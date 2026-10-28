/**
 * 第 29 批：Word 自动编号的显示文字。真实走查：条款号由 numbering.xml 生成的合同，解析文字里一个条款号都没有，
 * Agent 审查只能猜条款号、修改时说不清改哪一条。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256Hex } from "@zr-legal/domain";
import {
  applyRevisionsToDocx,
  createDocx,
  documentXmlWithListLabels,
  docxListLabels,
  extractParagraphs,
  formatListNumber,
  paragraphListLabels,
  readZipEntries,
  stripListLabel,
  writeZip,
} from "../src/index.ts";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const NUMBERING = `<?xml version="1.0" encoding="UTF-8"?><w:numbering ${W}>
<w:abstractNum w:abstractNumId="7"><w:multiLevelType w:val="multilevel"/>
<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="chineseCounting"/><w:lvlText w:val="第%1条"/></w:lvl>
<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:isLgl/><w:lvlText w:val="%1.%2"/></w:lvl>
<w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="chineseCounting"/><w:lvlText w:val="（%3）"/></w:lvl>
</w:abstractNum>
<w:abstractNum w:abstractNumId="9"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimalEnclosedCircle"/><w:lvlText w:val="%1"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="7"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="9"/></w:num>
<w:num w:numId="3"><w:abstractNumId w:val="9"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>
</w:numbering>`;
const STYLES = `<w:styles ${W}><w:style w:type="paragraph" w:styleId="ClauseHeading"><w:pPr><w:numPr><w:numId w:val="1"/><w:ilvl w:val="0"/></w:numPr></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="ClauseHeadingBold"><w:basedOn w:val="ClauseHeading"/></w:style></w:styles>`;

const para = (text: string, numPr = "", style = "") =>
  `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${numPr}</w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const num = (ilvl: number, id = 1) => `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${id}"/></w:numPr>`;

function documentXml(): string {
  return `<w:document ${W}><w:body>${[
    para("技术服务合同"),
    para("服务内容", "", "ClauseHeadingBold"), // 样式自带编号（basedOn 继承）→ 第一条
    para("乙方为甲方提供数据中台建设服务。", num(1)),
    para("乙方可以将部分工作交由第三方完成。", num(1)),
    para("服务费用", num(0)),
    para("甲方应于验收合格后三十日内支付。", num(1)),
    para("付款前乙方应开具发票：", num(1)),
    para("增值税专用发票；", num(2)),
    para("税率为百分之六。", num(2)),
    para("不编号的段落", `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/></w:numPr>`),
    para("附件一", num(0, 2)),
    para("附件二", num(0, 2)),
    para("另一列表从头编", num(0, 3)),
  ].join("")}</w:body></w:document>`;
}

test("编号格式：中文计数、带圈数字、字母、罗马数字", () => {
  assert.deepEqual([1, 10, 11, 20, 21, 105, 110].map((n) => formatListNumber(n, "chineseCounting")), ["一", "十", "十一", "二十", "二十一", "一百零五", "一百一十"]);
  assert.equal(formatListNumber(3, "decimalEnclosedCircle"), "③");
  assert.equal(formatListNumber(27, "upperLetter"), "AA");
  assert.equal(formatListNumber(14, "lowerRoman"), "xiv");
  assert.equal(formatListNumber(12, "chineseLegalSimplified"), "壹拾贰");
  assert.equal(formatListNumber(2, "ideographTraditional"), "乙");
});

test("段落编号：直接编号与样式编号同一计数，下级随上级归零，isLgl 写阿拉伯数字，startOverride 从头编", () => {
  const labels = paragraphListLabels(documentXml(), NUMBERING, STYLES);
  assert.deepEqual(labels, [null, "第一条", "1.1", "1.2", "第二条", "2.1", "2.2", "（一）", "（二）", null, "①", "②", "①"]);
  assert.deepEqual(paragraphListLabels(documentXml(), null, STYLES), Array(13).fill(null), "没有 numbering.xml 时不编号");
});

test("文字视图写进编号；锚点开头抄进来的编号只在恰好是本文件编号时去掉", () => {
  const xml = documentXml();
  const labels = paragraphListLabels(xml, NUMBERING, STYLES);
  const shown = documentXmlWithListLabels(xml, labels);
  assert.match(shown, /第一条 <\/w:t><\/w:r><w:r><w:t xml:space="preserve">服务内容/);
  assert.match(shown, /2\.1 <\/w:t><\/w:r><w:r><w:t xml:space="preserve">甲方应于验收合格后三十日内支付/);
  assert.equal(stripListLabel("2.1 甲方应于验收合格后三十日内支付", labels), "甲方应于验收合格后三十日内支付");
  assert.equal(stripListLabel("第二条　服务费用", labels), "服务费用");
  assert.equal(stripListLabel("2.10 不是本文件的编号", labels), "2.10 不是本文件的编号", "不是本文件的编号不动");
  assert.equal(stripListLabel("2.1甲方", labels), "2.1甲方", "编号后面没有空白不动（可能是正文里的数字）");
});

test("修订定位：多段命中时条款提示按 Word 显示的编号比对（自动编号的合同）", () => {
  // 两段文字相同，只有自动编号不同；提示“3.2”须落在第二段
  const base = createDocx("合同", [{ heading: "付款", paragraphs: ["占位"] }]);
  const files = readZipEntries(base);
  const body = [para("付款", num(0)), para("甲方应于验收合格后三十日内支付。", num(1)), para("甲方应于验收合格后三十日内支付。", num(1))].join("");
  files.set("word/document.xml", Buffer.from(files.get("word/document.xml")!.toString("utf8").replace(/<w:body>[\s\S]*?(<w:sectPr)/, `<w:body>${body}$1`)));
  files.set("word/numbering.xml", Buffer.from(NUMBERING.replace(/<w:lvl w:ilvl="0"><w:start w:val="1"\/>/, '<w:lvl w:ilvl="0"><w:start w:val="3"/>')));
  const docx = writeZip([...files.entries()].map(([name, data]) => ({ name, data })));
  const labels = docxListLabels(docx);
  const texts = extractParagraphs(docx).map((p) => p.text);
  assert.deepEqual(labels.filter(Boolean), ["第三条", "3.1", "3.2"], `编号：${JSON.stringify(labels)} ${JSON.stringify(texts)}`);
  const out = applyRevisionsToDocx(docx, {
    baselineHash: sha256Hex(docx),
    ops: [{ opId: "x", anchor: { originalText: "三十日", paragraphHint: "3.2" }, originalHash: sha256Hex("三十日"), newText: "十五日", author: "测试" }],
  });
  const after = extractParagraphs(out.docx).map((p) => p.text).filter((t) => t.startsWith("甲方"));
  assert.deepEqual(after, ["甲方应于验收合格后三十日内支付。", "甲方应于验收合格后十五日内支付。"], "提示“3.2”命中第二段");
});

test("导出 PDF 的打印页（第 29 批）：按样式排版、写出自动编号、取文件的页边距；带修订痕迹的拒绝", async () => {
  const { renderDocxPrintHtml, createStyledDocx } = await import("../src/index.ts");
  const docx = createStyledDocx(
    [
      { kind: "title", text: "律师函" },
      { kind: "p", runs: [{ text: "贵司应于收到本函之日起七日内付款。" }] },
      { kind: "table", rows: [[[{ text: "收款账户" }], [{ text: "【待填】" }]]] },
    ],
    undefined,
    null,
    { mark: false },
  );
  const html = renderDocxPrintHtml(docx, "律师函<测试>");
  assert.match(html, /<title>律师函&lt;测试&gt;<\/title>/, "标题转义");
  assert.match(html, /@page\{size:595\.3pt 841\.9pt;margin:/, "A4 与文件页边距");
  assert.match(html, /<p style="text-align:center;[^"]*font-weight:bold">律师函<\/p>/, "标题居中加粗");
  assert.match(html, /text-indent:2em[^"]*">贵司应于收到本函之日起七日内付款。/, "正文首行缩进两字");
  assert.match(html, /<td><p [^>]*>(?:<span style="font-weight:bold">)?收款账户/, "表格（首行加粗照原件）");
  assert.equal(/<script|https?:/.test(html.replace(/xmlns[^"]*"[^"]*"/g, "")), false, "不带脚本与外部地址");
  // 自动编号写进打印页
  const files = readZipEntries(docx);
  const body = [para("服务费用", num(0)), para("甲方应于验收合格后三十日内支付。", num(1))].join("");
  files.set("word/document.xml", Buffer.from(files.get("word/document.xml")!.toString("utf8").replace(/<w:body>[\s\S]*?(<w:sectPr)/, `<w:body>${body}$1`)));
  files.set("word/numbering.xml", Buffer.from(NUMBERING));
  const numbered = renderDocxPrintHtml(writeZip([...files.entries()].map(([name, data]) => ({ name, data }))), "合同");
  assert.match(numbered, />第一条 服务费用</);
  assert.match(numbered, />1\.1 甲方应于验收合格后三十日内支付。</);
  // 修订稿拒绝
  const revised = applyRevisionsToDocx(docx, { baselineHash: sha256Hex(docx), ops: [{ opId: "r", anchor: { originalText: "七日" }, originalHash: sha256Hex("七日"), newText: "十日", author: "测试" }] }).docx;
  assert.throws(() => renderDocxPrintHtml(revised, "律师函"), /修订痕迹/);
});
