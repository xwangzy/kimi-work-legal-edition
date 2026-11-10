/**
 * 律师上传的原件：全文先完整识别一遍、新认出的姓名与机构写回事项代号表（V16 第 41 批安全评审 H1、H2）。
 *
 * 为什么：“只替换已知名单”（knownOnly）只对事项代号表里已有的名字生效。它用在助手或复核人写的文字上，免得普通词被认成姓名；
 * 但修订工具的返回（改前整段、编号顺延的条款开头）、复核对象里的修订稿与清洁稿（含页眉页脚）带着原件原文——原件如果从没进过任务的材料快照，
 * 里面的姓名从没被识别过，只换已知名单就会让真名以明文发往云端。凡是要按“只换已知名单”送出原件文字的地方，先调这里。
 *
 * 读取范围：正文（含表格）、页眉、页脚、脚注、尾注、批注，以及原件文件名；非 Word 材料按解析出的文字。
 * 读不到原件时返回 false，调用方不得再按“只换已知名单”送出这份原件的文字（退回完整识别，宁可多遮）。
 */
import { docxAllPartsText, mapParagraphs, readZipText } from "@zr-legal/docx-engine";
import type { KernelDb } from "../db.ts";
import type { BlobStore } from "../blobs.ts";
import type { MatterTokenStore } from "../egress/matter-tokens.ts";

/** 原件的全部可见文字（正文、表格、页眉页脚、脚注尾注、批注）与文件名；读不到返回 null。 */
export function sourceDocumentTexts(db: KernelDb, blobs: BlobStore, matterId: string, documentVersionId: string): string[] | null {
  const row = db.get<{ storage_uri: string; filename: string }>(`SELECT storage_uri, filename FROM document_versions WHERE document_version_id = ? AND matter_id = ?`, [documentVersionId, matterId]);
  if (!row) return null;
  try {
    const buf = blobs.read(row.storage_uri);
    if (row.filename.toLowerCase().endsWith(".docx")) {
      const comments = readZipText(buf, "word/comments.xml");
      return [row.filename, docxAllPartsText(buf), ...(comments ? [mapParagraphs(comments).map((p) => p.text).join("\n")] : [])];
    }
    const parsed = db.get<{ content: string }>(
      `SELECT pt.content FROM parse_versions pv JOIN parse_texts pt ON pt.parse_version_id = pv.parse_version_id WHERE pv.document_version_id = ? ORDER BY pv.created_at DESC LIMIT 1`,
      [documentVersionId],
    );
    return [row.filename, parsed?.content ?? buf.toString("utf8")];
  } catch {
    return null;
  }
}

/** 完整识别原件全文并写回事项代号表（tokenizeAll 会持久化新条目）。成功返回 true；读不到原件返回 false。 */
export function learnSourceDocument(deps: { db: KernelDb; blobs: BlobStore; tokens: MatterTokenStore }, matterId: string, documentVersionId: string): boolean {
  const texts = sourceDocumentTexts(deps.db, deps.blobs, matterId, documentVersionId);
  if (!texts) return false;
  deps.tokens.tokenizeAll(matterId, texts);
  return true;
}
