/**
 * 生成新 DOCX（意见书/报告/清洁稿模板）：带律所版式（house-style.ts：A4、字体字号、标题居中、页码、落款），Word/WPS 可开。
 * 函头与律所模板在下载 / 导出时按本机的“文书版式”设置套上（成果登记的字节不含函头）。
 */
import { alignSignature, createStyledDocx, type DocBlock } from "./house-style.ts";

/** 节内表格（第 32 批：合同价款表、设备清单、证据目录等）：画在本节段落之后，首行为表头。 */
export interface ReportTable {
  columns: string[];
  rows: string[][];
}

export interface ReportSection {
  heading: string;
  paragraphs: string[];
  table?: ReportTable;
}

/** mark=false：不带本产品标记，导出时不套函头（示例合同、清洁稿这类不是律所出具的文件）。 */
/** 只表示结构、不该印成小标题的节名（复核 R15B-09：律师函方法里的“落款与联系方式”）。 */
// 第 28 批：起诉状、答辩状等的“当事人”“首部”“结尾”只是方法里的分段，正式文书没有这些小标题
const STRUCTURE_HEADING = /^(落款|落款与联系方式|署名|签署|签字|签名|当事人|当事人信息|当事人基本情况|首部|尾部|结尾|结尾部分)$/;
/** 标题末尾的“（草稿）”不印进正文标题（草稿状态在文件名、文件属性与成果状态里；律师递交前不必再手工删）。 */
const DRAFT_SUFFIX = /\s*[（(]草稿[）)]\s*$/;

export function createDocx(title: string, sections: ReportSection[], o: { mark?: boolean } = {}): Buffer {
  const shown = title.replace(DRAFT_SUFFIX, "");
  const blocks: DocBlock[] = shown ? [{ kind: "title", text: shown }] : [];
  for (const s of sections) {
    if (s.heading && !STRUCTURE_HEADING.test(s.heading.trim())) blocks.push({ kind: "h1", text: s.heading });
    for (const p of s.paragraphs) blocks.push({ kind: "p", runs: [{ text: p }] });
    if (s.table) blocks.push({ kind: "table", rows: [s.table.columns, ...s.table.rows].map((r) => r.map((text) => [{ text }])) });
  }
  // 起诉状、律师函的落款（律所、律师、具状人、日期）右对齐，与 Markdown 导出同一规则
  return createStyledDocx(alignSignature(blocks), undefined, null, o);
}

/** 纯文本 → DOCX（清洁稿从文本重建的降级路径；主路径是修订稿接受全部修订）。 */
export function textToDocx(text: string): Buffer {
  return createDocx("", [{ heading: "", paragraphs: text.split(/\n+/) }], { mark: false });
}
