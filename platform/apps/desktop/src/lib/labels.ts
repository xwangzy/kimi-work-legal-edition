/** 界面文案映射（只说事实；不用“绝对安全”“数据不出所”等禁用词——第 02 篇 §12）。 */
import type { BasisValue, RunMode } from "../api.ts";

// 律师语言（UIUX 增量评审 H-2；10-13 文案表）：档位语义不变，只改称呼
/** 代号类别（令牌化器的 TokenCategory）→ 律师称呼。 */
export const TOKEN_CATEGORY_LABELS: Record<string, string> = {
  person: "姓名",
  org: "公司名称",
  id_number: "证件号",
  phone: "电话",
  account: "账号",
  uscc: "信用代码",
  address: "地址",
  plate: "车牌",
  email: "邮箱",
  case_no: "案号",
  birth_date: "出生日期",
};

export const MODE_LABELS: Record<RunMode, string> = { chat: "只问答", manual: "每步问我", default: "标准（推荐）", auto: "放手做" };
export const MODE_HINTS: Record<RunMode, string> = {
  chat: "只读材料、不写不执行；检索按规则",
  manual: "每一步都先问你",
  default: "在这台电脑上读写本事项文件、做计算；要联网或用到当事人信息时先问你",
  auto: "在本次用量上限内自己做完；开始时你同意过的检索不再逐条问；结果仍是草稿",
};
export const PREAUTH_LABELS: Record<string, string> = {
  search_generalized: "去掉当事人名称后检索（改成“某公司 / 某人”再发出）",
  fetch_allowlisted: "打开官方网站（法院、政府等）",
  connector_readonly: "只读查看律所系统",
};

export const BASIS_FIELDS: { key: "engagement" | "personal_info" | "sensitive" | "subprocessor"; label: string; hint: string }[] = [
  { key: "engagement", label: "委托/保密授权", hint: "客户是否同意使用 AI 与第三方服务" },
  { key: "personal_info", label: "个人信息处理依据", hint: "含对方、证人、员工等非委托人主体" },
  { key: "sensitive", label: "敏感信息特别条件", hint: "涉及敏感个人信息时的单独同意或其他条件" },
  { key: "subprocessor", label: "转委托与次处理者", hint: "中软、月之暗面等次处理者范围已告知或约定" },
];
export const BASIS_VALUE_LABELS: Record<BasisValue, string> = { confirmed: "已确认", pending: "待确认", not_applicable: "不适用" };

export const ENDPOINT_LABELS: Record<string, string> = {
  standard: "Kimi 模型（经中软安全通道）",
  byok: "律所自有 Kimi 账号",
  private: "律所私有模型",
  none: "不使用模型",
};
export const LEVEL_LABELS: Record<string, string> = {
  L0: "公开资料",
  L1: "律所内部",
  L2: "一般",
  L3a: "敏感（公司名称也替换为代号）",
  L3b: "客户要求不上云",
};

export const RUN_STATUS_LABELS: Record<string, string> = {
  created: "已创建",
  validating: "校验中",
  queued: "排队中",
  running: "执行中",
  waiting_input: "等待你回答",
  waiting_approval: "等待你确认",
  waiting_device: "等待电脑上线",
  budget_paused: "预算暂停",
  recovering: "恢复中",
  reconciling: "对账中",
  succeeded: "已完成",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已取消",
  expired: "已过期",
  timed_out: "已超时",
};
export const TERMINAL_STATUSES = ["succeeded", "partial", "failed", "cancelled", "expired", "timed_out", "reconciling"];

export const SCENARIO_LABELS: Record<string, string> = {
  "s1.contract_review": "合同审查",
  "s1b.draft_compare": "回稿比对",
  "s2.case_file": "材料整理",
  "s6.redaction": "对外脱敏",
  "a1.agent_task": "通用任务",
};

/** 成果在列表里的名称：Agent 产出的文件用文件名（同一任务可能有多份），其余用类别名。 */
/**
 * 交付件名称（UIUX 增量评审 D-2）：Agent 成果有内容标题（内核取第一行）时用标题，否则用文件名；工作流成果用固定名称。
 * 标题是令牌形态，传入 restore 才还原代号（下拉框里不能渲染胶囊）。
 */
export function artifactName(a: { kind: string; filename: string; title?: string | null }, restore?: (t: string) => string): string {
  const agentKind = ["a1_workspace_file", "agent_table", "agent_report", "a1_agent_draft", "a1_agent_draft_partial"].includes(a.kind);
  if (!agentKind) return ARTIFACT_LABELS[a.kind] ?? a.filename;
  const t = a.title ? (restore ? restore(a.title) : a.title) : null;
  // 助手草稿有标题时写“标题（草稿）”，没有标题时沿用固定名称
  if (a.kind === "a1_agent_draft" || a.kind === "a1_agent_draft_partial") return t ? `${t}（${a.kind === "a1_agent_draft" ? "草稿" : "部分完成"}）` : ARTIFACT_LABELS[a.kind]!;
  return t ?? a.filename;
}

export const ARTIFACT_LABELS: Record<string, string> = {
  s1_redline: "修订稿（原生修订）",
  s1_clean: "清洁稿",
  s1_opinion: "审查意见书（内部稿）",
  s1_issue_table: "条款问题表",
  s1b_report: "回稿比对报告",
  s1b_diff_table: "回稿差异表",
  s6_redacted: "脱敏件",
  s6_report: "脱敏报告",
  a1_agent_draft: "助手草稿",
  a1_workspace_file: "工作区文件（草稿）",
  revision_draft: "修订稿（Word 修订痕迹）",
  agent_table: "表格（草稿）",
  agent_report: "文书（草稿）",
  final_message: "助手回复",
  a1_agent_draft_partial: "助手草稿（部分完成）",
  consent_notice: "当事人告知函（草稿）",
};

/** 受众（第 03 篇 §12：审批对象绑定受众；按受众分版）。 */
export const AUDIENCE_LABELS: Record<string, string> = { internal: "内部", client: "客户", counterparty: "相对方", court: "法院" };

export const DEST_LABELS: Record<string, string> = {
  legal_gateway: "Kimi 模型（经中软法律模型网关）",
  maas_model: "Kimi 模型（经中软网关）",
  byok_model: "Kimi 模型（律所自带密钥，不经中软）",
  private_model: "律所私有模型",
  search_service: "中软检索服务",
  public_web: "公开网页（本机抓取）",
  gate_blocked: "已拦下（没有发出）",
  mock_local: "本机示例（未外发）",
  law_source: "法源服务",
};

export const CITE_STATE_LABELS: Record<string, string> = {
  source_verified: "来源已核",
  version_verified: "版本已核",
  support_pending: "支持待判",
  lawyer_confirmed: "律师已确认",
  intercepted: "已拦截",
  unverified_offline: "未核实（离线）",
};

export const EFFECTIVENESS_LABELS: Record<string, string> = { valid: "现行有效", amended: "已修改", repealed: "已废止" };

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("zh-CN", { hour12: false });
}

/** 相对时间（事项列表“最近活动”）：刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / 日期。纯函数。 */
export function fmtRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const min = Math.floor((now - t) / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d === 1) return "昨天";
  if (d < 30) return `${d} 天前`;
  const dt = new Date(t);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

/** 事项进展（事项列表；Y4 M-1）：等你确认 / 进行中 / 待签发，没有则为空数组。纯函数。 */
export function matterProgress(a: { waiting: number; running: number; pending_review?: number } | undefined): { text: string; tone: "orange" | "blue" | "gray" }[] {
  if (!a) return [];
  const out: { text: string; tone: "orange" | "blue" | "gray" }[] = [];
  if (a.waiting > 0) out.push({ text: `${a.waiting} 项等你确认`, tone: "orange" });
  if (a.running > 0) out.push({ text: `${a.running} 个任务进行中`, tone: "blue" });
  if ((a.pending_review ?? 0) > 0) out.push({ text: `${a.pending_review} 份待签发`, tone: "gray" });
  return out;
}

/**
 * 执行页步骤时刻（Y4 R-12）：律师层显示相对时间（“刚刚”“2 分钟前”），处理细节显示时分秒；悬停都给完整时间。纯函数。
 */
export function stepTime(at: string | undefined, level: "lawyer" | "detail", now = Date.now()): { text: string; title: string } | null {
  if (!at || !Number.isFinite(Date.parse(at))) return null;
  return { text: level === "lawyer" ? fmtRelative(at, now) : fmtShortTime(at), title: fmtTime(at) };
}

export function fmtShortTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString("zh-CN", { hour12: false });
}

/** 立场与法域的显示（经接口或旧版本写入的英文代码也显示为中文；中文原样）。 */
const STANCE_CODES: Record<string, string> = { client_side: "委托人一方", plaintiff: "原告", defendant: "被告", buyer: "买方", seller: "卖方", lessee: "承租方", lessor: "出租方", neutral: "中立" };
const JURISDICTION_CODES: Record<string, string> = { CN: "中国内地", "CN-HK": "中国香港", HK: "中国香港", "CN-MO": "中国澳门", "CN-TW": "中国台湾" };
export function stanceLabel(v: string | null | undefined): string {
  return v ? (STANCE_CODES[v] ?? v) : "—";
}
export function jurisdictionLabel(v: string | null | undefined): string {
  return v ? (JURISDICTION_CODES[v] ?? v) : "—";
}

/** 核对码每 4 位一组显示（Z3 评审 7.0：与成员入组的核对码同一种读法）。 */
export function groupDigits(code: string): string {
  const d = code.replace(/\s+/g, "");
  return d.replace(/(.{4})(?=.)/g, "$1 ");
}

