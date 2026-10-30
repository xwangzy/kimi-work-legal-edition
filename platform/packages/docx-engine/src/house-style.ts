/**
 * 律所版式（v9.3 第 15 批 B-4；评审 Z1 P1-1：生成的 Word 没有样式、字体、页面、函头、页码、落款）。
 *
 * 本产品生成的 Word（意见书、报告、补证清单、Agent 写的 Markdown 备忘录导出成 Word）一律带一套版式：
 * - A4，页边距按党政机关公文格式（上 3.7、下 3.5、左 2.8、右 2.6 厘米）；
 * - 正文宋体小四、1.5 倍行距（缺省），或仿宋三号、固定行距 28 磅（诉讼文书惯例）；正文首行缩进两字；
 * - 标题居中加粗，一级标题黑体、二级标题楷体；表格加边框；落款（律所、律师、日期）右对齐；
 * - 页脚居中“第 X 页 共 Y 页”；有函头时页眉居中写律所名称与一两行地址电话，下有横线。
 * 律所上传自己的 Word 模板（.dotx / .docx）时，样式、页眉页脚（含徽标图片）、主题取自模板，模板里没有的样式才用本产品的。
 *
 * 版式只在“下载 / 导出”时套用（成果登记的字节与哈希不变）；只有带本产品标记（docProps/core.xml 的 category）的文件才会被重新套版式，
 * 律师上传的原件、对方合同的修订稿一律不动。写出经 writeZip（去除打开时会外取的引用；模板里的链接图片、附加模板等一并去掉）。
 */
import { posix } from "node:path";
import { readZipEntries, readZipSelected, writeZip, type ZipEntryOut } from "./zip.ts";
import { escapeXml } from "./textmap.ts";

export interface Run {
  text: string;
  bold?: boolean;
}

export type DocBlock =
  | { kind: "title"; text: string }
  | { kind: "h1" | "h2" | "h3"; text: string }
  | { kind: "p"; runs: Run[]; keepNext?: boolean }
  | { kind: "li"; runs: Run[]; marker: string; level?: number }
  | { kind: "table"; rows: Run[][][] }
  | { kind: "right"; text: string }
  | { kind: "blank" };

export interface HouseStyle {
  /** 函头：律所名称与至多两行地址、电话（页眉）；null 不加。 */
  letterhead: { name: string; lines: string[] } | null;
  /** 正文字体与字号：宋体小四（缺省，意见书、备忘录）或仿宋三号（起诉状、律师函等）。 */
  body: "song-xiaosi" | "fangsong-san";
  pageNumbers: boolean;
}

export const DEFAULT_HOUSE_STYLE: HouseStyle = { letterhead: null, body: "song-xiaosi", pageNumbers: true };

/** 递交法院、仲裁机构的文书（按文件名判断；第 28 批）：导出时不套律所函头与律所模板，正文仿宋三号。 */
const COURT_FILING = /(起诉状|反诉状|答辩状|上诉状|答辩书|申请书|代理词|质证意见|再审申请|保全申请|执行申请)/;

export function isCourtFiling(filename: string): boolean {
  return COURT_FILING.test(filename);
}

/** 递交法院的文书用的版式：去掉函头，正文仿宋三号，页码照旧。 */
export function courtFilingStyle(style: HouseStyle): HouseStyle {
  return { ...style, letterhead: null, body: "fangsong-san" };
}

/** 本产品生成的文件的标记（docProps/core.xml 的 cp:category）：只有带它的文件在导出时会重新套版式。 */
export const HOUSE_STYLE_MARK = "kwl-house-style/1";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const CT_DOC = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const CT_STYLES = "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml";
const CT_HEADER = "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml";
const CT_FOOTER = "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml";
const CT_THEME = "application/vnd.openxmlformats-officedocument.theme+xml";
const CT_NUMBERING = "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml";
const CT_CORE = "application/vnd.openxmlformats-package.core-properties+xml";
const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", emf: "image/x-emf", wmf: "image/x-wmf", tif: "image/tiff", tiff: "image/tiff" };

/** 本产品的样式编号（正文段落里写的就是这些；套模板时按样式名换成模板里的编号）。 */
const IDS = { title: "KwlTitle", h1: "KwlHeading1", h2: "KwlHeading2", h3: "KwlHeading3", body: "KwlBody", list: "KwlList", table: "KwlTable", right: "KwlRight" } as const;
type Role = keyof typeof IDS;
/** 模板里按样式名认的角色（Word 内置样式名不随界面语言变；正文、表格、落款没有内置对应，用本产品的）。 */
const TEMPLATE_NAMES: Partial<Record<Role, string>> = { title: "title", h1: "heading 1", h2: "heading 2", h3: "heading 3", list: "list paragraph" };

const MARGINS = { top: 2098, bottom: 1984, left: 1587, right: 1474, header: 851, footer: 992 };

function fonts(style: HouseStyle): { body: string; size: number; line: string; title: number; h1: number; h2: number; h3: number } {
  return style.body === "fangsong-san"
    ? { body: "仿宋", size: 32, line: `<w:spacing w:line="560" w:lineRule="exact"/>`, title: 44, h1: 32, h2: 32, h3: 32 }
    : { body: "宋体", size: 24, line: `<w:spacing w:line="360" w:lineRule="auto"/>`, title: 36, h1: 28, h2: 24, h3: 24 };
}

function rFonts(eastAsia: string): string {
  return `<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="${eastAsia}" w:cs="Times New Roman"/>`;
}

/** 本产品的 styles.xml（Normal 为缺省段落样式）。 */
function ourStylesXml(style: HouseStyle): string {
  const f = fonts(style);
  const st = (id: string, name: string, ppr: string, rpr: string, extra = "") =>
    `<w:style w:type="paragraph" w:customStyle="1" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="${IDS.body}"/><w:qFormat/>${extra}<w:pPr>${ppr}</w:pPr><w:rPr>${rpr}</w:rPr></w:style>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr>${rFonts(f.body)}<w:sz w:val="${f.size}"/><w:szCs w:val="${f.size}"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>${f.line}</w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:jc w:val="both"/></w:pPr></w:style>
${st(IDS.title, "Title", `<w:spacing w:before="240" w:after="360"/><w:jc w:val="center"/><w:outlineLvl w:val="0"/>`, `${rFonts("宋体")}<w:b/><w:sz w:val="${f.title}"/><w:szCs w:val="${f.title}"/>`)}
${st(IDS.h1, "heading 1", `<w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/>`, `${rFonts("黑体")}<w:sz w:val="${f.h1}"/><w:szCs w:val="${f.h1}"/>`)}
${st(IDS.h2, "heading 2", `<w:keepNext/><w:spacing w:before="120" w:after="60"/><w:ind w:firstLineChars="200" w:firstLine="${f.size * 20}"/><w:outlineLvl w:val="1"/>`, `${rFonts("楷体")}<w:b/><w:sz w:val="${f.h2}"/><w:szCs w:val="${f.h2}"/>`)}
${st(IDS.h3, "heading 3", `<w:keepNext/><w:ind w:firstLineChars="200" w:firstLine="${f.size * 20}"/><w:outlineLvl w:val="2"/>`, `<w:b/><w:sz w:val="${f.h3}"/><w:szCs w:val="${f.h3}"/>`)}
${st(IDS.body, "Kwl Body", `<w:ind w:firstLineChars="200" w:firstLine="${f.size * 20}"/>`, "")}
${st(IDS.list, "List Paragraph", `<w:ind w:left="${f.size * 20}" w:hanging="${f.size * 10}"/>`, "")}
${st(IDS.table, "Kwl Table Text", `<w:spacing w:line="240" w:lineRule="auto"/><w:jc w:val="left"/>`, `<w:sz w:val="${Math.min(f.size, 24)}"/><w:szCs w:val="${Math.min(f.size, 24)}"/>`)}
${st(IDS.right, "Kwl Signature", `<w:jc w:val="right"/>`, "")}
</w:styles>`;
}

function runXml(r: Run): string {
  return `<w:r>${r.bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${escapeXml(r.text)}</w:t></w:r>`;
}

function para(styleId: string, runs: Run[]): string {
  return `<w:p><w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>${runs.map(runXml).join("")}</w:p>`;
}

/** 表格版心宽（twip）：A4 宽 11906 减左右页边距。 */
const TABLE_WIDTH = 8845;
/** 表格文字小四（12 磅）：半个汉字宽 120 twip（汉字 240、西文数字与小写约 120、大写字母约 155）；单元格左右边距各 108，另留 24 给粗体表头与字体差异。 */
const HALF_EM = 120;
const CELL_PAD = 108 * 2 + 24;

/**
 * 列宽（第 32 批，复核 A-01；真实走查 W1、W2 后改为“数据格行数最少”）：
 * 从 1 行起找最小的行数 L，使每列放得下——最长的数据格折成 L 行、表头折成至多 1～3 行（L 小时表头不折，L 大时允许折到 3 行）、
 * 最长的不可断开的西文串（金额“1,200,000.00”、型号“HZ-ZZ-8000”、信用代码，至多 18 个半角宽）与两个汉字——且合计不超过版心，
 * 再放满版心（先让差得少的短列一行放下，余下给仍要折行的列）。长内容的列（设备名称、备注、证明目的）因此分到相近的行数；列很多的证据目录（8 列）表头折行，
 * 不再整表按比例缩到“证明目的”一行 4 个字。连保底都放不下时按保底比例缩。
 */
function columnWidths(rows: Run[][][], cols: number): number[] {
  const units = (s: string) => [...s].reduce((n, ch) => n + (ch.codePointAt(0)! > 0x2e7f ? 2 : /[A-Zmw]/.test(ch) ? 1.3 : 1), 0);
  const text = (r: Run[][] | undefined, c: number) => (r?.[c] ?? []).map((x) => x.text).join("");
  const longestRun = (s: string) => Math.max(0, ...(s.match(/[!-~]+/g) ?? []).map(units));
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const fill = (ws: number[]) => ws.map((w) => Math.floor((TABLE_WIDTH * w) / sum(ws)));
  const data = rows.length > 1 ? rows.slice(1) : rows;
  const floor = Array.from({ length: cols }, (_, c) => Math.max(4, ...rows.map((r) => Math.min(18, longestRun(text(r, c))))));
  const head = Array.from({ length: cols }, (_, c) => units(text(rows[0], c)));
  const longest = Array.from({ length: cols }, (_, c) => Math.max(0, ...data.map((r) => units(text(r, c)))));
  // 数据一行放得下的宽度；放满版心时先让差得少的短列（“证据1”“第1、2项”）一行放下，余下给仍要折行的长内容列
  const oneLine = floor.map((f, c) => CELL_PAD + HALF_EM * Math.max(f, Math.ceil(longest[c]!)));
  const spread = (ws: number[]) => {
    const out = ws.slice();
    let spare = TABLE_WIDTH - sum(out);
    for (const c of out.map((_, i) => i).filter((i) => oneLine[i]! > out[i]!).sort((a, b) => oneLine[a]! - out[a]! - (oneLine[b]! - out[b]!))) {
      if (oneLine[c]! - out[c]! > spare) break;
      spare -= oneLine[c]! - out[c]!;
      out[c] = oneLine[c]!;
    }
    const wrapping = out.map((_, i) => i).filter((i) => oneLine[i]! > out[i]!);
    const take = wrapping.length > 0 ? wrapping : out.map((_, i) => i);
    const base = sum(take.map((i) => out[i]!));
    for (const i of take) out[i] = Math.floor(out[i]! + (spare * out[i]!) / base);
    return out;
  };
  for (let lines = 1; lines <= 60; lines += 1) {
    const headLines = lines <= 2 ? 1 : lines <= 6 ? 2 : 3;
    const ws = floor.map((f, c) => CELL_PAD + HALF_EM * Math.max(f, Math.ceil(head[c]! / headLines), Math.ceil(longest[c]! / lines)));
    if (sum(ws) <= TABLE_WIDTH) return spread(ws);
  }
  return fill(floor.map((f) => CELL_PAD + HALF_EM * f));
}

/** 正文块 → document.xml 的 body 内容（样式写本产品编号）。 */
export function blocksToBodyXml(blocks: DocBlock[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === "title") out.push(para(IDS.title, [{ text: b.text }]));
    else if (b.kind === "h1" || b.kind === "h2" || b.kind === "h3") out.push(para(IDS[b.kind], [{ text: b.text }]));
    else if (b.kind === "p") {
      const p = para(IDS.body, b.runs);
      out.push(b.keepNext ? p.replace(`<w:pStyle w:val="${IDS.body}"/>`, `<w:pStyle w:val="${IDS.body}"/><w:keepNext/>`) : p);
    }
    else if (b.kind === "li") {
      // 嵌套列表按层级加缩进（复核 R15B-20）
      const lvl = Math.min(4, Math.max(0, b.level ?? 0));
      const p = para(IDS.list, [{ text: `${b.marker}\t` }, ...b.runs]);
      out.push(lvl === 0 ? p : p.replace(`<w:pStyle w:val="${IDS.list}"/>`, `<w:pStyle w:val="${IDS.list}"/><w:ind w:left="${480 * (lvl + 1)}" w:hanging="240"/>`));
    }
    else if (b.kind === "right") out.push(para(IDS.right, [{ text: b.text }]));
    else if (b.kind === "blank") out.push(`<w:p/>`);
    else if (b.kind === "table" && b.rows.length > 0) {
      const cols = Math.max(1, ...b.rows.map((r) => r.length));
      const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`;
      const widths = columnWidths(b.rows, cols);
      const grid = widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("");
      // 首行是表头：跨页时在每页重复（第 32 批，设备清单、证据目录常跨页）；
      // 每行不拆到两页（第 33 批，Word 实开：证据目录一行拆开后末页只剩表头与一个字；行高超过一页时 Word 仍会拆）
      const rows = b.rows
        .map((r, i) => {
          const cells = Array.from({ length: cols }, (_, c) => r[c] ?? []);
          // 格内上下居中（汉字与纯数字的格行高不同，顶端对齐时看着错位）；表头左右居中，并与第一行数据同页（第 33 批：行不拆后表头曾独自留在页末）
          const cellPara = (runs: Run[]) => (i === 0 ? para(IDS.table, runs.map((x) => ({ ...x, bold: true }))).replace(`<w:pStyle w:val="${IDS.table}"/>`, `<w:pStyle w:val="${IDS.table}"/><w:keepNext/><w:jc w:val="center"/>`) : para(IDS.table, runs));
          return `<w:tr><w:trPr><w:cantSplit/>${i === 0 ? "<w:tblHeader/>" : ""}</w:trPr>${cells.map((runs, c) => `<w:tc><w:tcPr><w:tcW w:w="${widths[c]}" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr>${cellPara(runs)}</w:tc>`).join("")}</w:tr>`;
        })
        .join("");
      out.push(`<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(border).join("")}</w:tblBorders><w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl>`);
      out.push(`<w:p/>`);
    }
  }
  return out.join("");
}

function headerXml(lh: { name: string; lines: string[] }): string {
  const lines = lh.lines.filter((l) => l.trim()).slice(0, 2);
  const border = `<w:pBdr><w:bottom w:val="single" w:sz="12" w:space="4" w:color="000000"/></w:pBdr>`;
  const p = (text: string, sz: number, bold: boolean, last: boolean) =>
    `<w:p><w:pPr>${last ? border : ""}<w:spacing w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr><w:r><w:rPr>${rFonts(bold ? "黑体" : "宋体")}${bold ? "<w:b/>" : ""}<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="${W}" xmlns:r="${R}">${p(lh.name, 32, true, lines.length === 0)}${lines.map((l, i) => p(l, 18, false, i === lines.length - 1)).join("")}</w:hdr>`;
}

function footerXml(): string {
  const run = (t: string) => `<w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${t}</w:t></w:r>`;
  const field = (instr: string) => `<w:fldSimple w:instr=" ${instr} "><w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t>1</w:t></w:r></w:fldSimple>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="${W}" xmlns:r="${R}"><w:p><w:pPr><w:jc w:val="center"/></w:pPr>${run("第 ")}${field("PAGE")}${run(" 页 共 ")}${field("NUMPAGES")}${run(" 页")}</w:p></w:ftr>`;
}

function coreXml(mark = true): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:creator>Kimi Work 法律行业发行版（AI 辅助起草，经律师复核）</dc:creator>
<cp:lastModifiedBy></cp:lastModifiedBy>
${mark ? `<cp:category>${HOUSE_STYLE_MARK}</cp:category>\n` : ""}</cp:coreProperties>`;
}

// ─── 律所模板（.dotx / .docx）───

/** 模板里拷过来的一个页眉或页脚：部件、它的关系文件（图片已改名）。 */
interface TemplateHf {
  xml: Buffer;
  rels: Buffer | null;
}

export interface TemplateParts {
  styles: string;
  /** 角色 → 模板里的样式编号（模板没有的角色不在表里，用本产品注入的样式）。 */
  ids: Partial<Record<Role, string>>;
  normalId: string;
  /** 缺省页眉页脚与“首页不同”的首页页眉页脚（复核 R15B-10）。 */
  header: TemplateHf | null;
  footer: TemplateHf | null;
  firstHeader: TemplateHf | null;
  firstFooter: TemplateHf | null;
  titlePg: boolean;
  /** 模板的纸张与页边距（复核 R15B-22：用模板时沿用模板的页面设置）。 */
  pgSz: string | null;
  pgMar: string | null;
  /** 页眉页脚引用的图片：已改名为 media/kwl-tpl-N.ext（复核 R15A-08：不和原文件的同名部件冲突）→ 字节与内容类型。 */
  media: Map<string, { data: Buffer; type: string }>;
  theme: Buffer | null;
  numbering: Buffer | null;
  /** 页眉页脚里的文字（给律师确认里面没有具体案件的信息，复核 R15A-09）。 */
  headerText: string;
  footerText: string;
}

export const TEMPLATE_MAX_BYTES = 5 * 1024 * 1024;
/** 每个部件与合计的解压上限（复核 R15A-13）。 */
const PART_MAX = { styles: 2 * 1024 * 1024, hf: 1024 * 1024, media: 2 * 1024 * 1024, total: 10 * 1024 * 1024 };

const attrOf = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

/** 关系文件 → 编号到目标的表（按字面编号查，不把模板里的编号拼进正则，复核 R15A-13）。 */
function relMap(xml: string): Map<string, { target: string; type: string; external: boolean; tag: string }> {
  const out = new Map<string, { target: string; type: string; external: boolean; tag: string }>();
  for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attrOf(m[0], "Id");
    const target = attrOf(m[0], "Target");
    if (id && target) out.set(id, { target, type: attrOf(m[0], "Type") ?? "", external: /TargetMode="External"/i.test(m[0]), tag: m[0] });
  }
  return out;
}

/** SVG 里有没有外取（href 指向网址、文件或协议相对地址）：有就整份页眉页脚不用（复核 R15A-10）。 */
function svgFetchesOutside(svg: Buffer): boolean {
  return /\b(?:xlink:)?href\s*=\s*["']\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(svg.toString("utf8"));
}

const visibleText = (xml: string) =>
  xml
    .replace(/<w:tab\b[^>]*\/>/g, " ")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\n{2,}/g, "\n")
    .trim();

/**
 * 读律所模板：只解压用得到的部件（样式、缺省与首页的页眉页脚及其图片、主题、编号、页面设置），每个部件与合计都有上限；
 * 页眉页脚引用了图片以外的包内部件（批注、设置、正文等）的，这份页眉页脚不用；图片按模板自己的内容类型登记，改名后放入。读不出返回 null。
 */
export function readTemplate(buf: Buffer): TemplateParts | null {
  if (buf.length > TEMPLATE_MAX_BYTES) return null;
  let budget = PART_MAX.total;
  const take = (names: Set<string>, cap: number): Map<string, Buffer> | null => {
    let got: Map<string, Buffer>;
    try {
      got = readZipSelected(buf, (n) => names.has(n.toLowerCase()));
    } catch {
      return null;
    }
    for (const [, d] of got) {
      if (d.length > cap) return null;
      budget -= d.length;
    }
    return budget < 0 ? null : new Map([...got].map(([k, v]) => [k.toLowerCase(), v]));
  };
  const base = take(new Set(["[content_types].xml", "word/document.xml", "word/_rels/document.xml.rels", "word/styles.xml", "word/theme/theme1.xml", "word/numbering.xml"]), PART_MAX.styles);
  if (!base) return null;
  const stylesBuf = base.get("word/styles.xml");
  if (!stylesBuf) return null;
  const styles = stylesBuf.toString("utf8");
  const ids: Partial<Record<Role, string>> = {};
  let normalId = "Normal";
  for (const m of styles.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    if (attrOf(m[1]!, "w:type") !== "paragraph") continue;
    const id = attrOf(m[1]!, "w:styleId");
    const name = /<w:name\s+w:val="([^"]*)"/.exec(m[2]!)?.[1]?.toLowerCase();
    if (!id || !name || !/^[A-Za-z0-9_\-一-鿿]{1,64}$/.test(id)) continue;
    if (attrOf(m[1]!, "w:default") === "1") normalId = id;
    for (const [role, want] of Object.entries(TEMPLATE_NAMES) as [Role, string][]) if (name === want && !ids[role]) ids[role] = id;
  }
  const doc = base.get("word/document.xml")?.toString("utf8") ?? "";
  const sect = /<w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr>/.exec(doc.slice(doc.lastIndexOf("<w:sectPr")))?.[0] ?? "";
  const docRels = relMap(base.get("word/_rels/document.xml.rels")?.toString("utf8") ?? "");
  const ct = base.get("[content_types].xml")?.toString("utf8") ?? "";
  const ctOf = (part: string): string | null => {
    const ov = [...ct.matchAll(/<Override\b[^>]*>/g)].find((m) => (attrOf(m[0], "PartName") ?? "").toLowerCase() === `/${part.toLowerCase()}`);
    if (ov) return attrOf(ov[0], "ContentType");
    const ext = part.split(".").pop()!.toLowerCase();
    const df = [...ct.matchAll(/<Default\b[^>]*>/g)].find((m) => (attrOf(m[0], "Extension") ?? "").toLowerCase() === ext);
    return df ? attrOf(df[0], "ContentType") : (IMAGE_TYPES[ext] ?? null);
  };
  const safeTarget = (t: string) => {
    if (/[:\\]|^\//.test(t)) return null;
    const full = posix.normalize(`word/${t}`);
    return full.startsWith("word/") && !full.startsWith("../") ? full : null;
  };
  const refTarget = (kind: "header" | "footer", type: "default" | "first") => {
    const ref = [...sect.matchAll(new RegExp(`<w:${kind}Reference\\b[^>]*>`, "g"))].find((m) => (attrOf(m[0], "w:type") ?? "default") === type)?.[0];
    const rid = ref ? attrOf(ref, "r:id") : null;
    const rel = rid ? docRels.get(rid) : undefined;
    return rel && !rel.external ? safeTarget(rel.target) : null;
  };
  const media = new Map<string, { data: Buffer; type: string }>();
  let mediaNo = 0;
  const hfTexts: { header: string[]; footer: string[] } = { header: [], footer: [] };
  const part = (kind: "header" | "footer", type: "default" | "first"): TemplateHf | null => {
    const full = refTarget(kind, type);
    if (!full) return null;
    const relsName = `word/_rels/${full.slice("word/".length)}.rels`;
    const got = take(new Set([full.toLowerCase(), relsName.toLowerCase()]), PART_MAX.hf);
    const xml = got?.get(full.toLowerCase());
    if (!got || !xml) return null;
    let relsXml = got.get(relsName.toLowerCase())?.toString("utf8") ?? null;
    if (relsXml) {
      for (const [, r] of relMap(relsXml)) {
        if (r.external) continue; // 外部关系由 writeZip 去除（超链接保留）
        const target = safeTarget(r.target);
        const ext = (target ?? "").split(".").pop()!.toLowerCase();
        // 只收 media/ 下的图片；指向别的包内部件（批注、设置、正文……）的页眉页脚整份不用
        if (!target || !target.startsWith("word/media/") || !/\/image$/.test(r.type)) return null;
        const img = take(new Set([target.toLowerCase()]), PART_MAX.media)?.get(target.toLowerCase());
        const ctype = ctOf(target);
        if (!img || !ctype || !/^image\//.test(ctype)) return null;
        if (ext === "svg" && svgFetchesOutside(img)) return null;
        mediaNo += 1;
        const renamed = `media/kwl-tpl-${mediaNo}.${ext}`;
        media.set(renamed, { data: img, type: ctype });
        relsXml = relsXml.split(r.tag).join(r.tag.replace(`Target="${r.target}"`, `Target="${renamed}"`));
      }
    }
    hfTexts[kind].push(visibleText(xml.toString("utf8")));
    return { xml, rels: relsXml ? Buffer.from(relsXml, "utf8") : null };
  };
  const titlePg = /<w:titlePg\b(?![^>]*w:val="(?:0|false)")[^>]*\/?>/.test(sect);
  return {
    styles,
    ids,
    normalId,
    header: part("header", "default"),
    footer: part("footer", "default"),
    firstHeader: titlePg ? part("header", "first") : null,
    firstFooter: titlePg ? part("footer", "first") : null,
    titlePg,
    pgSz: /<w:pgSz\b[^>]*\/>/.exec(sect)?.[0] ?? null,
    pgMar: /<w:pgMar\b[^>]*\/>/.exec(sect)?.[0] ?? null,
    media,
    theme: base.get("word/theme/theme1.xml") ?? null,
    numbering: base.get("word/numbering.xml") ?? null,
    headerText: hfTexts.header.filter(Boolean).join("\n"),
    footerText: hfTexts.footer.filter(Boolean).join("\n"),
  };
}

/**
 * 只留模板里用得到的部件，重新打包（复核 R15A-09：不保存模板的正文、批注、作者等——拿真实文书当模板时，那份文书的内容不进账本）。
 * 读不出返回 null。
 */
export function templateLite(buf: Buffer): Buffer | null {
  const t = readTemplate(buf);
  if (!t) return null;
  const files: ZipEntryOut[] = [];
  const rels: string[] = [];
  const overrides: string[] = [`<Override PartName="/word/document.xml" ContentType="${CT_DOC}"/>`, `<Override PartName="/word/styles.xml" ContentType="${CT_STYLES}"/>`];
  const defaults = new Set<string>();
  files.push({ name: "word/styles.xml", data: Buffer.from(t.styles, "utf8") });
  rels.push(`<Relationship Id="rIdS" Type="${R}/styles" Target="styles.xml"/>`);
  const refs: string[] = [];
  const add = (hf: TemplateHf | null, kind: "header" | "footer", type: "default" | "first", n: number) => {
    if (!hf) return;
    const name = `${kind}${n}.xml`;
    files.push({ name: `word/${name}`, data: hf.xml });
    if (hf.rels) files.push({ name: `word/_rels/${name}.rels`, data: hf.rels });
    overrides.push(`<Override PartName="/word/${name}" ContentType="${kind === "header" ? CT_HEADER : CT_FOOTER}"/>`);
    rels.push(`<Relationship Id="rId${kind}${n}" Type="${R}/${kind}" Target="${name}"/>`);
    refs.push(`<w:${kind}Reference w:type="${type}" r:id="rId${kind}${n}"/>`);
  };
  add(t.header, "header", "default", 1);
  add(t.firstHeader, "header", "first", 2);
  add(t.footer, "footer", "default", 1);
  add(t.firstFooter, "footer", "first", 2);
  for (const [name, m] of t.media) {
    files.push({ name: `word/${name}`, data: m.data });
    defaults.add(`<Default Extension="${name.split(".").pop()!.toLowerCase()}" ContentType="${m.type}"/>`);
  }
  if (t.theme) {
    files.push({ name: "word/theme/theme1.xml", data: t.theme });
    overrides.push(`<Override PartName="/word/theme/theme1.xml" ContentType="${CT_THEME}"/>`);
    rels.push(`<Relationship Id="rIdT" Type="${R}/theme" Target="theme/theme1.xml"/>`);
  }
  if (t.numbering) {
    files.push({ name: "word/numbering.xml", data: t.numbering });
    overrides.push(`<Override PartName="/word/numbering.xml" ContentType="${CT_NUMBERING}"/>`);
    rels.push(`<Relationship Id="rIdN" Type="${R}/numbering" Target="numbering.xml"/>`);
  }
  const sect = `<w:sectPr>${refs.join("")}${t.pgSz ?? ""}${t.pgMar ?? ""}${t.titlePg ? "<w:titlePg/>" : ""}</w:sectPr>`;
  return writeZip([
    { name: "[Content_Types].xml", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${[...defaults].join("")}${overrides.join("")}</Types>`, "utf8") },
    { name: "word/document.xml", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body><w:p/>${sect}</w:body></w:document>`, "utf8") },
    { name: "word/_rels/document.xml.rels", data: Buffer.from(relsXml(rels), "utf8") },
    ...files,
  ]);
}

/** 模板没有的角色：把本产品的样式（基于模板的缺省段落样式，只带缩进、对齐与标题字号）加进模板的 styles.xml。 */
function mergeStyles(t: TemplateParts, style: HouseStyle): string {
  const ours = ourStylesXml(style);
  const add: string[] = [];
  for (const role of Object.keys(IDS) as Role[]) {
    if (t.ids[role]) continue;
    const m = new RegExp(`<w:style\\b[^>]*w:styleId="${IDS[role]}"[^>]*>[\\s\\S]*?</w:style>`).exec(ours);
    // 不用字符串替换写入模板的编号（编号里的 $& 等会被当成替换模式，复核 R15A-13）
    if (m) add.push(m[0].split(`<w:basedOn w:val="Normal"/>`).join(`<w:basedOn w:val="${t.normalId}"/>`));
  }
  const at = t.styles.lastIndexOf("</w:styles>");
  return at < 0 ? t.styles : `${t.styles.slice(0, at)}${add.join("")}${t.styles.slice(at)}`;
}

/** 版式涉及的部件：样式表、页眉页脚（函头 / 页码，或模板的）、模板的图片、主题与编号；以及新的页面设置与样式编号对应。 */
interface StyledParts {
  files: ZipEntryOut[];
  rels: string[];
  overrides: string[];
  defaults: Map<string, string>;
  sect: string;
  idMap: Partial<Record<Role, string>>;
}

function styledParts(style: HouseStyle, template: TemplateParts | null, have: { theme: boolean; numbering: boolean } = { theme: false, numbering: false }): StyledParts {
  const parts: StyledParts = { files: [], rels: [], overrides: [], defaults: new Map(), sect: "", idMap: {} };
  const addPart = (name: string, data: Buffer, type: string, relType: string, rid: string) => {
    parts.files.push({ name: `word/${name}`, data });
    parts.overrides.push(`<Override PartName="/word/${name}" ContentType="${type}"/>`);
    parts.rels.push(`<Relationship Id="${rid}" Type="${R}/${relType}" Target="${name}"/>`);
  };
  addPart("styles.xml", Buffer.from(template ? mergeStyles(template, style) : ourStylesXml(style), "utf8"), CT_STYLES, "styles", "rIdKwlStyles");
  const refs: string[] = [];
  const addHf = (kind: "header" | "footer", type: "default" | "first", hf: TemplateHf | null, fallback: string | null) => {
    const name = `${kind}${type === "first" ? 2 : 1}.xml`;
    const rid = `rIdKwl${kind === "header" ? "Header" : "Footer"}${type === "first" ? "First" : ""}`;
    if (hf) {
      addPart(name, hf.xml, kind === "header" ? CT_HEADER : CT_FOOTER, kind, rid);
      if (hf.rels) parts.files.push({ name: `word/_rels/${name}.rels`, data: hf.rels });
    } else if (fallback) addPart(name, Buffer.from(fallback, "utf8"), kind === "header" ? CT_HEADER : CT_FOOTER, kind, rid);
    else return;
    refs.push(`<w:${kind}Reference w:type="${type}" r:id="${rid}"/>`);
  };
  addHf("header", "default", template?.header ?? null, style.letterhead ? headerXml(style.letterhead) : null);
  if (template?.titlePg) addHf("header", "first", template.firstHeader, null);
  addHf("footer", "default", template?.footer ?? null, style.pageNumbers ? footerXml() : null);
  if (template?.titlePg) addHf("footer", "first", template.firstFooter, null);
  if (template) {
    for (const [name, m] of template.media) {
      parts.files.push({ name: `word/${name}`, data: m.data });
      parts.defaults.set(name.split(".").pop()!.toLowerCase(), m.type);
    }
    // 原文件已有主题、编号的不换（正文的编号引用的是原来的编号定义）
    if (template.theme && !have.theme) addPart("theme/theme1.xml", template.theme, CT_THEME, "theme", "rIdKwlTheme");
    if (template.numbering && !have.numbering) addPart("numbering.xml", template.numbering, CT_NUMBERING, "numbering", "rIdKwlNumbering");
    for (const role of Object.keys(IDS) as Role[]) if (template.ids[role]) parts.idMap[role] = template.ids[role];
  }
  // sectPr 子元素顺序：页眉页脚引用、pgSz、pgMar、cols、titlePg
  const pgSz = template?.pgSz ?? `<w:pgSz w:w="11906" w:h="16838"/>`;
  const pgMar = template?.pgMar ?? `<w:pgMar w:top="${MARGINS.top}" w:right="${MARGINS.right}" w:bottom="${MARGINS.bottom}" w:left="${MARGINS.left}" w:header="${MARGINS.header}" w:footer="${MARGINS.footer}" w:gutter="0"/>`;
  parts.sect = `<w:sectPr>${refs.join("")}${pgSz}${pgMar}<w:cols w:space="425"/>${template?.titlePg ? "<w:titlePg/>" : ""}</w:sectPr>`;
  return parts;
}

function applyIdMap(body: string, idMap: Partial<Record<Role, string>>): string {
  let out = body;
  // split/join 而不是 replaceAll：模板的样式编号里的 $& 等不能被当成替换模式（复核 R15A-13）
  for (const [role, id] of Object.entries(idMap) as [Role, string][]) out = out.split(`<w:pStyle w:val="${IDS[role]}"/>`).join(`<w:pStyle w:val="${id}"/>`);
  return out;
}

const PKG_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
const relsXml = (rels: string[]) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`;

/**
 * 正文 + 版式 → DOCX。bodyXml 里的样式写本产品编号；有模板时换成模板里同名样式的编号。
 */
export function buildStyledDocx(bodyXml: string, style: HouseStyle, template: TemplateParts | null = null, o: { mark?: boolean } = {}): Buffer {
  const parts = styledParts(style, template);
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${applyIdMap(bodyXml, parts.idMap)}${parts.sect}</w:body></w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${[...parts.defaults].map(([e, t]) => `<Default Extension="${e}" ContentType="${t}"/>`).join("")}<Override PartName="/word/document.xml" ContentType="${CT_DOC}"/><Override PartName="/docProps/core.xml" ContentType="${CT_CORE}"/>${parts.overrides.join("")}</Types>`;
  return writeZip([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(PKG_RELS, "utf8") },
    { name: "docProps/core.xml", data: Buffer.from(coreXml(o.mark !== false), "utf8") },
    { name: "word/document.xml", data: Buffer.from(documentXml, "utf8") },
    { name: "word/_rels/document.xml.rels", data: Buffer.from(relsXml(parts.rels), "utf8") },
    ...parts.files,
  ]);
}

/** 正文块 → 套好版式的 DOCX。mark=false 时不带本产品标记（例如示例合同、清洁稿：导出时不套函头）。 */
export function createStyledDocx(blocks: DocBlock[], style: HouseStyle = DEFAULT_HOUSE_STYLE, template: TemplateParts | null = null, o: { mark?: boolean } = {}): Buffer {
  return buildStyledDocx(blocksToBodyXml(blocks), style, template, o);
}

/**
 * 由已有文件派生的文件（修订稿、清洁稿、净化属性、脱敏件）去掉本产品标记（复核 R15A-07）：只有本产品原样生成的意见书、报告才在下载时套函头，
 * 对方改过发回的稿子、对外的脱敏件都不套。
 */
export function dropHouseMark(files: Map<string, Buffer>): void {
  const core = files.get("docProps/core.xml");
  if (!core) return;
  const xml = core.toString("utf8");
  const next = xml.split(`<cp:category>${HOUSE_STYLE_MARK}</cp:category>`).join("");
  if (next !== xml) files.set("docProps/core.xml", Buffer.from(next, "utf8"));
}

/** 是不是本产品生成、可以重新套版式的文件（看 core.xml 的标记）。 */
export function isHouseStyled(docx: Buffer): boolean {
  try {
    const files = readZipSelected(docx, (n) => n === "docProps/core.xml");
    return (files.get("docProps/core.xml")?.toString("utf8") ?? "").includes(`<cp:category>${HOUSE_STYLE_MARK}</cp:category>`);
  } catch {
    return false;
  }
}

/**
 * 导出时重新套版式（律所函头、字体、模板）：在原包上**只换**样式表、页眉页脚与最后的页面设置，其余部件（批注、脚注、图片、修订、编号）原样保留——
 * 修订稿的批注与修订痕迹不受影响。不是本产品生成的文件、或正文里有多个分节（各节各有页眉页脚引用）的，原样返回。
 */
export function restyleDocx(docx: Buffer, style: HouseStyle, template: TemplateParts | null = null): Buffer {
  if (!isHouseStyled(docx)) return docx;
  const files = readZipEntries(docx);
  const docXml = files.get("word/document.xml")?.toString("utf8");
  const ctRaw = files.get("[Content_Types].xml")?.toString("utf8");
  if (!docXml || !ctRaw) return docx;
  if ((docXml.match(/<w:sectPr\b/g) ?? []).length > 1) return docx;
  const relsName = "word/_rels/document.xml.rels";
  let rels = files.get(relsName)?.toString("utf8") ?? relsXml([]);
  let ct = ctRaw;
  // 去掉原来的样式表与页眉页脚（及其关系文件、内容类型）
  for (const m of [...rels.matchAll(/<Relationship\b[^>]*>/g)]) {
    const type = attrOf(m[0], "Type") ?? "";
    if (!/\/(styles|header|footer)$/.test(type)) continue;
    const target = attrOf(m[0], "Target") ?? "";
    const full = posix.normalize(`word/${target}`);
    files.delete(full);
    files.delete(`word/_rels/${full.slice("word/".length)}.rels`);
    ct = ct.replace(new RegExp(`<Override\\b[^>]*PartName="/${full.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*/>`, "i"), "");
    rels = rels.replace(m[0], "");
  }
  const has = (t: string) => new RegExp(`Type="[^"]*/${t}"`).test(rels);
  const parts = styledParts(style, template, { theme: has("theme"), numbering: has("numbering") });
  for (const f of parts.files) files.set(f.name, f.data);
  const relEnd = rels.lastIndexOf("</Relationships>");
  rels = `${rels.slice(0, relEnd)}${parts.rels.join("")}${rels.slice(relEnd)}`;
  // Default 按扩展名不区分大小写判重（复核 R15A-13）
  const haveExt = new Set([...ct.matchAll(/<Default\b[^>]*>/g)].map((m) => (attrOf(m[0], "Extension") ?? "").toLowerCase()));
  const newDefaults = [...parts.defaults].filter(([e]) => !haveExt.has(e)).map(([e, t]) => `<Default Extension="${e}" ContentType="${t}"/>`);
  const ctEnd = ct.lastIndexOf("</Types>");
  ct = `${ct.slice(0, ctEnd)}${newDefaults.join("")}${parts.overrides.join("")}${ct.slice(ctEnd)}`;
  let body = applyIdMap(docXml, parts.idMap).replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>|<w:sectPr\/>/, () => parts.sect);
  if (!/<w:document\b[^>]*xmlns:r=/.test(body)) body = body.replace(/<w:document\b/, `<w:document xmlns:r="${R}"`);
  files.set("word/document.xml", Buffer.from(body, "utf8"));
  files.set(relsName, Buffer.from(rels, "utf8"));
  files.set("[Content_Types].xml", Buffer.from(ct, "utf8"));
  return writeZip([...files].map(([name, data]) => ({ name, data })));
}

// ─── Markdown → 正文块（Agent 写的备忘录、意见书导出成 Word）───

/** Markdown 转义（\* \_ \| \# 等）先换成私用区字符，最后再换回原字符（复核 R15B-20：“100000\*0.05” 不能变成乱码）。 */
const ESC_RE = /\\([\\`*_{}[\]()#+\-.!|>~])/g;
const escIn = (s: string) => s.replace(ESC_RE, (_m, c: string) => String.fromCharCode(0xe000 + c.charCodeAt(0)));
const escOut = (s: string) => s.replace(/[-]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xe000));

/** 行内：**加粗**；`代码`、*斜体*、_斜体_ 去掉记号；[文字](链接) 写成“文字（链接）”。 */
export function inlineRuns(text: string): Run[] {
  const s = escIn(text)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t: string, u: string) => (u.startsWith("#") ? t : `${t}（${u}）`))
    .replace(/`([^`]+)`/g, "$1");
  const runs: Run[] = [];
  const re = /\*\*([^*]+)\*\*|__([^_]+)__/g;
  let last = 0;
  for (const m of s.matchAll(re)) {
    if (m.index! > last) runs.push({ text: s.slice(last, m.index) });
    runs.push({ text: m[1] ?? m[2]!, bold: true });
    last = m.index! + m[0].length;
  }
  if (last < s.length) runs.push({ text: s.slice(last) });
  return runs
    .map((r) => ({ ...r, text: escOut(r.text.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1$2").replace(/(^|\s)_([^_]+)_(?=\s|$)/g, "$1$2")) }))
    .filter((r) => r.text !== "");
}

/**
 * 落款行（复核 R15B-21）：整行是律所名称（可带“（盖章）”）、“（承办）律师：”、各类诉讼主体的署名（答辩人、申请人、上诉人……）、
 * 单独的“（盖章）”或日期。文末几行里出现时右对齐；正文里提到律所的句子不算。
 */
const SIGNATURE_LINE =
  /^(?:[^，。；,;：:]{2,30}律师事务所(?:（盖章）|\(盖章\))?|(?:承办|经办)?律师[:：].{0,20}|(?:具状人|答辩人|申请人|被申请人|上诉人|被上诉人|起诉人|委托人|声明人|承诺人|原告|被告)[:：]?.{0,30}|(?:法定代表人|负责人|授权代表|(?:委托)?(?:诉讼)?代理人)(?:或(?:授权代表|负责人))?[:：].{0,30}|[（(]盖章[)）]|(?:\d{4}|[〇零一二三四五六七八九]{4})\s*年\s*\S{1,3}\s*月\s*\S{1,3}\s*日|[_＿\s]*年[_＿\s]*月[_＿\s]*日)$/;

/** 把文末连续的落款行改成右对齐（Markdown 转换与 createDocx 共用）。 */
export function alignSignature(blocks: DocBlock[]): DocBlock[] {
  const out = blocks.slice();
  // 文末是附页表（证据目录、计算表）时，落款在附页之前：跳过末尾的表格与它的小标题再找（第 32 批，复核 A-06）
  let end = out.length - 1;
  if (out[end]?.kind === "table") {
    while (end >= 0 && (out[end]!.kind === "table" || out[end]!.kind === "blank")) end -= 1;
    if (end >= 0 && /^h[123]$/.test(out[end]!.kind)) end -= 1;
  }
  for (let k = end, n = 0; k >= 0 && n < 6; k -= 1, n += 1) {
    const b = out[k]!;
    if (b.kind !== "p") break;
    const text = b.runs.map((r) => r.text).join("").trim();
    if (text.length > 40 || !SIGNATURE_LINE.test(text)) break;
    out[k] = { kind: "right", text };
  }
  // “此致”与下一行（受文机关）放在同一页（第 33 批，Word 实开：“此致”独自落在页末）
  for (let k = 0; k < out.length - 1; k += 1) {
    const b = out[k]!;
    if (b.kind === "p" && /^此\s*致[，,：:]?$/.test(b.runs.map((r) => r.text).join("").trim())) out[k] = { ...b, keepNext: true };
  }
  return out;
}

export function markdownToBlocks(md: string): DocBlock[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: DocBlock[] = [];
  const headingLevels = lines.map((l) => /^(#{1,6})\s+\S/.exec(l)?.[1]!.length ?? 0);
  const firstContent = lines.findIndex((l) => l.trim() !== "");
  // 只有一个一级标题、而且在最前面时才当文书标题（复核 R15B-20：每节都写成“# 一、……”时不把第一节当标题）
  const hasTitle = firstContent >= 0 && headingLevels[firstContent] === 1 && headingLevels.filter((n) => n === 1).length === 1;
  const rest = headingLevels.filter((n, i) => n > 0 && !(hasTitle && i === firstContent));
  const base = rest.length > 0 ? Math.min(...rest) : 1;
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    const line = raw.trimEnd();
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      blocks.push({ kind: "p", runs: [{ text: line }] });
      continue;
    }
    if (line.trim() === "") continue;
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ kind: "blank" });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const text = inlineRuns(h[2]!.replace(/\s+#+\s*$/, "")).map((r) => r.text).join("");
      if (hasTitle && i === firstContent) blocks.push({ kind: "title", text });
      else blocks.push({ kind: (["h1", "h2", "h3"] as const)[Math.min(2, Math.max(0, h[1]!.length - base))]!, text });
      continue;
    }
    if (/^\s*\|/.test(line)) {
      const rows: Run[][][] = [];
      let j = i;
      for (; j < lines.length && /^\s*\|/.test(lines[j]!); j += 1) {
        const cells = escIn(lines[j]!.trim()).replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => escOut(c).trim());
        if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
        rows.push(cells.map((c) => inlineRuns(c)));
      }
      if (rows.length > 0) blocks.push({ kind: "table", rows });
      i = j - 1;
      continue;
    }
    const indent = (/^(\s*)/.exec(raw)?.[1] ?? "").replace(/\t/g, "  ").length;
    const level = Math.floor(indent / 2);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      blocks.push({ kind: "li", marker: "•", runs: inlineRuns(bullet[1]!), level });
      continue;
    }
    const ordered = /^\s*(\d{1,3})[.)、]\s+(.*)$/.exec(line);
    if (ordered) {
      blocks.push({ kind: "li", marker: `${ordered[1]}.`, runs: inlineRuns(ordered[2]!), level });
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    blocks.push({ kind: "p", runs: inlineRuns(quote ? quote[1]! : line.trim()) });
  }
  return alignSignature(blocks);
}
