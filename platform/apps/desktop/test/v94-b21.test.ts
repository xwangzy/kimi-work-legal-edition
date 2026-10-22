/**
 * v9.4 第 21 批界面口径（纯函数）：条件列的“不适用”与计数、事实角标、预览交付包、跨文件审查的关系说法。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { columnApplies, isOpen, tableCounts, whenText, type CellView } from "../src/lib/table-review.ts";
import { factMarksSummary, previewFactMarks } from "../src/lib/citation-review.ts";
import { deliveryPackage, PACKAGE_REASON_TEXT } from "../src/lib/deliverables.ts";
import { RELATION_LABEL } from "../src/lib/risk-ladder.ts";

const cell = (doc: string, col: string, state: CellView["state"], value: string | null = null, lawyer: string | null = null): CellView => ({
  cell_id: `${doc}-${col}`,
  document_version_id: doc,
  col_key: col,
  value,
  quote: null,
  anchor_status: null,
  note: null,
  state,
  lawyer_value: lawyer,
});

test("条件列：与内核同一口径；不适用的格子不计入总数、不算未核", () => {
  const cols = [
    { key: "custom_1", label: "有违约金条款", format: "yesno" as const, hint: "" },
    { key: "custom_2", label: "违约金比例", format: "text" as const, hint: "", when: { column: "custom_1", equals: "是" } },
  ];
  assert.equal(columnApplies(cols[1]!, cell("a", "custom_1", "ai", "是")), "yes");
  assert.equal(columnApplies(cols[1]!, cell("a", "custom_1", "verified", "否")), "no");
  assert.equal(columnApplies(cols[1]!, cell("a", "custom_1", "edited", "否", "是")), "yes", "律师改过的值优先");
  assert.equal(columnApplies(cols[1]!, cell("a", "custom_1", "not_found")), "no");
  assert.equal(columnApplies(cols[1]!, undefined), "pending");
  assert.equal(whenText(cols[1]!, cols), "只在“有违约金条款”为“是”时填");
  assert.equal(whenText(cols[0]!, cols), "");
  const cells = [cell("a", "custom_1", "verified", "是"), cell("a", "custom_2", "ai", "日万分之五"), cell("b", "custom_1", "verified", "否")];
  const c = tableCounts({ columns: cols, document_version_ids: ["a", "b"] }, cells);
  assert.deepEqual(c, { total: 3, done: 2, conflict: 0, quoteMissing: 0, empty: 0, na: 1 }, "b 的违约金比例不适用：不算还没填");
  assert.equal(isOpen(undefined), true);
});

test("事实角标：已确认 / 未确认的说法与颜色；悬停写事实与出处；汇总一行", () => {
  const marks = previewFactMarks([
    { raw: "2026 年 3 月 1 日", nth: 1, status: "confirmed", facts: [{ fact_id: "f1", statement: "买方签收全部货物", status: "confirmed", filename: "签收单.pdf", quote: "买方于 2026 年 3 月 1 日签收全部货物。" }] },
    { raw: "2026 年 4 月 2 日", nth: 1, status: "proposed", facts: [{ fact_id: "f2", statement: "卖方催款", status: "proposed", filename: null, quote: null }] },
  ]);
  assert.deepEqual(marks.map((m) => [m.mark, m.tone]), [["已确认", "confirmed"], ["未确认", "orange"]]);
  assert.match(marks[0]!.title, /买方签收全部货物\n  出处《签收单\.pdf》：“买方于/);
  assert.match(marks[1]!.title, /签发前请到事项“事实”里确认[\s\S]*卖方催款（未确认）/);
  assert.equal(factMarksSummary([]), "");
  assert.equal(factMarksSummary([{ raw: "x", nth: 1, status: "confirmed", facts: [] }, { raw: "y", nth: 1, status: "proposed", facts: [] }]), "文中 2 处日期对上事实：已确认 1 · 未确认 1");
  assert.deepEqual(previewFactMarks(undefined), []);
});

test("预览交付包：已签发 + 最新版本 + 对外的才随包；其余写明原因", () => {
  const rows = [
    { artifact_version_id: "a1", kind: "redline", version: 1, audience: "counterparty", status: "approved" },
    { artifact_version_id: "a2", kind: "redline", version: 2, audience: "counterparty", status: "approved" },
    { artifact_version_id: "b1", kind: "opinion", version: 1, audience: "internal", status: "approved" },
    { artifact_version_id: "c1", kind: "letter", version: 1, audience: "client", status: "pending_review" },
    { artifact_version_id: "d1", kind: "memo", version: 1, audience: "client", status: "rejected" },
  ];
  const p = deliveryPackage(rows);
  assert.deepEqual(p.ready.map((r) => r.artifact_version_id), ["a2"]);
  assert.deepEqual(p.held.map((h) => [h.row.artifact_version_id, h.reason]), [["a1", "superseded"], ["b1", "internal"], ["c1", "not_signed"], ["d1", "rejected"]]);
  assert.match(PACKAGE_REASON_TEXT.internal, /内部稿，不随包/);
});

test("跨文件审查：关系的律师说法", () => {
  assert.deepEqual(RELATION_LABEL, { amends: "变更本条的", conflicts: "与本条不一致的", refers: "本条援引的" });
});
