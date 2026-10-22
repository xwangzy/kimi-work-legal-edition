/**
 * 用量与上限、中软侧操作记录的显示文字（第 9 批 S3/S14）。纯函数，便于用例覆盖。
 * 律师可见的一句话（本机与安全）不出现租约、序号、签名等工程用语；管理员页可以写明。
 */
import type { CpAuditRow, QuotaStatus } from "../api.ts";

/** 点数千分位。 */
export function fmtPoints(n: number | null | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("zh-CN") : "—";
}

/** “2026-10” → “2026 年 10 月”。 */
export function periodLabel(p: string | undefined): string {
  const m = /^(\d{4})-(\d{2})$/.exec(p ?? "");
  return m ? `${m[1]} 年 ${Number(m[2])} 月` : "本月";
}

/**
 * 本月已用占上限的比例（0–1；不设上限为 null）。只按已结算的用量：网关预领、尚未用掉的部分（in_flight）不算“已用”，
 * 否则设了上限后第一次请求就会显示“已用完”。
 */
export function capRatio(q: QuotaStatus): number | null {
  if (q.cap_monthly === null || q.cap_monthly === undefined || q.period_used === undefined) return null;
  if (q.cap_monthly === 0) return 1;
  return Math.min(1, q.period_used / q.cap_monthly);
}

/** 律师在“本机与安全”看到的一句话。 */
export function quotaLawyerLine(q: QuotaStatus | null): string {
  if (!q) return "读取中…";
  if (q.mode !== "control_plane") return "开发形态：不统计本所用量";
  const own = q.own ? `你本月用了 ${fmtPoints(q.own.points)} 点` : "你本月还没有用量";
  const firm = q.cap_monthly === null || q.cap_monthly === undefined ? `本所 ${fmtPoints(q.period_used)} 点（未设上限）` : `本所 ${fmtPoints(q.period_used)} / ${fmtPoints(q.cap_monthly)} 点`;
  const r = capRatio(q);
  // 购买额度用完同样暂停（复核 S9A-13：成员看不到余额，但要知道为什么停了）
  const warn =
    q.paused === "pool"
      ? "；本所购买的 AI 额度已用完，AI 处理暂停，请联系律所管理员"
      : q.paused === "cap" || (r !== null && r >= 1)
        ? "；本所本月额度已用完，AI 处理暂停，请联系律所管理员"
        : r !== null && r >= 0.8
          ? "；本所本月额度即将用完"
          : "";
  return `${own}；${firm}${warn}`;
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
  "quota.cap_set": "设置月度上限",
  "license.renew": "续订",
  "license.terminate": "终止订阅",
};

export function auditActionLabel(a: string): string {
  return ACTIONS[a] ?? a;
}

/** 数值明细 → 一句话（复核 S9A-25：上限改成多少点等在页面上可见）。 */
export function auditDetailLabel(d: Record<string, number> | undefined): string {
  if (!d) return "";
  const parts: string[] = [];
  if (d.uncapped) parts.push("不设上限");
  if (d.cap !== undefined) parts.push(`上限 ${fmtPoints(d.cap)} 点`);
  if (d.points !== undefined && d.seats === undefined) parts.push(`${fmtPoints(d.points)} 点`);
  if (d.seats !== undefined) parts.push(`席位 ${d.seats}、点数 ${fmtPoints(d.points ?? 0)}`);
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
