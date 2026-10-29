/**
 * 第 31 批：整段删除连段落标记一起标为删除（真实走查：按律师意见删除股权转让协议第 5.3 条，清洁稿在原处留下一个空段落；
 * 自动编号的合同会剩一个空的“5.3”，后面的编号也不顺延）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256Hex } from "@zr-legal/domain";
import { applyRevisionsToDocx, createDocx, docxListLabels, extractParagraphs, markParagraphDeleted, readZipEntries, sanitizeDocx, writeZip } from "../src/index.ts";

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
const del = (docx: Buffer, text: string) =>
  applyRevisionsToDocx(docx, { baselineHash: sha256Hex(docx), ops: [{ opId: "d", anchor: { originalText: text }, originalHash: sha256Hex(text), newText: "", author: "测试" }] }).docx;
const texts = (docx: Buffer) => extractParagraphs(docx).map((p) => p.text);

test("删掉一段的全部文字：修订稿里段落标记也标删除，清洁稿整段消失、不留空行", () => {
  const docx = withBody([para("5.2 甲方保证标的股权未设定质押。"), para("5.3 乙方同意按现状受让标的股权。"), para("第六条 债权债务")].join(""));
  const revised = del(docx, "5.3 乙方同意按现状受让标的股权。");
  const xml = readZipEntries(revised).get("word/document.xml")!.toString("utf8");
  assert.match(xml, /<w:pPr><w:rPr><w:del w:id="\d+" w:author="测试" w:date="[^"]+"\/><\/w:rPr><\/w:pPr><w:del /, "段落标记删除");
  const clean = sanitizeDocx(revised).docx;
  assert.deepEqual(texts(clean), ["5.2 甲方保证标的股权未设定质押。", "第六条 债权债务"]);
});

test("只删段内一部分文字时段落标记不动", () => {
  const docx = withBody([para("5.3 乙方同意按现状受让标的股权，但甲方另有保证的除外。"), para("第六条 债权债务")].join(""));
  const revised = del(docx, "，但甲方另有保证的除外");
  assert.doesNotMatch(readZipEntries(revised).get("word/document.xml")!.toString("utf8"), /<w:rPr><w:del /);
  assert.deepEqual(texts(sanitizeDocx(revised).docx), ["5.3 乙方同意按现状受让标的股权。", "第六条 债权债务"]);
});

test("自动编号的条款整段删除：清洁稿里没有空的编号，后面的编号顺延", () => {
  const docx = withBody([para("陈述与保证", num(0)), para("甲方保证标的股权未设定质押。", num(1)), para("乙方同意按现状受让标的股权。", num(1)), para("甲方保证已足额实缴。", num(1))].join(""), NUMBERING);
  assert.deepEqual(docxListLabels(docx).filter(Boolean), ["第一条", "1.1", "1.2", "1.3"]);
  const clean = sanitizeDocx(del(docx, "乙方同意按现状受让标的股权。")).docx;
  assert.deepEqual(texts(clean), ["陈述与保证", "甲方保证标的股权未设定质押。", "甲方保证已足额实缴。"]);
  assert.deepEqual(docxListLabels(clean).filter(Boolean), ["第一条", "1.1", "1.2"], "原 1.3 顺延为 1.2");
});

test("段落标记删除：已有段落 rPr 的加在里面；带分节符或段落格式修订的不动", () => {
  assert.equal(markParagraphDeleted('<w:p><w:pPr><w:jc w:val="both"/><w:rPr><w:b/></w:rPr></w:pPr><w:r><w:t>x</w:t></w:r></w:p>', 9, "A", "D"), '<w:p><w:pPr><w:jc w:val="both"/><w:rPr><w:b/><w:del w:id="9" w:author="A" w:date="D"/></w:rPr></w:pPr><w:r><w:t>x</w:t></w:r></w:p>');
  assert.equal(markParagraphDeleted('<w:p w:rsidR="1"><w:r><w:t>x</w:t></w:r></w:p>', 9, "A", "D"), '<w:p w:rsidR="1"><w:pPr><w:rPr><w:del w:id="9" w:author="A" w:date="D"/></w:rPr></w:pPr><w:r><w:t>x</w:t></w:r></w:p>');
  const sect = '<w:p><w:pPr><w:sectPr><w:pgSz w:w="11906"/></w:sectPr></w:pPr><w:r><w:t>x</w:t></w:r></w:p>';
  assert.equal(markParagraphDeleted(sect, 9, "A", "D"), sect);
  const chg = '<w:p><w:pPr><w:jc w:val="left"/><w:pPrChange w:id="1"><w:pPr><w:jc w:val="both"/></w:pPr></w:pPrChange></w:pPr><w:r><w:t>x</w:t></w:r></w:p>';
  assert.equal(markParagraphDeleted(chg, 9, "A", "D"), chg);
});
