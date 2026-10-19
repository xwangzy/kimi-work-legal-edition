/**
 * 表格材料导入（第 13 批；评审 Z1：选择对话框允许 xlsx/csv，导入却报“不支持的文件类型”）：
 * xlsx 逐表逐行取值成文字（表名、制表符分隔），csv 按纯文本；律师能在事项里读到、Agent 能检索到。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createXlsx, writeRawZip, xlsxToText } from "@zr-legal/docx-engine";
import { makeKernel, importBytes, type TestKernel } from "./helpers.ts";

let tk: TestKernel | null = null;
after(async () => {
  await tk?.kernel.close().catch(() => {});
});

test("xlsxToText：表名、共享字符串、数字、空单元格对齐", () => {
  const x = createXlsx([
    { name: "付款记录", rows: [["日期", "金额", "备注"], ["2026-03-01", 300000, null], ["2026-04-01", 200000, "第二期\t含税"]] },
    { name: "合同清单", rows: [["编号", "名称"], ["HT-01", "设备采购合同"]] },
  ]);
  const r = xlsxToText(x);
  assert.equal(r.sheets, 2);
  assert.equal(r.truncated, false);
  const lines = r.text.split("\n");
  assert.equal(lines[0], "【付款记录】");
  assert.equal(lines[1], "日期\t金额\t备注");
  assert.equal(lines[2], "2026-03-01\t300000");
  assert.equal(lines[3], "2026-04-01\t200000\t第二期 含税", "单元格内的制表符与换行折成空格");
  assert.ok(r.text.includes("【合同清单】\n编号\t名称\nHT-01\t设备采购合同"));
});

const W = (s: string) => Buffer.from(s, "utf8");
const NS = `xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;

test("复核 B13-O02：调整过顺序的工作簿按 rels 对上表名；日期格式的数值转成日期", () => {
  // 工作簿里第一个表“汇总”实际存在 sheet2.xml，第二个表“明细”存在 sheet1.xml（Excel 调整表顺序后的常见情形）
  const x = writeRawZip([
    { name: "[Content_Types].xml", data: W(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`) },
    { name: "xl/workbook.xml", data: W(`<workbook ${NS}><sheets><sheet name="汇总" sheetId="2" r:id="rId7"/><sheet name="明细" sheetId="1" r:id="rId3"/></sheets></workbook>`) },
    { name: "xl/_rels/workbook.xml.rels", data: W(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId3" Type="worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId7" Type="worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>`) },
    {
      name: "xl/styles.xml",
      data: W(`<styleSheet ${NS}><numFmts count="1"><numFmt numFmtId="176" formatCode="yyyy&quot;年&quot;m&quot;月&quot;d&quot;日&quot;"/></numFmts><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/><xf numFmtId="176" applyNumberFormat="1"/><xf numFmtId="4"/></cellXfs></styleSheet>`),
    },
    { name: "xl/worksheets/sheet1.xml", data: W(`<worksheet ${NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>明细行</t></is></c><c r="B1" s="1"><v>45000</v></c><c r="C1" s="2"><v>45366</v></c><c r="D1" s="3"><v>300000</v></c></row></sheetData></worksheet>`) },
    { name: "xl/worksheets/sheet2.xml", data: W(`<worksheet ${NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>汇总行</t></is></c></row></sheetData></worksheet>`) },
    { name: "xl/media/image1.png", data: Buffer.alloc(4096, 7) },
  ]);
  const r = xlsxToText(x);
  assert.equal(r.sheets, 2);
  assert.equal(r.text, "【汇总】\n汇总行\n【明细】\n明细行\t2023-03-15\t2024-03-15\t300000", "表名与内容对应；内置日期格式 14 与自定义“年月日”格式都转成日期，普通数字不动");
  assert.equal(r.dates_raw, undefined);
});

test("复核 B13-O01：中央目录声明的解压大小与实际不符（压缩炸弹）即拒收，导入回 422、内核不崩", { timeout: 120_000 }, async () => {
  const big = createXlsx([{ name: "表", rows: [["x".repeat(10)]] }]);
  // 构造一个“声明 1000 字节、实际解压出 4 MB”的条目：改写本地头与中央目录里的解压后大小
  const bomb = writeRawZip([
    { name: "[Content_Types].xml", data: W(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`) },
    { name: "xl/workbook.xml", data: W(`<workbook ${NS}><sheets><sheet name="表" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.alloc(4 * 1024 * 1024, 0x20) },
  ]);
  const name = Buffer.from("xl/worksheets/sheet1.xml");
  for (let i = 0; i + 4 <= bomb.length; i++) {
    const sig = bomb.readUInt32LE(i);
    if (sig === 0x04034b50 && bomb.subarray(i + 30, i + 30 + name.length).equals(name)) bomb.writeUInt32LE(1000, i + 22);
    if (sig === 0x02014b50 && bomb.subarray(i + 46, i + 46 + name.length).equals(name)) bomb.writeUInt32LE(1000, i + 24);
  }
  assert.throws(() => xlsxToText(bomb), (e: any) => e.code === "unsupported_file" && /压缩炸弹/.test(e.message));
  assert.ok(xlsxToText(big).text.includes("xxxxxxxxxx"), "正常表格不受影响");
  const k = await makeKernel({}, "xlsx-bomb-firm");
  try {
    const { matter } = await k.inv("matters.create", { title: "炸弹", stance: "原告", consent_status: "not_required" });
    await assert.rejects(importBytes(k.inv, matter.matter_id, "坏表.xlsx", bomb, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), (e: any) => e.status === 422 || e.code === "unsupported_file");
    assert.ok(await k.inv("matters.list"), "内核仍可响应");
  } finally {
    await k.kernel.close().catch(() => {});
  }
});

test("导入 xlsx 与 csv 材料：解析成功，事项里能读到文字", { timeout: 120_000 }, async () => {
  tk = await makeKernel({}, "xlsx-firm");
  const { inv } = tk;
  const { matter } = await inv("matters.create", { title: "表格材料", stance: "原告", consent_status: "not_required" });
  const x = createXlsx([{ name: "付款", rows: [["日期", "金额"], ["2026-03-01", 300000]] }]);
  const a = await importBytes(inv, matter.matter_id, "付款记录.xlsx", x, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const ta = await inv("materials.text", { document_version_id: a.document_version_id });
  assert.match(JSON.stringify(ta), /2026-03-01/);
  const c = await importBytes(inv, matter.matter_id, "清单.csv", Buffer.from("编号,名称\nHT-01,设备采购合同\n"), "application/vnd.ms-excel");
  const tc = await inv("materials.text", { document_version_id: c.document_version_id });
  assert.match(JSON.stringify(tc), /设备采购合同/);
});
