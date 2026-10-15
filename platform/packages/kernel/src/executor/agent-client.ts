/**
 * A1 Agent 任务客户端接口（内核 → Agent 宿主）。实现见 kap-agent-client.ts（kap-host；v5 SDK 宿主已于 K9-1 退役）。
 * v4 agent-runtime 的 HTTP 客户端已删除（v9 阶段 4 出网面：内核不保留任何直连外部地址的路径）。
 */
import type { AgentOutcome } from "@zr-legal/domain";

export interface AgentClient {
  /**
   * id.fence：尝试纪元（attempts.fence_token）——任务令牌绑定尝试与纪元，端点逐次复核（v9 第 04 篇 §8；审查 R-06）；
   * req.purpose：运行意图（审批与端点按工具清单的 purposes 校验；审查 R-09）。
   */
  start(
    id: { tid: string; uid: string; mid: string; rid: string; aid: string; fence: number },
    req: { goal: string; materials: { filename: string; text: string }[]; timeout_ms?: number; wall_ms?: number; purpose?: string; fx?: readonly string[]; continue_session_id?: string },
  ): Promise<string>;
  poll(id: { tid: string; uid: string }, taskId: string, cursor: number): Promise<AgentTaskPoll>;
  /** 取消；kap-host 适配器返回取消结果（复核 B4-B07：执行器据此直接记入事项账本），SDK 宿主不返回。 */
  cancel(id: { tid: string; uid: string }, taskId: string, reason: string): Promise<AgentCancelOutcome | void>;
}

/**
 * 取消结果（Kimi Code 增量核查 N-1；复核 B4-B07/B4-B08）：
 * - confirmed：宿主确认运行已停止（按版本取消成功、宿主已在终态，或经强制取消成功）；
 * - forced：经强制取消（不比对宿主状态版本；只在内核 IPC 方法表）；
 * - cause：未能按版本取消的原因（version_conflict 重试耗尽、timeout、forbidden 身份不一致、not_found 等）；
 * - error：强制取消也失败时的错误（此时本机任务可能仍在运行）。
 */
export interface AgentCancelOutcome {
  confirmed: boolean;
  forced: boolean;
  cause?: string | null;
  error?: string | null;
}

/** F5：结构化成果（宿主上报文件 + sha256，由管理器校验后按字节交付；不是事件文本拼接）。 */
export interface AgentArtifact {
  kind: string;
  filename: string;
  sha256: string;
  bytes: Uint8Array;
}

export interface AgentTaskPoll {
  /** F1：终态枚举（succeeded / partial / failed / cancelled / timed_out / expired）或进行中。 */
  status: "starting" | "running" | AgentOutcome;
  events: { seq: number; type: string; payload: Record<string, unknown>; at: string }[];
  next_cursor: number;
  /** 界面预览（截断，不可作为成果）。 */
  preview_text: string;
  error: string | null;
  /** 终态原因（不成功时必有）。 */
  reason: string | null;
  /** 校验通过的成果（只在 succeeded / partial 时非空）。 */
  artifacts: AgentArtifact[];
}
