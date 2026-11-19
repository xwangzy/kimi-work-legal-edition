/**
 * 发起任务前的检查（第 46 批，主文 §5-1；审计 client §9-1）：要重新登录、客户端版本过旧、本所额度暂停（本期用完 / 律所上限 /
 * 5 小时频率窗口）、个人上限已满时，任务不排队，直接告诉律师原因与办法。纯函数，可单测。
 *
 * - 只对经中软转发的 AI 任务（事项端点 standard）检查：本机流程（不调用 AI）、律所自己的 AI 账号或私有端点不受影响；
 * - 额度只看内核已缓存的最近一次用量视图（控制面签名、本机验过签），不在发起时同步请求控制面；
 *   视图超过 10 分钟、或已过了本期 / 频率窗口的重置时刻就不拦，交给网关兜底（网关拒绝时执行器照样写清原因）。
 */

/** 用到的用量视图字段（control-plane/client.ts QuotaView 的子集）。 */
export interface LaunchQuotaView {
  period: { kind: "month" | "week"; resets_at: string };
  firm: { paused: "cap" | "allowance" | "burst" | null; cap_pct: number | null };
  burst: { hours: number; resets_at: string | null } | null;
  own: { used_ratio: number; enforced: boolean; denominator: "account_limit" | "seat_quota" } | null;
}

export interface LaunchHint {
  /** login = 要重新登录；outdated = 要升级客户端；quota = 本所或个人额度暂停。 */
  kind: "login" | "outdated" | "quota";
  /** 原因代码（给界面选入口与诊断用，不显示）。 */
  code: string;
  /** 给律师看的一句话：发生了什么 + 怎么办。 */
  message: string;
  /** 界面上的入口：login = 页面顶部的登录框；usage = 设置 → 账号与团队 → 用量；null = 没有可点的入口。 */
  action: "login" | "usage" | null;
}

/** 视图超过这个时长就不按它拦（交给网关兜底）。 */
export const QUOTA_VIEW_MAX_AGE_MS = 10 * 60_000;

function hhmm(iso: string | null | undefined): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function passed(iso: string | null | undefined, now: number): boolean {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) && now >= t;
}

export function launchCheck(i: {
  /** 这个任务会不会经中软转发调用 AI（本机流程、律所自己的 AI 为 false）。 */
  viaGateway: boolean;
  /** 内核记下的“要重新登录”原因（null = 没有）。 */
  accountProblem: string | null;
  clientOutdated: { min_version: string | null } | null;
  quota: { view: LaunchQuotaView; at: number } | null;
  now: number;
}): LaunchHint | null {
  if (!i.viaGateway) return null;
  if (i.accountProblem) {
    if (i.accountProblem === "account_disabled") return { kind: "login", code: "account_disabled", message: "账号已停用，AI 任务暂时不能开始：请联系律所管理员（本机的事项和文件照常可用）", action: null };
    if (i.accountProblem === "session_member_mismatch") return { kind: "login", code: "session_member_mismatch", message: "这台电脑登记的是本所另一位成员：请在页面顶部用那位成员的账号登录后再开始", action: "login" };
    return { kind: "login", code: i.accountProblem, message: "登录已失效：请先在页面顶部重新登录，再开始任务（本机的事项和文件照常可用）", action: "login" };
  }
  if (i.clientOutdated) {
    const v = i.clientOutdated.min_version;
    return { kind: "outdated", code: "client_outdated", message: `客户端版本过旧，AI 任务暂时不能开始：请升级到 ${v ? `${v} 或以上` : "最新版本"}（本机的事项和文件照常可用）`, action: null };
  }
  const q = i.quota;
  if (!q || i.now - q.at > QUOTA_VIEW_MAX_AGE_MS || i.now < q.at - 60_000) return null;
  const v = q.view;
  // 已过本期重置时刻：额度已经重置，不按旧视图拦
  if (passed(v.period?.resets_at, i.now)) return null;
  const term = v.period?.kind === "week" ? "本周" : "本月";
  const paused = v.firm?.paused ?? null;
  if (paused === "allowance") return { kind: "quota", code: "quota_exhausted", message: `本所${term} AI 额度已用完：请联系律所管理员加量；下期自动重置`, action: "usage" };
  if (paused === "cap") {
    const cap = typeof v.firm.cap_pct === "number" ? `（本期额度的 ${v.firm.cap_pct}%）` : "";
    return { kind: "quota", code: "quota_cap_reached", message: `已到律所设定的${term} AI 用量上限${cap}：请律所管理员在“设置 → 管理 → 用量”调整上限`, action: "usage" };
  }
  if (paused === "burst" && !passed(v.burst?.resets_at, i.now)) {
    const at = hhmm(v.burst?.resets_at);
    return { kind: "quota", code: "quota_burst", message: `本所最近 ${v.burst?.hours ?? 5} 小时 AI 用量较多，暂时放缓：${at ? `${at} 起恢复` : "几小时内自动恢复"}，届时再开始`, action: "usage" };
  }
  if (v.own && v.own.enforced && v.own.used_ratio >= 1) {
    return { kind: "quota", code: "quota_seat_limit", message: `你${term}的个人 AI 额度已用完：请联系律所管理员调整你的个人上限`, action: "usage" };
  }
  return null;
}
