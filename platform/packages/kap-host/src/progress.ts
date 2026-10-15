/**
 * 运行过程快照（Kimi Code 增量核查 K7-P）：把引擎里“有、但律师看不到”的过程信息汇成一份最新快照——
 * 主 Agent 的工作清单（TodoList）、子任务与集群成员、后台任务、进展通知（NotifyUser）、上下文整理（压缩）、已加载的方法模板、
 * 模型重试。快照只在内存里经 IPC 交内核（与流式文字同一口径，不落账本）；里程碑（子任务起止、整理发生、方法模板加载）另作时间线事件。
 *
 * 事件与字段以锁版上游协议为准（third_party/kimi-code/packages/kap-server/src/protocol/events-zod.ts：tool.call.started.args、
 * subagent.*、compaction.*、task.* / background.task.*、turn.step.retrying），由 embed-drift 测试锁定。
 * 内容多为模型生成的文字（令牌形态）：长度一律截断，界面渲染时还原代号。摘要正文（压缩摘要）可能含材料原文，不出宿主。
 *
 * 复核 B4-B01：上下文整理只认主 Agent（子 Agent 自己的压缩不计入主任务的“第 N 次”，也不让律师看到“对话过长”）；
 * 整理的触发方式在 `compaction.started` 记下（`completed` 没有该字段），限定为 manual|auto；子任务超过快照条数上限后快照不再加项，
 * 但起止里程碑照发（时间线完整）；方法模板在工具成功返回（`tool.result` 且非错误）后才记——参数校验或审批被拒的调用不算“已按模板执行”。
 */

export type TodoStatus = "pending" | "in_progress" | "done";
export type SubagentStatus = "running" | "done" | "failed" | "cancelled" | "paused";
export type TaskStatus = "running" | "done" | "failed" | "stopped";

export interface RunProgress {
  todo: { title: string; status: TodoStatus }[];
  subagents: { id: string; name: string; description: string; status: SubagentStatus; swarm_index: number | null; background: boolean; summary: string | null }[];
  tasks: { id: string; kind: "bash" | "agent" | "other"; description: string; status: TaskStatus }[];
  notes: { at: string; text: string; agent_id: string }[];
  compaction: { count: number; running: boolean; blocked: boolean; last_at: string | null; tokens_before: number | null; tokens_after: number | null };
  skills: string[];
  /** 模型请求失败后引擎正在重试（主 Agent）；下一步成功即清除。 */
  retry: { attempt: number; max: number; status_code: number | null; at: string } | null;
  /**
   * 主 Agent 当前在做什么（UIUX 增量评审 P0-D）：思考 / 写回复 / 执行工具 / 重试，及进入该阶段的时刻；
   * heartbeat_at = 引擎最近一次有任何事件（含思考与子任务）的时刻——界面据此区分“在忙但还没有可显示的东西”与“真的没动静”。
   */
  activity: { phase: ActivityPhase | null; since: string | null; tool: string | null; heartbeat_at: string | null };
}

export type ActivityPhase = "thinking" | "writing" | "tool" | "retrying";
/** 心跳单独推送的最短间隔（只有心跳变化时不必每条流式事件都推一次快照）。 */
export const HEARTBEAT_PUSH_MS = 15_000;

export const PROGRESS_LIMITS = Object.freeze({ todo: 30, todoTitle: 120, subagents: 32, description: 200, summary: 1_000, tasks: 16, notes: 5, note: 1_000, skills: 8 });
/** 记住的子任务编号上限（超过快照条数后只为里程碑去重；集群单次最多 128 个成员）。 */
const KNOWN_SUBAGENTS_MAX = 1_024;
/** 等待返回结果的方法模板调用上限。 */
const PENDING_SKILLS_MAX = 16;

const str = (v: unknown, n: number): string => (typeof v === "string" ? v.slice(0, n) : "");

/** 里程碑：进入执行态时间线（账本）的事件，只含编号、状态与计数，不含模型生成的文字。 */
export interface ProgressMilestone {
  type: "run.subagent" | "run.compaction" | "run.skill";
  payload: Record<string, unknown>;
}

export class ProgressTracker {
  private readonly p: RunProgress = {
    todo: [],
    subagents: [],
    tasks: [],
    notes: [],
    compaction: { count: 0, running: false, blocked: false, last_at: null, tokens_before: null, tokens_after: null },
    skills: [],
    retry: null,
    activity: { phase: null, since: null, tool: null, heartbeat_at: null },
  };
  private lastBeatPush = 0;
  /** 受信的方法模板名（已验签清单）；不在清单内的名字不记（模型可能拼错或编造）。 */
  private readonly trustedSkills: ReadonlySet<string>;
  /** 见过的子任务编号（含超出快照条数上限的；里程碑去重与收尾用）。 */
  private readonly knownSubagents = new Set<string>();
  /** 已发起、尚未返回的方法模板调用（工具调用 ID → 模板名）。 */
  private readonly pendingSkills = new Map<string, string>();
  /** 主 Agent 进行中的上下文整理的触发方式（started 时记下，completed 时带出）。 */
  private compactionTrigger: "manual" | "auto" | null = null;
  constructor(trustedSkills: ReadonlySet<string> = new Set()) {
    this.trustedSkills = trustedSkills;
  }

  snapshot(): RunProgress {
    return structuredClone(this.p);
  }

  /** 应用一条引擎事件；返回 { changed（过程内容变化）, beat（阶段变化或到了心跳推送间隔）, milestone }。 */
  apply(type: string, payload: Record<string, any>, now = new Date()): { changed: boolean; beat: boolean; milestone?: ProgressMilestone } {
    const r = this.applyContent(type, payload, now);
    return { ...r, beat: this.touch(type, payload, now) };
  }

  /** 心跳与阶段：阶段变化即算变化；只有心跳时按 HEARTBEAT_PUSH_MS 节流。 */
  private touch(type: string, payload: Record<string, any>, now: Date): boolean {
    const a = this.p.activity;
    const at = now.toISOString();
    a.heartbeat_at = at;
    let changed = false;
    if (now.getTime() - this.lastBeatPush >= HEARTBEAT_PUSH_MS) changed = true;
    const main = (typeof payload.agentId === "string" ? payload.agentId : "main") === "main";
    if (main) {
      let next: ActivityPhase | null | undefined;
      let tool: string | null = null;
      if (type === "turn.started" || type === "turn.step.started" || type === "thinking.delta" || type === "tool.result") next = "thinking";
      else if (type === "assistant.delta") next = "writing";
      else if (type === "tool.call.started") {
        next = "tool";
        tool = str(payload.name, 40) || null;
      } else if (type === "turn.step.retrying") next = "retrying";
      else if (type === "turn.ended") next = null;
      if (next !== undefined && (next !== a.phase || tool !== a.tool)) {
        a.phase = next;
        a.tool = next === "tool" ? tool : null;
        a.since = next === null ? null : at;
        changed = true;
      }
    }
    if (changed) this.lastBeatPush = now.getTime();
    return changed;
  }

  private applyContent(type: string, payload: Record<string, any>, now: Date): { changed: boolean; milestone?: ProgressMilestone } {
    const at = now.toISOString();
    const agentId = typeof payload.agentId === "string" ? payload.agentId : "main";
    switch (type) {
      case "tool.call.started": {
        const args = (payload.args ?? {}) as Record<string, unknown>;
        if (payload.name === "TodoList" && agentId === "main" && Array.isArray(args.todos)) {
          this.p.todo = args.todos.slice(0, PROGRESS_LIMITS.todo).flatMap((t) => {
            const title = str((t as { title?: unknown })?.title, PROGRESS_LIMITS.todoTitle).trim();
            const s = (t as { status?: unknown })?.status;
            return title ? [{ title, status: s === "in_progress" || s === "done" ? s : "pending" }] : [];
          });
          return { changed: true };
        }
        if (payload.name === "NotifyUser") {
          // 上游工具说明要求约 1000 字以内（复核 S5B-02）：超出部分截去并注明，不静默丢字
          const raw = typeof args.message === "string" ? args.message : typeof args.text === "string" ? args.text : "";
          const text = (raw.length > PROGRESS_LIMITS.note ? `${raw.slice(0, PROGRESS_LIMITS.note - 8)}…（已截断）` : raw).trim();
          if (!text) return { changed: false };
          this.p.notes = [...this.p.notes, { at, text, agent_id: agentId }].slice(-PROGRESS_LIMITS.notes);
          return { changed: true };
        }
        if (payload.name === "Skill" && agentId === "main") {
          // 只记下待返回的调用：成功返回后才算“已按方法模板执行”（复核 B4-B01）
          const name = str(args.skill, 80);
          const callId = str(payload.toolCallId, 200);
          if (!callId || !this.trustedSkills.has(name) || this.p.skills.includes(name)) return { changed: false };
          if (this.pendingSkills.size >= PENDING_SKILLS_MAX) this.pendingSkills.delete(this.pendingSkills.keys().next().value!);
          this.pendingSkills.set(callId, name);
          return { changed: false };
        }
        return { changed: false };
      }
      case "tool.result": {
        const callId = str(payload.toolCallId, 200);
        const name = callId ? this.pendingSkills.get(callId) : undefined;
        if (name === undefined || agentId !== "main") return { changed: false };
        this.pendingSkills.delete(callId);
        const failed = payload.isError === true || (payload.output as { isError?: unknown } | null | undefined)?.isError === true;
        if (failed || this.p.skills.includes(name)) return { changed: false };
        this.p.skills = [...this.p.skills, name].slice(0, PROGRESS_LIMITS.skills);
        return { changed: true, milestone: { type: "run.skill", payload: { skill: name } } };
      }
      case "subagent.spawned": {
        const id = str(payload.subagentId, 80);
        if (!id || this.knownSubagents.has(id)) return { changed: false };
        if (this.knownSubagents.size < KNOWN_SUBAGENTS_MAX) this.knownSubagents.add(id);
        const swarmIndex = typeof payload.swarmIndex === "number" && Number.isFinite(payload.swarmIndex) ? payload.swarmIndex : null;
        const milestone: ProgressMilestone = { type: "run.subagent", payload: { subagent_id: id, event: "spawned", swarm_index: swarmIndex, background: payload.runInBackground === true } };
        // 快照条数有上限；超出后不再加项，但里程碑照发（复核 B4-B01：超预算获批的长集群时间线完整）
        if (this.p.subagents.length >= PROGRESS_LIMITS.subagents) return { changed: false, milestone };
        this.p.subagents.push({
          id,
          name: str(payload.subagentName, 60),
          description: str(payload.description, PROGRESS_LIMITS.description),
          status: "running",
          swarm_index: swarmIndex,
          background: payload.runInBackground === true,
          summary: null,
        });
        return { changed: true, milestone };
      }
      case "subagent.completed":
      case "subagent.failed":
      case "subagent.cancelled":
      case "subagent.suspended": {
        const id = str(payload.subagentId, 80);
        const s = id ? this.p.subagents.find((x) => x.id === id) : undefined;
        if (!s && !(id && this.knownSubagents.has(id))) return { changed: false };
        const status: SubagentStatus = type === "subagent.completed" ? "done" : type === "subagent.failed" ? "failed" : type === "subagent.cancelled" ? "cancelled" : "paused";
        const u = payload.usage as { inputOther?: unknown; output?: unknown; inputCacheRead?: unknown; inputCacheCreation?: unknown } | undefined;
        const tokens = u ? [u.inputOther, u.output, u.inputCacheRead, u.inputCacheCreation].reduce<number>((n, v) => n + (typeof v === "number" && Number.isFinite(v) ? v : 0), 0) : null;
        const milestone: ProgressMilestone = { type: "run.subagent", payload: { subagent_id: id, event: status, tokens } };
        // 超出快照条数的成员：只发里程碑
        if (!s) return { changed: false, milestone };
        s.status = status;
        if (type === "subagent.completed") s.summary = str(payload.resultSummary, PROGRESS_LIMITS.summary) || null;
        if (type === "subagent.failed") s.summary = str(payload.error, PROGRESS_LIMITS.description) || null;
        return { changed: true, milestone };
      }
      // 上下文整理只认主 Agent（复核 B4-B01：上游四个压缩事件都带 agentId；子 Agent 自己的压缩不算进主任务）
      case "compaction.started":
        if (agentId !== "main") return { changed: false };
        this.p.compaction.running = true;
        this.compactionTrigger = payload.trigger === "manual" || payload.trigger === "auto" ? payload.trigger : null;
        return { changed: true };
      case "compaction.completed": {
        if (agentId !== "main") return { changed: false };
        const r = (payload.result ?? {}) as { tokensBefore?: unknown; tokensAfter?: unknown; droppedCount?: unknown };
        const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
        const c = this.p.compaction;
        c.running = false;
        c.blocked = false;
        c.count += 1;
        c.last_at = at;
        c.tokens_before = num(r.tokensBefore);
        c.tokens_after = num(r.tokensAfter);
        const trigger = this.compactionTrigger;
        this.compactionTrigger = null;
        // 摘要正文不出宿主（可能含材料原文）
        return { changed: true, milestone: { type: "run.compaction", payload: { event: "completed", trigger, tokens_before: c.tokens_before, tokens_after: c.tokens_after, dropped: num(r.droppedCount), count: c.count } } };
      }
      // compaction.blocked 是“本步等整理完成再继续”，不是失败（上游 fullCompactionService.beforeStep：shouldBlock → 等待压缩）；
      // 2026-10-14 压缩验收取证：事件顺序为 started → blocked → completed。此前把它当失败，时间线会提示律师“拆小任务”且丢掉触发方式
      case "compaction.blocked":
        if (agentId !== "main") return { changed: false };
        this.p.compaction.running = true;
        this.p.compaction.blocked = true;
        return { changed: true };
      // 整理失败不是事件，而是回合错误（错误码 compaction.failed / compaction.unable），经任务错误如实提示
      case "compaction.cancelled":
        if (agentId !== "main") return { changed: false };
        this.p.compaction.running = false;
        this.p.compaction.blocked = false;
        this.compactionTrigger = null;
        return { changed: true, milestone: { type: "run.compaction", payload: { event: "cancelled", count: this.p.compaction.count } } };
      case "task.started":
      case "background.task.started":
      case "task.terminated":
      case "background.task.terminated": {
        const info = (payload.info ?? {}) as { taskId?: unknown; kind?: unknown; description?: unknown; status?: unknown };
        const id = str(info.taskId, 80);
        if (!id || info.kind === "question") return { changed: false };
        const status: TaskStatus = info.status === "running" ? "running" : info.status === "completed" ? "done" : info.status === "killed" ? "stopped" : "failed";
        const kind = info.kind === "process" ? "bash" : info.kind === "agent" ? "agent" : "other";
        const existing = this.p.tasks.find((t) => t.id === id);
        if (existing) existing.status = status;
        else if (this.p.tasks.length < PROGRESS_LIMITS.tasks) this.p.tasks.push({ id, kind, description: str(info.description, PROGRESS_LIMITS.description), status });
        else return { changed: false };
        return { changed: true };
      }
      case "turn.step.retrying": {
        if (agentId !== "main") return { changed: false };
        this.p.retry = {
          attempt: typeof payload.nextAttempt === "number" ? payload.nextAttempt : 0,
          max: typeof payload.maxAttempts === "number" ? payload.maxAttempts : 0,
          status_code: typeof payload.statusCode === "number" ? payload.statusCode : null,
          at,
        };
        return { changed: true };
      }
      case "turn.step.completed":
        if (agentId !== "main" || this.p.retry === null) return { changed: false };
        this.p.retry = null;
        return { changed: true };
      default:
        return { changed: false };
    }
  }
}
