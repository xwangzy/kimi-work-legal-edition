/**
 * calc.ledger 第 58 批（V31 全量验收的评分报告：金额测算、答辩状、企业催告函、强制执行四张卡）：
 * A 汇总与余额引用分段表、付款表（公式能重算）、日期格、日数公式、改截止日会重算；B 只出用到的列、计算口径只写一次、无内部用语；
 * C 违约金单独成项（计算基数不计入合计、缺省不按“利息”优先冲抵、可选有争议口径）；D 每笔只按自身基数分段；E 待核日期按两端并列；F 第六十五条调减参照。
 * 金额全部手算核对（日万分之五：每 1 万元每日 5 元）。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createXlsx, excelSerial, readCreatedXlsx, type SheetSpec } from "@zr-legal/docx-engine";
import { calcLedger, calcLedgerScenarios, type LedgerParams } from "../src/tools/tools/ledger.ts";
import { ledgerWorkbook } from "../src/tools/tools/ledger-table.ts";
import { blocksOfSheets } from "../src/services/amount-check.ts";
import { liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";
import { calcLabor } from "../src/tools/tools/labor.ts";
import { calcOvertime, overtimeSheet } from "../src/tools/tools/labor-overtime.ts";
import { issueKey, newIssuesSince } from "../src/executor/amount-reconcile.ts";

const D5 = { kind: "daily", per_10k: 5 } as const;
const PAYS = [
  { date: "2025-12-26", amount_yuan: 300_000 },
  { date: "2026-03-10", amount_yuan: 200_000 },
];
const book = (list: LedgerParams[]) => {
  const { params, results } = calcLedgerScenarios(list);
  return { sheets: ledgerWorkbook(params, results), results };
};

// ---- 一个只认本表写法的小公式求值器（SUM、SUMIF、ROUND、MIN、四则、跨表引用），用来证明公式本身能把数算出来 ----
type Book = Map<string, SheetSpec>;
const colNo = (s: string) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
function evaluate(wb: Book, sheet: string, ref: string, seen = new Set<string>()): number | string | null {
  const sh = wb.get(sheet)!;
  const m = /^([A-Z]+)(\d+)$/.exec(ref)!;
  const f = sh.formulas?.[ref];
  if (f === undefined) return sh.rows[Number(m[2]) - 1]?.[colNo(m[1]!)] ?? null;
  const key = `${sheet}!${ref}`;
  assert.ok(!seen.has(key), `循环引用 ${key}`);
  seen.add(key);
  let i = 0;
  const peek = () => f[i];
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  const cells = (sh0: string, a: string, b: string): (number | string | null)[] => {
    const pa = /^\$?([A-Z]+)\$?(\d*)$/.exec(a)!;
    const pb = /^\$?([A-Z]+)\$?(\d*)$/.exec(b)!;
    const rows = wb.get(sh0)!.rows.length;
    const r1 = pa[2] ? Number(pa[2]) : 1;
    const r2 = pb[2] ? Number(pb[2]) : rows;
    const out: (number | string | null)[] = [];
    for (let r = r1; r <= r2; r++) for (let c = colNo(pa[1]!); c <= colNo(pb[1]!); c++) out.push(evaluate(wb, sh0, `${String.fromCharCode(65 + c)}${r}`, new Set(seen)));
    return out;
  };
  const refAt = (): { sheet: string; a: string; b: string | null } | null => {
    const rm = /^(?:'((?:[^']|'')+)'!)?(\$?[A-Z]+\$?\d*)(?::(\$?[A-Z]+\$?\d*))?/.exec(f.slice(i));
    if (!rm || /^[A-Z]+\(/.test(f.slice(i))) return null;
    i += rm[0].length;
    return { sheet: rm[1] ? rm[1].replace(/''/g, "'") : sheet, a: rm[2]!, b: rm[3] ?? null };
  };
  const args = (): unknown[] => {
    const out: unknown[] = [];
    i++; // (
    while (peek() !== ")") {
      out.push(expr());
      if (peek() === ",") i++;
    }
    i++;
    return out;
  };
  const factor = (): unknown => {
    if (peek() === "(") {
      i++;
      const v = expr();
      i++;
      return v;
    }
    if (peek() === "-") {
      i++;
      return -num(factor());
    }
    if (peek() === '"') {
      const j = f.indexOf('"', i + 1);
      const s = f.slice(i + 1, j);
      i = j + 1;
      return s;
    }
    const n = /^\d+(?:\.\d+)?/.exec(f.slice(i));
    if (n) {
      i += n[0].length;
      return Number(n[0]);
    }
    const fn = /^(SUMIF|SUM|ROUND|MIN|MAX)\(/.exec(f.slice(i));
    if (fn) {
      i += fn[1]!.length;
      const a = args();
      const flat = (v: unknown) => (Array.isArray(v) ? v : [v]);
      if (fn[1] === "SUM") return a.flatMap(flat).reduce((s: number, v) => s + num(v), 0);
      if (fn[1] === "MIN") return Math.min(...a.flatMap(flat).map(num));
      if (fn[1] === "MAX") return Math.max(...a.flatMap(flat).map(num));
      if (fn[1] === "ROUND") return Math.sign(num(a[0])) * Math.round(Math.abs(num(a[0])) * 10 ** num(a[1]) + 1e-7) / 10 ** num(a[1]);
      const crit = flat(a[0]);
      const vals = flat(a[2]);
      return crit.reduce((s: number, c, k) => s + (c === a[1] ? num(vals[k]) : 0), 0);
    }
    const r = refAt();
    assert.ok(r, `看不懂的公式 ${f} @${i}`);
    if (r!.b) return cells(r!.sheet, r!.a, r!.b);
    return evaluate(wb, r!.sheet, r!.a.replace(/\$/g, ""), new Set(seen));
  };
  const term = (): unknown => {
    let v = factor();
    while (peek() === "*" || peek() === "/") v = f[i++] === "*" ? num(v) * num(factor()) : num(v) / num(factor());
    return v;
  };
  const expr = (): unknown => {
    let v = term();
    while (peek() === "+" || peek() === "-") v = f[i++] === "+" ? num(v) + num(term()) : num(v) - num(term());
    return v;
  };
  return expr() as number;
}
/** 把所有公式格的缓存值清零后逐格求值：每一格都要算回原来的数。 */
function recompute(sheets: SheetSpec[]): number {
  const poisoned: Book = new Map(sheets.map((s) => [s.name, { ...s, rows: s.rows.map((r, ri) => r.map((c, ci) => (s.formulas?.[`${String.fromCharCode(65 + ci)}${ri + 1}`] ? 0 : c))) }]));
  let n = 0;
  for (const s of sheets) {
    for (const ref of Object.keys(s.formulas ?? {})) {
      const m = /^([A-Z]+)(\d+)$/.exec(ref)!;
      const want = s.rows[Number(m[2]) - 1]![colNo(m[1]!)];
      const got = evaluate(poisoned, s.name, ref);
      assert.ok(typeof got === "number" && Math.abs(got - Number(want)) < 0.005, `${s.name}!${ref} = ${s.formulas![ref]}：应为 ${want}，算出 ${got}`);
      n++;
    }
  }
  return n;
}
const sheet = (sheets: SheetSpec[], name: string) => sheets.find((s) => s.name === name)!;
const rowOf = (s: SheetSpec, label: string) => s.rows.find((r) => r[0] === label)!;

const M05: LedgerParams[] = [
  { name: "口径一：付款冲本金", as_of: "2026-11-30", accrual: "penalty", debts: [{ label: "验收款", amount_yuan: 810_000, accrue_from: "2025-12-04" }], payments: PAYS, rate: D5 },
  { name: "口径二：违约金按利息先冲", as_of: "2026-11-30", accrual: "penalty", penalty_order: "as_interest", debts: [{ label: "验收款", amount_yuan: 810_000, accrue_from: "2025-12-04" }], payments: PAYS, rate: D5 },
];

test("A：汇总的累计、已冲、已付、余额、合计都是引用分段表与付款表的公式，清零缓存后逐格能算回原数", () => {
  const { sheets } = book(M05);
  assert.ok(recompute(sheets) >= 30);
  const sum = sheet(sheets, "汇总");
  const f = sum.formulas!;
  const at = (label: string) => sum.rows.findIndex((r) => r[0] === label) + 1;
  assert.match(f[`B${at("违约金累计（元）")}`]!, /^SUMIF\('分段计算1'!C:C,"违约金",'分段计算1'!J:J\)$/);
  assert.equal(f[`B${at("本表录入的付款合计（元）")}`], "'付款与抵扣1'!C4");
  assert.equal(f[`C${at("已冲违约金（元）")}`], "'付款与抵扣2'!E4");
  assert.equal(f[`B${at("已冲本金（元）")}`], "'付款与抵扣1'!D4");
  assert.equal(f[`B${at("未清偿合计（元）")}`], `B${at("本金余额（元）")}+B${at("违约金未付（元）")}`);
  assert.deepEqual(rowOf(sum, "未清偿合计（元）").slice(1), [379_010, 383_078.26]);
  // 抵扣后本金余额 = 本金原额 − 累计冲本金
  assert.equal(sheet(sheets, "付款与抵扣1").formulas!.E3, "'汇总'!$B$3-SUM(D$2:D3)");
});

test("A：日期是日期格，日数 = 止日 − 起日 + 1；末段截止日引用汇总的暂计截止日——改截止日，日数、金额、汇总跟着变", () => {
  const { sheets } = book([M05[0]!]);
  const seg = sheet(sheets, "分段计算");
  assert.deepEqual(seg.dates!.slice(0, 2), ["D2", "E2"]);
  assert.equal(seg.rows[1]![3], excelSerial("2025-12-04"));
  assert.equal(seg.formulas!.F2, "E2-D2+1");
  assert.equal(seg.formulas!.E4, "'汇总'!$B$2", "末段截止日落在暂计截止日");
  assert.equal(seg.formulas!.E3, undefined, "中间段的截止日是付款前一日，不跟截止日走");
  const sum = sheet(sheets, "汇总");
  assert.ok(sum.dates!.includes("B2"));
  // 律师把暂计截止日从 11-30 改到 12-10：末段多 10 天 × 310,000 × 万分之五 = 1,550 元
  const edited: Book = new Map(sheets.map((s) => [s.name, s.name === "汇总" ? { ...s, rows: s.rows.map((r, ri) => (ri === 1 ? [r[0]!, excelSerial("2026-12-10")] : r)) } : s]));
  const totalRow = sum.rows.findIndex((r) => r[0] === "未清偿合计（元）") + 1;
  assert.equal(evaluate(edited, "分段计算", "F4"), 276);
  assert.equal(evaluate(edited, "汇总", `B${totalRow}`), 379_010 + 1_550);
  // 写成 xlsx 再读回：日期格与公式都在（xlsx.edit_cells 依赖读回）
  const back = readCreatedXlsx(createXlsx(sheets))!;
  assert.deepEqual(back.find((s) => s.name === "分段计算")!.dates, seg.dates);
  assert.deepEqual(back.find((s) => s.name === "汇总")!.formulas, sum.formulas);
  // 金额勾稽读表时日期还原成日期文字，不当作金额出处
  const rows = blocksOfSheets(back).rows!;
  assert.equal(rows.find((r) => r.where === "分段计算 第 2 行")!.cells[3], "2025-12-04");
});

test("B：只出用到的列与行；计算口径各口径相同的只写一次；表里没有“利息（违约金）”和内部用语", () => {
  const { sheets } = book(M05);
  assert.deepEqual(sheet(sheets, "付款与抵扣1").rows[0], ["序号", "付款日", "付款金额（元）", "冲本金", "抵扣后本金余额", "抵扣后未付违约金", "抵充明细"]);
  assert.deepEqual(sheet(sheets, "付款与抵扣2").rows[0], ["序号", "付款日", "付款金额（元）", "冲本金", "冲违约金", "抵扣后本金余额", "抵扣后未付违约金", "抵充明细"]);
  const labels = sheet(sheets, "汇总").rows.map((r) => r[0]);
  assert.ok(!labels.some((l) => /费用|加倍|利息|多付/.test(String(l))), labels.join("|"));
  const params = sheet(sheets, "参数与假设").rows;
  const rule = (t: RegExp) => params.filter((r) => r[1] === "计算口径" && t.test(String(r[2])));
  assert.equal(rule(/^舍入/).length, 1);
  assert.equal(rule(/^舍入/)[0]![0], "全部口径");
  assert.equal(rule(/^暂计截止日/).length, 1);
  assert.equal(params.filter((r) => r[1] === "验收款（本金）").length, 1, "两个口径相同的债务只列一次");
  const text = sheets.flatMap((s) => s.rows.flat()).filter((c) => typeof c === "string").join("\n");
  assert.doesNotMatch(text, /利息（违约金）|系统|工具|内核|calc\.|penalty|principal/);
});

test("C：违约金计算基数不计入未清偿合计、不参与抵充；逐笔上限；替代采购差价单列（企业催告函一单：基数被计成 714,259.85 元或填 0）", () => {
  const r = calcLedger({
    as_of: "2026-11-09",
    rate: D5,
    debts: [
      { label: "第一批迟延交货", kind: "penalty", amount_yuan: 386_200, due_date: "2026-10-10", accrue_to: "2026-10-20", cap_yuan: 38_620 },
      { label: "第一批A型补货逾期", kind: "penalty", amount_yuan: 252_000, due_date: "2026-11-06" },
      { label: "第二批逾期", kind: "penalty", amount_yuan: 411_300, due_date: "2026-10-31" },
      { label: "替代采购差价", kind: "cost", amount_yuan: 46_800 },
    ],
  });
  // 386,200 × 10 日 = 1,931；252,000 × 3 日 = 378；411,300 × 9 日 = 1,850.85
  assert.deepEqual(r.segments.map((s) => [s.item, s.kind, s.from, s.to, s.days, s.amount_yuan]), [
    ["第一批迟延交货", "penalty", "2026-10-11", "2026-10-20", 10, 1_931],
    ["第一批A型补货逾期", "penalty", "2026-11-07", "2026-11-09", 3, 378],
    ["第二批逾期", "penalty", "2026-11-01", "2026-11-09", 9, 1_850.85],
  ]);
  assert.equal(r.totals.penalty_base_yuan, 1_049_500);
  assert.equal(r.totals.principal_outstanding_yuan, 0);
  assert.equal(r.totals.penalty_outstanding_yuan, 4_159.85);
  assert.equal(r.totals.total_outstanding_yuan, 50_959.85, "违约金 4,159.85 + 差价 46,800，不含基数");
  assert.match(r.summary, /违约金未付 4,159\.85 元.*合计 50,959\.85 元/);
  assert.doesNotMatch(r.summary, /本金/);
  // 逐笔上限：把第一批上限压到 1,000 元
  const capped = calcLedger({ as_of: "2026-11-09", rate: D5, debts: [{ label: "第一批", kind: "penalty", amount_yuan: 386_200, due_date: "2026-10-10", accrue_to: "2026-10-20", cap_yuan: 1_000 }] });
  assert.equal(capped.totals.penalty_accrued_yuan, 1_000);
  assert.ok(capped.assumptions.some((a) => a.includes("累计 1,931.00 元已超过，按上限计")));
  assert.throws(() => calcLedger({ as_of: "2026-11-09", debts: [{ label: "基数", kind: "penalty", amount_yuan: 1_000, due_date: "2026-10-10" }] }), /违约金的计算基数：需要 rate/);
  assert.throws(() => calcLedger({ as_of: "2026-11-09", rate: D5, debts: [{ label: "基数", kind: "penalty", amount_yuan: 1_000, due_date: "2026-10-10", in_doubled_base: true }] }), /不能计入加倍部分/);
  const zero = calcLedger({ as_of: "2026-11-09", rate: D5, debts: [{ label: "货款基数", amount_yuan: 0, accrue_from: "2026-10-01" }] });
  assert.ok(zero.warnings.some((w) => w.includes("金额为 0")));
});

test("C：逾期付款违约金缺省排在本金之后冲抵（不当然适用第五百六十一条的“利息”顺序）；律师选“按利息顺序”时结果同第 57 批口径二并写明有争议", () => {
  const def = calcLedger({ as_of: "2026-11-30", accrual: "penalty", debts: [{ label: "验收款", amount_yuan: 810_000, accrue_from: "2025-12-04" }], payments: PAYS, rate: D5 });
  // 付款全部冲本金：违约金 8,910 + 18,870 + 41,230 = 69,010；本金 310,000
  assert.deepEqual(def.payments.map((x) => [x.to_principal_yuan, x.to_penalty_yuan, x.to_interest_yuan]), [[300_000, 0, 0], [200_000, 0, 0]]);
  assert.equal(def.totals.penalty_accrued_yuan, 69_010);
  assert.equal(def.totals.interest_accrued_yuan, 0);
  assert.equal(def.totals.total_outstanding_yuan, 379_010);
  assert.ok(def.assumptions.some((a) => a.startsWith("违约金排在本金之后") && a.includes("实务有争议")));
  const asInt = calcLedger({ as_of: "2026-11-30", accrual: "penalty", penalty_order: "as_interest", debts: [{ label: "验收款", amount_yuan: 810_000, accrue_from: "2025-12-04" }], payments: PAYS, rate: D5 });
  assert.deepEqual(asInt.payments.map((x) => [x.to_penalty_yuan, x.to_principal_yuan]), [[8_910, 291_090], [19_199.67, 180_800.33]]);
  assert.equal(asInt.totals.penalty_paid_yuan, 28_109.67);
  assert.equal(asInt.totals.total_outstanding_yuan, 383_078.26);
  assert.ok(asInt.assumptions.some((a) => a.startsWith("违约金与利息同序") && a.includes("有争议的口径")));
  // 只冲本金的口径不提违约金冲抵顺序
  const po = calcLedger({ as_of: "2026-11-30", accrual: "penalty", allocation: "principal_only", debts: [{ label: "验收款", amount_yuan: 810_000, accrue_from: "2025-12-04" }], payments: PAYS, rate: D5 });
  assert.ok(!po.assumptions.some((a) => a.startsWith("违约金排在") || a.startsWith("违约金与利息")));
});

test("C：强制执行——判决确定的违约金（penalty_fixed）计入加倍部分的基数，冲抵排在本金之后、加倍部分之前", () => {
  const r = calcLedger({
    as_of: "2026-11-30",
    debts: [
      { label: "货款本金", amount_yuan: 280_000 },
      { label: "判决确定的违约金", amount_yuan: 30_000, kind: "penalty_fixed" },
      { label: "案件受理费", amount_yuan: 6_500, kind: "cost" },
    ],
    payments: [
      { date: "2026-03-20", amount_yuan: 80_000 },
      { date: "2026-07-08", amount_yuan: 50_000 },
    ],
    doubled: { due_date: "2026-01-15" },
  });
  // 8 万：受理费 6,500 → 本金 73,500；违约金未冲
  assert.deepEqual([r.payments[0]!.to_cost_yuan, r.payments[0]!.to_principal_yuan, r.payments[0]!.to_penalty_yuan], [6_500, 73_500, 0]);
  const d = r.segments.filter((s) => s.kind === "doubled");
  // 316,500 × 万分之一点七五 × 63 = 3,489.4125；236,500 × 110 日 = 4,552.625；186,500 × 146 日 = 4,765.075
  assert.deepEqual(d.map((s) => [s.from, s.to, s.days, s.base_yuan, s.amount_yuan]), [
    ["2026-01-16", "2026-03-19", 63, 316_500, 3_489.41],
    ["2026-03-20", "2026-07-07", 110, 236_500, 4_552.63],
    ["2026-07-08", "2026-11-30", 146, 186_500, 4_765.08],
  ]);
  assert.equal(r.totals.doubled_accrued_yuan, 12_807.12);
  assert.equal(r.totals.penalty_outstanding_yuan, 30_000);
  assert.equal(r.totals.total_outstanding_yuan, 199_307.12); // 156,500 + 30,000 + 12,807.12
  assert.equal(recompute(book([{ as_of: "2026-11-30", debts: [{ label: "货款本金", amount_yuan: 280_000 }, { label: "判决确定的违约金", amount_yuan: 30_000, kind: "penalty_fixed" }, { label: "案件受理费", amount_yuan: 6_500, kind: "cost" }], payments: [{ date: "2026-03-20", amount_yuan: 80_000 }, { date: "2026-07-08", amount_yuan: 50_000 }], doubled: { due_date: "2026-01-15" } }]).sheets) > 10, true);
});

test("D：每笔款项只按自己的基数变化分段——别的款项的起算日、付款不切开它", () => {
  const r = calcLedger({
    as_of: "2026-01-31",
    accrual: "penalty",
    allocation: "principal_only",
    rate: D5,
    debts: [
      { label: "甲批货款", amount_yuan: 100_000, accrue_from: "2026-01-01" },
      { label: "乙批货款", amount_yuan: 50_000, accrue_from: "2026-01-10" },
    ],
    payments: [{ date: "2026-01-20", amount_yuan: 30_000 }],
  });
  // 付款先冲先到期的甲批：甲 19 日 × 50 = 950，12 日 × 35 = 420；乙 22 日 × 25 = 550，一段到底
  assert.deepEqual(r.segments.map((s) => [s.item, s.from, s.to, s.days, s.amount_yuan]), [
    ["甲批货款", "2026-01-01", "2026-01-19", 19, 950],
    ["甲批货款", "2026-01-20", "2026-01-31", 12, 420],
    ["乙批货款", "2026-01-10", "2026-01-31", 22, 550],
  ]);
  // 一笔用 LPR、一笔用固定日利率：LPR 报价日只切开用 LPR 的那一笔
  const mixed = calcLedger({ as_of: "2025-06-30", debts: [{ label: "借款", amount_yuan: 1_000_000, accrue_from: "2025-05-01", rate: { kind: "lpr_times", multiple: 1.5 } }, { label: "货款", amount_yuan: 100_000, accrue_from: "2025-05-01", rate: D5 }] });
  assert.equal(mixed.segments.filter((s) => s.item === "借款").length, 2);
  assert.deepEqual(mixed.segments.filter((s) => s.item === "货款").map((s) => [s.days, s.amount_yuan]), [[61, 3_050]]);
});

test("E：一笔付款到账日只知道区间——按最早、最晚各算一个口径并列，确定的分段不丢、依赖待核日期的分段标出（答辩状一单只算了最后一段）", () => {
  const { params, results } = calcLedgerScenarios([{ name: "反诉违约金", as_of: "2026-11-09", accrual: "penalty", allocation: "principal_only", rate: D5, debts: [{ label: "验收款", amount_yuan: 810_000, accrue_from: "2025-12-04" }], payments: [{ date_range: { earliest: "2025-12-10", latest: "2026-01-20" }, amount_yuan: 300_000 }, { date: "2026-03-10", amount_yuan: 200_000 }] }]);
  assert.deepEqual(results.map((r) => r.name), ["反诉违约金（待核日期按最早）", "反诉违约金（待核日期按最晚）"]);
  // 最早：810,000 × 6 日 + 510,000 × 90 日 + 310,000 × 245 日 = 2,430 + 22,950 + 37,975 = 63,355
  // 最晚：810,000 × 47 日 + 510,000 × 49 日 + 310,000 × 245 日 = 19,035 + 12,495 + 37,975 = 69,505
  assert.deepEqual(results.map((r) => r.totals.penalty_accrued_yuan), [63_355, 69_505]);
  assert.deepEqual(results[0]!.segments.map((s) => [s.days, !!s.pending]), [[6, true], [90, true], [245, false]]);
  assert.equal(results[0]!.pending_dates!.dependent_segments, 2);
  assert.equal(results[0]!.pending_dates!.other_total_outstanding_yuan, 379_505);
  assert.match(results[0]!.pending_dates!.items[0]!, /300,000\.00 元付款的日期（待核：最早 2025-12-10，最晚 2026-01-20）/);
  assert.match(results[1]!.payments[0]!.note, /日期待核（2025-12-10～2026-01-20），本口径按最晚日计/);
  assert.equal(params[1]!.payments![0]!.date, "2026-01-20");
  const sheets = ledgerWorkbook(params, results);
  assert.equal(sheet(sheets, "分段计算1").rows[1]![10], "依赖待核日期");
  assert.match(String(rowOf(sheet(sheets, "汇总"), "待核日期")[2]), /本列按最晚日计，2 段依赖待核日期/);
  recompute(sheets);
  // 起算日待核同样展开
  const s = calcLedgerScenarios([{ as_of: "2026-01-31", rate: D5, accrual: "penalty", debts: [{ label: "质保金", amount_yuan: 100_000, due_date_range: { earliest: "2026-01-10", latest: "2026-01-20" } }] }]);
  assert.deepEqual(s.results.map((r) => r.totals.penalty_accrued_yuan), [1_050, 550]); // 21 日、11 日 × 50
  assert.throws(() => calcLedgerScenarios([{ as_of: "2026-01-31", debts: [{ label: "x", amount_yuan: 1 }], payments: [{ date_range: { earliest: "2026-01-20", latest: "2026-01-10" }, amount_yuan: 1 }] }]), /earliest 须早于 latest/);
  assert.throws(() => calcLedgerScenarios([{ as_of: "2026-01-31", debts: [{ label: "x", amount_yuan: 1 }], payments: [{ date: "2026-01-05", date_range: { earliest: "2026-01-01", latest: "2026-01-10" }, amount_yuan: 1 }] }]), /date 与 date_range 只给一个/);
  assert.throws(() => calcLedger({ as_of: "2026-01-31", debts: [{ label: "x", amount_yuan: 1 }], payments: [{ date_range: { earliest: "2026-01-01", latest: "2026-01-10" }, amount_yuan: 1 }] }), /calcLedgerScenarios/);
});

test("F：违约金调减参照——给了损失数额才比较“损失 × 130%”；没有损失只列需要的证据，不编数；结论写明是“一般可以认定”的参照", () => {
  const base: LedgerParams = { as_of: "2026-11-30", accrual: "penalty", allocation: "principal_only", debts: [{ label: "验收款", amount_yuan: 810_000, accrue_from: "2025-12-04" }], payments: PAYS, rate: D5 };
  const none = calcLedger(base).penalty_check!;
  assert.equal(none.loss_yuan, null);
  assert.equal(none.reference_yuan, null);
  assert.equal(none.exceeds, null);
  assert.ok(none.needs.length >= 1 && none.needs[0]!.includes("第五百八十四条"));
  assert.ok(calcLedger(base).assumptions.some((a) => a.includes("第六十五条第二款") && a.includes("一般可以认定") && a.includes("不是确定结论")));
  // 违约金 69,010；损失 50,000 × 130% = 65,000 → 超过
  const hi = calcLedger({ ...base, penalty_check: { loss_yuan: 50_000, loss_basis: "律师确认的资金占用损失" } }).penalty_check!;
  assert.deepEqual([hi.penalty_yuan, hi.loss_yuan, hi.reference_yuan, hi.exceeds], [69_010, 50_000, 65_000, true]);
  assert.match(hi.conclusion, /超过损失 50,000\.00 元的 130%（65,000\.00 元）.*参照，不是确定结论/);
  // 损失 60,000 × 130% = 78,000 → 未超过
  assert.equal(calcLedger({ ...base, penalty_check: { loss_yuan: 60_000 } }).penalty_check!.exceeds, false);
  // 损失按年 3.65%（日万分之一）计：810,000 × 22 日 × 万分之一 = 1,782；510,000 × 74 日 = 3,774；310,000 × 266 日 = 8,246；合计 13,802 → 130% = 17,942.60
  const byRate = calcLedger({ ...base, penalty_check: { loss_rate: { kind: "fixed", annual_pct: 3.65 } } }).penalty_check!;
  assert.deepEqual([byRate.loss_yuan, byRate.reference_yuan, byRate.exceeds], [13_802, 17_942.6, true]);
  assert.match(byRate.loss_basis!, /年利率 3\.65%/);
  assert.throws(() => calcLedger({ ...base, penalty_check: { loss_yuan: 1, loss_rate: D5 } }), /只给一个/);
  // 没有违约金的口径不出调减参照
  assert.equal(calcLedger({ as_of: "2026-01-31", rate: D5, debts: [{ label: "借款", amount_yuan: 1_000, accrue_from: "2026-01-01" }] }).penalty_check, null);
  // 表里：损失数额、130% 参照（公式）、结论
  const sheets = book([{ ...base, penalty_check: { loss_yuan: 50_000 } }]).sheets;
  const sum = sheet(sheets, "汇总");
  assert.equal(rowOf(sum, "损失的 130%（元）")[1], 65_000);
  assert.ok(Object.values(sum.formulas!).some((f) => /^ROUND\(B\d+\*1\.3,2\)$/.test(f)));
  recompute(sheets);
});

test("没有录入付款的口径：已付款合计写“未录入”，不出空的付款表；没有计息期间不出空的分段表", () => {
  const { sheets } = book([{ as_of: "2026-11-09", debts: [{ label: "判决确定的违约金", amount_yuan: 1_000, kind: "penalty_fixed" }] }]);
  assert.deepEqual(sheets.map((s) => s.name), ["汇总", "参数与假设"]);
  assert.equal(rowOf(sheet(sheets, "汇总"), "本表录入的付款合计（元）")[1], "未录入");
});

test("calc.labor 工资台账：加回扣款只改 include，台账原样传一次——不会把 3,310.34 元扣款加回两次（劳动应对一单）", () => {
  const months = Array.from({ length: 12 }, (_, i) => ({ month: `2025-${String(i + 1).padStart(2, "0")}`, items: { 基本工资: 25_000, 岗位津贴: 5_000 } as Record<string, number> }));
  months[7]!.items["旷工扣款"] = -3_310.34;
  const kept = calcLabor({ start_date: "2021-03-01", end_date: "2026-09-04", kind: "compensation", wage_table: { months, include: ["基本工资", "岗位津贴", "旷工扣款"] } });
  const addBack = calcLabor({ start_date: "2021-03-01", end_date: "2026-09-04", kind: "compensation", wage_table: { months, include: ["基本工资", "岗位津贴"] } });
  // 不加回：(360,000 − 3,310.34) ÷ 12 = 29,724.14；加回：360,000 ÷ 12 = 30,000（重复加回才会是 363,310.34 ÷ 12 = 30,275.86）
  assert.match(kept.steps[1]!, /合计 356689\.66 元 ÷ 12 = 29724\.14 元/);
  assert.match(addBack.steps[1]!, /合计 360000 元 ÷ 12 = 30000 元/);
  assert.equal(addBack.compensation_yuan, 180_000); // 6 × 30,000
});

test("修改轮新引入的金额不一致：上一轮没有、最新版出现的报出来（回看接入点）", () => {
  const eq = (text: string) => ({ kind: "equation" as const, where: "第 1 段", filename: "催告函.docx", text, expected: 1, actual: 2, fix: "" });
  const old = eq("386,200.00×日万分之5×10日＝1,931.00");
  const fresh = eq("0.00×日万分之5×10日＝1,931.00");
  assert.deepEqual(newIssuesSince([issueKey(old)], [old, fresh, fresh]).map((i) => i.text), [fresh.text]);
});

// ---- calc.labor kind=overtime：加班费差额（真实复测：台账 144 小时被手工加成 152 小时） ----
const OT_MONTHS = [
  { month: "2026-03", base_yuan: 8_700, workday_hours: 20, restday_hours: 16, paid_yuan: 1_000 },
  { month: "2026-04", base_yuan: 9_000, workday_hours: 30.5, holiday_hours: 8, paid_yuan: 4_000, note: "4 月休息日加班已补休" },
  { month: "2026-05", base_yuan: 8_700, workday_hours: 93.5 },
];

test("加班费：逐月小时工资、各类加班费、应付、差额与合计由工具算；小时数按类别合计（工作日 144 小时）", () => {
  const r = calcOvertime({ kind: "overtime", months: OT_MONTHS, base_basis: "劳动合同约定月工资" });
  // 3 月：8,700 ÷ 21.75 ÷ 8 = 50；20 × 50 × 150% = 1,500；16 × 50 × 200% = 1,600；应付 3,100，已付 1,000，差额 2,100
  // 4 月：9,000 ÷ 21.75 ÷ 8 = 51.7241…（不先取整）；30.5 × 51.7241… × 150% = 2,366.38；8 × 51.7241… × 300% = 1,241.38；应付 3,607.76
  // 5 月：93.5 × 50 × 150% = 7,012.50，已付未录入
  assert.deepEqual(r.months.map((m) => [m.month, m.hourly_yuan, m.workday_pay_yuan, m.restday_pay_yuan, m.holiday_pay_yuan, m.due_yuan, m.paid_yuan, m.diff_yuan]), [
    ["2026-03", 50, 1_500, 1_600, 0, 3_100, 1_000, 2_100],
    ["2026-04", 9_000 / 21.75 / 8, 2_366.38, 0, 1_241.38, 3_607.76, 4_000, 0],
    ["2026-05", 50, 7_012.5, 0, 0, 7_012.5, 0, 7_012.5],
  ]);
  assert.deepEqual(r.hours_total, { workday: 144, restday: 16, holiday: 8, all: 168 });
  assert.deepEqual([r.due_total_yuan, r.paid_total_yuan, r.diff_total_yuan, r.total_yuan], [13_720.26, 5_000, 9_112.5, 9_112.5]);
  // 已付超过应付：差额 0 并标注；已付未录入的月份标注
  assert.equal(r.months[1]!.overpaid_yuan, 392.24);
  assert.match(r.months[1]!.note, /已付超过应付 392\.24 元，本月差额按 0 计（不抵其他月份）；4 月休息日加班已补休/);
  assert.match(r.months[2]!.note, /本月已付未录入，按 0 计/);
  assert.ok(r.assumptions.some((a) => a.includes("21.75 天（原劳动和社会保障部通知口径）")));
  assert.ok(r.assumptions.some((a) => a.includes("劳动法第四十四条") && a.includes("百分之一百五十")));
  assert.ok(r.assumptions.some((a) => a.includes("已安排补休的，不支付加班费")));
  assert.ok(r.warnings.some((w) => w.includes("已付超过应付")));
  assert.match(r.steps.at(-1)!, /加班 168 小时.*工作日延长工作时间 144 小时/);
});

test("加班费：补休的休息日不计；改计薪天数与倍数按声明计；参数错误拒收", () => {
  // 同一个月，休息日 16 小时已补休（不填）：应付只有工作日部分
  const a = calcOvertime({ kind: "overtime", months: [{ month: "2026-03", base_yuan: 8_700, workday_hours: 20 }] });
  assert.deepEqual([a.due_total_yuan, a.hours_total.restday], [1_500, 0]);
  assert.ok(a.warnings.some((w) => w.includes("没有录入已付加班费")));
  // 计薪天数 20.83、每日 8 小时：8,700 ÷ 20.83 ÷ 8 = 52.2083…（不先取整）；20 × 52.2083… × 150% = 1,566.25
  const b = calcOvertime({ kind: "overtime", divisor_days: 20.83, months: [{ month: "2026-03", base_yuan: 8_700, workday_hours: 20 }] });
  assert.deepEqual([b.months[0]!.hourly_yuan, b.due_total_yuan], [8_700 / 20.83 / 8, 1_566.25]);
  assert.ok(!b.assumptions[0]!.includes("21.75"));
  assert.throws(() => calcOvertime({ kind: "overtime", months: [{ month: "2026-3", base_yuan: 1 }] }), /YYYY-MM/);
  assert.throws(() => calcOvertime({ kind: "overtime", months: [{ month: "2026-03", base_yuan: 1 }, { month: "2026-03", base_yuan: 1 }] }), /重复/);
  assert.throws(() => calcOvertime({ kind: "overtime", months: [{ month: "2026-03", base_yuan: 0 }] }), /base_yuan/);
});

test("加班费计算表：只出用到的类别；小时工资、各类加班费、应付、差额（MAX）、合计都是公式，清零后能算回原数", () => {
  const sh = overtimeSheet("加班费计算", calcOvertime({ kind: "overtime", months: OT_MONTHS }));
  assert.deepEqual(sh.rows[0], ["月份", "加班费计算基数（元）", "小时工资（元）", "工作日延长工作时间（小时）", "工作日延长工作时间加班费（元，150%）", "休息日加班（不能安排补休）（小时）", "休息日加班（不能安排补休）加班费（元，200%）", "法定休假日加班（小时）", "法定休假日加班加班费（元，300%）", "应付加班费（元）", "已付加班费（元）", "差额（元）", "说明"]);
  assert.equal(sh.formulas!.C3, "B3/21.75/8");
  assert.equal(sh.formulas!.E3, "ROUND(D3*C3*1.5,2)");
  assert.equal(sh.formulas!.L3, "MAX(0,J3-K3)");
  assert.equal(sh.formulas!.D5, "SUM(D2:D4)");
  assert.equal(sh.rows[4]![3], 144);
  assert.equal(sh.rows[4]![11], 9_112.5);
  assert.ok(recompute([sh]) >= 25);
  const one = overtimeSheet("加班费", calcOvertime({ kind: "overtime", months: [{ month: "2026-03", base_yuan: 8_700, workday_hours: 20 }] }));
  assert.deepEqual(one.rows[0], ["月份", "加班费计算基数（元）", "小时工资（元）", "工作日延长工作时间（小时）", "工作日延长工作时间加班费（元，150%）", "应付加班费（元）", "差额（元）", "说明"]);
  recompute([one]);
});

// ---- 经本机端点：新字段过 schema、成表、读回 ----
let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "calc-ledger-b58");
});
after(async () => {
  await tk.kernel.close();
});

test("经本机端点：违约金基数、待核日期、调减参照一次调用成表；读回有日期格与公式", async () => {
  const { matter: m } = await tk.inv("matters.create", { title: "台账违约金", stance: "原告", consent_status: "agreed" });
  const { Agent, fetch } = await import("undici");
  const live = liveTaskIdentity(tk, m.matter_id, "ledger-b58");
  const token = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, fx: ["read", "write_draft"], scope: ["tool:legal"] }, 300);
  const agent = new Agent({ connect: { socketPath: tk.kernel.pipePath } });
  try {
    const r = (await fetch("http://tools.kwl/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "calc.ledger",
          arguments: {
            title: "金额测算-违约金-截至2026-11-09",
            scenarios: [
              { name: "反诉", as_of: "2026-11-09", accrual: "penalty", allocation: "principal_only", rate: D5, debts: [{ label: "验收款", amount_yuan: 810_000, accrue_from: "2025-12-04" }], payments: [{ date_range: { earliest: "2025-12-10", latest: "2026-01-20" }, amount_yuan: 300_000 }, { date: "2026-03-10", amount_yuan: 200_000 }], penalty_check: { loss_yuan: 40_000 } },
              { name: "逾期交货", as_of: "2026-11-09", rate: D5, debts: [{ label: "第二批", kind: "penalty", amount_yuan: 411_300, due_date: "2026-10-31", cap_yuan: 41_130 }] },
            ],
          },
        },
      }),
      dispatcher: agent,
    }).then((x) => x.json())) as any;
    assert.equal(r.result?.isError, false, JSON.stringify(r).slice(0, 800));
    const out = r.result.structuredContent;
    assert.deepEqual(out.scenarios.map((s: any) => s.totals.total_outstanding_yuan), [373_355, 379_505, 1_850.85]);
    assert.match(out.how_to_use, /pending_dates/);
    assert.equal(out.workbook.quality_check?.ok ?? out.workbook.quality_check?.issues?.length === 0, true, JSON.stringify(out.workbook.quality_check).slice(0, 800));
    const row = tk.kernel.db.get<{ storage_uri: string }>(`SELECT storage_uri FROM artifact_versions WHERE artifact_version_id = ?`, [out.workbook.artifact_version_id]);
    const back = readCreatedXlsx(tk.kernel.blobs.read(row!.storage_uri))!;
    assert.deepEqual(back.map((s) => s.name), ["汇总", "分段计算1", "付款与抵扣1", "分段计算2", "付款与抵扣2", "分段计算3", "参数与假设"]);
    assert.ok(back[1]!.dates!.includes("D2") && back[0]!.dates!.includes("B2"));
    assert.equal(back[5]!.rows[1]![5], 9, "第二批 11-01～11-09 一段 9 日");
    recompute(back);
    // calc.labor kind=overtime 过 schema；xlsx.render_table 的 computed 由内核写成带公式的加班费表
    const call = async (name: string, args: unknown, id: number) =>
      (await fetch("http://tools.kwl/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }), dispatcher: agent }).then((x) => x.json())) as any;
    const ot = await call("calc.labor", { kind: "overtime", months: OT_MONTHS, base_basis: "劳动合同约定月工资" }, 2);
    assert.equal(ot.result?.isError, false, JSON.stringify(ot).slice(0, 600));
    assert.equal(ot.result.structuredContent.diff_total_yuan, 9_112.5);
    const t = await call("xlsx.render_table", { title: "加班费差额测算", sheets: [], computed: [{ tool: "calc.labor", name: "加班费计算", params: { kind: "overtime", months: OT_MONTHS } }] }, 3);
    assert.equal(t.result?.isError, false, JSON.stringify(t).slice(0, 600));
    const tr = tk.kernel.db.get<{ storage_uri: string }>(`SELECT storage_uri FROM artifact_versions WHERE artifact_version_id = ?`, [t.result.structuredContent.artifact_version_id]);
    const otBack = readCreatedXlsx(tk.kernel.blobs.read(tr!.storage_uri))!;
    assert.equal(otBack[0]!.name, "加班费计算");
    const qc = t.result.structuredContent.quality_check;
    assert.equal(qc?.ok ?? qc?.issues?.length === 0, true, JSON.stringify(qc).slice(0, 800));
    assert.equal(otBack[0]!.formulas?.L3, "MAX(0,J3-K3)");
    recompute(otBack);
    const bad = await call("xlsx.render_table", { title: "x", sheets: [], computed: [{ tool: "calc.labor", params: { kind: "unlawful" } }] }, 4);
    assert.equal(bad.result?.isError, true);
  } finally {
    await agent.close();
  }
});

// 第 58 批（真实复测金额测算卡）：汇总表“需要留意”三列都写“无”，复核判它掩盖了各口径的前提——这一行是工具生成的、模型改不了，修改轮落不了地
test("口径前提：写了 premise 的在汇总表单列一行；没有提示时不出“需要留意”一行", async () => {
  const { ledgerWorkbook } = await import("../src/tools/tools/ledger-table.ts");
  const { calcLedger } = await import("../src/tools/tools/ledger.ts");
  const a = { name: "口径一", premise: "超期修复属卖方原因，质保金顺延 29 日", as_of: "2026-11-30", debts: [{ label: "验收款", amount_yuan: 100_000, accrue_from: "2026-10-01" }], rate: { kind: "daily" as const, per_10k: 5 } };
  const b = { name: "口径二", as_of: "2026-11-30", debts: [{ label: "验收款", amount_yuan: 100_000, accrue_from: "2026-10-01" }], rate: { kind: "daily" as const, per_10k: 5 } };
  const results = [a, b].map((s) => calcLedger(s as any));
  assert.equal(results[0]!.premise, "超期修复属卖方原因，质保金顺延 29 日");
  assert.equal(results[1]!.premise, null);
  const sheets = ledgerWorkbook([a, b] as any, results);
  const sum = sheets.find((x: any) => x.name === "汇总")!;
  const row = (label: string) => sum.rows.find((r: any) => r[0] === label);
  assert.deepEqual(row("口径前提"), ["口径前提", "超期修复属卖方原因，质保金顺延 29 日", "—"]);
  assert.equal(row("需要留意"), undefined, "两个口径都没有提示时不出这一行");
  assert.ok(row("本表录入的付款合计（元）"), "已付款合计改名，免得读成案件全部已付款");
});
