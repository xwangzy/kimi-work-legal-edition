/**
 * v9.4 第 19 批 C-01 材料页“表格审阅”：格子状态的律师说法、显示值（律师改过的用律师的值）、未核口径、表头计数、改值的格式提示；
 * 材料页源码：列表 / 表格审阅切换，“让助手填表”按表格审阅方法、表编号作方法参数发起。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CELL_STATE_TEXT, cellText, formatProblem, isOpen, tableCounts, type CellView } from "../src/lib/table-review.ts";

const cell = (o: Partial<CellView>): CellView => ({ cell_id: "c", document_version_id: "d1", col_key: "amount", value: null, quote: null, anchor_status: null, note: null, state: "ai", lawyer_value: null, ...o });
const plain = (s: string | null) => s ?? "";

test("显示值：已改用律师的值；已核没有值写“确认没有”；没找到与读取差不显示值", () => {
  assert.equal(cellText(cell({ state: "edited", value: "120 万元", lawyer_value: "130 万元" }), plain), "130 万元");
  assert.equal(cellText(cell({ state: "verified", value: null }), plain), "确认没有");
  assert.equal(cellText(cell({ state: "verified", value: "120 万元" }), plain), "120 万元");
  assert.equal(cellText(cell({ state: "not_found" }), plain), "");
  assert.equal(cellText(undefined, plain), "");
  assert.deepEqual(Object.values(CELL_STATE_TEXT), ["待核", "没找到", "读取差", "有冲突", "已核", "已改"]);
});

test("未核与计数：已核、已改不算未核；空格算未核；原文对不上只算 AI 值与冲突", () => {
  assert.equal(isOpen(cell({ state: "verified" })), false);
  assert.equal(isOpen(cell({ state: "conflict" })), true);
  assert.equal(isOpen(undefined), true);
  const t = { columns: [{ key: "a" }, { key: "b" }] as any, document_version_ids: ["d1", "d2"] };
  const c = tableCounts(t, [cell({ state: "verified" }), cell({ state: "ai", anchor_status: "not_found" }), cell({ state: "edited", anchor_status: "not_found" })]);
  assert.deepEqual(c, { total: 4, done: 2, conflict: 0, quoteMissing: 1, empty: 1 });
});

test("改值的格式提示与内核一致", () => {
  assert.equal(formatProblem({ format: "date" }, "2026-03"), null);
  assert.match(formatProblem({ format: "date" }, "2026年3月")!, /2026-03-01/);
  assert.match(formatProblem({ format: "yesno" }, "对")!, /是/);
  assert.match(formatProblem({ format: "choice", options: ["原件", "复印件"] }, "扫描件")!, /原件 \/ 复印件/);
  assert.match(formatProblem({ format: "money" }, "一百万")!, /数字/);
  assert.equal(formatProblem({ format: "text" }, " "), "请填写");
});

test("材料页源码：列表 / 表格审阅切换；填表按表格审阅方法、表编号作方法参数", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/pages/Matter.tsx", import.meta.url)), "utf8");
  assert.match(src, />表格审阅</);
  assert.match(src, /skill: "tabular-review", label: "表格审阅", skillArgs: \{ table_id: t\.table_id \}/);
  const tr = readFileSync(fileURLToPath(new URL("../src/components/TableReview.tsx", import.meta.url)), "utf8");
  assert.match(tr, /撤回（助手可再填）/);
  assert.match(tr, /api\.exportTable\(/);
});
