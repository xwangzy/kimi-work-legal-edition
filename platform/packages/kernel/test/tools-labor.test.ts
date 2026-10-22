/**
 * v9.4 第 20 批：calc.labor（经济补偿 N、违法解除赔偿金 2N、三倍封顶、2008 年分段、代通知金）与 calc.interest v2（LPR 倍数、报价核至日警告）。
 * 期待值按劳动合同法第四十七条、第八十七条、第九十七条第三款、实施条例第二十、二十五、二十七条人工算出。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LEGAL_MCP_TOOLS } from "@zr-legal/domain";
import { calcLabor, monthsOfWage, servicePeriod } from "../src/tools/tools/labor.ts";
import { calcInterest, LPR_1Y, LPR_CHECKED_THROUGH } from "../src/tools/tools/calc.ts";
import { findTool, legalToolLockProblems, validateParams } from "../src/tools/registry.ts";

test("工作年限与月数：满年、六个月以上（含六个月）按一年、不满六个月半个月、月末对应日", () => {
  assert.deepEqual(servicePeriod("2018-03-01", "2026-09-15"), { years: 8, months: 6, days: 14 });
  assert.equal(monthsOfWage({ years: 8, months: 6, days: 14 }), 9);
  assert.equal(monthsOfWage(servicePeriod("2026-01-01", "2026-07-01")), 1, "恰好六个月按一年");
  assert.equal(monthsOfWage(servicePeriod("2026-01-01", "2026-06-30")), 0.5, "差一天不满六个月");
  assert.equal(monthsOfWage(servicePeriod("2023-01-01", "2026-06-01")), 3.5);
  assert.equal(monthsOfWage(servicePeriod("2023-01-01", "2026-01-01")), 3, "整年");
  assert.deepEqual(servicePeriod("2024-01-31", "2024-02-29"), { years: 0, months: 1, days: 0 }, "1 月 31 日起一个月到 2 月末");
});

test("经济补偿：不封顶、三倍封顶（年限最高十二年）、低于最低工资、没给当地平均工资时警告", () => {
  const a = calcLabor({ start_date: "2018-03-01", end_date: "2026-09-15", kind: "compensation", avg_monthly_wage_yuan: 10000, local_avg_monthly_wage_yuan: 12000 });
  assert.equal(a.months_of_wage, 9);
  assert.equal(a.compensation_yuan, 90000);
  assert.equal(a.capped, false);
  assert.ok(a.steps.some((s) => s.includes("不封顶")));
  const b = calcLabor({ start_date: "2010-01-01", end_date: "2025-01-01", kind: "compensation", avg_monthly_wage_yuan: 50000, local_avg_monthly_wage_yuan: 10000 });
  assert.equal(b.capped, true);
  assert.equal(b.base_yuan, 30000);
  assert.equal(b.months_of_wage, 12, "15 年按最高 12 年");
  assert.equal(b.compensation_yuan, 360000);
  const c = calcLabor({ start_date: "2024-01-01", end_date: "2025-03-01", kind: "compensation", avg_monthly_wage_yuan: 1500, local_min_wage_yuan: 2690 });
  assert.equal(c.base_yuan, 2690);
  assert.equal(c.compensation_yuan, 1.5 * 2690);
  assert.ok(c.warnings.some((w) => w.includes("三倍封顶")), "没给当地平均工资");
});

test("2008 年分段：经济补偿只算 2008 年以后并警告；违法解除赔偿金自用工之日起算、二倍", () => {
  const n = calcLabor({ start_date: "2005-01-01", end_date: "2026-01-01", kind: "compensation", avg_monthly_wage_yuan: 8000, local_avg_monthly_wage_yuan: 10000 });
  assert.equal(n.service.from, "2008-01-01");
  assert.equal(n.months_of_wage, 18);
  assert.equal(n.compensation_yuan, 144000);
  assert.ok(n.warnings.some((w) => w.includes("2008")));
  assert.ok(n.basis.includes("《中华人民共和国劳动合同法》第九十七条第三款"));
  const u = calcLabor({ start_date: "2005-01-01", end_date: "2026-01-01", kind: "unlawful", avg_monthly_wage_yuan: 8000, local_avg_monthly_wage_yuan: 10000 });
  assert.equal(u.service.from, "2005-01-01");
  assert.equal(u.months_of_wage, 21);
  assert.equal(u.compensation_yuan, 21 * 8000 * 2);
  assert.ok(u.basis.includes("《中华人民共和国劳动合同法实施条例》第二十五条"));
  assert.ok(!u.warnings.some((w) => w.includes("2008")));
});

test("代通知金按上一个月工资；没给时按平均工资并警告；输入校验", () => {
  const a = calcLabor({ start_date: "2024-01-01", end_date: "2025-01-01", kind: "compensation", avg_monthly_wage_yuan: 9000, local_avg_monthly_wage_yuan: 10000, notice_in_lieu: true, last_month_wage_yuan: 9500 });
  assert.equal(a.notice_pay_yuan, 9500);
  assert.equal(a.total_yuan, 9000 + 9500);
  const b = calcLabor({ start_date: "2024-01-01", end_date: "2025-01-01", kind: "compensation", avg_monthly_wage_yuan: 9000, notice_in_lieu: true });
  assert.equal(b.notice_pay_yuan, 9000);
  assert.ok(b.warnings.some((w) => w.includes("上一个月")));
  assert.throws(() => calcLabor({ start_date: "2025-01-01", end_date: "2024-01-01", kind: "compensation", avg_monthly_wage_yuan: 1 }), /晚于/);
  assert.throws(() => calcLabor({ start_date: "2025-02-30", end_date: "2026-01-01", kind: "compensation", avg_monthly_wage_yuan: 1 }), /YYYY-MM-DD/);
  assert.throws(() => calcLabor({ start_date: "2024-01-01", end_date: "2025-01-01", kind: "compensation", avg_monthly_wage_yuan: -1 }), /非负/);
});

test("calc.interest v2：LPR 倍数按报价生效日分段；越过已核报价日给警告；倍数上限四倍", () => {
  assert.equal(LPR_1Y.at(-1)!.pct, 3.0);
  const r = calcInterest({ principal_yuan: 100000, start_date: "2025-06-01", end_date: "2025-12-01", rate: { kind: "lpr_times", lpr_term: "1Y", multiple: 1.5 } });
  assert.equal(r.segments[0]!.annual_pct, 4.5);
  assert.equal(r.total_interest_yuan, 2256.16);
  assert.deepEqual(r.warnings, []);
  const s = calcInterest({ principal_yuan: 100000, start_date: "2025-05-01", end_date: "2025-06-01", rate: { kind: "lpr_times", lpr_term: "1Y", multiple: 4 } });
  assert.deepEqual(s.segments.map((x) => x.annual_pct), [12.4, 12], "2025-05-20 前 3.1×4，之后 3.0×4");
  const w = calcInterest({ principal_yuan: 100000, start_date: "2026-01-01", end_date: "2027-01-01", rate: { kind: "lpr_plus", lpr_term: "1Y", plus_bp: 0 } });
  assert.ok(w.warnings[0]!.includes(LPR_CHECKED_THROUGH));
  assert.deepEqual(calcInterest({ principal_yuan: 1, start_date: "2026-01-01", end_date: "2027-01-01", rate: { kind: "fixed", annual_pct: 6 } }).warnings, [], "固定利率不涉及 LPR");
  assert.throws(() => calcInterest({ principal_yuan: 1, start_date: "2025-06-01", end_date: "2025-07-01", rate: { kind: "lpr_times", lpr_term: "1Y", multiple: 5 } }), /0～4/);
});

test("工具登记：calc.labor 在法律工具名单与锁文件里；参数校验", () => {
  assert.ok((LEGAL_MCP_TOOLS as readonly string[]).includes("calc.labor"));
  for (const n of ["calc.labor", "calc.interest"]) assert.equal(legalToolLockProblems().has(n), false, `${n}: ${legalToolLockProblems().get(n)}`);
  const t = findTool("calc.labor")!;
  assert.doesNotThrow(() => validateParams(t.inputSchema, { start_date: "2024-01-01", end_date: "2025-01-01", kind: "compensation", avg_monthly_wage_yuan: 1 }));
  assert.throws(() => validateParams(t.inputSchema, { start_date: "2024-01-01", end_date: "2025-01-01", kind: "bonus", avg_monthly_wage_yuan: 1 }));
});
