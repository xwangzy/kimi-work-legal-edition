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
// 第 35 批：意见书方法的“致送对象与事由”“签署栏”同样只是分段（文档工程审查 A-03）
const STRUCTURE_HEADING = /^(落款|落款与联系方式|署名|签署|签字|签名|签署栏|签署页|签字页|签章页|致送对象|致送对象与事由|当事人|当事人信息|当事人基本情况|首部|尾部|结尾|结尾部分)$/;
/** 标题末尾的“（草稿）”不印进正文标题（草稿状态在文件名、文件属性与成果状态里；律师递交前不必再手工删）。 */
const DRAFT_SUFFIX = /\s*[（(]草稿[）)]\s*$/;

export function createDocx(title: string, sections: ReportSection[], o: { mark?: boolean } = {}): Buffer {
  const shown = title.replace(DRAFT_SUFFIX, "");
  const blocks: DocBlock[] = shown ? [{ kind: "title", text: shown }] : [];
  for (const s of sections) {
    if (s.heading && !STRUCTURE_HEADING.test(s.heading.trim())) blocks.push({ kind: "h1", text: s.heading });
    // 段内换行拆成独立段落（第 35 批真实走查 R1：首部各方信息、签署块按“一项一行”写进同一段，换行留在文字里，Word 打开挤成一行）
    for (const p of s.paragraphs) {
      const lines = String(p).split(/\r?\n/);
      if (lines.length === 1) blocks.push({ kind: "p", runs: [{ text: p }] });
      else for (const line of lines) if (line.trim()) blocks.push({ kind: "p", runs: [{ text: line }] });
    }
    if (s.table) blocks.push({ kind: "table", rows: [s.table.columns, ...s.table.rows].map((r) => r.map((text) => [{ text }])) });
  }
  // 起诉状、律师函的落款（律所、律师、具状人、日期）右对齐，与 Markdown 导出同一规则；合同签署页另起一页、签署行不缩进（第 35 批）
  return createStyledDocx(alignSignature(signaturePage(blocks)), undefined, null, o);
}

/** 合同各方的签署行开头（“受让方：”“甲方（盖章）：”“转让方一：”）。 */
const PARTY_SIGN = /^(?:甲方|乙方|丙方|丁方|戊方|受让方|转让方|出让方|出租人|出租方|承租人|承租方|买方|卖方|委托方|受托方|委托人|受托人|服务方|发包人|承包人|借款人|出借人|贷款人|保证人|担保人|投资方|目标公司|创始股东|增资方|原股东|合作方|许可方|被许可方)[一二三四五六七八九十]?\s*[（(：:]/;

/**
 * 合同签署页（第 35 批，文档工程审查 A-02）：“（以下无正文……）”之后到下一个标题或表格之前的段落，若含合同一方的签署行，
 * 作为签署页——第一行另起一页、各行左对齐不缩进，各方之间空一行；“以下无正文”那一行留在上一页。意见书、律师函的落款不在此列（仍右对齐）。
 */
export function signaturePage(blocks: DocBlock[]): DocBlock[] {
  const start = blocks.findIndex((b) => b.kind === "p" && /^[（(]\s*以下无正文/.test(b.runs.map((r) => r.text).join("").trim()));
  if (start < 0) return blocks;
  let end = start + 1;
  while (end < blocks.length && (blocks[end]!.kind === "p" || blocks[end]!.kind === "blank")) end += 1;
  const lines = blocks.slice(start + 1, end);
  const textOf = (b: DocBlock) => (b.kind === "p" ? b.runs.map((r) => r.text).join("").trim() : "");
  if (!lines.some((b) => PARTY_SIGN.test(textOf(b)))) return blocks;
  const out: DocBlock[] = blocks.slice(0, start + 1);
  let first = true;
  for (const b of lines) {
    if (b.kind !== "p") continue;
    if (!first && PARTY_SIGN.test(textOf(b))) out.push({ kind: "blank" });
    out.push({ ...b, sign: true, ...(first ? { pageBreakBefore: true } : {}) });
    first = false;
  }
  // 签署页之后的“附件”另起一页
  const rest = blocks.slice(end).map((b, i) => (i === 0 && (b.kind === "h1" || b.kind === "h2") && /^附件/.test(b.text) ? { ...b, pageBreakBefore: true } : b));
  return [...out, ...rest] as DocBlock[];
}

/** 纯文本 → DOCX（清洁稿从文本重建的降级路径；主路径是修订稿接受全部修订）。 */
export function textToDocx(text: string): Buffer {
  return createDocx("", [{ heading: "", paragraphs: text.split(/\n+/) }], { mark: false });
}
