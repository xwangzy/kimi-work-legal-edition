/**
 * 第 62 批（线上验收发现）：价目生效前按售价定价、没有成本价的行，若算进毛利，毛利率会被高估（线上 v1.1.0 首屏显示 51%）。
 * 汇总另给“有成本价的行的售价合计”（costed_value），控制台毛利 = costed_value − 成本。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { addAgg, emptyAgg, rowAgg } from "../src/usage-ledger.ts";

const row = (value: number | null, cost: number | null) => ({ usage: { input: 100, cached: 0, output: 10 }, value_micro: value, cost_micro: cost, outcome: "ok", usage_source: "upstream" }) as any;

test("有成本的行计入 costed_value，没有成本的行只计入 value、不计入 costed_value 与毛利", () => {
  const a = addAgg(addAgg(emptyAgg(), rowAgg(row(1_000_000, 500_000))), rowAgg(row(2_000_000, null)));
  assert.equal(a.value_micro, 3_000_000);
  assert.equal(a.cost_micro, 500_000);
  assert.equal(a.costed_value_micro, 1_000_000);
  assert.equal(a.uncosted, 1);
  // 毛利率按有成本的行：(1.0 − 0.5) / 1.0 = 50%，而不是 (3.0 − 0.5) / 3.0 ≈ 83%
  assert.equal((a.costed_value_micro! - a.cost_micro) / a.costed_value_micro!, 0.5);
});
