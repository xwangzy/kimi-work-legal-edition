/**
 * V10 第 36 批：docx.edit_draft 改后重做交付前检查时，表格格子不当条款段落——
 * 真实走查 V7（增资协议股权表）里“56.25”“33.75”被当成款号，报 30 条“款号不连续”，还让模型把正确的“2.3”改成“2.7”。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createStyledDocx } from "@zr-legal/docx-engine";
import { sectionsOfDocx } from "../src/tools/tools/edit-draft.ts";
import { checkDeliverable } from "../src/services/deliverable-check.ts";

const cells = (rows: string[][]) => rows.map((r) => r.map((text) => [{ text }]));

test("表格整张收进本节 table，表后文字另起无标题节；格子里的小数不报款号", () => {
  const buf = createStyledDocx([
    { kind: "title", text: "增资协议" },
    { kind: "h1", text: "第一条 定义" },
    { kind: "p", runs: [{ text: "1.1 本协议所称“交割日”指第三条约定之日。" }] },
    { kind: "h1", text: "第二条 本轮增资" },
    { kind: "p", runs: [{ text: "2.1 增资后股权结构如下：" }] },
    { kind: "table", rows: cells([["股东", "出资额（万元）", "持股比例（%）"], ["顾某", "186.00", "56.25"], ["邵某", "54.00", "18.75"]]) },
    { kind: "p", runs: [{ text: "2.2 各方应按第三条缴付。" }] },
    { kind: "h1", text: "第三条 交割" },
    { kind: "p", runs: [{ text: "3.1 交割日为全部先决条件满足之日。" }] },
  ]);
  const s = sectionsOfDocx(buf);
  assert.deepEqual(s.sections.map((x) => x.heading), ["第一条 定义", "第二条 本轮增资", "", "第三条 交割"]);
  assert.deepEqual(s.sections[1]!.table, { columns: ["股东", "出资额（万元）", "持股比例（%）"], rows: [["顾某", "186.00", "56.25"], ["邵某", "54.00", "18.75"]] });
  assert.deepEqual(s.sections[2]!.paragraphs, ["2.2 各方应按第三条缴付。"]);

  const r = checkDeliverable(s.title, s.sections);
  assert.deepEqual(r.issues.filter((i) => i.kind === "numbering" || i.kind === "cross_ref"), [], JSON.stringify(r.issues));
});

test("表后款号写错照样查得出；格子里的内部用语照样查得出", () => {
  const buf = createStyledDocx([
    { kind: "title", text: "增资协议" },
    { kind: "h1", text: "第一条 定义" },
    { kind: "p", runs: [{ text: "1.1 定义见下表：" }] },
    { kind: "table", rows: cells([["术语", "含义"], ["ARR", "见 docv_0123456789ab 的口径"]]) },
    { kind: "p", runs: [{ text: "1.3 其他术语按上下文理解。" }] },
    { kind: "h1", text: "第二条 增资" },
    { kind: "h1", text: "第三条 交割" },
  ]);
  const r = checkDeliverable("增资协议", sectionsOfDocx(buf).sections);
  assert.ok(r.issues.some((i) => i.kind === "numbering" && /应为 1\.2/.test(i.fix)), JSON.stringify(r.issues));
  assert.ok(r.issues.some((i) => i.kind === "internal_term" && /表格第 1 行/.test(i.where)), JSON.stringify(r.issues));
});
