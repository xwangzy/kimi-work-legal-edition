/**
 * v0 解析器（占位）：纯文本直接读取；DOCX 粗提取 word/document.xml 文本层。
 * 生产文档服务（§4.1/§5.4）：解析、OCR、锚点、质量标记由独立隔离 worker 承担，
 * 中文合同保真度以 G0 同台评测为准。v0 解析结果一律打 quality_flags，如实降级。
 */
import { DomainError } from "@zr-legal/domain";
import { listEntries, readEntry, readEntryText } from "./zip.ts";

export interface ParseOutcome {
  text: string;
  pageCount: number | null;
  qualityFlags: string[];
  parser: string;
  parserVersion: string;
}

// v0.1.1：DOCX 取可见文字（修订删除、移动原位置不计入；复核 B3-B14、C-B04）——新旧解析版本可按此区分
const PARSER_VERSION = "v0.1.1-crude";

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
  if (mime.startsWith("text/") || lower.endsWith(".txt") || lower.endsWith(".md")) {
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
    const text = docxXmlToText(xml);
    return {
      text,
      pageCount: null,
      qualityFlags: ["v0_crude_docx_parser", "no_page_anchors", "tables_flattened", "comments_revisions_ignored"],
      parser: "docx-crude",
      parserVersion: PARSER_VERSION,
    };
  }
  if (lower.endsWith(".pdf") || mime === "application/pdf") {
    // 生产：PDF 文本层 + OCR（文档服务）；v0 不伪造解析能力
    throw new DomainError("unsupported_file", "PDF 解析待文档服务接入（G0 第 3–4 周）；v0 支持 DOCX/TXT", 422, {
      supported: ["docx", "txt", "md"],
    });
  }
  throw new DomainError("unsupported_file", `不支持的文件类型 ${mime}（v0 支持 DOCX/TXT/MD）`, 422);
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
  return visible
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<w:br\b[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
