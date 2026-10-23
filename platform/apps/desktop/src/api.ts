/**
 * 内核 API 客户端（v9 第 04 篇 §3.3：界面只见业务运行时 API；§1.1：渲染进程经主进程 IPC 调用，不直连任何网络地址）。
 * Electron：preload 暴露的 zrKernel.invoke；web 开发：开发桥（127.0.0.1:7720，仅开发，带令牌）。
 */
import { downloadPlan } from "./lib/download.ts";
import { GENERIC_FAILURE } from "./lib/errors.ts";
import { ask } from "./lib/ask.ts";
import type { KernelPreviewCard } from "./lib/accept-preview.ts";

declare global {
  interface Window {
    zrKernel?: {
      invoke: (method: string, params?: Record<string, unknown>) => Promise<any>;
      onEvent?: (cb: (msg: any) => void) => () => void;
      fileHandleFor?: (file: File) => Promise<PickedFile | null>;
      /** 主进程文件对话框（v9.2 §3.7）：只回一次性句柄、文件名与大小。 */
      pickFiles?: (o: { extensions?: string[]; multiple?: boolean }) => Promise<PickedFile[] | null>;
      pickSave?: (o: { name: string }) => Promise<{ handle: string; name: string; risk: SaveRisk | null } | null>;
      /** 选文件夹（第 14 批：备份位置、从备份恢复）。 */
      pickFolder?: () => Promise<{ handle: string; name: string; risk: SaveRisk | null } | null>;
      saveText?: (handle: string, text: string) => Promise<{ ok: boolean; name?: string }>;
      /** 用系统默认程序打开刚保存的成果（v9.4 第 21 批）。 */
      openSaved?: (handle: string) => Promise<{ ok: boolean; reason?: string }>;
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
    if (await ask({ title: "保存位置提示", body: `${SAVE_PLACE[s.risk]}：${what}。`, yes: "仍保存在这里", no: "换一个位置" })) return s;
  }
  return null;
}

/**
 * 材料的常见扩展名（选择对话框的过滤器）。旧版 Word / WPS / Excel 与 RTF 也让选（B-11）：选了会逐个告诉律师“请另存为 docx / xlsx 再导入”，
 * 而不是在对话框里看不见、以为文件丢了。
 */
export const MATERIAL_EXTENSIONS = ["docx", "pdf", "txt", "md", "png", "jpg", "jpeg", "xlsx", "csv", "doc", "wps", "xls", "et", "rtf"];
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

const BRIDGE = `http://127.0.0.1:${(import.meta as any).env?.VITE_KWL_BRIDGE_PORT ?? "7720"}/invoke`;
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
  if (!data.ok) throw new KernelError(data.error?.message ?? GENERIC_FAILURE, data.error?.code ?? "internal", data.error?.detail);
  return data.result as T;
}

/** 自动更新（W7，只在安装包形态启用）：状态与“重启并安装”。 */
export const updates = {
  status: async (): Promise<UpdateStatus | null> => (window.zrKernel?.updateStatus ? window.zrKernel.updateStatus() : null),
  install: async (): Promise<{ ok: boolean; reason?: string }> => (window.zrKernel?.installUpdate ? window.zrKernel.installUpdate() : { ok: false }),
};

/** 订阅内核广播（Electron）；web 开发桥只推问答的部分回答（chat.delta），其余调用方自行轮询。 */
export function onKernelEvent(cb: (msg: any) => void): () => void {
  if (window.zrKernel?.onEvent) return window.zrKernel.onEvent(cb);
  if (window.zrKernel) return () => {};
  devListeners.add(cb);
  openDevEvents();
  return () => devListeners.delete(cb);
}

/** web 开发形态：开发桥 GET /events（逐行 JSON），全页共用一条连接；断开后下次订阅时重连。 */
const devListeners = new Set<(msg: any) => void>();
let devEventsOpen = false;
function openDevEvents(): void {
  if (devEventsOpen) return;
  devEventsOpen = true;
  void (async () => {
    try {
      const res = await fetch(BRIDGE.replace(/\/invoke$/, "/events"), { headers: BRIDGE_TOKEN ? { "x-kwl-token": BRIDGE_TOKEN } : {} });
      const reader = res.body?.getReader();
      if (!res.ok || !reader) return;
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let msg: unknown;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          for (const l of devListeners) l(msg);
        }
      }
    } catch {
      // 开发桥未启动或已断开：不推送，调用方照常拿最终结果
    } finally {
      devEventsOpen = false;
    }
  })();
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
  /** 程序阶段、事件时点（YYYY-MM-DD 或 YYYY-MM）、地域（v9.4 S-08，律师填写）。 */
  stage?: string | null;
  event_date?: string | null;
  region?: string | null;
  /** 新建事项时选的事项类型（v9.4 第 22 批）：概览里据此给“推荐的方法”。 */
  template_id?: string | null;
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

/** 事项待办（v9.4 第 20 批，C1 §3.2）。 */
export interface TodoInput {
  title: string;
  assignee_kind: "me" | "assistant" | "colleague" | "ai";
  assignee_name?: string | null;
  reviewer_name?: string | null;
  due_date?: string | null;
}
export interface TodoRow extends TodoInput {
  todo_id: string;
  status: "open" | "done";
  created_at: string;
  done_at: string | null;
}
export interface DerivedTodo {
  kind: "run_waiting" | "drafts_to_review" | "to_sign";
  goal: string;
  scenario: string | null;
  filename: string | null;
  done_by_ai: boolean;
  run_id: string | null;
  artifact_version_id: string | null;
  count: number;
  at: string;
}
export interface TodoList {
  open: TodoRow[];
  done: TodoRow[];
  derived: DerivedTodo[];
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
  /** 为什么要问我（机制说明，折叠显示；Z3 评审 3.3）。 */
  why_detail?: string;
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

export interface DocStyleView {
  letterhead: "auto" | "custom" | "none";
  letterhead_name: string | null;
  letterhead_lines: string[];
  effective_letterhead: string | null;
  body: "song-xiaosi" | "fangsong-san";
  page_numbers: boolean;
  /** Word 修订里显示的作者名（v9.4 第 22 批）；空 = 缺省“律师审定（Kimi Work 辅助起草）”。 */
  redline_author: string | null;
  template: { name: string; sha256: string; updated_at: string; header_text: string; footer_text: string; looks_case_specific: boolean } | null;
}

/** 事项模板（v9.4 第 22 批，内核 services/matter-templates.ts）。 */
export interface MatterTemplate {
  id: string;
  title: string;
  line: "litigation" | "transactional" | "inhouse";
  hint: string;
  stances: string[];
  stage: string | null;
  todos: { title: string }[];
  scenarios: string[];
  start_fact?: { label: string; start_key: string; deadline_key: string; period: { unit: string; n: number }; todo: string; basis: string };
}

/** 本事项的审查要点（v9.4 第 22 批，内核 services/review-rules.ts）。 */
export interface ReviewRule {
  no: number;
  topic: string;
  standard: string;
  fallback: string | null;
  red_line: string | null;
}
export interface RuleSet {
  rule_set_id: string;
  version: number | null;
  title: string;
  rules: ReviewRule[];
  status: "active" | "superseded" | "retired" | "draft";
  source: "lawyer" | "ai_draft";
  run_id: string | null;
  from_run_id?: string | null;
  created_at: string;
}
export interface RuleSets {
  active: RuleSet | null;
  drafts: RuleSet[];
  history: RuleSet[];
}

/** 我的写作偏好（v9.4 第 22 批）：只存格式与文风。 */
export interface WritingPrefs {
  signature: string | null;
  citation: "full" | "short" | null;
  notes: string | null;
}

/** 材料初判（v9.4 第 22 批）：本机按规则判断，只做建议。 */
export interface MaterialTriage {
  document_version_id: string;
  kind: string;
  label: string;
  contract_type: string | null;
  chars: number;
  pages: number | null;
  size: "short" | "medium" | "long";
}

export interface ChatMessage {
  message_id: string;
  role: "user" | "assistant" | "notice";
  text: string;
  created_at: string;
  /** 回答里的引用离线核对结果（B-6）；没有引用时不带。 */
  citations?: import("./lib/qa-citations.ts").QaCitationsView;
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
  installSample: (kind?: "litigation") => invoke<{ matter_id: string | null; matter_ids?: string[]; installed: boolean }>("samples.install", kind ? { kind } : {}),
  sampleStatus: () => invoke<{ installed: boolean; removed: boolean; matter_ids: string[]; litigation_offered: boolean }>("samples.status", {}),
  removeSample: (matterId: string) => invoke<{ removed: boolean }>("samples.remove", { matter_id: matterId }),
  createMatter: (body: Record<string, unknown>) =>
    invoke<{ matter: Matter; template_applied?: { template_id: string; todos: number; deadline: { date: string; steps: string[]; warnings: string[]; uncertain: boolean } | null; stance_mismatch?: boolean } }>("matters.create", body),
  matterTemplates: () => invoke<{ templates: MatterTemplate[] }>("matters.templates"),
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
  startRun: (matterId: string, body: { estimate_id: string; idempotency_key: string; goal?: string; topic_hint?: string; mode?: RunMode; plan_first?: boolean; preauthorizations?: Preauthorization[]; skill?: string; skill_args?: Record<string, string>; review_rules?: boolean; followup_of?: string; mode_raise_confirmed?: boolean }) =>
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
  /** 下载成果（Markdown 成果下载成套好版式的 Word，见 lib/download.ts）；返回 false = 律师取消。 */
  /**
   * 在 Word / WPS 中打开（v9.4 第 21 批，主文 §3.2）：先存到律师选定的位置，再用系统默认程序打开那一份；给了要定位的一句话时复制到剪贴板，
   * 在 Word 里按 Ctrl+F（Mac 为 ⌘F）粘贴即可跳到那里。开发形态（浏览器）只能下载，返回 opened=false。
   */
  openArtifactInOffice: async (artifactVersionId: string, filename: string, find?: string): Promise<{ saved: boolean; opened: boolean; copied: boolean }> => {
    const plan = downloadPlan(filename);
    const target = await chooseSaveTarget(plan.saveName);
    if (target === null) return { saved: false, opened: false, copied: false };
    const r = await invoke<{ filename: string; data_base64?: string; saved?: boolean; open_handle?: string }>("artifacts.download", { artifact_version_id: artifactVersionId, ...(plan.as ? { as: plan.as } : {}), ...(target ? { save_handle: target.handle } : {}) });
    if (!target && r.data_base64) browserDownload(r.data_base64, r.filename, "application/octet-stream");
    let copied = false;
    if (find?.trim()) {
      try {
        await navigator.clipboard.writeText(find.trim());
        copied = true;
      } catch {
        copied = false;
      }
    }
    const opened = !!(r.open_handle && window.zrKernel?.openSaved && (await window.zrKernel.openSaved(r.open_handle)).ok);
    return { saved: true, opened, copied };
  },
  downloadArtifact: async (artifactVersionId: string, filename: string): Promise<boolean> => {
    const plan = downloadPlan(filename);
    const target = await chooseSaveTarget(plan.saveName);
    if (target === null) return false;
    const r = await invoke<{ filename: string; sha256: string; data_base64?: string; saved?: boolean }>("artifacts.download", { artifact_version_id: artifactVersionId, ...(plan.as ? { as: plan.as } : {}), ...(target ? { save_handle: target.handle } : {}) });
    if (!target && r.data_base64) browserDownload(r.data_base64, r.filename, "application/octet-stream");
    return true;
  },
  // 文书版式（B-4）：本机导出 Word 的函头、字体字号、页码与律所模板
  docStyle: () => invoke<DocStyleView>("doc_style.get"),
  setDocStyle: (body: Partial<Pick<DocStyleView, "letterhead" | "letterhead_name" | "letterhead_lines" | "body" | "page_numbers" | "redline_author">>) => invoke<DocStyleView>("doc_style.set", body),
  writingPrefs: () => invoke<WritingPrefs>("writing_prefs.get"),
  setWritingPrefs: (body: Partial<WritingPrefs>) => invoke<WritingPrefs>("writing_prefs.set", body),
  /** 上传律所 Word 模板：桌面客户端经系统对话框；开发形态退回文件输入框传字节。返回 null = 取消。 */
  setDocTemplate: async (fallback?: File | null): Promise<DocStyleView | null> => {
    if (window.zrKernel?.pickFiles) {
      const f = ((await window.zrKernel.pickFiles({ extensions: ["dotx", "docx"], multiple: false })) ?? [])[0];
      if (!f) return null;
      return invoke<DocStyleView>("doc_style.set_template", { file_handle: f.handle, filename: f.name });
    }
    if (!fallback) return null;
    const data_base64 = btoa(Array.from(new Uint8Array(await fallback.arrayBuffer()), (b) => String.fromCharCode(b)).join(""));
    return invoke<DocStyleView>("doc_style.set_template", { data_base64, filename: fallback.name });
  },
  clearDocTemplate: () => invoke<DocStyleView>("doc_style.clear_template"),
  /** 样张按面板上当前的选项生成（还没保存也行，复核 R15B-22）。 */
  downloadDocStyleSample: async (draft?: Partial<Pick<DocStyleView, "letterhead" | "letterhead_name" | "letterhead_lines" | "body" | "page_numbers">>): Promise<boolean> => {
    const target = await chooseSaveTarget("文书版式样张.docx");
    if (target === null) return false;
    const r = await invoke<{ filename: string; data_base64?: string }>("doc_style.sample", { ...(draft ? { draft } : {}), ...(target ? { save_handle: target.handle } : {}) });
    if (!target && r.data_base64) browserDownload(r.data_base64, r.filename, "application/octet-stream");
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
  /** 律师改风险卡的性质（复核 RB16B-03）。 */
  setRiskCardNature: (matterId: string, cardId: string, nature: "must" | "should" | "negotiable") => invoke<{ card: RiskCard }>("riskcards.set_nature", { matter_id: matterId, card_id: cardId, nature }),
  /** level：接受时选用哪一级（C-05；缺省首选，可退让须卡上有）。 */
  decideRiskCard: (matterId: string, cardId: string, decision: "accept" | "modify" | "reject" | "reset", finalText?: string, level?: "suggestion" | "fallback") =>
    invoke<{ card: RiskCard }>("riskcards.decide", { matter_id: matterId, card_id: cardId, decision, ...(finalText ? { final_text: finalText } : {}), ...(level ? { level } : {}) }),
  /** “接受后”预览：与生成修订稿同一套定位（只读，余项续复核 RC-B-01）。 */
  previewRedline: (matterId: string, documentVersionId: string, o: { run_id?: string } = {}) =>
    invoke<{ status: "ok" | "conflicts" | "not_docx" | "document_version_superseded" | "no_patches"; paragraphs: string[]; cards: KernelPreviewCard[] }>("riskcards.preview_redline", { matter_id: matterId, document_version_id: documentVersionId, ...o }),
  /** audience：对外版只有修订、内部版另带批注（C1 §2.2 第 6 条）。 */
  buildRedline: (matterId: string, documentVersionId: string, o: { run_id?: string; skip_card_ids?: string[]; audience?: "external" | "internal" } = {}) =>
    invoke<
      | { status: "applied"; artifact_version_id: string; filename: string; applied: number; skipped: string[]; no_insert_point?: string[] }
      | { status: "preview"; reason: string; conflicts: { index: number; reason: string; detail?: string; card_id: string | null }[]; skipped: string[]; no_insert_point?: string[] }
    >("riskcards.redline", { matter_id: matterId, document_version_id: documentVersionId, ...o }),
  /** 导出审查意见表（Excel 草稿成果，C1 §2.2 第 8 条）。 */
  exportReviewTable: (matterId: string, documentVersionId: string | null, o: { run_id?: string; format?: "xlsx" | "docx" } = {}) =>
    invoke<{ artifact_version_id: string; filename: string; rows: number }>("riskcards.export_table", { matter_id: matterId, document_version_id: documentVersionId, ...o }),
  /** 表格审阅（C-01）：建表、读表、逐格核、导出。 */
  tableTemplates: () => invoke<{ templates: { id: string; title: string; line: string; columns: import("./lib/table-review.ts").TableColumnView[] }[] }>("tables.templates"),
  tables: (matterId: string) => invoke<{ tables: import("./lib/table-review.ts").TableView[] }>("tables.list", { matter_id: matterId }),
  createTable: (matterId: string, body: { template: string; columns: string[]; document_version_ids: string[]; title?: string }) =>
    invoke<{ table: import("./lib/table-review.ts").TableView }>("tables.create", { matter_id: matterId, ...body }),
  table: (matterId: string, tableId: string) =>
    invoke<{ table: import("./lib/table-review.ts").TableView; cells: import("./lib/table-review.ts").CellView[]; docs: { document_version_id: string; filename: string }[] }>("tables.get", { matter_id: matterId, table_id: tableId }),
  decideCell: (matterId: string, tableId: string, body: { cell_id?: string; document_version_id?: string; column?: string; decision: "verify" | "edit" | "reset"; value?: string; expected_updated_at?: string }) =>
    invoke<{ cell: import("./lib/table-review.ts").CellView }>("tables.decide_cell", { matter_id: matterId, table_id: tableId, ...body }),
  exportTable: (matterId: string, tableId: string) => invoke<{ artifact_version_id: string; filename: string; rows: number }>("tables.export", { matter_id: matterId, table_id: tableId }),
  // 表格审阅残余（v9.4 第 20 批，C1 §3.3）
  tableAddColumn: (matterId: string, tableId: string, body: { label: string; hint: string; format: string; options?: string[]; when?: { column: string; equals: string } }) =>
    invoke<{ table: import("./lib/table-review.ts").TableView }>("tables.add_column", { matter_id: matterId, table_id: tableId, ...body }),
  tableRemoveColumn: (matterId: string, tableId: string, column: string, confirm = false) => invoke<{ table: import("./lib/table-review.ts").TableView }>("tables.remove_column", { matter_id: matterId, table_id: tableId, column, confirm }),
  tableCellContext: (matterId: string, tableId: string, cellId: string) =>
    invoke<{ located: boolean; before: string; quote: string; after: string; filename: string }>("tables.cell_context", { matter_id: matterId, table_id: tableId, cell_id: cellId }),
  tablePushFacts: (matterId: string, tableId: string) => invoke<{ pushed: number; already: number; not_verified: number }>("tables.push_facts", { matter_id: matterId, table_id: tableId }),
  tableDraft: (matterId: string, tableId: string) => invoke<{ artifact_version_id: string; filename: string; open: number }>("tables.draft", { matter_id: matterId, table_id: tableId }),
  tableReminderCandidates: (matterId: string, tableId: string) =>
    invoke<{ candidates: { document_version_id: string; filename: string; column: string; label: string; date: string | null; verified: boolean; note: string }[] }>("tables.reminder_candidates", { matter_id: matterId, table_id: tableId }),
  // 工作台残余（v9.4 第 20 批，C1 §2.2）
  decideRiskBatch: (matterId: string, cardIds: string[], action: "accept" | "undo", batch?: string) =>
    invoke<{ batch: string; accepted: string[]; refused: string[]; undone: string[] }>("riskcards.decide_batch", { matter_id: matterId, card_ids: cardIds, action, ...(batch ? { batch } : {}) }),
  counterChanges: (matterId: string, documentVersionId: string, o: { run_id?: string; baseline_document_version_id?: string } = {}) =>
    invoke<
      | { available: false }
      | { available: true; baseline_document_version_id: string; baseline_filename: string; stats: { added: number; deleted: number; modified: number; silent: number }; changes: { index: number; type: "added" | "deleted" | "modified"; silent: boolean; base_text: string; cur_text: string; card_ids: string[] }[] }
    >("riskcards.counter_changes", { matter_id: matterId, document_version_id: documentVersionId, ...o }),
  rejectMissing: (matterId: string, cardId: string, term?: string) => invoke<{ card: RiskCard; remembered: string | null }>("riskcards.reject_missing", { matter_id: matterId, card_id: cardId, ...(term ? { term } : {}) }),
  /** 起草前的论点与依据（C-04）：任务页逐条确认。 */
  outlines: (matterId: string, runId: string) => invoke<{ outlines: import("./lib/outline.ts").OutlineView[] }>("outlines.list", { matter_id: matterId, run_id: runId }),
  decideOutline: (matterId: string, outlineId: string, decisions: { arg_id: string; keep: boolean; claim?: string; basis_keep?: number[] }[], note: string) =>
    invoke<{ outline: import("./lib/outline.ts").OutlineView }>("outlines.decide", { matter_id: matterId, outline_id: outlineId, decisions, ...(note ? { note } : {}) }),
  // 论断—依据（v9.4 第 20 批 C-03）
  artifactCitations: (artifactVersionId: string) =>
    invoke<{ citations: import("./lib/citation-review.ts").ArtifactCitations | null; facts?: import("./lib/citation-review.ts").FactMarkView[] }>("artifacts.citations", { artifact_version_id: artifactVersionId }),
  decideCitation: (artifactVersionId: string, citeKey: string, decision: "supported" | "unsupported" | "acknowledged" | null) =>
    invoke<{ citations: import("./lib/citation-review.ts").ArtifactCitations | null }>("citations.decide", { artifact_version_id: artifactVersionId, cite_key: citeKey, decision }),
  todos: (matterId: string) => invoke<TodoList>("todos.list", { matter_id: matterId }),
  reviewRules: (matterId: string) => invoke<RuleSets>("review_rules.get", { matter_id: matterId }),
  saveReviewRules: (matterId: string, body: { title: string; rules: Omit<ReviewRule, "no">[]; base_version: number | null; from_draft?: string }) => invoke<RuleSets & { saved: RuleSet }>("review_rules.save", { matter_id: matterId, ...body }),
  retireReviewRules: (matterId: string, baseVersion: number | null) => invoke<RuleSets>("review_rules.retire", { matter_id: matterId, base_version: baseVersion }),
  discardRulesDraft: (matterId: string, ruleSetId: string) => invoke<RuleSets>("review_rules.discard_draft", { matter_id: matterId, rule_set_id: ruleSetId }),
  materialTriage: (matterId: string) => invoke<{ items: MaterialTriage[] }>("materials.triage", { matter_id: matterId }),
  pendingChecks: (matterId: string) => invoke<{ checks: PendingCheck[]; total: number }>("matters.pending_checks", { matter_id: matterId }),
  createTodo: (matterId: string, body: TodoInput) => invoke<{ todo: TodoRow }>("todos.create", { matter_id: matterId, ...body }),
  updateTodo: (matterId: string, todoId: string, patch: Partial<TodoInput> & { done?: boolean }) => invoke<{ todo: TodoRow }>("todos.update", { matter_id: matterId, todo_id: todoId, patch }),
  deleteTodo: (matterId: string, todoId: string) => invoke<{ ok: true }>("todos.delete", { matter_id: matterId, todo_id: todoId }),
  facts: (matterId: string, f: { run_id?: string; status?: "proposed" | "confirmed" | "rejected" } = {}) => invoke<{ facts: FactRow[] }>("facts.list", { matter_id: matterId, ...f }),
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
  /** 全局搜索（余项续复核 RC-A-05、RC-B-06/07）：内核里按标题找，只返回命中的几条。 */
  searchTitles: (q: string, labels: Record<string, string>) =>
    invoke<{
      matters: { matter_id: string; title: string; sub: string; last_at: string | null }[];
      runs: { run_id: string; matter_id: string; matter_title: string; scenario: string; skill: string | null; goal: string; updated_at: string }[];
      deliverables: { artifact_version_id: string; matter_id: string; matter_title: string; kind: string; version: number; filename: string; title: string | null; created_at: string }[];
      truncated: { runs: boolean; deliverables: boolean };
    }>("search.titles", { q, labels }),
  recentRuns: (limit = 5) =>
    invoke<{ runs: { run_id: string; matter_id: string; matter_title: string; scenario: string; status: string; updated_at: string; goal: string; skill?: string | null }[]; waiting: { run_id: string; matter_id: string }[] }>("runs.list_recent", { limit }),

  // 数据去向
  egressRecords: (args: { runId?: string; matterId?: string }) => invoke<{ records: EgressRecord[] }>("egress.records", args.runId ? { run_id: args.runId } : { matter_id: args.matterId }),
  egressSummary: (runId: string) => invoke<EgressSummary>("egress.summary", { run_id: runId }),
  /** 结果不明的出站（预写后中断，待人工对账；阶段 4 复核 S4-21）。 */
  egressUnresolved: (matterId?: string) => invoke<{ records: any[] }>("egress.unresolved", matterId ? { matter_id: matterId } : {}),
  egressReconcile: (recordId: string, resolution: "confirmed_sent" | "not_sent" | "unknown") => invoke("egress.reconcile", { record_id: recordId, resolution }),

  // 问答（无事项）
  chatList: () => invoke<{ conversations: { conversation_id: string; title: string; updated_at: string }[] }>("chat.list"),
  chatGet: (conversationId: string) => invoke<{ conversation_id: string; messages: ChatMessage[] }>("chat.get", { conversation_id: conversationId }),
  /** stream_id：本次发送的一次性编号，回答生成中的部分内容以 chat.delta 广播推送（onKernelEvent）。 */
  chatSend: (body: { conversation_id?: string; text: string; stream_id?: string }) =>
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
  /** 按法定期间推算届满日（v9.4 第 20 批；内核 calc.deadline 同一计算）。 */
  computeDeadline: (start: string, period: { unit: "day" | "month" | "year" | "workday"; n: number }, rule: "civil" | "workday" = "civil") =>
    invoke<{ deadline: string | null; range: { earliest: string; latest: string } | null; steps: string[]; warnings?: string[] }>("deadlines.compute", { start, period, rule }),
  reminderCreate: (input: ReminderInput & { matter_id: string }) => invoke<ReminderItem>("reminders.create", { ...input }),
  reminderUpdate: (reminderId: string, input: ReminderInput) => invoke<ReminderItem>("reminders.update", { reminder_id: reminderId, ...input }),
  reminderCancel: (reminderId: string) => invoke<ReminderItem>("reminders.cancel", { reminder_id: reminderId }),
  remindersMarkRead: (items: { reminder_id: string; version: number }[] | "all") => invoke<{ updated: number }>("reminders.mark_read", items === "all" ? { all: true } : { items }),
  remindersSync: () => invoke<{ local: number; cloud: number; finished: boolean }>("reminders.sync"),
  // 团队事项经中软共享中继同步（第 11 批 S11）
  relayStatus: () => invoke<RelayStatus>("relay.status"),
  relaySync: () => invoke<{ push: RelayReport; pull: RelayReport; status: RelayStatus }>("relay.sync"),
  // 成员链（第 12 批）：本机重新引导该事项；中继控制成员移交
  matterSyncRebootstrap: (matterId: string) => invoke<{ matter_id: string; note: string }>("matters.sync_rebootstrap", { matter_id: matterId }),
  matterRelayHandoff: (matterId: string, toUser: string) => invoke<{ matter_id: string; controller: string; note: string }>("matters.relay_handoff", { matter_id: matterId, to_user: toUser }),
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
  /** 原件页码（只有按页解析的材料，如 PDF；Word 没有）。 */
  page?: number;
  anchor_text: string;
  anchor_status: "located" | "ambiguous" | "not_found" | "no_document" | "cross_paragraph";
  anchor_start: number | null;
  severity: "high" | "mid" | "low";
  category: "legal" | "commercial" | "both";
  issue: string;
  basis: { law: string; article: number | null; note: string | null; check: string; matched: string | null }[];
  /** 首选。 */
  suggestion: string | null;
  /** 可退让。 */
  fallback: string | null;
  /** 底线（Astra M-1）。 */
  bottom_line?: string | null;
  /** 建议的性质（Astra M-1）：must 必须修改 / should 建议修改 / negotiable 可谈判。 */
  nature?: "must" | "should" | "negotiable";
  /** 性质是按类别推定的（Agent 没给、律师也没改过）。 */
  nature_inferred?: boolean;
  needs_client_decision: boolean;
  assumptions: string | null;
  /** 类型（C-02）：风险 / 缺失 / 偏离规则 / 前后不一致；旧内核没给时按风险。 */
  kind?: "risk" | "missing" | "deviation" | "consistency";
  /** 判断依据来源：法律强制 / 本所或客户规则 / 通用建议；本批之前的卡为空。 */
  rule_source?: "law" | "firm_rule" | "general" | null;
  rule_ref?: string | null;
  /** 卡片引用的本事项审查要点（v9.4 第 22 批）：任务发起时那一版的要点原文。 */
  rule_text?: { version: number; title: string } & ReviewRule;
  /** 缺失卡：查过的说法与文件；材料里其实找得到的说法（非空即可能误报）。 */
  searched_terms?: string[];
  searched_docs?: string[];
  searched_found?: { term: string; filename: string }[];
  /** 跨文件审查（v9.4 第 21 批）：本卡引用的同一事项其他文件原文（补充协议、附件等）。 */
  related?: { document_version_id: string; filename: string; quote: string; relation: "amends" | "conflicts" | "refers"; anchor_status: string; quarantined?: boolean }[];
  /** 锚点在 Word 表格里时的位置（“表 2 第 3 行第 2 列（单价）”）。 */
  cell?: string;
  /** 接受时选用的一级（C-05）。 */
  chosen_level?: "suggestion" | "fallback";
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
  /** 引文在原件里的页码（按页解析的材料；v9.4 第 22 批）。 */
  page?: number;
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
  /** 成员链自动处置最近一次失败的原因（第 12 批）。 */
  chain_last_error?: string | null;
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
  alerts?: { matter_id: string; title: string | null; kind: string; epoch: number; first_at: string; hits: number; peer_member: string | null; peer_name?: string | null }[];
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

/** 开通与成员入组（第 13 批）：待激活模式下只有这几个方法可用。 */
export const onboarding = {
  status: () => invoke<any>("onboarding.status"),
  redeem: (code: string) => invoke<any>("onboarding.redeem", { code }),
  check: () => invoke<any>("onboarding.check"),
  reset: () => invoke<any>("onboarding.reset"),
  /** 从备份恢复（第 14 批）：安装包形态传句柄；开发形态（无对话框）传路径。 */
  restore: (o: { file_handle?: string; folder_handle?: string; file?: string; dir?: string; code: string; legacy_ack?: boolean; older_ack?: boolean }) => invoke<any>("onboarding.restore", o),
};

/** 恢复包与备份（第 14 批）：安装包形态经系统对话框拿句柄；开发形态（浏览器）没有对话框，界面让开发者填路径。 */
export const recovery = {
  hasDialogs: () => !!window.zrKernel?.pickFolder,
  pickFolder: () => window.zrKernel?.pickFolder?.() ?? Promise.resolve(null),
  pickPackageFile: async () => ((await window.zrKernel?.pickFiles?.({ extensions: ["kwlr"], multiple: false })) ?? [])[0] ?? null,
  pickPackageSave: () => window.zrKernel?.pickSave?.({ name: "Kimi Work 恢复包.kwlr" }) ?? Promise.resolve(null),
  createPackage: (o: { save_handle?: string; path?: string }) => invoke<any>("recovery.create_package", o),
  verifyPackage: (o: { file_handle?: string; file?: string; code: string }) => invoke<any>("recovery.verify_package", o),
  backupStatus: () => invoke<any>("backup.status"),
  configureBackup: (o: { folder_handle?: string; dir?: string }) => invoke<any>("backup.configure", o),
  runBackup: () => invoke<any>("backup.run"),
};

/** 成员管理（管理员）：邀请、待批准申请、批准与拒绝。 */
export const members = {
  list: () => invoke<any>("members.list"),
  /** 侧栏提醒：有几份入组申请等这台电脑批准（内核 60 秒内复用上次结果）。 */
  attention: () => invoke<{ pending_joins: number }>("members.attention"),
  invite: (name: string, role: string) => invoke<any>("members.invite", { name, role }),
  approve: (joinRequestId: string) => invoke<any>("members.approve", { join_request_id: joinRequestId }),
  reject: (joinRequestId: string) => invoke<any>("members.reject", { join_request_id: joinRequestId }),
  revokeInvitation: (activationId: string) => invoke<any>("members.revoke_invitation", { activation_id: activationId }),
  // 成员离所（B-10）：成员列表、移出前提醒、移出律所（停用全部电脑 + 释放席位）、停用一台电脑
  roster: () => invoke<{ members: RosterMember[]; can_remove: boolean }>("members.roster"),
  removalPreview: (memberId: string) => invoke<{ member_id: string; name: string | null; is_me: boolean; active_devices: number; matters: { matter_id: string; title: string; relay_controller: boolean }[] }>("members.removal_preview", { member_id: memberId }),
  remove: (memberId: string) => invoke<{ devices_revoked: number; seat_released: boolean; note: string }>("members.remove", { member_id: memberId }),
  revokeDevice: async (deviceId: string) => {
    const r = await invoke<{ note: string; lawyer_note?: string }>("devices.revoke", { device_id: deviceId, reason: "管理员停用这台电脑" });
    return { note: r.lawyer_note ?? r.note };
  },
  departedInMatters: () => invoke<{ items: { matter_id: string; title: string; user_id: string; name: string | null; removed_from_firm: boolean }[] }>("members.departed_in_matters"),
  removeDepartedFromMatter: (matterId: string, userId: string) => invoke<{ note: string }>("matters.members.remove", { matter_id: matterId, user_id: userId, confirm_departed: true }),
  // 本人离所交接：清单与“交给同事”
  offboarding: () => invoke<{ matters: OffboardingItem[]; pending: number; personal?: { writing_prefs: boolean } }>("members.offboarding"),
  // 离所时清除本人在这台电脑上的个人设置（写作偏好；复核 Q4 建议 3）
  offboardClearPersonal: () => invoke<{ cleared: { writing_prefs: number }; note: string }>("members.offboard_clear_personal"),
  offboardHandoff: (matterId: string, toUser: string) => invoke<{ relay: "done" | "not_needed" | "pending"; owner_set: boolean; note: string; item: OffboardingItem }>("members.offboard_handoff", { matter_id: matterId, to_user: toUser }),
};

export interface RosterMember {
  member_id: string;
  name: string | null;
  role: string;
  is_me: boolean;
  /** removed：走过“移出律所”；devices_stopped：电脑都停用了但没移出（席位还占着）。 */
  status: "active" | "removed" | "devices_stopped";
  joined_at: string;
  devices: { device_id: string; status: string; created_at: string; revoked_at: string | null; this_device: boolean }[];
  removal: { removed_at: string; seat_released: boolean; seat_error: string | null } | null;
}

export interface OffboardingItem {
  matter_id: string;
  title: string;
  scope: "personal" | "team";
  status: "ok" | "needs_archive" | "needs_owner" | "needs_handoff";
  closed?: boolean;
  colleagues: { user_id: string; name: string | null; role: string }[];
  archived_at?: string | null;
  relay_controller?: boolean;
}

/** 统一待核清单的一项（v9.4 第 21 批，主文 §6.4）：还等律师做什么、去哪里做。 */
export interface PendingCheck {
  kind: "facts" | "table_cells" | "risk_cards" | "outlines" | "open_items" | "citations";
  count: number;
  text: string;
  target: { tab: "facts" } | { tab: "materials"; view: "table"; table_id: string } | { workbench: string | null } | { run_id: string } | { artifact_version_id: string };
}
