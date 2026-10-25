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
  standard: "Kimi AI（经中软转发，发送前姓名证件换成代号）",
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

/** 成果状态（交付件页、执行页版本记录同一份）。 */
export const ARTIFACT_STATUS_LABELS: Record<string, string> = { draft: "草稿", pending_review: "待复核", approved: "已签发", rejected: "已退回", superseded: "已被替代" };

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
  "s2.case_file": "整理案卷",
  "s6.redaction": "对外脱敏",
  "a1.agent_task": "通用任务",
};

/** 成果在列表里的名称：Agent 产出的文件用文件名（同一任务可能有多份），其余用类别名。 */
/**
 * 交付件名称（UIUX 增量评审 D-2）：Agent 成果有内容标题（内核取第一行）时用标题，否则用文件名；工作流成果用固定名称。
 * 标题是令牌形态，传入 restore 才还原代号（下拉框里不能渲染胶囊）。
 */
export function artifactName(a: { kind: string; filename: string; title?: string | null; run_title?: string | null; run_goal?: string | null }, restore?: (t: string) => string): string {
  const agentKind = ["a1_workspace_file", "agent_table", "agent_report", "a1_agent_draft", "a1_agent_draft_partial"].includes(a.kind);
  // 审查意见表、审阅表按所审的合同或表命名（同一事项可有多份），用文件名去掉扩展名（v9.4 第 19 批）
  // v9.4 第 20 批：意见表 Word 版、据审阅表起草的证据目录与尽调发现同样按文件名
  if (["review_table", "review_grid", "review_table_docx", "evidence_index", "dd_findings"].includes(a.kind)) return a.filename.replace(/\.(xlsx|docx)$/i, "");
  if (!agentKind) return ARTIFACT_LABELS[a.kind] ?? a.filename;
  const t = a.title ? (restore ? restore(a.title) : a.title) : null;
  // 助手草稿有标题时写“标题（草稿）”，没有标题时沿用固定名称；标题自己已带“（草稿）”时不再重复（v9.4 走查：“研究备忘（草稿）（草稿）”）
  if (a.kind === "a1_agent_draft" || a.kind === "a1_agent_draft_partial") {
    // 第一行是一句话（以句号等结尾，如“时间线草稿已生成。”）不是标题：用固定名称（第 26 批走查）
    // 第 27 批（评审 U3-09）：这时用所属任务的名字（场景卡名或任务说明前 30 字），两次任务的草稿不再都叫“助手草稿”
    if (!t || /[。！？!?]\s*$/.test(t)) {
      const rn = a.run_title || (a.run_goal ?? "").trim() ? runName({ title: a.run_title ?? null, goal: a.run_goal ?? "" }) : null;
      return rn ? `${rn}（${a.kind === "a1_agent_draft" ? "草稿" : "部分完成"}）` : ARTIFACT_LABELS[a.kind]!;
    }
    const bare = stripMarkdownInline(t).replace(/[（(]\s*(草稿|初稿|内部稿)\s*[）)]\s*$/, "").trim();
    return `${bare}（${a.kind === "a1_agent_draft" ? "草稿" : "部分完成"}）`;
  }
  // 没有内容标题时用文件名，去掉扩展名（第 26 批走查：“案情时间线（草稿）.docx”；下载按钮已写明 Word / Excel）
  return t ?? a.filename.replace(/\.(docx|xlsx|md|txt|csv|pdf)$/i, "");
}

/** 去掉行内 Markdown 记号（粗体、斜体、行内代码、链接），用于摘要与标题这类纯文字位置。 */
export function stripMarkdownInline(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(^|[^*])\*(?!\s)([^*]+?)\*(?!\*)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}

export const ARTIFACT_LABELS: Record<string, string> = {
  s1_redline: "修订稿（原生修订）",
  s1_clean: "清洁稿",
  s1_opinion: "审查意见书（内部稿）",
  s1_issue_table: "条款问题表",
  s1b_report: "回稿比对报告",
  s1b_diff_table: "回稿差异表",
  // 整理案卷的六份成果（v9.4：原来显示带任务编号尾巴的文件名）
  s2_catalog: "案卷总目录",
  s2_timeline: "事实时间轴",
  s2_evidence_catalog: "证据目录",
  s2_matrix: "争点证据矩阵（框架）",
  s2_supplement: "补证清单",
  s2_quality_report: "材料质量报告",
  s6_redacted: "脱敏件",
  s6_report: "脱敏报告",
  a1_agent_draft: "助手草稿",
  a1_workspace_file: "工作区文件（草稿）",
  revision_draft: "修订稿（Word 修订痕迹）",
  agent_table: "表格（草稿）",
  review_table: "审查意见表",
  review_grid: "审阅表（Excel）",
  review_table_docx: "审查意见表（Word）",
  evidence_index: "证据目录（据审阅表）",
  dd_findings: "尽调发现（据审阅表）",
  agent_report: "文书（草稿）",
  final_message: "助手回复",
  a1_agent_draft_partial: "助手草稿（部分完成）",
  consent_notice: "当事人告知函（草稿）",
};

/** 受众（第 03 篇 §12：审批对象绑定受众；按受众分版）。 */
export const AUDIENCE_LABELS: Record<string, string> = { internal: "内部", client: "客户", counterparty: "相对方", court: "法院" };

export const DEST_LABELS: Record<string, string> = {
  // 第 27 批（评审 U3-19）：同一服务一个叫法，与开始前确认一致
  legal_gateway: "Kimi AI（经中软转发）",
  maas_model: "Kimi AI（经中软转发）",
  byok_model: "Kimi AI（律所自己的账号，不经中软）",
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

const pad2 = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
const hm = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

/** 完整时刻（有效期、签发时刻、悬停提示）：“2026年10月19日 14:40”，律师层不显示秒，不用斜杠（Z3 #14）。纯函数。 */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${ymd(d)} ${hm(d)}`;
}

/** 只要日期：“2026年10月19日”。纯函数。 */
export function fmtDate(iso: string | number | Date | null | undefined): string {
  if (iso === null || iso === undefined || iso === "") return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : ymd(d);
}

/**
 * 列表里的时刻（Z3 #14）：今天写“刚刚 / n 分钟前 / 14:40”，今年写“10月19日 14:40”，往年写“2025年10月19日”；
 * 悬停用 fmtTime 给完整时刻。纯函数。
 */
export function fmtWhen(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const d = new Date(t);
  const n = new Date(now);
  const min = Math.floor((now - t) / 60_000);
  if (min >= 0 && min < 1) return "刚刚";
  if (min >= 0 && min < 60) return `${min} 分钟前`;
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return hm(d);
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm(d)}`;
  return ymd(d);
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
  return dt.getFullYear() === new Date(now).getFullYear() ? `${dt.getMonth() + 1}月${dt.getDate()}日` : ymd(dt);
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

/** 时分秒：只用于“处理细节”层（执行页细节、诊断），律师层用 fmtWhen。 */
export function fmtShortTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${hm(d)}:${pad2(d.getSeconds())}`;
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


/**
 * 材料解析标记 → 律师话术（复核 B13-U07：材料表原先把 xlsx_values_only 这类标记原样显示）。
 * 键为标记本身或冒号前的前缀（scanned_pages:3）；encoding_* 单独处理；空串表示不必提示；未登记的标记显示“有提示”。
 * 门禁：apps/desktop/test/parse-flags.test.ts 扫描内核解析器里出现的全部标记，须都在这里有对应。
 */
export const PARSE_FLAG_TEXT: Record<string, string | ((n: string) => string)> = {
  plain_text: "",
  pdf_pipeline: "",
  image_ocr: "图片里的文字是识别出来的，请核对",
  v0_crude_docx_parser: "只读了文字",
  no_page_anchors: "没有页码",
  tables_flattened: "表格按文字读取",
  tables_as_rows: "表格按行读取（合并单元格可能错位）",
  comments_revisions_ignored: "批注与修订没有读取",
  xlsx_values_only: "只读了表格里的值，公式没有计算",
  xlsx_truncated: "表格太大，只读了前一部分",
  xlsx_dates_raw: "部分日期显示为数字",
  scanned_pages: (n) => `${n} 页是扫描件（文字是识别出来的）`,
  ocr_low_quality_pages: (n) => `${n} 页识别不清，请核对原件`,
  unreadable_pages: (n) => `${n} 页没有读出文字`,
  ocr_mock_engine: "文字识别为演示引擎，结果不可信",
  ocr_unavailable: "本机文字识别不可用，扫描页没有读出文字",
};

export function parseFlagsText(flags: readonly string[]): string {
  const notes: string[] = [];
  let unknown = false;
  for (const f of flags) {
    if (/^encoding_/.test(f)) {
      notes.push(`按 ${f.slice("encoding_".length).toUpperCase()} 编码读取`);
      continue;
    }
    const [key, arg = ""] = f.split(":", 2) as [string, string?];
    const t = PARSE_FLAG_TEXT[key];
    if (t === undefined) unknown = true;
    else {
      const s = typeof t === "function" ? t(arg) : t;
      if (s) notes.push(s);
    }
  }
  if (notes.length === 0) return unknown ? "已读取（有提示）" : "已读取";
  return `已读取：${notes.join("；")}${unknown ? "（另有提示）" : ""}`;
}

/** 输入框顶部事项名（Z3 #12、M-4）：超过 max 字截断加“…”，悬停看全称。纯函数。 */
export function clipTitle(title: string, max = 28): string {
  const chars = [...title];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : title;
}

/**
 * 任务名（第 26 批）：场景卡发起的任务用卡名（内核快照里的 title）；律师自己描述的任务用描述的前 max 字；都没有时用场景名。
 * 不拿拼好的任务说明当标题（走查：执行页、首页“继续工作”的标题是“请审查这份买卖合同，我方立场以事项为准；”）。
 */
export function runName(r: { title?: string | null; goal?: string | null; scenario?: string | null; input_snapshot?: unknown } | null | undefined, max = 30): string {
  const snap = r?.input_snapshot && typeof r.input_snapshot === "object" ? (r.input_snapshot as { title?: unknown; goal?: unknown }) : null;
  const title = String(r?.title ?? (typeof snap?.title === "string" ? snap.title : "")).trim();
  if (title) return title;
  const goal = String(r?.goal ?? (typeof snap?.goal === "string" ? snap.goal : ""))
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[；;，,、：:]+$/, "");
  if (goal) return clipTitle(goal, max);
  return SCENARIO_LABELS[String(r?.scenario ?? "")] ?? "任务";
}

/**
 * 方法名（第 26 批）：律师看到的方法名不带内部档位与机制词——“· 试用（通用辅助）”“（受限文书）”“（风险卡）”。
 * 试用档位在“方法与模板”页另用标签说明；时间线、方法行、工作台协议条都用这个名字。
 */
export function methodName(title: string): string {
  return title
    .replace(/\s*·\s*试用.*$/, "")
    .replace(/[（(](受限文书|风险卡)[）)]/g, "")
    .trim();
}

/**
 * 设置 · 通用的版本号（Z3 #30、V-i）：律师层显示安装包版本“5.0.0”，不显示内部构建标记（如“-g0”）；
 * 开发形态没有安装包版本时写“开发版”。原始标记只在“管理 → 技术支持 → 诊断”显示。纯函数。
 */
export function displayVersion(appVersion: string | null | undefined, kernelVersion: string | null | undefined): string {
  const pick = appVersion || kernelVersion;
  if (!pick) return "—";
  const m = /^v?(\d+\.\d+\.\d+)/.exec(pick);
  if (!m) return "—";
  return appVersion ? m[1]! : `${m[1]}（开发版）`;
}

/** 确认卡的材料一行：至多列 3 个文件名，多了写“等 n 份”；没有指定材料时说按需读取。 */
export function materialsLine(n: number, names?: string[]): string {
  if (n === 0) return "没有指定：按需读取本事项的材料";
  const list = (names ?? []).filter(Boolean);
  if (list.length === 0) return `${n} 份`;
  return `${list.slice(0, 3).join("、")}${n > 3 ? ` 等 ${n} 份` : ""}`;
}
