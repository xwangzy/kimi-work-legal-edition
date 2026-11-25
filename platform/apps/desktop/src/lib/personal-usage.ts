/** 个人用量口径（第 66 批 V40 P0-5）。纯函数，“套餐与用量”页与用例共用。 */
import type { QuotaStatus } from "../api.ts";
import { personalUsedRatio } from "./quota-notice.ts";

/** 个人口径（新云端给 personal；旧云端：单人工作室的本期额度就是本人套餐）。纯函数。 */
export function personalView(q: QuotaStatus): { used: number; inFlight: number; available: number; now: number | null; limitedBy: string | null; paused: string | null } {
  // 第 66 批第二轮（独立评审：一个分母）：本期额度为 100%——已用 used、进行中预留 inFlight、可用 available = 1 − 已用 − 预留，
  // 三者加起来就是整条进度条。now = 云端算的“此刻还能用多少”（同样按本期额度计；被 5 小时频率卡住时比 available 小）
  const p = q.personal;
  const inFlight = Math.max(0, q.firm?.in_flight_ratio ?? 0);
  const used = p ? p.used_ratio : personalUsedRatio(q);
  const available = Math.max(0, 1 - Math.min(1, used) - inFlight);
  return { used, inFlight, available, now: p ? p.remaining_ratio : null, limitedBy: p?.limited_by ?? null, paused: (p ? p.paused : q.firm?.paused) ?? null };
}

/** 5 小时窗口一栏只用窗口自己的分母（窗口上限 = 本期额度的 pct%）：已用、预留、此刻还可用都折到窗口上。纯函数。 */
export function burstView(b: { pct: number; used_ratio: number }, v: Pick<ReturnType<typeof personalView>, "inFlight" | "now" | "limitedBy">): { used: number; inFlight: number; available: number } {
  const cap = b.pct > 0 ? b.pct / 100 : 1;
  const used = Math.max(0, b.used_ratio);
  const inFlight = Math.min(Math.max(0, 1 - used), v.inFlight / cap);
  const available = v.limitedBy === "burst" && v.now !== null ? Math.max(0, Math.min(1, v.now / cap)) : Math.max(0, 1 - used - inFlight);
  return { used, inFlight, available };
}
