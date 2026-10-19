/**
 * 表格材料导入（第 13 批；评审 Z1：选择对话框允许 xlsx/csv，导入却报“不支持的文件类型”）：
 * xlsx 逐表逐行取值成文字（表名、制表符分隔），csv 按纯文本；律师能在事项里读到、Agent 能检索到。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createXlsx, xlsxToText } from "@zr-legal/docx-engine";
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
