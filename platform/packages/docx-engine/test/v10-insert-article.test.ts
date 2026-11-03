/**
 * V10 第 36 批真实走查 V12：律师要“保密那条后面单独加一条‘数据与个人信息保护’”。自动编号的合同里 insert_after 照抄锚点（6.1）
 * 的段落格式，新条只能写成 6.2～6.5。现在插入的首行写“第 N 条 标题”时，首行沿用锚点所属那一条标题段落的格式（自动编号的去掉
 * “第 N 条”由 Word 续号），其余各行仍是款；只认明写的“第 N 条”，短句不当标题。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256Hex } from "@zr-legal/domain";
import { applyRevisionsToDocx, createDocx, docxListLabels, extractParagraphs, readZipEntries, sanitizeDocx, writeZip } from "../src/index.ts";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const NUMBERING = `<?xml version="1.0" encoding="UTF-8"?><w:numbering ${W}>
<w:abstractNum w:abstractNumId="7"><w:multiLevelType w:val="multilevel"/>
<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="chineseCounting"/><w:lvlText w:val="第%1条"/></w:lvl>
<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:isLgl/><w:lvlText w:val="%1.%2"/></w:lvl>
</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="7"/></w:num></w:numbering>`;
const para = (text: string, pPr = "") => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const num = (ilvl: number) => `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="1"/></w:numPr>`;

function withBody(body: string, numbering?: string): Buffer {
  const files = readZipEntries(createDocx("合同", [{ heading: "占位", paragraphs: ["占位"] }]));
  files.set("word/document.xml", Buffer.from(files.get("word/document.xml")!.toString("utf8").replace(/<w:body>[\s\S]*?(<w:sectPr)/, `<w:body>${body}$1`)));
  if (numbering) files.set("word/numbering.xml", Buffer.from(numbering));
  return writeZip([...files.entries()].map(([name, data]) => ({ name, data })));
}
const insert = (docx: Buffer, anchor: string, newText: string) =>
  applyRevisionsToDocx(docx, { baselineHash: sha256Hex(docx), ops: [{ opId: "i", anchor: { originalText: anchor }, originalHash: sha256Hex(anchor), newText, insertAfter: true, author: "测试" }] }).docx;
const texts = (docx: Buffer) => extractParagraphs(docx).map((p) => p.text);

const contract = () =>
  withBody(
    [
      para("保密", num(0)),
      para("双方对在履行本合同过程中知悉的对方商业秘密负有保密义务。", num(1)),
      para("违约责任", num(0)),
      para("任何一方违约的，应赔偿对方因此受到的损失。", num(1)),
    ].join(""),
    NUMBERING,
  );

test("自动编号：插在 6.1 后、首行写“第 N 条 标题”的，新条续成下一条，后面的条号顺延，正文是新条的款", () => {
  const docx = contract();
  assert.deepEqual(docxListLabels(docx).filter(Boolean), ["第一条", "1.1", "第二条", "2.1"]);
  const revised = insert(docx, "双方对在履行本合同过程中知悉的对方商业秘密负有保密义务。", "第二条 数据与个人信息保护\n乙方仅为实施与运维目的处理甲方提供的个人信息。\n乙方不得将个人信息转委托第三方处理。");
  const clean = sanitizeDocx(revised).docx;
  assert.deepEqual(texts(clean), ["保密", "双方对在履行本合同过程中知悉的对方商业秘密负有保密义务。", "数据与个人信息保护", "乙方仅为实施与运维目的处理甲方提供的个人信息。", "乙方不得将个人信息转委托第三方处理。", "违约责任", "任何一方违约的，应赔偿对方因此受到的损失。"], "自动编号的去掉手写的“第二条”");
  assert.deepEqual(docxListLabels(clean).filter(Boolean), ["第一条", "1.1", "第二条", "2.1", "2.2", "第三条", "3.1"], "新条续号，原第二条顺延为第三条");
});

test("首行不是“第 N 条”的照原做法：都沿用锚点的款格式", () => {
  const revised = insert(contract(), "双方对在履行本合同过程中知悉的对方商业秘密负有保密义务。", "保密期限\n保密义务在本合同终止后五年内有效。");
  assert.deepEqual(docxListLabels(sanitizeDocx(revised).docx).filter(Boolean), ["第一条", "1.1", "1.2", "1.3", "第二条", "2.1"]);
});

test("手打编号：首行写“第七条 ……”的照前一条标题段落的格式，文字原样保留", () => {
  const head = '<w:jc w:val="center"/><w:spacing w:before="160"/>';
  const docx = withBody([para("第六条 保密", head), para("6.1 双方负有保密义务。"), para("第七条 违约责任", head), para("7.1 违约方赔偿损失。")].join(""));
  const revised = insert(docx, "6.1 双方负有保密义务。", "第七条 数据与个人信息保护\n7.1 乙方仅为实施目的处理个人信息。");
  const xml = readZipEntries(revised).get("word/document.xml")!.toString("utf8");
  const ps = [...xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)].map((m) => m[0]);
  const title = ps.find((p) => p.includes("第七条 数据与个人信息保护"))!;
  assert.match(title, /<w:jc w:val="center"\/>/, "新条标题沿用条标题的段落格式");
  assert.doesNotMatch(ps.find((p) => p.includes("7.1 乙方仅为"))!, /<w:jc w:val="center"\/>/, "款沿用锚点的段落格式");
  assert.deepEqual(texts(sanitizeDocx(revised).docx).slice(2, 4), ["第七条 数据与个人信息保护", "7.1 乙方仅为实施目的处理个人信息。"]);
});
