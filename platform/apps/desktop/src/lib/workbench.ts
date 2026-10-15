/**
 * 审查工作台的卡片导航（UIUX 增量评审 W-1）：打开时展开第一张未处理的卡（重大优先）；处理完自动展开下一张未处理的卡；J/K 切换。
 */
export interface NavCard {
  card_id: string;
  seq: number;
  severity: "high" | "mid" | "low";
  status: string;
}

const RANK: Record<string, number> = { high: 0, mid: 1, low: 2 };

/** 第一张未处理的卡：重大 → 一般 → 提示，同级按序号。没有未处理的返回 null。 */
export function firstOpenCard(cards: readonly NavCard[]): string | null {
  const open = cards.filter((c) => c.status === "proposed").sort((a, b) => (RANK[a.severity] ?? 3) - (RANK[b.severity] ?? 3) || a.seq - b.seq);
  return open[0]?.card_id ?? null;
}

/** 处理完 afterId 之后的下一张未处理的卡（按序号往后找，到末尾再从头找）；都处理完返回 null。 */
export function nextOpenCard(cards: readonly NavCard[], afterId: string): string | null {
  const ordered = [...cards].sort((a, b) => a.seq - b.seq);
  const i = ordered.findIndex((c) => c.card_id === afterId);
  const rotated = i < 0 ? ordered : [...ordered.slice(i + 1), ...ordered.slice(0, i + 1)];
  return rotated.find((c) => c.status === "proposed" && c.card_id !== afterId)?.card_id ?? null;
}

/** J/K：在当前显示的卡片之间移动（不循环）。 */
export function stepCard(visibleIds: readonly string[], current: string | null, dir: 1 | -1): string | null {
  if (visibleIds.length === 0) return null;
  const i = current ? visibleIds.indexOf(current) : -1;
  if (i < 0) return visibleIds[dir === 1 ? 0 : visibleIds.length - 1]!;
  return visibleIds[Math.max(0, Math.min(visibleIds.length - 1, i + dir))]!;
}
