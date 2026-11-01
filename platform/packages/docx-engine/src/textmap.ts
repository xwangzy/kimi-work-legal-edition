/**
 * document.xml 段落文本映射：把每个 <w:p> 的可见文本映射回 XML 源偏移。
 * 修订写入基于此做定点字符串手术，其余部分字节不动（保真优先）。
 */
export interface TextSegment {
  /** 段内文本偏移 [start, end) */
  start: number;
  end: number;
  /** 文本在整篇 XML 中的偏移（<w:t> 内容区间；制表符、换行为该元素本身的区间） */
  xmlStart: number;
  xmlEnd: number;
  /** 所属 <w:r> 在整篇 XML 中的完整区间（修订手术以 run 为最小切除单位） */
  runXmlStart: number;
  runXmlEnd: number;
  text: string;
  /** 所属 <w:r> 的 rPr XML（用于继承格式；按配对标签取全，含他人格式修订 w:rPrChange 时也完整） */
  rPr: string | null;
  /** 该文本是否在删除标记内（w:delText 或位于未闭合 w:del 内） */
  deleted: boolean;
  /**
   * 内容种类（第 34 批）：文字；制表符（记作“\t”）；换行（w:br / w:cr，记作“\n”）——与材料文字视图（内核 parser 的 inlineText）一致，
   * 律师和助手在材料里看到的“甲方（盖章）：\t乙方（盖章）：”在这里也找得到。
   */
  kind?: "text" | "tab" | "br";
  /** 本次写入中新插入的文字（带 kwl-new 标记的 w:ins 内）：不参与锚点匹配，宽度为 0（第 34 批 D11） */
  fresh?: boolean;
}

export interface ParagraphMap {
  index: number;
  /** 段落 XML 在整篇中的区间 */
  xmlStart: number;
  xmlEnd: number;
  text: string; // 可见文本（不含已删除）
  segments: TextSegment[];
}

/**
 * 段落区间（第 34 批，文档工程压测 D02/D05）：按 <w:p> 的嵌套深度扫描。自闭合空段落 <w:p …/>（Word 常这样写空行，本引擎的
 * createStyledDocx 也这样写）单独算一段——原先的惰性正则会把它连同下一段并成一段，整段删除时写出非法结构；文本框里嵌套的段落
 * （w:txbxContent）算在外层段落里、不单独成段。返回顶层段落在整篇里的 [start, end)。多余的结束标签忽略，没闭合的段落不算。
 */
export function paragraphSpans(xml: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let depth = 0;
  let start = -1;
  for (const m of xml.matchAll(/<(\/?)w:p\b[^>]*?(\/?)>/g)) {
    if (m[2] === "/") {
      if (depth === 0) out.push({ start: m.index!, end: m.index! + m[0].length });
      continue;
    }
    if (!m[1]) {
      if (depth === 0) start = m.index!;
      depth += 1;
      continue;
    }
    if (depth === 0) continue;
    depth -= 1;
    if (depth === 0) out.push({ start, end: m.index! + m[0].length });
  }
  return out;
}

/** 名为 name 的第一个元素（按同名标签配对，嵌套同名元素也取全）：返回在 xml 里的 [start, end)；没有返回 null。 */
export function findElement(xml: string, name: string, from = 0): { start: number; end: number } | null {
  const re = new RegExp(`<(/?)${name.replace(":", "\\:")}(?=[\\s/>])[^>]*?(/?)>`, "g");
  re.lastIndex = from;
  let depth = 0;
  let start = -1;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (m[2] === "/") {
      if (depth === 0) return { start: m.index, end: m.index + m[0].length };
      continue;
    }
    if (!m[1]) {
      if (depth === 0) start = m.index;
      depth += 1;
      continue;
    }
    if (depth === 0) continue;
    depth -= 1;
    if (depth === 0) return { start, end: m.index + m[0].length };
  }
  return null;
}

/** 去掉 xml 里所有名为 names 的元素（按配对取全）。纯函数。 */
export function removeElements(xml: string, names: readonly string[]): string {
  let out = xml;
  for (const name of names) {
    for (let e = findElement(out, name); e; e = findElement(out, name, e.start)) out = out.slice(0, e.start) + out.slice(e.end);
  }
  return out;
}

/** 片段里的顶层元素（任意名，按深度配对）：name、区间；不含元素之间的空白文字。 */
export function childElements(xml: string): { name: string; start: number; end: number }[] {
  const out: { name: string; start: number; end: number }[] = [];
  let depth = 0;
  let start = -1;
  let name = "";
  for (const m of xml.matchAll(/<(\/?)([A-Za-z_][\w.:-]*)\b[^>]*?(\/?)>/g)) {
    if (m[3] === "/") {
      if (depth === 0) out.push({ name: m[2]!, start: m.index!, end: m.index! + m[0].length });
      continue;
    }
    if (!m[1]) {
      if (depth === 0) {
        start = m.index!;
        name = m[2]!;
      }
      depth += 1;
      continue;
    }
    if (depth === 0) continue;
    depth -= 1;
    if (depth === 0) out.push({ name, start, end: m.index! + m[0].length });
  }
  return out;
}

/** 文本框内容（w:txbxContent，里面是嵌套的段落）换成等长空格：偏移不变，外层段落只看自己的 run（第 34 批 D02）。 */
export function maskNested(pXml: string): string {
  let out = pXml;
  for (let e = findElement(out, "w:txbxContent"); e; e = findElement(out, "w:txbxContent", e.end)) out = out.slice(0, e.start) + " ".repeat(e.end - e.start) + out.slice(e.end);
  return out;
}

const R_RE = /<w:r\b[^>]*\/>|<w:r\b[^>]*>[\s\S]*?<\/w:r>/g;
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

/** run 是否在本次写入新插入的 w:ins（带 kwl-new 标记）内：按 w:ins 开闭配对，看最内层（第 34 批 D11）。 */
function insideFreshIns(pXml: string, runStart: number): boolean {
  const stack: boolean[] = [];
  for (const m of pXml.matchAll(/<(\/?)w:ins\b([^>]*?)(\/?)>/g)) {
    if (m.index! >= runStart) break;
    if (m[3] === "/") continue;
    if (m[1]) stack.pop();
    else stack.push(/\skwl-new="/.test(m[2] ?? ""));
  }
  return stack.at(-1) === true;
}

/**
 * 转义并去掉 XML 1.0 不允许的控制字符（制表、换行、回车除外）：模型从 PDF、OCR 摘录里带出的 \f、\v 等原样写进
 * <w:t> 会让 Word 打不开整份文件（第 32 批，复核 A-03）。
 */
export function escapeXml(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 反转义；数字字符引用（&#160; &#x4E09;）也解码（第 34 批 D14：原先原样留在文字里，改同一 run 后正文出现字面“&#160;”）。 */
export function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);|&#x([0-9a-fA-F]+);/g, (m, d: string | undefined, h: string | undefined) => {
      const cp = d !== undefined ? Number(d) : parseInt(h!, 16);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/&amp;/g, "&");
}

/** run 的 rPr（按配对标签取全；第 34 批 D03：含他人格式修订 w:rPrChange 时原先只取到半截）。 */
export function runProps(rXml: string): string | null {
  const open = /^<w:r\b[^>]*>/.exec(rXml);
  if (!open) return null;
  const e = findElement(rXml, "w:rPr", open[0].length);
  if (!e) return null;
  // 只认 run 的第一个子元素位置上的 rPr（不是内容里嵌套的）
  return /^\s*$/.test(rXml.slice(open[0].length, e.start)) ? rXml.slice(e.start, e.end) : null;
}

/** 映射一个段落（pXml 为该段落的 XML，pStart 为其在整篇里的偏移）。 */
export function mapParagraph(pXml: string, pStart: number, index: number): ParagraphMap {
  const masked = maskNested(pXml);
  const segments: TextSegment[] = [];
  let textLen = 0;
  for (const rm of masked.matchAll(R_RE)) {
    if (rm[0].endsWith("/>") && !rm[0].includes("</w:r>")) continue;
    const rStart = rm.index!;
    const rXml = pXml.slice(rStart, rStart + rm[0].length);
    const rpr = runProps(rXml);
    const inDel = insideDel(masked, rStart);
    const fresh = insideFreshIns(masked, rStart);
    const open = /^<w:r\b[^>]*>/.exec(rXml)![0].length;
    const inner = rXml.slice(open, rXml.length - "</w:r>".length);
    for (const c of childElements(inner)) {
      const el = inner.slice(c.start, c.end);
      let text: string;
      let kind: TextSegment["kind"];
      let xs: number;
      let xe: number;
      let isDelText = false;
      if (c.name === "w:t" || c.name === "w:delText") {
        const gt = el.indexOf(">");
        if (el.endsWith("/>")) continue;
        const raw = el.slice(gt + 1, el.length - `</${c.name}>`.length);
        text = unescapeXml(raw);
        kind = "text";
        xs = pStart + rStart + open + c.start + gt + 1;
        xe = xs + raw.length;
        isDelText = c.name === "w:delText";
      } else if (c.name === "w:tab" || c.name === "w:ptab") {
        text = "\t";
        kind = "tab";
        xs = pStart + rStart + open + c.start;
        xe = pStart + rStart + open + c.end;
      } else if (c.name === "w:br" || c.name === "w:cr") {
        text = "\n";
        kind = "br";
        xs = pStart + rStart + open + c.start;
        xe = pStart + rStart + open + c.end;
      } else continue;
      const seg: TextSegment = {
        start: textLen,
        end: textLen + text.length,
        xmlStart: xs,
        xmlEnd: xe,
        runXmlStart: pStart + rStart,
        runXmlEnd: pStart + rStart + rXml.length,
        text,
        rPr: rpr,
        deleted: inDel || isDelText,
        kind,
        ...(fresh ? { fresh: true } : {}),
      };
      segments.push(seg);
      if (!seg.deleted && !fresh) textLen += text.length;
      else {
        // 删除文本、本次新插入的文字不占可见文本位：回退段内偏移
        seg.start = textLen;
        seg.end = textLen;
      }
    }
  }
  const visible = segments.filter((s) => !s.deleted && !s.fresh).map((s) => s.text).join("");
  return { index, xmlStart: pStart, xmlEnd: pStart + pXml.length, text: visible, segments };
}

/** 把段落里含多个内容（文字、制表符、换行……）的 run 拆成一个内容一个 run（格式照抄）；段落之外不动。 */
export function splitParagraphRuns(xml: string, target: { xmlStart: number; xmlEnd: number }, nextId?: () => number): string {
  const paraXml = xml.slice(target.xmlStart, target.xmlEnd);
  // 与 mapParagraph 同一口径：在遮盖了文本框内容的副本上找 run（文本框里的 run 不动），按位置取原文
  const masked = maskNested(paraXml);
  let out = "";
  let cursor = 0;
  for (const m of masked.matchAll(R_RE)) {
    out += paraXml.slice(cursor, m.index!);
    cursor = m.index! + m[0].length;
    out += splitRun(paraXml.slice(m.index!, cursor), nextId);
  }
  out += paraXml.slice(cursor);
  return out === paraXml ? xml : xml.slice(0, target.xmlStart) + out + xml.slice(target.xmlEnd);
}

function splitRun(rXml: string, nextId?: () => number): string {
  if (rXml.endsWith("/>") && !rXml.includes("</w:r>")) return rXml;
  const open = /^<w:r\b[^>]*>/.exec(rXml)![0];
  const inner = rXml.slice(open.length, rXml.length - "</w:r>".length);
  const rPr = runProps(rXml) ?? "";
  const kids = childElements(inner).filter((k) => k.name !== "w:rPr");
  // 文本框（嵌套段落）所在的 run 不拆：childElements 按深度配对，图形整块算一个内容
  if (kids.length <= 1 || /<w:txbxContent\b/.test(inner)) return rXml;
  // 拆出的第二段起，格式里的格式修订记录（w:rPrChange）换新编号，免得同一编号出现在几个 run 里
  const renumber = (x: string) => (nextId ? x.replace(/(<w:rPrChange\b[^>]*?\bw:id=")\d+(")/g, (_m, a: string, c: string) => `${a}${nextId()}${c}`) : x);
  return kids.map((k, i) => `${open}${i === 0 ? rPr : renumber(rPr)}${inner.slice(k.start, k.end)}</w:r>`).join("");
}

export function mapParagraphs(documentXml: string): ParagraphMap[] {
  return paragraphSpans(documentXml).map((sp, i) => mapParagraph(documentXml.slice(sp.start, sp.end), sp.start, i));
}

/** 不间断空格（U+00A0、U+202F）记作普通空格；长度不变。 */
export function sameSpaces(s: string): string {
  return s.replace(/[\u00a0\u202f]/g, " ");
}

/** 在段落文本中定位原文（支持第 N 次出现），返回段内 [start, end)。 */
export function findInParagraph(para: ParagraphMap, originalText: string, occurrence = 0): { start: number; end: number } | null {
  let idx = -1;
  let from = 0;
  // 不间断空格与普通空格按同一个字比（等长替换，偏移不变；第 34 批压测 E18：模型转述时常把 NBSP 写成普通空格）
  const hay = sameSpaces(para.text);
  const needle = sameSpaces(originalText);
  for (let i = 0; i <= occurrence; i++) {
    idx = hay.indexOf(needle, from);
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
