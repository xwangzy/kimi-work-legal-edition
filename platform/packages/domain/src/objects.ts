/**
 * 领域对象（方案 v4.0 第 4 篇 §4.3 最小关键字段 + 约束）。
 * 所有时间为 UTC ISO 字符串；内容版本不可变。
 */
import type {
  ArtifactStatus,
  Audience,
  CollabScope,
  ConsentStatus,
  ModelEndpoint,
  RunStatus,
  SeatKind,
} from "./states.ts";

export interface Tenant {
  tenant_id: string;
  name: string;
  created_at: string;
}

export interface User {
  user_id: string;
  tenant_id: string;
  display_name: string;
  created_at: string;
}

/** 约束：管理员角色不自动获得案卷正文权限。 */
export type OrgRole = "firm_admin" | "knowledge_admin" | "partner" | "lawyer" | "paralegal" | "it" | "finance";

export interface Membership {
  membership_id: string;
  tenant_id: string;
  user_id: string;
  role: OrgRole;
  authz_version: number;
}

export interface Seat {
  seat_id: string;
  tenant_id: string;
  user_id: string;
  kind: SeatKind;
  valid_from: string;
  valid_to: string | null;
}

/** 事项与策略（模型端点、协作范围、当事人同意在事项头部常显；权限与数据去向由内核确定）。 */
export interface Matter {
  matter_id: string;
  tenant_id: string;
  title: string;
  client_name: string | null;
  counterparty: string | null;
  stance: string;
  jurisdiction: string;
  key_dates: Record<string, string>;
  confidentiality: "normal" | "high" | "strict";
  model_endpoint: ModelEndpoint;
  collab_scope: CollabScope;
  consent_status: ConsentStatus;
  policy_version: number;
  status: "active" | "archived";
  created_by: string;
  created_at: string;
}

export interface MatterMember {
  matter_id: string;
  user_id: string;
  matter_role: "owner" | "editor" | "reviewer" | "issuer" | "viewer";
  added_by: string;
  added_at: string;
}

/** 原件只读；纠错建新版本。存储模式：挂载（只读引用，不复制）/ 导入（加密副本进内容寻址块）。 */
export interface DocumentVersion {
  document_version_id: string;
  matter_id: string;
  tenant_id: string;
  filename: string;
  sha256: string;
  size_bytes: number;
  mime: string;
  storage_mode: "mount" | "import";
  storage_uri: string;
  supersedes: string | null;
  uploaded_by: string;
  created_at: string;
}

export interface ParseVersion {
  parse_version_id: string;
  document_version_id: string;
  parser: string;
  parser_version: string;
  page_count: number | null;
  quality_flags: string[];
  text_uri: string;
  created_at: string;
}

/** 锚点：转换前后位置有映射。 */
export interface EvidenceAnchor {
  anchor_id: string;
  parse_version_id: string;
  page: number | null;
  paragraph: string | null;
  char_start: number;
  char_end: number;
  text_hash: string;
}

/** 任务 / 尝试 / 事件账本（§4.3 Run/Attempt/ToolOperation）。 */
export interface Run {
  run_id: string;
  tenant_id: string;
  matter_id: string;
  scenario: string;
  workflow_version: string;
  status: RunStatus;
  status_version: number;
  idempotency_key: string;
  input_snapshot: Record<string, unknown>;
  budget_points: number;
  points_reserved: number;
  points_charged: number;
  estimate_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface Attempt {
  attempt_id: string;
  run_id: string;
  seq: number;
  status: "running" | "succeeded" | "failed" | "cancelled";
  lease_owner: string | null;
  lease_until: string | null;
  fence_token: number;
  error: string | null;
  started_at: string;
  ended_at: string | null;
}

/** 追加式事件账本；先落账本再推前端（§9.5）。 */
export interface RunEvent {
  event_id: number;
  run_id: string;
  attempt_id: string | null;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface ToolOperation {
  tool_operation_id: string;
  run_id: string;
  attempt_id: string;
  tool: string;
  operation: string;
  params_hash: string;
  status: "requested" | "approved" | "rejected" | "succeeded" | "failed";
  result_uri: string | null;
  created_at: string;
}

/** 成果与签发：签发绑定最终字节 hash；批准 A 版不能用于 B 版。 */
export interface ArtifactVersion {
  artifact_version_id: string;
  tenant_id: string;
  matter_id: string;
  run_id: string | null;
  kind: string;
  version: number;
  baseline_id: string | null;
  audience: Audience;
  status: ArtifactStatus;
  filename: string;
  sha256: string;
  storage_uri: string;
  open_items: unknown[];
  manifest: Record<string, unknown>;
  created_by: string;
  created_at: string;
}

export interface Approval {
  approval_id: string;
  artifact_version_id: string;
  artifact_sha256: string;
  approver_id: string;
  decision: "approved" | "rejected";
  checklist: Record<string, unknown>;
  valid_until: string | null;
  created_at: string;
}

/** 计量（§4.2）：token 分类归集，失败退点不抹掉真实成本。 */
export interface UsageRecord {
  usage_id: string;
  request_id: string;
  tenant_id: string;
  user_id: string | null;
  matter_id: string | null;
  run_id: string | null;
  attempt_id: string | null;
  route: string;
  provider_model: string;
  tokens_uncached_input: number;
  tokens_cached_input: number;
  tokens_cache_write: number;
  tokens_output: number;
  tokens_reasoning: number;
  tool_calls: number;
  cost_microcny: number | null;
  created_at: string;
}
