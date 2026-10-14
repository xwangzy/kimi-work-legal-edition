/**
 * 状态机定义（方案 v4.0 第 3 篇 §2.5、第 4 篇 §4.4）。
 * 用 as const 对象 + 联合类型（Node 原生 TS 只允许可擦除语法，不用 enum）。
 */

/**
 * 模型端点（方案 v5.0 第 2 篇 §4.2：取代 v4.0 的“处理模式”）：
 * 标准（中软 MaaS → Kimi）/ 自带密钥（律所直签）/ 私有模型 / 不使用模型。
 * 后台不得自动切换；改变端点须本人确认并看到数据去向变化。
 */
export const ModelEndpoint = {
  standard: "standard",
  byok: "byok",
  private: "private",
  none: "none",
} as const;
export type ModelEndpoint = (typeof ModelEndpoint)[keyof typeof ModelEndpoint];

/** 协作范围（v5.0 §4.2）：个人（只在本机）/ 团队（律所内同步密文）。 */
export const CollabScope = {
  personal: "personal",
  team: "team",
} as const;
export type CollabScope = (typeof CollabScope)[keyof typeof CollabScope];

/**
 * 当事人告知同意状态（v5.0 §4.2 与第 4 篇 §8.3）：
 * 待取得 = 只用本机能力（不发送模型）；已拒绝 = 只能私有模型或不使用模型。
 */
export const ConsentStatus = {
  agreed: "agreed",
  pending: "pending",
  refused: "refused",
  notRequired: "not_required",
} as const;
export type ConsentStatus = (typeof ConsentStatus)[keyof typeof ConsentStatus];

/**
 * 任务状态（v9 第 04 篇 §8）：`CREATED → VALIDATING → QUEUED → RUNNING`，期间可进入
 * `WAITING_INPUT / WAITING_APPROVAL / WAITING_DEVICE / PAUSED_BUDGET（budget_paused）/ RECOVERING`；
 * 副作用结果不明进入 `reconciling`（人工对账，不盲目重发）；
 * 终态 `SUCCEEDED / PARTIAL / FAILED / CANCELLED / EXPIRED / TIMED_OUT`。
 * 终态转换用 CAS；**未知状态、缺成果、截断、超时都不能成功**（F1）。
 */
export const RunStatus = {
  created: "created",
  validating: "validating",
  queued: "queued",
  running: "running",
  waitingInput: "waiting_input",
  waitingApproval: "waiting_approval",
  waitingDevice: "waiting_device",
  budgetPaused: "budget_paused",
  recovering: "recovering",
  reconciling: "reconciling",
  succeeded: "succeeded",
  partial: "partial",
  failed: "failed",
  cancelled: "cancelled",
  expired: "expired",
  timedOut: "timed_out",
} as const;
export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus];

/** 终态集合：进入后不再迁移（failed → queued 的人工重试除外，重试产生新 Attempt）。 */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["succeeded", "partial", "failed", "cancelled", "expired", "timed_out"];

export function isTerminalRun(status: string): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

/** 允许的状态迁移。执行成功不等于可签发（§2.5）。 */
export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  created: ["validating", "cancelled"],
  validating: ["queued", "failed", "cancelled"],
  queued: ["running", "cancelled", "expired"],
  running: [
    "waiting_input",
    "waiting_approval",
    "waiting_device",
    "budget_paused",
    "recovering",
    "reconciling",
    "succeeded",
    "partial",
    "failed",
    "cancelled",
    "timed_out",
  ],
  waiting_input: ["running", "cancelled", "expired", "timed_out"],
  waiting_approval: ["running", "cancelled", "expired", "timed_out"],
  waiting_device: ["running", "cancelled", "expired", "timed_out"],
  budget_paused: ["running", "cancelled", "expired", "partial"],
  recovering: ["running", "reconciling", "failed", "cancelled"],
  // 人工对账（复审 R-05）：只能经 runs.reconcile 在全部结果不明的调用有结论后迁到 failed，再经 runs.retry 重新排队
  //（重试按检查点结算、不重跑 Agent）；执行器与取消都不改写 reconciling
  reconciling: ["failed"],
  succeeded: [],
  partial: [],
  failed: ["queued"],
  cancelled: [],
  expired: [],
  timed_out: [],
};

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Agent 宿主上报的终态（F1：终态枚举化）。宿主协议里出现枚举之外的值一律视为 failed。
 * - succeeded：回合以 completed 结束、最后一步不是截断、进程退出码 0、至少一份成果且 hash 校验通过；
 * - partial：宿主如实声明部分完成（预算暂停等），已有成果可用、剩余部分列明；
 * - failed / cancelled / timed_out / expired：见名知义。
 */
export const AgentOutcome = {
  succeeded: "succeeded",
  partial: "partial",
  failed: "failed",
  cancelled: "cancelled",
  timedOut: "timed_out",
  expired: "expired",
} as const;
export type AgentOutcome = (typeof AgentOutcome)[keyof typeof AgentOutcome];

/**
 * 结束原因白名单（审查 R-03）：只有这些值才可能成功；缺失、未知（other/paused/error/interrupted…）一律不是成功。
 * Kimi Code 锁版的归一化：provider 层 kosong `completed|tool_calls|truncated|filtered|paused|other` →
 * 回合事件 `end_turn|tool_use|max_tokens|filtered|paused|other`；上游会把**缺失**的 provider 结束原因默认成 completed，
 * 所以还要单独看 provider 上报值（providerFinishReason）是否真的存在。
 */
const SUCCESS_FINISH_REASONS = new Set(["end_turn", "stop", "completed"]);
/** 截断类结束原因（模型输出被长度上限切断）。 */
const TRUNCATED_FINISH_REASONS = new Set(["length", "max_tokens", "max_output_tokens", "model_length", "truncated"]);
/** 内容安全拦截。 */
const FILTERED_FINISH_REASONS = new Set(["content_filter", "filtered"]);

export interface AgentCompletionReport {
  /** 宿主声明的状态（来自 done 记录；可能缺失或为未知值）。 */
  hostStatus: string | undefined;
  /** 宿主进程退出码（null = 被信号终止）。 */
  exitCode: number | null;
  /** 最后一个回合的结束原因（completed / cancelled / failed / blocked）。 */
  turnEndReason?: string | undefined;
  /** 最后一步的模型结束原因（引擎归一化值：end_turn / max_tokens / other …）。 */
  finishReason?: string | undefined;
  /** 最后一步 provider 层上报的结束原因（kosong 归一化值：completed / truncated / other …；缺失 = 未上报）。 */
  providerFinishReason?: string | undefined;
  /** 已登记且 hash 校验通过的成果数。 */
  verifiedArtifacts: number;
  /** 宿主声明但校验失败（缺文件、hash 不符、越界路径）的成果数。 */
  invalidArtifacts: number;
}

export interface AgentOutcomeDecision {
  outcome: AgentOutcome;
  /** 不成功时的机器可读原因（timed_out / length_truncated / missing_artifact / artifact_hash_mismatch / exit_code_mismatch / turn_not_completed / unknown_status …）。 */
  reason: string | null;
}

/**
 * 由宿主完成记录 + 进程退出码 + 成果校验结果裁定终态（F1）。
 * 规则：只有一切证据一致指向成功时才给 succeeded；任何缺失、矛盾或未知都不是成功。
 */
export function resolveAgentOutcome(r: AgentCompletionReport): AgentOutcomeDecision {
  const s = r.hostStatus;
  if (s === "cancelled") return { outcome: "cancelled", reason: "cancelled" };
  if (s === "timed_out" || s === "timeout") return { outcome: "timed_out", reason: "timed_out" };
  if (s === "expired") return { outcome: "expired", reason: "expired" };
  if (s === "failed") return { outcome: "failed", reason: "host_reported_failure" };
  if (s !== "succeeded" && s !== "partial") return { outcome: "failed", reason: s === undefined ? "missing_completion_record" : "unknown_status" };
  if (r.exitCode !== 0) return { outcome: "failed", reason: "exit_code_mismatch" };
  if (r.invalidArtifacts > 0) return { outcome: "failed", reason: "artifact_hash_mismatch" };
  const reasons = [r.finishReason, r.providerFinishReason];
  if (reasons.some((x) => x !== undefined && FILTERED_FINISH_REASONS.has(x))) return { outcome: "failed", reason: "content_filtered" };
  const partialOrFail = (reason: string): AgentOutcomeDecision =>
    r.verifiedArtifacts > 0 ? { outcome: "partial", reason } : { outcome: "failed", reason };
  if (reasons.some((x) => x !== undefined && TRUNCATED_FINISH_REASONS.has(x))) return partialOrFail("length_truncated");
  if (s === "partial") return r.verifiedArtifacts > 0 ? { outcome: "partial", reason: "host_reported_partial" } : { outcome: "failed", reason: "missing_artifact" };
  if (r.turnEndReason !== "completed") return { outcome: "failed", reason: "turn_not_completed" };
  if (r.verifiedArtifacts === 0) return { outcome: "failed", reason: "missing_artifact" };
  if (r.finishReason === undefined || !SUCCESS_FINISH_REASONS.has(r.finishReason)) return partialOrFail("finish_reason_unknown");
  if (r.providerFinishReason === undefined) return partialOrFail("finish_reason_unreported");
  if (!SUCCESS_FINISH_REASONS.has(r.providerFinishReason)) return partialOrFail("finish_reason_unknown");
  return { outcome: "succeeded", reason: null };
}

/** 成果状态：草稿 → 待核验 → 待复核 → 已批准 → 已签发；核验未过为受阻；旧版可标已替代/已撤回。 */
export const ArtifactStatus = {
  draft: "draft",
  pendingVerification: "pending_verification",
  pendingReview: "pending_review",
  approved: "approved",
  issued: "issued",
  blocked: "blocked",
  superseded: "superseded",
  withdrawn: "withdrawn",
} as const;
export type ArtifactStatus = (typeof ArtifactStatus)[keyof typeof ArtifactStatus];

/** 风险分级（第 2 篇 §5.2：红/橙/黄）。 */
export const RiskLevel = {
  high: "high",
  mid: "mid",
  low: "low",
} as const;
export type RiskLevel = (typeof RiskLevel)[keyof typeof RiskLevel];

/** 法规效力（独立标签样式）：现行有效 / 已修改 / 已废止。 */
export const SourceEffectiveness = {
  valid: "valid",
  amended: "amended",
  repealed: "repealed",
} as const;
export type SourceEffectiveness = (typeof SourceEffectiveness)[keyof typeof SourceEffectiveness];

/**
 * 引用四态核验（第 2 篇 §5.3）：来源已核 / 版本已核 / 支持待判 / 律师已确认；
 * 无法核实的引用进入“拦截”（不静默删除）。
 * 案号类引用：存在性核验需授权数据商在线接口，离线为「未核实（离线）」（第 5 篇 §2.1：
 * 该引用不得进入签发版，联网后补核）。
 */
export const CitationState = {
  sourceVerified: "source_verified",
  versionVerified: "version_verified",
  supportPending: "support_pending",
  lawyerConfirmed: "lawyer_confirmed",
  intercepted: "intercepted",
  unverifiedOffline: "unverified_offline",
} as const;
export type CitationState = (typeof CitationState)[keyof typeof CitationState];

/** 事实/陈述类型（S2：类型标签）。 */
export const AssertionKind = {
  materialRecord: "material_record",
  partyStatement: "party_statement",
  opponentClaim: "opponent_claim",
  inference: "inference",
  lawyerConfirmed: "lawyer_confirmed",
} as const;
export type AssertionKind = (typeof AssertionKind)[keyof typeof AssertionKind];

/** 席位类型（第 7 篇：生产席 / 审阅签发席 / 管理席）。 */
export const SeatKind = {
  production: "production",
  reviewIssuer: "review_issuer",
  admin: "admin",
} as const;
export type SeatKind = (typeof SeatKind)[keyof typeof SeatKind];

/** 受众分版（§2.4）。 */
export const Audience = {
  internal: "internal",
  client: "client",
  counterparty: "counterparty",
  court: "court",
} as const;
export type Audience = (typeof Audience)[keyof typeof Audience];

/** 推理档位（第 4 篇 §4.2：K3 默认 max，网关按步骤强制分档）。 */
export const ReasoningEffort = {
  low: "low",
  high: "high",
  max: "max",
} as const;
export type ReasoningEffort = (typeof ReasoningEffort)[keyof typeof ReasoningEffort];
