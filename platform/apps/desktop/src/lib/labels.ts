/** 界面文案映射（只说事实；不用“绝对安全”“数据不出所”等禁用词——第 02 篇 §12）。 */
import type { BasisValue, RunMode } from "../api.ts";

export const MODE_LABELS: Record<RunMode, string> = { chat: "问答（只读）", manual: "手动", default: "默认", auto: "自动" };
export const MODE_HINTS: Record<RunMode, string> = {
  chat: "只读材料、不写不执行；检索按规则",
  manual: "每一步都先问你",
  default: "执行域内的读写与代码直接执行；跨边界动作逐项确认",
  auto: "预算硬上限内自动；开始时预授权的跨边界范围自动通过，其余仍确认；产物只为草稿",
};
export const PREAUTH_LABELS: Record<string, string> = {
  search_generalized: "泛化后的检索（当事人名称改写为“某公司/某人”后发出）",
  fetch_allowlisted: "白名单站点抓取",
  connector_readonly: "只读连接器",
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
export function artifactName(a: { kind: string; filename: string }): string {
  return ["a1_workspace_file", "agent_table", "agent_report"].includes(a.kind) ? a.filename : (ARTIFACT_LABELS[a.kind] ?? a.filename);
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
  a1_agent_draft: "Agent 草稿",
  a1_workspace_file: "工作区文件（草稿）",
  revision_draft: "修订稿（Word 修订痕迹）",
  agent_table: "表格（草稿）",
  agent_report: "文书（草稿）",
  final_message: "Agent 回复",
  a1_agent_draft_partial: "Agent 草稿（部分完成）",
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
  gate_blocked: "出站闸门拦截（未发出）",
  mock_local: "本机模拟（未外发）",
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

export function fmtShortTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString("zh-CN", { hour12: false });
}
