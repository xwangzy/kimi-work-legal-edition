/**
 * 第 65 批（V39，D-280）债权台账拆出“履行期未届满的本金”与“已届满部分合计”：V35 三张卡把未到期质保金混进未清偿合计当起诉标的。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { calcLedger } from "../src/tools/tools/ledger.ts";
import { ledgerWorkbook } from "../src/tools/tools/ledger-table.ts";

const p = {
  name: "按合同约定",
  as_of: "2026-10-30",
  rate: { kind: "daily" as const, per_10k: 5 },
  accrual: "penalty" as const,
  debts: [
    { label: "验收款余额", amount_yuan: 310_000, due_date: "2026-06-30" },
    { label: "质保金", amount_yuan: 135_000, due_date: "2027-03-31" },
  ],
};

test("未届满的质保金单列：合计不变，已届满部分 = 合计 − 未届满本金；摘要与提示写明起诉以已届满部分为准", () => {
  const r = calcLedger(p as any);
  assert.equal(r.totals.principal_not_due_yuan, 135_000);
  assert.equal(r.totals.total_due_outstanding_yuan, Math.round((r.totals.total_outstanding_yuan - 135_000) * 100) / 100);
  assert.match(r.summary, /履行期尚未届满的本金 135,000\.00 元（质保金）/);
  assert.ok(r.warnings.some((w) => /已届满部分/.test(w) && /加速到期/.test(w)));
});

test("全部已届满时不出两段小计，汇总表没有多余的行", () => {
  const r = calcLedger({ ...p, debts: [p.debts[0]!] } as any);
  assert.equal(r.totals.principal_not_due_yuan, 0);
  assert.equal(r.totals.total_due_outstanding_yuan, r.totals.total_outstanding_yuan);
  const wb = ledgerWorkbook([p as any], [r]);
  assert.ok(!wb[0]!.rows.some((row) => row[0] === "已届满部分合计（元）"));
});

test("汇总表：有未届满本金时多出两行，已届满部分合计带公式（未清偿合计 − 未届满本金）", () => {
  const r = calcLedger(p as any);
  const wb = ledgerWorkbook([p as any], [r]);
  const sum = wb[0]!;
  const i = sum.rows.findIndex((row) => row[0] === "已届满部分合计（元）");
  const t = sum.rows.findIndex((row) => row[0] === "未清偿合计（元）");
  const nd = sum.rows.findIndex((row) => row[0] === "其中：履行期未届满的本金（元）");
  assert.ok(i > 0 && t > 0 && nd > 0);
  assert.equal(sum.formulas![`B${i + 1}`], `B${t + 1}-B${nd + 1}`);
  assert.equal(sum.rows[i]![1], r.totals.total_due_outstanding_yuan);
});
