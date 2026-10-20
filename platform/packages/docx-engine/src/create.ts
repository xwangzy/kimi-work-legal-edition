/**
 * 生成新 DOCX（意见书/报告/清洁稿模板）：带律所版式（house-style.ts：A4、字体字号、标题居中、页码、落款），Word/WPS 可开。
 * 函头与律所模板在下载 / 导出时按本机的“文书版式”设置套上（成果登记的字节不含函头）。
 */
import { alignSignature, createStyledDocx, type DocBlock } from "./house-style.ts";

export interface ReportSection {
  heading: string;
  paragraphs: string[];
}

/** mark=false：不带本产品标记，导出时不套函头（示例合同、清洁稿这类不是律所出具的文件）。 */
/** 只表示结构、不该印成小标题的节名（复核 R15B-09：律师函方法里的“落款与联系方式”）。 */
const STRUCTURE_HEADING = /^(落款|落款与联系方式|署名|签署|签字|签名)$/;

export function createDocx(title: string, sections: ReportSection[], o: { mark?: boolean } = {}): Buffer {
  const blocks: DocBlock[] = title ? [{ kind: "title", text: title }] : [];
  for (const s of sections) {
    if (s.heading && !STRUCTURE_HEADING.test(s.heading.trim())) blocks.push({ kind: "h1", text: s.heading });
    for (const p of s.paragraphs) blocks.push({ kind: "p", runs: [{ text: p }] });
  }
  // 起诉状、律师函的落款（律所、律师、具状人、日期）右对齐，与 Markdown 导出同一规则
  return createStyledDocx(alignSignature(blocks), undefined, null, o);
}

/** 纯文本 → DOCX（清洁稿从文本重建的降级路径；主路径是修订稿接受全部修订）。 */
export function textToDocx(text: string): Buffer {
  return createDocx("", [{ heading: "", paragraphs: text.split(/\n+/) }], { mark: false });
}
