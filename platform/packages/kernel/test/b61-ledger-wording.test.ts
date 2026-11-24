/**
 * 第 61 批（V35）真实验收 m08-appeal 评分：计算表里出现参数名（accrual、interest）与“（本金）（本金）”。
 * 两处都是内核写进表的：推断违约金的提示随表交付却带着参数名；款项名自带“（本金）”时又追加一次。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { calcLedger } from "../src/tools/tools/ledger.ts";
import { ledgerWorkbook } from "../src/tools/tools/ledger-table.ts";

test("推断为违约金的提示用律师的话，不带参数名；款项名自带括注不重复", () => {
  const p = { as_of: "2026-11-09", debts: [{ label: "货款（本金）", amount_yuan: 228000, due_date: "2024-10-14" }, { label: "逾期付款违约金", amount_yuan: 228000, due_date: "2024-10-14", rate: { kind: "daily", per_10k: 5 } }], rate: { kind: "none" } } as any;
  const r = calcLedger(p);
  const all = JSON.stringify(r);
  assert.doesNotMatch(all, /accrual|"interest"/, "warnings 不带参数名");
  assert.match(all, /按款项名称计为违约金/);
  const wb = JSON.stringify(ledgerWorkbook([p], [r]));
  assert.doesNotMatch(wb, /（本金）（本金）/);
  assert.doesNotMatch(wb, /accrual/);
});
