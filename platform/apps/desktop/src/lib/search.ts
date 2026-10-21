/**
 * 全局搜索（Z3 评审 §8.2 #31，10-13 遗留）：在本机已取到的事项、任务、交付件里按标题找（纯函数；不联网、不进账本搜索全文）。
 * 每个词（空格隔开）都要出现在标题或副标题里；标题开头命中 > 标题包含 > 只在副标题；同分按最近活动。
 */
export type SearchKind = "matter" | "run" | "deliverable";
export interface SearchItem {
  kind: SearchKind;
  title: string;
  /** 副标题（事项的客户与相对方、任务与交付件所在的事项）。 */
  sub: string;
  href: string;
  /** 最近活动（ISO 时刻），同分时新的在前。 */
  at?: string | null;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");

export function searchItems(query: string, items: readonly SearchItem[], limitPerKind = 6): { kind: SearchKind; items: SearchItem[] }[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const scored: { it: SearchItem; score: number }[] = [];
  for (const it of items) {
    const t = norm(it.title);
    const all = `${t}${norm(it.sub)}`;
    if (!terms.every((w) => all.includes(w))) continue;
    const first = terms[0]!;
    const score = t.startsWith(first) ? 3 : terms.every((w) => t.includes(w)) ? 2 : 1;
    scored.push({ it, score });
  }
  scored.sort((a, b) => b.score - a.score || String(b.it.at ?? "").localeCompare(String(a.it.at ?? "")));
  const order: SearchKind[] = ["matter", "run", "deliverable"];
  return order
    .map((kind) => ({ kind, items: scored.filter((x) => x.it.kind === kind).slice(0, limitPerKind).map((x) => x.it) }))
    .filter((g) => g.items.length > 0);
}

export const SEARCH_KIND_LABEL: Readonly<Record<SearchKind, string>> = { matter: "事项", run: "任务", deliverable: "交付件" };
