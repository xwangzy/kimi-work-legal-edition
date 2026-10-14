/**
 * W-core 执行域（v9 第 04 篇 §4.1）：把 Kimi Code Bash 工具的一次 `spawn(shell, ['-c', cmd])` 变成 W 内的一次 just-bash 执行，
 * 返回与上游 `IHostProcess` 同形的合成进程对象（立即返回；排队、基线、执行、提交在后台进行）。
 *
 * 与上游语义的衔接（锁版 bashTool.ts / process-task.ts）：
 * - 单一路径命名空间：工作区、材料快照（及可选可信区）挂在与宿主路径的 shell 形式相同的位置（Windows `C:\…` → `/c/…`），
 *   Read/Write/Grep 与 Bash 看到同一路径；cwd 由执行域路由解析 `cd '<…>' &&` 前缀后传入；
 * - 并发：同一事项最多 N 个命令同时执行（默认 2），其余在宿主侧排队（排队有上限，超出即拒绝并说明）；排队位置经事件报告；
 * - 基线在命令**真正开始时**采集（审查 S3-12），并且与提交、引擎的 Write/Edit 一样在 broker 写入临界区内进行（S3-03）；
 * - 流式输出：W 每个顶层语句结束即写入 stdout/stderr 流；
 * - 终止：`SIGTERM` → 协作式停止（下一语句边界）+ 5 秒宽限后强杀；`SIGKILL` → 终止 worker；都不殃及同事项其他命令；
 *   退出码 143 / 137，超时 124；
 * - 提交：命令正常结束或协作停止（SIGTERM）时提交已执行部分（与上游“被 SIGTERM 的进程已写的文件仍在盘上”一致）；
 *   **强制终止、超时、执行域资源上限（输出、内存、时长）或执行域错误时，本次改动一律不写回**（避免截断的文件覆盖原文件：
 *   审查 S3-05、S3-10；与上游 SIGKILL 语义不同，偏离登记），并在 stderr 说明；
 * - 退出码：提交没有完整写回（冲突副本、保留未删、被拒绝、写入失败）而命令本身退出码为 0 时返回 75（审查 S3-06）；
 *   命令结束后先提交、再结束输出流与返回退出码——Bash 返回时文件已在盘上；
 * - 取消传播：abortAll 递增本事项的取消纪元，排队中与采集基线中的命令不再开始，执行中的命令强杀（审查 S3-07）；
 * - 环境变量：固定白名单（HOME、PATH、LANG、TERM、NO_COLOR、TMPDIR），不透传宿主环境（ZP-15）。
 */
import { PassThrough } from "node:stream";
import type { FileBroker } from "@zr-legal/file-broker";
import {
  captureBaseline,
  commitChanges,
  commitIncomplete,
  describeReport,
  EXIT_COMMIT_INCOMPLETE,
  type Baseline,
  type CommitLimits,
  type CommitReport,
} from "./commit.ts";
import { WSupervisor, WUnavailableError, type WSupervisorOptions } from "./host.ts";
import type { ExecLimits, ExecResult, MountSpec } from "./protocol.ts";
import type { ZoneKeysOfPurpose } from "@zr-legal/at-rest";

export type PathClass = "posix" | "win32";

/** 宿主路径 → shell 形式（与上游 shellPathBridge.toShellPath 相同：Windows 盘符小写、反斜杠改正斜杠）。 */
export function toShellPath(hostPath: string, pathClass: PathClass): string {
  if (pathClass !== "win32") return hostPath;
  if (hostPath.startsWith("\\\\")) return hostPath.replaceAll("\\", "/");
  const m = /^([A-Za-z]):(?:[\\/]|$)/.exec(hostPath);
  if (m) {
    const rest = hostPath.slice(2).replaceAll("\\", "/");
    return `/${m[1]!.toLowerCase()}${rest.startsWith("/") ? rest : `/${rest}`}`;
  }
  return hostPath.replaceAll("\\", "/");
}

export const W_CORE_LABEL = "运行时隔离：W-core（模拟 bash + 零 JS 桥 Python；Node 权限模型：无网络、无子进程；不是操作系统强制的沙箱）";

/**
 * just-bash 的输出上限同时计入重定向写文件（审查 S3-05），所以按提交层的单文件上限放宽；回给模型的输出另由上游任务服务
 * 限制在 16 MiB（超出即停止任务并提示重定向到文件），W 侧再以 HOST_OUTPUT_CAP 截断送回宿主的部分。
 */
export const DEFAULT_EXEC_LIMITS: ExecLimits = Object.freeze({
  maxExecutionTimeMs: 60 * 60_000,
  maxOutputSize: 128 * 1024 * 1024,
  maxFileReadSize: 128 * 1024 * 1024,
  maxMemoryBytes: 256 * 1024 * 1024,
  maxFileSystemBytes: 512 * 1024 * 1024,
  maxIterations: 1_000_000,
});

export const DEFAULT_COMMIT_LIMITS: CommitLimits = Object.freeze({ maxFileBytes: 100 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024 });

/** 宿主侧排队上限（同一事项）：超出即拒绝并说明。 */
export const DEFAULT_MAX_WAITING = 16;

const FIXED_ENV: Readonly<Record<string, string>> = Object.freeze({
  HOME: "/home/user",
  PATH: "/usr/local/bin:/usr/bin:/bin",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  TERM: "dumb",
  NO_COLOR: "1",
  TMPDIR: "/tmp",
  USER: "user",
});

export interface WExecEvent {
  type: "exec.queued" | "exec.started" | "exec.finished";
  execId: number;
  position?: number;
  reason?: ExecResult["reason"] | "cancelled_before_start" | "refused";
  exitCode?: number;
  durationMs?: number;
  commit?: { written: number; deleted: number; conflicts: number; kept: number; rejected: number; failed: number; renamed: number };
  /** 本次改动是否被丢弃（强制终止、超时、资源上限、错误）。 */
  discarded?: boolean;
}

export interface WCoreDomainOptions {
  broker: FileBroker;
  /** 工作区：broker 区域名 + 宿主根目录（读盘、写入留在内存，结束后提交）。 */
  work: { zone: string; root: string };
  /** 只读挂载：材料快照、（可选）可信区的宿主根目录。 */
  readOnlyRoots: string[];
  /**
   * 落盘加密（审计 S3 第 2 步）：哪些挂载在盘上是 KWE1 密文及其区密钥（工作区；只读挂载按根目录）。W 的读层据此解封；
   * strict = 盘上出现的非空明文一律拒读。写入经 broker 提交时由 broker 的区编解码器封装（与这里给的是同一把区密钥）。
   */
  sealed?: { work?: ZoneKeysOfPurpose; readOnly?: Record<string, ZoneKeysOfPurpose>; strict: boolean };
  pathClass: PathClass;
  /** 任务临时目录（W 进程唯一可写的真实目录）。 */
  tmpDir: string;
  supervisor?: Omit<WSupervisorOptions, "dataDirs" | "tmpDir">;
  limits?: Partial<ExecLimits>;
  commitLimits?: Partial<CommitLimits>;
  maxWaiting?: number;
  /** 执行域不可用后的自动恢复探测：首次退避（缺省 30 秒），之后指数增长到 10 分钟（第二轮复核 S3-28）。 */
  recoveryRetryMs?: number;
  onEvent?: (e: WExecEvent) => void;
}

/** 与上游 IHostProcess 同形（kap-host 的 HostProcessLike）。 */
export interface WProcess {
  readonly _serviceBrand: undefined;
  readonly pid: number;
  readonly exitCode: number | null;
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  wait(): Promise<number>;
  kill(signal?: NodeJS.Signals): Promise<void>;
  dispose(): void | Promise<void>;
  /** 本次提交报告（结束后可得；供审计与测试）。 */
  readonly commitReport: CommitReport | null;
}

const SYNTHETIC_PID_BASE = 700_000;

/** 宿主侧并发槽（FIFO；排队有上限）。 */
class Slots {
  private free: number;
  private readonly waiters: { grant: () => void; onPosition?: (p: number) => void }[] = [];
  private readonly maxWaiting: number;
  constructor(n: number, maxWaiting: number) {
    this.free = n;
    this.maxWaiting = maxWaiting;
  }
  async acquire(onPosition?: (p: number) => void): Promise<() => void> {
    if (this.free > 0) {
      this.free -= 1;
      return this.releaser();
    }
    if (this.waiters.length >= this.maxWaiting) throw new QueueFullError(this.maxWaiting);
    await new Promise<void>((grant) => {
      this.waiters.push({ grant, ...(onPosition ? { onPosition } : {}) });
      onPosition?.(this.waiters.length);
    });
    return this.releaser();
  }
  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next.grant();
        this.waiters.forEach((w, i) => w.onPosition?.(i + 1));
      } else this.free += 1;
    };
  }
}

export class QueueFullError extends Error {
  readonly code = "execution_queue_full";
  constructor(n: number) {
    super(`本事项排队等待执行的命令已达上限（${n} 条），请等前面的命令结束后再试`);
  }
}

interface Job {
  cancelled: null | "SIGTERM" | "SIGKILL";
  execId: number | null;
  done: boolean;
}

export class WCoreDomain {
  readonly id = "W-core" as const;
  readonly label = W_CORE_LABEL;
  readonly supervisor: WSupervisor;
  private readonly limits: ExecLimits;
  private readonly commitLimits: CommitLimits;
  private readonly mounts: MountSpec[];
  private readonly o: WCoreDomainOptions;
  private readonly slots: Slots;
  /** 取消纪元（abortAll 递增）：纪元变化后，尚未开始的命令不再开始。 */
  private abortEpoch = 0;
  private readonly live = new Set<Job>();
  private nextLocalId = 1;
  private closed = false;
  /** 最近一次“执行域不可用”的原因（W 进程重启或自检失败；成功执行一次或恢复探测通过即清除）——账本与宿主策略据此如实反映（复核 S3-23）。 */
  private unavailable: string | null = null;
  /**
   * 恢复探测（第二轮复核 S3-28）：不可用时宿主策略拒绝 Bash，不会再有调用到达执行域——由 health() 按退避发起一次
   * 拉起 + 自检（含真实 worker 往返），通过即清除；同一时刻只有一轮探测。
   */
  private probeAt = 0;
  private probeBackoffMs = 0;
  private probing: Promise<void> | null = null;

  private constructor(o: WCoreDomainOptions) {
    this.o = o;
    this.limits = { ...DEFAULT_EXEC_LIMITS, ...o.limits };
    this.commitLimits = { ...DEFAULT_COMMIT_LIMITS, ...o.commitLimits };
    const sealedOf = (keys: ZoneKeysOfPurpose | undefined) => (keys ? { sealed: { keys, strict: o.sealed?.strict ?? true } } : {});
    this.mounts = [
      { mountPoint: toShellPath(o.work.root, o.pathClass), root: o.work.root, readOnly: false, ...sealedOf(o.sealed?.work) },
      ...o.readOnlyRoots.map((r) => ({ mountPoint: toShellPath(r, o.pathClass), root: r, readOnly: true, ...sealedOf(o.sealed?.readOnly?.[r]) })),
    ];
    this.supervisor = new WSupervisor({ ...o.supervisor, dataDirs: [o.work.root, ...o.readOnlyRoots], tmpDir: o.tmpDir });
    this.slots = new Slots(Math.max(1, o.supervisor?.maxConcurrent ?? 2), o.maxWaiting ?? DEFAULT_MAX_WAITING);
  }

  /** 拉起 W 进程并自检（含一次真实 worker 往返）；不通过即抛 WUnavailableError（调用方保持“执行域不可用”）。 */
  static async start(o: WCoreDomainOptions): Promise<WCoreDomain> {
    const d = new WCoreDomain(o);
    try {
      await d.supervisor.ensure();
    } catch (e) {
      await d.supervisor.close().catch(() => {});
      throw e;
    }
    return d;
  }

  /** 挂载点（shell 形式）列表：Bash 可见的全部真实目录。 */
  mountPoints(): string[] {
    return this.mounts.map((m) => m.mountPoint);
  }

  shellPath(hostPath: string): string {
    return toShellPath(hostPath, this.o.pathClass);
  }

  async run(command: string, opts: { cwd: string; env?: Record<string, string> }): Promise<WProcess> {
    if (this.closed) throw new WUnavailableError("执行域已关闭");
    const job: Job = { cancelled: null, execId: null, done: false };
    const epoch = this.abortEpoch;
    this.live.add(job);
    const localId = this.nextLocalId++;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    stdin.resume(); // 上游会立即关闭 stdin；W 不读 stdin
    const state: { exitCode: number | null; report: CommitReport | null } = { exitCode: null, report: null };
    let resolveWait!: (n: number) => void;
    const waited = new Promise<number>((r) => {
      resolveWait = r;
    });
    void this.drive(job, epoch, localId, command, opts.cwd, stdout, stderr).then((r) => {
      state.exitCode = r.exitCode;
      state.report = r.report;
      job.done = true;
      this.live.delete(job);
      stdout.end();
      stderr.end();
      resolveWait(r.exitCode);
    });
    const sup = this.supervisor;
    return {
      _serviceBrand: undefined,
      pid: SYNTHETIC_PID_BASE + localId,
      get exitCode() {
        return state.exitCode;
      },
      stdin,
      stdout,
      stderr,
      wait: () => waited,
      async kill(signal?: NodeJS.Signals) {
        if (job.done) return;
        const how = signal === "SIGKILL" ? "SIGKILL" : "SIGTERM";
        if (job.execId === null) job.cancelled = how === "SIGKILL" || job.cancelled === "SIGKILL" ? "SIGKILL" : "SIGTERM";
        else if (how === "SIGKILL") sup.kill(job.execId);
        else sup.abort(job.execId);
      },
      dispose() {
        if (job.done) return;
        if (job.execId === null) job.cancelled = "SIGKILL";
        else sup.kill(job.execId);
      },
      get commitReport() {
        return state.report;
      },
    };
  }

  private stale(job: Job, epoch: number): boolean {
    return job.cancelled !== null || epoch !== this.abortEpoch || this.closed;
  }

  private async drive(
    job: Job,
    epoch: number,
    localId: number,
    command: string,
    cwd: string,
    stdout: PassThrough,
    stderr: PassThrough,
  ): Promise<{ exitCode: number; report: CommitReport | null }> {
    const started = Date.now();
    const finished = (e: Omit<WExecEvent, "type" | "execId">) => this.o.onEvent?.({ type: "exec.finished", execId: localId, durationMs: Date.now() - started, ...e });
    let release: (() => void) | null = null;
    try {
      try {
        release = await this.slots.acquire((position) => this.o.onEvent?.({ type: "exec.queued", execId: localId, position }));
      } catch (e) {
        stderr.write(`[执行域] ${(e as Error).message}\n`);
        finished({ reason: "refused", exitCode: 1 });
        return { exitCode: 1, report: null };
      }
      const cancelledBeforeStart = (): { exitCode: number; report: null } => {
        const code = job.cancelled === "SIGTERM" ? 143 : 137;
        stderr.write("[执行域] 命令在开始执行前已被取消，未运行、未改动工作区。\n");
        finished({ reason: "cancelled_before_start", exitCode: code });
        return { exitCode: code, report: null };
      };
      if (this.stale(job, epoch)) return cancelledBeforeStart();
      // 基线 + 链接预检：在命令真正开始时采集（复核 S3-21：不持写入临界区——写入与删除都按基线身份比较—替换，
      // 基线早一点只会多出假冲突，不会丢数据；只读挂载只做链接预检）
      let baseline: Baseline;
      try {
        baseline = await captureBaseline(this.o.work.root);
        for (const r of this.o.readOnlyRoots) await captureBaseline(r);
      } catch (e) {
        stderr.write(`[执行域] ${(e as Error).message}\n`);
        finished({ reason: "refused", exitCode: 1 });
        return { exitCode: 1, report: null };
      }
      if (this.stale(job, epoch)) return cancelledBeforeStart();
      let handle: { id: number; result: Promise<ExecResult> };
      try {
        handle = await this.supervisor.exec(
          { script: command, cwd: this.shellPath(cwd), env: { ...FIXED_ENV }, mounts: this.mounts, limits: this.limits },
          {
            onChunk: (c) => {
              if (c.stdout) stdout.write(c.stdout);
              if (c.stderr) stderr.write(c.stderr);
            },
          },
        );
      } catch (e) {
        this.markUnavailable((e as Error).message);
        stderr.write(`[执行域] 执行域不可用：${(e as Error).message}\n`);
        finished({ reason: "error", exitCode: 1 });
        return { exitCode: 1, report: null };
      }
      this.markAvailable();
      job.execId = handle.id;
      this.o.onEvent?.({ type: "exec.started", execId: localId });
      // 开始执行的同一时刻若已被取消：立即传达
      if (this.stale(job, epoch)) {
        if (job.cancelled === "SIGTERM" && epoch === this.abortEpoch) this.supervisor.abort(handle.id);
        else this.supervisor.kill(handle.id);
      }
      const r = await handle.result;
      if (r.stdout) stdout.write(r.stdout);
      if (r.stderr) stderr.write(r.stderr);
      // 执行域上限只认结构化信号（worker 在 just-bash 构造上限错误、python3 报告共享缓冲上限时置位），与退出码、stderr 文本无关
      const limitHit = r.limit !== undefined;
      const discard = r.reason === "killed" || r.reason === "timeout" || r.reason === "error" || limitHit;
      const ws = r.changes.find((c) => c.mountPoint === this.mounts[0]!.mountPoint);
      const hasChanges = !!ws && (ws.files.length > 0 || ws.dirs.length > 0 || ws.deleted.length > 0 || ws.links.length > 0);
      let report: CommitReport | null = null;
      if (discard) {
        const why =
          r.reason === "killed"
            ? "命令被强制终止"
            : r.reason === "timeout"
              ? "命令超过执行时限"
              : limitHit && r.limit?.startsWith("sealed_read_refused")
                ? "命令读取了无法解密的工作区或材料文件（外部写入的明文、已损坏或格式不符的文件）"
                : limitHit
                  ? `命令触及执行域资源上限（${r.limit ?? "输出、内存或时长"}）`
                  : "执行域内部错误";
        stderr.write(`[执行域] ${why}，本次命令对工作区的改动一律未写回（避免不完整或被截断的文件覆盖原文件）。\n`);
      } else if (ws && hasChanges) {
        try {
          report = await this.o.broker.exclusive(() => commitChanges(this.o.broker, this.o.work.zone, ws, baseline, this.commitLimits));
          const note = describeReport(report, this.mounts[0]!.mountPoint);
          if (note) stderr.write(note);
        } catch (e) {
          stderr.write(`[执行域] 工作区改动提交失败：${(e as Error).message}\n`);
          report = { written: [], deleted: [], dirs: [], renamed: [], conflicts: [], kept: [], unchanged: 0, rejected: [], failed: [{ path: "*", reason: "commit_error" }] };
        }
      }
      let exitCode = r.reason === "aborted" ? 143 : r.reason === "killed" ? 137 : r.reason === "timeout" ? 124 : r.exitCode;
      if (exitCode === 0 && limitHit) exitCode = 126;
      if (commitIncomplete(report)) {
        if (exitCode === 0) {
          exitCode = EXIT_COMMIT_INCOMPLETE;
          stderr.write(`[执行域] 退出码 ${EXIT_COMMIT_INCOMPLETE}：命令本身已执行完毕，但对工作区的改动没有完整写回（见上）。\n`);
        } else stderr.write(`[执行域] 对工作区的改动没有完整写回（见上）；退出码保持命令本身的值 ${exitCode}。\n`);
      }
      finished({
        reason: r.reason,
        exitCode,
        ...(discard && hasChanges ? { discarded: true } : {}),
        ...(report
          ? {
              commit: {
                written: report.written.length,
                deleted: report.deleted.length,
                conflicts: report.conflicts.length,
                kept: report.kept.length,
                rejected: report.rejected.length,
                failed: report.failed.length,
                renamed: report.renamed.length,
              },
            }
          : {}),
      });
      return { exitCode, report };
    } finally {
      release?.();
    }
  }

  private markUnavailable(reason: string): void {
    this.unavailable = reason;
    const base = this.o.recoveryRetryMs ?? 30_000;
    this.probeBackoffMs = this.probeBackoffMs > 0 ? Math.min(this.probeBackoffMs * 2, 600_000) : base;
    this.probeAt = Date.now() + this.probeBackoffMs;
  }

  private markAvailable(): void {
    this.unavailable = null;
    this.probeBackoffMs = 0;
    this.probeAt = 0;
  }

  /**
   * 执行域健康：null = 可用；否则为最近一次不可用的原因（W 进程拉起或自检失败）。不可用且退避已到时发起一轮恢复探测（异步；
   * 本次仍返回不可用，探测通过后的下一次查询返回可用）。
   */
  health(): string | null {
    if (this.closed) return "执行域已关闭";
    if (this.unavailable !== null && !this.probing && Date.now() >= this.probeAt) {
      this.probing = this.supervisor
        .ensure()
        .then(
          () => this.markAvailable(),
          (e: unknown) => this.markUnavailable((e as Error)?.message ?? String(e)),
        )
        .finally(() => {
          this.probing = null;
        });
    }
    return this.unavailable;
  }

  /** 测试与诊断：等待在途的恢复探测结束。 */
  async settleProbe(): Promise<void> {
    await this.probing;
  }

  /** 终止本事项全部在途与排队中的执行（运行取消、超时、失败时由宿主调用；内存层改动丢弃，不提交）。 */
  abortAll(_reason: string): number {
    this.abortEpoch += 1;
    let n = 0;
    for (const job of this.live) {
      n += 1;
      if (job.execId === null) job.cancelled = "SIGKILL";
      else this.supervisor.kill(job.execId);
    }
    return n;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abortAll("closed");
    await this.supervisor.close();
  }
}

export { WUnavailableError };
