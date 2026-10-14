/**
 * 宿主内检索的进程形态与文件访问（审计 S3 第 2 步）：Grep/Glob 的 `spawn(rg, args)` 经执行域路由交到这里，返回与上游 `IHostProcess`
 * 同形的合成进程（stdout/stderr 流 + wait/kill/dispose）。
 *
 * 检索在独立的 worker_thread 里运行（复核 S3B-B02/B03：主线程分时挡不住整文件解密、整段预筛、多行匹配这些不可让出的同步段）：
 * - worker 用同一组区（工具可寻址区：work、materials、trusted）与区密钥构造只读文件 broker，经 broker 遍历与解封——与宿主同一套逐级校验；
 * - kill（SIGTERM 或 SIGKILL）即 `worker.terminate()`，立即结束，退出码 143（与被终止的 rg 相同）；上游 20 秒时限因此是硬上界；
 * - worker 堆上限（resourceLimits，按本机内存缩放）：超限时 worker 被 V8 终止、宿主进程不受影响，报“检索内存超限”、退出码 2；
 *   resourceLimits 不约束 Buffer 等外部内存——同一宿主同时运行的检索 worker 数另有上限（≤ 8 GB 的设备 1 个、其余 2 个；复核 B 处置复核 N-01），
 *   其余排队（排队时间计入上游 20 秒时限，排队中被 kill 即 143）；
 * - 区密钥随 workerData 进入同一进程的另一个线程（宿主本就持有），worker 结束时清零。
 * 测试与无区密钥的调用方可直接给出 SearchFs，在本线程内执行（同一引擎）。
 */
import { existsSync } from "node:fs";
import { totalmem } from "node:os";
import { PassThrough } from "node:stream";
import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { ZoneKeysOfPurpose } from "@zr-legal/at-rest";
import type { FileBroker } from "@zr-legal/file-broker";
import { runSearch, type SearchFs } from "./engine.ts";

export interface HostSearchProcess {
  readonly _serviceBrand: undefined;
  readonly pid: number;
  readonly exitCode: number | null;
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  wait(): Promise<number>;
  kill(signal?: NodeJS.Signals): Promise<void>;
  dispose(): void;
}

/** worker 内重建只读 broker 所需的区描述（可结构化克隆）。 */
export interface SearchZoneSpec {
  name: string;
  root: string;
  strict?: boolean;
  chunkedOnly?: boolean;
  keys?: ZoneKeysOfPurpose;
}

/** worker 的堆上限（MB）：单文件检索上限 256 MiB 的明文解码成字符串约需 512 MB 以上；≤ 8 GB 的设备减半（有效单文件上限随之降低，超限报“内存超限”）。 */
export const SEARCH_WORKER_HEAP_MB = totalmem() <= 8 * 1024 ** 3 ? 768 : 1536;
/** 同一宿主同时运行的检索 worker 数。 */
export const SEARCH_WORKER_SLOTS = totalmem() <= 8 * 1024 ** 3 ? 1 : 2;

let freeSlots = SEARCH_WORKER_SLOTS;
const slotWaiters: (() => void)[] = [];
function acquireSlot(): Promise<() => void> {
  const grant = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = slotWaiters.shift();
      if (next) next();
      else freeSlots += 1;
    };
  };
  if (freeSlots > 0) {
    freeSlots -= 1;
    return Promise.resolve(grant());
  }
  return new Promise((r) => slotWaiters.push(() => r(grant())));
}

let nextPid = 800_000;

/** 经文件 broker 的检索文件访问：只在 allowedZones（工具可寻址区）内给出上级目录。 */
export function brokerSearchFs(broker: FileBroker, allowedZones: ReadonlySet<string>, pathClass: "posix" | "win32"): SearchFs {
  const p = pathClass === "win32" ? win32 : posix;
  return {
    readdir: (path) => broker.readdir(path),
    async stat(path) {
      const s = await broker.stat(path);
      return { isFile: s.isFile, isDirectory: s.isDirectory, mtimeMs: s.mtimeMs, size: s.size };
    },
    read: (path, n, offset) => broker.readBytes(path, n, offset),
    parentsWithinZone(path) {
      const loc = broker.locate(path);
      if (!loc || !allowedZones.has(loc.zone.name) || loc.rel.length === 0) return [];
      let root = loc.display;
      for (let i = 0; i < loc.rel.length; i++) root = p.dirname(root);
      const out: string[] = [];
      let cur = root;
      out.push(cur);
      for (const c of loc.rel.slice(0, -1)) {
        cur = p.join(cur, c);
        out.push(cur);
      }
      return out;
    },
  };
}

/** worker 入口：开发形态为本目录的 search-worker.ts，安装包形态为与宿主 main.mjs 同目录的 search-worker.mjs。 */
export function searchWorkerUrl(): URL {
  for (const name of ["./search-worker.ts", "./search-worker.mjs"]) {
    const u = new URL(name, import.meta.url);
    if (existsSync(fileURLToPath(u))) return u;
  }
  throw new Error("宿主内检索的 worker 入口缺失（search-worker）");
}

interface SpawnOptions {
  cwd: string;
  pathClass: "posix" | "win32";
  /** 给出即在 worker 内按这些区重建 broker 检索（宿主形态）。 */
  zones?: SearchZoneSpec[];
  /** 本线程内检索（测试与无区密钥的调用方）。 */
  fs?: SearchFs;
  /** 测试用：覆盖 worker 堆上限（MB）。 */
  heapMb?: number;
}

export function spawnHostSearch(args: readonly string[], o: SpawnOptions): HostSearchProcess {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let exitCode: number | null = null;
  let killed = false;
  let worker: Worker | null = null;
  let finish!: (code: number) => void;
  const done = new Promise<number>((resolve) => {
    finish = (code: number) => {
      if (exitCode !== null) return;
      exitCode = killed ? 143 : code;
      stdout.end();
      stderr.end();
      resolve(exitCode);
    };
  });
  if (o.zones) {
    void (async () => {
      const releaseSlot = await acquireSlot();
      void done.then(releaseSlot);
      if (killed) return finish(143);
      let w: Worker;
      try {
        w = new Worker(searchWorkerUrl(), {
          workerData: { args: [...args], cwd: o.cwd, pathClass: o.pathClass, zones: o.zones },
          resourceLimits: { maxOldGenerationSizeMb: o.heapMb ?? SEARCH_WORKER_HEAP_MB, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 },
          stdout: false,
          stderr: false,
        });
      } catch (e) {
        stderr.write(`rg: 宿主内检索无法启动：${(e as Error)?.message ?? e}\n`);
        return finish(2);
      }
      worker = w;
      w.on("message", (m: { t: string; s?: string; code?: number }) => {
        if (exitCode !== null) return; // 已收尾（被终止或已报出错）后到达的消息丢弃
        if (m?.t === "out" && typeof m.s === "string") stdout.write(m.s);
        else if (m?.t === "err" && typeof m.s === "string") stderr.write(m.s);
        else if (m?.t === "exit") finish(typeof m.code === "number" ? m.code : 2);
      });
      w.on("error", (e: Error & { code?: string }) => {
        if (exitCode === null) {
          stderr.write(e?.code === "ERR_WORKER_OUT_OF_MEMORY" ? "rg: 宿主内检索内存超限（结果不完整：请缩小搜索范围或换用更具体的模式）\n" : `rg: 宿主内检索出错：${e?.message ?? e}\n`);
        }
        finish(2);
      });
      // 正常结束时 exit 消息先于 exit 事件送达；没有送达（worker 异常退出）按出错处理
      w.on("exit", () => finish(killed ? 143 : 2));
    })();
  } else {
    void (async () => {
      // 让调用方先接上读取端（上游先 stdin.end() 再读流）
      await new Promise((r) => setImmediate(r));
      let code: number;
      try {
        code = await runSearch(args, {
          cwd: o.cwd,
          pathClass: o.pathClass,
          fs: o.fs!,
          io: { out: (s) => void stdout.write(s), err: (s) => void stderr.write(s), aborted: () => killed },
        });
      } catch (e) {
        stderr.write(`rg: ${(e as Error)?.message ?? e}\n`);
        code = 2;
      }
      finish(code);
    })();
  }
  const stop = () => {
    if (exitCode !== null) return;
    killed = true;
    if (worker) void worker.terminate().then(() => finish(143));
    else if (o.zones) finish(143); // 排队中（尚未拉起 worker）
  };
  return {
    _serviceBrand: undefined,
    pid: nextPid++,
    get exitCode() {
      return exitCode;
    },
    stdin: new PassThrough(),
    stdout,
    stderr,
    wait: () => done,
    async kill() {
      stop();
    },
    dispose() {
      stop();
    },
  };
}
