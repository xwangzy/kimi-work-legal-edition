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
