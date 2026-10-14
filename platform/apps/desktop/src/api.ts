/**
 * 内核 API 客户端（v9 第 04 篇 §3.3：界面只见业务运行时 API；§1.1：渲染进程经主进程 IPC 调用，不直连任何网络地址）。
 * Electron：preload 暴露的 zrKernel.invoke；web 开发：开发桥（127.0.0.1:7720，仅开发，带令牌）。
 */

declare global {
  interface Window {
    zrKernel?: {
      invoke: (method: string, params?: Record<string, unknown>) => Promise<any>;
      onEvent?: (cb: (msg: any) => void) => () => void;
      getPathForFile?: (file: File) => string;
      rendererNet?: () => Promise<{ blocked: number; last: string[] }>;
      platform?: string;
    };
  }
}

const BRIDGE = "http://127.0.0.1:7720/invoke";
/** 开发桥令牌（vite 注入；生产不经开发桥）。 */
const BRIDGE_TOKEN: string = (import.meta as any).env?.VITE_KWL_BRIDGE_TOKEN ?? "";

export class KernelError extends Error {
  code: string;
  detail?: unknown;
  constructor(message: string, code: string, detail?: unknown) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

async function invoke<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (window.zrKernel?.invoke) {
    try {
      return (await window.zrKernel.invoke(method, params)) as T;
    } catch (e) {
      const err = e as Error & { code?: string; detail?: unknown };
      throw new KernelError(err.message, err.code ?? "internal", err.detail);
    }
  }
  const res = await fetch(BRIDGE, {
    method: "POST",
    headers: { "content-type": "application/json", ...(BRIDGE_TOKEN ? { "x-kwl-token": BRIDGE_TOKEN } : {}) },
    body: JSON.stringify({ method, params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new KernelError(data.error?.message ?? "内核调用失败", data.error?.code ?? "internal", data.error?.detail);
  return data.result as T;
}

/** 订阅内核广播（Electron）；web 开发桥无推送，调用方自行轮询。 */
export function onKernelEvent(cb: (msg: any) => void): () => void {
  return window.zrKernel?.onEvent ? window.zrKernel.onEvent(cb) : () => {};
}

// ─── 类型 ───

export type RunMode = "chat" | "manual" | "default" | "auto";
export type Preauthorization = "search_generalized" | "fetch_allowlisted" | "connector_readonly";
export type BasisValue = "confirmed" | "pending" | "not_applicable";
export interface MatterBasis {
  /** 委托/保密授权（客户是否同意使用 AI 与第三方服务）。 */
  engagement: BasisValue;
  /** 个人信息处理依据（含对方、证人、员工等非委托人主体）。 */
  personal_info: BasisValue;
  /** 敏感信息特别条件。 */
  sensitive: BasisValue;
  /** 转委托与次处理者范围。 */
  subprocessor: BasisValue;
}

export interface Matter {
  matter_id: string;
  title: string;
  client_name: string | null;
  counterparty: string | null;
  stance: string;
  jurisdiction: string;
  confidentiality: string;
  model_endpoint: "standard" | "byok" | "private" | "none";
  collab_scope: "personal" | "team";
  consent_status: "agreed" | "pending" | "refused" | "not_required";
  node_allowed?: 0 | 1;
  key_dates?: Record<string, string> | null;
  data_level?: "L0" | "L1" | "L2" | "L3a" | "L3b";
  basis?: MatterBasis;
  /** 四项依据是否齐备（内核判定；当事人拒绝记录优先）。 */
  basis_complete?: boolean;
  full_pseudonym?: boolean;
  /** 数据生命周期：进行中 / 已结案（保留期，只读）/ 已删除。 */
  lifecycle?: "active" | "closed" | "purged";
  closed_at?: string | null;
  retention_until?: string | null;
  legal_hold?: boolean;
  legal_hold_reason?: string | null;
  purged_at?: string | null;
  purge_eligible?: boolean;
  /** 本人在事项中的角色（matters.get）。 */
  my_role?: "owner" | "editor" | "viewer";
  created_at: string;
}

export interface MatterLifecycle {
  lifecycle: "active" | "closed" | "purged";
  closed_at: string | null;
  retention_until: string | null;
  legal_hold: boolean;
  legal_hold_reason: string | null;
  purged_at: string | null;
  purge_eligible: boolean;
}

export interface DeletionReceiptView {
  receipt: {
    receipt_id: string;
    matter_id: string;
    purged_at: string;
    closed_at: string | null;
    retention_until: string | null;
    early: boolean;
    reason: string | null;
    by: string;
    device_id: string;
    inventory: Record<string, number>;
    copies: { where: string; status: "deleted" | "pending" | "irrevocable" | "kept" | "none"; note: string }[];
  };
  signature: string;
  signer_cert: unknown;
  signature_valid: boolean;
}

export interface RunPolicyView {
  allowed_modes: RunMode[];
  default_mode: RunMode;
  plan_first_default: boolean;
  preauthorizations: Preauthorization[];
  budget: { max_tool_calls: number; max_subagents: number };
  data_level: string;
  basis_complete: boolean;
  execution_location: string;
}

export interface RunEvent {
  event_id: number;
  seq: number;
  type: string;
  payload: Record<string, any>;
  created_at: string;
}

export interface EgressRecord {
  record_id: string;
  destination_kind: string;
  destination_host: string;
  request_id: string | null;
  chars: number;
  segments: number;
  pseudonym_findings: number;
  pseudonym_counts: Record<string, number>;
  note: string | null;
  outcome?: string;
  created_at: string;
}

/** 跨边界确认卡（第 03 篇 §8.2；内容由内核按待决审批重算，不采信 Agent 宿主的展示）。 */
export interface ApprovalCard {
  approval_id: string;
  kind: "plan" | "search" | "fetch" | "image" | "budget" | "schedule" | "stop" | "manual" | "connector" | "other";
  tool: string;
  reason: string;
  title: string;
  why: string;
  destination: string;
  cost: string | null;
  /** 检索：原文放行与泛化改写各自将发出的查询；抓取：URL 与主机；计划：计划正文（令牌形态，界面还原后显示）。 */
  preview: { send_original?: string; send_generalized?: string; url?: string; host?: string; plan?: string; detail?: string };
  scope_options: ("once" | "task")[];
  variants?: ("original" | "generalized")[];
  /** “本任务内允许”放行的变体（检索只能是改写后）。 */
  task_variant?: "generalized";
  /** Agent 在这一步的说明（模型自述，仅供参考）。 */
  agent_note?: string | null;
  object_hash: string;
  nonce: string;
  expires_at: string;
}

export interface QuestionCard {
  question_id: string;
  questions: { id: string; question: string; header?: string; options: { id: string; label: string; description?: string }[]; multi_select?: boolean }[];
}

export type QuestionAnswer =
  | { kind: "single"; option_id: string }
  | { kind: "multi"; option_ids: string[] }
  | { kind: "other"; text: string }
  | { kind: "skipped" };

export interface EgressSummary {
  run_id: string;
  model: { requests: number; documents: number; segments: number; chars: number; tokens_present: Record<string, number>; replaced_at_gate: number };
  search: { sent: number; generalized: number; confirmed: number; confirmed_original: number; blocked: number };
  fetch: { pages: number; domains: string[]; blocked: number };
  exec: { runs: number };
  blocked: { purpose: string; reason: string; at: string }[];
  sentence: string;
}

export interface ChatMessage {
  message_id: string;
  role: "user" | "assistant" | "notice";
  text: string;
  created_at: string;
}

export interface Capabilities {
  execution_domain: { available: boolean | null; label: string; status: string; detail: string };
  sole_exit: string;
  gate: { running: boolean; routes: Record<string, boolean>; search_configured: boolean; fetch: string };
  rows: { capability: string; status: string; note: string }[];
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** 控制面状态（阶段 6；不含任何令牌）。 */
export interface ControlPlaneStatus {
  mode: "control_plane" | "local_dev";
  admin_threshold?: number | null;
  /** 管理员签名门限是否已固定（首次取得许可时固定；固定之前不接受放宽内容）。 */
  admin_threshold_pinned?: boolean;
  policy?: {
    source: "control_plane" | "strictest_fallback" | "local_dev";
    version: number | null;
    issued_at: string | null;
    expires_at: string | null;
    body: { max_mode: RunMode; auto_preauthorizations: string[]; fetch_allowlist_extra: string[]; l3a_standard_model: "deny" | "allow" };
    relaxations: string[];
    signers: string[];
    fallback_reason: "none_received" | "expired" | "signers_insufficient" | "unrecognized_newer" | null;
  };
  license?: { state: "dev" | "missing" | "valid" | "expired"; edition: string | null; seats: number | null; expires_at: string | null };
  seat?: { has_token: boolean; sid: string | null; expires_at: string | null } | null;
  directory?: { version: number; devices: number; revoked_devices: number; expires_at: string | null; stale: boolean } | null;
  connectors?: { connector_id: string; name: string; version: number; url?: string; max_data_level: string; tools: number; signers: string[] }[];
  exit_mode?: { code: string; message: string } | null;
  /** 待核对的公钥变更（不含新公钥的安全码：由对方读出、本机比对）。 */
  key_changes?: { device_id: string; member_id: string; detected_at: string }[];
  /** 待同步到控制面的收紧动作（本机吊销）：待发送（自动重试）/ 已提交待目录确认 / 控制面拒绝（需人工处理）。 */
  pending_actions?: { kind: string; target: string; attempts: number; last_error: string | null; state: "pending" | "submitted" | "failed" }[];
  /** 控制面形态但未配置控制面地址（退出模式）。 */
  unconfigured?: boolean;
  alerts?: { alert_id: number; area: string; code: string; subject: string | null; detail: string; created_at: string }[];
  last_sync?: { at: string; ok: boolean; steps: Record<string, string> } | null;
}

/** 律所策略或连接器登记的草稿（本机重算放宽项）。 */
export interface PolicyDraft {
  draft_id: string;
  kind: "policy" | "connector";
  created_at?: string | null;
  /** 草稿的完整文档（策略：有效期与正文；连接器：服务地址、工具清单与 schema 摘要）——所见即所签。 */
  doc: { version: number; issued_at?: string; expires_at?: string; connector_id?: string; name?: string; [k: string]: unknown };
  /** 本机为该草稿算出的待签字节摘要（签名时原样交回）。 */
  digest: string | null;
  relaxations: string[];
  /** 本机核验通过的签名成员。 */
  signed_by: { device_id: string; member_id: string }[];
  signed_by_me: boolean;
  valid: boolean;
  problem: string | null;
}

export interface UnresolvedOperation {
  tool_operation_id: string;
  tool: string;
  operation: string;
  status: string;
  created_at: string;
}

export const api = {
  // 事项
  listMatters: () => invoke<{ matters: Matter[] }>("matters.list"),
  createMatter: (body: Record<string, unknown>) => invoke<{ matter: Matter }>("matters.create", body),
  getMatter: (id: string) => invoke<{ matter: Matter; documents: any[]; run_policy?: RunPolicyView; runs?: any[] }>("matters.get", { matter_id: id }),
  updateMatter: (id: string, patch: Record<string, unknown>) => invoke<{ matter: Matter }>("matters.update", { matter_id: id, patch }),
  // 数据生命周期（结案 → 保留期 → 删除；法律保全）
  matterLifecycle: (id: string) => invoke<{ lifecycle: MatterLifecycle; retention_years: { min: number; max: number; default: number }; receipt: DeletionReceiptView | null }>("matters.lifecycle", { matter_id: id }),
  closeMatter: (id: string, retentionYears: number) => invoke<{ lifecycle: MatterLifecycle; agent_data_purged: boolean }>("matters.close", { matter_id: id, retention_years: retentionYears }),
  reopenMatter: (id: string) => invoke<{ lifecycle: MatterLifecycle }>("matters.reopen", { matter_id: id }),
  setLegalHold: (id: string, on: boolean, reason?: string) => invoke<{ lifecycle: MatterLifecycle }>("matters.hold", { matter_id: id, on, reason }),
  archiveMatter: (id: string) =>
    invoke<{ filename: string; data_base64: string; bytes: number; sha256: string; counts: Record<string, number>; missing: { document_version_id: string; filename: string; reason: string }[] }>("matters.archive", { matter_id: id }),
  purgeMatter: (id: string, body: { confirm_title: string; early: boolean; reason: string }) => invoke<{ lifecycle: MatterLifecycle; receipt: DeletionReceiptView }>("matters.purge", { matter_id: id, ...body }),
  consentNotice: (id: string) => invoke<{ artifact_version_id: string; filename: string; note: string }>("matters.consent_notice", { matter_id: id }),
  parties: (matterId: string) => invoke<{ parties: { name: string; kind: "person" | "org"; aliases: string[]; role: string | null }[]; full_pseudonym: boolean }>("matters.parties.list", { matter_id: matterId }),
  upsertParty: (matterId: string, body: { name: string; kind: "person" | "org"; aliases: string[]; role?: string | null }) => invoke("matters.parties.upsert", { matter_id: matterId, ...body }),
  removeParty: (matterId: string, name: string) => invoke("matters.parties.remove", { matter_id: matterId, name }),
  /** 别名处置：确认学得的别名 / 驳回或停用（自动派生的字号）/ 撤销停用（阶段 4 复核 S4-20）。 */
  partyAlias: (matterId: string, name: string, alias: string, action: "confirm" | "reject" | "restore") =>
    invoke("matters.parties.alias", { matter_id: matterId, name, alias, action }),
  /** 只在渲染层还原代号（第 02 篇 §8.4；T20）：结果不落盘、不回传 Agent。 */
  restore: (matterId: string, text: string) => invoke<{ text: string; unknown: string[] }>("matters.tokens.restore", { matter_id: matterId, text }),

  // 材料
  importMaterial: async (matterId: string, file: File): Promise<{ document_version_id: string; quality_flags: string[]; chars: number; sha256: string; note: string; marking_notice?: string | null }> => {
    const path = window.zrKernel?.getPathForFile?.(file);
    if (path) return invoke("materials.import", { matter_id: matterId, path, filename: file.name, mime: file.type || "application/octet-stream" });
    const data_base64 = await fileToBase64(file);
    return invoke("materials.import", { matter_id: matterId, data_base64, filename: file.name, mime: file.type || "application/octet-stream" });
  },
  mountMaterial: async (matterId: string, file: File) => {
    const path = window.zrKernel?.getPathForFile?.(file);
    if (!path) throw new KernelError("挂载需要桌面客户端（web 调试请用导入）", "validation");
    return invoke("materials.mount", { matter_id: matterId, path, filename: file.name, mime: file.type || "application/octet-stream" });
  },

  // 任务
  estimate: (matterId: string, body: { scenario: string; document_version_ids: string[]; goal?: string; topic_hint?: string } & Record<string, unknown>) =>
    invoke<{ estimate_id: string; points: number; points_display: string; assumptions: string[]; data_where?: { preview: string; warning: string | null; start_blocked: boolean } }>("runs.estimate", { matter_id: matterId, ...body }),
  startRun: (matterId: string, body: { estimate_id: string; idempotency_key: string; goal?: string; topic_hint?: string; mode?: RunMode; plan_first?: boolean; preauthorizations?: Preauthorization[]; skill?: string; followup_of?: string; mode_raise_confirmed?: boolean }) =>
    invoke<{ run_id: string; status: string; mode?: RunMode }>("runs.start", { matter_id: matterId, ...body }),
  getRun: (runId: string) =>
    invoke<{ run: any; artifacts: any[]; inflight?: { model: number; search: number; fetch: number }; unresolved_operations?: UnresolvedOperation[] }>("runs.get", { run_id: runId }),
  /** 方法模板（Kimi Code Skills）：已验签、会在任务中提供给 Agent 的方法模板。 */
  listSkills: () =>
    invoke<{ ok: boolean; reason?: string; skills: { id: string; title: string; description: string; version: string; tier: string; lines: string[] }[] }>("skills.list", {}),
  /** 人工对账：逐项确认结果不明的操作是否已生效（applied / not_applied）。 */
  reconcileOperation: (runId: string, toolOperationId: string, resolution: "applied" | "not_applied") =>
    invoke<{ remaining_unresolved: number; run_status: string }>("runs.reconcile", { run_id: runId, tool_operation_id: toolOperationId, resolution }),
  /** 重新运行失败的任务（乐观并发）。 */
  retryRun: (runId: string, expectedVersion: number) => invoke("runs.retry", { run_id: runId, expected_version: expectedVersion }),
  runEvents: (runId: string, cursor = 0) => invoke<{ events: RunEvent[]; next_cursor: number; run_status: string }>("runs.events", { run_id: runId, cursor, limit: 500 }),
  cancelRun: (runId: string, expectedVersion: number) => invoke("runs.cancel", { run_id: runId, expected_version: expectedVersion, reason: "用户取消" }),
  interactions: (runId: string) => invoke<{ approvals: ApprovalCard[]; questions: QuestionCard[]; state_version: number | null; live_text?: string | null }>("runs.interactions", { run_id: runId }),
  decide: (runId: string, card: ApprovalCard, body: { decision: "approve" | "reject"; scope?: "once" | "task"; variant?: "original" | "generalized"; feedback?: string }) =>
    invoke<{ ok: true }>("runs.approve", { run_id: runId, approval_id: card.approval_id, object_hash: card.object_hash, nonce: card.nonce, ...body }),
  /** 作答带回界面看到的状态版本（乐观并发：期间有新的提问或决定时须按最新卡片作答）。 */
  answer: (runId: string, questionId: string, answers: Record<string, QuestionAnswer>, expectedStateVersion?: number | null) =>
    invoke<{ ok: true }>("runs.answer", { run_id: runId, question_id: questionId, answers, ...(typeof expectedStateVersion === "number" ? { expected_state_version: expectedStateVersion } : {}) }),

  // 成果
  downloadArtifact: async (artifactVersionId: string, filename: string): Promise<void> => {
    const r = await invoke<{ filename: string; sha256: string; data_base64: string }>("artifacts.download", { artifact_version_id: artifactVersionId });
    const bin = Uint8Array.from(atob(r.data_base64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bin], { type: "application/octet-stream" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },
  /** 预览用：取令牌形态的原文（界面按事项令牌表还原显示；不是导出，不记导出审计）。 */
  artifactText: (artifactVersionId: string) => invoke<{ filename: string; sha256: string; data_base64: string }>("artifacts.download", { artifact_version_id: artifactVersionId, restore: false }),
  /** Office 成果的应用内预览（内核渲染为白名单 HTML，界面在隔离框架中显示）。 */
  artifactHtml: (artifactVersionId: string) =>
    invoke<{ filename: string; html: string; kind: "docx" | "xlsx"; summary: Record<string, unknown> }>("artifacts.render_html", { artifact_version_id: artifactVersionId }),
  /** 材料全文（审查工作台左栏；按段落）。 */
  materialText: (documentVersionId: string) => invoke<{ filename: string; paragraphs: string[] }>("materials.text", { document_version_id: documentVersionId }),
  riskCards: (matterId: string, f: { run_id?: string; document_version_id?: string | null } = {}) => invoke<{ cards: RiskCard[]; progress: RiskProgress }>("riskcards.list", { matter_id: matterId, ...f }),
  decideRiskCard: (matterId: string, cardId: string, decision: "accept" | "modify" | "reject" | "reset", finalText?: string) =>
    invoke<{ card: RiskCard }>("riskcards.decide", { matter_id: matterId, card_id: cardId, decision, ...(finalText ? { final_text: finalText } : {}) }),
  buildRedline: (matterId: string, documentVersionId: string, o: { run_id?: string; skip_card_ids?: string[] } = {}) =>
    invoke<
      | { status: "applied"; artifact_version_id: string; filename: string; applied: number; skipped: string[] }
      | { status: "preview"; reason: string; conflicts: { index: number; reason: string; detail?: string; card_id: string | null }[]; skipped: string[] }
    >("riskcards.redline", { matter_id: matterId, document_version_id: documentVersionId, ...o }),
  facts: (matterId: string, f: { run_id?: string } = {}) => invoke<{ facts: FactRow[] }>("facts.list", { matter_id: matterId, ...f }),
  decideFact: (matterId: string, factId: string, decision: "confirm" | "reject" | "reset", statement?: string) =>
    invoke<{ fact: FactRow }>("facts.decide", { matter_id: matterId, fact_id: factId, decision, ...(statement ? { statement } : {}) }),
  listArtifacts: (matterId: string) => invoke<{ artifacts: any[] }>("artifacts.list", { matter_id: matterId }),

  // 复核与签发
  submitReview: (artifactVersionId: string) => invoke("review.submit", { artifact_version_id: artifactVersionId }),
  completeness: (artifactVersionId: string) => invoke<any>("review.completeness", { artifact_version_id: artifactVersionId }),
  approve: (artifactVersionId: string, body: { decision: "approved" | "rejected"; expected_sha256: string; checklist?: Record<string, unknown> }) =>
    invoke<any>("review.approve", { artifact_version_id: artifactVersionId, ...body }),
  deliver: (body: { artifact_version_id: string; action: "download" | "external_send" | "archive"; audience?: string }) => invoke<any>("deliveries.create", body),
  pending: () => invoke<{ pending: any[]; count: number }>("pending.list"),

  // 数据去向
  egressRecords: (args: { runId?: string; matterId?: string }) => invoke<{ records: EgressRecord[] }>("egress.records", args.runId ? { run_id: args.runId } : { matter_id: args.matterId }),
  egressSummary: (runId: string) => invoke<EgressSummary>("egress.summary", { run_id: runId }),
  /** 结果不明的出站（预写后中断，待人工对账；阶段 4 复核 S4-21）。 */
  egressUnresolved: (matterId?: string) => invoke<{ records: any[] }>("egress.unresolved", matterId ? { matter_id: matterId } : {}),
  egressReconcile: (recordId: string, resolution: "confirmed_sent" | "not_sent" | "unknown") => invoke("egress.reconcile", { record_id: recordId, resolution }),

  // 问答（无事项）
  chatList: () => invoke<{ conversations: { conversation_id: string; title: string; updated_at: string }[] }>("chat.list"),
  chatGet: (conversationId: string) => invoke<{ conversation_id: string; messages: ChatMessage[] }>("chat.get", { conversation_id: conversationId }),
  chatSend: (body: { conversation_id?: string; text: string }) =>
    invoke<{ conversation_id: string; messages: ChatMessage[]; blocked?: { reason: string; message: string; matters?: { matter_id: string; title: string }[] } }>("chat.send", body),

  // 设备与连接
  /** 渲染会话被主进程拦截的外部请求（只在桌面客户端有；web 开发返回 null）。 */
  rendererNet: async (): Promise<{ blocked: number; last: string[] } | null> => (window.zrKernel?.rendererNet ? window.zrKernel.rendererNet() : null),
  kernelStatus: () => invoke<any>("kernel.status"),
  // 控制面与律所治理（阶段 6）：状态不含任何令牌；告警是控制面下发内容未通过本机核验的记录
  controlPlaneStatus: () => invoke<ControlPlaneStatus>("control_plane.status"),
  controlPlaneSync: () => invoke<{ report?: { ok: boolean; steps: Record<string, string>; at: string }; status?: ControlPlaneStatus; note?: string }>("control_plane.sync"),
  controlPlaneAck: (alertId: number) => invoke("control_plane.alerts.ack", { alert_id: alertId }),
  policyDrafts: () => invoke<{ drafts: PolicyDraft[] }>("firm_policy.drafts"),
  policyCreateDraft: (body: Record<string, unknown>, ttlDays: number) => invoke<{ draft: PolicyDraft }>("firm_policy.create_draft", { kind: "policy", body, ttl_days: ttlDays }),
  /** 签名绑定界面所见内容：交回本机为该草稿算出的待签字节摘要，内核比对后才签（复核 S6-B02）。 */
  policySign: (draftId: string, expectedDigest: string) => invoke<{ draft: PolicyDraft }>("firm_policy.sign", { draft_id: draftId, expected_digest: expectedDigest }),
  policyPublish: (draftId: string) => invoke<{ status: ControlPlaneStatus }>("firm_policy.publish", { draft_id: draftId }),
  keyChangeConfirm: (deviceId: string, safetyCode: string) => invoke<{ ok: true; note: string }>("devices.key_changes.confirm", { device_id: deviceId, safety_code: safetyCode }),
  capabilities: () => invoke<Capabilities>("kernel.capabilities"),
  lawdbStatus: () => invoke<any>("lawdb.status"),
  devices: () => invoke<{ devices: any[]; tenant_epoch: number; my_device_id?: string; my_safety_code?: string }>("devices.list"),
  imList: () => invoke<{ bindings: any[] }>("im.list"),
  recoveryStatus: () => invoke<any>("recovery.status"),

  // 所内节点（v5 原型保留）
  nodeEnqueue: (body: { matter_id: string; scenario: string; input?: Record<string, unknown>; idempotency_key: string }) => invoke<any>("runs.node_enqueue", body),
};

/** 风险卡（审查工作台；文字为令牌形态，界面还原显示；律师改写的 final_text 为原文）。 */
export interface RiskCard {
  card_id: string;
  run_id: string | null;
  document_version_id: string | null;
  anchor_quote?: string | null;
  seq: number;
  clause_ref: string | null;
  anchor_text: string;
  anchor_status: "located" | "ambiguous" | "not_found" | "no_document" | "cross_paragraph";
  anchor_start: number | null;
  severity: "high" | "mid" | "low";
  category: "legal" | "commercial" | "both";
  issue: string;
  basis: { law: string; article: number | null; note: string | null; check: string; matched: string | null }[];
  suggestion: string | null;
  fallback: string | null;
  needs_client_decision: boolean;
  assumptions: string | null;
  status: "proposed" | "accepted" | "modified" | "rejected";
  final_text: string | null;
  decided_at: string | null;
}
export interface RiskProgress {
  total: number;
  decided: number;
  high_open: number;
  /** 会写进修订稿的项数（修改后接受，或接受且有建议文本）。 */
  accepted: number;
  /** 知悉、不改动的项数。 */
  acknowledged?: number;
}
export interface FactRow {
  fact_id: string;
  run_id: string | null;
  statement: string;
  kind: "claimed" | "inferred" | "to_confirm" | "confirmed";
  occurred_on: string | null;
  amount_yuan: number | null;
  party: string | null;
  document_version_id: string | null;
  quote: string | null;
  anchor_status: string;
  status: "proposed" | "confirmed" | "rejected";
}
