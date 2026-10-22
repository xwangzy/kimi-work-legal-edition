/**
 * document.xml 段落文本映射：把每个 <w:p> 的可见文本映射回 XML 源偏移。
 * 修订写入基于此做定点字符串手术，其余部分字节不动（保真优先）。
 */
export interface TextSegment {
  /** 段内文本偏移 [start, end) */
  start: number;
  end: number;
  /** 文本在整篇 XML 中的偏移（<w:t> 内容区间） */
  xmlStart: number;
  xmlEnd: number;
  /** 所属 <w:r> 在整篇 XML 中的完整区间（修订手术以 run 为最小切除单位） */
  runXmlStart: number;
  runXmlEnd: number;
  text: string;
  /** 所属 <w:r> 的 rPr XML（用于继承格式） */
  rPr: string | null;
  /** 该文本是否在删除标记内（w:delText 或位于未闭合 w:del 内） */
  deleted: boolean;
}

export interface ParagraphMap {
  index: number;
  /** 段落 XML 在整篇中的区间 */
  xmlStart: number;
  xmlEnd: number;
  text: string; // 可见文本（不含已删除）
  segments: TextSegment[];
}

const P_RE = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
const R_RE = /<w:r\b[^>]*>[\s\S]*?<\/w:r>/g;
const T_RE = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/;
const DELT_RE = /<w:delText\b[^>]*>([\s\S]*?)<\/w:delText>/;
const RPR_RE = /<w:rPr>[\s\S]*?<\/w:rPr>/;
/**
 * 删除区段的开/闭标记：w:del 与 w:moveFrom（移动修订的原位置，等同删除；复核 C-B03，与解析器口径一致）。
 * 自闭合的 `<w:del …/>`（段落标记被删，出现在 rPr 里）不是区段开头——否则会把其后整段都当成已删除。
 */
const DEL_OPEN = /<w:(?:del|moveFrom)\b[^>]*(?<!\/)>/g;
const DEL_CLOSE = /<\/w:(?:del|moveFrom)>/g;

/** run 是否位于未闭合的 w:del / w:moveFrom 内（比较其前最近一次开/闭标记的位置）。 */
function insideDel(pXml: string, runStart: number): boolean {
  DEL_OPEN.lastIndex = 0;
  DEL_CLOSE.lastIndex = 0;
  let lastOpen = -1;
  let lastClose = -1;
  for (const m of pXml.matchAll(DEL_OPEN)) {
    if (m.index! < runStart) lastOpen = m.index!;
    else break;
  }
  for (const m of pXml.matchAll(DEL_CLOSE)) {
    if (m.index! < runStart) lastClose = m.index!;
    else break;
  }
  return lastOpen > lastClose;
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

export function mapParagraphs(documentXml: string): ParagraphMap[] {
  const out: ParagraphMap[] = [];
  let pIdx = 0;
  for (const pm of documentXml.matchAll(P_RE)) {
    const pStart = pm.index!;
    const pXml = pm[0];
    const segments: TextSegment[] = [];
    let textLen = 0;
    for (const rm of pXml.matchAll(R_RE)) {
      const rStart = rm.index!;
      const rXml = rm[0];
      const rpr = RPR_RE.exec(rXml)?.[0] ?? null;
      const inDel = insideDel(pXml, rm.index!);
      const tMatch = T_RE.exec(rXml) ?? DELT_RE.exec(rXml);
      if (!tMatch) continue;
      const isDelText = DELT_RE.test(rXml) && !T_RE.test(rXml);
      const tXmlStart = rStart + tMatch.index + tMatch[0].indexOf(">") + 1;
      const raw = tMatch[1] ?? "";
      const text = unescapeXml(raw);
      const seg: TextSegment = {
        start: textLen,
        end: textLen + text.length,
        xmlStart: pStart + tXmlStart,
        xmlEnd: pStart + tXmlStart + raw.length,
        runXmlStart: pStart + rStart,
        runXmlEnd: pStart + rStart + rXml.length,
        text,
        rPr: rpr,
        deleted: inDel || isDelText,
      };
      segments.push(seg);
      if (!seg.deleted) textLen += text.length;
      else {
        // 删除文本不占可见文本位：回退段内偏移
        seg.start = textLen;
        seg.end = textLen;
      }
    }
    const visible = segments.filter((s) => !s.deleted).map((s) => s.text).join("");
    out.push({ index: pIdx++, xmlStart: pStart, xmlEnd: pStart + pXml.length, text: visible, segments });
  }
  return out;
}

/** 在段落文本中定位原文（支持第 N 次出现），返回段内 [start, end)。 */
export function findInParagraph(para: ParagraphMap, originalText: string, occurrence = 0): { start: number; end: number } | null {
  let idx = -1;
  let from = 0;
  for (let i = 0; i <= occurrence; i++) {
    idx = para.text.indexOf(originalText, from);
    if (idx < 0) return null;
    from = idx + originalText.length;
  }
  return { start: idx, end: idx + originalText.length };
}

/** 段落所在的表格单元格（v9.4 第 21 批，评审 C1 §2 第 8 项“表格里的条款也审”）：第几张表、第几行、第几列（均从 1 起），以及该列首行的文字（多为列名）。 */
export interface CellPosition {
  table: number;
  row: number;
  col: number;
  header: string;
}

/**
 * 每个段落（与 mapParagraphs 同一顺序）在不在表格单元格里；不在表格里的为 null。
 * 嵌套表按最内层计位置、表号按出现顺序；首行文字取最内层表第一行同列单元格的可见文本（截 20 字）。
 */
export function paragraphCells(documentXml: string): (CellPosition | null)[] {
  const paras = mapParagraphs(documentXml);
  const TAG = /<(\/?)w:(tbl|tr|tc)\b[^>]*?(\/?)>/g;
  type Frame = { table: number; row: number; col: number };
  const stack: Frame[] = [];
  let tables = 0;
  const events = [...documentXml.matchAll(TAG)].filter((m) => m[3] !== "/");
  const out: (CellPosition | null)[] = [];
  const firstRow = new Map<string, string>();
  let e = 0;
  for (const p of paras) {
    while (e < events.length && events[e]!.index! < p.xmlStart) {
      const [, close, tag] = events[e]!;
      if (!close) {
        if (tag === "tbl") stack.push({ table: ++tables, row: 0, col: 0 });
        else if (tag === "tr" && stack.length) {
          stack.at(-1)!.row += 1;
          stack.at(-1)!.col = 0;
        } else if (tag === "tc" && stack.length) stack.at(-1)!.col += 1;
      } else if (tag === "tbl") stack.pop();
      e += 1;
    }
    const f = stack.at(-1);
    if (!f || f.row === 0 || f.col === 0) {
      out.push(null);
      continue;
    }
    if (f.row === 1) {
      const k = `${f.table}:${f.col}`;
      firstRow.set(k, `${firstRow.get(k) ?? ""}${p.text}`);
    }
    out.push({ table: f.table, row: f.row, col: f.col, header: "" });
  }
  for (const c of out) if (c) c.header = (firstRow.get(`${c.table}:${c.col}`) ?? "").trim().slice(0, 20);
  return out;
}

/** 单元格位置的律师说法：“表 2 第 3 行第 2 列（单价）”；首行本身不带列名。 */
export function cellPositionLabel(c: CellPosition): string {
  return `表 ${c.table} 第 ${c.row} 行第 ${c.col} 列${c.row > 1 && c.header ? `（${c.header}）` : ""}`;
}
