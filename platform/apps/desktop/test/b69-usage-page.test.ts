/**
 * 第 69 批（V43）：“设置 · 套餐与用量”重设计的客户端口径——
 * - 每日柱：云端 personal.daily（只含有调用的日子）铺到本期每一天；今天、今天之后、没用的日子各自标出；均匀线 = 1 ÷ 本期天数；旧云端没有 daily 时整块不显示；
 * - 节奏：日均从本期开始或第一次用的那天算起（取晚者，至少 1 天），推到期末判宽裕 / 偏紧 / 偏快（给出约哪天用完）；旧云端不报日均；
 * - 用途：任务 + 问答（同一分母）；按模型带 used_ratio 时按计入额度说，旧云端按处理量份额说；
 * - 源码门禁：不拿最近 20 条明细拼每日图、不出现金额点数、不做伪数据。
 * 样例数字取自 2026-11-26 本机全链路真实账号（试用、单席位）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { QuotaStatus } from "../src/api.ts";
import { collapseFree, dailySeries, dayReadout, kindSplit, ownModels, paceView, personalView, resetIn } from "../src/lib/personal-usage.ts";

const src = (p: string) => readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const PERIOD = { kind: "month" as const, key: "2026-11", start: "2026-10-31T16:00:00.000Z", resets_at: "2026-11-30T16:00:00.000Z" };
const NOW = Date.parse("2026-11-26T04:00:00.000Z"); // 北京 11 月 26 日 12:00
const q = (personal: Partial<NonNullable<QuotaStatus["personal"]>> = {}, over: Partial<QuotaStatus> = {}): QuotaStatus =>
  ({
    mode: "control_plane",
    plan: { id: "trial", label: "试用", period: "month", burst: { hours: 5, pct: 50 }, models: ["K3", "K2.6"] },
    period: PERIOD,
    firm: { used_ratio: 0.12, remaining_ratio: 0.88, in_flight_ratio: 0, paused: null, cap_pct: null, boost_pct: 0, legacy_used_ratio: null, used: null, total: null, seats: 1 },
    burst: { hours: 5, pct: 50, used_ratio: 0, resets_at: null },
    own: null,
    personal: { used_ratio: 0.12, remaining_ratio: 0.88, limited_by: null, paused: null, ...personal },
    ...over,
  }) as QuotaStatus;

test("每日柱：本期 30 天每天一格；云端只给有调用的日子，其余为 0；今天、今天之后各自标出；均匀线 1/30；纵轴上沿不低于均匀线", () => {
  const daily = [
    { day: "2026-11-03", ratio: 0.031, requests: 40, qa_requests: 2 },
    { day: "2026-11-26", ratio: 0.089, requests: 77, qa_requests: 5 },
  ];
  const s = dailySeries(q({ daily }), NOW)!;
  assert.equal(s.bars.length, 30);
  assert.equal(s.bars[0]!.day, "2026-11-01");
  assert.equal(s.bars[29]!.day, "2026-11-30");
  assert.equal(s.bars[2]!.ratio, 0.031);
  assert.equal(s.bars[1]!.ratio, 0, "没用的日子 0（界面画基线点）");
  assert.deepEqual(s.bars.filter((b) => b.today).map((b) => b.day), ["2026-11-26"]);
  assert.deepEqual(s.bars.filter((b) => b.future).map((b) => b.day), ["2026-11-27", "2026-11-28", "2026-11-29", "2026-11-30"]);
  assert.ok(Math.abs(s.even - 1 / 30) < 1e-12);
  assert.ok(s.top >= 0.089 && s.top >= s.even);
  assert.equal(s.active, 2);
  // 周套餐：7 格
  const wk = dailySeries(q({ daily: [] }, { period: { kind: "week", key: "2026-W48", start: "2026-11-22T16:00:00.000Z", resets_at: "2026-11-29T16:00:00.000Z" } }), NOW)!;
  assert.equal(wk.bars.length, 7);
  assert.equal(wk.active, 0);
  assert.ok(Math.abs(wk.top - (1 / 7) * 1.12) < 1e-12, "一天没用：纵轴按均匀线定，柱子都是基线点");
  // 旧云端没有 daily：整块不显示（不拿 own_recent 拼）
  assert.equal(dailySeries(q(), NOW), null);
  assert.equal(dailySeries(q({ daily: [] }, { period: undefined }), NOW), null);
});

test("每日读数：日期 · 百分比 · 调用次数（任务与问答分开）；今天写“今天”", () => {
  assert.deepEqual(dayReadout({ day: "2026-11-24", ratio: 0.042, requests: 38, qa: 3, today: false }), { when: "11 月 24 日", pct: "4.2%", calls: "38 次调用（任务 35 · 问答 3）" });
  assert.deepEqual(dayReadout({ day: "2026-11-26", ratio: 0.0005, requests: 2, qa: 2, today: true }), { when: "今天 · 11 月 26 日", pct: "<0.1%", calls: "2 次问答调用" });
  assert.equal(dayReadout({ day: "2026-11-25", ratio: 0, requests: 0, qa: 0, today: false }).calls, "没有调用");
});

test("节奏（第三轮）：按近 7 天日均推算期末；第一次用起不满 3 天不推算；宽裕 / 偏紧 / 偏快 / 已用完 / 还没用；旧云端只并排说时间与用量", () => {
  // 今天才开始用、已用 12%：不满 3 天 → 不推算（只用过一天就外推到月底会夸大）
  const firstDay = q({ used_ratio: 0.12, daily: [{ day: "2026-11-26", ratio: 0.12, requests: 80, qa_requests: 2 }] });
  const p1 = paceView(firstDay, personalView(firstDay), NOW)!;
  assert.deepEqual([p1.label, p1.text], ["刚开始", "用满 3 天后，按近 7 天日均预估月底用量"]);
  assert.ok(Math.abs(p1.elapsed - (25.5 / 30)) < 1e-9);
  // 不满 3 天但已用得多：如实说余量不多
  const hot = q({ used_ratio: 0.85, daily: [{ day: "2026-11-25", ratio: 0.5, requests: 80, qa_requests: 0 }, { day: "2026-11-26", ratio: 0.35, requests: 60, qa_requests: 0 }] });
  assert.deepEqual([paceView(hot, personalView(hot), NOW)!.label, paceView(hot, personalView(hot), NOW)!.text], ["偏紧", "已用 85%，余量不多"]);
  // 11-20 起用了 7 天（近 7 天合计 24%）：日均 3.4%，剩 4.5 天 → 30% + 15% ≈ 45% → 宽裕
  const steady = q({ used_ratio: 0.3, daily: [{ day: "2026-11-20", ratio: 0.1, requests: 9, qa_requests: 0 }, { day: "2026-11-24", ratio: 0.05, requests: 5, qa_requests: 0 }, { day: "2026-11-25", ratio: 0.05, requests: 5, qa_requests: 0 }, { day: "2026-11-26", ratio: 0.04, requests: 4, qa_requests: 0 }] });
  const p2 = paceView(steady, personalView(steady), NOW)!;
  assert.deepEqual([p2.label, p2.text], ["宽裕", "按近 7 天日均 3.4% 估算，到月底约用 45%"]);
  // 近 3 天每天 20%～25%：日均约 23%，余 30% 约 1.3 天用完 → 偏快，11 月 27 日
  const fast = q({ used_ratio: 0.7, daily: [{ day: "2026-11-24", ratio: 0.2, requests: 9, qa_requests: 0 }, { day: "2026-11-25", ratio: 0.25, requests: 9, qa_requests: 0 }, { day: "2026-11-26", ratio: 0.25, requests: 9, qa_requests: 0 }] });
  const p3 = paceView(fast, personalView(fast), NOW)!;
  assert.equal(p3.tone, "fast");
  assert.equal(p3.text, "按近 3 天日均 23% 估算，约 11 月 27 日用完");
  // 月初用掉 60%、近 7 天只用 20%：日均 2.9%，期末约 93% → 偏紧（按近 7 天，不被月初那一下拉高）
  const tight = q({ used_ratio: 0.8, daily: [{ day: "2026-11-01", ratio: 0.6, requests: 10, qa_requests: 0 }, { day: "2026-11-22", ratio: 0.2, requests: 10, qa_requests: 0 }] });
  assert.equal(paceView(tight, personalView(tight), NOW)!.label, "偏紧");
  const out = q({ used_ratio: 1, remaining_ratio: 0, limited_by: "allowance", paused: "allowance", daily: [] });
  assert.equal(paceView(out, personalView(out), NOW)!.tone, "out");
  const idle = q({ used_ratio: 0, daily: [] });
  assert.deepEqual([paceView(idle, personalView(idle), NOW)!.label, paceView(idle, personalView(idle), NOW)!.text], ["还没用", "本月还没有计入额度的调用"]);
  // 旧云端（没有 daily）：不推算期末，并排说时间与用量
  const old = q({ used_ratio: 0.12 });
  // 第四轮：旧云端不下判断，只陈述
  assert.deepEqual([paceView(old, personalView(old), NOW)!.label, paceView(old, personalView(old), NOW)!.text], ["—", "本月时间已过 85%，额度已用 12%"]);
  assert.equal(paceView(q({}, { period: undefined }), personalView(q()), NOW), null);
});
test("用途与按模型：任务 + 问答同一分母；模型带 used_ratio 按计入额度排序，旧云端为 null（按处理量份额说）；距重置的大字", () => {
  const k = kindSplit(q({ by_kind: { task: { ratio: 0.112, requests: 75 }, qa: { ratio: 0.008, requests: 5 } } }))!;
  assert.ok(Math.abs(k.task.ratio + k.qa.ratio - 0.12) < 1e-9);
  assert.equal(kindSplit(q()), null, "旧云端没有 by_kind");
  const m = ownModels(q({}, { own_models: [{ alias: "legal/k3", label: "K3", share: 0.4, requests: 10, used_ratio: 0.09 }, { alias: "legal/k2.6", label: "K2.6", share: 0.6, requests: 70, used_ratio: 0.03 }] }), { solo: true });
  assert.deepEqual(m.map((x) => [x.label, x.ratio]), [["K3", 0.09], ["K2.6", 0.03]], "按计入额度排，不按 token 份额");
  assert.equal(ownModels(q({}, { own_models: [{ alias: "legal/k3", label: "K3", share: 1, requests: 6 }] }), { solo: true })[0]!.ratio, null);
  assert.deepEqual(resetIn(PERIOD.resets_at, NOW), { n: "4", unit: "天后" });
  assert.deepEqual(resetIn(PERIOD.resets_at, Date.parse("2026-11-30T11:00:00.000Z")), { n: "5", unit: "小时后" });
  assert.deepEqual(resetIn(PERIOD.resets_at, Date.parse("2026-11-30T15:30:00.000Z")), { n: "1", unit: "小时内" });
  assert.equal(resetIn(PERIOD.resets_at, Date.parse("2026-12-01T00:00:00.000Z")), null);
});

test("最近记录：相邻的“未计入”同类行并成一行（上游 503 自动重试，真实账本 12:48 连续 7 条）；计入额度的行逐条列", () => {
  const row = (at: string, outcome: string, ratio: number, kind: "qa" | "task" = "task") => ({ at, kind, alias: "legal/k3", label: "K3", tokens_in: 0, tokens_cached: 0, tokens_out: 0, outcome, partial: false, estimated: false, charge_ratio: ratio });
  const rows = [row("2026-11-26T04:49:41Z", "ok", 0.002), ...Array.from({ length: 7 }, (_, i) => row(`2026-11-26T04:48:${String(37 - i).padStart(2, "0")}Z`, "upstream_error", 0)), row("2026-11-26T04:47:59Z", "ok", 0.004), row("2026-11-26T04:46:59Z", "ok", 0.003)];
  const c = collapseFree(rows, 1);
  assert.deepEqual(c.map((x) => [x.n, x.charge.text]), [[1, "0.2%"], [7, "未计入 · 未成功"], [1, "0.4%"], [1, "0.3%"]]);
  assert.equal(collapseFree([row("a", "upstream_error", 0), row("b", "upstream_error", 0, "qa")], 1).length, 2, "用途不同不合并");
});

test("源码门禁：每日图只用云端 personal.daily；不拼 own_recent、不出现金额点数、不做伪数据；图形颜色只走样式表", () => {
  const lib = strip(src("lib/personal-usage.ts"));
  const fn = lib.slice(lib.indexOf("export function dailySeries"), lib.indexOf("export function dayReadout"));
  assert.match(fn, /q\.personal\?\.daily/);
  assert.doesNotMatch(fn, /own_recent|own_models|Math\.random/);
  const page = strip(src("pages/PersonalUsage.tsx"));
  assert.match(page, /\{series && \(/, "旧云端没有 daily 时整块不显示");
  const charts = strip(src("components/UsageCharts.tsx"));
  for (const code of [page, charts]) {
    assert.doesNotMatch(code, /本所|by_member|value_cny|点数|积分|¥|元/);
    assert.doesNotMatch(code, /Math\.random|mock|setTimeout/i);
    assert.doesNotMatch(code, /#[0-9a-fA-F]{3,8}\b|rgba?\(|\b(fill|stroke|color|background)=\{?["'`]/, "颜色只走样式表令牌");
  }
});

test("最近记录（第四轮）：同一分钟里同一类、同一模型的计入调用合成一行、计入额度相加；不同分钟、不同类不合并；未计入的重试照旧合并", async () => {
  const { collapseFree } = await import("../src/lib/personal-usage.ts");
  const row = (at: string, kind: "task" | "qa", ratio: number | null, outcome = "ok") => ({ at, kind, alias: "legal/k3", label: "K3", tokens_in: 1, tokens_cached: 0, tokens_out: 1, outcome, partial: false, estimated: false, ...(ratio === null ? { charge_ratio: 0 } : { charge_ratio: ratio }) });
  const items = collapseFree(
    [row("2026-11-26T04:10:05.000Z", "task", 0.002), row("2026-11-26T04:10:40.000Z", "task", 0.003), row("2026-11-26T04:11:02.000Z", "task", 0.004), row("2026-11-26T04:11:30.000Z", "qa", 0.001), row("2026-11-26T04:12:00.000Z", "task", null, "upstream_error"), row("2026-11-26T04:12:30.000Z", "task", null, "upstream_error")] as never,
    1,
  );
  assert.deepEqual(items.map((x) => [x.n, x.charge.text]), [[2, "0.5%"], [1, "0.4%"], [1, "0.1%"], [2, "未计入 · 未成功"]]);
});
