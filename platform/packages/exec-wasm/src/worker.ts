/**
 * W-core 每调用 worker（v9 第 04 篇 §4.1）：在 W 监督进程内（Node --permission：无网、无子进程、无原生扩展）运行一个 just-bash 实例。
 *
 * - 文件系统：MountableFs；挂载点 = 宿主路径的 shell 形式（单一路径命名空间）。材料快照 OverlayFs 只读；工作区 OverlayFs 读盘、
 *   写入留在内存；其余（/tmp、/home 等）是内存；allowSymlinks = false；加密挂载（审计 S3 第 2 步）的读层解封 KWE1 密文（sealed-overlay.ts）；
 * - just-bash：executionLimitProfile = hardened（计数类上限与 Python/SQLite 时长按宿主下发的值放宽）；replaceEnv；
 *   python3 = 自带 CPython-Emscripten（零 JS 桥：`import js` 不存在）；未配置网络（无 curl）；js-exec 未开启；
 * - 流式输出：顶层语句结束即经 postMessage 发出（jb-loader.ts 的 KJ 补丁）；结果只带尚未发出的剩余输出；
 * - 结束时导出工作区改动（OverlayFs 内存层 + 删除集合；内容经 readFileBytes 取全，含追加分块），由宿主经文件 broker 校验后提交；
 * - 取消：收到 abort → AbortSignal（协作式，下一语句边界停止）；强杀由监督进程 worker.terminate()。
 */
import { parentPort, workerData } from "node:worker_threads";
import { LIMIT_PROBE_PREFIX, loadJustBash, PY_BRIDGE_BYTES, setLimitObserver, type OutputCallback } from "./jb-loader.ts";
import { trustedCommands } from "./trusted-commands.ts";
import { sealOverlay } from "./sealed-overlay.ts";
import type { ChangeSet, ExecRequest, ExecResult } from "./protocol.ts";

interface OverlayInternals {
  memory: Map<string, { type: string }>;
  deleted: Set<string>;
  readFileBytes(path: string): Promise<string>;
}

// just-bash 入口由宿主解析为绝对路径传入（不做裸模块名解析：W 进程只被授予运行时目录的读取权限）
const { req, jbEntry } = workerData as { req: ExecRequest; jbEntry: string };
const controller = new AbortController();
parentPort?.on("message", (m: { t?: string }) => {
  if (m?.t === "abort") controller.abort();
});

/**
 * 送回宿主的输出上限（stdout 与 stderr 各自计）：上游任务服务在 16 MiB 时停止任务并提示“把大量输出重定向到文件”，
 * 这里略高于它，超出部分不再送回（防止单条巨大输出撑大宿主内存）。只记已送出的长度，不另存副本。
 */
const HOST_OUTPUT_CAP = 17 * 1024 * 1024;
const sent = { stdout: 0, stderr: 0 };
const capped = { stdout: false, stderr: false };
/** 按 UTF-8 字节计（与上游 16 MiB 的字节口径一致）；超出时截断在字节边界并附说明。 */
const capChunk = (stream: "stdout" | "stderr", chunk: string): string => {
  if (capped[stream] || chunk.length === 0) return "";
  const bytes = Buffer.byteLength(chunk, "utf8");
  const room = HOST_OUTPUT_CAP - sent[stream];
  if (bytes <= room) {
    sent[stream] += bytes;
    return chunk;
  }
  capped[stream] = true;
  const head = room > 0 ? Buffer.from(chunk, "utf8").subarray(0, room).toString("utf8").replace(/\uFFFD$/, "") : "";
  sent[stream] = HOST_OUTPUT_CAP;
  return `${head}\n[执行域] 输出超过 ${Math.floor(HOST_OUTPUT_CAP / 1048576)} MiB，其余部分未送回（请把大量输出重定向到文件）\n`;
};
/** 已流出的字符数（最终输出以已流出内容为前缀：流式补丁差分验证；KJ-1～3）。 */
const streamedLen = { stdout: 0, stderr: 0 };
const onOutput: OutputCallback = (stream, chunk) => {
  streamedLen[stream] += chunk.length;
  const out = capChunk(stream, chunk);
  if (out.length === 0) return;
  parentPort?.postMessage({ t: "chunk", id: req.id, stdout: stream === "stdout" ? out : "", stderr: stream === "stderr" ? out : "" });
};

/** 最终输出中尚未流出的部分（按已流出的长度切分），再经同一上限截断。 */
function remainder(stream: "stdout" | "stderr", final: string): string {
  const rest = final.length > streamedLen[stream] ? final.slice(streamedLen[stream]) : "";
  return capChunk(stream, rest);
}

/**
 * 执行域上限的结构化记录（复核 S3-18、第二轮复核 S3-26、抽查 S3-30）：just-bash 的 ExecutionLimitError 在构造时记录；python3 的共享缓冲
 * 上限经 stat 保留路径 `/.kwl-limit/<类别>` 报告；文件系统上限（字节、单文件读入与复制）在抛出点记录。不看用户可见的 stderr 文本，也与最终退出码无关。
 * 非宿主发起的 ExecutionAbortedError 记为 "deadline"，只作诊断——时限由 worker 自身计时判定（S3-27），不据此判定。
 */
const limitHits: string[] = [];
const recordLimit = (kind: string) => {
  if (limitHits.length < 20) limitHits.push(kind.slice(0, 200));
};

/** 拦截保留路径的 stat：记录 python3 报告的上限，返回“不存在”。 */
function interceptLimitProbe(fs: Record<string, unknown>): void {
  for (const m of ["stat", "lstat", "exists"] as const) {
    const orig = fs[m];
    if (typeof orig !== "function") continue;
    fs[m] = async function (p: unknown, ...rest: unknown[]) {
      if (typeof p === "string" && p.startsWith(LIMIT_PROBE_PREFIX)) {
        recordLimit(p.slice(LIMIT_PROBE_PREFIX.length) || "python_limit");
        if (m === "exists") return false;
        throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${p}'`), { code: "ENOENT" });
      }
      return (orig as (...a: unknown[]) => unknown).call(fs, p, ...rest);
    };
  }
}

/**
 * 文件系统上限的结构化记录（第二轮复核 S3-26、抽查 S3-30）：just-bash 的 OverlayFs 与 InMemoryFs 在触及上限时抛普通 `Error`，
 * 不经 ExecutionLimitError——内存层与内存文件系统的字节上限（`ENOSPC: … byte limit exceeded`）、单文件读入与复制上限
 * （`EFBIG: file too large…`）。命令捕获后只报“文件不存在”或 I/O 错误、python3 还会在析构时吞掉（退出码 0），已有文件会被截断版本覆盖。
 * 在实例上包装其类的全部方法（含内部辅助方法），抛出前记录——撞限即整体不写回。已知的检查方法缺失即拒绝运行（失败关闭；just-bash
 * 版本另由锁定摘要约束）。
 */
const FS_LIMIT_RE = /^(?:EFBIG: file too large|ENOSPC: (?:overlay memory|in-memory filesystem) byte limit exceeded)/;
function interceptFsLimits(target: object, kind: string, mustHave: readonly string[]): void {
  const t = target as Record<string, unknown>;
  for (const m of mustHave) {
    if (typeof t[m] !== "function") throw new Error(`执行域自检失败：just-bash 文件系统缺少 ${m}（无法识别文件系统上限）`);
  }
  const hit = (e: unknown) => {
    const msg = String((e as Error)?.message ?? "");
    if (FS_LIMIT_RE.test(msg)) recordLimit(msg.startsWith("EFBIG") ? `fs_file_too_large_${kind}` : `fs_bytes_${kind}`);
  };
  const names = new Set<string>();
  for (let proto = Object.getPrototypeOf(target); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor") continue;
      const d = Object.getOwnPropertyDescriptor(proto, name);
      if (d && typeof d.value === "function") names.add(name);
    }
  }
  for (const name of names) {
    const orig = t[name] as (...a: unknown[]) => unknown;
    t[name] = function (this: unknown, ...args: unknown[]) {
      try {
        const r = orig.apply(this, args);
        if (r && typeof (r as Promise<unknown>).then === "function") {
          return (r as Promise<unknown>).catch((e: unknown) => {
            hit(e);
            throw e;
          });
        }
        return r;
      } catch (e) {
        hit(e);
        throw e;
      }
    };
  }
}

async function main(): Promise<ExecResult> {
  const jb = await loadJustBash(jbEntry);
  // 观察者在装载之后设置（装载时的自检构造不计入）；宿主发起的 SIGTERM 协作停止不算上限
  setLimitObserver({ onLimit: recordLimit, isOwnAbort: () => controller.signal.aborted });
  const overlays: { spec: (typeof req.mounts)[number]; fs: OverlayInternals }[] = [];
  const codecs: { wipe(): void }[] = [];
  const mounts = req.mounts.map((m) => {
    const fs = new jb.OverlayFs({
      root: m.root,
      mountPoint: "/",
      readOnly: m.readOnly,
      allowSymlinks: false,
      maxFileReadSize: req.limits.maxFileReadSize,
      maxMemoryBytes: req.limits.maxMemoryBytes,
    }) as unknown as OverlayInternals;
    // 解密读层先装（上限记录器再包在它外面：EFBIG 等仍在原方法处抛出、经两层原样传出）
    if (m.sealed) codecs.push(sealOverlay(fs, { keys: m.sealed.keys, strict: m.sealed.strict, normalize: jb.normalizePath, onRefused: recordLimit }));
    interceptFsLimits(fs, m.readOnly ? "readonly" : "overlay", ["readFileBuffer", "assertMemoryCapacity"]);
    overlays.push({ spec: m, fs });
    return { mountPoint: m.mountPoint, filesystem: fs };
  });
  // 内存层：/tmp、/home/user 等（不落盘；随 worker 结束丢弃）
  const base = new jb.InMemoryFs(undefined, { maxTotalBytes: req.limits.maxFileSystemBytes }) as { mkdir(p: string, o: { recursive: boolean }): Promise<void> };
  interceptFsLimits(base, "memfs", ["assertCanAllocate", "setEntry"]);
  for (const d of ["/tmp", "/home/user"]) await base.mkdir(d, { recursive: true });
  const fs = new jb.MountableFs({ base, mounts });
  interceptLimitProbe(fs as unknown as Record<string, unknown>);
  const n = req.limits.maxIterations;
  const bash = new jb.Bash({
    fs,
    cwd: req.cwd,
    python: true,
    // 可信命令 kwl-docx / kwl-xlsx（文书引擎；经同一虚拟文件系统读写）
    customCommands: trustedCommands(jb.defineCommand),
    executionLimitProfile: "hardened",
    executionLimits: {
      maxExecutionTimeMs: req.limits.maxExecutionTimeMs,
      maxPythonTimeoutMs: req.limits.maxExecutionTimeMs,
      maxSqliteTimeoutMs: req.limits.maxExecutionTimeMs,
      maxOutputSize: req.limits.maxOutputSize,
      maxFileSystemBytes: req.limits.maxFileSystemBytes,
      maxCommandCount: n,
      maxLoopIterations: n,
      // awk/sed/jq 按记录计数（awk 每行一次）：数据文件常有几百万行，放宽到 20 倍；时长与内存仍有独立上限
      maxAwkIterations: n * 20,
      maxSedIterations: n * 20,
      maxJqIterations: n * 20,
      // 数据规模（审查 S3-14）：hardened 档按 10 MiB 字符串、32 MiB 输入设计，律师的流水与台账常在几十 MB；单个文件经
      // awk/python3 读入统一放宽到 64 MiB（python3 的上限同时受 KJ-4 的 64 MiB 共享缓冲约束），总量与内存仍由提交上限与看门狗约束
      maxStringLength: PY_BRIDGE_BYTES,
      maxHeredocSize: 16 * 1024 * 1024,
      maxInputBytes: 256 * 1024 * 1024,
      maxLiveBytes: 512 * 1024 * 1024,
      maxArrayElements: 4_000_000,
      maxCsvRows: 2_000_000,
      maxCsvCells: 50_000_000,
      maxWorkUnits: 100_000_000,
      maxTraversalEntries: 1_000_000,
      maxTraversalWork: 1_000_000,
      maxDatabaseBytes: 512 * 1024 * 1024,
      maxDatabaseResultBytes: 128 * 1024 * 1024,
      maxWorkerMessageBytes: 160 * 1024 * 1024,
    },
    env: req.env,
  });
  let out: { stdout: string; stderr: string; exitCode: number };
  let reason: ExecResult["reason"] = "completed";
  // 时限按 worker 自身计时判定（第二轮复核 S3-27）：命令自身返回 124（`exit 124`、`timeout N cmd`）不算执行域时限；
  // just-bash 的时限从其预算创建时起算（晚于这里），真正超时的那一刻这里的计时必然已到期
  const startedAt = Date.now();
  const deadlineReached = () => Date.now() >= startedAt + req.limits.maxExecutionTimeMs;
  const limitOtherThanDeadline = () => limitHits.some((k) => !k.startsWith("deadline"));
  try {
    out = await bash.exec(req.script, { cwd: req.cwd, env: req.env, replaceEnv: true, signal: controller.signal, onOutput });
    if (controller.signal.aborted) reason = "aborted";
    else if (out.exitCode === 124 && deadlineReached()) reason = "timeout";
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    // 抛出异常：宿主中止 → aborted；计时到期 → timeout；触及资源上限 → error（退出码 126）；其余 → 执行域内部错误（退出码 1）
    reason = controller.signal.aborted ? "aborted" : deadlineReached() ? "timeout" : "error";
    out = { stdout: "", stderr: `${msg}\n`, exitCode: reason === "aborted" ? 143 : reason === "timeout" ? 124 : limitOtherThanDeadline() ? 126 : 1 };
  }
  // 导出可写挂载的改动（只读挂载不会有内存层写入）
  const changes: ChangeSet[] = [];
  for (const { spec, fs: ov } of overlays) {
    if (spec.readOnly) continue;
    const cs: ChangeSet = { mountPoint: spec.mountPoint, files: [], dirs: [], deleted: [...ov.deleted].map((p) => p.replace(/^\/+/, "")), links: [] };
    for (const [p, entry] of ov.memory) {
      const rel = p.replace(/^\/+/, "");
      if (rel === "") continue;
      if (entry.type === "directory") cs.dirs.push(rel);
      else if (entry.type === "file") cs.files.push({ path: rel, content: new Uint8Array(Buffer.from(await ov.readFileBytes(p), "latin1")) });
      else cs.links.push(rel);
    }
    changes.push(cs);
  }
  for (const c of codecs) c.wipe();
  const limitLine = limitHits.find((k) => !k.startsWith("deadline")) ?? null;
  return {
    t: "result",
    id: req.id,
    stdout: remainder("stdout", out.stdout),
    stderr: remainder("stderr", out.stderr),
    exitCode: out.exitCode,
    reason: controller.signal.aborted && reason === "completed" ? "aborted" : reason,
    changes,
    ...(limitLine ? { limit: limitLine } : {}),
  };
}

main()
  .then((r) => parentPort?.postMessage(r))
  .catch((e: unknown) =>
    parentPort?.postMessage({ t: "result", id: req.id, stdout: "", stderr: `${(e as Error)?.message ?? e}\n`, exitCode: 1, reason: "error", changes: [], error: String(e) } satisfies ExecResult),
  );
