/**
 * 召回评测标注界面的纯函数（标注规范 v1）：类别表、正文分段、选区换算、加/改/删标注、自然人编号。
 * 坐标一律是 JavaScript 字符串下标（UTF-16 码元），与评测器一致。
 */
import type { EvalCategory, EvalDoc, EvalSpan } from "../api.ts";

export interface CategoryMeta {
  key: EvalCategory;
  label: string;
  /** 快捷键（选中文字后按键即标注）。 */
  hotkey: string;
  tone: "person" | "partial" | "org" | "id" | "place" | "negative";
}

export const EVAL_CATEGORIES: readonly CategoryMeta[] = Object.freeze([
  { key: "person", label: "自然人", hotkey: "1", tone: "person" },
  { key: "person_partial", label: "隐名写法", hotkey: "2", tone: "partial" },
  { key: "org", label: "机构", hotkey: "3", tone: "org" },
  { key: "id_number", label: "证件号", hotkey: "4", tone: "id" },
  { key: "phone", label: "电话", hotkey: "5", tone: "id" },
  { key: "account", label: "账号", hotkey: "6", tone: "id" },
  { key: "uscc", label: "信用代码", hotkey: "7", tone: "id" },
  { key: "address", label: "地址", hotkey: "8", tone: "place" },
  { key: "plate", label: "车牌", hotkey: "9", tone: "id" },
  { key: "email", label: "邮箱", hotkey: "e", tone: "id" },
  { key: "case_no", label: "案号", hotkey: "c", tone: "id" },
  { key: "birth_date", label: "出生日期", hotkey: "b", tone: "id" },
  { key: "negative", label: "困难负例", hotkey: "0", tone: "negative" },
]);

export const CATEGORY_LABEL: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(EVAL_CATEGORIES.map((c) => [c.key, c.label])));

export interface Segment {
  start: number;
  end: number;
  /** 覆盖这段的标注在 doc.spans 里的下标；未标注为 -1。 */
  span: number;
}

/** 按标注把正文切成连续的段（标注不重叠；越界的标注忽略）。 */
export function segments(text: string, spans: readonly EvalSpan[]): Segment[] {
  const order = spans
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.start >= 0 && s.end <= text.length && s.end > s.start)
    .sort((a, b) => a.s.start - b.s.start);
  const out: Segment[] = [];
  let at = 0;
  for (const { s, i } of order) {
    if (s.start < at) continue;
    if (s.start > at) out.push({ start: at, end: s.start, span: -1 });
    out.push({ start: s.start, end: s.end, span: i });
    at = s.end;
  }
  if (at < text.length) out.push({ start: at, end: text.length, span: -1 });
  return out;
}

/** 去掉选区两端的空白（含全角空格与换行）；返回 null = 选区里只有空白。 */
export function trimRange(text: string, start: number, end: number): { start: number; end: number } | null {
  let a = Math.max(0, Math.min(start, end));
  let b = Math.min(text.length, Math.max(start, end));
  while (a < b && /\s/.test(text[a]!)) a += 1;
  while (b > a && /\s/.test(text[b - 1]!)) b -= 1;
  return b > a ? { start: a, end: b } : null;
}

export function overlaps(spans: readonly EvalSpan[], start: number, end: number, except = -1): number {
  return spans.findIndex((s, i) => i !== except && s.start < end && s.end > start);
}

/** 下一个未用的自然人编号（P1、P2…）。 */
export function nextPersonId(spans: readonly EvalSpan[]): string {
  const used = new Set(spans.map((s) => s.person_id).filter(Boolean));
  for (let n = 1; ; n++) if (!used.has(`P${n}`)) return `P${n}`;
}

/** 本文书已有的自然人：编号 → 第一次出现的写法与提及数。 */
export function personsOf(doc: EvalDoc): { id: string; first: string; mentions: number }[] {
  const m = new Map<string, { id: string; first: string; mentions: number; at: number }>();
  for (const s of doc.spans) {
    if (s.category !== "person" || !s.person_id) continue;
    const cur = m.get(s.person_id);
    if (!cur) m.set(s.person_id, { id: s.person_id, first: doc.text.slice(s.start, s.end), mentions: 1, at: s.start });
    else {
      cur.mentions += 1;
      if (s.start < cur.at) {
        cur.at = s.start;
        cur.first = doc.text.slice(s.start, s.end);
      }
    }
  }
  return [...m.values()].sort((a, b) => a.at - b.at).map(({ id, first, mentions }) => ({ id, first, mentions }));
}

export type AddResult = { ok: true; doc: EvalDoc } | { ok: false; reason: string };

/**
 * 加一条标注：先去掉两端空白；与已有标注重叠即拒绝（规范 v1 §3 第 2 条：不嵌套）；
 * 自然人缺编号时：与已有某人写法完全相同即沿用其编号，否则分配新编号。
 */
export function addSpan(doc: EvalDoc, start: number, end: number, category: EvalCategory, personId?: string): AddResult {
  const r = trimRange(doc.text, start, end);
  if (!r) return { ok: false, reason: "选中的只有空白" };
  if (overlaps(doc.spans, r.start, r.end) >= 0) return { ok: false, reason: "和已有的标注重叠：先删掉那一处，或调整选区" };
  let pid = personId;
  if (category === "person" && !pid) {
    const form = doc.text.slice(r.start, r.end);
    const same = doc.spans.find((s) => s.category === "person" && s.person_id && doc.text.slice(s.start, s.end) === form);
    pid = same?.person_id ?? nextPersonId(doc.spans);
  }
  const span: EvalSpan = { start: r.start, end: r.end, category, ...(category === "person" && pid ? { person_id: pid } : {}) };
  const spans = [...doc.spans, span].sort((a, b) => a.start - b.start || a.end - b.end);
  return { ok: true, doc: { ...doc, spans } };
}

export function removeSpan(doc: EvalDoc, index: number): EvalDoc {
  return { ...doc, spans: doc.spans.filter((_, i) => i !== index) };
}

/** 改类别或编号（改成自然人时补编号；改成别的类别时去掉编号）。 */
export function updateSpan(doc: EvalDoc, index: number, patch: { category?: EvalCategory; person_id?: string }): EvalDoc {
  const spans = doc.spans.map((s, i) => {
    if (i !== index) return s;
    const category = patch.category ?? s.category;
    const next: EvalSpan = { start: s.start, end: s.end, category };
    if (category === "person") {
      // 改成自然人时沿用同一写法已有的编号（复核 S6B-06）
      const form = doc.text.slice(s.start, s.end);
      const same = doc.spans.find((x, j) => j !== index && x.category === "person" && x.person_id && doc.text.slice(x.start, x.end) === form);
      next.person_id = patch.person_id ?? s.person_id ?? same?.person_id ?? nextPersonId(doc.spans);
    }
    return next;
  });
  return { ...doc, spans };
}

/** 合并新读入的文书：同编号的整份替换（标注文件覆盖同名文书），新编号追加。 */
export function mergeDocs(current: readonly EvalDoc[], incoming: readonly EvalDoc[]): EvalDoc[] {
  const out = [...current];
  for (const d of incoming) {
    const i = out.findIndex((x) => x.doc_id === d.doc_id);
    if (i >= 0) out[i] = d;
    else out.push(d);
  }
  return out;
}

export function fmtRatio(x: number | null | undefined, digits = 3): string {
  return typeof x === "number" && Number.isFinite(x) ? x.toFixed(digits) : "—";
}
