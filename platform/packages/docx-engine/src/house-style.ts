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
import { readZipEntries, writeZip, type ZipEntryOut } from "./zip.ts";
import { escapeXml } from "./textmap.ts";

export interface Run {
  text: string;
  bold?: boolean;
}

export type DocBlock =
  | { kind: "title"; text: string }
  | { kind: "h1" | "h2" | "h3"; text: string }
  | { kind: "p"; runs: Run[] }
  | { kind: "li"; runs: Run[]; marker: string }
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
${st(IDS.title, "Title", `<w:jc w:val="center"/><w:spacing w:before="240" w:after="360"/><w:outlineLvl w:val="0"/>`, `${rFonts("宋体")}<w:b/><w:sz w:val="${f.title}"/><w:szCs w:val="${f.title}"/>`)}
${st(IDS.h1, "heading 1", `<w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/>`, `${rFonts("黑体")}<w:sz w:val="${f.h1}"/><w:szCs w:val="${f.h1}"/>`)}
${st(IDS.h2, "heading 2", `<w:keepNext/><w:spacing w:before="120" w:after="60"/><w:ind w:firstLineChars="200" w:firstLine="${f.size * 20}"/><w:outlineLvl w:val="1"/>`, `${rFonts("楷体")}<w:b/><w:sz w:val="${f.h2}"/><w:szCs w:val="${f.h2}"/>`)}
${st(IDS.h3, "heading 3", `<w:keepNext/><w:ind w:firstLineChars="200" w:firstLine="${f.size * 20}"/><w:outlineLvl w:val="2"/>`, `<w:b/><w:sz w:val="${f.h3}"/><w:szCs w:val="${f.h3}"/>`)}
${st(IDS.body, "Kwl Body", `<w:ind w:firstLineChars="200" w:firstLine="${f.size * 20}"/>`, "")}
${st(IDS.list, "List Paragraph", `<w:ind w:left="${f.size * 20}" w:hanging="${f.size * 10}"/>`, "")}
${st(IDS.table, "Kwl Table Text", `<w:jc w:val="left"/><w:spacing w:line="240" w:lineRule="auto"/>`, `<w:sz w:val="${Math.min(f.size, 24)}"/><w:szCs w:val="${Math.min(f.size, 24)}"/>`)}
${st(IDS.right, "Kwl Signature", `<w:jc w:val="right"/>`, "")}
</w:styles>`;
}

function runXml(r: Run): string {
  return `<w:r>${r.bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${escapeXml(r.text)}</w:t></w:r>`;
}

function para(styleId: string, runs: Run[]): string {
  return `<w:p><w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>${runs.map(runXml).join("")}</w:p>`;
}

/** 正文块 → document.xml 的 body 内容（样式写本产品编号）。 */
export function blocksToBodyXml(blocks: DocBlock[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === "title") out.push(para(IDS.title, [{ text: b.text }]));
    else if (b.kind === "h1" || b.kind === "h2" || b.kind === "h3") out.push(para(IDS[b.kind], [{ text: b.text }]));
    else if (b.kind === "p") out.push(para(IDS.body, b.runs));
    else if (b.kind === "li") out.push(para(IDS.list, [{ text: `${b.marker}\t` }, ...b.runs]));
    else if (b.kind === "right") out.push(para(IDS.right, [{ text: b.text }]));
    else if (b.kind === "blank") out.push(`<w:p/>`);
    else if (b.kind === "table") {
      const cols = Math.max(1, ...b.rows.map((r) => r.length));
      const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`;
      const grid = Array.from({ length: cols }, () => `<w:gridCol w:w="${Math.floor(8845 / cols)}"/>`).join("");
      const rows = b.rows
        .map((r, i) => {
          const cells = Array.from({ length: cols }, (_, c) => r[c] ?? []);
          return `<w:tr>${cells.map((runs) => `<w:tc><w:tcPr><w:tcW w:w="${Math.floor(8845 / cols)}" w:type="dxa"/></w:tcPr>${para(IDS.table, i === 0 ? runs.map((x) => ({ ...x, bold: true })) : runs)}</w:tc>`).join("")}</w:tr>`;
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
    `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:line="240" w:lineRule="auto"/>${last ? border : ""}</w:pPr><w:r><w:rPr>${rFonts(bold ? "黑体" : "宋体")}${bold ? "<w:b/>" : ""}<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="${W}" xmlns:r="${R}">${p(lh.name, 32, true, lines.length === 0)}${lines.map((l, i) => p(l, 18, false, i === lines.length - 1)).join("")}</w:hdr>`;
}

function footerXml(): string {
  const run = (t: string) => `<w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${t}</w:t></w:r>`;
  const field = (instr: string) => `<w:fldSimple w:instr=" ${instr} "><w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t>1</w:t></w:r></w:fldSimple>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="${W}" xmlns:r="${R}"><w:p><w:pPr><w:jc w:val="center"/></w:pPr>${run("第 ")}${field("PAGE")}${run(" 页 共 ")}${field("NUMPAGES")}${run(" 页")}</w:p></w:ftr>`;
}

function coreXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:creator>Kimi Work 法律行业发行版（AI 辅助起草，经律师复核）</dc:creator>
<cp:lastModifiedBy></cp:lastModifiedBy>
<cp:category>${HOUSE_STYLE_MARK}</cp:category>
</cp:coreProperties>`;
}

// ─── 律所模板（.dotx / .docx）───

interface TemplateParts {
  styles: string;
  /** 角色 → 模板里的样式编号（模板没有的角色不在表里，用本产品注入的样式）。 */
  ids: Partial<Record<Role, string>>;
  normalId: string;
  header: { xml: Buffer; rels: Buffer | null } | null;
  footer: { xml: Buffer; rels: Buffer | null } | null;
  /** 页眉页脚引用的图片与其他部件（路径相对 word/）。 */
  media: Map<string, Buffer>;
  theme: Buffer | null;
  numbering: Buffer | null;
}

export const TEMPLATE_MAX_BYTES = 5 * 1024 * 1024;

const attrOf = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

/** 读律所模板：只取样式、缺省页眉页脚（含其关系与图片）、主题与编号；读不出返回 null（导出照常用本产品版式）。 */
export function readTemplate(buf: Buffer): TemplateParts | null {
  if (buf.length > TEMPLATE_MAX_BYTES) return null;
  let files: Map<string, Buffer>;
  try {
    files = readZipEntries(buf);
  } catch {
    return null;
  }
  const get = (n: string) => files.get(n) ?? [...files].find(([k]) => k.toLowerCase() === n.toLowerCase())?.[1] ?? null;
  const stylesBuf = get("word/styles.xml");
  if (!stylesBuf) return null;
  const styles = stylesBuf.toString("utf8");
  const ids: Partial<Record<Role, string>> = {};
  let normalId = "Normal";
  for (const m of styles.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    if (attrOf(m[1]!, "w:type") !== "paragraph") continue;
    const id = attrOf(m[1]!, "w:styleId");
    const name = /<w:name\s+w:val="([^"]*)"/.exec(m[2]!)?.[1]?.toLowerCase();
    if (!id || !name) continue;
    if (attrOf(m[1]!, "w:default") === "1") normalId = id;
    for (const [role, want] of Object.entries(TEMPLATE_NAMES) as [Role, string][]) if (name === want && !ids[role]) ids[role] = id;
  }
  const doc = get("word/document.xml")?.toString("utf8") ?? "";
  const rels = get("word/_rels/document.xml.rels")?.toString("utf8") ?? "";
  const target = (rid: string | null) => (rid ? attrOf(new RegExp(`<Relationship\\b[^>]*\\bId="${rid}"[^>]*>`).exec(rels)?.[0] ?? "", "Target") : null);
  const media = new Map<string, Buffer>();
  const part = (kind: "header" | "footer") => {
    const ref = new RegExp(`<w:${kind}Reference\\b[^>]*w:type="default"[^>]*>`).exec(doc)?.[0] ?? new RegExp(`<w:${kind}Reference\\b[^>]*>`).exec(doc)?.[0];
    const t = target(ref ? attrOf(ref, "r:id") : null);
    if (!t || /[:\\]|^\//.test(t) || t.includes("..")) return null;
    const xml = get(`word/${t}`);
    if (!xml) return null;
    const relsBuf = get(`word/_rels/${t}.rels`);
    for (const m of (relsBuf?.toString("utf8") ?? "").matchAll(/<Relationship\b[^>]*>/g)) {
      const tt = attrOf(m[0], "Target");
      // 只拷包内的部件（徽标图片等）；外部目标由 writeZip 去除（超链接保留）
      if (!tt || /TargetMode="External"/i.test(m[0]) || /[:\\]|^\//.test(tt)) continue;
      const full = posix.normalize(`word/${tt}`);
      if (full.startsWith("../") || !full.startsWith("word/")) continue;
      const data = get(full);
      if (data) media.set(full.slice("word/".length), data);
    }
    return { xml, rels: relsBuf };
  };
  return { styles, ids, normalId, header: part("header"), footer: part("footer"), media, theme: get("word/theme/theme1.xml"), numbering: get("word/numbering.xml") };
}

/** 模板没有的角色：把本产品的样式（基于模板的缺省段落样式，只带缩进、对齐与标题字号）加进模板的 styles.xml。 */
function mergeStyles(t: TemplateParts, style: HouseStyle): string {
  const ours = ourStylesXml(style);
  const add: string[] = [];
  for (const role of Object.keys(IDS) as Role[]) {
    if (t.ids[role]) continue;
    const m = new RegExp(`<w:style\\b[^>]*w:styleId="${IDS[role]}"[^>]*>[\\s\\S]*?</w:style>`).exec(ours);
    if (m) add.push(m[0].replace(/<w:basedOn w:val="Normal"\/>/, `<w:basedOn w:val="${t.normalId}"/>`));
  }
  return t.styles.replace(/<\/w:styles>\s*$/, `${add.join("")}</w:styles>`);
}

/**
 * 正文 + 版式 → DOCX。bodyXml 里的样式写本产品编号；有模板时换成模板里同名样式的编号。
 */
export function buildStyledDocx(bodyXml: string, style: HouseStyle, template: TemplateParts | null = null): Buffer {
  const files: ZipEntryOut[] = [];
  const ct: string[] = [];
  const defaults = new Set<string>();
  const rels: string[] = [];
  let body = bodyXml;
  let stylesXml = ourStylesXml(style);
  if (template) {
    stylesXml = mergeStyles(template, style);
    for (const role of Object.keys(IDS) as Role[]) {
      const id = template.ids[role];
      if (id) body = body.replaceAll(`<w:pStyle w:val="${IDS[role]}"/>`, `<w:pStyle w:val="${id}"/>`);
    }
  }
  files.push({ name: "word/styles.xml", data: Buffer.from(stylesXml, "utf8") });
  ct.push(`<Override PartName="/word/styles.xml" ContentType="${CT_STYLES}"/>`);
  rels.push(`<Relationship Id="rIdStyles" Type="${R}/styles" Target="styles.xml"/>`);
  let headerRef = "";
  let footerRef = "";
  const addPart = (name: string, data: Buffer, type: string, relType: string, rid: string) => {
    files.push({ name: `word/${name}`, data });
    ct.push(`<Override PartName="/word/${name}" ContentType="${type}"/>`);
    rels.push(`<Relationship Id="${rid}" Type="${R}/${relType}" Target="${name}"/>`);
  };
  if (template?.header) {
    addPart("header1.xml", template.header.xml, CT_HEADER, "header", "rIdHeader");
    if (template.header.rels) files.push({ name: "word/_rels/header1.xml.rels", data: template.header.rels });
    headerRef = `<w:headerReference w:type="default" r:id="rIdHeader"/>`;
  } else if (style.letterhead) {
    addPart("header1.xml", Buffer.from(headerXml(style.letterhead), "utf8"), CT_HEADER, "header", "rIdHeader");
    headerRef = `<w:headerReference w:type="default" r:id="rIdHeader"/>`;
  }
  if (template?.footer) {
    addPart("footer1.xml", template.footer.xml, CT_FOOTER, "footer", "rIdFooter");
    if (template.footer.rels) files.push({ name: "word/_rels/footer1.xml.rels", data: template.footer.rels });
    footerRef = `<w:footerReference w:type="default" r:id="rIdFooter"/>`;
  } else if (style.pageNumbers) {
    addPart("footer1.xml", Buffer.from(footerXml(), "utf8"), CT_FOOTER, "footer", "rIdFooter");
    footerRef = `<w:footerReference w:type="default" r:id="rIdFooter"/>`;
  }
  if (template) {
    for (const [name, data] of template.media) {
      if (files.some((f) => f.name === `word/${name}`)) continue;
      files.push({ name: `word/${name}`, data });
      const ext = name.split(".").pop()!.toLowerCase();
      if (IMAGE_TYPES[ext]) defaults.add(`<Default Extension="${ext}" ContentType="${IMAGE_TYPES[ext]}"/>`);
    }
    if (template.theme) addPart("theme/theme1.xml", template.theme, CT_THEME, "theme", "rIdTheme");
    if (template.numbering) addPart("numbering.xml", template.numbering, CT_NUMBERING, "numbering", "rIdNumbering");
  }
  const sect = `<w:sectPr>${headerRef}${footerRef}<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="${MARGINS.top}" w:right="${MARGINS.right}" w:bottom="${MARGINS.bottom}" w:left="${MARGINS.left}" w:header="${MARGINS.header}" w:footer="${MARGINS.footer}" w:gutter="0"/><w:cols w:space="425"/></w:sectPr>`;
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}${sect}</w:body></w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${[...defaults].join("")}<Override PartName="/word/document.xml" ContentType="${CT_DOC}"/><Override PartName="/docProps/core.xml" ContentType="${CT_CORE}"/>${ct.join("")}</Types>`;
  const pkgRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`;
  return writeZip([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(pkgRels, "utf8") },
    { name: "docProps/core.xml", data: Buffer.from(coreXml(), "utf8") },
    { name: "word/document.xml", data: Buffer.from(documentXml, "utf8") },
    { name: "word/_rels/document.xml.rels", data: Buffer.from(docRels, "utf8") },
    ...files,
  ]);
}

/** 正文块 → 套好版式的 DOCX。 */
export function createStyledDocx(blocks: DocBlock[], style: HouseStyle = DEFAULT_HOUSE_STYLE, template: TemplateParts | null = null): Buffer {
  return buildStyledDocx(blocksToBodyXml(blocks), style, template);
}

/** 是不是本产品生成、可以重新套版式的文件（看 core.xml 的标记）。 */
export function isHouseStyled(docx: Buffer): boolean {
  try {
    const files = readZipEntries(docx);
    return (files.get("docProps/core.xml")?.toString("utf8") ?? "").includes(`<cp:category>${HOUSE_STYLE_MARK}</cp:category>`);
  } catch {
    return false;
  }
}

/** 导出时重新套版式（律所函头、字体、模板）：只换样式、页眉页脚与页面，正文段落原样保留；不是本产品生成的文件原样返回。 */
export function restyleDocx(docx: Buffer, style: HouseStyle, template: TemplateParts | null = null): Buffer {
  if (!isHouseStyled(docx)) return docx;
  const xml = readZipEntries(docx).get("word/document.xml")?.toString("utf8") ?? "";
  const m = /<w:body>([\s\S]*?)(?:<w:sectPr\b[\s\S]*?<\/w:sectPr>|<w:sectPr\/>)?\s*<\/w:body>/.exec(xml);
  if (!m) return docx;
  return buildStyledDocx(m[1]!, style, template);
}

// ─── Markdown → 正文块（Agent 写的备忘录、意见书导出成 Word）───

/** 行内：**加粗**；`代码`、*斜体*、_斜体_ 去掉记号；[文字](链接) 写成“文字（链接）”。 */
export function inlineRuns(text: string): Run[] {
  const s = text
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
  return runs.map((r) => ({ ...r, text: r.text.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1$2").replace(/(^|\s)_([^_]+)_(?=\s|$)/g, "$1$2") })).filter((r) => r.text !== "");
}

/** 落款行：律所名称、“律师：”“承办律师”、日期（文末几行里出现时右对齐）。 */
const SIGNATURE_LINE = /(律师事务所|^(承办|经办)?律师[:：]|^具状人[:：]?|^(\d{4}|[〇零一二三四五六七八九]{4})\s*年\s*\S{1,3}\s*月\s*\S{1,3}\s*日$)/;

export function markdownToBlocks(md: string): DocBlock[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: DocBlock[] = [];
  const headingLevels = lines.map((l) => /^(#{1,6})\s+\S/.exec(l)?.[1]!.length ?? 0);
  const firstContent = lines.findIndex((l) => l.trim() !== "");
  const hasTitle = firstContent >= 0 && headingLevels[firstContent] === 1;
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
        const cells = lines[j]!.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
        if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
        rows.push(cells.map((c) => inlineRuns(c)));
      }
      blocks.push({ kind: "table", rows });
      i = j - 1;
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      blocks.push({ kind: "li", marker: "•", runs: inlineRuns(bullet[1]!) });
      continue;
    }
    const ordered = /^\s*(\d{1,3})[.)、]\s+(.*)$/.exec(line);
    if (ordered) {
      blocks.push({ kind: "li", marker: `${ordered[1]}.`, runs: inlineRuns(ordered[2]!) });
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    blocks.push({ kind: "p", runs: inlineRuns(quote ? quote[1]! : line.trim()) });
  }
  // 文末的落款（律所、律师、日期）右对齐：从最后一块往前看至多 4 块，遇到不是落款的就停
  for (let k = blocks.length - 1, n = 0; k >= 0 && n < 4; k -= 1, n += 1) {
    const b = blocks[k]!;
    if (b.kind !== "p") break;
    const text = b.runs.map((r) => r.text).join("").trim();
    if (!SIGNATURE_LINE.test(text) || text.length > 40) break;
    blocks[k] = { kind: "right", text };
  }
  return blocks;
}
