/**
 * 工作台“接受后”预览（v9.3 评审 Z3 M-5、§8 P2 #25；余项续复核 RC-B-01/02/03）：不用先生成 Word，就能看到接受之后合同长什么样。
 *
 * Word 材料由内核按生成修订稿的同一套计划、定位、最小修改范围与重叠检查算出每张卡的落点（riskcards.preview_redline，只读），
 * 这里只负责排版：删掉的原文显示删除线，新文本显示为插入，与 Word 原生修订的样子一致；
 * 不能写进修订稿的卡逐项说明原因（生成时会被拦下的写明“会被拦下”）。
 * 非 Word 材料不能生成修订稿：退回本机按原文定位（localPreview），页面写明“仅供参考”。
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
  /** 可退让（还原后）与接受时选用的一级（C-05）。 */
  fallback?: string;
  chosen_level?: "suggestion" | "fallback";
  kind?: string;
}

/** 一段文字；edit 为一处修改（del 被删的原文，ins 新文本，可能有一边为空）。 */
export type PreviewSeg = { text: string; edit?: { cardId: string; del: string; ins: string } };

export interface AcceptPreview {
  paragraphs: PreviewSeg[][];
  applied: number;
  skipped: { card_id: string; reason: string }[];
}

/** 内核预览里一张卡的结果（与内核 RedlinePreviewCard 同形）。 */
export type KernelPreviewCard = { card_id: string; ok: true; para: number; start: number; end: number; old: string; new: string; insert?: true } | { card_id: string; ok: false; reason: string };

/** 不能写进修订稿的原因（律师层）。unchanged 不会生成修订，其余在生成修订稿时会被拦下。 */
export const SKIP_REASON_TEXT: Record<string, string> = {
  unchanged: "改后与原文相同，不改动",
  anchor_ambiguous: "原文出现多处，生成修订稿时会被拦下",
  anchor_not_found: "原文里找不到，生成修订稿时会被拦下",
  anchor_not_in_view: "原文里找不到，生成修订稿时会被拦下",
  anchor_hash_mismatch: "原文里找不到，生成修订稿时会被拦下",
  overlap: "与另一项改动重叠，生成修订稿时会被拦下",
  unknown_token: "含无法还原的代号，生成修订稿时会被拦下",
  anchor_empty: "没有原文，生成修订稿时会被拦下",
  apply_failed: "无法写成修订，生成修订稿时会被拦下",
  no_insert_point: "没有写明插在哪里，只进审查意见表，请在 Word 中手工补上",
};
export const skipReasonText = (r: string) => SKIP_REASON_TEXT[r] ?? "无法写进修订稿";

/** 会改动合同的卡（与内核 changesDocument 一致）。 */
export function changesDocument(c: Pick<PreviewCard, "status" | "suggestion"> & Partial<Pick<PreviewCard, "fallback" | "chosen_level">>): boolean {
  return c.status === "modified" || (c.status === "accepted" && !!adopted(c).trim());
}

/** 接受时写进修订稿的文本（与内核 acceptedText 一致）。 */
const adopted = (c: Pick<PreviewCard, "suggestion"> & Partial<Pick<PreviewCard, "fallback" | "chosen_level">>) => (c.chosen_level === "fallback" && c.fallback?.trim() ? c.fallback : c.suggestion);

function commonEdges(a: string, b: string): [number, number] {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return [p, s];
}

type Edit = { para: number; start: number; end: number; old: string; text: string; cardId: string };

/** 按落点排版：每处修改去掉与原文相同的开头和结尾，只把真正改动的部分写成“删除线原文 + 新文本”。纯函数。 */
function layout(paragraphs: readonly string[], edits: readonly Edit[]): PreviewSeg[][] {
  const byPara = new Map<number, Edit[]>();
  for (const e of edits) byPara.set(e.para, [...(byPara.get(e.para) ?? []), e]);
  return paragraphs.map((p, i) => {
    const list = (byPara.get(i) ?? []).sort((a, b) => a.start - b.start);
    if (list.length === 0) return [{ text: p }];
    const segs: PreviewSeg[] = [];
    let last = 0;
    for (const e of list) {
      const was = p.slice(e.start, e.end);
      const [pre, suf] = commonEdges(was, e.text);
      segs.push({ text: p.slice(last, e.start) + e.text.slice(0, pre) });
      segs.push({ text: "", edit: { cardId: e.cardId, del: was.slice(pre, was.length - suf), ins: e.text.slice(pre, e.text.length - suf) } });
      segs.push({ text: e.text.slice(e.text.length - suf) });
      last = e.end;
    }
    segs.push({ text: p.slice(last) });
    return segs.filter((s) => s.text || s.edit);
  });
}

/** Word 材料：按内核给出的落点排版；缺失条款（段后插入）排成锚点段落之后的新段落，整段显示为插入。纯函数。 */
export function kernelPreview(paragraphs: readonly string[], cards: readonly KernelPreviewCard[]): AcceptPreview {
  const edits: Edit[] = [];
  const inserts = new Map<number, { cardId: string; text: string }[]>();
  const skipped: AcceptPreview["skipped"] = [];
  for (const c of cards) {
    if (c.ok && c.insert) inserts.set(c.para, [...(inserts.get(c.para) ?? []), { cardId: c.card_id, text: c.new }]);
    else if (c.ok) edits.push({ para: c.para, start: c.start, end: c.end, old: c.old, text: c.new, cardId: c.card_id });
    else skipped.push({ card_id: c.card_id, reason: skipReasonText(c.reason) });
  }
  const out: PreviewSeg[][] = [];
  layout(paragraphs, edits).forEach((segs, i) => {
    out.push(segs);
    for (const ins of inserts.get(i) ?? [])
      for (const line of ins.text.split(/\r?\n/).filter((l) => l.trim())) out.push([{ text: "", edit: { cardId: ins.cardId, del: "", ins: line.trim() } }]);
  });
  return { paragraphs: out, applied: edits.length + [...inserts.values()].reduce((n, l) => n + l.length, 0), skipped };
}

const squash = (s: string) => s.replace(/[\s　|]+/g, "");

/** 在段落里按忽略空白的口径找引文（与内核 locateQuote 同一口径）；返回原文坐标。 */
function locateLoose(p: string, quote: string): { start: number; end: number } | null {
  const exact = p.indexOf(quote);
  if (exact >= 0) return { start: exact, end: exact + quote.length };
  const q = squash(quote);
  if (q.length < 2) return null;
  const map: number[] = [];
  let flat = "";
  for (let i = 0; i < p.length; i++) {
    if (/[\s　|]/.test(p[i]!)) continue;
    map.push(i);
    flat += p[i];
  }
  const at = flat.indexOf(q);
  if (at < 0 || flat.indexOf(q, at + 1) >= 0) return null;
  return { start: map[at]!, end: map[at + q.length - 1]! + 1 };
}

/**
 * 非 Word 材料（不能生成修订稿）：本机按原文定位，仅供参考。先求最小改动段再判断重叠（与修订稿同一思路）；改后与原文相同的不改动。纯函数。
 */
export function localPreview(paragraphs: readonly string[], cards: readonly PreviewCard[]): AcceptPreview {
  const skipped: AcceptPreview["skipped"] = [];
  const edits: Edit[] = [];
  for (const c of [...cards].filter(changesDocument).sort((a, b) => a.seq - b.seq)) {
    // 缺失条款要插入新段落：非 Word 材料没有修订稿，本机预览不排（意见表里有）
    if (c.kind === "missing") {
      skipped.push({ card_id: c.card_id, reason: "补充条款只能写进 Word 修订稿" });
      continue;
    }
    const next = c.status === "modified" ? c.final_text : adopted(c);
    if (next === c.anchor_text) {
      skipped.push({ card_id: c.card_id, reason: skipReasonText("unchanged") });
      continue;
    }
    if (c.anchor_status === "ambiguous") {
      skipped.push({ card_id: c.card_id, reason: "原文出现多处" });
      continue;
    }
    let hit: { para: number; start: number; end: number } | null = null;
    for (let i = 0; i < paragraphs.length && !hit; i++) {
      const loc = c.anchor_text.length >= 2 ? locateLoose(paragraphs[i]!, c.anchor_text) : null;
      if (loc) hit = { para: i, ...loc };
    }
    if (!hit) {
      skipped.push({ card_id: c.card_id, reason: "原文里找不到" });
      continue;
    }
    const was = paragraphs[hit.para]!.slice(hit.start, hit.end);
    const [pre, suf] = commonEdges(was, next);
    const core = { start: hit.start + pre, end: hit.end - suf };
    if (edits.some((e) => e.para === hit!.para && core.start < e.end && e.start < core.end)) {
      skipped.push({ card_id: c.card_id, reason: "与另一项改动重叠" });
      continue;
    }
    // 只存真正改动的那一段（排版时不会和相邻的修改交叠）
    edits.push({ para: hit.para, start: core.start, end: core.end, old: was.slice(pre, was.length - suf), text: next.slice(pre, next.length - suf), cardId: c.card_id });
  }
  return { paragraphs: layout(paragraphs, edits), applied: edits.length, skipped };
}

/** 兼容旧名：本机预览。 */
export const acceptPreview = localPreview;
