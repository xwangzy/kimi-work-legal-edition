/**
 * v9.4 第 33 批：Word 实开第 32 批成果后发现的两处分页问题。
 * - 表格每行不拆到两页（`cantSplit`）：证据目录一行拆开后，末页只剩重复表头与一个字；
 * - “此致”与下一行受文机关放在同一页（`keepNext`）：“此致”独自落在页末，法院名称到了下一页。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDocx, createStyledDocx, markdownToBlocks, readZipEntries } from "../src/index.ts";

const docXml = (buf: Buffer) => readZipEntries(buf).get("word/document.xml")?.toString("utf8") ?? "";
const paraOf = (xml: string, text: string) => {
  const at = xml.indexOf(`>${text}</w:t>`);
  assert.ok(at > 0, `找到段落：${text}`);
  return xml.slice(xml.lastIndexOf("<w:p>", at), at);
};

const PLEADING = createDocx("民事起诉状", [
  { heading: "事实与理由", paragraphs: ["原告已履行供货义务，特此致函被告催告付款未果。", "此致", "嘉兴市南湖区人民法院", "附：本诉状副本1份；证据目录及证据【待填】份。", "具状人：浙江衡川新材料有限公司（盖章）", "法定代表人：（签名）", "年    月    日"] },
  { heading: "证据目录", paragraphs: [], table: {
    columns: ["证据编号", "证据名称", "证据来源", "证明目的", "页数", "原件或复印件"],
    rows: [
      ["1", "购销合同", "原、被告双方", "拟证明双方买卖合同关系、付款期限、逾期付款违约金标准及争议解决约定。", "【待核】", "待核"],
      ["2", "对账确认函", "被告", "拟证明被告确认截至2025年9月30日尚欠原告货款735,800.00元。", "1页", "待核"],
    ],
  } },
]);

test("第 33 批：表格每行都不拆到两页（cantSplit），只有首行是重复表头且与第一行数据同页", () => {
  const xml = docXml(PLEADING);
  const rows = [...xml.matchAll(/<w:tr>[\s\S]*?<\/w:tr>/g)].map((m) => m[0]);
  assert.equal(rows.length, 3);
  for (const r of rows) assert.match(r, /^<w:tr><w:trPr><w:cantSplit\/>/);
  assert.match(rows[0]!, /<w:trPr><w:cantSplit\/><w:tblHeader\/><\/w:trPr>/);
  assert.equal((xml.match(/<w:tblHeader\/>/g) ?? []).length, 1);
  // 表头各格与第一行数据同页：行不拆后，表头曾独自留在页末、数据从下一页开始（Word 实开）
  assert.equal((rows[0]!.match(/<w:keepNext\/>/g) ?? []).length, 6);
  for (const r of rows.slice(1)) assert.doesNotMatch(r, /keepNext/);
});

test("第 33 批：“此致”与下一行受文机关同页（keepNext）；正文里含“此致”二字的句子与落款不受影响", () => {
  const xml = docXml(PLEADING);
  assert.match(paraOf(xml, "此致"), /<w:pStyle w:val="KwlBody"\/><w:keepNext\/>/);
  for (const other of ["嘉兴市南湖区人民法院", "原告已履行供货义务，特此致函被告催告付款未果。", "附：本诉状副本1份；证据目录及证据【待填】份。"]) assert.doesNotMatch(paraOf(xml, other), /keepNext/);
  assert.equal((xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, "").match(/<w:keepNext\/>/g) ?? []).length, 1, "表格以外只有“此致”一段");
  // 落款仍右对齐（附页表格之前）
  assert.match(paraOf(xml, "具状人：浙江衡川新材料有限公司（盖章）"), /KwlRight/);
});

test("第 33 批：Markdown 转 Word 时“此致”同样与下一行同页；写成“此 致”“此致：”也认", () => {
  for (const salute of ["此致", "此 致", "此致："]) {
    const xml = docXml(createStyledDocx(markdownToBlocks(`# 律师函\n\n请于七日内付款。\n\n${salute}\n\n安徽鼎硕包装制品有限公司\n\n某某律师事务所（盖章）`)));
    assert.match(paraOf(xml, salute), /<w:keepNext\/>/, salute);
    assert.doesNotMatch(paraOf(xml, "安徽鼎硕包装制品有限公司"), /keepNext/);
  }
});
