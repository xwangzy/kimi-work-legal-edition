/**
 * v9.4 第 32 批：Word 文书里的表格（合同价款表、设备清单、证据目录）。
 * - 节内表格画在本节段落之后、下一节之前，首行为表头且跨页重复；
 * - 列宽按内容分配（“序号”“数量”不和“设备名称”一样宽），总宽不超过版心；
 * - 格子里的文字照样进段落提取（导出还原、待补占位、引用核对都靠它）、预览与导出套版式时表格不丢。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDocx, extractParagraphs, readZipEntries, renderDocxHtml, restyleDocx } from "../src/index.ts";

const docXml = (buf: Buffer) => readZipEntries(buf).get("word/document.xml")?.toString("utf8") ?? "";

const CONTRACT = createDocx("设备买卖合同", [
  { heading: "第一条 标的与价款", paragraphs: ["1.1 买方向卖方购买下列设备："], table: {
    columns: ["序号", "设备名称", "型号规格", "数量", "单价（元）", "金额（元）"],
    rows: [
      ["1", "立式加工中心", "VMC-850 三轴 主轴 12000rpm", "2", "380,000.00", "760,000.00"],
      ["2", "数控车床", "CK6150 卧式", "1", "【待填】", "【待填】"],
    ],
  } },
  { heading: "", paragraphs: ["1.2 合同总价为人民币壹佰贰拾万元整（¥1,200,000.00），含税。"] },
  { heading: "第二条 交付", paragraphs: ["2.1 卖方应于合同生效后六十日内交付。"] },
]);

test("第 32 批：节内表格画在本节段落之后、下一节之前；首行表头加粗并跨页重复", () => {
  const xml = docXml(CONTRACT);
  const at = (s: string) => xml.indexOf(s);
  assert.ok(at("1.1 买方向卖方购买") < at("<w:tbl>"), "表在本节段落之后");
  assert.ok(at("</w:tbl>") < at("1.2 合同总价"), "表后正文另起一节、接在表后");
  assert.ok(at("1.2 合同总价") < at("第二条 交付"));
  assert.equal((xml.match(/<w:tbl>/g) ?? []).length, 1);
  assert.equal((xml.match(/<w:tblHeader\/>/g) ?? []).length, 1, "只有首行是重复表头");
  const firstRow = /<w:tr>[\s\S]*?<\/w:tr>/.exec(xml)![0];
  assert.match(firstRow, /<w:tblHeader\/>/);
  assert.match(firstRow, /<w:b\/><\/w:rPr><w:t xml:space="preserve">序号</);
  // 空标题的节不印小标题
  assert.equal((xml.match(/KwlHeading1/g) ?? []).length, 2);
});

test("第 32 批：列宽按内容分配——短列窄、长列宽，各格宽度与网格一致，总宽不超过版心", () => {
  const xml = docXml(CONTRACT);
  const grid = [...xml.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((m) => Number(m[1]));
  assert.equal(grid.length, 6);
  const [seq, name, model, qty] = grid as [number, number, number, number];
  assert.ok(seq < name && qty < name, `序号、数量比设备名称窄：${grid.join(",")}`);
  assert.ok(model > name, "型号规格最长，最宽");
  assert.ok(grid.reduce((a, b) => a + b, 0) <= 8845);
  const firstRow = /<w:tr>[\s\S]*?<\/w:tr>/.exec(xml)![0];
  assert.deepEqual([...firstRow.matchAll(/<w:tcW w:w="(\d+)"/g)].map((m) => Number(m[1])), grid);
});

test("第 32 批：格子里的文字进段落提取（导出还原、待补占位靠它），预览成 HTML 表格，导出套版式后表格还在", () => {
  const text = extractParagraphs(CONTRACT).map((p) => p.text).join("\n");
  assert.match(text, /立式加工中心/);
  assert.equal((text.match(/【待填】/g) ?? []).length, 2);
  const html = renderDocxHtml(CONTRACT).html;
  assert.match(html, /<table><tr><td>[\s\S]*序号[\s\S]*<\/table>/);
  assert.match(html, /<td>[^]*?760,000\.00/);
  const restyled = docXml(restyleDocx(CONTRACT, { letterhead: { name: "某某律师事务所", lines: [] }, body: "fangsong-san", pageNumbers: true }));
  assert.match(restyled, /<w:tbl>[\s\S]*<w:tblHeader\/>[\s\S]*数控车床[\s\S]*<\/w:tbl>/);
});
