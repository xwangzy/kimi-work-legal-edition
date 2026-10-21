/**
 * 故障语义（方案 v4.0 第 4 篇 §4.4、第 3 篇 §2.6）。
 * 错误对外“说人话”，对内带机器可判的 code。
 */
export const FaultCode = {
  // 权限与策略
  forbidden: "forbidden",
  modeNotAllowed: "mode_not_allowed",
  revoked: "revoked",
  // 并发与版本
  staleBaseline: "stale_baseline",
  leaseConflict: "lease_conflict",
  approvalInvalidated: "approval_invalidated",
  // 材料与解析
  unsupportedFile: "unsupported_file",
  hashMismatch: "hash_mismatch",
  lowQualityScan: "low_quality_scan",
  anchorMismatch: "anchor_mismatch",
  // 执行
  budgetExhausted: "budget_exhausted",
  cancelled: "cancelled",
  upstreamUnknown: "upstream_unknown",
  providerUnavailable: "provider_unavailable",
  // 核验
  citationIntercepted: "citation_intercepted",
  pseudonymLeak: "pseudonym_leak",
  // 出站闸门（v5.0 §8.3）
  egressBlocked: "egress_blocked",
  // 密钥体系与签发（v5.0 §5.2/§5.3/§6.3）
  revokedDeviceEvent: "revoked_device_event",
  artifactChanged: "artifact_changed",
  // 解析与 OCR（v5.0 §8.1）
  parseUnsafe: "parse_unsafe",
  // Agent 宿主（v5.0 §4.3/探针 1：签名法律 Agent profile 失败关闭）
  agentProfileInvalid: "agent_profile_invalid",
  // 法规版本库与 Source Registry（v5.0 §9、第 5 篇 §2.2）
  lawdbInvalid: "lawdb_invalid",
  sourceActionDenied: "source_action_denied",
  unverifiedCitations: "unverified_citations",
  /** Astra M-2：任务有没读到的材料，签发须勾选“缺口已告知客户”。 */
  materialGapsUndisclosed: "material_gaps_undisclosed",
  // 控制面与许可（v9 阶段 6；第 02 篇 §10 退出模式）
  exitMode: "exit_mode",
  /** 第 13 批：本机尚未用开通码 / 邀请码激活（待激活模式只开放开通相关方法）。 */
  notActivated: "not_activated",
  /** v9 第 02 篇 §9.6、§13 第 6 条：IM 不能确认签发（阶段 7 复核 S7-A08）。 */
  imSignoffDisabled: "im_signoff_disabled",
  /** v9 第 02 篇 §8.1 L4：带国家秘密标志的材料拒绝导入（审计 S6）。 */
  classifiedMaterial: "classified_material",
  /** 令牌还原等敏感接口的速率上限（隐私安全审查 P1-5）。 */
  rateLimited: "rate_limited",
  // 通用
  validation: "validation",
  notFound: "not_found",
  conflict: "conflict",
  internal: "internal",
} as const;
export type FaultCode = (typeof FaultCode)[keyof typeof FaultCode];

export class DomainError extends Error {
  readonly code: FaultCode;
  readonly httpStatus: number;
  readonly detail: Record<string, unknown> | undefined;

  constructor(code: FaultCode, message: string, httpStatus = 400, detail?: Record<string, unknown>) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.detail = detail;
  }
}

export const notFound = (what: string) => new DomainError("not_found", `${what}不存在或无权查看`, 404);
export const conflict = (msg: string, detail?: Record<string, unknown>) => new DomainError("conflict", msg, 409, detail);
export const staleBaseline = (msg = "基线已变化，请刷新后重试") => new DomainError("stale_baseline", msg, 412);
export const validation = (msg: string, detail?: Record<string, unknown>) => new DomainError("validation", msg, 422, detail);
export const forbidden = (msg = "无权执行该操作") => new DomainError("forbidden", msg, 403);
