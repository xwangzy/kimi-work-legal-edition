/**
 * 内核 API 客户端（v9 第 04 篇 §3.3：界面只见业务运行时 API；§1.1：渲染进程经主进程 IPC 调用，不直连任何网络地址）。
 * Electron：preload 暴露的 zrKernel.invoke；web 开发：开发桥（127.0.0.1:7720，仅开发，带令牌）。
 */
import { downloadPlan } from "./lib/download.ts";
import { GENERIC_FAILURE } from "./lib/errors.ts";
import { ask } from "./lib/ask.ts";
import type { KernelPreviewCard } from "./lib/accept-preview.ts";
import type { AccountDevice, AccountSession, RegistrationMeta, SmsPurpose } from "./lib/account.ts";

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
      /** 把 Word 成果导出成 PDF（第 29 批）：主进程选位置、打印、写文件。 */
      exportPdf?: (artifactVersionId: string) => Promise<{ ok: boolean; name?: string; open_handle?: string; canceled?: boolean; reason?: string }>;
      rendererNet?: () => Promise<{ blocked: number; last: string[] }>;
      updateStatus?: () => Promise<UpdateStatus | null>;
      installUpdate?: () => Promise<{ ok: boolean; reason?: string }>;
      platform?: string;
      /** 第 64 批：无边框窗口（界面顶部自绘拖动条）。 */
      frameless?: boolean;
      /** 界面明暗变了：Windows 窗口控件浮层跟着换色。 */
      setWindowTheme?: (theme: "light" | "dark") => void;
    };
  }
}

/** 第 64 批：无边框窗口要用的 preload 接口（是否无边框、平台、给 Windows 窗口控件浮层换色）；渲染层只经这里接触 preload。 */
export function windowBridge(): { zrKernel?: { frameless?: boolean; platform?: string; setWindowTheme?: (t: "light" | "dark") => void } } {
  const k = window.zrKernel;
  return k ? { zrKernel: { ...(k.frameless !== undefined ? { frameless: k.frameless } : {}), ...(k.platform !== undefined ? { platform: k.platform } : {}), ...(k.setWindowTheme ? { setWindowTheme: k.setWindowTheme } : {}) } } : {};
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

const BRIDGE = (import.meta as any).env?.DEV ? `http://127.0.0.1:${(import.meta as any).env?.VITE_KWL_BRIDGE_PORT ?? "7720"}/invoke` : "";
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
  // 开发桥只在开发形态（vite 开发服务）存在；生产构建里这段整体被剔除（第 62 批发布配置核对 §1：不在安装包里留开发桥地址）
  if (!(import.meta as any).env?.DEV) throw new KernelError("应用后台接口不可用，请关闭后重新打开应用", "kernel_unavailable");
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
  if (devEventsOpen || !BRIDGE) return;
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
/** AI 次处理者清单（内核常量，带版本；客户授权记录时一并留痕）。 */
export interface AiSubprocessors {
  version: string;
  items: { name: string; role: string }[];
}
export interface AiAuthorization {
  engagement_terms: boolean;
  default_ref?: string | null;
  updated_at: string | null;
  subprocessors?: AiSubprocessors;
}

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
  /** 四项依据怎么记下的（第 48 批）：按委托合同条款（律师的默认设置）/ 律师在本事项确认 / 逐项或旧事项（null）。 */
  /** 四项依据怎么记下的（第 51 批，D-216）：委托合同中的 AI 条款 / 客户单独书面同意 / 旧记录（律师确认、逐项）。 */
  basis_source?: "engagement_terms" | "separate_consent" | "confirmed" | null;
  /** 授权依据的出处（合同名称或编号、条款号、签订日期，或书面同意的日期与方式）。 */
  basis_ref?: string | null;
  /** 记录时告知客户的 AI 次处理者清单版本；与当前版本不同时须重新确认。 */
  basis_notice_version?: string | null;
  /** 按旧的次处理者清单记录、或缺少出处的早期记录，须重新确认（内核派生）。 */
  basis_reconfirm?: boolean;
  /** 客户授权状态（D-225，内核与四个强制点同一判定）：有效 / 待确认 / 待补记出处 / 次处理者清单已更新待重新确认。 */
  basis_state?: "valid" | "pending" | "needs_ref" | "reconfirm";
  /** 最近一次记录授权的时间与记录人（D-225；matters.list、matters.get）。 */
  basis_recorded_at?: string | null;
  basis_recorded_by?: string | null;
  /** 授权记录历史（D-225，matters.get；新的在前，只增不改）。 */
  authorization_history?: AuthorizationHistoryEntry[];
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
  /** 这台电脑上关联的案卷文件夹（第 48 批，matters.get）；没关联为 null。 */
  folder?: MatterFolder | null;
  created_at: string;
}

/** 一条客户授权记录（D-225）。 */
export interface AuthorizationHistoryEntry {
  basis_source: string;
  basis_ref: string;
  basis_notice_version: string;
  /** 记录时的次处理者清单是否为当前版本。 */
  current_version: boolean;
  recorded_by: string | null;
  recorded_at: string;
}

/** 案卷文件夹（第 48 批）：位置只在这台电脑。 */
export interface MatterFolder {
  name: string;
  root: string;
  linked_at: string | null;
  synced_at: string | null;
}
/** 一次同步的结果（materials.link_folder / materials.sync_folder）。 */
export interface FolderSyncResult {
  folder: MatterFolder | null;
  added: number;
  updated: number;
  unchanged: number;
  skipped: { rel_path: string; reason: string }[];
  skipped_total: number;
  missing_on_disk: string[];
  capped: boolean;
  cap: number;
  scanned: number;
  synced_at: string;
}
/** 材料内搜索的一条结果（materials.search）。 */
export interface MaterialSearchHit {
  document_version_id: string;
  filename: string;
  rel_path: string | null;
  hits: number;
  name_match: boolean;
  snippet: string | null;
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
  /** 待签发那条的成果种类（第 27 批）。 */
  artifact_kind?: string;
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
  /** 律所名称：修订署名不填时，对外版修订稿用它作作者名（10-23 拍板）。 */
  firm_name?: string | null;
  template: { name: string; sha256: string; updated_at: string; header_text: string; footer_text: string; looks_case_specific: boolean } | null;
}

/** 事项模板（v9.4 第 22 批，内核 services/matter-templates.ts）。 */
export interface MatterTemplate {
  id: string;
  title: string;
  line: "litigation" | "transactional" | "inhouse";
  hint: string;
  stances: string[];
  stance_aliases?: string[];
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
  /**
   * 这条回答（或“未能取得回答”）实际用的模型别名（第 47 批），如 "legal/k2.6"；问题本身与第 47 批之前的旧记录为 null（界面不显示）。
   * route_label 是律师看的名字（"K3" / "K2.6"），不认识的别名为 null。旧内核不带这两个字段。
   */
  route?: string | null;
  route_label?: string | null;
  /** 第 71 批第三轮：律师在生成中途停止，只保存了停止前的部分（界面标“已停止”）。旧内核不带。 */
  stopped?: boolean;
}

/** 问答可选的模型（第 47 批；chat.models 与 kernel.status 的 model_choices）：只列本机模型路由配置了的。 */
export interface ChatModelChoice {
  /** 模型别名："legal/k3" | "legal/k2.6"。发送时原样作为 route 传回。 */
  alias: string;
  /** 律师看的名字："K3" | "K2.6"。 */
  label: string;
  /** 一句话说明，如“缺省，适合复杂问题”“更快、更省额度，复杂问题效果略弱”。 */
  note: string;
  /** 不选时用的就是它。 */
  default: boolean;
  /** 深度思考开关控制什么（第 49 批；旧内核没有）：effort = K3 始终思考、开关调推理强度；toggle = K2.6 开 / 关思考；none = 不可控。 */
  thinking?: "effort" | "toggle" | "none";
}

/** 第 66 批（V40）：模型选择器的入口——task = 首页发起任务，qa = 问答。 */
export type ModelScope = "task" | "qa";

/** 第 66 批：云端模型目录里的一项（models.list）。只有展示与能力字段——上游型号、地址与密钥不在客户端。 */
export interface ModelOption {
  /** 模型编号（别名），如 "legal/k3"、"legal/k3-fast"；发起任务时作 runs.start 的 model，问答发送时作 route。 */
  id: string;
  /** 律师看的名字，如“K3”。 */
  label: string;
  /** 一句话说明，如“适合复杂问题”；没有为 null。 */
  description: string | null;
  sort: number;
  /** 深度思考开关控制什么：effort = 始终思考、开关调强度；toggle = 开 / 关；none = 不可控（不显示开关）。 */
  thinking: "effort" | "toggle" | "none";
  efforts: ("low" | "high" | "max")[];
  capabilities: ("tool_use" | "thinking" | "long_context")[];
  scopes: ModelScope[];
  max_context: number | null;
  /** 这个入口不选时用的就是它。 */
  default: boolean;
  /** 现在能不能选（套餐不含、未定价、无线路、已停用、不支持工具调用时为 false；界面置灰并显示 reason_text）。 */
  available: boolean;
  /** 不可用原因代码：not_in_plan / unpriced / no_route / disabled / no_tool_use / not_in_scope；可用时为 null。 */
  reason: string | null;
  /** 不可用原因的中文说明（直接显示）；可用时为 null。 */
  reason_text: string | null;
}

/** 第 66 批：models.list 的结果。 */
export interface ModelCatalogView {
  scope: ModelScope;
  /** 云端目录版本（只用内置两项时为 null）。 */
  version: number | null;
  /** cloud = 本次运行中从云端取到；cache = 上次取到的（离线时）；builtin = 从未取到 / 没有云端（开发形态、试用版）。 */
  source: "cloud" | "cache" | "builtin";
  fetched_at: string | null;
  /** 这个入口的缺省模型编号。 */
  default: string;
  /** 现在应选中的：律师记住的（仍可用时）否则缺省。 */
  selected: string;
  /** 律师记住的模型现在不可用时（已回落到缺省）：说明原因，界面可提示一次。 */
  selected_unavailable?: { id: string; label: string; reason: string; reason_text: string | null };
  /** 该入口的模型（按排序；含不可用的）。 */
  models: ModelOption[];
}

/** 内核广播：要重新登录（第 44 批同步；第 47 批起模型请求被网关按身份拒绝时也立即广播）。 */
export interface AccountLoginRequiredEvent {
  type: "account.login_required";
  /** 原因代码：account_disabled / session_invalid / session_expired / session_required / session_member_mismatch。 */
  reason: string;
  /** sync = 与控制面同步时得知；model = 问答或任务的模型请求被网关拒绝时得知（第 47 批）。旧内核不带。 */
  source?: "sync" | "model";
  /** 律师话（如“账号已停用，请联系律所管理员或中软客服”）。旧内核不带。 */
  message?: string;
}

export interface Capabilities {
  execution_domain: { available: boolean | null; label: string; status: string; detail: string };
  sole_exit: string;
  gate: { running: boolean; routes: Record<string, boolean>; search_configured: boolean; fetch: string };
  rows: { capability: string; status: string; note: string }[];
  /** 给律所看的本机功能一览（第 26 批）；老内核没有。 */
  customer_rows?: { feature: string; status: string; note: string }[];
}

/** 文字 → UTF-8 → base64（分块拼，长文字不撑爆调用栈）。 */
export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
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

/**
 * 本所用量与上限（第 44 批 v2，与 Kimi 的额度呈现同一表达）：比例 0–1、剩余、单位（tokens 或元）、统计周期与重置时间、
 * 5 小时频率窗口、本人用量（分母写明来源：个人上限或套餐每人额度）、按模型；管理员与合伙人另有用量数与按成员明细。
 * 成员名由内核在本机换上。mode = local_dev 时只有 note。
 */
export interface QuotaStatus {
  mode: "control_plane" | "local_dev";
  /** 安装形态（第 46 批）：trial = 试用版安装包。 */
  edition?: "trial" | "release" | "dev";
  note?: string;
  /** 第 66 批（V40）：note / period / burst / models（可用模型显示名，与模型目录同源）是追加字段，旧控制面没有。 */
  plan?: { id: string; label: string; note?: string | null; period?: "month" | "week"; burst?: { hours: number; pct: number } | null; models?: string[] | null; /** 第 69 批：有效期至（试用为试用结束；旧云端没有）。 */ valid_until?: string | null };
  unit?: "tokens" | "cny";
  unit_label?: string;
  period?: { kind: "month" | "week"; key: string; start: string; resets_at: string };
  firm?: {
    used_ratio: number;
    remaining_ratio: number;
    in_flight_ratio: number;
    /** 暂停原因：律所设的上限已到 / 本期额度用完 / 5 小时内用得太快。 */
    paused: "cap" | "allowance" | "burst" | null;
    cap_pct: number | null;
    cap_set_at?: string | null;
    boost_pct: number;
    /** 本期从旧计量口径带过来的比例（迁移前的用量）；null = 没有。 */
    legacy_used_ratio: number | null;
    /** 用量数与总额度（单位见 unit）；成员看不到，为 null。 */
    used: number | null;
    total: number | null;
    seats: number;
    denominator?: string;
  };
  burst?: { hours: number; pct: number; used_ratio: number; resets_at: string | null } | null;
  own?: { used_ratio: number; denominator: "account_limit" | "seat_quota"; enforced: boolean; used: number; total: number; requests: number; tokens: number; value_cny: number | null; estimated_rows: number } | null;
  history?: { period: string; used_ratio: number | null; legacy: boolean }[];
  models?: { alias: string; label?: string; used: number; share: number; requests: number }[];
  by_member?: { uid: string | null; name: string | null; used: number; used_ratio_of_firm: number; requests: number }[];
  boosts?: { at: string; pct: number }[];
  unreconciled_leases?: number;
  /** 本人的使用明细（第 47 批）：本期最近 20 条，新的在前；不含请求内容。旧控制面没有该字段。 */
  own_recent?: { at: string; kind: "qa" | "task"; alias: string | null; label: string | null; tokens_in: number; tokens_cached: number; tokens_out: number; charge: number; /** 第 62 批：这一条占本人分母的比例（控制面算；客户端不用 charge 折算金额）。旧控制面没有。 */ charge_ratio?: number; unit: "tokens" | "cny"; value_cny: number | null; outcome: string; partial: boolean; estimated: boolean; /** 第 62 批：上游没给真实用量、按估算——不计入额度，待核对。 */ pending?: boolean; /** 第 70 批：用在哪（本机对回）。 */ where?: UsageWhere }[];
  /**
   * 第 66 批（V40）：个人口径——真正卡住“我”的那一项（额度、律所上限、5 小时窗口、个人上限四者最小）。界面的“已用 / 剩余”优先用它；
   * limited_by = 正在卡住的那项（null = 都没卡）。旧控制面没有，回退到 own。
   */
  personal?: {
    used_ratio: number;
    remaining_ratio: number;
    limited_by: "allowance" | "cap" | "burst" | "seat" | null;
    /** 暂停原因（null = 没暂停）。 */
    paused: "allowance" | "cap" | "burst" | "seat" | null;
    /** 第 68 批：本人进行中的任务预留（同一分母；旧云端没有）。 */
    in_flight_ratio?: number;
    /** 第 69 批（V43）：本期按天（北京日期 YYYY-MM-DD 升序，只含有调用的日子；ratio 与 used_ratio 同一分母，各日之和 = used_ratio）。旧云端没有。 */
    daily?: { day: string; ratio: number; requests: number; qa_requests: number }[];
    /** 第 69 批（V43）：本期按用途（任务 + 问答 = used_ratio）。旧云端没有。 */
    by_kind?: { task: { ratio: number; requests: number }; qa: { ratio: number; requests: number } };
  };
  /** 第 68 批：明细与大数字同一分母（"personal"）；旧云端没有，客户端按比值折算。 */
  ratio_basis?: "personal";
  /** 第 66 批：本人本期按模型（份额按 token，不含金额）。 */
  /** 第 69 批：used_ratio = 计入本人额度的比例（与 personal.used_ratio 同一分母，各模型之和 = used_ratio）；旧云端没有。 */
  own_models?: { alias: string; label: string; share: number; requests: number; used_ratio?: number }[];
}

/** 第 66 批（V40）：本人用量明细的一行（quota.usage_page；与 own_recent 同口径，不含金额与请求内容）。in_period = 属于本期。 */
export interface UsagePageRow {
  at: string;
  kind: "qa" | "task";
  alias: string | null;
  label: string | null;
  tokens_in: number;
  tokens_cached: number;
  tokens_out: number;
  charge_ratio: number;
  outcome: string;
  partial: boolean;
  estimated: boolean;
  pending: boolean;
  in_period: boolean;
  /** 第 70 批（V44）：用在哪（内核在本机按请求编号对回的任务名与事项名，只在本机；对不上没有这一字段；别的电脑发出的为 elsewhere）。 */
  where?: UsageWhere;
}

/** 第 70 批（V44）：明细一行用在哪——任务名（卡片名）与事项名（问答为会话标题）；elsewhere = 在本账号的另一台电脑上。 */
export type UsageWhere = { task: string; matter: string | null; /** 第 71 批：问答第一问全文（界面按显示宽度截断、悬停给全称）。 */ matter_full?: string | null; matter_id: string | null; run_id: string | null; conversation_id: string | null; how: "id" | "match" } | { elsewhere: true };

/** 第 66 批：明细一页；next_before = 下一页的 before（null = 没有更早的了）。mode = local_dev 时没有明细。 */
export interface UsagePage {
  mode: "control_plane" | "local_dev";
  rows: UsagePageRow[];
  next_before: string | null;
}

/** 账号状态（第 44 批）：这台电脑上登录的是谁、是否要重新登录。 */
export interface AccountStatus {
  mode: "control_plane" | "local_dev";
  /** 安装形态（第 46 批）：trial = 试用版安装包（不接中软账号服务）。 */
  edition?: "trial" | "release" | "dev";
  logged_in: boolean;
  account: { email: string; name: string; role: string } | null;
  /** 上次登录的账号（退出登录后仍记得，只有邮箱、姓名、角色；没有令牌）。 */
  last_account?: { email: string; name: string; role: string } | null;
  login_required: boolean;
  reason: string | null;
  message: string | null;
}

/** 账号详情（account.me）：本人、当前登录、名下的电脑、仍有效的登录。 */
export interface AccountMe {
  /** phone：验证过的手机号（打码，如 138****8000），没有绑定为 null；旧内核没有这一项。 */
  account: { aid: string; email: string; name: string; role: string; status: string; tid: string; org?: { slug: string; name: string }; device_limit: number; last_login_at?: string | null; created_at?: string; phone?: string | null };
  session: AccountSession;
  devices: AccountDevice[];
  sessions: AccountSession[];
  /** 第 66 批（V40）：个人账号（换电脑直接登录、不需别的电脑批准；第 68 批起台数按云端配置的上限）。旧云端没有。 */
  personal?: boolean;
  /** 第 66 批：最近 5 次登录（新的在前）：时刻、类型（login 登录 / enroll 新电脑登记）、设备编号、平台、粗粒度网段。旧云端没有。 */
  recent_logins?: { at: string; kind: "login" | "enroll"; device_id: string | null; platform: string | null; version: string | null; net: string }[];
}

/** 中软侧操作记录（第 9 批 S14）：本机验过签名与哈希链后留存的记录。 */
export interface CpAuditRow {
  seq: number;
  at: string;
  actor: { kind: "device" | "root" | "ops" | "service" | "account" | "claimant"; id: string; fp?: string };
  /** 执行者的姓名（第 56 批：与“管理 → 成员”同一来源；解析不到为 null）。 */
  actor_name: string | null;
  actor_is_me?: boolean;
  action: string;
  target: string | null;
  /** 对象所属成员的姓名（设备、席位、账号；第 56 批起不再是“你的席位”这类整句）。 */
  target_name: string | null;
  target_kind?: "device" | "seat" | "account" | "matter" | "activation" | "invitation" | "join_request" | "draft" | "connector" | "other" | null;
  target_is_me?: boolean;
  /** 对象是设备时：本人登记的第几台、共几台。 */
  target_ordinal?: { n: number; of: number } | null;
  result: string;
  /** 数值明细（上限百分比、加量百分比、席位数、续订天数；第 39 批之前的旧记录另有旧计量的数）。 */
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
  installSample: (kind?: "litigation") => invoke<{ matter_id: string | null; matter_ids?: string[]; installed: boolean; disabled?: boolean }>("samples.install", kind ? { kind } : {}),
  /** available：内核是否开着演示开关（正式产品为 false，不放任何示例）。 */
  sampleStatus: () => invoke<{ installed: boolean; removed: boolean; matter_ids: string[]; litigation_offered: boolean; available?: boolean }>("samples.status", {}),
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
  /** 含事项名称等案件信息的文本（D-225 各事项授权记录导出）：保存位置按“含案件内容”提示。返回 false = 取消或失败。 */
  saveCaseText: async (suggestedName: string, text: string, type = "text/csv"): Promise<boolean> => {
    const target = await chooseSaveTarget(suggestedName, "case");
    if (target === null) return false;
    if (target && window.zrKernel?.saveText) return (await window.zrKernel.saveText(target.handle, text)).ok;
    browserDownload(textToBase64(text), suggestedName, type);
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
  /**
   * 律师直接写的文字存成一份材料（第 55 批：开始面板的案情说明）。文字本来就在界面里，按内容交给内核（与浏览器形态拖放文件同一个入口，
   * 内核照常算哈希、解析、加密入库）；不经文件路径。
   */
  /** supersedes：作为本事项某份材料的新版本（D-224 当事人信息：事项里只留一份当前有效）。 */
  importMaterialText: (matterId: string, filename: string, text: string, supersedes?: string | null) =>
    invoke<{ document_version_id: string; chars: number; sha256: string; note: string }>("materials.import", { matter_id: matterId, data_base64: utf8ToBase64(text), filename, mime: "text/plain", ...(supersedes ? { supersedes } : {}) }),
  /** 材料用途（我方 / 对方 / 参考；null 清除）。 */
  setMaterialRole: (documentVersionId: string, role: "ours" | "theirs" | "reference" | null) => invoke<{ role: string | null }>("materials.set_role", { document_version_id: documentVersionId, role }),
  /** 把本事项的 Word 成果作为新材料（V14 第 39 批：在上一轮修订稿 / 清洁稿 / 起草稿上继续修改）。 */
  artifactToMaterial: (artifactVersionId: string) => invoke<{ document_version_id: string; filename: string; note: string }>("materials.from_artifact", { artifact_version_id: artifactVersionId }),
  mountMaterial: async (matterId: string, file: MaterialFile) => {
    if (isPicked(file)) return invoke("materials.mount", { matter_id: matterId, file_handle: file.handle, filename: file.name });
    const h = window.zrKernel?.fileHandleFor ? await window.zrKernel.fileHandleFor(file) : null;
    if (!h) throw new KernelError(window.zrKernel?.fileHandleFor ? "这个文件不能引用（网络位置上的文件请先复制到本机）" : "引用原文件需要桌面客户端（web 调试请用添加）", "validation");
    return invoke("materials.mount", { matter_id: matterId, file_handle: h.handle, filename: file.name });
  },
  /**
   * 材料和任务的对应（第 66 批 K2，只读）：每份材料被哪些任务勾选过、每个任务勾了哪些材料；没勾材料的任务（可读全部）单列计数。
   * 任务名 title / goal 是代号形态，显示前照常还原。
   */
  materialUsage: (matterId: string) => invoke<MaterialUsage>("materials.usage", { matter_id: matterId }),
  /**
   * 移除误放的材料（第 66 批 K3）：删本产品保存的副本与解析文字（挂载的只解除引用），原文件不动，留审计；
   * 进行中的任务在用时报 code = "material_in_use"（detail.run_ids）。用过它的成果标“依据材料已被移除”待核对。
   */
  removeMaterial: (documentVersionId: string) => invoke<MaterialRemoveResult>("materials.remove", { document_version_id: documentVersionId }),
  /** 有没有选文件夹的系统对话框（桌面客户端有；web 开发形态没有，界面让开发者填路径）。 */
  hasFolderDialog: () => !!window.zrKernel?.pickFolder,
  /**
   * 关联案卷文件夹（第 48 批）：桌面客户端弹系统对话框，只把一次性文件夹句柄交给主进程换成路径；取消返回 null。
   * web 开发形态没有对话框，用开发者填写的路径（与“备份位置”同一做法，仅开发）。
   */
  linkFolder: async (matterId: string, devPath?: string): Promise<FolderSyncResult | null> => {
    if (window.zrKernel?.pickFolder) {
      const f = await window.zrKernel.pickFolder();
      if (!f) return null;
      return invoke<FolderSyncResult>("materials.link_folder", { matter_id: matterId, folder_handle: f.handle });
    }
    if (!devPath?.trim()) throw new KernelError("请先填写文件夹的完整位置（开发调试形态没有选择文件夹的对话框）", "validation");
    return invoke<FolderSyncResult>("materials.link_folder", { matter_id: matterId, path: devPath.trim() });
  },
  /** 同步案卷文件夹：导入新增、改过的文件（内容相同的不重复导入；文件夹里删掉的只报告）。 */
  syncFolder: (matterId: string) => invoke<FolderSyncResult>("materials.sync_folder", { matter_id: matterId }),
  /** 取消关联：只清除这台电脑记下的位置，已导入的材料留在事项里。 */
  unlinkFolder: (matterId: string) => invoke<{ folder: null }>("materials.unlink_folder", { matter_id: matterId }),
  /** 在本事项材料里搜索（文件名、文件夹位置、解析文字；只在本机）。 */
  searchMaterials: (matterId: string, q: string) => invoke<{ terms: string[]; hits: MaterialSearchHit[]; truncated: boolean }>("materials.search", { matter_id: matterId, q }),

  // 任务
  estimate: (matterId: string, body: { scenario: string; document_version_ids: string[]; goal?: string; topic_hint?: string } & Record<string, unknown>) =>
    invoke<{ estimate_id: string; points: number; points_display: string; assumptions: string[]; data_where?: { preview: string; warning: string | null; start_blocked: boolean; block_kind?: "exit_mode" | "busy" | "consent" | "policy" | "suspects" | "account" | "quota" | null; busy_run_id?: string; send_summary?: SendSummaryView; start_hint?: { kind: "login" | "outdated" | "quota"; code: string; message: string; action: "login" | "usage" | null } } }>("runs.estimate", { matter_id: matterId, ...body }),
  /** 发送视图（v9.2 §3.4）：模型会看到的样子——令牌形态与代号位置，不含代号真值。 */
  sendPreview: (matterId: string, documentVersionId: string) => invoke<SendPreview>("materials.send_preview", { matter_id: matterId, document_version_id: documentVersionId }),
  /** 疑似未替换的姓名（只在本机界面显示）。 */
  listSuspects: (matterId: string, documentVersionIds: string[], goal?: string) => invoke<{ suspects: SuspectView[]; summary: SendSummaryView }>("matters.suspects.list", { matter_id: matterId, document_version_ids: documentVersionIds, ...(goal ? { goal } : {}) }),
  reviewSuspects: (matterId: string, items: { value: string; decision: "name" | "not_name" }[]) =>
    invoke<{ added_to_parties: number; dismissed: number; rejected: string[] }>("matters.suspects.review", { matter_id: matterId, items }),
  startRun: (matterId: string, body: { estimate_id: string; idempotency_key: string; goal?: string; title?: string; topic_hint?: string; mode?: RunMode; plan_first?: boolean; preauthorizations?: Preauthorization[]; skill?: string; skill_args?: Record<string, string>; primary_output?: string; review_rules?: boolean; followup_of?: string; mode_raise_confirmed?: boolean; review_apply?: boolean; /** 第 66 批：所选模型（ModelOption.id）；不给 = 律师在首页记住的或缺省；追问沿用上一轮（给了不同的被拒）。 */ model?: string }) =>
    invoke<{ run_id: string; status: string; mode?: RunMode; /** 第 66 批：这次任务实际用的模型与显示名。 */ model?: string; model_label?: string }>("runs.start", { matter_id: matterId, ...body }),
  getRun: (runId: string) =>
    invoke<{ run: any; artifacts: any[]; inflight?: { model: number; search: number; fetch: number }; unresolved_operations?: UnresolvedOperation[]; waiting_ahead?: number }>("runs.get", { run_id: runId }),
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
  /**
   * 导出 PDF（第 29 批，律师指定要 PDF）：与“下载 Word”同一份文件排版后打印。桌面客户端由主进程打印并写到律师选定的位置；
   * 开发形态（浏览器）打开打印页，由浏览器“打印 → 存储为 PDF”。返回 null = 取消。
   */
  exportArtifactPdf: async (artifactVersionId: string): Promise<{ name: string | null; opened: boolean } | null> => {
    if (window.zrKernel?.exportPdf) {
      const r = await window.zrKernel.exportPdf(artifactVersionId);
      if (r.canceled) return null;
      if (!r.ok) throw new Error(r.reason ?? "导出 PDF 失败");
      const opened = !!(r.open_handle && window.zrKernel.openSaved && (await window.zrKernel.openSaved(r.open_handle)).ok);
      return { name: r.name ?? null, opened };
    }
    const r = await invoke<{ filename: string; html: string }>("artifacts.print_html", { artifact_version_id: artifactVersionId });
    const url = URL.createObjectURL(new Blob([r.html], { type: "text/html" }));
    const w = window.open(url, "_blank");
    if (!w) {
      URL.revokeObjectURL(url);
      throw new Error("浏览器拦截了打印窗口：请允许本页弹出窗口后再点“导出 PDF”");
    }
    w.addEventListener("load", () => w.print());
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return { name: r.filename, opened: false };
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
  /** 客户授权的默认设置（第 48 批）：委托合同是否含使用 AI 辅助的条款；开了以后新建事项默认按此记录。 */
  aiAuthorization: () => invoke<AiAuthorization>("ai_authorization.get"),
  /** 律师本人的授权设置（第 51 批）：engagement_terms = 用常用条款出处预填；default_ref = 常用的委托合同 AI 条款出处。 */
  setAiAuthorization: (p: { engagement_terms?: boolean; default_ref?: string | null }) => invoke<AiAuthorization>("ai_authorization.set", p),
  /** 首次使用 AI 的数据去向告知（第 51 批）：律师本人看过的版本。 */
  aiNotice: () => invoke<{ version: string; acked_version: string | null; acked_at: string | null; needs_ack: boolean }>("ai_notice.get"),
  ackAiNotice: (version: string) => invoke<{ version: string; acked_at: string }>("ai_notice.ack", { version }),
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
  // 本所范本库（v9.4 第 24 批，C1 #23）：律师主动放入、去掉客户信息的范本；只在本机比对，不发给 AI
  firmTemplates: () => invoke<{ templates: FirmTemplate[]; contract_types: string[] }>("firm_templates.list"),
  firmTemplate: (templateId: string) => invoke<{ template: FirmTemplate; clauses: { seq: number; heading: string; text: string; body: string }[] }>("firm_templates.get", { template_id: templateId }),
  /** 放入范本：file 为开发形态的文件输入框；桌面客户端经系统对话框（pick = true）；也可粘贴 text。返回 null = 取消选择文件。 */
  addFirmTemplate: async (meta: { title: string; contract_type: string; stance?: string; note?: string; replace_hits?: boolean }, src: { text: string } | { file: File } | { handle: string; name: string }): Promise<FirmTemplateAddResult> => {
    if ("text" in src) return invoke<FirmTemplateAddResult>("firm_templates.add", { ...meta, text: src.text });
    if ("handle" in src) return invoke<FirmTemplateAddResult>("firm_templates.add", { ...meta, file_handle: src.handle, filename: src.name });
    const data_base64 = btoa(Array.from(new Uint8Array(await src.file.arrayBuffer()), (b) => String.fromCharCode(b)).join(""));
    return invoke<FirmTemplateAddResult>("firm_templates.add", { ...meta, data_base64, filename: src.file.name });
  },
  pickTemplateFile: async (): Promise<{ handle: string; name: string } | null> => {
    if (!window.zrKernel?.pickFiles) return null;
    const f = ((await window.zrKernel.pickFiles({ extensions: ["docx", "txt"], multiple: false })) ?? [])[0];
    return f ? { handle: f.handle, name: f.name } : null;
  },
  /** 把范本放进一个事项作为参考材料（之后起草合同等方法按事项材料使用，随任务发给 AI）。 */
  firmTemplateToMatter: (templateId: string, matterId: string) => invoke<{ document_version_id: string; filename: string }>("firm_templates.to_matter", { template_id: templateId, matter_id: matterId }),
  removeFirmTemplate: (templateId: string) => invoke<{ templates: FirmTemplate[] }>("firm_templates.remove", { template_id: templateId }),
  templatesForCard: (matterId: string, cardId: string) => invoke<{ items: TemplateMatch[]; library_size: number }>("firm_templates.for_card", { matter_id: matterId, card_id: cardId }),
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
      | { status: "applied"; artifact_version_id: string; filename: string; applied: number; skipped: string[]; no_insert_point?: string[]; clean?: { artifact_version_id: string; filename: string } }
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
  /** confirmFacts（第 28 批）：同时确认留下的论点引用的待确认事实。 */
  decideOutline: (matterId: string, outlineId: string, decisions: { arg_id: string; keep: boolean; claim?: string; basis_keep?: number[] }[], note: string, confirmFacts = false) =>
    invoke<{ outline: import("./lib/outline.ts").OutlineView; facts_confirmed?: number }>("outlines.decide", { matter_id: matterId, outline_id: outlineId, decisions, ...(note ? { note } : {}), ...(confirmFacts ? { confirm_facts: true } : {}) }),
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
      runs: { run_id: string; matter_id: string; matter_title: string; scenario: string; skill: string | null; goal: string; title?: string | null; updated_at: string }[];
      deliverables: { artifact_version_id: string; matter_id: string; matter_title: string; kind: string; version: number; filename: string; title: string | null; created_at: string }[];
      /** 材料（第 49 批；旧内核没有）：各事项材料的最新版本，按文件名与文件夹位置匹配。 */
      materials?: { document_version_id: string; matter_id: string; matter_title: string; filename: string; rel_path: string | null; created_at: string }[];
      truncated: { runs: boolean; deliverables: boolean; materials?: boolean };
    }>("search.titles", { q, labels }),
  /** 上手清单（第 46 批）：自己建的事项、自己导入的材料、自己发起的任务与其成果的数目，以及“去做”直达的目标。 */
  guideProgress: () =>
    invoke<{ firm: string | null; user: string | null; own_matters: number; materials: number; runs: number; deliverables: number; latest_matter_id: string | null; latest_run: { run_id: string; matter_id: string } | null }>("guide.progress"),
  recentRuns: (limit = 5) =>
    invoke<{ runs: { run_id: string; matter_id: string; matter_title: string; scenario: string; status: string; updated_at: string; goal: string; title?: string | null; skill?: string | null }[]; waiting: { run_id: string; matter_id: string }[] }>("runs.list_recent", { limit }),

  // 数据去向
  egressRecords: (args: { runId?: string; matterId?: string }) => invoke<{ records: EgressRecord[] }>("egress.records", args.runId ? { run_id: args.runId } : { matter_id: args.matterId }),
  egressSummary: (runId: string) => invoke<EgressSummary>("egress.summary", { run_id: runId }),
  /** 结果不明的出站（预写后中断，待人工对账；阶段 4 复核 S4-21）。 */
  egressUnresolved: (matterId?: string) => invoke<{ records: any[] }>("egress.unresolved", matterId ? { matter_id: matterId } : {}),
  egressReconcile: (recordId: string, resolution: "confirmed_sent" | "not_sent" | "unknown") => invoke("egress.reconcile", { record_id: recordId, resolution }),

  // 问答（无事项）
  chatList: () => invoke<{ conversations: { conversation_id: string; title: string; updated_at: string }[] }>("chat.list"),
  chatGet: (conversationId: string) => invoke<{ conversation_id: string; messages: ChatMessage[] }>("chat.get", { conversation_id: conversationId }),
  chatDelete: (conversationId: string) => invoke<{ ok: true }>("chat.delete", { conversation_id: conversationId }),
  /** 第 71 批第三轮：停止正在生成的回答（只停本人发起的、还在进行的；已经答完或不存在时 ok 为 false）。chat.send 随即返回，已生成的部分标“已停止”。 */
  chatStop: (streamId: string) => invoke<{ ok: boolean }>("chat.stop", { stream_id: streamId }),
  /** stream_id：本次发送的一次性编号，回答生成中的部分内容以 chat.delta 广播推送（onKernelEvent）。 */
  chatSend: (body: { conversation_id?: string; text: string; stream_id?: string }) =>
    invoke<{ conversation_id: string; messages: ChatMessage[]; blocked?: { reason: string; message: string; matters?: { matter_id: string; title: string }[] } }>("chat.send", body),
  /** 问答可选的模型（第 47 批）：choices 只列本机配置了的；default 为不选时用的别名（没有可选模型时为 null）。 */
  chatModels: () => invoke<{ choices: ChatModelChoice[]; default: string | null; /** “深度思考”开关的缺省状态（第 48 批；旧内核没有这个字段）。 */ default_deep?: boolean }>("chat.models"),
  /**
   * 带模型选择的发送（第 47 批）：route 为 ChatModelChoice.alias（"legal/k3" / "legal/k2.6"）；不给 = 缺省模型。
   * 选了不可用的模型内核拒绝（validation，消息如“所选模型不可用：问答只能选 K3、K2.6”），不会悄悄换模型。
   */
  chatSendWithModel: (body: { conversation_id?: string; text: string; stream_id?: string; route?: string; /** 深度思考（第 48 批）：true 先充分思考再答，false 快速回答；不给按内核缺省。 */ deep?: boolean }) =>
    invoke<{ conversation_id: string; messages: ChatMessage[]; blocked?: { reason: string; message: string; matters?: { matter_id: string; title: string }[] } }>("chat.send", body),
  /**
   * 第 66 批（V40）：云端模型目录（首页与问答的选择器共用）。scope = "task"（首页任务，只列能做任务的）或 "qa"（问答）；
   * refresh: true 先向云端取一次（打开选择器时用；取不到用上一版）。
   */
  modelsList: (scope: ModelScope, opts: { refresh?: boolean } = {}) => invoke<ModelCatalogView>("models.list", { scope, ...(opts.refresh ? { refresh: true } : {}) }),
  /** 第 66 批：记住律师在某入口选的模型（本机、按本人）；不可选的被拒（消息可直接显示）。 */
  modelsSelect: (scope: ModelScope, id: string) => invoke<{ ok: true; scope: ModelScope; selected: string; label: string }>("models.select", { scope, id }),

  // 设备与连接
  /** 渲染会话被主进程拦截的外部请求（只在桌面客户端有；web 开发返回 null）。 */
  rendererNet: async (): Promise<{ blocked: number; last: string[] } | null> => (window.zrKernel?.rendererNet ? window.zrKernel.rendererNet() : null),
  kernelStatus: () => invoke<any>("kernel.status"),
  /** 连接检测（IP 部署第 50 批）：各云端服务的连通、证书核对结果与一句结论（文字由内核给出）。 */
  connectionDiagnose: () => invoke<ConnectionDiagnosis>("connection.diagnose"),
  // 控制面与律所治理（阶段 6）：状态不含任何令牌；告警是控制面下发内容未通过本机核验的记录
  controlPlaneStatus: () => invoke<ControlPlaneStatus>("control_plane.status"),
  quotaStatus: () => invoke<QuotaStatus>("quota.status"),
  /** 第 66 批（V40）：本人用量明细翻页（before = 上一页的 next_before；不传 = 最新一页；limit 1～100，缺省 50）。 */
  quotaUsagePage: (o: { before?: string | null; limit?: number } = {}) => invoke<UsagePage>("quota.usage_page", { ...(o.before ? { before: o.before } : {}), ...(o.limit ? { limit: o.limit } : {}) }),
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
  quotaSetCap: (capPct: number | null) => invoke<{ cap_pct: number | null }>("quota.set_cap", { monthly_cap_pct: capPct }),
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
  /** 本事项内的事实序号（V16 第 41 批）：交付件里写“事实 12”，这里显示同一序号；后来新增或驳回事实不改变旧序号。 */
  no: number;
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
  /** 第 66 批（V40）：个人账号新电脑自动登记被风控暂停后，用账号绑定手机号的短信验证码（account.smsSend(phone, "login")）确认再登记。 */
  deviceConfirm: (phone: string, smsCode: string) => invoke<any>("onboarding.device_confirm", { phone, sms_code: smsCode }),
  /** 第 68 批（V42）：电脑数已满时，用刚完成的登录就地移除这个账号的一台旧电脑，再继续登记这台电脑（结果同登录）。 */
  unbindDevice: (deviceId: string) => invoke<any>("onboarding.unbind_device", { device_id: deviceId }),
  /** 第 71 批（V45，D-298）：同时登录已满时，用刚完成的登录让这个账号的一台电脑退出登录（可逆：资料留在那台电脑上），再继续登记这台电脑（结果同登录）。 */
  signoutDevice: (deviceId: string) => invoke<any>("onboarding.signout_device", { device_id: deviceId }),
  /** 第 71 批：这台电脑正在为另一个账号等批准时，放弃那个申请、接着用刚才登录的账号继续（结果同登录）。 */
  abandonPending: () => invoke<any>("onboarding.abandon_pending"),
  /** 从备份恢复（第 14 批）：安装包形态传句柄；开发形态（无对话框）传路径。 */
  restore: (o: { file_handle?: string; folder_handle?: string; file?: string; dir?: string; code: string; legacy_ack?: boolean; older_ack?: boolean }) => invoke<any>("onboarding.restore", o),
};

/**
 * 账号（第 44 批，主文 §2）：登录、注册、找回密码在待激活时也可用；其余要这台电脑已激活。
 * 密码只经内核发给中软，渲染层不保存；登录凭据在内核里加密保存，界面拿不到。
 */
export const account = {
  register: (o: { email: string; password: string; name: string; org_name?: string; code?: string; phone?: string; sms_code?: string }) => invoke<any>("account.register", o),
  login: (email: string, password: string) => invoke<any>("account.login", { email, password }),
  // 第 63 批：手机号 + 短信验证码登录（同一个内核方法，结果与密码登录相同）
  loginByPhone: (phone: string, smsCode: string) => invoke<any>("account.login", { phone, sms_code: smsCode }),
  /** 第 71 批（V45）：这台已登记的电脑上重新登录——验证码发到这个账号绑定的手机号（不用再输手机号；应答里只有打码号）。 */
  smsSendRelogin: () => invoke<{ ok: true; phone: string | null; resend_after_s: number; expires_in_s: number; code_length: number; dry_run?: true; debug_code?: string }>("account.sms_send", { purpose: "login", relogin: true }),
  /** 第 71 批：用上面发到绑定手机号的验证码重新登录（结果同 login）。 */
  loginRelogin: (smsCode: string) => invoke<any>("account.login", { relogin: true, sms_code: smsCode }),
  resetRequest: (email: string) => invoke<{ ok: boolean; channel: "email" | "admin"; message?: string }>("account.reset_request", { email }),
  resetConfirm: (email: string, code: string, password: string) => invoke<{ ok: true }>("account.reset_confirm", { email, code, password }),
  // 第 62 批：注册策略（旧云端回 legacy）、短信验证码、用手机号找回密码
  registrationMeta: () => invoke<RegistrationMeta>("account.registration_meta"),
  smsSend: (phone: string, purpose: SmsPurpose) => invoke<{ ok: true; phone: string | null; resend_after_s: number; expires_in_s: number; code_length: number; dry_run?: true; debug_code?: string }>("account.sms_send", { phone, purpose }),
  resetConfirmByPhone: (phone: string, code: string, password: string) => invoke<{ ok: true }>("account.reset_confirm", { phone, code, password }),
  // 第 63 批：绑定手机号（账号还没有手机号）；更换手机号另要当前密码。结果里的手机号已打码
  bindPhone: (o: { phone: string; sms_code: string; password?: string }) => invoke<{ ok: true; phone: string | null }>("account.bind_phone", o),
  status: () => invoke<AccountStatus>("account.status"),
  logout: () => invoke<{ ok: true }>("account.logout"),
  me: () => invoke<AccountMe>("account.me"),
  changePassword: (current: string, next: string) => invoke<{ ok: true; other_sessions_revoked: number }>("account.change_password", { current, next }),
  revokeSession: (sid: string) => invoke<{ ok: true }>("account.revoke_session", { sid }),
  unbindDevice: (deviceId: string, password: string) => invoke<{ ok: true }>("account.unbind_device", { device_id: deviceId, password }),
  /** 第 70 批（V44）：给本人账号的一台电脑起名字（空串 = 去掉名字；只上传这一串）。 */
  renameDevice: (deviceId: string, name: string) => invoke<{ ok: true; name: string | null }>("account.rename_device", { device_id: deviceId, name }),
  /** 第 68 批（V42）：换账号登录时那个账号电脑数已满——就地移除它的一台旧电脑后继续切换（结果同 login）。 */
  unbindForLogin: (deviceId: string) => invoke<any>("account.unbind_for_login", { device_id: deviceId }),
  /** 第 71 批（V45，D-298）：重新登录 / 换账号时同时登录已满——让那个账号的一台电脑退出登录后继续（结果同 login）。 */
  signoutForLogin: (deviceId: string) => invoke<any>("account.signout_for_login", { device_id: deviceId }),
  /** 第 71 批：在设置里让本人账号的另一台电脑退出登录（那台电脑上的资料保留，回去重新登录即可）。 */
  signoutDevice: (deviceId: string) => invoke<{ ok: true; signed_out: number }>("account.signout_device", { device_id: deviceId }),
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
  offboarding: () => invoke<{ matters: OffboardingItem[]; pending: number; personal?: { writing_prefs: boolean; qa_conversations: number } }>("members.offboarding"),
  // 离所时清除本人在这台电脑上的个人设置（写作偏好；复核 Q4 建议 3）
  // 被停用的电脑启动时提示清除本人个人数据（D-144，10-23 拍板：只提示）
  personalStatus: () => invoke<{ device_revoked: boolean; writing_prefs: boolean; qa_conversations: number; prompt_clear: boolean }>("members.personal_status"),
  offboardClearPersonal: () => invoke<{ cleared: { writing_prefs: number; qa_conversations: number }; note: string }>("members.offboard_clear_personal"),
  offboardHandoff: (matterId: string, toUser: string) => invoke<{ relay: "done" | "not_needed" | "pending"; owner_set: boolean; note: string; item: OffboardingItem }>("members.offboard_handoff", { matter_id: matterId, to_user: toUser }),
};

export interface FirmTemplate {
  template_id: string;
  title: string;
  contract_type: string;
  stance: string | null;
  note: string | null;
  source_name: string | null;
  clauses: number;
  sha256: string;
  created_by: string;
  created_at: string;
}

export type FirmTemplateAddResult =
  | { status: "saved"; template: FirmTemplate; replaced: number }
  | { status: "needs_cleanup"; hits: { seq: number; heading: string; kind: string; text: string; reason: string }[]; clauses: number };

export interface TemplateMatch {
  template_id: string;
  title: string;
  contract_type: string;
  stance: string | null;
  stance_differs: boolean;
  same_type: boolean;
  seq: number;
  heading: string;
  text: string;
  body: string;
  score: number;
}

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

/** 连接检测结果（内核 connection.diagnose；services/cloud-connection.ts diagnoseView）。钉住值只有短前缀。 */
export interface ConnectionDiagnosis {
  checked_at: string;
  gate: "running" | "unavailable";
  tone: "ok" | "warn" | "error";
  conclusion: string;
  rows: {
    upstream: string;
    name: string;
    class: string;
    label: string;
    host: string | null;
    port: number | null;
    elapsed_ms: number;
    detail: string | null;
    pins: string[];
    presented: string[];
    cloud_ca: boolean;
  }[];
}

/**
 * materials.import 的结果（第 66 批 K1）：同事项已有内容相同的材料时不重复保存，duplicate 为 true、document_version_id 是已有那份、
 * filename 是它的原名（界面提示“已在本事项（原名 X）”，不改名）。api.importMaterial 的返回可按此类型读取。
 */
export interface MaterialImportResult {
  document_version_id: string;
  chars?: number;
  quality_flags?: string[];
  sha256?: string;
  note?: string;
  marking_notice?: string | null;
  duplicate?: boolean;
  filename?: string;
}

/** materials.usage 的一个任务（第 66 批 K2）。scope：selected = 勾了材料（只读这些）；all = 没勾、可读本事项全部材料。 */
export interface MaterialUsageRun {
  run_id: string;
  scenario: string;
  status: string;
  created_at: string;
  title: string | null;
  goal: string | null;
  followup_of?: string | null;
  scope?: "selected" | "all";
  document_version_ids?: string[];
  artifact_count: number;
}

export interface MaterialUsage {
  documents: { document_version_id: string; used_by: MaterialUsageRun[]; readable_by_unrestricted: number }[];
  runs: MaterialUsageRun[];
  unrestricted_runs: number;
}

export interface MaterialRemoveResult {
  document_version_id: string;
  removed: true;
  already?: boolean;
  reason: string;
  storage_mode?: string;
  affected_artifacts: number;
  note?: string;
}
