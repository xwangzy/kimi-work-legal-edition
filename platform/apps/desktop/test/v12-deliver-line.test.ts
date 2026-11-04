/**
 * V12 D11：发起确认里的“交付”一行。改前确认卡上没有这一行：律师写了“出 Word”，看不到会交什么，交错了只能事后发现。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deliverSheetLine } from "../src/lib/deliverables.ts";

test("场景卡方法的主交付物写成文书名；律师点名的格式、不要的格式一并写出", () => {
  assert.equal(deliverSheetLine({ agent: true, deliverables: ["合同草稿.docx"], req: { formats: [], not: [], document: "draft" } }), "《合同草稿》（Word）——没交出会记“部分完成”");
  assert.equal(deliverSheetLine({ agent: true, deliverables: ["变更清单.xlsx", "Word 文书.docx"], req: { formats: ["docx"], not: [], document: null } }), "《变更清单》（Excel）；Word 文书——没交出会记“部分完成”");
  assert.equal(deliverSheetLine({ agent: true, deliverables: ["Word 文书.docx"], req: { formats: [], not: ["xlsx"], document: "draft" } }), "Word 文书（不要 Excel）——没交出会记“部分完成”");
  assert.equal(deliverSheetLine({ agent: true, deliverables: ["Word 文书.docx"], req: { formats: [], not: [], document: "revise" } }), "在原件上的修订稿与清洁稿（Word）——没交出会记“部分完成”");
  assert.match(deliverSheetLine({ agent: true, deliverables: ["Word 文书.docx"], req: { formats: ["pdf"], not: [], document: null } })!, /PDF 在定稿后从成果导出/);
});

test("没指定时如实写“未指定”；非 AI 任务不显示", () => {
  assert.equal(deliverSheetLine({ agent: true, deliverables: [], req: null }), "未指定：按任务需要（要 Word 或 Excel 请在说明里写明）");
  assert.equal(deliverSheetLine({ agent: false, deliverables: ["合同草稿.docx"] }), null);
});
