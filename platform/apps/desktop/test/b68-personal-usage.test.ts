/**
 * 第 68 批：“设置 · 套餐与用量”只给本人用量的守护用例——个人口径（personal 块、单席位与多人律所的区别）、明细分母折算、
 * 状态句、套餐说明去金额、倒计时与“今天”刻度、按日分组；以及“客户端不再展示团队用量”的源码门禁。
 * 样例数字取自 2026-11-26 本机全链路真实租户（试用、单席位、本期加量 +100%）：personal 0.3089、own 0.6178、明细 charge_ratio 0.0089。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { QuotaStatus } from "../src/api.ts";
import { burstView, dayGroups, limitedNote, ownModels, periodElapsed, personalUsedRatio, personalView, planNoteText, resetCountdown, rowCharge, rowScale, usageStatus, usageTone } from "../src/lib/personal-usage.ts";
import { quotaMenuLine, quotaNotice } from "../src/lib/quota-notice.ts";

const src = (p: string) => readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const PERIOD = { kind: "month" as const, key: "2026-11", start: "2026-10-31T16:00:00.000Z", resets_at: "2026-11-30T16:00:00.000Z" };
const OWN = { used_ratio: 0.6178, denominator: "seat_quota" as const, enforced: false, used: 51.89, total: 84, requests: 77, tokens: 7_089_734, value_cny: null, estimated_rows: 0 };
const q = (over: Partial<QuotaStatus> = {}, firm: Partial<NonNullable<QuotaStatus["firm"]>> = {}): QuotaStatus =>
  ({
    mode: "control_plane",
    plan: { id: "trial", label: "试用", note: "自助注册试用 14 天，84 元额度（按价目计），约 10 单常规任务", period: "month", burst: { hours: 5, pct: 50 }, models: ["K3", "K3 高速", "K2.6"] },
    unit: "cny",
    period: PERIOD,
    firm: { used_ratio: 0.3089, remaining_ratio: 0.6911, in_flight_ratio: 0, paused: null, cap_pct: null, boost_pct: 100, legacy_used_ratio: null, used: null, total: null, seats: 1, ...firm },
    burst: { hours: 5, pct: 50, used_ratio: 0, resets_at: null },
    own: OWN,
    personal: { used_ratio: 0.3089, remaining_ratio: 0.5, limited_by: "burst", paused: null },
    own_models: [{ alias: "legal/k3-fast", label: "K3 高速", share: 1, requests: 77 }],
    ...over,
  }) as QuotaStatus;

test("个人口径（真实租户）：大数字取 personal；5 小时窗口卡住时月度剩余不被压低；单席位的在途画进个人条", () => {
  const v = personalView(q());
  assert.equal(v.used, 0.3089);
  assert.ok(Math.abs(v.left - 0.6911) < 1e-9, "被 5 小时窗口卡住（now = 50%）时，月度剩余仍是 1 − 已用");
  assert.equal(v.now, 0.5);
  assert.equal(v.solo, true);
  assert.equal(v.capped, true);
  const f = personalView(q({}, { in_flight_ratio: 0.05 }));
  assert.equal(f.inFlight, 0.05, "单席位：在途就是本人的、分母相同");
  assert.ok(Math.abs(f.used + f.inFlight + f.available - 1) < 1e-9, "已用 + 预留 + 可用 = 整条");
  assert.equal(usageTone(v), "ok");
  assert.equal(usageStatus(q(), v, "12 月 1 日 00:00", ""), null, "正常时不说话");
});

test("多人律所：不把全所的在途、5 小时窗口、按模型当成本人的；没设个人上限时用超个人份额不算用完", () => {
  const multi = q({ own_models: undefined, models: [{ alias: "legal/k3", label: "K3", used: 1, share: 1, requests: 9 }] }, { seats: 5, in_flight_ratio: 0.2 });
  const v = personalView(multi);
  assert.equal(v.solo, false);
  assert.equal(v.inFlight, 0, "全所在途 ÷ 全所额度，不画进个人条");
  assert.deepEqual(ownModels(multi, v), [], "旧云端的 models 是全所的，多人律所不拿来当本人的");
  assert.equal(ownModels(q(), personalView(q()))[0]!.label, "K3 高速");
  // 软份额：每人额度不对个人生效（own.enforced = false）
  const over = q({ personal: { used_ratio: 1.2, remaining_ratio: 0.6, limited_by: "allowance", paused: null } }, { seats: 5 });
  const vo = personalView(over);
  assert.equal(vo.capped, false);
  assert.equal(usageTone(vo), "high", "用超份额是提醒，不是停用");
  assert.match(usageStatus(over, vo, "", "")!.text, /已超出你本月的个人份额/);
  assert.equal(quotaNotice(over), null, "首页提示条不因软份额报“不足 10%”");
  // 旧云端没有 personal：多人律所回退到本人分母（own），不再拿全所的 used_ratio 当“我的”
  assert.equal(personalUsedRatio({ firm: multi.firm, own: { ...OWN, used_ratio: 0.42 } }), 0.42);
  assert.equal(personalUsedRatio({ firm: q().firm, own: OWN }), 0.3089, "单人工作室：本期额度就是本人套餐");
});

test("被停与受限：额度用完、管理员上限、个人额度（seat）、5 小时放缓各有一句；剩余被上限压低时说明原因", () => {
  const at = "12 月 1 日 00:00";
  const seat = q({ own: { ...OWN, enforced: true, denominator: "account_limit", used_ratio: 1 }, personal: { used_ratio: 1, remaining_ratio: 0, limited_by: "seat", paused: "seat" } }, { seats: 5 });
  assert.equal(usageStatus(seat, personalView(seat), at, "")!.text, "你的个人额度已用完，新任务暂不能发起；12 月 1 日 00:00 重置后恢复。");
  assert.equal(usageTone(personalView(seat)), "full");
  assert.deepEqual([quotaNotice(seat)!.tone, quotaNotice(seat)!.text], ["stop", "你的个人额度已用完，新任务暂不能发起，将于 12-01 重置"], "首页提示条认得 seat");
  const all = q({ personal: { used_ratio: 1, remaining_ratio: 0, limited_by: "allowance", paused: "allowance" } });
  // 第 69 批（独立评审 R6-2）：用完时状态句末尾直接说去哪要更多额度（原来要滚到页面下方的套餐卡才看得到）
  assert.match(usageStatus(all, personalView(all), at, "")!.text, /^本月额度已用完，新任务暂不能发起；12 月 1 日 00:00 重置后恢复。需要更多额度，请联系客户经理或客服。$/);
  const cap = q({ personal: { used_ratio: 0.5, remaining_ratio: 0.3, limited_by: "cap", paused: null } });
  const vc = personalView(cap);
  assert.ok(Math.abs(vc.left - 0.3) < 1e-9, "上限压低了此刻能用的");
  assert.equal(limitedNote(vc), "受管理员设定的上限限制");
  const burst = q({ burst: { hours: 5, pct: 50, used_ratio: 1, resets_at: "2026-11-26T07:30:00.000Z" }, personal: { used_ratio: 0.6, remaining_ratio: 0, limited_by: "burst", paused: "burst" } });
  const vb = personalView(burst);
  assert.equal(usageStatus(burst, vb, at, "15:30")!.text, "最近 5 小时用量较多，AI 处理暂时放缓，15:30 起恢复。");
  assert.equal(usageTone(vb), "ok", "5 小时放缓不把整月染红");
  assert.ok(Math.abs(burstView(burst.burst!, vb).available) < 1e-9);
  const low = q({ personal: { used_ratio: 0.95, remaining_ratio: 0.05, limited_by: "allowance", paused: null } });
  assert.match(usageStatus(low, personalView(low), at, "")!.text, /剩余不足 10%；需要更多额度，请联系客户经理或客服/);
  assert.equal(usageTone(personalView(low)), "high");
});

test("明细“计入额度”折到大数字的分母：真实租户 own 0.6178 / personal 0.3089 → 系数 0.5；控制面改成同一分母（ratio_basis）后不再折算", () => {
  const scale = rowScale(q());
  assert.ok(Math.abs(scale - 0.5) < 1e-9);
  assert.equal(rowCharge({ at: "2026-11-25T19:51:42.515Z", kind: "task", alias: "legal/k3-fast", label: "K3 高速", tokens_in: 1, tokens_cached: 0, tokens_out: 1, outcome: "ok", partial: false, estimated: false, charge_ratio: 0.0089 }, scale).text, "0.4%");
  assert.equal(rowScale({ ...q(), ratio_basis: "personal" } as QuotaStatus), 1);
  assert.equal(rowScale(q({ own: null })), 1, "没有 own 时不折算");
  const base = { at: "x", kind: "task" as const, alias: null, label: null, tokens_in: 0, tokens_cached: 0, tokens_out: 0, outcome: "ok", partial: false, estimated: false };
  assert.deepEqual(rowCharge({ ...base, partial: true, charge_ratio: 0.01 }, 1), { counted: false, text: "未计入 · 中途中断" });
  assert.deepEqual(rowCharge({ ...base, pending: true, charge_ratio: 0 }, 1), { counted: false, text: "未计入 · 待核对" });
  assert.deepEqual(rowCharge({ ...base, outcome: "upstream_error", charge_ratio: 0 }, 1), { counted: false, text: "未计入 · 未成功" });
  assert.deepEqual(rowCharge({ ...base, outcome: "client_gone", charge_ratio: 0.0089 }, 1), { counted: true, text: "0.9%" }, "中途离开但已产生用量的照常计入");
  assert.equal(rowCharge({ ...base, estimated: true, charge_ratio: 0.02 }, 1).text, "2%（估算）");
  assert.deepEqual(rowCharge({ ...base, charge: 5 }, 1), { counted: true, text: "已计入" }, "旧云端没有比例：只说计入，不显示数量或金额");
});

test("套餐说明去掉金额与原始计数；倒计时、“今天”刻度与按日分组按北京时间", () => {
  assert.equal(planNoteText("自助注册试用 14 天，84 元额度（按价目计），约 10 单常规任务"), "自助注册试用 14 天，约 10 单常规任务");
  assert.equal(planNoteText("自助注册试用 14 天，2,000 万 token，约 10 单常规任务"), "自助注册试用 14 天，约 10 单常规任务");
  assert.equal(planNoteText("每月 84 元额度（按价目计）"), "每月");
  assert.equal(planNoteText(null), "");
  const now = Date.parse("2026-11-26T02:00:00.000Z"); // 北京 11 月 26 日 10:00
  assert.equal(resetCountdown(PERIOD.resets_at, now), "还有 4 天");
  assert.equal(resetCountdown(PERIOD.resets_at, Date.parse("2026-11-30T11:00:00.000Z")), "还有 5 小时");
  assert.equal(resetCountdown(PERIOD.resets_at, Date.parse("2026-11-30T15:30:00.000Z")), "不到 1 小时");
  assert.equal(resetCountdown(PERIOD.resets_at, Date.parse("2026-12-01T00:00:00.000Z")), "");
  const e = periodElapsed(PERIOD, now)!;
  assert.ok(Math.abs(e - (25 * 24 + 10) / (30 * 24)) < 1e-9, "11 月过去了 25 天 10 小时");
  assert.equal(periodElapsed(undefined, now), null);
  const g = dayGroups(
    [
      { at: "2026-11-26T01:00:00.000Z" }, // 北京 26 日 09:00
      { at: "2026-11-25T17:00:00.000Z" }, // 北京 26 日 01:00
      { at: "2026-11-25T15:00:00.000Z" }, // 北京 25 日 23:00
      { at: "2026-11-02T03:00:00.000Z", in_period: true },
      { at: "2026-10-30T03:00:00.000Z", in_period: false },
    ],
    now,
  );
  assert.deepEqual(g.map((x) => [x.label, x.rows.length, x.earlier]), [["今天", 2, false], ["昨天", 1, false], ["11 月 2 日", 1, false], ["10 月 30 日", 1, true]]);
});

test("菜单小字与页面同一个数；本地开发、试用版不显示", () => {
  assert.equal(quotaMenuLine(q()), "已用 31%");
  assert.equal(quotaMenuLine({ mode: "local_dev" }), null);
  assert.equal(quotaNotice(q()), null);
});

test("源码门禁：客户端不再展示团队用量；页面只讲本人、不出现金额点数与“本所”；套餐收成一块（第 69 批起不再用设置行）", () => {
  const conn = src("pages/Connections.tsx");
  assert.match(conn, /\{tab === "usage" && <PersonalUsage admin=\{isAdmin\} \/>\}/);
  assert.doesNotMatch(strip(conn), /UsagePanel|用量与上限/, "管理里不再有“用量与上限”");
  const firm = src("pages/FirmUsage.tsx");
  assert.doesNotMatch(strip(firm), /export function UsagePanel|by_member|quotaSetCap|quotaStatus/, "本所用量面板已移除，只剩操作记录");
  const page = src("pages/PersonalUsage.tsx");
  const code = strip(page);
  assert.doesNotMatch(code, /本所|by_member|cap_pct|q\.firm\.used_ratio|value_cny|点数|积分|¥|元/);
  assert.match(code, /团队用量与上限/, "管理员看到的那一句");
  assert.match(code, /\{admin && !v\.solo && <p className="pu-plan-admin">团队用量与上限请在云端控制台管理/);
  // 第 69 批第六轮：“需要更多额度”改为小标题 + 值两行
  assert.match(code, /id="pu-plan-h"[\s\S]*<span className="pu-k">需要更多额度<\/span>\s*<span>请联系客户经理或客服<\/span>/, "套餐块：套餐名、可用模型、更多额度（不做购买入口）");
  assert.match(code, /api\.quotaUsagePage\(/, "更早的明细来自云端账本翻页");
  assert.match(code, /<DailyBars/, "第 69 批：每日柱（今天高亮）代替进度条上的“今天”刻度");
  assert.doesNotMatch(code, /setTimeout|Math\.random|mock/i, "不做伪数据与伪交互");
  assert.match(page, /id="sec-usage"/);
});
