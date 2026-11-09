/**
 * 用量的显示口径（第 40 批：取消点数，一律按百分比）。
 *
 * - 本所与个人的月度用量由控制面按“本月额度的百分比”给出（用量与上限页）；
 * - 单个任务在内核里有一份**预留额度**（按任务类型的单任务上限预估，estimate.ts），它与网关计量不是同一把尺子——
 *   所以任务层面只说“约为这类任务上限的 x%”“已用本任务预留额度的 x%”，不折算成月度额度，也不出现点数。
 */

/** 百分比文字：不到 1% 写“不到 1%”；其余取整。 */
export function pctText(ratio: number): string {
  const p = ratio * 100;
  if (p > 0 && p < 1) return "不到 1%";
  return `${Math.round(p)}%`;
}

/** 发起前的预估（界面标签是“预计用量”）：“中等（约为这类任务上限的 50%）”；本机流程不占额度。 */
export function estimateDisplay(points: number, cap: number, local = false): string {
  if (local || points <= 0) return "不调用 AI，不占用额度";
  if (!cap || cap <= 0) return "按实际用量计";
  const r = Math.min(1, points / cap);
  const size = r < 0.4 ? "较少" : r < 0.75 ? "中等" : "较大";
  return `${size}（约为这类任务上限的 ${pctText(r)}）`;
}

/** 任务记录里的实际用量：“已用本任务预留额度的 45%”。 */
export function chargedDisplay(charged: number, budget: number): string {
  if (charged <= 0) return "未占用额度";
  if (!budget || budget <= 0) return "已计入本所本月用量";
  return `已用本任务预留额度的 ${pctText(Math.min(1, charged / budget))}`;
}
