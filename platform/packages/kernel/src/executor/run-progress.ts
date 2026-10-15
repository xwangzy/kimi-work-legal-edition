/**
 * 运行过程快照（Kimi Code 增量核查 K7-P）的内核侧校验：宿主经 IPC 交来的快照按字段白名单与长度上限重建（不信任宿主给的结构），
 * 只保存在内存（与流式文字同一口径，不落账本），经 runs.interactions 交给可信界面；运行结束即不再返回。
 * 文字是令牌形态，界面渲染时还原代号。
 */

export interface RunProgressView {
  todo: { title: string; status: "pending" | "in_progress" | "done" }[];
  subagents: { id: string; name: string; description: string; status: "running" | "done" | "failed" | "cancelled" | "paused"; swarm_index: number | null; background: boolean; summary: string | null }[];
  tasks: { id: string; kind: "bash" | "agent" | "other"; description: string; status: "running" | "done" | "failed" | "stopped" }[];
  notes: { at: string; text: string; agent_id: string }[];
  compaction: { count: number; running: boolean; blocked: boolean; last_at: string | null; tokens_before: number | null; tokens_after: number | null };
  skills: string[];
  retry: { attempt: number; max: number; status_code: number | null; at: string } | null;
  /** 主 Agent 当前阶段与引擎心跳（P0-D）：界面区分“在忙但没有可显示的东西”与“真的没动静”。 */
  activity: { phase: "thinking" | "writing" | "tool" | "retrying" | null; since: string | null; tool: string | null; heartbeat_at: string | null };
}

const arr = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const s = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pick = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T => (allowed.includes(v as T) ? (v as T) : dflt);
const iso = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v) ? v : null);

export function sanitizeProgress(raw: unknown): RunProgressView | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const c = (p.compaction ?? {}) as Record<string, unknown>;
  const r = p.retry as Record<string, unknown> | null | undefined;
  const a = (p.activity ?? {}) as Record<string, unknown>;
  const phase = (["thinking", "writing", "tool", "retrying"] as const).find((x) => x === a.phase) ?? null;
  return {
    todo: arr(p.todo, 30).flatMap((t) => {
      const o = t as Record<string, unknown>;
      const title = s(o?.title, 120).trim();
      return title ? [{ title, status: pick(o.status, ["pending", "in_progress", "done"] as const, "pending") }] : [];
    }),
    subagents: arr(p.subagents, 32).flatMap((t) => {
      const o = t as Record<string, unknown>;
      const id = s(o?.id, 80);
      if (!id) return [];
      return [
        {
          id,
          name: s(o.name, 60),
          description: s(o.description, 200),
          status: pick(o.status, ["running", "done", "failed", "cancelled", "paused"] as const, "running"),
          swarm_index: n(o.swarm_index),
          background: o.background === true,
          summary: typeof o.summary === "string" ? o.summary.slice(0, 1_000) : null,
        },
      ];
    }),
    tasks: arr(p.tasks, 16).flatMap((t) => {
      const o = t as Record<string, unknown>;
      const id = s(o?.id, 80);
      if (!id) return [];
      return [{ id, kind: pick(o.kind, ["bash", "agent", "other"] as const, "other"), description: s(o.description, 200), status: pick(o.status, ["running", "done", "failed", "stopped"] as const, "running") }];
    }),
    notes: arr(p.notes, 5).flatMap((t) => {
      const o = t as Record<string, unknown>;
      const text = s(o?.text, 1_000).trim();
      const at = iso(o?.at);
      return text && at ? [{ at, text, agent_id: s(o.agent_id, 80) || "main" }] : [];
    }),
    compaction: {
      count: Math.max(0, Math.min(1_000, n(c.count) ?? 0)),
      running: c.running === true,
      blocked: c.blocked === true,
      last_at: iso(c.last_at),
      tokens_before: n(c.tokens_before),
      tokens_after: n(c.tokens_after),
    },
    skills: arr(p.skills, 8).flatMap((x) => (typeof x === "string" && /^[\p{L}\p{N}_.-]{1,80}$/u.test(x) ? [x] : [])),
    retry: r && typeof r === "object" && iso(r.at) ? { attempt: n(r.attempt) ?? 0, max: n(r.max) ?? 0, status_code: n(r.status_code), at: iso(r.at)! } : null,
    activity: {
      phase,
      since: phase ? iso(a.since) : null,
      // 工具名只认标识符形态（界面按登记表转成律师用语）
      tool: phase === "tool" && typeof a.tool === "string" && /^[A-Za-z0-9_.:-]{1,40}$/.test(a.tool) ? a.tool : null,
      heartbeat_at: iso(a.heartbeat_at),
    },
  };
}

/**
 * 时间线载荷（执行态时间线镜像到事项账本前；复核 B4-B02）：去掉大字段（计划正文、工具展示结构），文本截断；
 * 过程里程碑（子任务起止、上下文整理、方法模板加载）按字段白名单重建——与过程快照同一口径，不信任宿主给的结构：
 * 未知字段丢弃、超长截断、枚举外的值改为缺省；账本只存编号、状态与计数（D-49）。
 * 确认卡与提问的完整内容经 runs.interactions 取（只在运行期间）。
 */
export function slimAgentPayload(type: string, p: Record<string, unknown>): Record<string, unknown> {
  const cut = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : v);
  switch (type) {
    case "agent.tool_started":
      return { tool_call_id: p.tool_call_id, tool: p.tool, description: cut(p.description, 300), agent_id: p.agent_id };
    case "agent.approval_requested":
      return { approval_id: p.approval_id, tool: p.tool, reason: p.reason, cross_boundary: p.cross_boundary, agent_id: p.agent_id };
    case "agent.question":
      return { question_id: p.question_id, n: Array.isArray(p.questions) ? p.questions.length : 0 };
    case "agent.error":
      // retryable：宿主转来的引擎错误是否由引擎自动重试（复核 B4-B21：界面据此写“正在自动重试”）
      return { code: p.code ?? null, message: cut(p.message, 300), retryable: p.retryable === true };
    case "agent.subagent":
      return {
        subagent_id: s(p.subagent_id, 80),
        event: pick(p.event, ["spawned", "done", "failed", "cancelled", "paused"] as const, "spawned"),
        swarm_index: n(p.swarm_index),
        background: p.background === true,
        tokens: n(p.tokens),
      };
    case "agent.compaction":
      return {
        event: pick(p.event, ["completed", "failed", "cancelled"] as const, "completed"),
        trigger: p.trigger === "manual" || p.trigger === "auto" ? p.trigger : null,
        tokens_before: n(p.tokens_before),
        tokens_after: n(p.tokens_after),
        dropped: n(p.dropped),
        count: n(p.count),
      };
    case "agent.skill":
      return { skill: typeof p.skill === "string" && /^[\p{L}\p{N}_.-]{1,80}$/u.test(p.skill) ? p.skill : null };
    default:
      return p;
  }
}
