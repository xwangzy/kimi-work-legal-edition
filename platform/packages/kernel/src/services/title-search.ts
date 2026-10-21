/**
 * 全局搜索的标题匹配（Z3 评审 §8.2 #31；余项续复核 RC-A-05、RC-B-06/07/09）：在内核里按标题找事项、任务、交付件，
 * 只把命中的、要显示的几条交给界面（不再把几十个事项的交付件标题整批还原给界面）。纯函数。
 *
 * - 每个词（空格隔开）都要整个出现在标题或副标题的同一处（不跨“标题 + 副标题”的边界）；
 * - 标题开头命中 > 词都在标题里 > 有词只在副标题里；都不命中时，再按“每个字都在标题里、并且按顺序出现”宽松匹配，排在最后
 *   （律师常连着输入“股权转让修订稿”）；同分按最近活动。
 */
export type TitleKind = "matter" | "run" | "deliverable";

export interface TitleCandidate {
  kind: TitleKind;
  /** 还原代号后的标题与副标题（只在内核里用于匹配，命中的才交给界面）。 */
  title: string;
  sub: string;
  /** 另外可搜的文字（不显示），如任务的场景名。 */
  extra?: string;
  at: string | null;
  ref: Record<string, unknown>;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");

function inOrder(hay: string, needle: string): boolean {
  let at = 0;
  for (const ch of needle) {
    at = hay.indexOf(ch, at);
    if (at < 0) return false;
    at += 1;
  }
  return true;
}

export function scoreTitle(query: string, c: Pick<TitleCandidate, "title" | "sub" | "extra">): number {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;
  const t = norm(c.title);
  const fields = [t, norm(c.sub), norm(c.extra ?? "")];
  if (terms.every((w) => fields.some((f) => f.includes(w)))) {
    if (!terms.every((w) => t.includes(w) || norm(c.extra ?? "").includes(w))) return 1;
    return t.startsWith(terms[0]!) ? 3 : 2;
  }
  const loose = terms.join("");
  if (loose.length >= 2 && (inOrder(t, loose) || inOrder(norm(c.extra ?? "") + t, loose))) return 0.5;
  return 0;
}

export function rankTitles<T extends TitleCandidate>(query: string, items: readonly T[], limitPerKind = 6): Record<TitleKind, T[]> {
  const scored = items.map((it) => ({ it, s: scoreTitle(query, it) })).filter((x) => x.s > 0);
  scored.sort((a, b) => b.s - a.s || String(b.it.at ?? "").localeCompare(String(a.it.at ?? "")));
  const out: Record<TitleKind, T[]> = { matter: [], run: [], deliverable: [] };
  for (const x of scored) if (out[x.it.kind].length < limitPerKind) out[x.it.kind].push(x.it);
  return out;
}
