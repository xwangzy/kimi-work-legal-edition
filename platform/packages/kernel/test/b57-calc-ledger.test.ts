/**
 * calc.ledger 债权台账（第 57 批，D-228）：分段计息、还款抵充、加倍部分债务利息、上限与勾稽。
 * 用例里的数字取自第 56 批十三卡真实验收的评分报告（金额测算、答辩状、强制执行三张卡被判错的地方），手算可复核。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { calcLedger } from "../src/tools/tools/ledger.ts";
import { calcInterest } from "../src/tools/tools/calc.ts";

const DAILY5 = { kind: "daily", per_10k: 5 } as const;
const PAYS = [
  { date: "2025-12-26", amount_yuan: 300_000 },
  { date: "2026-03-10", amount_yuan: 200_000 },
];

test("付款只冲本金（对账口径）：三段违约金 8,910 + 18,870 + 41,230 = 69,010，本金余额 310,000", () => {
  const r = calcLedger({ name: "口径一", as_of: "2026-11-30", debts: [{ label: "验收款", amount_yuan: 810_000, accrue_from: "2025-12-04" }], payments: PAYS, rate: DAILY5, allocation: "principal_only" });
  assert.deepEqual(r.segments.map((s) => [s.from, s.to, s.days, s.base_yuan, s.amount_yuan]), [
    ["2025-12-04", "2025-12-25", 22, 810_000, 8_910],
    ["2025-12-26", "2026-03-09", 74, 510_000, 18_870],
    ["2026-03-10", "2026-11-30", 266, 310_000, 41_230],
  ]);
  assert.equal(r.totals.interest_accrued_yuan, 69_010);
  assert.equal(r.totals.interest_outstanding_yuan, 69_010, "只冲本金：违约金不因付款减少");
  assert.equal(r.totals.principal_outstanding_yuan, 310_000);
  assert.equal(r.totals.total_outstanding_yuan, 379_010);
  assert.match(r.summary, /合计 379,010\.00 元/);
});

test("先冲违约金后冲本金（法定顺序）：已冲的违约金不再计入未清金额——余本金 338,109.67、未付违约金 44,968.59、合计 383,078.26", () => {
  const r = calcLedger({ name: "口径二", as_of: "2026-11-30", debts: [{ label: "验收款", amount_yuan: 810_000, accrue_from: "2025-12-04" }], payments: PAYS, rate: DAILY5 });
  assert.deepEqual(r.segments.map((s) => [s.days, s.base_yuan, s.amount_yuan]), [
    [22, 810_000, 8_910],
    [74, 518_910, 19_199.67],
    [266, 338_109.67, 44_968.59],
  ]);
  assert.deepEqual(r.payments.map((x) => [x.to_interest_yuan, x.to_principal_yuan, x.principal_after_yuan, x.interest_unpaid_after_yuan]), [
    [8_910, 291_090, 518_910, 0],
    [19_199.67, 180_800.33, 338_109.67, 0],
  ]);
  assert.equal(r.totals.interest_accrued_yuan, 73_078.26);
  assert.equal(r.totals.interest_paid_yuan, 28_109.67);
  assert.equal(r.totals.interest_outstanding_yuan, 44_968.59);
  assert.equal(r.totals.total_outstanding_yuan, 383_078.26, "第 56 批真实运行里这一口径被写成 411,187.93（把已冲的 28,109.67 又加了一遍）");
});

test("第二笔债务（质保金）有自己的到期日：最后履行日的次日起算；尚未到期的不计息但计入本金", () => {
  const debts = [
    { label: "验收款", amount_yuan: 810_000, accrue_from: "2025-12-04" },
    { label: "质保金", amount_yuan: 135_000, due_date: "2026-11-13" },
  ];
  const r = calcLedger({ as_of: "2026-11-30", debts, payments: PAYS, rate: DAILY5, allocation: "principal_only" });
  const q = r.segments.filter((s) => s.item === "质保金");
  assert.deepEqual(q.map((s) => [s.from, s.to, s.days, s.amount_yuan]), [["2026-11-14", "2026-11-30", 17, 1_147.5]]);
  assert.equal(r.totals.principal_outstanding_yuan, 445_000);
  assert.equal(r.totals.total_outstanding_yuan, 445_000 + 69_010 + 1_147.5);
  // 质保期顺延的口径：到期日晚于截止日，利息为 0，并给出提示
  const later = calcLedger({ as_of: "2026-11-30", debts: [debts[0]!, { label: "质保金", amount_yuan: 135_000, due_date: "2027-01-12" }], payments: PAYS, rate: DAILY5, allocation: "principal_only" });
  assert.equal(later.segments.filter((s) => s.item === "质保金").length, 0);
  assert.ok(later.warnings.some((w) => w.includes("质保金") && w.includes("尚未起算")), later.warnings.join("|"));
});

test("截止日含当日、最后履行日的次日起算：与 calc.interest（算头不算尾）逐分一致", () => {
  const r = calcLedger({ as_of: "2026-11-09", debts: [{ label: "货款", amount_yuan: 310_000, accrue_from: "2026-03-10" }], rate: DAILY5 });
  assert.equal(r.segments[0]!.days, 245);
  assert.equal(r.totals.interest_accrued_yuan, 37_975);
  const old = calcInterest({ principal_yuan: 310_000, start_date: "2026-03-10", end_date: "2026-11-10", rate: { kind: "fixed", annual_pct: 18.25 }, year_days: 365 });
  assert.equal(old.total_interest_yuan, r.totals.interest_accrued_yuan);
  // 反诉违约金三段：8,910 + 18,870 + 37,975 = 65,755（真实运行里从首日按 31 万元计，只有 52,855）
  const three = calcLedger({ as_of: "2026-11-09", debts: [{ label: "货款", amount_yuan: 810_000, accrue_from: "2025-12-04" }], payments: PAYS, rate: DAILY5, allocation: "principal_only" });
  assert.equal(three.totals.interest_accrued_yuan, 65_755);
});

test("付款当日计入的口径：付款当日仍按付款前余额计", () => {
  const a = calcLedger({ as_of: "2026-01-31", debts: [{ label: "货款", amount_yuan: 100_000, accrue_from: "2026-01-01" }], payments: [{ date: "2026-01-11", amount_yuan: 50_000 }], rate: DAILY5, allocation: "principal_only" });
  assert.deepEqual(a.segments.map((s) => [s.days, s.base_yuan]), [[10, 100_000], [21, 50_000]]);
  const b = calcLedger({ as_of: "2026-01-31", debts: [{ label: "货款", amount_yuan: 100_000, accrue_from: "2026-01-01" }], payments: [{ date: "2026-01-11", amount_yuan: 50_000 }], rate: DAILY5, allocation: "principal_only", payment_day: "counted" });
  assert.deepEqual(b.segments.map((s) => [s.days, s.base_yuan]), [[11, 100_000], [20, 50_000]]);
});

test("强制执行：履行期最后一日的次日起算加倍部分；付款先冲费用、利息、本金，加倍部分排最后；基数随清偿减少", () => {
  const r = calcLedger({
    name: "执行标的",
    as_of: "2026-11-30",
    debts: [
      { label: "货款本金", amount_yuan: 280_000 },
      { label: "判决确定的违约金", amount_yuan: 30_000, kind: "interest" },
      { label: "案件受理费", amount_yuan: 6_500, kind: "cost" },
    ],
    payments: [
      { date: "2026-03-20", amount_yuan: 80_000 },
      { date: "2026-07-08", amount_yuan: 50_000 },
    ],
    doubled: { due_date: "2026-01-15" },
  });
  const d = r.segments.filter((s) => s.kind === "doubled");
  // 首段自 01-16 起、至 03-19 止：63 天（不是 64 天）
  assert.deepEqual([d[0]!.from, d[0]!.to, d[0]!.days, d[0]!.base_yuan], ["2026-01-16", "2026-03-19", 63, 286_500]);
  assert.equal(d[0]!.amount_yuan, 3_158.66); // 286,500 × 0.000175 × 63 = 3,158.6625
  // 第一笔 8 万：受理费 6,500 → 违约金 30,000 → 本金 43,500
  assert.deepEqual([r.payments[0]!.to_cost_yuan, r.payments[0]!.to_interest_yuan, r.payments[0]!.to_principal_yuan, r.payments[0]!.to_doubled_yuan], [6_500, 30_000, 43_500, 0]);
  assert.equal(d[1]!.base_yuan, 236_500);
  assert.equal(r.payments[1]!.to_principal_yuan, 50_000);
  assert.equal(d[2]!.base_yuan, 186_500);
  assert.equal(r.totals.doubled_paid_yuan, 0, "本金没清完之前不冲加倍部分");
  assert.equal(r.totals.principal_outstanding_yuan, 186_500);
  assert.equal(r.totals.total_outstanding_yuan, 186_500 + r.totals.doubled_outstanding_yuan);
  // 勾稽：付款合计 = 各项抵充之和
  assert.equal(r.totals.payments_total_yuan, r.totals.cost_paid_yuan + r.totals.interest_paid_yuan + r.totals.principal_paid_yuan + r.totals.doubled_paid_yuan + r.totals.unallocated_yuan);
});

test("LPR 倍数按报价日分段，年日数只影响年利率折算；约定上限：超过按上限计，没到的推算到达日", () => {
  const r = calcLedger({ as_of: "2025-06-30", debts: [{ label: "借款", amount_yuan: 1_000_000, accrue_from: "2025-05-01" }], rate: { kind: "lpr_times", multiple: 1.5 } });
  assert.deepEqual(r.segments.map((s) => [s.from, s.to, s.days]), [["2025-05-01", "2025-05-19", 19], ["2025-05-20", "2025-06-30", 42]]);
  assert.equal(r.segments[0]!.amount_yuan, 2_420.55); // 1,000,000 × 4.65% × 19 / 365
  assert.equal(r.segments[1]!.amount_yuan, 5_178.08); // 1,000,000 × 4.5% × 42 / 365
  const capped = calcLedger({ as_of: "2026-11-30", debts: [{ label: "验收款", amount_yuan: 810_000, accrue_from: "2025-12-04" }], rate: DAILY5, cap_yuan: 81_000 });
  assert.equal(capped.cap!.applied, true);
  assert.equal(capped.totals.interest_accrued_yuan, 81_000);
  assert.equal(capped.cap!.reached_on, "2026-06-21"); // 405 元/日，第 200 天
  const open = calcLedger({ as_of: "2026-01-02", debts: [{ label: "验收款", amount_yuan: 810_000, accrue_from: "2025-12-04" }], rate: DAILY5, cap_yuan: 81_000 });
  assert.equal(open.cap!.applied, false);
  assert.equal(open.cap!.projected, true);
  assert.equal(open.cap!.reached_on, "2026-06-21");
});

test("多付、晚于截止日的付款、参数错误：如实提示或拒收", () => {
  const over = calcLedger({ as_of: "2026-01-31", debts: [{ label: "货款", amount_yuan: 1_000, accrue_from: "2026-01-01" }], payments: [{ date: "2026-01-11", amount_yuan: 5_000 }, { date: "2026-02-01", amount_yuan: 1 }], rate: DAILY5 });
  assert.equal(over.totals.principal_outstanding_yuan, 0);
  assert.equal(over.totals.unallocated_yuan, 3_995); // 5,000 − 1,000 − 10 天 × 0.5
  assert.equal(over.warnings.length, 2);
  assert.throws(() => calcLedger({ as_of: "2026-01-31", debts: [{ label: "货款", amount_yuan: 1_000.001, accrue_from: "2026-01-01" }], rate: DAILY5 }), /两位小数/);
  assert.throws(() => calcLedger({ as_of: "2026-01-31", debts: [{ label: "货款", amount_yuan: 1_000, accrue_from: "2026-01-01", due_date: "2025-12-31" }], rate: DAILY5 }), /只给一个/);
  assert.throws(() => calcLedger({ as_of: "2026-01-31", debts: [{ label: "货款", amount_yuan: 1_000 }], rate: DAILY5 }), /没有给 due_date 或 accrue_from/);
  assert.throws(() => calcLedger({ as_of: "2026-02-30", debts: [{ label: "货款", amount_yuan: 1_000 }] }), /as_of/);
  assert.throws(() => calcLedger({ as_of: "2026-01-31", debts: [{ label: "a", amount_yuan: 1 }, { label: "a", amount_yuan: 2 }] }), /重复/);
});

// ---- calc.labor 扩展：各月工资由工具求平均；未休年休假工资报酬 ----
import { calcAnnualLeave, calcLabor, wageOf } from "../src/tools/tools/labor.ts";

test("calc.labor：给各月应得工资由工具求平均（418,637.93 ÷ 12 = 34,886.49），与直接给平均数的结果相同", () => {
  // 第 56 批真实运行的工资台账合计 418,637.93 元：模型手算成 421,948.27 / 425,258.61 两个错数
  const months = [34_886.49, 34_886.49, 34_886.49, 34_886.49, 34_886.49, 34_886.49, 34_886.49, 34_886.49, 34_886.49, 34_886.49, 34_886.49, 34_886.54];
  assert.equal(wageOf({ monthly_wages_yuan: months }).wage, 34_886.49);
  const a = calcLabor({ start_date: "2021-03-01", end_date: "2026-09-04", kind: "unlawful", monthly_wages_yuan: months });
  const b = calcLabor({ start_date: "2021-03-01", end_date: "2026-09-04", kind: "unlawful", avg_monthly_wage_yuan: 34_886.49 });
  assert.equal(a.compensation_yuan, b.compensation_yuan);
  assert.equal(a.compensation_yuan, 418_637.88); // 6 × 34,886.49 × 2
  assert.match(a.steps[0]!, /12 个月应得工资合计 418637\.93 元 ÷ 12 = 34886\.49 元/);
  assert.throws(() => calcLabor({ start_date: "2021-03-01", end_date: "2026-09-04", kind: "unlawful", monthly_wages_yuan: months, avg_monthly_wage_yuan: 1 }), /只给一个/);
  assert.throws(() => calcLabor({ start_date: "2021-03-01", end_date: "2026-09-04", kind: "unlawful" }), /avg_monthly_wage_yuan/);
});

test("calc.labor annual_leave：日工资先取到分再乘天数与倍数，算式逐分可复算", () => {
  const r = calcAnnualLeave({ kind: "annual_leave", avg_monthly_wage_yuan: 30_765.81, unused_days: 3 });
  assert.equal(r.daily_wage_yuan, 1_414.52);
  assert.equal(r.compensation_yuan, 8_487.12); // 1,414.52 × 3 × 2
  assert.equal(calcAnnualLeave({ kind: "annual_leave", avg_monthly_wage_yuan: 30_765.81, unused_days: 3, leave_multiple: 3 }).compensation_yuan, 12_730.68);
  assert.throws(() => calcAnnualLeave({ kind: "annual_leave", avg_monthly_wage_yuan: 30_000, unused_days: 0 }), /unused_days/);
});

test("calc.labor wage_table：台账只抄一次，各口径只改“计入哪些项目”——剔除加班费、加回扣款都由工具按同一份台账算，不会加回两次", () => {
  // 仿第二波劳动者应对一单：8 月基本工资 18,000、岗位津贴 6,000、加班费 2,400、旷工扣款 −3,310.34（其余各月略为同数）
  const months = Array.from({ length: 12 }, (_, i) => ({ month: `2025-${String(i + 9).padStart(2, "0")}`.replace(/2025-(1[3-9]|2\d)/, (_m, n) => `2026-${String(Number(n) - 12).padStart(2, "0")}`), items: { 基本工资: 18_000, 岗位津贴: 6_000, 加班费: 2_400 } as Record<string, number> }));
  months[11]!.items["旷工扣款"] = -3_310.34;
  const all = calcLabor({ start_date: "2021-03-01", end_date: "2026-09-04", kind: "unlawful", wage_table: { months, include: ["基本工资", "岗位津贴", "加班费", "旷工扣款"] } });
  const noOt = calcLabor({ start_date: "2021-03-01", end_date: "2026-09-04", kind: "unlawful", wage_table: { months, include: ["基本工资", "岗位津贴", "旷工扣款"] } });
  const noOtAddBack = calcLabor({ start_date: "2021-03-01", end_date: "2026-09-04", kind: "unlawful", wage_table: { months, include: ["基本工资", "岗位津贴"] } });
  // 台账应发：12×26,400 − 3,310.34 = 313,489.66；剔除加班费：288,000 − 3,310.34 = 284,689.66；剔除加班费并加回扣款：288,000（8 月是 24,000，不是 27,310.34）
  assert.match(all.steps[1]!, /合计 313489\.66 元 ÷ 12 = 26124\.14 元/);
  assert.match(noOt.steps[1]!, /合计 284689\.66 元 ÷ 12 = 23724\.14 元/);
  assert.match(noOtAddBack.steps[1]!, /合计 288000 元 ÷ 12 = 24000 元/);
  assert.equal(noOtAddBack.compensation_yuan, 288_000); // 6 × 24,000 × 2
  assert.match(noOtAddBack.steps[0]!, /计入 基本工资、岗位津贴；不计入 加班费、旷工扣款/);
  assert.throws(() => calcLabor({ start_date: "2021-03-01", end_date: "2026-09-04", kind: "unlawful", wage_table: { months, include: ["基本工资", "绩效"] } }), /“绩效”不在台账项目里；台账项目有：基本工资、岗位津贴、加班费、旷工扣款/);
  assert.throws(() => calcLabor({ start_date: "2021-03-01", end_date: "2026-09-04", kind: "unlawful", wage_table: { months, include: ["基本工资"] }, avg_monthly_wage_yuan: 1 }), /只给一个/);
  // 年休假工资同样可以用台账（剔除加班费）
  assert.equal(calcAnnualLeave({ kind: "annual_leave", wage_table: { months, include: ["基本工资", "岗位津贴"] }, unused_days: 3 }).compensation_yuan, 6_620.7); // 24,000 ÷ 21.75 = 1,103.45；× 3 × 2
});
