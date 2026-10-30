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

test("复核 A-01：每列都放得下表头（至多 5 个汉字）与最长的金额、型号——序号、数量不竖排，金额不折行；列很多时按保底比例缩", () => {
  // 小四：汉字 240 twip、半角 120；单元格左右边距合计 216
  const fits = (w: number, halfEms: number) => w >= 216 + 120 * halfEms;
  const grid = (buf: Buffer) => [...docXml(buf).matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((m) => Number(m[1]));
  const [seq, name, model, qty, price, amount] = grid(CONTRACT) as number[];
  assert.ok(fits(seq!, 4) && fits(qty!, 4), `序号、数量放得下两个汉字：${seq}、${qty}`);
  assert.ok(fits(price!, 10) && fits(amount!, 10), `单价（元）表头与“760,000.00”放得下：${price}、${amount}`);
  assert.ok(name! > seq! && model! > name!);
  // 审查意见表（review-cards 导出同一渲染）：“律师决定”这类短内容列不再缩到一行一个字
  const review = createDocx("", [{ heading: "", paragraphs: [], table: { columns: ["条款", "问题", "类型与等级", "判断依据", "建议", "律师决定"], rows: [["7.1", "违约金过低，不足以覆盖逾期办理变更登记给受让方造成的损失，且未约定上限之外的赔偿", "违约责任 · 高", "民法典第五百八十五条第二款：约定的违约金低于造成的损失的，人民法院或者仲裁机构可以根据当事人的请求予以增加", "将万分之一改为千分之三，并约定违约金不足以弥补损失的，违约方继续赔偿", "接受"]] } }], { mark: false });
  const g = grid(review);
  assert.ok(fits(g[5]!, 8), `“律师决定”表头放得下：${g.join(",")}`);
  assert.ok(g.reduce((a, b) => a + b, 0) <= 8845);
  // 10 列短表头：保底合计超过版心时按比例缩，总宽仍不超过版心
  const wide = grid(createDocx("", [{ heading: "", paragraphs: [], table: { columns: Array.from({ length: 10 }, (_, i) => `第${i + 1}列标题文字`), rows: [Array.from({ length: 10 }, () => "x")] } }], { mark: false }));
  assert.equal(wide.length, 10);
  assert.ok(wide.reduce((a, b) => a + b, 0) <= 8845);
});

test("复核 A-06：文末是附页表格（证据目录）时，附页之前的落款照样右对齐；两张表之间隔一个空段不粘连", () => {
  const filing = createDocx("民事起诉状", [
    { heading: "", paragraphs: ["此致", "嘉兴市南湖区人民法院", "具状人：浙江衡川新材料有限公司", "2026 年 10 月 30 日"] },
    { heading: "证据目录", paragraphs: [], table: { columns: ["证据编号", "证据名称", "证明目的"], rows: [["1", "购销合同", "双方买卖关系"]] } },
    { heading: "", paragraphs: [], table: { columns: ["序号", "材料"], rows: [["1", "授权委托书"]] } },
  ]);
  const xml = docXml(filing);
  assert.match(xml, /KwlRight"\/><\/w:pPr><w:r><w:t xml:space="preserve">具状人：浙江衡川新材料有限公司/);
  assert.match(xml, /KwlRight"\/><\/w:pPr><w:r><w:t xml:space="preserve">2026 年 10 月 30 日/);
  assert.match(xml, /<\/w:tbl><w:p\/><w:tbl>/, "两张表之间有空段");
});

test("复核 A-03：格子与段落里的控制字符（PDF、OCR 摘录带出的换页符等）不写进文件，生成的 XML 合法", () => {
  const d = createDocx("清单", [{ heading: "一", paragraphs: ["第一页\f第二页\u000b续"], table: { columns: ["名称\u0001"], rows: [["送货单\u0008汇总"]] } }]);
  const xml = docXml(d);
  assert.equal(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(xml), false);
  assert.match(xml, /第一页第二页续/);
  assert.match(xml, /送货单汇总/);
});
