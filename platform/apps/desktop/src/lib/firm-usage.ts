/**
 * 用量与上限、中软侧操作记录的显示文字（第 9 批 S3/S14；第 44 批 v2：一把尺子——tokens 或元，按 Kimi 的额度呈现）。纯函数，便于用例覆盖。
 * 律师可见的文字不出现租约、序号、签名等工程用语，也不出现点数一类的说法；单位只有 tokens 与元（中软的单位名 unit_label 原样显示）。
 */
import type { CpAuditRow, QuotaStatus } from "../api.ts";

/** 次数等整数的千分位。 */
export function fmtCount(n: number | null | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("zh-CN") : "—";
}

/**
 * 比例（0–1）→ 百分比文字：不到 0.1% 写“<0.1%”；10% 以下保留一位小数；其余取整。
 */
export function fmtPct(r: number | null | undefined): string {
  if (typeof r !== "number" || !Number.isFinite(r)) return "—";
  const p = r * 100;
  if (p > 0 && p < 0.1) return "<0.1%";
  return `${p < 10 ? (Math.round(p * 10) / 10).toFixed(1).replace(/\.0$/, "") : Math.round(p)}%`;
}

/**
 * 用量数 → 文字：tokens 过万写“万”、过亿写“亿”（保留一位小数）；元保留两位小数（不到 0.01 元写“不到 0.01 元”）。
 * label = 中软给的单位名（tokens 或元）。
 */
export function fmtAmount(n: number | null | undefined, unit: "tokens" | "cny" | undefined, label?: string): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  if (unit === "cny") {
    const yuan = label ?? "元";
    if (n > 0 && n < 0.01) return `不到 0.01 ${yuan}`;
    return `${n.toLocaleString("zh-CN", { minimumFractionDigits: n >= 100 ? 0 : 2, maximumFractionDigits: 2 })} ${yuan}`;
  }
  const u = label ?? "tokens";
  const one = (x: number) => (Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, "");
  if (Math.abs(n) >= 1e8) return `${one(n / 1e8)} 亿 ${u}`;
  if (Math.abs(n) >= 1e4) return `${one(n / 1e4)} 万 ${u}`;
  return `${Math.round(n).toLocaleString("zh-CN")} ${u}`;
}

const BJ = 8 * 3600_000;
function bj(iso: string | null | undefined): Date | null {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? new Date(t + BJ) : null;
}

/** 时刻（北京时间）→ “12 月 1 日 0:00”。 */
export function atLabel(iso: string | null | undefined): string {
  const d = bj(iso);
  if (!d) return "—";
  return `${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日 ${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** “2026-10” → “2026 年 10 月”；周期对象按种类写“本周（11 月 10 日起）”。 */
export function periodLabel(p: string | QuotaStatus["period"] | undefined): string {
  const key = typeof p === "string" ? p : p?.key;
  const m = /^(\d{4})-(\d{2})$/.exec(key ?? "");
  if (m) return `${m[1]} 年 ${Number(m[2])} 月`;
  if (typeof p === "object" && p?.kind === "week") {
    const d = bj(p.start);
    return d ? `本周（${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日起）` : "本周";
  }
  return "本期";
}

/** 统计周期的起止（北京时间）：“11 月 1 日 – 11 月 30 日”。 */
export function periodRange(p: QuotaStatus["period"] | undefined): string {
  const s = bj(p?.start);
  const e = bj(p?.resets_at ? new Date(Date.parse(p.resets_at) - 1).toISOString() : null);
  if (!s || !e) return "";
  return `${s.getUTCMonth() + 1} 月 ${s.getUTCDate()} 日 – ${e.getUTCMonth() + 1} 月 ${e.getUTCDate()} 日`;
}

/** 重置时刻 → “将于 12 月 1 日 0:00 重置”。 */
export function resetLabel(iso: string | undefined): string {
  return bj(iso) ? `将于 ${atLabel(iso)} 重置` : "每期开始时重置";
}

/** 用量水位：<80% 正常、≥80% 提醒、≥100%（或已暂停）用完。上限按本期总额度的百分比折算。 */
export function usageTone(f: { used_ratio?: number | null; cap_pct?: number | null; paused?: string | null } | null | undefined): "ok" | "high" | "full" {
  const r = f?.used_ratio ?? 0;
  const limit = f?.cap_pct ? f.cap_pct / 100 : 1;
  if (f?.paused || r >= limit) return "full";
  return r >= limit * 0.8 ? "high" : "ok";
}

/** 比例自身的水位（个人、5 小时窗口、按成员）：≥80% 提醒、≥100% 用完。 */
export function ratioTone(r: number | null | undefined): "ok" | "high" | "full" {
  const x = r ?? 0;
  return x >= 1 ? "full" : x >= 0.8 ? "high" : "ok";
}

/** “剩余 x%（约 N）”：总额度看得到时（管理员与合伙人）带上约数。 */
export function remainingLine(q: QuotaStatus): string {
  const f = q.firm;
  if (!f) return "";
  const rem = `剩余 ${fmtPct(f.remaining_ratio)}`;
  if (f.total === null || f.used === null) return rem;
  return `${rem}（约 ${fmtAmount(Math.max(0, f.total - f.used), q.unit, q.unit_label)}）`;
}

/** 本人用量的分母来源。 */
export function ownDenominatorText(own: NonNullable<QuotaStatus["own"]>): string {
  return own.denominator === "account_limit" ? "个人上限（管理员设置）" : "每人额度（套餐约定，仅作参考、不限制）";
}

/** 暂停原因 → 横幅文字。 */
export function pausedText(q: QuotaStatus): string | null {
  const f = q.firm;
  if (!f?.paused) return null;
  const when = bj(q.period?.resets_at) ? `，或等 ${atLabel(q.period!.resets_at)} 重置` : "";
  if (f.paused === "allowance") return `本所${periodLabel(q.period)}的 AI 额度已用完（100%）：AI 处理暂停，请联系律所管理员加量${when}。`;
  if (f.paused === "cap") return `本所${periodLabel(q.period)}的用量已到律所设的上限（${f.cap_pct}%）：AI 处理暂停，直到管理员调高上限${when}。`;
  const back = q.burst?.resets_at ? `，${atLabel(q.burst.resets_at)} 起恢复` : "";
  return `最近 ${q.burst?.hours ?? 5} 小时用得太快（超过本期额度的 ${q.burst?.pct ?? "—"}%）：AI 处理暂时放缓${back}。`;
}

/** 超过 80% 的提醒（未暂停时）。 */
export function warnText(q: QuotaStatus): string | null {
  const f = q.firm;
  if (!f || f.paused) return null;
  if (usageTone(f) === "high") return `本所${periodLabel(q.period)}已用 ${fmtPct(f.used_ratio)}${f.cap_pct ? `（上限 ${f.cap_pct}%）` : ""}，额度即将用完。`;
  if (q.burst && ratioTone(q.burst.used_ratio) !== "ok") return `最近 ${q.burst.hours} 小时已用到频率上限的 ${fmtPct(q.burst.used_ratio)}，稍后再发大任务更稳妥。`;
  return null;
}

/** 本期含旧计量口径的用量说明。 */
export function legacyNote(q: QuotaStatus): string | null {
  const l = q.firm?.legacy_used_ratio;
  return typeof l === "number" && l > 0 ? `本期含旧计量口径的用量 ${fmtPct(l)}（换用新计量之前的部分，按比例计入）。` : null;
}

/** 律师在“账号与团队”看到的一句话。 */
export function quotaLawyerLine(q: QuotaStatus | null): string {
  if (!q) return "读取中…";
  if (q.mode !== "control_plane" || !q.firm) return "开发形态：不统计本所用量";
  const own = q.own && q.own.requests > 0 ? `你本期已用${q.own.denominator === "account_limit" ? "个人上限" : "每人额度"}的 ${fmtPct(q.own.used_ratio)}` : "你本期还没有用量";
  const firm = `本所已用 ${fmtPct(q.firm.used_ratio)}${q.firm.cap_pct ? `（上限 ${q.firm.cap_pct}%）` : ""}`;
  const tone = usageTone(q.firm);
  const warn =
    q.firm.paused === "allowance"
      ? "；本所本期 AI 额度已用完，AI 处理暂停，请联系律所管理员加量"
      : q.firm.paused === "cap" || (tone === "full" && q.firm.paused !== "burst")
        ? "；本所本期用量已到律所设的上限，AI 处理暂停，请联系律所管理员"
        : q.firm.paused === "burst"
          ? "；最近 5 小时用得太快，AI 处理暂时放缓"
          : tone === "high"
            ? "；本所本期额度即将用完"
            : "";
  return `${own}；${firm}；${resetLabel(q.period?.resets_at)}${warn}`;
}

/** 模型别名 → 显示名（主任务 / 子任务；别的别名原样）。 */
export function modelLabel(alias: string): string {
  if (alias === "legal/k3") return "Kimi K3（主任务）";
  if (alias === "legal/k2.6") return "Kimi K2.6（辅助步骤）";
  return alias.replace(/^legal\//, "");
}

const ACTIONS: Readonly<Record<string, string>> = {
  "tenant.create": "开通本所",
  "tenant.enroll_root": "登记律所根公钥",
  "device.register": "设备登记",
  "seat_token.issue": "签发席位凭据",
  "anon_summary.update": "更新事项匿名摘要",
  "draft.create": "起草律所策略或律所系统接入",
  "draft.sign": "管理员签名",
  "draft.publish": "发布律所策略或律所系统接入",
  "connector.remove": "撤下律所系统接入",
  "device.revoke": "停用设备",
  "seat.revoke": "收回席位",
  "seat.assign": "分配席位",
  "support_token.issue": "签发支持凭据（诊断包上传）",
  "quota.grant": "加量",
  "quota.boost": "加量包",
  "quota.cap_set": "设置月度上限",
  "plan.change": "调整套餐或席位",
  "activation.issue": "发出开通码",
  "activation.revoke": "作废开通码",
  "activation.redeem": "使用开通码",
  "invitation.create": "发出邀请",
  "join.request": "申请加入本所",
  "join.withdraw": "撤回入组申请",
  "account.create": "建立账号",
  "account.register": "注册账号",
  "account.disable": "停用账号",
  "account.enable": "启用账号",
  "account.limits": "调整个人上限或设备数",
  "account.login": "登录",
  "account.logout": "退出登录",
  "account.password_change": "修改密码",
  "account.password_reset": "重置密码",
  "account.password_setup": "设置密码",
  "account.reset_code": "发出重置码",
  "account.session_revoke": "让一处登录下线",
  "account.sessions_revoke": "让全部登录下线",
  "account.device_unbind": "解绑电脑",
  "accounts.policy": "账号登录要求",
  "license.renew": "续订",
  "license.terminate": "终止订阅",
};

export function auditActionLabel(a: string): string {
  return ACTIONS[a] ?? a;
}

/**
 * 数值明细 → 一句话（复核 S9A-25：上限改成多少等在页面上可见）。第 40 批起按百分比；
 * 第 39 批之前的记录带的是旧计量的数（流水不可改）：只写“加量”“改上限”，不再显示旧单位的数。
 */
export function auditDetailLabel(d: Record<string, number> | undefined): string {
  if (!d) return "";
  const parts: string[] = [];
  if (d.uncapped) parts.push("不设上限");
  if (d.cap_pct !== undefined) parts.push(`上限 ${d.cap_pct}%`);
  if (d.pct !== undefined) parts.push(`本月额度 +${d.pct}%`);
  if (d.custom) parts.push("定制加量");
  if (d.plan) parts.push("改套餐");
  if (d.seats !== undefined) parts.push(`席位 ${d.seats}`);
  if (d.required !== undefined) parts.push(d.required ? "要求登录账号" : "不强制登录账号");
  if (d.cap !== undefined && d.cap_pct === undefined) parts.push("改上限");
  if (d.points !== undefined && d.points > 0 && d.pct === undefined) parts.push("加量");
  if (d.days !== undefined) parts.push(`${d.days} 天`);
  return parts.join("，");
}

export function auditActorLabel(r: Pick<CpAuditRow, "actor" | "actor_name">): string {
  switch (r.actor.kind) {
    case "device":
      return r.actor_name ? `${r.actor_name}（设备 ${shortId(r.actor.id)}）` : `设备 ${shortId(r.actor.id)}`;
    case "root":
      return "律所根密钥（开通）";
    case "ops":
      // 经运营接口的操作记到具体的运营人员（v9.3 A-10：运营编号是工号，不是姓名）；早先的与进程内的记录只有笼统的“中软运营”
      return r.actor.id === "ops" ? "中软运营" : `中软运营（${shortId(r.actor.id)}）`;
    default:
      return "中软服务";
  }
}

export function auditTargetLabel(r: Pick<CpAuditRow, "target" | "target_name">): string {
  if (!r.target) return "—";
  return r.target_name ? `${r.target_name}（${shortId(r.target)}）` : shortId(r.target);
}

const RESULT_CODES: Readonly<Record<string, string>> = {
  admin_required: "需要管理员设备",
  revoker_required: "需要管理员或合伙人设备",
  license_expired: "订阅已到期",
  no_seat: "没有席位",
  seat_revoked: "席位已收回",
  device_revoked: "设备已停用",
  cap_invalid: "上限不合法",
  session_required: "须先登录账号",
  session_invalid: "登录已失效",
  account_disabled: "账号已停用",
  device_limit: "设备数已满",
  draft_stale: "草稿已过时",
  admin_threshold_not_met: "管理员签名不足",
  state_persist_failed: "写盘失败",
  audit_unavailable: "记录写入失败",
  invalid_request: "请求不合法",
};

export function auditResultLabel(result: string): { text: string; tone: "ok" | "warn" | "bad" } {
  if (result === "ok") return { text: "成功", tone: "ok" };
  const [kind, code] = [result.slice(0, result.indexOf(":")), result.slice(result.indexOf(":") + 1)];
  const why = RESULT_CODES[code] ?? code;
  if (kind === "rolled_back") return { text: `未生效（${why}）`, tone: "warn" };
  return { text: `被拒绝（${why}）`, tone: "bad" };
}

/** 取回失败的原因 → 管理员看得懂的说明。 */
export function auditFetchErrorText(code: string): string {
  switch (code) {
    case "cp_audit_rewritten":
      return "中软侧返回的记录与本机此前取回的不一致（云端改写或删除了已给出的历史）：已拒收，本机留存的原记录不变。请联系中软并保留本页导出。";
    case "cp_audit_chain_invalid":
      return "中软侧返回的记录未通过哈希链核验：已拒收。";
    case "cp_audit_page_invalid":
      return "中软侧返回的记录未通过 Kimi Work 服务的签名核验：已拒收。";
    case "device_role_required":
      return "这台电脑的设备证书不是管理员或合伙人设备，中软不提供操作记录：下面是本机已留存的记录。";
    default:
      return `暂时取不到最新记录（${code}）：下面是本机已留存的记录。`;
  }
}

const DIAG_SECTIONS: Readonly<Record<string, string | null>> = {
  format: null,
  created_at: null,
  device_id: "设备编号",
  kernel: "后台服务状态",
  execution_domain_available: "代码运行环境",
  environment_check: "电脑环境自检（含 BitLocker、同步盘与杀毒软件产品名）",
  environment: "软件版本与运行环境（操作系统、处理器、内存）",
  schema: "数据库版本",
  runs_30d: "近 30 天任务计数",
  recent_runs: "最近 20 个任务的状态、错误代码、开始时刻与时长",
  egress_30d: "近 30 天联网次数",
  audit_30d: "近 30 天操作计数",
  table_rows: "数据量统计（事项、文档、任务等的条数）",
  logs_7d: "近 7 天运行记录（事件代码、时间与次数，最多 200 条）",
};

/** 诊断包分节 → 律师看得懂的名称（不认识的写“其他统计”，只出现一次）。 */
export function diagSectionLabels(sections: readonly string[]): string[] {
  const out: string[] = [];
  for (const s of sections) {
    const label = s in DIAG_SECTIONS ? DIAG_SECTIONS[s] : "其他统计";
    if (label && !out.includes(label)) out.push(label);
  }
  return out;
}

function shortId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}
