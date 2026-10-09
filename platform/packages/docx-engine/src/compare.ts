/**
 * 整稿比对（S1b）：段落级 LCS 对齐，找出全部改动，含未开修订的静默改动。
 * 语义（§S1b）：区分新增/删除/修改；当前稿中被 w:ins/w:del 覆盖的改动标 tracked=true，
 * 未被覆盖的为静默改动（对方未开修订直接改文）。
 */
import { readZipText } from "./zip.ts";
import { mapParagraphs } from "./textmap.ts";

export interface DocxParagraph {
  index: number;
  text: string;
  tracked: boolean; // 该段含修订标记
}

export interface CompareChange {
  type: "added" | "deleted" | "modified";
  baseIndex: number | null;
  curIndex: number | null;
  baseText: string;
  curText: string;
  silent: boolean; // 未被修订标记覆盖 = 静默改动
}

export interface CompareResult {
  changes: CompareChange[];
  stats: { added: number; deleted: number; modified: number; silent: number };
  baseParagraphs: number;
  curParagraphs: number;
  curHasTrackedChanges: boolean;
}

export function extractParagraphs(docx: Buffer): DocxParagraph[] {
  const xml = readZipText(docx, "word/document.xml");
  if (xml === null) throw new Error("DOCX 缺少 word/document.xml");
  const maps = mapParagraphs(xml);
  return maps.map((p) => ({
    index: p.index,
    text: p.text,
    tracked: p.segments.some((s) => s.deleted) || /<w:ins\b/.test(xml.slice(p.xmlStart, p.xmlEnd)),
  }));
}

export function compareDocx(baseline: Buffer, current: Buffer): CompareResult {
  const baseParas = extractParagraphs(baseline).filter((p) => p.text.trim() !== "");
  const curParas = extractParagraphs(current).filter((p) => p.text.trim() !== "");
  const changes = lcsDiff(
    baseParas.map((p) => p.text),
    curParas.map((p) => p.text),
  ).map((c) => {
    const curP = c.curIndex !== null ? curParas[c.curIndex] : undefined;
    const silent = c.type === "deleted" ? true : curP ? !curP.tracked : true;
    return {
      ...c,
      baseText: c.baseIndex !== null ? (baseParas[c.baseIndex]?.text ?? "") : "",
      curText: c.curIndex !== null ? (curParas[c.curIndex]?.text ?? "") : "",
      silent,
    } satisfies CompareChange;
  });
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
    curHasTrackedChanges: curParas.some((p) => p.tracked),
  };
}

interface RawChange {
  type: "added" | "deleted" | "modified";
  baseIndex: number | null;
  curIndex: number | null;
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
    for (let k = aMid; k < bMid; k++) mid.push({ type: "added", baseIndex: null, curIndex: i + k });
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
      out.push({ type: "added", baseIndex: null, curIndex: j });
      j++;
    }
  }
  while (i < n) out.push({ type: "deleted", baseIndex: i++, curIndex: null });
  while (j < m) out.push({ type: "added", baseIndex: null, curIndex: j++ });
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
