/**
 * A1 Agent 任务客户端（阶段 1 过渡形态）：内核 → agent-runtime 服务的内部 HTTP。
 * 阶段 2 迁移为 apps/agent-host（内核经命名管道拉起每任务宿主进程 + ZP-5/6），接口语义不变。
 */
import { DomainError } from "@zr-legal/domain";
import { mintTaskToken } from "../identity.ts";

export interface AgentClient {
  start(id: { tid: string; uid: string; mid: string; rid: string; aid: string }, req: { goal: string; materials: { filename: string; text: string }[]; timeout_ms?: number }): Promise<string>;
  poll(id: { tid: string; uid: string }, taskId: string, cursor: number): Promise<AgentTaskPoll>;
  cancel(id: { tid: string; uid: string }, taskId: string, reason: string): Promise<void>;
}

export interface AgentTaskPoll {
  status: "starting" | "running" | "succeeded" | "failed" | "cancelled";
  events: { seq: number; type: string; payload: Record<string, unknown>; at: string }[];
  next_cursor: number;
  output_text: string;
  error: string | null;
}

export function createHttpAgentClient(baseUrl: string): AgentClient {
  return {
    async start(id, req) {
      const token = mintTaskToken({ ...id, scope: ["agent:internal"] });
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/agent/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ matter_id: id.mid, goal: req.goal, materials: req.materials, timeout_ms: req.timeout_ms }),
        });
      } catch (e) {
        throw new DomainError("provider_unavailable", `agent-runtime 连接失败: ${(e as Error).message}`, 503);
      }
      const data = (await res.json()) as any;
      if (!res.ok) throw new DomainError("internal", `启动 Agent 任务失败: ${data.error ?? res.status}`, 502);
      return data.task_id as string;
    },
    async poll(id, taskId, cursor) {
      const token = mintTaskToken({ ...id, scope: ["agent:internal"] });
      const res = await fetch(`${baseUrl}/agent/tasks/${taskId}/events?cursor=${cursor}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const data = (await res.json()) as any;
      if (!res.ok) throw new DomainError("internal", `轮询 Agent 任务失败: ${data.error ?? res.status}`, 502);
      return data as AgentTaskPoll;
    },
    async cancel(id, taskId, reason) {
      const token = mintTaskToken({ ...id, scope: ["agent:internal"] });
      await fetch(`${baseUrl}/agent/tasks/${taskId}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ reason }),
      }).catch(() => {});
    },
  };
}
