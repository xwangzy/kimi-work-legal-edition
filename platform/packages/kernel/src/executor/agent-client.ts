/**
 * A1 Agent 任务客户端接口（内核 → Agent 宿主）。实现见 agent-host-manager.ts（SDK 形态宿主）与 kap-agent-client.ts（kap-host）。
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
  cancel(id: { tid: string; uid: string }, taskId: string, reason: string): Promise<void>;
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
