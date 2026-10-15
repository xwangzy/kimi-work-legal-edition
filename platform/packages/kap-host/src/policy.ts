/**
 * 宿主策略（v9 第 02 篇 §9.2 强制点①、§9.3 运行模式、§9.4 工具分级、§9.5 跨边界、§9.7 子 Agent；第 04 篇 ZP-4/14）。
 *
 * - 由 ZP-4 补丁插在引擎策略链首位，对**每一次**工具调用（含子 Agent 作用域）给出 approve / ask / deny；
 *   永不弃权——上游的 auto/yolo/默认放行/git 写入放行策略永远不被触达；
 * - 裁决依据：运行（事项、运行模式、渠道、数据级别、依据状态）× 工具分级 × 路径区域 × 跨边界动作 × 预算；
 * - 未知会话、未知工具、实验开关锁死的工具、X1–X4（对外发送、签发、删改原件、改权限）一律拒绝；
 * - 每次裁决写入决策日志（事项内容审计的来源之一；不含明文参数，只有参数摘要）。
 */
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { FileBroker } from "@zr-legal/file-broker";
import { argsHash, authorizeToolCall, type ManifestRegistry, type RunMode } from "@zr-legal/host-policy";
import { SECONDARY_MODEL } from "./engine-config.ts";
import { BUILTIN_TOOLS, CROSS_BOUNDARY, LOCKED_OFF_TOOLS, TOOL_ZONES, type ToolGrade } from "./tool-table.ts";

export type DataLevel = "L0" | "L1" | "L2" | "L3a" | "L3b";

/** 渠道（第 02 篇 §9.6）：远程渠道的运行模式上限更低。 */
export type Channel = "desktop" | "office" | "mobile" | "im" | "schedule" | "executor";

const CHANNEL_MODE_CAP: Record<Channel, RunMode> = {
  desktop: "auto",
  office: "default",
  mobile: "default",
  im: "manual",
  schedule: "default",
  executor: "default",
};
const MODE_RANK: Record<RunMode, number> = { chat: 0, manual: 1, default: 2, auto: 3 };

/** 实际运行模式 = min(请求, 律所策略上限, 渠道上限)。 */
export function effectiveMode(requested: RunMode, firmMax: RunMode, channel: Channel): RunMode {
  const candidates = [requested, firmMax, CHANNEL_MODE_CAP[channel]];
  return candidates.reduce((a, b) => (MODE_RANK[a] <= MODE_RANK[b] ? a : b));
}

/** “自动”档在任务开始时预授权的跨边界范围（第 02 篇 §9.3）。 */
export type Preauthorization = "search_generalized" | "fetch_allowlisted" | "connector_readonly";

export interface RunPolicyContext {
  runId: string;
  matterId: string;
  mode: RunMode;
  channel: Channel;
  purpose: string;
  dataLevel: DataLevel;
  /** 四项依据是否齐备（任一“待确认”时只运行不出站的本机能力）。 */
  basisComplete: boolean;
  preauthorized: ReadonlySet<Preauthorization>;
  /** 抓取白名单域名（公开官方站点基线 + 律所策略）。 */
  fetchAllowlist: readonly string[];
  budget: { maxToolCalls: number; maxSubagents: number };
  /** “先出计划”开关：开启时计划一律经业务审批卡由律师批准。 */
  planFirst: boolean;
}

export interface PolicyDecisionRecord {
  at: string;
  runId: string | null;
  sessionId: string;
  agentId: string;
  toolCallId: string;
  toolName: string;
  grade: ToolGrade | "mcp" | "unknown";
  decision: "approve" | "ask" | "deny";
  reason: string;
  crossBoundary: string | null;
  argsHash: string;
  /** 联网检索与网页抓取：出站内容的摘要（查询或 URL）。宿主出口据此把闸门请求对到这一次裁决（第 04 篇 §5.1）。 */
  egressDigest?: string;
  /**
   * 超预算询问（复核 B4-B05/B4-B06）：本次调用将派出的子任务数（非编排类为 0）与询问时的余额。
   * 律师批准后按此补记预算（1 次工具调用 + members 个子任务）——之后的调用按实际用量判断，越额仍逐次询问；确认卡据此写明成员数与余额。
   */
  overBudget?: { members: number; toolCallsLeft: number; subagentsLeft: number };
}

/** 出站内容摘要：WebSearch 的查询、FetchURL 的 URL（与宿主出口从请求体算出的摘要比对）。 */
export function egressDigest(tool: "WebSearch" | "FetchURL", value: string): string {
  return createHash("sha256").update(`${tool}\u0000${value}`).digest("hex");
}

export interface HostPolicyRequest {
  sessionId: string;
  agentId: string;
  turnId: number;
  toolCallId: string;
  toolName: string;
  args: unknown;
  description: string | undefined;
  display: unknown;
}

/** 引擎侧 PermissionPolicyResult 的形状（ZP-4 补丁接受的返回值）。 */
export type PolicyResult =
  | { kind: "approve"; reason?: Record<string, string | number | boolean | null> }
  | { kind: "deny"; message: string; reason?: Record<string, string | number | boolean | null> }
  | { kind: "ask"; reason?: Record<string, string | number | boolean | null> };

interface RunState {
  ctx: RunPolicyContext;
  toolCalls: number;
  subagents: number;
  /** “本任务内允许”的范围键（不跨任务、不跨事项）。 */
  taskAllowances: Set<string>;
}

export interface HostPolicyDeps {
  broker: FileBroker;
  /** 工作区根（相对路径的解析基准，= kap-server workspace cwd）。 */
  workDir: string;
  manifests: ManifestRegistry;
  /** 执行域是否可用（第 02 篇 §9.10：不可用时代码执行关闭）。 */
  execDomainAvailable: () => boolean;
  onDecision?: (r: PolicyDecisionRecord) => void;
  /**
   * 检索式预筛（W1，收敛偏离 D-16）：由内核按事项令牌化器与当事人词典计算（与闸门同一份筛查代码），只回答“是否须律师确认”。
   * 须确认 → 宿主策略询问（确认卡）；律师批准后内核签发出站凭据，闸门独立核验。未提供或失败 → 交闸门逐条筛查（含实体即拒绝并提示改写）。
   */
  screenSearch?: (run: { runId: string; matterId: string }, query: string) => Promise<{ needsConfirmation: boolean }>;
}

/** 宿主策略的异步前置信息（只来自可信方：内核）。 */
export interface PolicyPreScreen {
  searchNeedsConfirmation?: boolean;
}

export class HostPolicy {
  private readonly runsBySession = new Map<string, RunState>();
  readonly decisions: PolicyDecisionRecord[] = [];
  private readonly deps: HostPolicyDeps;

  constructor(deps: HostPolicyDeps) {
    this.deps = deps;
  }

  /** 把引擎会话绑定到一次业务运行（未绑定的会话一律拒绝）。 */
  bindSession(sessionId: string, ctx: RunPolicyContext): void {
    this.runsBySession.set(sessionId, { ctx, toolCalls: 0, subagents: 0, taskAllowances: new Set() });
  }

  unbindSession(sessionId: string): void {
    this.runsBySession.delete(sessionId);
  }

  /** 记录“本任务内允许”（跨任务、跨事项无效；随会话解绑失效）。 */
  allowForTask(sessionId: string, key: string): void {
    this.runsBySession.get(sessionId)?.taskAllowances.add(key);
  }

  runContext(sessionId: string): RunPolicyContext | undefined {
    return this.runsBySession.get(sessionId)?.ctx;
  }

  /**
   * “本任务内允许”的范围键（审查 S2-02）：裁决原因 + 工具 + 去向类别（不含具体参数）。
   * 律师对某张卡选“本任务内允许”，只放行**同一原因**的同类调用——不会顺带放行超预算等别的原因的询问。
   */
  static allowanceKey(toolName: string, args: unknown, reason: string): string {
    if (toolName === "FetchURL") {
      const host = hostOf((args as { url?: unknown })?.url);
      return `${reason}|FetchURL|${host ?? "?"}`;
    }
    return `${reason}|${toolName}`;
  }

  /**
   * 引擎实际调用的入口：WebSearch 在默认/自动档先经内核预筛（异步），其余同步裁决。
   * 预筛只能让裁决更严（放行 → 询问），不能放宽。
   */
  async evaluateAsync(req: HostPolicyRequest): Promise<PolicyResult> {
    let pre: PolicyPreScreen | undefined;
    const state = this.runsBySession.get(req.sessionId);
    const query = (req.args as { query?: unknown } | null)?.query;
    if (
      req.toolName === "WebSearch" &&
      this.deps.screenSearch &&
      state &&
      typeof query === "string" &&
      (state.ctx.mode === "default" || (state.ctx.mode === "auto" && !state.ctx.preauthorized.has("search_generalized"))) &&
      state.ctx.basisComplete &&
      (state.ctx.dataLevel === "L0" || state.ctx.dataLevel === "L1" || state.ctx.dataLevel === "L2")
    ) {
      try {
        const r = await this.deps.screenSearch({ runId: state.ctx.runId, matterId: state.ctx.matterId }, query);
        pre = { searchNeedsConfirmation: r.needsConfirmation === true };
      } catch {
        pre = undefined; // 预筛不可用：交闸门逐条筛查（含实体即拒绝）
      }
    }
    return this.evaluate(req, pre);
  }

  evaluate(req: HostPolicyRequest, pre?: PolicyPreScreen): PolicyResult {
    const hash = argsHash(req.args ?? {});
    const state = this.runsBySession.get(req.sessionId);
    const record = (
      decision: PolicyDecisionRecord["decision"],
      reason: string,
      grade: PolicyDecisionRecord["grade"],
      crossBoundary: string | null = null,
      extra: Pick<PolicyDecisionRecord, "overBudget"> = {},
    ): void => {
      const r: PolicyDecisionRecord = {
        at: new Date().toISOString(),
        runId: state?.ctx.runId ?? null,
        sessionId: req.sessionId,
        agentId: req.agentId,
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        grade,
        decision,
        reason,
        crossBoundary,
        argsHash: hash,
        ...(req.toolName === "WebSearch" && typeof (req.args as { query?: unknown } | null)?.query === "string"
          ? { egressDigest: egressDigest("WebSearch", (req.args as { query: string }).query) }
          : req.toolName === "FetchURL" && typeof (req.args as { url?: unknown } | null)?.url === "string"
            ? { egressDigest: egressDigest("FetchURL", (req.args as { url: string }).url) }
            : {}),
        ...extra,
      };
      this.decisions.push(r);
      if (this.decisions.length > 5000) this.decisions.splice(0, 1000);
      this.deps.onDecision?.(r);
    };
    const deny = (reason: string, grade: PolicyDecisionRecord["grade"], message?: string): PolicyResult => {
      record("deny", reason, grade);
      return { kind: "deny", message: message ?? `宿主策略拒绝：${reason}`, reason: { host_policy: reason } };
    };
    const approve = (reason: string, grade: PolicyDecisionRecord["grade"]): PolicyResult => {
      record("approve", reason, grade);
      return { kind: "approve", reason: { host_policy: reason } };
    };
    const ask = (reason: string, grade: PolicyDecisionRecord["grade"], crossBoundary: string | null, extra: Pick<PolicyDecisionRecord, "overBudget"> = {}): PolicyResult => {
      // 每次都须确认的原因（超预算、停止任务、定时、图像直送、L3a 检索）永不按任务放行（审查 S2-02）
      if (state && !ONCE_ONLY_REASONS.has(reason) && state.taskAllowances.has(HostPolicy.allowanceKey(req.toolName, req.args, reason))) {
        return approve(`task_allowance:${reason}`, grade);
      }
      record("ask", reason, grade, crossBoundary, extra);
      return { kind: "ask", reason: { host_policy: reason, cross_boundary: crossBoundary } };
    };

    if (!state) return deny("unbound_session", "unknown");
    const { ctx } = state;
    const isSubagent = req.agentId !== "main";

    // MCP 工具：清单式授权（工具 ID + 副作用 + 资源 + 用途 + schema hash）
    if (req.toolName.startsWith("mcp__")) {
      const d = authorizeToolCall(
        this.deps.manifests,
        {
          toolId: req.toolName,
          boundMatterId: ctx.matterId,
          purpose: ctx.purpose,
          mode: ctx.mode,
          execDomainAvailable: this.deps.execDomainAvailable(),
          ...(ctx.preauthorized.has("connector_readonly")
            ? { preauthorized: new Set(this.deps.manifests.list().filter((m) => m.sideEffect === "read").map((m) => m.id)) }
            : {}),
        },
        req.args,
      );
      if (d.decision === "deny") return deny(d.reason, "mcp");
      if (!this.consumeBudget(state, 0)) return this.overBudget(state, 0, ask, deny, "mcp");
      if (d.decision === "ask") return ask(d.reason, "mcp", d.manifest?.sideEffect === "network" ? CROSS_BOUNDARY.connectorWrite : null);
      return approve(d.reason, "mcp");
    }

    if (LOCKED_OFF_TOOLS.has(req.toolName)) return deny("locked_off_experimental", "unknown");
    // G0 未开放的能力（能力账本“目标模式”“定时”为 G1）：目标须设预算与时限、运行生命周期按目标状态判定；
    // 定时任务触发的回合落在运行之外——在相应语义落地前失败关闭（审查 S2-01）
    const g0Off = G0_DISABLED_TOOLS[req.toolName];
    if (g0Off) return deny(g0Off, "unknown", `宿主策略拒绝：${req.toolName} 在当前版本未开放（${g0Off}）`);
    const spec = BUILTIN_TOOLS[req.toolName];
    if (!spec) return deny("unknown_tool", "unknown");

    // 路径区域检查（纵深：broker 是最终强制点，这里提前拒绝并给出可读原因）
    for (const field of spec.pathArgs ?? []) {
      const raw = (req.args as Record<string, unknown> | null)?.[field];
      if (typeof raw !== "string" || raw.length === 0 || raw.startsWith("kimi-file://")) continue;
      const abs = isAbsolute(raw) ? raw : resolve(this.deps.workDir, raw);
      const loc = this.deps.broker.locate(abs);
      // 计划模式：本会话自己的计划文件（引擎内部状态区中唯一对工具开放的路径；上游计划模式要求 Agent 把计划写到这里）
      const ownPlan =
        !!loc &&
        loc.zone.name === "engine" &&
        (req.toolName === "Read" || req.toolName === "Write" || req.toolName === "Edit") &&
        isOwnPlanFile(loc.rel, req.sessionId, req.agentId);
      if (!loc || (!TOOL_ZONES.has(loc.zone.name) && !ownPlan)) return deny("path_outside_matter", spec.grade, `宿主策略拒绝：路径不在本事项的材料区或工作区内（${field}）`);
      if (ownPlan) continue;
      if (spec.writes && loc.zone.name !== "work") return deny("write_outside_workspace", spec.grade, "宿主策略拒绝：只能写入本事项工作区；原件区只读、交付区只由人发布");
      if (req.toolName === "Bash" && loc.zone.name !== "work") return deny("bash_cwd_outside_workspace", spec.grade);
    }

    const mode = ctx.mode;
    switch (spec.grade) {
      case "UI":
        return approve("interaction", spec.grade);
      case "plan":
        // 权限层放行；计划本身的确认由工具自己的交互发起（引擎侧权限模式固定 manual），业务层呈现为审批卡。
        // “自动”档且未开“先出计划”时，宿主按自动档语义代为批准该确认（runtime.ts，记 run.approval_auto）
        if (mode === "chat") return deny("chat_read_only", spec.grade);
        return approve(mode === "auto" && !ctx.planFirst ? "plan_auto_approved" : "plan_review_by_card", spec.grade);
      case "T0":
        if (!this.consumeBudget(state, 0)) return this.overBudget(state, 0, ask, deny, spec.grade);
        return mode === "manual" ? ask("manual_mode", spec.grade, null) : approve("read_within_matter", spec.grade);
      case "T0'":
        if (mode === "chat") return deny("chat_read_only", spec.grade);
        if (ctx.dataLevel === "L3a" || ctx.dataLevel === "L3b") return deny("image_to_model_forbidden_l3", spec.grade);
        if (!ctx.basisComplete) return deny("basis_pending_no_egress", spec.grade);
        return ask("image_to_model", spec.grade, CROSS_BOUNDARY.imageToModel);
      case "T1":
      case "T2":
      case "T3":
        if (mode === "chat") return deny("chat_read_only", spec.grade);
        // 不可降级：执行域不可用时代码执行关闭，只运行可信工具（第 02 篇 §9.10；审查 R-10）
        if (spec.grade === "T2" && !this.deps.execDomainAvailable()) return deny("execution_domain_unavailable", spec.grade, "宿主策略拒绝：本机执行域不可用，代码执行已关闭（不会在执行域之外运行代码）");
        if (req.toolName === "Bash") {
          // 超时档位收紧（第 04 篇 §4.1：前台 ≤ 5 分钟、后台 ≤ 60 分钟、禁止 disable_timeout；执行域另有同值硬上限）
          const a = (req.args ?? {}) as { run_in_background?: unknown; timeout?: unknown; disable_timeout?: unknown };
          if (a.disable_timeout === true) return deny("bash_disable_timeout_forbidden", spec.grade, "宿主策略拒绝：不支持 disable_timeout（后台命令最长 60 分钟）");
          if (a.run_in_background === true && typeof a.timeout === "number" && a.timeout > 3600) {
            return deny("bash_background_timeout_cap", spec.grade, "宿主策略拒绝：后台命令最长 60 分钟（timeout ≤ 3600）");
          }
        }
        if ((req.toolName === "Agent" || req.toolName === "AgentSwarm") && (req.args as { fork?: unknown } | null)?.fork === true) {
          // 分叉上下文的子 Agent 继承主 Agent 的模型并复制整段对话，绕过 [secondary_model].force（子 Agent 强制低价模型）：
          // 引擎已由实验开关锁关（ZP-13），宿主策略独立拒绝（每处独立强制）
          return deny("subagent_fork_disabled", spec.grade, "宿主策略拒绝：不支持分叉上下文的子任务（子任务一律使用独立上下文与低价模型）");
        }
        if (req.toolName === "Agent" || req.toolName === "AgentSwarm") {
          // 子任务一律低价模型（复核 B4-B06）：引擎的 [secondary_model].force 之外，宿主独立拒绝指定其他模型（每处独立强制，与 fork 同口径）
          const model = (req.args as { model?: unknown } | null)?.model;
          if (model !== undefined && model !== SECONDARY_MODEL) {
            return deny("subagent_model_override_disabled", spec.grade, "宿主策略拒绝：子任务一律使用低价模型，不能另行指定模型");
          }
        }
        // 子 Agent 预算按成员计（K7-4）：一次 AgentSwarm = items 与 resume_agent_ids 的成员总数；
        // 无法解析即拒绝（复核 B4-B06：引擎同样会因参数无效拒绝，询问律师“超预算”既无意义也误导）
        const members = spec.grade !== "T3" ? 0 : req.toolName === "Agent" ? 1 : req.toolName === "AgentSwarm" ? swarmMembers(req.args) : 0;
        if (!Number.isFinite(members)) {
          return deny("swarm_members_unparseable", spec.grade, "宿主策略拒绝：集群的成员数无法确定（须给出 items 或 resume_agent_ids）");
        }
        if (!this.consumeBudget(state, members)) {
          return this.overBudget(state, members, ask, deny, spec.grade);
        }
        if (mode === "manual") return ask("manual_mode", spec.grade, null);
        return approve(spec.grade === "T1" ? "draft_within_workspace" : spec.grade === "T2" ? "exec_within_domain" : "orchestration_within_budget", spec.grade);
      case "T2-stop":
        if (mode === "chat") return deny("chat_read_only", spec.grade);
        return ask("stop_task_requires_confirmation", spec.grade, CROSS_BOUNDARY.stopTask);
      case "T4": {
        if (mode === "chat" && !ctx.basisComplete) return deny("basis_pending_no_egress", spec.grade);
        if (ctx.dataLevel === "L3b") return deny("search_forbidden_l3b", spec.grade);
        if (!ctx.basisComplete) return deny("basis_pending_no_egress", spec.grade);
        if (!this.consumeBudget(state, 0)) return this.overBudget(state, 0, ask, deny, spec.grade);
        if (ctx.dataLevel === "L3a") return ask("search_l3a_each_query", spec.grade, CROSS_BOUNDARY.searchEntity);
        if (mode === "manual") return ask("manual_mode", spec.grade, null);
        // 默认/自动档：出站闸门逐条去标识；预授权“泛化后放行”时由闸门泛化
        if (mode === "auto" && ctx.preauthorized.has("search_generalized")) return approve("preauthorized_generalized_search", spec.grade);
        // 含当事人实体（内核预筛）：确认卡——原文放行 / 本任务内允许 / 改写后允许 / 拒绝；批准后内核签发凭据、闸门独立核验（第 02 篇 §9.5①、§11.2；W1 收敛 D-16）
        if (pre?.searchNeedsConfirmation) return ask("search_entity_requires_confirmation", spec.grade, CROSS_BOUNDARY.searchEntity);
        return approve("search_screened_by_gate", spec.grade);
      }
      case "T5": {
        if (mode === "chat") return deny("chat_read_only", spec.grade);
        // 四项依据任一“待确认”：只运行不出站的本机能力（第 02 篇 §8.1）
        if (!ctx.basisComplete && ctx.dataLevel !== "L0" && ctx.dataLevel !== "L1") return deny("basis_pending_no_egress", spec.grade);
        const url = (req.args as { url?: unknown } | null)?.url;
        const host = hostOf(url);
        if (!host) return deny("fetch_url_invalid", spec.grade);
        if (!this.consumeBudget(state, 0)) return this.overBudget(state, 0, ask, deny, spec.grade);
        const allowlisted = ctx.fetchAllowlist.some((d) => host === d || host.endsWith(`.${d}`));
        // 白名单域名：默认档与自动档都自动（第 02 篇 §9.4 T5“白名单域名自动”；自动档不比默认档更严——复核 S5-A07）；手动档每一步都问
        if (allowlisted) return mode === "manual" ? ask("manual_mode", spec.grade, null) : approve("fetch_allowlisted_domain", spec.grade);
        return ask("fetch_new_domain", spec.grade, CROSS_BOUNDARY.fetchNewDomain);
      }
      case "T8":
        if (mode === "chat" || isSubagent) return deny(isSubagent ? "subagent_cannot_schedule" : "chat_read_only", spec.grade);
        return ask("schedule_requires_confirmation", spec.grade, CROSS_BOUNDARY.schedule);
      default:
        return deny("unhandled_grade", spec.grade);
    }
  }

  /**
   * 律师批准了超预算询问（复核 B4-B05）：按该次调用补记 1 次工具调用与其成员数。此前获批的那一次不计数，
   * 随后的调用在“名义余额”内被自动放行（例：上限 3、已用 2，批准一次 5 成员集群后，单个 Agent 仍按 2+1≤3 放行）。
   * 只认本会话、本策略记下的超预算询问；同一裁决只补记一次。
   */
  chargeApprovedOverBudget(sessionId: string, r: PolicyDecisionRecord): void {
    const state = this.runsBySession.get(sessionId);
    if (!state || r.sessionId !== sessionId || r.decision !== "ask" || r.reason !== "over_budget" || !r.overBudget || this.charged.has(r)) return;
    const members = r.overBudget.members;
    if (!Number.isFinite(members) || members < 0) return;
    this.charged.add(r);
    state.toolCalls += 1;
    state.subagents += members;
  }

  /** 已补记过的超预算裁决。 */
  private readonly charged = new WeakSet<PolicyDecisionRecord>();

  /** 本会话当前的预算用量（测试与诊断）。 */
  budgetUsage(sessionId: string): { toolCalls: number; subagents: number } | null {
    const s = this.runsBySession.get(sessionId);
    return s ? { toolCalls: s.toolCalls, subagents: s.subagents } : null;
  }

  /** subagents：本次调用将派出的子 Agent 数（0 = 非编排类；调用方已拒绝无法解析的情形）。 */
  private consumeBudget(state: RunState, subagents: number): boolean {
    if (state.toolCalls + 1 > state.ctx.budget.maxToolCalls) return false;
    if (subagents > 0 && state.subagents + subagents > state.ctx.budget.maxSubagents) return false;
    state.toolCalls += 1;
    state.subagents += subagents;
    return true;
  }

  private overBudget(
    state: RunState,
    members: number,
    ask: (reason: string, grade: PolicyDecisionRecord["grade"], cb: string | null, extra?: Pick<PolicyDecisionRecord, "overBudget">) => PolicyResult,
    deny: (reason: string, grade: PolicyDecisionRecord["grade"], message?: string) => PolicyResult,
    grade: PolicyDecisionRecord["grade"],
  ): PolicyResult {
    // 自动档：预算硬上限；默认/手动档：超出预算是跨边界动作，问律师（卡片写明本次成员数与余额；批准后补记——复核 B4-B05/B06）
    if (state.ctx.mode === "auto") return deny("budget_hard_cap", grade, "宿主策略拒绝：已达本任务预算硬上限（自动档）");
    const { maxToolCalls, maxSubagents } = state.ctx.budget;
    return ask("over_budget", grade, CROSS_BOUNDARY.budget, {
      overBudget: { members, toolCallsLeft: Math.max(0, maxToolCalls - state.toolCalls), subagentsLeft: Math.max(0, maxSubagents - state.subagents) },
    });
  }
}

/** `<home>/sessions/<wd>/<session_id>/agents/<agent>/plans/<file>.md`（engine 区内相对分量），且必须是请求方自己（同会话、同 Agent）的计划目录。 */
function isOwnPlanFile(rel: readonly string[], sessionId: string, agentId: string): boolean {
  return (
    rel.length === 6 && rel[1] === sessionId && rel[2] === "agents" && rel[3] === agentId && rel[4] === "plans" && /^[A-Za-z0-9._-]+\.md$/.test(rel[5] ?? "")
  );
}

/** 每次都须确认、永不按任务放行的裁决原因（审查 S2-02；第 02 篇 §9.5⑥ 超预算等跨边界动作逐次确认）。 */
export const ONCE_ONLY_REASONS: ReadonlySet<string> = new Set([
  "over_budget",
  "stop_task_requires_confirmation",
  "schedule_requires_confirmation",
  "image_to_model",
  "search_l3a_each_query",
]);

/** G0 未开放的工具 → 拒绝原因（能力账本“目标模式”“定时”为 G1）。 */
const G0_DISABLED_TOOLS: Readonly<Record<string, string>> = Object.freeze({
  CreateGoal: "goal_mode_not_enabled_g0",
  SetGoalBudget: "goal_mode_not_enabled_g0",
  UpdateGoal: "goal_mode_not_enabled_g0",
  CronCreate: "schedule_not_enabled_g0",
  CronDelete: "schedule_not_enabled_g0",
});

function hostOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * 一次 AgentSwarm 调用派出的成员数（上游 agent-core-v2 features/swarm/tools/agent-swarm/agent-swarm.ts：
 * `items` 每项派出一个新成员，`resume_agent_ids` 每个键续跑一个已有成员）。无法解析或为 0 → 无穷大（宿主策略拒绝，失败关闭；复核 B4-B06）。
 */
export function swarmMembers(args: unknown): number {
  const a = (args ?? {}) as { items?: unknown; resume_agent_ids?: unknown };
  const items = Array.isArray(a.items) ? a.items.length : 0;
  const resumed = a.resume_agent_ids && typeof a.resume_agent_ids === "object" && !Array.isArray(a.resume_agent_ids) ? Object.keys(a.resume_agent_ids).length : 0;
  const n = items + resumed;
  return n > 0 ? n : Number.POSITIVE_INFINITY;
}
