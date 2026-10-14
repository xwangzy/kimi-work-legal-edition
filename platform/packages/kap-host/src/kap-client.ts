/**
 * kap-server 有限调用面（v9 第 04 篇 §3.2“路由白名单”：宿主只调用能力账本需要的约 20–30 条路由，其余在宿主侧拒绝，
 * 上游新增路由默认不可达）。
 *
 * - 本类是宿主访问嵌入 kap-server 的**唯一**通道，不提供任何通用透传：每个方法对应一条白名单路由，请求体由本类构造；
 * - 不调用：改会话 profile（可切 yolo/auto 权限模式、换模型、开 Tower/Swarm——调研 kap-api-reference §1.1.1）、
 *   删除会话、生成标题、`:btw`/`:compact`（额外 Agent 与 token 消耗）、`prompts::steer`；
 * - 提示词只含文本部件与宿主选定的模型：不透传 permission_mode / profile / disabled_tools / agent_id；
 *   不接受按本机路径的附件（ZP-22 另在引擎侧拒绝）；
 * - 审批答复只带 decision 与 feedback：不带 scope（`scope:'session'` 会写入持久的会话级放行规则）；
 *   “本任务内允许”由宿主策略自己记录（policy.ts allowForTask）；
 * - 业务错误：kap-server 恒返回 HTTP 200，结果看信封 code（0 = 成功）。
 */
import type { EmbeddedServer, EventEnvelope } from "../vendor/kap-embed/kap-embed.mjs";

export class KapError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data: unknown = null) {
    super(`kap ${code}: ${message}`);
    this.name = "KapError";
    this.code = code;
    this.data = data;
  }
}

/** 宿主可达的 kap-server 路由（方法 + 注册路径）。测试据此证明其余已注册路由不可达。 */
export const KAP_ROUTE_ALLOWLIST: readonly string[] = Object.freeze([
  "POST /api/v1/sessions",
  "GET /api/v1/sessions/:session_id",
  "GET /api/v1/sessions/:session_id/status",
  "POST /api/v1/sessions/:tail",
  "GET /api/v1/sessions/:session_id/children",
  "POST /api/v1/sessions/:session_id/children",
  "GET /api/v1/sessions/:session_id/goal",
  // 只经 enterPlanMode 使用：请求体固定为 {agent_config:{plan_mode:true}}（“先出计划”）；不提供改模型、权限模式、Tower/Swarm 的入口
  "POST /api/v1/sessions/:session_id/profile",
  "POST /api/v1/sessions/:session_id/prompts",
  "POST /api/v1/sessions/:session_id/prompts/:tail",
  "GET /api/v1/sessions/:session_id/approvals",
  "POST /api/v1/sessions/:session_id/approvals/:approval_id",
  "GET /api/v1/sessions/:session_id/questions",
  "POST /api/v1/sessions/:session_id/questions/:tail",
  "GET /api/v1/sessions/:session_id/tasks",
  "GET /api/v1/sessions/:session_id/tasks/:task_id",
  "POST /api/v1/sessions/:session_id/tasks/:tail",
  "GET /api/v1/sessions/:session_id/messages",
  "GET /api/v1/sessions/:session_id/file-history/changes",
  "GET /api/v1/sessions/:session_id/file-history/content",
  "GET /api/v1/sessions/:session_id/snapshot",
  // 不含 …/transcript 与 …/transcript/plan（设计 §5.1 注 a、复核 S3B-A14）：其服务以 fs 直读 wire.jsonl，落盘加密后读到的是密文；宿主不调用
]);

/** `POST /sessions/:tail` 允许的会话动作（不含 :delete、:btw、:compact）。 */
export const SESSION_ACTIONS: ReadonlySet<string> = new Set(["abort", "restore", "archive"]);
/** `POST /prompts/:tail` 允许的动作。 */
export const PROMPT_ACTIONS: ReadonlySet<string> = new Set(["abort"]);
/** `POST /tasks/:tail` 允许的动作（停止后台任务须经宿主策略的确认，见 tool-table T2-stop）。 */
export const TASK_ACTIONS: ReadonlySet<string> = new Set(["cancel"]);

const ID = /^[A-Za-z0-9_.-]{1,128}$/;

function id(v: string, what: string): string {
  if (!ID.test(v)) throw new KapError(40001, `invalid ${what}`);
  return v;
}

export interface KapSession {
  id: string;
  workspace_id: string;
  title: string;
  busy: boolean;
  pending_interaction: "none" | "approval" | "question";
  last_turn_reason?: "completed" | "cancelled" | "failed";
  metadata: { cwd: string; [k: string]: unknown };
  [k: string]: unknown;
}

export interface KapApproval {
  approval_id: string;
  session_id: string;
  agent_id: string;
  turn_id?: number;
  tool_call_id: string;
  tool_name: string;
  action: string;
  tool_input_display: unknown;
  created_at: string;
}

export interface KapQuestion {
  question_id: string;
  session_id: string;
  agent_id?: string;
  tool_call_id?: string;
  questions: {
    id: string;
    question: string;
    header?: string;
    options: { id: string; label: string; description?: string }[];
    multi_select?: boolean;
  }[];
  created_at: string;
}

export type KapAnswer =
  | { kind: "single"; option_id: string }
  | { kind: "multi"; option_ids: string[] }
  | { kind: "other"; text: string }
  | { kind: "multi_with_other"; option_ids: string[]; other_text: string }
  | { kind: "skipped" };

export class KapClient {
  private readonly server: EmbeddedServer;

  constructor(server: EmbeddedServer) {
    this.server = server;
  }

  /** 唯一的调用出口：方法 + 具体路径，按白名单模板校验后才注入。 */
  private async call<T>(method: "GET" | "POST", path: string, body?: unknown, okCodes: readonly number[] = [0]): Promise<T> {
    if (!matchesAllowlist(method, path)) throw new KapError(40301, `route not in host allowlist: ${method} ${path.split("?")[0]}`);
    const r = await this.server.inject(method, path, body);
    const env = r.body as { code?: number; msg?: string; data?: unknown };
    if (!env || typeof env.code !== "number") throw new KapError(50001, `malformed envelope (${r.statusCode})`);
    if (!okCodes.includes(env.code)) throw new KapError(env.code, env.msg ?? "error", env.data ?? null);
    return env.data as T;
  }

  createSession(cwd: string, title?: string): Promise<KapSession> {
    return this.call("POST", "/api/v1/sessions", { metadata: { cwd }, ...(title ? { title } : {}) });
  }

  getSession(sessionId: string): Promise<KapSession> {
    return this.call("GET", `/api/v1/sessions/${id(sessionId, "session_id")}`);
  }

  status(sessionId: string): Promise<{ busy: boolean; model?: string; permission: string; plan_mode: boolean; [k: string]: unknown }> {
    return this.call("GET", `/api/v1/sessions/${id(sessionId, "session_id")}/status`);
  }

  /** 提交提示词：只有文本部件；模型由宿主选定（上游 default_model 不生效，首个提示必须显式带模型）。 */
  prompt(sessionId: string, p: { text: string; model: string; promptId?: string }): Promise<{ prompt_id: string; status: string }> {
    if (typeof p.text !== "string" || p.text.length === 0) throw new KapError(40001, "prompt text required");
    return this.call("POST", `/api/v1/sessions/${id(sessionId, "session_id")}/prompts`, {
      content: [{ type: "text", text: p.text }],
      model: p.model,
      ...(p.promptId ? { prompt_id: id(p.promptId, "prompt_id") } : {}),
    });
  }

  abortPrompt(sessionId: string, promptId: string): Promise<{ aborted: boolean }> {
    return this.call("POST", `/api/v1/sessions/${id(sessionId, "session_id")}/prompts/${id(promptId, "prompt_id")}:abort`);
  }

  sessionAction(sessionId: string, action: "abort" | "restore" | "archive"): Promise<unknown> {
    if (!SESSION_ACTIONS.has(action)) throw new KapError(40301, `session action not allowed: ${action}`);
    return this.call("POST", `/api/v1/sessions/${id(sessionId, "session_id")}:${action}`);
  }

  children(sessionId: string): Promise<{ items: KapSession[]; has_more: boolean }> {
    return this.call("GET", `/api/v1/sessions/${id(sessionId, "session_id")}/children`);
  }

  createChild(sessionId: string, title?: string): Promise<KapSession> {
    return this.call("POST", `/api/v1/sessions/${id(sessionId, "session_id")}/children`, title ? { title } : {});
  }

  /**
   * 让会话以计划模式开始（v9 第 02 篇 §9.3“先出计划”）。profile 路由的唯一用途：请求体固定只含 plan_mode，
   * 不透传任何其他 agent_config 字段（permission_mode、model、tower_mode、swarm_mode、goal_* 均不可达）。
   */
  enterPlanMode(sessionId: string): Promise<unknown> {
    return this.call("POST", `/api/v1/sessions/${id(sessionId, "session_id")}/profile`, { agent_config: { plan_mode: true } });
  }

  goal(sessionId: string): Promise<unknown> {
    return this.call("GET", `/api/v1/sessions/${id(sessionId, "session_id")}/goal`);
  }

  pendingApprovals(sessionId: string): Promise<{ items: KapApproval[] }> {
    return this.call("GET", `/api/v1/sessions/${id(sessionId, "session_id")}/approvals?status=pending`);
  }

  /** 审批答复：不带 scope（不写入会话级持久放行规则）。 */
  resolveApproval(sessionId: string, approvalId: string, decision: "approved" | "rejected" | "cancelled", feedback?: string): Promise<{ resolved: boolean }> {
    return this.call("POST", `/api/v1/sessions/${id(sessionId, "session_id")}/approvals/${id(approvalId, "approval_id")}`, {
      decision,
      ...(feedback ? { feedback: feedback.slice(0, 2000) } : {}),
    });
  }

  pendingQuestions(sessionId: string): Promise<{ items: KapQuestion[] }> {
    return this.call("GET", `/api/v1/sessions/${id(sessionId, "session_id")}/questions?status=pending`);
  }

  answerQuestion(sessionId: string, questionId: string, answers: Record<string, KapAnswer>): Promise<{ resolved: boolean }> {
    return this.call("POST", `/api/v1/sessions/${id(sessionId, "session_id")}/questions/${id(questionId, "question_id")}`, { answers });
  }

  /** 关闭问题（kap-server 以 code 40909 表示“已关闭”，按成功处理）。 */
  dismissQuestion(sessionId: string, questionId: string): Promise<{ dismissed: boolean }> {
    return this.call("POST", `/api/v1/sessions/${id(sessionId, "session_id")}/questions/${id(questionId, "question_id")}:dismiss`, undefined, [0, 40909]);
  }

  tasks(sessionId: string): Promise<{ items: unknown[] }> {
    return this.call("GET", `/api/v1/sessions/${id(sessionId, "session_id")}/tasks`);
  }

  task(sessionId: string, taskId: string, withOutput = false): Promise<unknown> {
    return this.call("GET", `/api/v1/sessions/${id(sessionId, "session_id")}/tasks/${id(taskId, "task_id")}${withOutput ? "?with_output=true" : ""}`);
  }

  cancelTask(sessionId: string, taskId: string): Promise<unknown> {
    return this.call("POST", `/api/v1/sessions/${id(sessionId, "session_id")}/tasks/${id(taskId, "task_id")}:cancel`, undefined, [0, 40904]);
  }

  messages(sessionId: string, pageSize = 100): Promise<{ items: unknown[]; has_more: boolean }> {
    return this.call("GET", `/api/v1/sessions/${id(sessionId, "session_id")}/messages?page_size=${Math.max(1, Math.min(100, pageSize))}`);
  }

  fileChanges(sessionId: string, turnId: number): Promise<{ changes: { path: string; status: string; additions: number; deletions: number; binary?: boolean }[]; recorded: boolean }> {
    if (!Number.isInteger(turnId) || turnId < 0) throw new KapError(40001, "invalid turn_id");
    return this.call("GET", `/api/v1/sessions/${id(sessionId, "session_id")}/file-history/changes?turn_id=${turnId}`);
  }

  fileContent(sessionId: string, turnId: number, path: string, phase: "start" | "end" = "end"): Promise<{ content: { version: number; content?: string; binary?: boolean } | null }> {
    if (!Number.isInteger(turnId) || turnId < 0) throw new KapError(40001, "invalid turn_id");
    const q = new URLSearchParams({ turn_id: String(turnId), path, phase });
    return this.call("GET", `/api/v1/sessions/${id(sessionId, "session_id")}/file-history/content?${q.toString()}`);
  }

  snapshot(sessionId: string): Promise<{ as_of_seq: number; epoch: string; pending_approvals: KapApproval[]; pending_questions: KapQuestion[]; [k: string]: unknown }> {
    return this.call("GET", `/api/v1/sessions/${id(sessionId, "session_id")}/snapshot`);
  }

  subscribe(sessionId: string, onEvent: (e: EventEnvelope) => void): Promise<() => void> {
    return this.server.subscribe(id(sessionId, "session_id"), onEvent);
  }
}

/** 具体路径是否匹配白名单模板（含 :tail 动作白名单）。 */
export function matchesAllowlist(method: string, fullPath: string): boolean {
  const path = fullPath.split("?")[0]!;
  const segs = path.split("/").filter(Boolean);
  for (const entry of KAP_ROUTE_ALLOWLIST) {
    const [m, tpl] = entry.split(" ") as [string, string];
    if (m !== method) continue;
    const t = tpl.split("/").filter(Boolean);
    if (t.length !== segs.length) continue;
    let ok = true;
    for (let i = 0; i < t.length && ok; i++) {
      const ts = t[i]!;
      const s = segs[i]!;
      if (ts === ":tail") {
        const k = s.lastIndexOf(":");
        if (k <= 0) {
          // 裸 id：只允许问题答复（questions/:tail 的“裸 id = answer”）
          ok = t[i - 1] === "questions" && ID.test(s);
          continue;
        }
        const idPart = s.slice(0, k);
        const action = s.slice(k + 1);
        const allowed = t[i - 1] === "prompts" ? PROMPT_ACTIONS : t[i - 1] === "tasks" ? TASK_ACTIONS : t[i - 1] === "questions" ? new Set(["dismiss"]) : SESSION_ACTIONS;
        ok = ID.test(idPart) && allowed.has(action);
      } else if (ts.startsWith(":")) {
        ok = ID.test(s);
      } else {
        ok = ts === s;
      }
    }
    if (ok) return true;
  }
  return false;
}
