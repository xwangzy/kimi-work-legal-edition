/**
 * 用量与上限、中软侧操作记录的显示文字（第 9 批 S3/S14）。纯函数，便于用例覆盖。
 * 律师可见的一句话（本机与安全）不出现租约、序号、签名等工程用语；管理员页可以写明。
 */
import type { CpAuditRow, QuotaStatus } from "../api.ts";

/** 次数等整数的千分位。 */
export function fmtCount(n: number | null | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("zh-CN") : "—";
}

/**
 * 比例（0–1）→ 百分比文字（第 40 批：用量一律按百分比）：不到 0.1% 写“<0.1%”；10% 以下保留一位小数；其余取整。
 */
export function fmtPct(r: number | null | undefined): string {
  if (typeof r !== "number" || !Number.isFinite(r)) return "—";
  const p = r * 100;
  if (p > 0 && p < 0.1) return "<0.1%";
  return `${p < 10 ? (Math.round(p * 10) / 10).toFixed(1).replace(/\.0$/, "") : Math.round(p)}%`;
}

/** “2026-10” → “2026 年 10 月”。 */
export function periodLabel(p: string | undefined): string {
  const m = /^(\d{4})-(\d{2})$/.exec(p ?? "");
  return m ? `${m[1]} 年 ${Number(m[2])} 月` : "本月";
}

/** 重置时刻（北京时间）→ “12 月 1 日重置”。 */
export function resetLabel(iso: string | undefined): string {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return "每月 1 日重置";
  const d = new Date(t + 8 * 3600_000);
  return `${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日重置`;
}

/** 用量水位：<80% 正常、≥80% 偏高、≥100%（或已暂停）用完。上限按本月总额度的百分比折算。 */
export function usageTone(q: Pick<QuotaStatus, "used_ratio" | "cap_pct" | "paused">): "ok" | "high" | "full" {
  const r = q.used_ratio ?? 0;
  const limit = q.cap_pct ? q.cap_pct / 100 : 1;
  if (q.paused || r >= limit) return "full";
  return r >= limit * 0.8 ? "high" : "ok";
}

/** 律师在“本机与安全”看到的一句话。 */
export function quotaLawyerLine(q: QuotaStatus | null): string {
  if (!q) return "读取中…";
  if (q.mode !== "control_plane") return "开发形态：不统计本所用量";
  const own = q.own && q.own.requests > 0 ? `你本月已用个人份额的 ${fmtPct(q.own.used_ratio)}` : "你本月还没有用量";
  const firm = `本所已用 ${fmtPct(q.used_ratio)}${q.cap_pct ? `（上限 ${q.cap_pct}%）` : ""}`;
  const tone = usageTone(q);
  const warn =
    q.paused === "allowance"
      ? "；本所本月 AI 额度已用完，AI 处理暂停，请联系律所管理员加量"
      : q.paused === "cap" || tone === "full"
        ? "；本所本月用量已到律所设的上限，AI 处理暂停，请联系律所管理员"
        : tone === "high"
          ? "；本所本月额度即将用完"
          : "";
  return `${own}；${firm}；${resetLabel(q.resets_at)}${warn}`;
}

/** Kimi 账号的一行显示：“张**（尾号 0000）”。 */
export function kimiAccountLabel(k: { nickname: string; phone_tail: string | null } | null | undefined): string {
  if (!k) return "未绑定";
  return k.phone_tail ? `${k.nickname}（尾号 ${k.phone_tail}）` : k.nickname;
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
  "quota.grant": "加量（旧版点数）",
  "quota.boost": "加量包",
  "quota.cap_set": "设置月度上限",
  "plan.change": "调整套餐或席位",
  "kimi.policy": "Kimi 账号登录要求",
  "kimi.bind": "绑定 Kimi 账号",
  "kimi.unbind": "解绑 Kimi 账号",
  "license.renew": "续订",
  "license.terminate": "终止订阅",
};

export function auditActionLabel(a: string): string {
  return ACTIONS[a] ?? a;
}

/**
 * 数值明细 → 一句话（复核 S9A-25：上限改成多少等在页面上可见）。第 40 批起按百分比；
 * 第 39 批之前的记录是点数（流水不可改），照原样标“旧版计量”。
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
  if (d.required !== undefined) parts.push(d.required ? "要求用 Kimi 账号登录" : "不强制 Kimi 账号登录");
  if (d.cap !== undefined) parts.push(`上限 ${fmtCount(d.cap)}（旧版计量）`);
  if (d.points !== undefined && d.points > 0) parts.push(`${fmtCount(d.points)}（旧版计量）`);
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
  kimi_account_required: "须先用 Kimi 账号登录",
  kimi_account_in_use: "Kimi 账号已被本所另一位成员绑定",
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
