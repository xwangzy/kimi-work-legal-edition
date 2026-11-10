/**
 * V16 第 41 批：读回本产品写出的表格（xlsx.edit_cells 在已生成的表格上逐格修改的前提）。
 * 真实走查：争点与证据分析的 5 张工作表、97 行的 Excel，交付前检查报了几处用语，只能整份重出（每次 4～5 分钟），前后 4 次撞上 40 分钟时限。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createXlsx, readCreatedXlsx, readZipEntries, writeRawZip, type SheetSpec } from "../src/index.ts";

/** 归一：空串与 null 同视；每行按表头列数补齐。 */
const norm = (specs: SheetSpec[]) =>
  specs.map((s) => {
    const width = s.rows.reduce((n, r) => Math.max(n, r.length), 0);
    return { name: s.name, rows: s.rows.map((r) => Array.from({ length: width }, (_, i) => (r[i] === undefined || r[i] === "" ? null : r[i]))) };
  });

test("往返相等：中文、换行、整数、小数、空格、转义字符、多工作表、带单引号的表名", () => {
  const specs: SheetSpec[] = [
    {
      name: "争点矩阵",
      rows: [
        ["序号", "争点", "我方证据", "金额（元）", "备注"],
        [1, "货款是否已付清", "《对账函》第 2 页\n《付款回单》", 906400, null],
        [2, "违约金是否过高", "", 12345.67, "按“日万分之五”计 <待核> & \"原告\" 主张"],
        [3, null, "事实 12、事实 13", -0.5, ""],
        [],
        [4, "  前后有空格  ", "a&b<c>d\"e'f", 0, "最后一列"],
      ],
    },
    { name: "金额 '测算'", rows: [["项目", "金额（元）"], ["本金", 906400], ["利息", 1234.5]] },
    { name: "只有表头", rows: [["甲", "乙"]] },
  ];
  const back = readCreatedXlsx(createXlsx(specs));
  assert.ok(back, "应能读回");
  assert.deepEqual(norm(back!), norm(specs));
  assert.equal(back![1]!.name, "金额 '测算'");
  assert.equal(back![0]!.rows[2]![4], "按“日万分之五”计 <待核> & \"原告\" 主张");
  assert.equal(typeof back![0]!.rows[1]![3], "number");
  // 第 27 列以后（AA 列）也按列字母定位
  const wide: SheetSpec[] = [{ name: "宽表", rows: [Array.from({ length: 30 }, (_, i) => `列${i + 1}`), Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? null : i))] }];
  assert.deepEqual(norm(readCreatedXlsx(createXlsx(wide))!), norm(wide));
});

test("不是本写入器写的文件返回 null：有 sharedStrings、有公式、不是 zip", () => {
  const base = createXlsx([{ name: "表1", rows: [["a", "b"], ["x", 1]] }]);
  const z = readZipEntries(base);
  const withShared = new Map(z);
  withShared.set("xl/sharedStrings.xml", Buffer.from(`<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"/>`));
  assert.equal(readCreatedXlsx(writeRawZip([...withShared].map(([name, data]) => ({ name, data })))), null);
  const withFormula = new Map(z);
  const sheet = z.get("xl/worksheets/sheet1.xml")!.toString("utf8").replace(/<c r="B2" s="\d+"><v>1<\/v><\/c>/, `<c r="B2"><f>SUM(1,1)</f><v>2</v></c>`);
  withFormula.set("xl/worksheets/sheet1.xml", Buffer.from(sheet));
  assert.equal(readCreatedXlsx(writeRawZip([...withFormula].map(([name, data]) => ({ name, data })))), null);
  const sharedCell = new Map(z);
  sharedCell.set("xl/worksheets/sheet1.xml", Buffer.from(z.get("xl/worksheets/sheet1.xml")!.toString("utf8").replace(/<c r="A2"[^]*?<\/c>/, `<c r="A2" t="s"><v>0</v></c>`)));
  assert.equal(readCreatedXlsx(writeRawZip([...sharedCell].map(([name, data]) => ({ name, data })))), null);
  assert.equal(readCreatedXlsx(Buffer.from("不是表格")), null);
});
