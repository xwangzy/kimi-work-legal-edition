/**
 * 工作台“接受后”预览（v9.3 评审 Z3 M-5、§8 P2 #25）：不用先生成 Word，就能看到接受之后合同长什么样。
 *
 * 只在本机按已接受的卡渲染（与修订稿同一口径：修改后接受用律师改写的文本，接受用首选建议，知悉不改动的卡不进来）；
 * 只处理“已定位”的卡——原文出现多处的、跨段或找不到的，列为“预览未体现”，以生成的修订稿为准。
 * 只标出真正改动的那一段（去掉与原文相同的开头和结尾），删掉的原文放在提示里。
 */

export interface PreviewCard {
  card_id: string;
  seq: number;
  status: "proposed" | "accepted" | "modified" | "rejected";
  anchor_status: string;
  /** 以下三项均为还原代号后的原文。 */
  anchor_text: string;
  suggestion: string;
  final_text: string;
}

export type PreviewSeg = { text: string; ins?: { cardId: string; seq: number; was: string } };

export interface AcceptPreview {
  paragraphs: PreviewSeg[][];
  applied: number;
  skipped: { card_id: string; seq: number; reason: string }[];
}

/** 会改动合同的卡（与内核 changesDocument 一致）。 */
export function changesDocument(c: Pick<PreviewCard, "status" | "suggestion">): boolean {
  return c.status === "modified" || (c.status === "accepted" && !!c.suggestion.trim());
}

function commonEdges(a: string, b: string): [number, number] {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return [p, s];
}

export function acceptPreview(paragraphs: readonly string[], cards: readonly PreviewCard[]): AcceptPreview {
  const skipped: AcceptPreview["skipped"] = [];
  const edits = new Map<number, { start: number; end: number; text: string; card: PreviewCard }[]>();
  for (const c of [...cards].filter(changesDocument).sort((a, b) => a.seq - b.seq)) {
    const next = c.status === "modified" ? c.final_text : c.suggestion;
    if (c.anchor_status !== "located" || c.anchor_text.length < 2) {
      skipped.push({ card_id: c.card_id, seq: c.seq, reason: c.anchor_status === "ambiguous" ? "原文出现多处" : "未能定位原文" });
      continue;
    }
    const pi = paragraphs.findIndex((p) => p.includes(c.anchor_text));
    if (pi < 0) {
      skipped.push({ card_id: c.card_id, seq: c.seq, reason: "未能定位原文" });
      continue;
    }
    const start = paragraphs[pi]!.indexOf(c.anchor_text);
    const end = start + c.anchor_text.length;
    const list = edits.get(pi) ?? [];
    if (list.some((e) => start < e.end && e.start < end)) {
      skipped.push({ card_id: c.card_id, seq: c.seq, reason: "与另一项改动重叠" });
      continue;
    }
    list.push({ start, end, text: next, card: c });
    edits.set(pi, list);
  }
  let applied = 0;
  const out = paragraphs.map((p, i) => {
    const list = (edits.get(i) ?? []).sort((a, b) => a.start - b.start);
    if (list.length === 0) return [{ text: p }];
    const segs: PreviewSeg[] = [];
    let last = 0;
    for (const e of list) {
      applied += 1;
      const was = p.slice(e.start, e.end);
      const [pre, suf] = commonEdges(was, e.text);
      segs.push({ text: p.slice(last, e.start) + e.text.slice(0, pre) });
      segs.push({ text: e.text.slice(pre, e.text.length - suf), ins: { cardId: e.card.card_id, seq: e.card.seq, was: was.slice(pre, was.length - suf) } });
      segs.push({ text: e.text.slice(e.text.length - suf) });
      last = e.end;
    }
    segs.push({ text: p.slice(last) });
    return segs.filter((s) => s.text || s.ins);
  });
  return { paragraphs: out, applied, skipped };
}
