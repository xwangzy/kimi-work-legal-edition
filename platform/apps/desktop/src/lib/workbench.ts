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

/**
 * 工作台协议条（Z3 #22、D-2）：标题下一行写“我方：受让方 · 审查要点：合同审查（风险卡） v1.1.1 · 中国内地 · 已处理 0/4”。
 * 缺的项不写（不编造）；只有进度时也给一行。纯函数。
 */
export function agreementParts(p: { stance?: string | null; method?: string | null; jurisdiction?: string | null; decided?: number; total?: number }): string[] {
  const out: string[] = [];
  if (p.stance) out.push(`我方：${p.stance}`);
  if (p.method) out.push(`审查要点：${p.method}`);
  if (p.jurisdiction) out.push(p.jurisdiction);
  if (typeof p.total === "number" && p.total > 0) out.push(`已处理 ${p.decided ?? 0}/${p.total}`);
  return out;
}

/**
 * 批量接受的边界（v9.4 第 20 批，C1 §2.2 第 5 条；与内核 review-cards.ts batchEligible 同一判定）：
 * 只对“提示”级和前后不一致类开放；重大、必须修改、缺失、需客户决定、没有建议文本的不进批量。
 */
export function batchEligible(c: { status: string; suggestion?: string | null; kind?: string | null; needs_client_decision?: boolean | number | null; nature?: string | null; severity: string }): boolean {
  if (c.status !== "proposed" || !(c.suggestion ?? "").trim()) return false;
  if (c.kind === "missing" || !!c.needs_client_decision || c.nature === "must" || c.severity === "high") return false;
  return c.severity === "low" || c.kind === "consistency";
}
