/**
 * W 执行域协议（宿主 ⇄ W 监督进程 ⇄ 每调用 worker）。只含可结构化克隆的数据。
 */
import type { ZoneKeysOfPurpose } from "@zr-legal/at-rest";

/** 挂载：mountPoint 与宿主路径的 shell 形式相同（单一路径命名空间，v9 第 04 篇 §4.1）。 */
export interface MountSpec {
  mountPoint: string;
  /** 宿主上的真实目录（W 进程经 --allow-fs-read 只读访问）。 */
  root: string;
  /** 材料快照只读；工作区可写——写入留在内存（OverlayFs），执行结束由宿主经文件 broker 校验后提交。 */
  readOnly: boolean;
  /**
   * 落盘加密（审计 S3 第 2 步）：本挂载在盘上是 KWE1 密文——worker 的读层按这把区密钥解封（读内容、报告明文长度）；写入仍留在内存层，
   * 由宿主经文件 broker 提交时封装。strict = 盘上出现的非空明文一律拒读（存量已在引擎打开前迁移）。只含本挂载用途的区密钥。
   */
  sealed?: { keys: ZoneKeysOfPurpose; strict: boolean };
}

export interface ExecLimits {
  /** 单次调用的总时长（宿主按调用类型设置：前台 ≤ 5 分钟、后台 ≤ 60 分钟；禁止无限）。 */
  maxExecutionTimeMs: number;
  /** stdout + stderr 总量上限。 */
  maxOutputSize: number;
  /** 单个读入文件上限。 */
  maxFileReadSize: number;
  /** 工作区写入（内存层）总量上限。 */
  maxMemoryBytes: number;
  /** 内存文件系统（/tmp、/home 等）总量上限。 */
  maxFileSystemBytes: number;
  /** 循环、命令数等计数上限（hardened 档的 1 万对数据任务偏紧，由宿主放宽到这里；时长与内存仍有独立上限）。 */
  maxIterations: number;
}

export interface ExecRequest {
  t: "exec";
  id: number;
  script: string;
  cwd: string;
  env: Record<string, string>;
  mounts: MountSpec[];
  limits: ExecLimits;
}

/** 工作区改动（来自 OverlayFs 内存层与删除集合）；路径为挂载点内的相对路径（以 / 分隔）。 */
export interface ChangeSet {
  mountPoint: string;
  files: { path: string; content: Uint8Array }[];
  dirs: string[];
  deleted: string[];
  /** 内存层出现的链接（符号链接或硬链接）——提交时一律拒绝。 */
  links: string[];
}

/** 流式输出：每个顶层语句结束时发出（just-bash 自维护补丁 KJ-1..3；单个命令内部的输出在该命令结束时一次给出）。 */
export interface ExecChunk {
  t: "chunk";
  id: number;
  stdout: string;
  stderr: string;
}

export interface ExecResult {
  t: "result";
  id: number;
  /** 尚未以 chunk 发出的剩余输出（宿主按 chunk + result 的顺序拼接）。 */
  stdout: string;
  stderr: string;
  exitCode: number;
  /** 终止原因：completed / aborted（SIGTERM 协作停止）/ killed（SIGKILL 终止 worker）/ timeout / error。 */
  reason: "completed" | "aborted" | "killed" | "timeout" | "error";
  changes: ChangeSet[];
  error?: string;
  /** 命令因执行域自身的资源上限终止时的说明（输出、内存、时长、计数）；有值时宿主不提交改动（审查 S3-05）。 */
  limit?: string;
}

export type SupervisorRequest = ExecRequest | { t: "abort"; id: number } | { t: "kill"; id: number } | { t: "selftest"; id: number } | { t: "shutdown" };

export interface SelftestResult {
  t: "selftest";
  id: number;
  permission: { fsReadEtc: boolean; fsWriteHome: boolean; net: boolean; child: boolean; addon: boolean; wasi: boolean; worker: boolean };
  dns: string;
  readEtc: string;
  rss: number;
  node: string;
}

export type SupervisorMessage = { t: "ready"; pid: number } | ExecChunk | ExecResult | SelftestResult | { t: "queued"; id: number; position: number };
