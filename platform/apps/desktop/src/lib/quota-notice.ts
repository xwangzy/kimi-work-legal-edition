/**
 * 首页输入框上方的额度提示条与用户卡上的额度小字（第 47 批，对照 Kimi Work：输入框顶边“月额度已不足 10%，将于 11-27 重置”）。纯函数。
 *
 * 口径与“设置 · 套餐与用量”同一把尺子（lib/firm-usage.ts）：比例只来自控制面按真实 token 或金额算出的 used_ratio / remaining_ratio，
 * 不做任何换算；本地开发与试用版（没有控制面）一律不提示。
 * 优先级：已暂停（用完 / 到上限 / 5 小时过快）> 个人上限用完 > 剩余不足 10% > 个人上限剩余不足 10%。
 * 第 66 批（V40 P0-5）：面向个人律师，提示一律说“你的额度”，不再说“本所”。
 * 我方没有 Kimi 的“加油包”：律师不能自行购买，提示条只给“查看用量”，不放购买入口（不做伪交互）。
 */
import type { QuotaStatus } from "../api.ts";
import { fmtPct } from "./firm-usage.ts";

export interface QuotaNotice {
  /** stop = 新任务发不出去；warn = 快用完 / 放缓。 */
  tone: "stop" | "warn";
  text: string;
  /** 关掉后记住的键：同一周期、同一种情形不再提示；情形变了（例如从“不足 10%”到“用完”）再出现。 */
  key: string;
}

/** 剩余不足多少时提示（Kimi 同为 10%）。 */
export const LOW_REMAINING = 0.1;

/** 北京时间的“MM-DD”（Kimi 提示条写法，例如 12-01）。 */
export function shortDay(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const d = new Date(t + 8 * 3600_000);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** 北京时间的“HH:mm”（5 小时窗口恢复时刻）。 */
function shortTime(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const d = new Date(t + 8 * 3600_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** 提示条只说“本月”“本周”（完整起止在“套餐与用量”页）。 */
function periodWord(q: QuotaStatus): string {
  return q.period?.kind === "week" ? "本周" : "本月";
}

export function quotaNotice(q: QuotaStatus | null | undefined): QuotaNotice | null {
  if (!q || q.mode !== "control_plane" || !q.firm) return null;
  const f = q.firm;
  const per = periodWord(q);
  const day = shortDay(q.period?.resets_at);
  const reset = day ? `，将于 ${day} 重置` : "";
  const pk = q.period?.key ?? "";
  if (f.paused === "allowance") return { tone: "stop", text: `你${per}的 AI 额度已用完，新任务暂不能发起${reset}`, key: `${pk}:allowance` };
  if (f.paused === "cap") return { tone: "stop", text: `${per}用量已到设定的上限（${f.cap_pct ?? "—"}%），新任务暂不能发起${reset}`, key: `${pk}:cap:${f.cap_pct ?? ""}` };
  if (f.paused === "burst") {
    const back = shortTime(q.burst?.resets_at);
    return { tone: "warn", text: `最近 ${q.burst?.hours ?? 5} 小时用得太快，AI 处理暂时放缓${back ? `，${back} 起逐步恢复` : ""}`, key: `${pk}:burst:${q.burst?.resets_at ?? ""}` };
  }
  const own = q.own;
  if (own && own.enforced && own.used_ratio >= 1) return { tone: "stop", text: `你的个人上限已用完，新任务暂不能发起${reset}`, key: `${pk}:own-full` };
  if (f.remaining_ratio < LOW_REMAINING) return { tone: "warn", text: `你${per}的额度已不足 ${fmtPct(LOW_REMAINING)}${reset}`, key: `${pk}:firm-low` };
  if (own && own.enforced && 1 - own.used_ratio < LOW_REMAINING) return { tone: "warn", text: `你的个人上限已不足 ${fmtPct(LOW_REMAINING)}${reset}`, key: `${pk}:own-low` };
  return null;
}

/** 用户菜单里的一行额度小字：“本月已用 37% · 12-01 重置”。没有控制面时为 null。 */
export function quotaMenuLine(q: QuotaStatus | null | undefined): string | null {
  // 第 66 批（V40 P0-5）：个人产品只说“我”的用量（菜单“套餐与用量”右侧的小字）；不再写“本所”
  if (!q || q.mode !== "control_plane" || !q.firm) return null;
  // 与“套餐与用量”页同一个数（云端 personal 优先）
  return `已用 ${fmtPct(q.personal?.used_ratio ?? personalUsedRatio(q))}`;
}

/** 个人用量比例（第 66 批）：本人账号有单独分母时用它；没有（单人工作室，本所额度就是本人套餐）用本期额度。 */
export function personalUsedRatio(q: Pick<QuotaStatus, "firm" | "own">): number {
  if (q.own && q.own.denominator === "account_limit") return q.own.used_ratio;
  return q.firm?.used_ratio ?? q.own?.used_ratio ?? 0;
}

/** 用户卡上的套餐标识（Kimi 名字旁的“Max”）：取控制面套餐名；试用版写“试用”；本地开发不显示。 */
export function planBadge(q: QuotaStatus | null | undefined): string | null {
  if (!q) return null;
  if (q.edition === "trial") return "试用";
  if (q.mode !== "control_plane") return null;
  const label = q.plan?.label?.trim();
  return label ? label.replace(/版$/, "") || label : null;
}
