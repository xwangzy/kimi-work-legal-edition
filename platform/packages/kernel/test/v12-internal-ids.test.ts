/** V12 真实走查用例 6：表格里的 fct_… 事实编号等内部编号没被交付前检查发现（原规则只认 docv/artv/run 等少数前缀）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDeliverable } from "../src/services/deliverable-check.ts";

test("事实、风险卡、论点、审阅表等内部编号都报出；时间线序号不报", () => {
  const r = checkDeliverable("案卷总目录", [{ heading: "案卷目录", table: { columns: ["卷内序号", "关联事实编号"], rows: [["B-01", "fct_3f2a9c1e-77aa-4b2c-9d10-aa00bb11cc22"], ["B-02", "rkc_9a8b7c6d5e4f"], ["B-03", "T03、T17"]] } }]);
  const hits = r.issues.filter((i) => i.kind === "internal_term").map((i) => i.text);
  assert.ok(hits.some((t) => t.includes("fct_")), JSON.stringify(r.issues));
  assert.ok(hits.some((t) => t.includes("rkc_")));
  assert.ok(!hits.some((t) => t.includes("T03")));
});
