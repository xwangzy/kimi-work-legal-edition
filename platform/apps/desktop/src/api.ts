/**
 * 内核 API 客户端（v9 第 04 篇 §3.3：界面只见业务运行时 API；§1.1：渲染进程经主进程 IPC 调用，不直连任何网络地址）。
 * Electron：preload 暴露的 zrKernel.invoke；web 开发：开发桥（127.0.0.1:7720，仅开发，带令牌）。
 */

declare global {
  interface Window {
    zrKernel?: {
      invoke: (method: string, params?: Record<string, unknown>) => Promise<any>;
      onEvent?: (cb: (msg: any) => void) => () => void;
      fileHandleFor?: (file: File) => Promise<PickedFile | null>;
      /** 主进程文件对话框（v9.2 §3.7）：只回一次性句柄、文件名与大小。 */
      pickFiles?: (o: { extensions?: string[]; multiple?: boolean }) => Promise<PickedFile[] | null>;
      pickSave?: (o: { name: string }) => Promise<{ handle: string; name: string; risk: SaveRisk | null } | null>;
      saveText?: (handle: string, text: string) => Promise<{ ok: boolean; name?: string }>;
      rendererNet?: () => Promise<{ blocked: number; last: string[] }>;
      updateStatus?: () => Promise<UpdateStatus | null>;
      installUpdate?: () => Promise<{ ok: boolean; reason?: string }>;
      platform?: string;
    };
  }
}

/** 主进程对话框选中的文件（渲染进程拿不到路径）。 */
export interface PickedFile {
  handle: string;
  name: string;
  size: number;
}
export type MaterialFile = File | PickedFile;
const isPicked = (f: MaterialFile): f is PickedFile => typeof (f as PickedFile).handle === "string";
export type SaveRisk = "onedrive" | "cloud" | "network";
const SAVE_PLACE: Record<SaveRisk, string> = {
  onedrive: "这个位置在 OneDrive 同步文件夹里",
  cloud: "这个位置在云盘的同步文件夹里",
  network: "这个位置是网络共享文件夹",
};

/**
 * 选保存位置（桌面客户端）：返回句柄；取消返回 null；不是桌面客户端返回 undefined（改用浏览器下载）。
 * 同步或网络位置先说明后果（复核 S5B-09：按文件是否含案件内容分别措辞；选“取消”会重新选择位置，而不是直接保存）。
 */
async function chooseSaveTarget(name: string, content: "case" | "none" = "case"): Promise<{ handle: string; name: string } | null | undefined> {
  const pick = window.zrKernel?.pickSave;
  if (!pick) return undefined;
  for (let i = 0; i < 3; i++) {
    const s = await pick({ name });
    if (!s) return null;
    if (!s.risk) return s;
    const what = content === "case" ? "文件会以原文（含当事人真实名称）同步或保存到其他设备上" : "文件会同步或保存到其他设备上（文件本身不含案件内容）";
    if (window.confirm(`${SAVE_PLACE[s.risk]}：${what}。\n\n点“确定”仍保存在这里；点“取消”换一个位置。`)) return s;
  }
  return null;
}

/** 材料的常见扩展名（选择对话框的过滤器）。 */
export const MATERIAL_EXTENSIONS = ["docx", "pdf", "txt", "md", "png", "jpg", "jpeg", "xlsx", "csv"];
/** web 开发形态文件输入框的同一组扩展名（复核 S5B-10）。 */
export const MATERIAL_ACCEPT = MATERIAL_EXTENSIONS.map((e) => `.${e}`).join(",");

/**
 * 选择材料（Y5 P1-4）：桌面客户端弹主进程系统对话框（不进“最近使用”，渲染进程只拿句柄）；web 开发形态退回隐藏的文件输入框。
 */
export async function pickMaterials(fallback: HTMLInputElement | null, onPicked: (files: MaterialFile[]) => unknown): Promise<void> {
  if (!window.zrKernel?.pickFiles) {
    fallback?.click();
    return;
  }
  try {
    const picked = (await window.zrKernel.pickFiles({ extensions: MATERIAL_EXTENSIONS })) ?? [];
    if (picked.length > 0) await onPicked(picked);
  } catch (e) {
    // 选择或添加失败要让律师看到（复核 S5B-10）
    window.alert(`没能添加文件：${(e as Error).message}`);
  }
}

/** web 开发形态的浏览器下载（桌面客户端不走这里）。 */
/** 文本转 base64（分块，避免大文本展开参数超出调用栈）。 */
function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function browserDownload(dataBase64: string, filename: string, type: string): void {
  const bin = Uint8Array.from(atob(dataBase64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bin], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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

/** 自动更新（W7，只在安装包形态启用）：状态与“重启并安装”。 */
export const updates = {
  status: async (): Promise<UpdateStatus | null> => (window.zrKernel?.updateStatus ? window.zrKernel.updateStatus() : null),
  install: async (): Promise<{ ok: boolean; reason?: string }> => (window.zrKernel?.installUpdate ? window.zrKernel.installUpdate() : { ok: false }),
};

/** 订阅内核广播（Electron）；web 开发桥无推送，调用方自行轮询。 */
export function onKernelEvent(cb: (msg: any) => void): () => void {
  return window.zrKernel?.onEvent ? window.zrKernel.onEvent(cb) : () => {};
}

// ─── 类型 ───

/** 运行过程快照（K7-P；令牌形态，运行中每秒随待决卡片一起取）。 */
export interface RunProgress {
  todo: { title: string; status: "pending" | "in_progress" | "done" }[];
  subagents: { id: string; name: string; description: string; status: "running" | "done" | "failed" | "cancelled" | "paused"; swarm_index: number | null; background: boolean; summary: string | null }[];
  tasks: { id: string; kind: "bash" | "agent" | "other"; description: string; status: "running" | "done" | "failed" | "stopped" }[];
  notes: { at: string; text: string; agent_id: string }[];
  compaction: { count: number; running: boolean; blocked: boolean; last_at: string | null; tokens_before: number | null; tokens_after: number | null };
  skills: string[];
  retry: { attempt: number; max: number; status_code: number | null; at: string } | null;
  /** 主 Agent 当前阶段与引擎心跳（旧内核没有此项）。 */
  activity?: { phase: "thinking" | "writing" | "tool" | "retrying" | null; since: string | null; tool: string | null; heartbeat_at: string | null };
}

/** 自动更新状态（主进程 updater.cjs；只在安装包形态启用）。 */
export interface UpdateStatus {
  enabled?: boolean;
  state: "idle" | "checking" | "downloading" | "ready" | "rejected" | "error";
  version?: string | null;
  percent?: number;
  message?: string;
}

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
  /** 示例事项（虚构内容，本机生成、不联网；可移除）。 */
  is_sample?: boolean;
  /** 进行中与等你确认的任务数（matters.list 给出）。 */
  activity?: { waiting: number; running: number; waiting_run_id: string | null; pending_review?: number; last_at?: string };
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

/** 发起前“将发送什么”（v9.2 §3.3）：按类别的替换计数与疑似未替换的姓名。 */
export interface SendSummaryView {
  docs: number;
  chars: number;
  replaced: Partial<Record<string, number>>;
  replaced_total: number;
  orgs_kept: boolean;
  suspects: { high: number; medium: number; unreviewed: number };
  truncated: boolean;
}
export interface SendPreview {
  filename: string;
  sent_text: string;
  chars: number;
  truncated: boolean;
  replaced: Partial<Record<string, number>>;
  tokens: { start: number; end: number; category: string }[];
  suspects: { start: number; end: number; confidence: string }[];
  orgs_kept: boolean;
}
/** 召回评测（S8 进所评测）：金标准文书（与 packages/tokenizer/eval 同一格式）。 */
export type EvalCategory = "person" | "org" | "id_number" | "phone" | "account" | "uscc" | "address" | "plate" | "email" | "case_no" | "birth_date" | "person_partial" | "negative";
export interface EvalSpan {
  start: number;
  end: number;
  category: EvalCategory;
  person_id?: string;
}
export interface EvalDoc {
  doc_id: string;
  source: string;
  text: string;
  known_parties: { name: string; kind: "person" | "org" }[];
  spans: EvalSpan[];
}
export interface EvalMetric {
  value: number | null;
  ci95: [number, number] | null;
  method: string | null;
  numerator: number;
  denominator: number;
  docsWithData: number;
}
export interface EvalAgreement {
  report: {
    paired: number;
    missing_in_a: number;
    missing_in_b: number;
    pooled_kappa: number | null;
    pooled_f1: number | null;
    kappa_min: number | null;
    docs_passing: number;
    docs_failing: number;
    per_doc: { doc_id: string; kappa: number; f1: number | null; agreed: number; only_a: number; only_b: number; text_mismatch: boolean; passes: boolean }[];
    thresholds: { kappa: number; f1: number };
  };
  groups: { doc_id: string; group: number; start: number; end: number; a: EvalSpan[]; b: EvalSpan[] }[];
}
export type EvalDecision = "a" | "b" | "none";

export interface SuspectView {
  value: string;
  confidence: "high" | "medium";
  cue: string;
  context: string;
  occurrences: number;
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

/** 上传诊断包前的预览（第 9 批 S13）：与“导出诊断信息”同一份内容。 */
export interface SupportPreview {
  allowed: boolean;
  configured: boolean;
  /** 超过 2 MB：不能上传（预览时即说明，不去申请工单）。 */
  too_large: boolean;
  /** 诊断包文件字节的 SHA-256（确认上传时交回；内核据此找回预览的那一份）。 */
  file_sha256: string;
  content_sha256: string;
  summary: { sections: string[]; bytes: number };
  preview: string;
}

/** 本所用量与上限（第 9 批 S3；只有点数与成员编号，成员名由内核在本机换上）。 */
/** 本人设的期限提醒（第 10 批 S9）。 */
export interface ReminderItem {
  reminder_id: string;
  matter_id: string;
  matter_title: string;
  collab_scope: "personal" | "team";
  kind: string;
  due_date: string;
  remind_at: string;
  days_before: number;
  remind_time: string;
  note: string;
  audience: "me" | "team";
  version: number;
  cloud_state: "local" | "pending" | "synced" | "failed" | "cancel_pending" | "cancelled";
  cloud_targets: number | null;
  cloud_error: string | null;
  matter_lifecycle: "active" | "closed" | "purged";
  my_role: string | null;
  /** 当前版本已经响过（改动后会再提醒一次）。 */
  fired: boolean;
}
/** 收到的提醒（本机到时或云端送来、核对签名后）。 */
export interface ReminderInboxItem {
  reminder_id: string;
  version: number;
  matter_id: string;
  matter_title: string | null;
  kind: string;
  due_date: string;
  remind_at: string;
  note: string;
  source: "local" | "cloud";
  received_at: string;
  read_at: string | null;
  from_name: string | null;
  from_me: boolean;
}
export interface ReminderInput {
  matter_id?: string;
  kind: string;
  due_date: string;
  days_before: number;
  remind_time: string;
  note: string;
  audience: "me" | "team";
}

export interface QuotaStatus {
  mode: "control_plane" | "local_dev";
  note?: string;
  period?: string;
  /** 暂停原因：上限已到 / 购买额度用完（成员也能看到，不含金额）。 */
  paused?: "cap" | "pool" | null;
  cap_monthly?: number | null;
  cap_set_at?: string | null;
  period_used?: number;
  in_flight?: number;
  own?: { points: number; requests: number } | null;
  history?: { period: string; used: number }[];
  pool_remaining?: number;
  granted_total?: number;
  by_member?: { member_id: string | null; name: string | null; points: number; requests: number }[];
  unreconciled_leases?: number;
}

/** 中软侧操作记录（第 9 批 S14）：本机验过签名与哈希链后留存的记录。 */
export interface CpAuditRow {
  seq: number;
  at: string;
  actor: { kind: "device" | "root" | "ops" | "service"; id: string; fp?: string };
  actor_name: string | null;
  action: string;
  target: string | null;
  target_name: string | null;
  result: string;
  /** 数值明细（上限点数、加量点数、席位数、续订天数）。 */
  detail?: Record<string, number>;
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
    body: { max_mode: RunMode; auto_preauthorizations: string[]; fetch_allowlist_extra: string[]; l3a_standard_model: "deny" | "allow"; support_upload?: "deny" | "allow" };
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
  /** 示例事项（v9.2 §4.4；Y4 §5 D-6）：首次使用放入一次；移除后不再放入。 */
  installSample: () => invoke<{ matter_id: string | null; installed: boolean }>("samples.install", {}),
  removeSample: (matterId: string) => invoke<{ removed: boolean }>("samples.remove", { matter_id: matterId }),
  createMatter: (body: Record<string, unknown>) => invoke<{ matter: Matter }>("matters.create", body),
  getMatter: (id: string) => invoke<{ matter: Matter; documents: any[]; run_policy?: RunPolicyView; runs?: any[] }>("matters.get", { matter_id: id }),
  updateMatter: (id: string, patch: Record<string, unknown>) => invoke<{ matter: Matter }>("matters.update", { matter_id: id, patch }),
  // 数据生命周期（结案 → 保留期 → 删除；法律保全）
  matterLifecycle: (id: string) => invoke<{ lifecycle: MatterLifecycle; retention_years: { min: number; max: number; default: number }; receipt: DeletionReceiptView | null }>("matters.lifecycle", { matter_id: id }),
  closeMatter: (id: string, retentionYears: number) => invoke<{ lifecycle: MatterLifecycle; agent_data_purged: boolean }>("matters.close", { matter_id: id, retention_years: retentionYears }),
  reopenMatter: (id: string) => invoke<{ lifecycle: MatterLifecycle }>("matters.reopen", { matter_id: id }),
  setLegalHold: (id: string, on: boolean, reason?: string) => invoke<{ lifecycle: MatterLifecycle }>("matters.hold", { matter_id: id, on, reason }),
  /** 结案归档：桌面客户端由内核直接写到律师选定的位置；返回 null = 律师取消。 */
  archiveMatter: async (id: string, suggestedName = "结案归档.zip") => {
    type R = { filename: string; data_base64?: string; saved?: boolean; bytes: number; sha256: string; counts: Record<string, number>; missing: { document_version_id: string; filename: string; reason: string }[] };
    const target = await chooseSaveTarget(suggestedName);
    if (target === null) return null;
    const r = await invoke<R>("matters.archive", { matter_id: id, ...(target ? { save_handle: target.handle } : {}) });
    if (!target && r.data_base64) browserDownload(r.data_base64, r.filename, "application/zip");
    return r;
  },
  /** 选择材料（桌面客户端用主进程对话框，不进“最近使用”）；不是桌面客户端返回 null，调用方改用文件输入框。 */
  pickFiles: async (extensions?: string[]): Promise<PickedFile[] | null> => (window.zrKernel?.pickFiles ? ((await window.zrKernel.pickFiles({ extensions })) ?? []) : null),
  /** 不含案件内容的小文件（删除回执）：桌面客户端经主进程写到选定位置。返回 false = 取消或失败。 */
  saveSmallText: async (suggestedName: string, text: string): Promise<boolean> => {
    const target = await chooseSaveTarget(suggestedName, "none");
    if (target === null) return false;
    if (target && window.zrKernel?.saveText) return (await window.zrKernel.saveText(target.handle, text)).ok;
    browserDownload(btoa(String.fromCharCode(...new TextEncoder().encode(text))), suggestedName, "application/json");
    return true;
  },
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
  importMaterial: async (matterId: string, file: MaterialFile): Promise<{ document_version_id: string; quality_flags: string[]; chars: number; sha256: string; note: string; marking_notice?: string | null }> => {
    if (isPicked(file)) return invoke("materials.import", { matter_id: matterId, file_handle: file.handle, filename: file.name });
    // 桌面客户端：拖放的文件经 preload 换成一次性句柄，内核按句柄换来的路径直读（不经页面内存、页面拿不到路径）
    if (window.zrKernel?.fileHandleFor) {
      const h = await window.zrKernel.fileHandleFor(file);
      if (!h) throw new KernelError("这个文件不能添加（网络位置上的文件请先复制到本机）", "validation");
      return invoke("materials.import", { matter_id: matterId, file_handle: h.handle, filename: file.name });
    }
    const data_base64 = await fileToBase64(file);
    return invoke("materials.import", { matter_id: matterId, data_base64, filename: file.name, mime: file.type || "application/octet-stream" });
  },
  /** 材料用途（我方 / 对方 / 参考；null 清除）。 */
  setMaterialRole: (documentVersionId: string, role: "ours" | "theirs" | "reference" | null) => invoke<{ role: string | null }>("materials.set_role", { document_version_id: documentVersionId, role }),
  mountMaterial: async (matterId: string, file: MaterialFile) => {
    if (isPicked(file)) return invoke("materials.mount", { matter_id: matterId, file_handle: file.handle, filename: file.name });
    const h = window.zrKernel?.fileHandleFor ? await window.zrKernel.fileHandleFor(file) : null;
    if (!h) throw new KernelError(window.zrKernel?.fileHandleFor ? "这个文件不能引用（网络位置上的文件请先复制到本机）" : "引用原文件需要桌面客户端（web 调试请用添加）", "validation");
    return invoke("materials.mount", { matter_id: matterId, file_handle: h.handle, filename: file.name });
  },

  // 任务
  estimate: (matterId: string, body: { scenario: string; document_version_ids: string[]; goal?: string; topic_hint?: string } & Record<string, unknown>) =>
    invoke<{ estimate_id: string; points: number; points_display: string; assumptions: string[]; data_where?: { preview: string; warning: string | null; start_blocked: boolean; block_kind?: "exit_mode" | "busy" | "consent" | "suspects" | null; busy_run_id?: string; send_summary?: SendSummaryView } }>("runs.estimate", { matter_id: matterId, ...body }),
  /** 发送视图（v9.2 §3.4）：模型会看到的样子——令牌形态与代号位置，不含代号真值。 */
  sendPreview: (matterId: string, documentVersionId: string) => invoke<SendPreview>("materials.send_preview", { matter_id: matterId, document_version_id: documentVersionId }),
  /** 疑似未替换的姓名（只在本机界面显示）。 */
  listSuspects: (matterId: string, documentVersionIds: string[], goal?: string) => invoke<{ suspects: SuspectView[]; summary: SendSummaryView }>("matters.suspects.list", { matter_id: matterId, document_version_ids: documentVersionIds, ...(goal ? { goal } : {}) }),
  reviewSuspects: (matterId: string, items: { value: string; decision: "name" | "not_name" }[]) =>
    invoke<{ added_to_parties: number; dismissed: number; rejected: string[] }>("matters.suspects.review", { matter_id: matterId, items }),
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
  interactions: (runId: string) => invoke<{ approvals: ApprovalCard[]; questions: QuestionCard[]; state_version: number | null; live_text?: string | null; progress?: RunProgress | null }>("runs.interactions", { run_id: runId }),
  decide: (runId: string, card: ApprovalCard, body: { decision: "approve" | "reject"; scope?: "once" | "task"; variant?: "original" | "generalized"; feedback?: string }) =>
    invoke<{ ok: true }>("runs.approve", { run_id: runId, approval_id: card.approval_id, object_hash: card.object_hash, nonce: card.nonce, ...body }),
  /** 作答带回界面看到的状态版本（乐观并发：期间有新的提问或决定时须按最新卡片作答）。 */
  answer: (runId: string, questionId: string, answers: Record<string, QuestionAnswer>, expectedStateVersion?: number | null) =>
    invoke<{ ok: true }>("runs.answer", { run_id: runId, question_id: questionId, answers, ...(typeof expectedStateVersion === "number" ? { expected_state_version: expectedStateVersion } : {}) }),

  // 成果
  /** 下载成果（还原真名）：桌面客户端由内核直接写到律师选定的位置（不经浏览器下载、不进“最近使用”）。返回 false = 律师取消。 */
  downloadArtifact: async (artifactVersionId: string, filename: string): Promise<boolean> => {
    const target = await chooseSaveTarget(filename);
    if (target === null) return false;
    const r = await invoke<{ filename: string; sha256: string; data_base64?: string; saved?: boolean }>("artifacts.download", { artifact_version_id: artifactVersionId, ...(target ? { save_handle: target.handle } : {}) });
    if (!target && r.data_base64) browserDownload(r.data_base64, filename, "application/octet-stream");
    return true;
  },
  /** Windows 环境自检（v9.2 §3.7；Y5 P1-6）：只读；Windows 之外为“不适用”。 */
  envProbe: (refresh = false) => invoke<Record<string, any>>("device.env_probe", refresh ? { refresh: true } : {}),
  /** 详细运行记录（v9.2 §3.6）：只记登记的事件代码与计数，开启后 24 小时自动关闭。 */
  setLogLevel: (level: "debug" | "info") => invoke<{ level: string }>("diagnostics.set_log_level", { level }),
  /** 脱敏诊断包（交给支持团队）：内核按白名单生成、导出前自证不含事项内容、设备签名；在本机保存为文件。 */
  exportDiagnostics: async (): Promise<{ filename: string; bytes: number } | null> => {
    const target = await chooseSaveTarget(`kimi-work-legal-diagnostics-${new Date().toISOString().slice(0, 10)}.json`, "none");
    if (target === null) return null;
    const r = await invoke<{ filename: string; data_base64?: string; saved?: boolean; summary: { bytes: number } }>("diagnostics.export", target ? { save_handle: target.handle } : {});
    if (!target && r.data_base64) browserDownload(r.data_base64, r.filename, "application/json");
    return { filename: r.filename, bytes: r.summary.bytes };
  },
  // 召回评测（S8 进所评测；标注规范 v1 §8）：文书与标注只在本机；导出报告由内核重新计算、只含计数
  /** 选择文书或标注文件并读入（桌面客户端经主进程对话框；返回 null = 不是桌面客户端，调用方改用文件输入框）。 */
  evalPick: async (): Promise<{ kind: "annotations" | "text"; docs: EvalDoc[] }[] | null> => {
    if (!window.zrKernel?.pickFiles) return null;
    const picked = (await window.zrKernel.pickFiles({ extensions: ["jsonl", "txt", "md", "docx", "pdf"], multiple: true })) ?? [];
    const out: { kind: "annotations" | "text"; docs: EvalDoc[] }[] = [];
    for (const f of picked) out.push(await invoke("eval.open", { file_handle: f.handle, filename: f.name }));
    return out;
  },
  evalOpenFile: async (file: File) => invoke<{ kind: "annotations" | "text"; docs: EvalDoc[] }>("eval.open", { data_base64: await fileToBase64(file), filename: file.name }),
  evalAgreement: (a: EvalDoc[], b: EvalDoc[]) => invoke<EvalAgreement>("eval.agreement", { a, b }),
  evalAdjudicate: (a: EvalDoc, b: EvalDoc, decisions: { group: number; decision: EvalDecision }[]) =>
    invoke<{ doc: EvalDoc; problems: string[]; undecided: number[]; person_id_conflicts: string[] }>("eval.adjudicate", { a, b, decisions }),
  evalRecall: (docs: EvalDoc[], o: { full_pseudonym?: boolean; case_numbers?: boolean } = {}) =>
    invoke<{ report: { docs: number; with_dictionary: Record<string, any>; rules_only: Record<string, any> }; markdown: string }>("eval.recall", { docs, ...o }),
  /** 保存标注（含原文：提醒律师保存在律所内）。返回 null = 取消。 */
  evalSaveWork: async (docs: EvalDoc[], suggestedName: string): Promise<{ filename: string } | null> => {
    const target = await chooseSaveTarget(suggestedName, "case");
    if (target === null) return null;
    const r = await invoke<{ saved?: boolean; filename?: string; text?: string }>("eval.save_work", { docs, ...(target ? { save_handle: target.handle } : {}) });
    if (!target && r.text) browserDownload(textToBase64(r.text), suggestedName, "application/jsonl");
    return { filename: r.filename ?? suggestedName };
  },
  /** 导出报告（只含计数、比例与区间；内核按文书重新计算生成，界面不提供任何文字）。返回 null = 取消。 */
  evalSaveReport: async (docs: EvalDoc[], o: { full_pseudonym?: boolean; case_numbers?: boolean }, suggestedName: string): Promise<{ filename: string } | null> => {
    const target = await chooseSaveTarget(suggestedName, "none");
    if (target === null) return null;
    const r = await invoke<{ saved?: boolean; filename?: string; text?: string }>("eval.save_report", { docs, ...o, ...(target ? { save_handle: target.handle } : {}) });
    if (!target && r.text) browserDownload(textToBase64(r.text), suggestedName, "text/markdown");
    return { filename: r.filename ?? suggestedName };
  },
  /** “数据去向说明”的示例请求：随包令牌化器现场替换一段虚构句子。 */
  exampleRequest: () => invoke<{ original: string; sent: string; replaced: number; fictional: boolean }>("privacy.example_request", {}),
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
  recentRuns: (limit = 5) =>
    invoke<{ runs: { run_id: string; matter_id: string; matter_title: string; scenario: string; status: string; updated_at: string; goal: string }[]; waiting: { run_id: string; matter_id: string }[] }>("runs.list_recent", { limit }),

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
  quotaStatus: () => invoke<QuotaStatus>("quota.status"),
  // 期限提醒（第 10 批 S9）
  reminders: (matterId?: string) =>
    invoke<{
      cloud: { configured: boolean; last: { at: string; ok: boolean; code: string | null } | null };
      reminders: ReminderItem[];
      inbox: ReminderInboxItem[];
      unread: number;
      rejected: { reason: string; count: number; last_at: string }[];
    }>("reminders.list", matterId ? { matter_id: matterId } : {}),
  remindersUnread: () => invoke<{ unread: number }>("reminders.unread"),
  reminderRetry: (reminderId: string) => invoke<ReminderItem>("reminders.retry", { reminder_id: reminderId }),
  reminderCreate: (input: ReminderInput & { matter_id: string }) => invoke<ReminderItem>("reminders.create", { ...input }),
  reminderUpdate: (reminderId: string, input: ReminderInput) => invoke<ReminderItem>("reminders.update", { reminder_id: reminderId, ...input }),
  reminderCancel: (reminderId: string) => invoke<ReminderItem>("reminders.cancel", { reminder_id: reminderId }),
  remindersMarkRead: (items: { reminder_id: string; version: number }[] | "all") => invoke<{ updated: number }>("reminders.mark_read", items === "all" ? { all: true } : { items }),
  remindersSync: () => invoke<{ local: number; cloud: number; finished: boolean }>("reminders.sync"),
  // 团队事项经中软共享中继同步（第 11 批 S11）
  relayStatus: () => invoke<RelayStatus>("relay.status"),
  relaySync: () => invoke<{ push: RelayReport; pull: RelayReport; status: RelayStatus }>("relay.sync"),
  diagnosticsUploadPreview: () => invoke<SupportPreview>("diagnostics.upload_preview"),
  diagnosticsUploads: () => invoke<{ uploads: { upload_id: string; ticket: string | null; bytes: number; status: "pending" | "sent" | "failed" | "unknown"; error_code: string | null; created_at: string }[] }>("diagnostics.uploads"),
  diagnosticsUpload: (fileSha256: string) => invoke<{ ticket: string; expires_at: string | null; retention_days: number }>("diagnostics.upload", { file_sha256: fileSha256 }),
  quotaSetCap: (cap: number | null) => invoke<{ cap_monthly: number | null }>("quota.set_cap", { monthly_cap: cap }),
  cpAudit: (o: { limit?: number; before_seq?: number } = {}) =>
    invoke<{ mode: string; fetched: { added: number; head: number; withheld: boolean } | null; fetch_error: string | null; records: CpAuditRow[] }>("control_plane.audit", o),
  /** 导出中软侧操作记录（原记录含哈希链，收件人可自行核验；只有代码与编号）。返回 null = 取消。 */
  cpAuditExport: async (): Promise<{ filename: string; count: number } | null> => {
    const target = await chooseSaveTarget(`zr-cloud-operations-${new Date().toISOString().slice(0, 10)}.json`, "none");
    if (target === null) return null;
    const r = await invoke<{ filename: string; count: number; data_base64?: string }>("control_plane.audit_export", target ? { save_handle: target.handle } : {});
    if (!target && r.data_base64) browserDownload(r.data_base64, r.filename, "application/json");
    return { filename: r.filename, count: r.count };
  },
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
  /** 在线内容更新（第 8 批 S6/S7）：法规库与方法模板的来源、序号与最近一次检查。 */
  contentStatus: () => invoke<ContentStatus>("content.status"),
  contentCheck: () => invoke<{ results: ContentCheckResult[]; status: ContentStatus }>("content.check", {}),
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

export interface ContentCheckResult {
  kind: "lawdb" | "skills";
  outcome: "up_to_date" | "installed" | "staged_rollout" | "not_configured" | "unreachable" | "unauthorized" | "stale" | "rejected" | "failed" | "rollback_ignored" | "reverted" | "skipped";
  reason?: string;
  seq?: number;
  version?: string;
  at: string;
  restart_required?: boolean;
  pending_swap?: boolean;
}

export interface ContentStatus {
  configured: boolean;
  channel?: "stable" | "beta";
  lawdb?: { source: "bundled" | "installed"; seq: number; version: string; pending?: { seq: number; version: string } | null; bundled_stamped?: boolean; last_check: ContentCheckResult | null; last_confirmed_at?: string | null };
  skills?: {
    source: "bundled" | "installed" | null;
    seq: number;
    version: string | null;
    pending: { seq: number; version: string } | null;
    revoked_pending_restart?: boolean;
    bundled_stamped?: boolean;
    last_check: ContentCheckResult | null;
    last_confirmed_at?: string | null;
  };
}

/** 共享中继状态（第 11 批 S11；只有计数、时刻与错误代码；发件与收件分别记——复核 S11B-04）。 */
export interface RelayStatus {
  blocked: "not_configured" | "not_allowed" | "exit_mode" | "closed" | null;
  configured: boolean;
  allowed: boolean;
  push_last_ok_at?: string | null;
  push_last_error?: string | null;
  pull_last_ok_at?: string | null;
  pull_last_error?: string | null;
  pending_upload?: number;
  stuck?: number;
  stuck_matters?: number;
  stuck_errors?: string[];
  waiting_key?: number;
  waiting_blob?: number;
  deferred?: number;
  retrying?: number;
  dropped_total?: number;
  matters?: number;
  /** 策略回退（过期、认不出、没收到），不是律所关闭。 */
  policy_fallback?: boolean;
  /** 团队同步的持久告警（两种介质）：纪元冲突、负责人无法确认。 */
  alerts?: { matter_id: string; title: string | null; kind: string; epoch: number; first_at: string; hits: number }[];
}
export interface RelayReport {
  ran: boolean;
  reason?: string;
  exported: number;
  uploaded: number;
  downloaded: number;
  applied: number;
  held: number;
  dropped: number;
  errors: string[];
}
