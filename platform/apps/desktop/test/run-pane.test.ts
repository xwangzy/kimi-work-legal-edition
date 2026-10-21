/**
 * Z3 #11 执行页右栏：标签不超过 4 个；没有成果时收起，出现首份成果或审查意见、引用核验后展开；律师点开后不再自动收起。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rightCollapsed, rightTabs } from "../src/lib/run-pane.ts";

test("#11 右栏标签至多 4 个，“文件历史”“记录”不再单列", () => {
  const all = rightTabs({ hasRisk: true, intercepted: 2 });
  assert.equal(all.length, 4);
  assert.deepEqual(all.map(([, l]) => l), ["审查摘要", "成果", "引用 · 2 条无法核实", "数据去向"]);
  assert.deepEqual(rightTabs({ hasRisk: false, intercepted: 0 }).map(([k]) => k), ["artifact", "citations", "egress"]);
  const src = readFileSync(join(import.meta.dirname, "..", "src", "pages", "RunView.tsx"), "utf8");
  assert.doesNotMatch(src, /"文件历史"|\["record", "记录"\]/);
});

test("#11 收起条件", () => {
  const base = { artifactsLoaded: true, artifactCount: 0, hasRisk: false, hasCitations: false, userExpanded: false };
  assert.equal(rightCollapsed(base), true, "没有成果：收起");
  assert.equal(rightCollapsed({ ...base, artifactsLoaded: false }), false, "还在读取：不收，免得闪");
  assert.equal(rightCollapsed({ ...base, artifactCount: 1 }), false, "首份成果出现：自动展开");
  assert.equal(rightCollapsed({ ...base, hasRisk: true }), false);
  assert.equal(rightCollapsed({ ...base, hasCitations: true }), false);
  assert.equal(rightCollapsed({ ...base, userExpanded: true }), false, "律师点开后不再自动收起");
});
