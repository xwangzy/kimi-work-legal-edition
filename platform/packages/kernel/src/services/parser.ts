/**
 * v0 解析器（占位）：纯文本直接读取；DOCX 粗提取 word/document.xml 文本层。
 * 生产文档服务（§4.1/§5.4）：解析、OCR、锚点、质量标记由独立隔离 worker 承担，
 * 中文合同保真度以 G0 同台评测为准。v0 解析结果一律打 quality_flags，如实降级。
 */
import { DomainError } from "@zr-legal/domain";
import { documentXmlWithListLabels, mapParagraphs, paragraphListLabels, xlsxToText } from "@zr-legal/docx-engine";
import { listEntries, readEntry, readEntryText } from "./zip.ts";

export interface ParseOutcome {
  text: string;
  pageCount: number | null;
  qualityFlags: string[];
  parser: string;
  parserVersion: string;
}

// v0.1.1：DOCX 取可见文字（修订删除、移动原位置不计入；复核 B3-B14、C-B04）——新旧解析版本可按此区分
// v0.1.2（v9.3 第 15 批 B-11）：DOCX 表格按行输出“| 单元格 | 单元格 |”，不再每个单元格各占一行
// v0.1.3（v9.4 第 29 批）：DOCX 自动编号（“第一条”“1.1”“（一）”）写进段首——原先只取可见文字，自动编号的合同整份没有条款号
const PARSER_VERSION = "v0.1.3-crude";

/**
 * 旧版 Office 与 WPS 格式（B-11；评审 Z1“.doc/.wps 不支持”）：本机不带格式转换程序，按扩展名或文件头（OLE 复合文档 D0CF11E0、RTF）认出来，
 * 请律师在 Word / WPS / Excel 里另存为新格式后再导入——说清楚怎么做，而不是只报“不支持的文件类型”。
 */
const LEGACY_FORMATS: { ext: RegExp; kind: string; to: string }[] = [
  { ext: /\.(doc|dot|wps|wpt)$/, kind: "旧版 Word 或 WPS 文字", to: "Word 文档（.docx）" },
  { ext: /\.(xls|xlt|et|ett)$/, kind: "旧版 Excel 或 WPS 表格", to: "Excel 工作簿（.xlsx）" },
  { ext: /\.(ppt|dps)$/, kind: "演示文稿", to: "PDF" },
  { ext: /\.rtf$/, kind: "RTF 文档", to: "Word 文档（.docx）" },
];

const isOle = (buf: Buffer) => buf.length >= 8 && buf.readUInt32BE(0) === 0xd0cf11e0 && buf.readUInt32BE(4) === 0xa1b11ae1;
/** 复合文档目录项名是 UTF-16LE：设了打开密码的 .docx / .xlsx（及权限保护的文件）外层也是复合文档，里面是这两项（复核 R15A-17、R15B-18）。 */
const OLE_ENCRYPTED = [Buffer.from("EncryptedPackage", "utf16le"), Buffer.from("EncryptionInfo", "utf16le")];
/** Outlook 邮件（.msg）的属性流名都以“__substg1.0_”开头。 */
const OLE_MSG = Buffer.from("__substg1.0_", "utf16le");

type Unreadable = { kind: string; to: string } | { message: string; detail: Record<string, unknown> };

function legacyFormat(lower: string, buf: Buffer): Unreadable | null {
  const ole = isOle(buf);
  // 先认出“设了打开密码”和“邮件”：按旧版格式提示另存，律师照做后仍然导不进
  if (ole && OLE_ENCRYPTED.some((m) => buf.includes(m))) {
    return { message: "这份文件设了打开密码（或权限保护），本机读不了：请在 Word、WPS 或 Excel 里去掉打开密码后另存一份，再导入", detail: { password_protected: true } };
  }
  if (/\.msg$/.test(lower) || (ole && buf.includes(OLE_MSG))) {
    return { message: "这是 Outlook 邮件（.msg），本机读不了：请在 Outlook 里打开它，另存为 PDF（附件请单独保存）后再导入", detail: { email_message: true } };
  }
  const byExt = LEGACY_FORMATS.find((f) => f.ext.test(lower));
  if (byExt) return byExt;
  // 改了扩展名的旧格式文件（例如 .doc 改名成 .docx）：看文件头
  if (ole) return lower.endsWith(".xlsx") ? LEGACY_FORMATS[1]! : LEGACY_FORMATS[0]!;
  if (buf.subarray(0, 5).toString("latin1") === "{\\rtf") return LEGACY_FORMATS[3]!;
  return null;
}

/**
 * 纯文本解码（复核 B3-A07）：UTF-8（含 BOM）优先；UTF-16 按 BOM；不是合法 UTF-8 时按 GB18030 解（本地政府与企业导出的 TXT 常见）——
 * 否则乱码既让律师读不了，也让密级检测整份漏检。
 */
export function decodePlainText(buf: Buffer): { text: string; encoding: "utf-8" | "utf-16le" | "utf-16be" | "gb18030" } {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { text: new TextDecoder("utf-16le").decode(buf.subarray(2)), encoding: "utf-16le" };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return { text: new TextDecoder("utf-16be").decode(buf.subarray(2)), encoding: "utf-16be" };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(buf), encoding: "utf-8" };
  } catch {
    try {
      return { text: new TextDecoder("gb18030").decode(buf), encoding: "gb18030" };
    } catch {
      return { text: buf.toString("utf8"), encoding: "utf-8" };
    }
  }
}

export function parseDocument(filename: string, mime: string, buf: Buffer): ParseOutcome {
  const lower = filename.toLowerCase();
  const legacy = legacyFormat(lower, buf);
  if (legacy && "message" in legacy) throw new DomainError("unsupported_file", legacy.message, 422, legacy.detail);
  if (legacy) {
    throw new DomainError("unsupported_file", `这是${legacy.kind}格式，本机读不了：请用 Word、WPS 或 Excel 打开它，“另存为”${legacy.to}后再导入`, 422, { legacy_format: true });
  }
  if (mime.startsWith("text/") || lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".csv")) {
    const decoded = decodePlainText(buf);
    return {
      text: decoded.text,
      pageCount: null,
      qualityFlags: decoded.encoding === "utf-8" ? ["plain_text"] : ["plain_text", `encoding_${decoded.encoding}`],
      parser: "plain",
      parserVersion: PARSER_VERSION,
    };
  }
  if (
    lower.endsWith(".docx") ||
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    const xml = readEntryText(buf, "word/document.xml");
    if (xml === null) throw new DomainError("unsupported_file", "DOCX 缺少 word/document.xml", 422);
    const labels = docxParagraphLabels(xml, buf);
    const text = docxXmlToText(labels.some(Boolean) ? documentXmlWithListLabels(xml, labels) : xml);
    return {
      text,
      pageCount: null,
      qualityFlags: [
        "v0_crude_docx_parser",
        "no_page_anchors",
        ...(/<w:tbl\b/.test(xml) ? ["tables_as_rows"] : []),
        ...(labels.some(Boolean) ? ["list_numbers_rendered"] : []),
        "comments_revisions_ignored",
      ],
      parser: "docx-crude",
      parserVersion: PARSER_VERSION,
    };
  }
  // XLSX（第 13 批）：只取单元格的值，逐表逐行转成文字（不执行公式、不读外部链接）
  if (lower.endsWith(".xlsx") || mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
    let r: { text: string; sheets: number; truncated: boolean; dates_raw?: boolean };
    try {
      r = xlsxToText(buf);
    } catch {
      throw new DomainError("unsupported_file", "这份表格打不开（文件可能已损坏或不是 xlsx），请另存为 xlsx 或 csv 后再导入", 422);
    }
    return {
      text: r.text,
      pageCount: null,
      qualityFlags: ["xlsx_values_only", ...(r.truncated ? ["xlsx_truncated"] : []), ...(r.dates_raw ? ["xlsx_dates_raw"] : [])],
      parser: "xlsx-values",
      parserVersion: PARSER_VERSION,
    };
  }
  if (lower.endsWith(".pdf") || mime === "application/pdf") {
    // 生产：PDF 文本层 + OCR（文档服务）；v0 不伪造解析能力
    throw new DomainError("unsupported_file", "PDF 解析待文档服务接入（G0 第 3–4 周）；v0 支持 DOCX/TXT", 422, {
      supported: ["docx", "txt", "md"],
    });
  }
  throw new DomainError("unsupported_file", `不支持的文件类型 ${mime}（支持 DOCX、XLSX、PDF、图片、TXT、MD、CSV）`, 422);
}

/**
 * 段落的自动编号文字（第 29 批）：按 numbering.xml 与样式算出，与 mapParagraphs 同序；可见文字为空的段落（整段被修订删除、空段）不写编号。
 * numbering.xml 读不出或格式异常时全部为 null（照旧只取可见文字，不让编号拖垮导入）。
 */
function docxParagraphLabels(xml: string, buf: Buffer): (string | null)[] {
  try {
    const numbering = readEntryText(buf, "word/numbering.xml");
    if (!numbering) return [];
    const labels = paragraphListLabels(xml, numbering, readEntryText(buf, "word/styles.xml"));
    const visible = mapParagraphs(xml).map((p) => p.text.trim() !== "");
    return labels.map((l, i) => (visible[i] ? l : null));
  } catch {
    return [];
  }
}

/**
 * DOCX 中解析文本之外、密级检测也要看的文字（classified-marking.ts）：页眉页脚（密级标志常在页眉），以及**含修订删除内容**的正文
 * （解析文本只取可见文字；标志即使在修订删除里，文件本身仍带着它——检测从严）。非 DOCX 或读不出时返回空数组。
 */
export function docxHeaderFooterTexts(filename: string, mime: string, buf: Buffer): string[] {
  const lower = filename.toLowerCase();
  if (!lower.endsWith(".docx") && mime !== "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return [];
  try {
    // 正文（含修订删除内容）一定在内；页眉页脚最多 12 个（复核 C-B10：不让页眉页脚的数量把正文挤出去）
    const entries = listEntries(buf);
    const body = entries.filter((e) => e.name === "word/document.xml");
    const hf = entries.filter((e) => /^word\/(?:header|footer)\d*\.xml$/.test(e.name)).slice(0, 12);
    return [...body, ...hf].map((e) => docxXmlToText(readEntry(e).toString("utf8"), { keepDeleted: true }));
  } catch {
    return [];
  }
}

/**
 * 段落级提取：w:p → 换行；w:tab → \t；其余标签剥离。
 * 带修订的文档取“可见文字”（复核 B3-B14）：已删除的文字（w:del、w:moveFrom 里的内容）不计入——与审查定位视图、结构化补丁同一口径，
 * Agent 从材料快照里逐字摘录的引文因此能在定位视图里找到；修订前后的差异由 docx.compare 单独提供。
 */
export function docxXmlToText(xml: string, o: { keepDeleted?: boolean } = {}): string {
  const visible = o.keepDeleted
    ? xml
    : xml
        .replace(/<w:(del|moveFrom)\b[^>]*\/>/g, "")
        .replace(/<w:(del|moveFrom)\b[^>]*>[\s\S]*?<\/w:\1>/g, "")
        .replace(/<w:delText\b[^>]*>[\s\S]*?<\/w:delText>/g, "");
  // 表格（B-11）：每张表按行写成“| 单元格 | 单元格 |”，换成占位符；单元格里的多段用空格连起，嵌套表压成一格
  const tables: string[] = [];
  const body = tablesToPlaceholders(visible, tables);
  return restoreTables(inlineText(body), tables)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 一遍扫完全文（复核 R15B-19：原先每张表都对全文做一次正则替换，几百张表的审计报告会长时间占住内核，且 500 张以后悄悄退回旧格式）：
 * 遇到 <w:tbl> 开一层，遇到 </w:tbl> 把这一层（里面的嵌套表已换成占位符）写成表格文字、在上一层留占位符。
 * 多余的结束标签丢掉；没闭合的表，内容照常当正文。
 */
function tablesToPlaceholders(xml: string, tables: string[]): string {
  const stack: string[] = [""];
  let last = 0;
  for (const m of xml.matchAll(/<(\/?)w:tbl\b[^>]*>/g)) {
    stack[stack.length - 1] += xml.slice(last, m.index);
    last = m.index! + m[0].length;
    if (m[0].endsWith("/>")) continue;
    if (!m[1]) {
      stack.push("");
      continue;
    }
    if (stack.length === 1) continue;
    tables.push(tableText(stack.pop()!, tables));
    stack[stack.length - 1] += `<w:p>\u0000T${tables.length - 1}\u0000</w:p>`;
  }
  stack[stack.length - 1] += xml.slice(last);
  return stack.join("");
}

function tableText(inner: string, tables: string[]): string {
  const rows = [...inner.matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)].map((r) =>
    [...r[1]!.matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g)].map((c) => restoreTables(inlineText(c[1]!), tables, true).replace(/\s*\n+\s*/g, " ").replace(/\|/g, "｜").trim()),
  );
  return rows.filter((r) => r.length > 0).map((r) => `| ${r.join(" | ")} |`).join("\n");
}

/** 表格占位符换回表格文字（嵌套表在单元格里压成一行，各行用“；”隔开）。 */
function restoreTables(text: string, tables: string[], nested = false): string {
  return text.replace(/\u0000T(\d+)\u0000/g, (_m, i: string) => {
    const t = restoreTables(tables[Number(i)] ?? "", tables, true);
    return nested ? t.replace(/\n/g, "；") : t;
  });
}

/** 段落与制表、换行 → 文字（不含表格：表格已换成占位符）。 */
function inlineText(xml: string): string {
  return xml
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<w:br\b[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
