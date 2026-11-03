/**
 * 第 35 批（文档工程审查 E-01）：交付的 Excel 打印可用——每页重复表头、宽表横向且缩到一页宽、表头带筛选、页脚页码；
 * 元素顺序合乎 CT_Worksheet（sheetPr 在 sheetViews 前；autoFilter、pageMargins、pageSetup、headerFooter 依次在 sheetData 之后）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createXlsx, readZipEntries } from "../src/index.ts";

const order = (xml: string, tags: string[]) => tags.map((t) => xml.indexOf(`<${t}`));

test("宽表横向、缩到一页宽、首行筛选与每页重复表头；窄表纵向", () => {
  const wide = { name: "证据目录", rows: [["序号", "证据名称", "来源", "证明目的", "页码", "原件", "备注"], [1, "购销合同", "原告提供", "买卖关系成立", "1-6", "有", ""], [2, "对账函", "原告提供", "欠款金额", "7", "有", ""]] };
  const narrow = { name: "金额 '测算'", rows: [["项目", "金额（元）"], ["本金", 906400]] };
  const buf = createXlsx([wide, narrow]);
  const z = readZipEntries(buf);
  const s1 = z.get("xl/worksheets/sheet1.xml")!.toString("utf8");
  const s2 = z.get("xl/worksheets/sheet2.xml")!.toString("utf8");
  assert.match(s1, /<pageSetup [^>]*orientation="landscape"[^>]*fitToWidth="1" fitToHeight="0"/);
  assert.match(s2, /orientation="portrait"/);
  assert.match(s1, /<autoFilter ref="A1:G3"\/>/);
  assert.match(s1, /<oddFooter>&amp;C第 &amp;P 页，共 &amp;N 页<\/oddFooter>/);
  const pos = order(s1, ["sheetPr", "sheetViews", "cols", "sheetData", "autoFilter", "pageMargins", "pageSetup", "headerFooter"]);
  assert.deepEqual([...pos].sort((a, b) => a - b), pos, `元素顺序：${pos.join(",")}`);
  assert.ok(pos.every((p) => p > 0));
  const wb = z.get("xl/workbook.xml")!.toString("utf8");
  assert.match(wb, /<\/sheets><definedNames>/, "definedNames 在 sheets 之后");
  assert.ok(wb.includes(`<definedName name="_xlnm.Print_Titles" localSheetId="0">'证据目录'!$1:$1</definedName>`));
  assert.ok(wb.includes(`<definedName name="_xlnm.Print_Titles" localSheetId="1">'金额 ''测算'''!$1:$1</definedName>`), "表名里的单引号按规则重写");
  assert.ok(wb.includes(`<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'证据目录'!$A$1:$G$3</definedName>`));
});

test("只有表头一行的表：不加筛选与打印标题", () => {
  const z = readZipEntries(createXlsx([{ name: "空表", rows: [["序号", "名称"]] }]));
  assert.doesNotMatch(z.get("xl/worksheets/sheet1.xml")!.toString("utf8"), /<autoFilter/);
  assert.doesNotMatch(z.get("xl/workbook.xml")!.toString("utf8"), /<definedNames>/);
});

test("V10：很宽的说明表不再硬缩到一页宽（V9.6 R6 律师评分：打印字太小看不清）——按约 207 个列宽单位一页分几页宽打印，每页重复首行与首列", async () => {
  const { printPagesWide } = await import("../src/xlsx.ts");
  const long = "按投资方立场给出首稿值，对方可能要求放宽，可退让至客户确认的区间，效力与可执行性另行提示".repeat(2);
  const wide = { name: "起草说明", rows: [["条款", "写法要点", "为什么这样写", "对我方的保护", "对方可能的修改", "可退让方向", "效力存疑提示", "依据", "核验状态", "材料来源"], ...Array.from({ length: 5 }, (_, i) => [`第${i + 1}条`, long, long, long, long, long, long, "公司法第十五条", "已核", "条款清单"])] };
  assert.ok(printPagesWide(wide) >= 2, `宽表分几页宽：${printPagesWide(wide)}`);
  const z = readZipEntries(createXlsx([wide]));
  assert.match(z.get("xl/worksheets/sheet1.xml")!.toString("utf8"), new RegExp(`fitToWidth="${printPagesWide(wide)}" fitToHeight="0"`));
  assert.ok(z.get("xl/workbook.xml")!.toString("utf8").includes(`'起草说明'!$A:$A,'起草说明'!$1:$1`), "分页宽时每页重复首列与首行");
});
