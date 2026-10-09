/**
 * v0 解析器（占位）：纯文本直接读取；DOCX 粗提取 word/document.xml 文本层。
 * 生产文档服务（§4.1/§5.4）：解析、OCR、锚点、质量标记由独立隔离 worker 承担，
 * 中文合同保真度以 G0 同台评测为准。v0 解析结果一律打 quality_flags，如实降级。
 */
import { DomainError } from "@zr-legal/domain";
import { readEntryText } from "./zip.ts";

export interface ParseOutcome {
  text: string;
  pageCount: number | null;
  qualityFlags: string[];
  parser: string;
  parserVersion: string;
}

const PARSER_VERSION = "v0.1.0-crude";

export function parseDocument(filename: string, mime: string, buf: Buffer): ParseOutcome {
  const lower = filename.toLowerCase();
  if (mime.startsWith("text/") || lower.endsWith(".txt") || lower.endsWith(".md")) {
    return {
      text: buf.toString("utf8"),
      pageCount: null,
      qualityFlags: ["plain_text"],
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

/** 段落级提取：w:p → 换行；w:tab → \t；其余标签剥离。 */
export function docxXmlToText(xml: string): string {
  return xml
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
