/**
 * 第 67 批（工作线 E 复核发现，P0）：Excel 写入器给所有小数套 #,##0.00——计算明细里的“利率数值”0.0005（日万分之五）
 * 在 Excel 里显示成 0.00。两位小数以内（金额）照旧 #,##0.00；超过两位小数的用常规格式，按原值显示。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createXlsx } from "../src/xlsx.ts";
import { readZipText } from "../src/zip.ts";
import { renderXlsxHtml } from "../src/render-html.ts";

test("小数格式：0.0005 不再显示成 0.00；金额两位小数照旧千分位两位", () => {
  const buf = createXlsx([{ name: "计算明细", rows: [["项目", "数值"], ["利率数值", 0.0005], ["违约金（元）", 69010.5], ["本金（元）", 310000], ["系数", 1.3], ["比例", 0.125]] }]);
  const xml = readZipText(buf, "xl/worksheets/sheet1.xml")!;
  const style = (ref: string) => /\bs="(\d+)"/.exec(new RegExp(`<c r="${ref}"[^>]*>`).exec(xml)![0])![1];
  assert.equal(style("B2"), "5", "0.0005 用常规格式（s=5）");
  assert.equal(style("B3"), "4", "69010.5 用 #,##0.00");
  assert.equal(style("B4"), "3", "310000 用 #,##0");
  assert.equal(style("B5"), "4", "1.3 两位以内仍是 #,##0.00");
  assert.equal(style("B6"), "5", "0.125 三位小数用常规格式");
  const html = renderXlsxHtml(buf).html;
  assert.match(html, />0\.0005</, "预览与 Excel 一致：显示 0.0005");
  assert.match(html, />69,010\.50</);
  assert.doesNotMatch(html, />0\.00</);
});

test("表格字体西文在前（第 67 批第三轮，独立评审 R2：Mac 上中文字体画西文，合同编号里的连字符看起来像长横线）", () => {
  const html = renderXlsxHtml(createXlsx([{ name: "表", rows: [["编号"], ["RC-XS-2025-118"]] }])).html;
  assert.match(html, /font-family:Calibri,'Segoe UI',BlinkMacSystemFont,'Helvetica Neue',DengXian/);
  assert.match(html, />RC-XS-2025-118</, "原文是半角连字符，照原样输出");
});
