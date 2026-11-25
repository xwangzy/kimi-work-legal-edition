/**
 * 第 65 批（V39，D-279）诉讼成本与回收测算：情景并列、不给概率；费用按《诉讼费用交纳办法》（法规库原文第十三、十五、十六、十七、二十、二十九、三十一、三十八条）。
 * 金额全部手算对照：445,000 元请求的受理费 = 50 + 90,000×2.5% + 100,000×2% + 245,000×1.5% = 7,975 元。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { calcLitigationBudget, litigationBudgetWorkbook } from "../src/tools/tools/litigation-budget.ts";
import { findTool, validateParams } from "../src/tools/registry.ts";
import { LEGAL_MCP_TOOLS } from "@zr-legal/domain";

const claims = [
  { label: "货款本金", amount_yuan: 310_000 },
  { label: "质保金", amount_yuan: 135_000 },
];

test("原告：全部支持时受理费随判决收回，净回收 = 请求金额 − 律师费；全部驳回时净额为负", () => {
  const r = calcLitigationBudget({ side: "plaintiff", claims, costs: [{ label: "一审律师费", amount_yuan: 30_000, incurred: true }] });
  assert.equal(r.total_claim_yuan, 445_000);
  const fee = r.fees.find((f) => f.item === "一审案件受理费")!;
  assert.equal(fee.amount_yuan, 7_975);
  const full = r.scenarios.find((s) => s.scenario === "全部支持")!;
  assert.equal(full.fee_borne_by_counterparty_yuan, 7_975);
  assert.equal(full.judgment_yuan, 452_975);
  assert.equal(full.our_costs_yuan, 37_975);
  assert.equal(full.net_yuan, 415_000);
  const none = r.scenarios.find((s) => s.scenario === "全部驳回")!;
  assert.equal(none.net_yuan, -37_975);
  assert.ok(r.assumptions.some((a) => /不是胜诉概率/.test(a)));
  assert.ok(r.basis.some((b) => /第二十九条/.test(b)));
});

test("逐项支持：只支持本金时受理费按支持比例分担，回收比例并列", () => {
  const r = calcLitigationBudget({
    side: "plaintiff",
    claims,
    simple_procedure: false,
    costs: [{ label: "律师费", amount_yuan: 30_000 }],
    scenarios: [{ label: "只支持本金", items: { 货款本金: 1 } }],
    collection: [1, 0.5],
  });
  assert.equal(r.scenarios.length, 2);
  const [a, b] = r.scenarios;
  const ratio = 310_000 / 445_000;
  assert.equal(a!.supported_yuan, 310_000);
  assert.equal(a!.fee_borne_by_counterparty_yuan, Math.round(7_975 * ratio * 100) / 100);
  assert.equal(a!.collection_ratio, 1);
  assert.equal(b!.collection_ratio, 0.5);
  assert.equal(b!.collected_yuan, Math.round(a!.judgment_yuan * 0.5 * 100) / 100);
  assert.equal(a!.net_yuan, Math.round((a!.judgment_yuan - 7_975 - 30_000) * 100) / 100);
});

test("简易程序受理费减半；保全申请费与担保费计入原告成本；列入请求的保全费按比例收回", () => {
  const r = calcLitigationBudget({ side: "plaintiff", claims, simple_procedure: true, preservation: { amount_yuan: 445_000, guarantee_fee_yuan: 890, fee_in_claims: true }, costs: [{ label: "律师费", amount_yuan: 30_000 }] });
  assert.equal(r.fees[0]!.amount_yuan, 3_987.5);
  const pres = r.fees.find((f) => f.item === "财产保全申请费")!;
  // 1,000 元以下 30 元 + 99,000×1% + 345,000×0.5% = 30 + 990 + 1,725 = 2,745
  assert.equal(pres.amount_yuan, 2_745);
  const full = r.scenarios[0]!;
  assert.equal(full.judgment_yuan, 445_000 + 3_987.5 + 2_745);
  assert.equal(full.our_costs_yuan, 3_987.5 + 2_745 + 890 + 30_000);
});

test("二审：原告就未获支持部分上诉，按上诉请求数额算二审受理费；没有不利部分的情景不上诉", () => {
  const r = calcLitigationBudget({ side: "plaintiff", claims, appeal: true, scenarios: [{ label: "只支持本金", items: { 货款本金: 1 } }, { label: "全部支持", support: 1 }], costs: [{ label: "律师费", amount_yuan: 30_000 }, { label: "二审律师费", amount_yuan: 20_000, stage: "appeal" }] });
  const part = r.scenarios.find((s) => s.scenario === "只支持本金")!;
  // 135,000 上诉：50 + 90,000×2.5% + 35,000×2% = 50 + 2,250 + 700 = 3,000
  assert.ok(part.notes.some((n) => /二审受理费 3,000\.00 元/.test(n)));
  assert.equal(part.our_costs_yuan, 7_975 + 30_000 + 20_000 + 3_000);
  const full = r.scenarios.find((s) => s.scenario === "全部支持")!;
  assert.ok(full.notes.some((n) => /不上诉/.test(n)));
});

test("和解：未立案时和解只扣已发生成本；持平点 = 情景净回收 + 和解仍要承担的成本", () => {
  const r = calcLitigationBudget({ side: "plaintiff", claims, costs: [{ label: "律师费", amount_yuan: 30_000, incurred: true }], settlement_offers: [380_000] });
  assert.equal(r.settlement[0]!.net_yuan, 350_000);
  const vsFull = r.settlement[0]!.versus.find((v) => v.scenario === "全部支持")!;
  assert.equal(vsFull.diff_yuan, 350_000 - 415_000);
  const be = r.break_even.find((b) => b.scenario === "全部支持")!;
  assert.equal(be.settlement_yuan, 445_000);
  const be0 = r.break_even.find((b) => b.scenario === "全部驳回")!;
  assert.equal(be0.settlement_yuan, -37_975 + 30_000);
});

test("和解：已立案的，撤诉或调解受理费减半按我方负担测算，保全费与担保费已发生", () => {
  const r = calcLitigationBudget({ side: "plaintiff", claims, filed: true, preservation: { amount_yuan: 445_000, guarantee_fee_yuan: 890 }, costs: [{ label: "律师费", amount_yuan: 30_000, incurred: true }], settlement_offers: [400_000] });
  const cost = 7_975 / 2 + 2_745 + 890 + 30_000;
  assert.equal(r.settlement[0]!.net_yuan, Math.round((400_000 - cost) * 100) / 100);
  assert.ok(r.basis.some((b) => /第十五条/.test(b)) && r.basis.some((b) => /第三十一条/.test(b)));
});

test("被告：总支出 = 判决应付 + 我方负担的受理费 + 我方费用；被强制执行另加申请执行费", () => {
  const r = calcLitigationBudget({ side: "defendant", claims, forced_enforcement: true, costs: [{ label: "律师费", amount_yuan: 25_000 }], scenarios: [{ label: "全部支持", support: 1 }, { label: "只支持本金", items: { 货款本金: 1 } }, { label: "全部驳回", support: 0 }], settlement_offers: [200_000] });
  const full = r.scenarios[0]!;
  // 445,000 执行：50 + 435,000×1.5% = 6,575
  assert.equal(full.judgment_yuan, 445_000 + 7_975 + 6_575);
  assert.equal(full.net_yuan, -(445_000 + 7_975 + 6_575 + 25_000));
  const none = r.scenarios[2]!;
  assert.equal(none.fee_borne_by_us_yuan, 0);
  assert.equal(none.net_yuan, -25_000);
  assert.equal(r.settlement[0]!.net_yuan, -200_000);
  assert.equal(r.break_even[0]!.settlement_yuan, 445_000 + 7_975 + 6_575 + 25_000);
});

test("仲裁：仲裁费由律师给，没给的按 0 计并提示；校验错误写清改法", () => {
  const r = calcLitigationBudget({ side: "plaintiff", forum: "arbitration", claims });
  assert.ok(r.warnings.some((w) => /仲裁机构的费用表/.test(w)));
  assert.ok(r.warnings.some((w) => /没有给我方律师费/.test(w)));
  assert.throws(() => calcLitigationBudget({ side: "plaintiff", claims, scenarios: [{ label: "x", items: { 货款: 1 } }] }), /不是 claims 里的项目名/);
  assert.throws(() => calcLitigationBudget({ side: "plaintiff", claims, scenarios: [{ label: "x", support: 60 }] }), /0～1/);
  assert.throws(() => calcLitigationBudget({ side: "plaintiff", claims, scenarios: [{ label: "x", support: 1, items: {} }] }), /只给一个/);
  assert.throws(() => calcLitigationBudget({ side: "defendant", claims, preservation: { amount_yuan: 1 } }), /只用于原告/);
});

test("成表：情景测算主表带公式，另有请求与支持比例、费用明细、和解持平点、口径与假设", () => {
  const p = { side: "plaintiff" as const, claims, costs: [{ label: "律师费", amount_yuan: 30_000 }], contingency_rate: 0.1, settlement_offers: [380_000], collection: [1, 0.5] };
  const r = calcLitigationBudget(p);
  const wb = litigationBudgetWorkbook(p, r);
  assert.deepEqual(wb.map((s) => s.name), ["情景测算", "请求与支持比例", "费用明细", "和解持平点", "和解方案比较", "口径与假设"]);
  const main = wb[0]!;
  assert.equal(main.formulas!["I2"], "ROUND(F2-G2-H2,2)");
  assert.equal(main.formulas!["H2"], "ROUND(B2*D2*0.1,2)");
  // 风险代理费按收回的请求金额计
  const s = r.scenarios[0]!;
  assert.equal(s.contingency_fee_yuan, 44_500);
  assert.equal(main.rows[1]![8], s.net_yuan);
});

test("登记为法律工具：名称在清单里，参数按 schema 校验", () => {
  assert.ok((LEGAL_MCP_TOOLS as readonly string[]).includes("calc.litigation_budget"));
  const t = findTool("calc.litigation_budget")!;
  assert.equal(t.sideEffect, "read");
  validateParams(t.inputSchema, { side: "plaintiff", claims, scenarios: [{ label: "只支持本金", items: { 货款本金: 1 } }], collection: [1, 0.5] });
  assert.throws(() => validateParams(t.inputSchema, { side: "plaintiff", claims, probability: 0.7 }));
});

test("工具清单锁里有这一项，实现与锁一致（schema、版本、副作用）", async () => {
  const { legalToolLockProblems } = await import("../src/tools/registry.ts");
  assert.equal(legalToolLockProblems().has("calc.litigation_budget"), false, String(legalToolLockProblems().get("calc.litigation_budget")));
});

test("未届满的请求（v39-B1 真实验收）：不进本次诉讼的受理费与情景；一揽子和解按“现在起诉 + 到期后另行收回”比较，比较方向随之改变", () => {
  const p = {
    side: "plaintiff" as const,
    claims: [{ label: "验收款", amount_yuan: 310_000 }, { label: "质保金", amount_yuan: 135_000, not_yet_due: true, due_on: "2026-12-14" }],
    scenarios: [{ label: "全部支持", support: 1 }, { label: "全部驳回", support: 0 }],
    costs: [{ label: "律师费", amount_yuan: 30_000 }],
    settlement_offers: [280_000],
  };
  const r = calcLitigationBudget(p);
  assert.equal(r.total_claim_yuan, 310_000, "受理费只按本次诉讼的请求");
  assert.deepEqual(r.not_due.map((x) => x.label), ["质保金"]);
  // 310,000 受理费 = 50 + 2,250 + 2,000 + 110,000×1.5% = 5,950
  assert.equal(r.fees[0]!.amount_yuan, 5_950);
  const full = r.scenarios[0]!;
  assert.equal(full.net_yuan, 310_000 - 30_000);
  // 和解 28 万一并了结质保金：与“现在起诉全额 28 万 + 到期另收 13.5 万 = 41.5 万”比，少得 13.5 万
  const vs = r.settlement[0]!.versus.find((v) => v.scenario === "全部支持")!;
  assert.equal(vs.diff_yuan, 280_000 - (280_000 + 135_000));
  assert.equal(r.break_even[0]!.settlement_yuan, 280_000 + 135_000);
  assert.ok(r.assumptions.some((a) => /尚未届满的请求/.test(a) && /2026-12-14/.test(a)));
  // 和解不含未届满项的，按原口径比较
  const r2 = calcLitigationBudget({ ...p, settlement_covers_not_due: false });
  assert.equal(r2.settlement[0]!.versus.find((v) => v.scenario === "全部支持")!.diff_yuan, 0);
  const wb = litigationBudgetWorkbook(p, r);
  assert.ok(wb[1]!.rows.some((row) => /质保金（履行期未届满，2026-12-14 到期/.test(String(row[0]))));
  assert.throws(() => calcLitigationBudget({ ...p, claims: [{ label: "质保金", amount_yuan: 1, not_yet_due: true }] }), /全部是未届满/);
});

test("和解持平点为 0 时写明“任何金额的和解都不比该情景少付”；方案比较的列名写明负数含义", () => {
  const p = { side: "defendant" as const, claims, filed: true, costs: [{ label: "律师费", amount_yuan: 40_000, incurred: true }], settlement_offers: [150_000] };
  const r = calcLitigationBudget(p);
  const none = r.break_even.find((b) => b.scenario === "全部驳回")!;
  assert.equal(none.settlement_yuan, 0);
  assert.match(none.steps[0]!, /任何金额的和解都不比该情景少付/);
  const wb = litigationBudgetWorkbook(p, r);
  const cmp = wb.find((s) => s.name === "和解方案比较")!;
  assert.ok(cmp.rows[0]!.some((c) => /负数为多付/.test(String(c))));
});

test("未届满项到期后另行收回的部分随情景的认定：统一比例的按同一比例（全部驳回为 0），逐项写了的按所写", () => {
  const p = {
    side: "plaintiff" as const,
    claims: [{ label: "验收款", amount_yuan: 310_000 }, { label: "质保金", amount_yuan: 135_000, not_yet_due: true }],
    scenarios: [{ label: "全部支持", support: 1 }, { label: "全部驳回", support: 0 }, { label: "质量抗辩成立", items: { 验收款: 0.7, 质保金: 0.5 } }],
    settlement_offers: [280_000],
  };
  const r = calcLitigationBudget(p);
  const be = (n: string) => r.break_even.find((b) => b.scenario === n)!.settlement_yuan;
  const net = (n: string) => r.scenarios.find((s) => s.scenario === n)!.net_yuan;
  assert.equal(be("全部支持"), net("全部支持") + 135_000);
  assert.equal(be("全部驳回"), net("全部驳回"), "驳回的同一认定下质保金到期后也收不回");
  assert.equal(be("质量抗辩成立"), Math.round((net("质量抗辩成立") + 67_500) * 100) / 100);
});
