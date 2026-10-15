/**
 * W 监督进程的宿主侧客户端（Agent 宿主内运行，可信）：按 v9 第 04 篇 §4.1 的权限参数拉起 W 进程，自检通过才可用。
 *
 * - 拉起：`node --permission --allow-fs-read=<运行时目录>/* --allow-fs-read=<数据目录>/* --allow-fs-write=<任务临时目录>/* --allow-worker`；
 *   不授予网络、子进程、原生扩展、WASI、FFI；环境变量不继承宿主（ZP-15）；IPC 用结构化克隆（改动集含二进制内容）；
 * - 自检（失败即关闭执行域，不降级）：随包 Node 存在且可执行（可选 sha256 摘要）、版本符合锁定值；权限模型生效（读系统文件被拒、
 *   写用户主目录被拒、网络/子进程/扩展/WASI 不可用）、DNS 解析失败；**一次真实的 worker 往返**（装载 just-bash 并校验摘要与补丁、
 *   跑 echo 与 python3）——审查 S3-08；
 * - 拉起失败（含 Node 路径失效、被杀软隔离）与运行中的 IPC 错误都按“执行域不可用”处理，不让宿主进程崩溃（审查 S3-09）；
 * - W 进程意外退出：在途调用一律以 killed 结束；下次调用重新拉起并重新自检；
 * - 内存：进程常驻内存上限 2 GB（总内存 ≤ 8 GB 的设备 1 GB），由 W 内看门狗执行。
 */
import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, constants as FS_CONST, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecChunk, ExecRequest, ExecResult, SelftestResult, SupervisorMessage } from "./protocol.ts";

/** 父进程心跳间隔（复核 B4-A13；W 监督进程按 KWL_PARENT_HEARTBEAT_MS 判断宿主是否还在）。 */
const HEARTBEAT_MS = 2_000;

export interface WSupervisorOptions {
  /** 只读授权的数据目录：本任务材料快照、事项工作区、（可选）可信区。 */
  dataDirs: string[];
  /** 可写授权：任务临时目录（W 不写工作区）。 */
  tmpDir: string;
  /** 运行 W 的 Node（v9：随包 Node 26 LTS；开发与测试用当前 Node）。 */
  nodePath?: string;
  /** 锁定的 Node 版本（产品构建给出确切小版本，例如 "v26.8.1"；开发形态缺省只要求 v26）。 */
  expectedNodeVersion?: string | RegExp;
  /** 随包 Node 可执行文件的 sha256（产品构建给出；开发形态不校验）。 */
  nodeSha256?: string;
  maxConcurrent?: number;
  rssLimitMb?: number;
  /** 每次调用的硬计时器宽限（时长上限之外；缺省 15 秒）。 */
  hardTimerGraceMs?: number;
  /** 等待 W 进程就绪与自检的上限。 */
  startTimeoutMs?: number;
  /**
   * 随包 W 运行时目录（安装包形态，收敛偏离 D-05）：内含 supervisor.mjs、worker.mjs 与 node_modules/just-bash（由
   * scripts/build-runtime.mjs 生成）。给出时 W 进程只被授权读取这一个代码目录；缺省为开发形态（本包源码 + 仓库 node_modules）。
   */
  runtimeDir?: string;
}

export interface WRuntimePaths {
  supervisorPath: string;
  jbEntry: string;
  /** W 进程需要读取的代码目录（本包与 just-bash 及其依赖所在的 node_modules）。 */
  runtimeDirs: string[];
}

export function wRuntimePaths(runtimeDir?: string): WRuntimePaths {
  if (runtimeDir) {
    const dir = realpathSync(runtimeDir);
    const supervisorPath = join(dir, "supervisor.mjs");
    const jbEntry = join(dir, "node_modules", "just-bash", "dist", "bundle", "index.js");
    for (const f of [supervisorPath, join(dir, "worker.mjs"), jbEntry]) {
      if (!statSync(f, { throwIfNoEntry: false })?.isFile()) throw new WUnavailableError(`随包 W 运行时不完整（缺少 ${f}）`);
    }
    return { supervisorPath, jbEntry, runtimeDirs: [dir] };
  }
  const supervisorPath = fileURLToPath(new URL("./supervisor.ts", import.meta.url));
  const jbEntry = fileURLToPath(import.meta.resolve("just-bash"));
  const pkgDir = dirname(dirname(supervisorPath));
  // just-bash/dist/bundle/index.js → node_modules（just-bash 的依赖提升在同一 node_modules）
  const nodeModules = dirname(dirname(dirname(dirname(jbEntry))));
  // 可信命令用到的工作区包（文书引擎及其依赖的领域包）：src/index.ts → 包目录
  const pkgOf = (spec: string) => realpathSync(dirname(dirname(fileURLToPath(import.meta.resolve(spec)))));
  return {
    supervisorPath,
    jbEntry,
    // 落盘加密读层（审计 S3 第 2 步）用到 @zr-legal/at-rest（只用 Node crypto）
    runtimeDirs: [realpathSync(pkgDir), realpathSync(nodeModules), pkgOf("@zr-legal/docx-engine"), pkgOf("@zr-legal/domain"), pkgOf("@zr-legal/at-rest")],
  };
}

export function defaultRssLimitMb(): number {
  return totalmem() <= 8 * 1024 ** 3 ? 1024 : 2048;
}

export class WUnavailableError extends Error {
  readonly code = "execution_domain_unavailable";
}

/** 开发形态的版本要求（产品构建以 expectedNodeVersion 锁定小版本：偏离登记）。 */
export const DEV_NODE_VERSION = /^v26\./;

/** 自检判定：任何一项不成立即视为执行域不可用。 */
export function selftestProblems(s: SelftestResult, expected: string | RegExp = DEV_NODE_VERSION): string[] {
  const p: string[] = [];
  if (s.permission.fsReadEtc) p.push("可读取系统目录");
  if (s.permission.fsWriteHome) p.push("可写用户主目录");
  if (s.permission.net) p.push("网络未关闭");
  if (s.permission.child) p.push("子进程未关闭");
  if (s.permission.addon) p.push("原生扩展未关闭");
  if (s.permission.wasi) p.push("WASI 未关闭");
  if (!s.permission.worker) p.push("worker 不可用");
  if (s.dns === "allowed") p.push("DNS 解析可用");
  if (s.readEtc === "allowed") p.push("系统文件可读");
  if (typeof expected === "string" ? s.node !== expected : !expected.test(s.node)) p.push(`Node 版本不符（${s.node}）`);
  return p;
}

interface Pending {
  resolve: (r: ExecResult) => void;
  onChunk: (c: ExecChunk) => void;
  onQueued?: (position: number) => void;
}

export class WSupervisor {
  private child: ChildProcess | null = null;
  private starting: Promise<ChildProcess> | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly selftests = new Map<number, (s: SelftestResult) => void>();
  private nextId = 1;
  private closed = false;
  /** 最近的 W 进程诊断输出（不交给模型）。 */
  readonly diagnostics: string[] = [];
  lastSelftest: SelftestResult | null = null;
  private readonly paths: WRuntimePaths;
  private readonly opts: WSupervisorOptions;

  constructor(opts: WSupervisorOptions) {
    this.opts = opts;
    this.paths = wRuntimePaths(opts.runtimeDir);
  }

  private flags(): string[] {
    const read = [...this.paths.runtimeDirs, ...this.opts.dataDirs].map((d) => `--allow-fs-read=${d}/*`);
    return ["--permission", ...read, `--allow-fs-write=${this.opts.tmpDir}/*`, "--allow-worker"];
  }

  /** 拉起并自检；已在运行则复用。 */
  async ensure(): Promise<void> {
    await this.process();
  }

  private process(): Promise<ChildProcess> {
    if (this.closed) return Promise.reject(new WUnavailableError("执行域已关闭"));
    if (this.child && this.child.connected) return Promise.resolve(this.child);
    if (!this.starting) {
      this.starting = this.spawn().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  /** 随包 Node 的存在性、可执行性与（可选）摘要：不成立即不可用，不去 fork（fork 不存在的文件会在子进程对象上发出未监听的 error）。 */
  private checkNode(nodePath: string): void {
    try {
      if (!statSync(nodePath).isFile()) throw new Error("不是文件");
      accessSync(nodePath, FS_CONST.X_OK);
    } catch (e) {
      throw new WUnavailableError(`随包 Node 不可用（${nodePath}：${(e as Error).message}）`);
    }
    if (this.opts.nodeSha256) {
      const digest = createHash("sha256").update(readFileSync(nodePath)).digest("hex");
      if (digest !== this.opts.nodeSha256) throw new WUnavailableError("随包 Node 摘要不符：执行域失败关闭");
    }
  }

  /** 清空监督进程的临时目录（审计 S3 1-12：运行期外不留任何文件；just-bash 的 /tmp 在内存，这里只是监督进程 cwd 与唯一写授权）。 */
  private clearTmp(): void {
    try {
      for (const f of readdirSync(this.opts.tmpDir)) rmSync(join(this.opts.tmpDir, f), { recursive: true, force: true });
    } catch {
      // 目录不存在
    }
  }

  private async spawn(): Promise<ChildProcess> {
    mkdirSync(this.opts.tmpDir, { recursive: true });
    this.clearTmp();
    const nodePath = this.opts.nodePath ?? process.execPath;
    this.checkNode(nodePath);
    const env: Record<string, string> = {};
    // Windows 系统目录（与 kernel/executor/child-env.ts 同口径：SystemRoot 与 windir 都给；复核 B4-A15）
    const sysRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.windir ?? process.env.WINDIR;
    if (process.platform === "win32" && sysRoot) {
      env.SystemRoot = sysRoot;
      env.windir = sysRoot;
    }
    // 父进程心跳（复核 B4-A13）：W 监督进程据此判断宿主是否还在（Windows 上 ppid 与 kill(pid,0) 判不了）
    env.KWL_PARENT_HEARTBEAT_MS = String(HEARTBEAT_MS);
    const child = fork(
      this.paths.supervisorPath,
      [this.paths.jbEntry, String(this.opts.maxConcurrent ?? 2), String(this.opts.rssLimitMb ?? defaultRssLimitMb()), String(this.opts.hardTimerGraceMs ?? 15_000)],
      {
      execPath: nodePath,
      execArgv: this.flags(),
      cwd: this.opts.tmpDir,
      env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      serialization: "advanced",
      // Windows：从桌面进程拉起随包 node.exe 时不弹控制台窗口（@types/node 的 ForkOptions 未声明，运行时生效）
      ...({ windowsHide: true } as {}),
      },
    );
    const diag = (d: Buffer) => {
      this.diagnostics.push(d.toString("utf8"));
      if (this.diagnostics.length > 200) this.diagnostics.splice(0, 100);
    };
    child.stdout?.on("data", diag);
    child.stderr?.on("data", diag);
    child.on("message", (m: SupervisorMessage) => this.onMessage(m));
    const hb = setInterval(() => {
      if (child.connected) child.send({ t: "hb" }, () => {});
    }, HEARTBEAT_MS);
    hb.unref();
    child.once("exit", () => clearInterval(hb));
    // 拉起失败（ENOENT、EACCES）与运行中的 IPC 错误（ERR_IPC_CHANNEL_CLOSED）：记诊断，按退出处理，不让宿主崩溃
    let startError: Error | null = null;
    child.on("error", (e: Error) => {
      startError ??= e;
      this.diagnostics.push(`W 进程错误：${e.message}`);
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // 已退出
        }
      }
    });
    child.on("exit", () => {
      if (this.child === child) this.child = null;
      // 在途调用一律以 killed 结束（W 进程退出 = 全部 worker 终止，内存层改动丢弃）
      for (const [id, p] of this.pending) p.resolve({ t: "result", id, stdout: "", stderr: "执行域进程已退出，命令被终止\n", exitCode: 137, reason: "killed", changes: [] });
      this.pending.clear();
    });
    const timeoutMs = this.opts.startTimeoutMs ?? 20_000;
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new WUnavailableError("执行域启动超时")), timeoutMs);
      const onMsg = (m: SupervisorMessage) => {
        if (m?.t !== "ready") return;
        clearTimeout(timer);
        child.off("message", onMsg);
        resolve();
      };
      child.on("message", onMsg);
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new WUnavailableError(startError ? `执行域进程启动失败（${startError.message}）` : `执行域进程启动失败（退出码 ${code}）`));
      });
      child.once("error", (e: Error) => {
        clearTimeout(timer);
        reject(new WUnavailableError(`执行域进程启动失败（${e.message}）`));
      });
    });
    try {
      await ready;
      // 自检通过前不对外可用（并发的 exec 等待同一个 starting）
      const st = await this.selftestOn(child, timeoutMs);
      this.lastSelftest = st;
      const problems = selftestProblems(st, this.opts.expectedNodeVersion ?? DEV_NODE_VERSION);
      if (problems.length > 0) throw new WUnavailableError(`执行域自检未通过：${problems.join("、")}`);
      // 真实 worker 往返：装载 just-bash（摘要与补丁锚点校验）、模拟 bash 与零 JS 桥 CPython 都能跑
      const rt = await this.roundTrip(child, timeoutMs);
      if (rt) throw new WUnavailableError(`执行域自检未通过：worker 往返失败（${rt}）`);
      if (this.closed) throw new WUnavailableError("执行域已关闭");
      this.child = child;
      return child;
    } catch (e) {
      child.kill("SIGKILL");
      throw e instanceof WUnavailableError ? e : new WUnavailableError((e as Error).message);
    }
  }

  /**
   * 一次真实执行（/tmp 内）：返回问题描述，null = 通过。另挂一个只读的加密挂载（随机区密钥、不读其中任何文件；复核 S3B-A12）——
   * 解密读层在挂载构造时安装并核对 just-bash 内部结构，结构不符即自检失败（执行域不可用），而不是之后每条加密执行都失败。
   */
  private roundTrip(child: ChildProcess, timeoutMs: number): Promise<string | null> {
    const id = this.nextId++;
    let out = "";
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve("超时");
      }, timeoutMs);
      this.pending.set(id, {
        onChunk: (c) => {
          out += c.stdout;
        },
        resolve: (r) => {
          clearTimeout(timer);
          out += r.stdout;
          if (r.exitCode !== 0 || r.reason !== "completed") resolve(`退出码 ${r.exitCode}（${r.reason}${r.limit ? `；上限：${r.limit}` : ""}）：${(r.stderr || r.error || "").trim().slice(0, 200)}`);
          else if (out !== "kwl-selftest\n42\n") resolve(`输出不符：${JSON.stringify(out.slice(0, 80))}`);
          else resolve(null);
        },
      });
      this.safeSend(child, {
        t: "exec",
        id,
        script: "echo kwl-selftest && python3 -c 'print(6*7)'",
        cwd: "/tmp",
        env: { HOME: "/home/user", PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
        mounts: this.opts.dataDirs[0]
          ? [{ mountPoint: "/kwl-selftest-sealed", root: this.opts.dataDirs[0], readOnly: true, sealed: { keys: { purpose: "work", gen_current: 1, keys: { "1": randomBytes(32).toString("base64") } }, strict: true } }]
          : [],
        limits: { maxExecutionTimeMs: Math.min(timeoutMs, 60_000), maxOutputSize: 1 << 20, maxFileReadSize: 1 << 20, maxMemoryBytes: 16 << 20, maxFileSystemBytes: 16 << 20, maxIterations: 10_000 },
      });
    });
  }

  /** 发 IPC：通道已关闭时不抛（Node 会在子进程对象上异步发出 error，由上面的监听吸收）。 */
  private safeSend(child: ChildProcess | null, m: unknown): boolean {
    if (!child || !child.connected) return false;
    try {
      child.send(m as Parameters<ChildProcess["send"]>[0], (e) => {
        if (e) this.diagnostics.push(`W IPC 发送失败：${e.message}`);
      });
      return true;
    } catch (e) {
      this.diagnostics.push(`W IPC 发送失败：${(e as Error).message}`);
      return false;
    }
  }

  private selftestOn(child: ChildProcess, timeoutMs: number): Promise<SelftestResult> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.selftests.delete(id);
        reject(new WUnavailableError("执行域自检超时"));
      }, timeoutMs);
      this.selftests.set(id, (s) => {
        clearTimeout(timer);
        resolve(s);
      });
      if (!this.safeSend(child, { t: "selftest", id })) {
        clearTimeout(timer);
        this.selftests.delete(id);
        reject(new WUnavailableError("执行域进程不可达"));
      }
    });
  }

  async selftest(): Promise<SelftestResult> {
    const child = await this.process();
    const s = await this.selftestOn(child, this.opts.startTimeoutMs ?? 20_000);
    this.lastSelftest = s;
    return s;
  }

  private onMessage(m: SupervisorMessage): void {
    if (!m || typeof m !== "object") return;
    if (m.t === "chunk") this.pending.get(m.id)?.onChunk(m);
    else if (m.t === "queued") this.pending.get(m.id)?.onQueued?.(m.position);
    else if (m.t === "result") {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      p?.resolve(m);
    } else if (m.t === "selftest") {
      const f = this.selftests.get(m.id);
      this.selftests.delete(m.id);
      f?.(m);
    }
  }

  /** 提交一次执行；返回调用 ID 与结果。W 不可用时抛 WUnavailableError（调用方据此失败关闭）。 */
  async exec(
    req: Omit<ExecRequest, "t" | "id">,
    handlers: { onChunk: (c: ExecChunk) => void; onQueued?: (position: number) => void },
  ): Promise<{ id: number; result: Promise<ExecResult> }> {
    const child = await this.process();
    const id = this.nextId++;
    const result = new Promise<ExecResult>((resolve) => {
      this.pending.set(id, { resolve, onChunk: handlers.onChunk, ...(handlers.onQueued ? { onQueued: handlers.onQueued } : {}) });
    });
    if (!this.safeSend(child, { t: "exec", id, ...req })) {
      const p = this.pending.get(id);
      this.pending.delete(id);
      p?.resolve({ t: "result", id, stdout: "", stderr: "执行域进程不可达，命令未运行\n", exitCode: 1, reason: "error", changes: [] });
    }
    return { id, result };
  }

  abort(id: number): void {
    if (this.pending.has(id)) this.safeSend(this.child, { t: "abort", id });
  }

  kill(id: number): void {
    if (this.pending.has(id)) this.safeSend(this.child, { t: "kill", id });
  }

  /** 终止全部在途调用（取消传播：运行取消、超时、失败）。 */
  killAll(): number {
    const ids = [...this.pending.keys()];
    for (const id of ids) this.safeSend(this.child, { t: "kill", id });
    return ids.length;
  }

  pid(): number | null {
    return this.child?.pid ?? null;
  }

  async close(): Promise<void> {
    this.closed = true;
    const child = this.child;
    this.child = null;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      if (!this.safeSend(child, { t: "shutdown" })) child.kill("SIGKILL");
    });
    this.clearTmp();
  }
}
