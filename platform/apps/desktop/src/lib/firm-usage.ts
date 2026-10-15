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
  const warn = r !== null && r >= 1 ? "；本所本月额度已用完，AI 处理暂停，请联系律所管理员" : r !== null && r >= 0.8 ? "；本所本月额度即将用完" : "";
  return `${own}；${firm}${warn}`;
}

const ACTIONS: Readonly<Record<string, string>> = {
  "tenant.create": "开通本所",
  "tenant.enroll_root": "登记律所根公钥",
  "device.register": "设备登记",
  "seat_token.issue": "签发席位凭据",
  "anon_summary.update": "更新事项匿名摘要",
  "draft.create": "起草律所策略或连接器",
  "draft.sign": "管理员签名",
  "draft.publish": "发布律所策略或连接器",
  "connector.remove": "撤下连接器",
  "device.revoke": "吊销设备",
  "seat.revoke": "收回席位",
  "quota.grant": "加量",
  "quota.cap_set": "设置月度上限",
  "license.renew": "续订",
  "license.terminate": "终止订阅",
};

export function auditActionLabel(a: string): string {
  return ACTIONS[a] ?? a;
}

export function auditActorLabel(r: Pick<CpAuditRow, "actor" | "actor_name">): string {
  switch (r.actor.kind) {
    case "device":
      return r.actor_name ? `${r.actor_name}（设备 ${shortId(r.actor.id)}）` : `设备 ${shortId(r.actor.id)}`;
    case "root":
      return "律所根密钥（开通）";
    case "ops":
      return "中软运营";
    default:
      return "中软服务";
  }
}

export function auditTargetLabel(r: Pick<CpAuditRow, "target" | "target_name">): string {
  if (!r.target) return "—";
  return r.target_name ? `${r.target_name}（${shortId(r.target)}）` : shortId(r.target);
}

export function auditResultLabel(result: string): { text: string; tone: "ok" | "warn" | "bad" } {
  if (result === "ok") return { text: "成功", tone: "ok" };
  const [kind, code] = [result.slice(0, result.indexOf(":")), result.slice(result.indexOf(":") + 1)];
  if (kind === "rolled_back") return { text: `未生效（${code}）`, tone: "warn" };
  return { text: `被拒绝（${code}）`, tone: "bad" };
}

/** 取回失败的原因 → 管理员看得懂的说明。 */
export function auditFetchErrorText(code: string): string {
  switch (code) {
    case "cp_audit_rewritten":
      return "中软侧返回的记录与本机此前取回的不一致（云端改写或删除了已给出的历史）：已拒收，本机留存的原记录不变。请联系中软并保留本页导出。";
    case "cp_audit_chain_invalid":
      return "中软侧返回的记录未通过哈希链核验：已拒收。";
    case "cp_audit_page_invalid":
      return "中软侧返回的记录未通过控制面签名核验：已拒收。";
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
  environment_check: "电脑环境自检",
  environment: "软件版本与运行环境",
  schema: "数据库版本",
  runs_30d: "近 30 天任务计数",
  recent_runs: "最近任务的状态与错误代码",
  egress_30d: "近 30 天联网次数",
  audit_30d: "近 30 天操作计数",
  table_rows: "数据量统计",
  logs_7d: "近 7 天运行记录（事件代码与次数）",
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
