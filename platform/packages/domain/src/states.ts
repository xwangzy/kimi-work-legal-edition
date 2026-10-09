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

/** 执行状态：排队 → 执行 → 成功；可转等待输入/等待审批/预算暂停；失败；取消；结果不明转对账中。 */
export const RunStatus = {
  queued: "queued",
  running: "running",
  waitingInput: "waiting_input",
  waitingApproval: "waiting_approval",
  budgetPaused: "budget_paused",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  reconciling: "reconciling",
} as const;
export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus];

/** 允许的状态迁移。执行成功不等于可签发（§2.5）。 */
export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["running", "cancelled"],
  running: ["waiting_input", "waiting_approval", "budget_paused", "succeeded", "failed", "cancelled", "reconciling"],
  waiting_input: ["running", "cancelled"],
  waiting_approval: ["running", "cancelled"],
  budget_paused: ["running", "cancelled"],
  reconciling: ["running", "succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: ["queued"],
  cancelled: [],
};

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
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
