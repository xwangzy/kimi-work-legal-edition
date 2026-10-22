/**
 * v9.4 第 21 批：calc.court_fee（《诉讼费用交纳办法》第十三条第（一）（四）项、第十四条第（一）（二）（三）项、第十五、十六、十八条）。
 * 期待值按办法原文（最高人民法院网站转载本）人工分段算出。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LEGAL_MCP_TOOLS } from "@zr-legal/domain";
import { calcCourtFee } from "../src/tools/tools/court-fee.ts";
import { findTool, legalToolLockProblems, validateParams } from "../src/tools/registry.ts";

test("财产案件受理费分段累计：1 万以下 50 元、100 万 13,800 元、3,000 万跨到 0.5% 一段、恰在分段点", () => {
  assert.equal(calcCourtFee({ kind: "case_property", amount_yuan: 5000 }).fee_yuan, 50);
  assert.equal(calcCourtFee({ kind: "case_property", amount_yuan: 10000 }).fee_yuan, 50, "恰好 1 万仍是定额");
  assert.equal(calcCourtFee({ kind: "case_property", amount_yuan: 100000 }).fee_yuan, 2300, "50 + 9 万 × 2.5%");
  const m = calcCourtFee({ kind: "case_property", amount_yuan: 1_000_000 });
  assert.equal(m.fee_yuan, 13800);
  assert.equal(m.segments.length, 5);
  assert.ok(m.steps.some((s) => s.includes("× 1.5%") && s.includes("4500")));
  assert.equal(calcCourtFee({ kind: "case_property", amount_yuan: 30_000_000 }).fee_yuan, 191800);
  assert.equal(calcCourtFee({ kind: "case_property", amount_yuan: 123456.78 }).fee_yuan, 2769.14, "50 + 2250 + 23456.78 × 2%（分位四舍五入）");
  assert.ok(m.basis[0]!.includes("第十三条第（一）项"));
  assert.ok(m.warnings.some((w) => w.includes("第十七条")), "提示上诉按上诉请求数额另算");
});

test("减半：简易程序、调解或撤诉、反诉各减半一次；同时符合几种只减一次并警告；申请费不减半", () => {
  const s = calcCourtFee({ kind: "case_property", amount_yuan: 1_000_000, reductions: ["simple_procedure"] });
  assert.equal(s.full_fee_yuan, 13800);
  assert.equal(s.fee_yuan, 6900);
  assert.ok(s.basis.some((b) => b.includes("第十六条")));
  const two = calcCourtFee({ kind: "case_property", amount_yuan: 1_000_000, reductions: ["simple_procedure", "mediation_or_withdrawal"] });
  assert.equal(two.fee_yuan, 6900, "不叠加");
  assert.ok(two.warnings.some((w) => w.includes("只减半一次")));
  const e = calcCourtFee({ kind: "enforcement", amount_yuan: 1_000_000, reductions: ["simple_procedure"] });
  assert.equal(e.fee_yuan, e.full_fee_yuan);
  assert.ok(e.warnings.some((w) => w.includes("申请费不减半")));
});

test("申请费：执行分段、保全 5000 元封顶与按实际保全、支付令 1/3、劳动争议每件 10 元、无执行金额只给幅度", () => {
  assert.equal(calcCourtFee({ kind: "enforcement", amount_yuan: 1_000_000 }).fee_yuan, 12400, "50 + 49 万 × 1.5% + 50 万 × 1%");
  assert.equal(calcCourtFee({ kind: "enforcement", amount_yuan: 20_000_000 }).fee_yuan, 87400, "50 + 7350 + 45000 + 25000 + 1000 万 × 0.1% = 10000");
  assert.equal(calcCourtFee({ kind: "preservation", amount_yuan: 500 }).fee_yuan, 30);
  assert.equal(calcCourtFee({ kind: "preservation", amount_yuan: 500_000 }).fee_yuan, 3020, "30 + 990 + 40 万 × 0.5%");
  const cap = calcCourtFee({ kind: "preservation", amount_yuan: 1_000_000 });
  assert.equal(cap.fee_yuan, 5000, "5520 → 最多 5000");
  assert.ok(cap.steps.some((x) => x.includes("5520") && x.includes("5000")));
  assert.equal(calcCourtFee({ kind: "payment_order", amount_yuan: 1_000_000 }).fee_yuan, 4600);
  assert.equal(calcCourtFee({ kind: "labor" }).fee_yuan, 10);
  const none = calcCourtFee({ kind: "enforcement", amount_yuan: 0 });
  assert.equal(none.fee_yuan, 0);
  assert.ok(none.warnings.some((w) => w.includes("50 元至 500 元")));
  assert.throws(() => calcCourtFee({ kind: "case_property" }), /amount_yuan/);
  assert.throws(() => calcCourtFee({ kind: "divorce" as never, amount_yuan: 1 }), /kind/);
});

test("工具登记：calc.court_fee 在法律工具名单与锁文件里；参数校验", () => {
  assert.ok((LEGAL_MCP_TOOLS as readonly string[]).includes("calc.court_fee"));
  assert.equal(legalToolLockProblems().has("calc.court_fee"), false, legalToolLockProblems().get("calc.court_fee") ?? "");
  const t = findTool("calc.court_fee")!;
  assert.doesNotThrow(() => validateParams(t.inputSchema, { kind: "case_property", amount_yuan: 1, reductions: ["simple_procedure"] }));
  assert.throws(() => validateParams(t.inputSchema, { kind: "case_property", amount_yuan: 1, reductions: ["half"] }));
  assert.throws(() => validateParams(t.inputSchema, { kind: "case_property", amount_yuan: -1 }));
});
