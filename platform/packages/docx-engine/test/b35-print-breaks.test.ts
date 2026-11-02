/**
 * 第 35 批（文档工程审查 D-02）：导出 PDF 的打印页认 Word 的分页设置——段前分页（合同签署页另起一页）、与下段同页（标题不落页末）、
 * 手动分页符。此前打印页不认，签署页会并到上一页，与下载的 Word 不一致。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDocx, renderDocxPrintHtml, readZipEntries, writeZip } from "../src/index.ts";

test("合同签署页在打印页里另起一页；“以下无正文”留在上一页", () => {
  const docx = createDocx("设备买卖合同", [
    { heading: "第一条 标的", paragraphs: ["1.1 设备见附件。"] },
    { heading: "", paragraphs: ["（以下无正文，为签署页）", "甲方（盖章）：", "法定代表人或授权代表：", "乙方（盖章）：", "法定代表人或授权代表："] },
  ]);
  const html = renderDocxPrintHtml(docx, "设备买卖合同");
  const sign = /<p style="([^"]*)">甲方（盖章）：<\/p>/.exec(html);
  assert.ok(sign, html.slice(0, 2000));
  assert.match(sign![1]!, /break-before:page/, "签署页第一行另起一页");
  assert.doesNotMatch(/<p style="([^"]*)">（以下无正文，为签署页）<\/p>/.exec(html)![1]!, /break-before:page/);
});

test("标题与下段同页、手动分页符另起一页", () => {
  const docx = createDocx("法律意见书", [{ heading: "一、事实", paragraphs: ["正文。"] }]);
  const files = readZipEntries(docx);
  let xml = files.get("word/document.xml")!.toString("utf8");
  // 在“正文。”所在段落开头插入手动分页符
  xml = xml.replace(/(<w:p\b[^>]*>(?:(?!<\/w:p>)[\s\S])*?)(<w:r\b[^>]*>(?:(?!<\/w:r>)[\s\S])*?<w:t[^>]*>正文。)/, `$1<w:r><w:br w:type="page"/></w:r>$2`);
  files.set("word/document.xml", Buffer.from(xml, "utf8"));
  const html = renderDocxPrintHtml(writeZip([...files.entries()].map(([name, data]) => ({ name, data }))), "法律意见书");
  assert.match(/<p style="([^"]*)">正文。<\/p>/.exec(html)?.[1] ?? "", /break-before:page/, "分页符在段首：本段另起一页");
  const styles = files.get("word/styles.xml")!.toString("utf8");
  if (/w:styleId="KwlHeading1"[\s\S]*?<w:keepNext\/>[\s\S]*?<\/w:style>/.test(styles)) assert.match(/<p style="([^"]*)">一、事实<\/p>/.exec(html)?.[1] ?? "", /break-after:avoid/);
});
