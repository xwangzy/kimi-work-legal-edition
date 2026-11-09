/**
 * 整稿比对（S1b）：段落级 LCS 对齐，找出全部改动，含未开修订的静默改动。
 * 语义（§S1b）：按“可见文字”（接受全部修订后）对齐两稿找出改动；每处改动是否“已标修订”，看当前稿拒绝全部修订后的文字：
 * 拒绝修订后与旧稿一致的，说明这处改动全都标了修订；不一致的，是静默改动（对方未开修订直接改文）。
 * V14 第 39 批：整段留痕删除（段落标记也删掉）的段落可见文字为空，原先被滤掉后一律算“静默删除”（T1 回稿把 4.1（三）项的
 * 留痕删除报成静默）；现在到当前稿的整段删除段落里找原文，找到即“已标修订”。另给出每处改动的自动编号条款号、新增段落插在
 * 旧稿哪一段之后，以及页眉页脚文字的变化。
 */
import { readZipText, readZipSelected } from "./zip.ts";
import { mapParagraphs } from "./textmap.ts";
import { acceptedNumberingXml, paragraphListLabels } from "./numbering.ts";

export interface DocxParagraph {
  index: number;
  /** 可见文字（接受全部修订后） */
  text: string;
  /** 拒绝全部修订后的文字（删除的字算、插入的字不算） */
  original: string;
  tracked: boolean; // 该段含修订标记
  /** 自动编号条款号（如“4.1（三）”：括号子项前接上一级编号）；不编号为 null */
  clause: string | null;
}

export interface CompareChange {
  type: "added" | "deleted" | "modified";
  baseIndex: number | null;
  curIndex: number | null;
  baseText: string;
  curText: string;
  silent: boolean; // 未被修订标记覆盖 = 静默改动
  /** 旧稿 / 新稿里这一段的自动编号条款号（文件用手打编号时为 null，条款号就在文字里） */
  baseClause?: string | null;
  curClause?: string | null;
  /** 新增段落：插在旧稿哪一段之后（旧稿非空段序号，从 0 起；插在最前为 -1）与那一段的文字 */
  afterBaseIndex?: number;
  afterBaseText?: string;
  afterBaseClause?: string | null;
}

export interface HeaderFooterChange {
  part: "页眉" | "页脚";
  baseText: string;
  curText: string;
  silent: boolean;
}

export interface CompareResult {
  changes: CompareChange[];
  stats: { added: number; deleted: number; modified: number; silent: number };
  baseParagraphs: number;
  curParagraphs: number;
  curHasTrackedChanges: boolean;
  /** 页眉页脚文字的变化（正文之外单列；不计入 stats） */
  headerFooter: HeaderFooterChange[];
}

const norm = (s: string): string => s.replace(/[\s　]+/g, "");

/** 子项编号（“（三）”“(a)”“①”这类）前接最近的上一级编号，得到律师说的条款号“4.1（三）”。 */
function clauseRefs(labels: readonly (string | null)[]): (string | null)[] {
  let main: string | null = null;
  return labels.map((l) => {
    if (!l || l === "•") return null;
    if (/^[（(]|^[①-⑳]/.test(l)) return main ? `${main}${l}` : l;
    main = l.replace(/[.．、]$/, "");
    return main;
  });
}

function paragraphsOf(xml: string, labels: readonly (string | null)[] | null): DocxParagraph[] {
  const clauses = labels ? clauseRefs(labels) : null;
  return mapParagraphs(xml).map((p) => ({
    index: p.index,
    text: p.text,
    original: p.segments.filter((s) => !s.inserted).map((s) => s.text).join(""),
    tracked: p.segments.some((s) => s.deleted || s.inserted) || /<w:(?:ins|del)\b/.test(xml.slice(p.xmlStart, p.xmlEnd)),
    clause: clauses?.[p.index] ?? null,
  }));
}

export function extractParagraphs(docx: Buffer): DocxParagraph[] {
  const xml = readZipText(docx, "word/document.xml");
  if (xml === null) throw new Error("DOCX 缺少 word/document.xml");
  // 条款号按接受修订后的口径（整段删除的段落不占号），与可见文字一致
  return paragraphsOf(xml, paragraphListLabels(acceptedNumberingXml(xml), readZipText(docx, "word/numbering.xml"), readZipText(docx, "word/styles.xml")));
}

/** 页眉、页脚各自的可见文字与拒绝修订后的文字（多个页眉部件按部件名顺序以“ / ”连接）。 */
function headerFooterTexts(docx: Buffer): Record<"页眉" | "页脚", { text: string; original: string }> {
  const parts = readZipSelected(docx, (n) => /^word\/(header|footer)\d*\.xml$/.test(n));
  const out = { 页眉: { text: [] as string[], original: [] as string[] }, 页脚: { text: [] as string[], original: [] as string[] } };
  for (const name of [...parts.keys()].sort()) {
    const kind = name.startsWith("word/header") ? "页眉" : "页脚";
    for (const p of paragraphsOf(parts.get(name)!.toString("utf8"), null)) {
      if (p.text.trim()) out[kind].text.push(p.text.trim());
      if (p.original.trim()) out[kind].original.push(p.original.trim());
    }
  }
  const pack = (k: "页眉" | "页脚") => ({ text: [...new Set(out[k].text)].join(" / "), original: [...new Set(out[k].original)].join(" / ") });
  return { 页眉: pack("页眉"), 页脚: pack("页脚") };
}

export function compareDocx(baseline: Buffer, current: Buffer): CompareResult {
  const baseParas = extractParagraphs(baseline).filter((p) => p.text.trim() !== "");
  const curAll = extractParagraphs(current);
  const curParas = curAll.filter((p) => p.text.trim() !== "");
  // 整段留痕删除的段落：可见文字为空、拒绝修订后有字（不参与对齐，只用来认出“已标修订的删除”）
  const trackedDeleted = curAll.filter((p) => p.text.trim() === "" && p.original.trim() !== "").map((p) => norm(p.original));
  const changes = lcsDiff(
    baseParas.map((p) => p.text),
    curParas.map((p) => p.text),
  ).map((c) => {
    const baseP = c.baseIndex !== null ? baseParas[c.baseIndex] : undefined;
    const curP = c.curIndex !== null ? curParas[c.curIndex] : undefined;
    let silent: boolean;
    if (c.type === "deleted") {
      // 旧稿这段在新稿里看不到了：新稿里有整段删除且原文就是这段，或者这段原文被并进了某段的删除文字里，才算标了修订
      const t = norm(baseP?.text ?? "");
      silent = !(t && (trackedDeleted.includes(t) || trackedDeleted.some((d) => d.length > t.length && d.includes(t))));
    } else if (c.type === "added") {
      // 新增段落：整段都在插入修订里（拒绝修订后没有字）才算标了修订
      silent = curP ? norm(curP.original) !== "" : true;
    } else {
      // 修改：拒绝新稿这段的全部修订，应当回到旧稿原文；回不去说明有没标修订的改动
      silent = curP ? norm(curP.original) !== norm(baseP?.text ?? "") : true;
    }
    return {
      type: c.type,
      baseIndex: c.baseIndex,
      curIndex: c.curIndex,
      baseText: baseP?.text ?? "",
      curText: curP?.text ?? "",
      silent,
      baseClause: baseP?.clause ?? null,
      curClause: curP?.clause ?? null,
      ...(c.type === "added" ? { afterBaseIndex: c.afterBaseIndex ?? -1, afterBaseText: baseParas[c.afterBaseIndex ?? -1]?.text ?? "", afterBaseClause: baseParas[c.afterBaseIndex ?? -1]?.clause ?? null } : {}),
    } satisfies CompareChange;
  });
  const hfBase = headerFooterTexts(baseline);
  const hfCur = headerFooterTexts(current);
  const headerFooter: HeaderFooterChange[] = (["页眉", "页脚"] as const)
    .filter((k) => norm(hfBase[k].text) !== norm(hfCur[k].text))
    .map((k) => ({ part: k, baseText: hfBase[k].text, curText: hfCur[k].text, silent: norm(hfCur[k].original) !== norm(hfBase[k].text) }));
  return {
    changes,
    stats: {
      added: changes.filter((c) => c.type === "added").length,
      deleted: changes.filter((c) => c.type === "deleted").length,
      modified: changes.filter((c) => c.type === "modified").length,
      silent: changes.filter((c) => c.silent).length,
    },
    baseParagraphs: baseParas.length,
    curParagraphs: curParas.length,
    curHasTrackedChanges: curAll.some((p) => p.tracked),
    headerFooter,
  };
}

interface RawChange {
  type: "added" | "deleted" | "modified";
  baseIndex: number | null;
  curIndex: number | null;
  /** 新增段落插在旧稿哪一段之后（-1 为最前） */
  afterBaseIndex?: number;
}

/** 段落 LCS 对齐（n*m 超阈值时退化为公共前后缀 + 中间块，保证大文件可用）。 */
function lcsDiff(a: string[], b: string[]): RawChange[] {
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) {
    let i = 0;
    while (i < n && i < m && a[i] === b[i]) i++;
    let j = 0;
    while (j < n - i && j < m - i && a[n - 1 - j] === b[m - 1 - j]) j++;
    const mid: RawChange[] = [];
    const aMid = n - i - j;
    const bMid = m - i - j;
    for (let k = 0; k < Math.min(aMid, bMid); k++) {
      if (a[i + k] !== b[i + k]) mid.push({ type: "modified", baseIndex: i + k, curIndex: i + k });
    }
    for (let k = bMid; k < aMid; k++) mid.push({ type: "deleted", baseIndex: i + k, curIndex: null });
    for (let k = aMid; k < bMid; k++) mid.push({ type: "added", baseIndex: null, curIndex: i + k, afterBaseIndex: i + aMid - 1 });
    return mid;
  }
  // LCS 动态规划
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: RawChange[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    // 同位且足够相似 → modified（回稿场景的典型形态：对方改了条款文字）
    if (similarity(a[i]!, b[j]!) >= 0.4) {
      out.push({ type: "modified", baseIndex: i, curIndex: j });
      i++;
      j++;
      continue;
    }
    if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: "deleted", baseIndex: i, curIndex: null });
      i++;
    } else {
      out.push({ type: "added", baseIndex: null, curIndex: j, afterBaseIndex: i - 1 });
      j++;
    }
  }
  while (i < n) out.push({ type: "deleted", baseIndex: i++, curIndex: null });
  while (j < m) out.push({ type: "added", baseIndex: null, curIndex: j++, afterBaseIndex: n - 1 });
  return out;
}

/** 简易相似度（公共子串比例），用于 paired modified 判定。 */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const minLen = Math.min(a.length, b.length);
  if (minLen === 0) return 0;
  let common = 0;
  const bChars = new Map<string, number>();
  for (const ch of b) bChars.set(ch, (bChars.get(ch) ?? 0) + 1);
  for (const ch of a) {
    const c = bChars.get(ch) ?? 0;
    if (c > 0) {
      common++;
      bChars.set(ch, c - 1);
    }
  }
  return common / Math.max(a.length, b.length);
}
