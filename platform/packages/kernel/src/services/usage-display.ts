/**
 * 用量的显示口径（第 40 批取消点数；第 46 批，主文 §5-4：任务层面也不再出由点数表折算的百分比）。
 *
 * - 本所与个人的月度用量由控制面按“本月额度的百分比”给出（用量与上限页）；
 * - 单个任务在内核里仍有一份**预留额度**（estimate.ts 的点数表，作安全阀：到了先停下来问律师），它与网关的真实计量不是同一把尺子，
 *   所以不对律师出数：发起前只说“按实际用量计入本月额度”，能读到本月用量时补一句“本月已用 x%”；本机流程写“不调用 AI，不占用额度”。
 */

/** 百分比文字：不到 1% 写“不到 1%”；其余取整。 */
export function pctText(ratio: number): string {
  const p = ratio * 100;
  if (p > 0 && p < 1) return "不到 1%";
  return `${Math.round(p)}%`;
}

/**
 * 发起前的预估（界面标签是“预计用量”）。monthUsedRatio = 缓存的用量视图里本所本期已用比例（没有或过时为 null）；
 * term = 统计周期（本月 / 本周）。
 */
export function estimateDisplay(local: boolean, monthUsedRatio: number | null = null, term: "本月" | "本周" = "本月"): string {
  if (local) return "不调用 AI，不占用额度";
  const used = typeof monthUsedRatio === "number" && Number.isFinite(monthUsedRatio) && monthUsedRatio >= 0 ? `（${term}已用 ${pctText(Math.min(monthUsedRatio, 1))}）` : "";
  return `按实际用量计入${term}额度${used}`;
}

/** 任务记录里的用量：用到 AI 的写“已按实际用量计入本所额度”，没用到的写“未占用额度”，本机流程写“不调用 AI，不占用额度”。 */
export function chargedDisplay(charged: number, budget: number): string {
  if (!budget || budget <= 0) return charged > 0 ? "已按实际用量计入本所额度" : "不调用 AI，不占用额度";
  if (charged <= 0) return "未占用额度";
  return "已按实际用量计入本所额度";
}
