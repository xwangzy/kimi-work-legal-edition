/**
 * 第 47 批：对照 Kimi Work 桌面端重做律师端外壳与首页。
 * - 额度提示条（Kimi“月额度已不足 10%，将于 11-27 重置”）：只用控制面给的真实比例，不换算；优先级与关闭规则；本地开发 / 试用不提示；
 * - 用户卡套餐标识、菜单额度一行；
 * - 首页“推荐”：最近用过的在前，其余按缺省组合，不放两张相近的卡；
 * - 使用明细计入额度的说法；
 * - 源码门禁：侧栏 Work / Chat、事项与任务分组、用户菜单的真实入口（不放“加油包”一类购买入口）、⌘K 新建任务、
 *   任务输入框的模型只读（不是假下拉）、问答模型选择走内核真实接口。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { QuotaStatus } from "../src/api.ts";
import { LOW_REMAINING, planBadge, quotaMenuLine, quotaNotice, shortDay } from "../src/lib/quota-notice.ts";

const SRC = join(import.meta.dirname, "..", "src");
const src = (p: string) => readFileSync(join(SRC, p), "utf8");

const base = (over: Partial<QuotaStatus> = {}, firm: Partial<NonNullable<QuotaStatus["firm"]>> = {}): QuotaStatus => ({
  mode: "control_plane",
  plan: { id: "standard", label: "标准" },
  unit: "tokens",
  period: { kind: "month", key: "2026-11", start: "2026-10-31T16:00:00.000Z", resets_at: "2026-11-30T16:00:00.000Z" },
  firm: { used_ratio: 0.3, remaining_ratio: 0.7, in_flight_ratio: 0, paused: null, cap_pct: null, boost_pct: 0, legacy_used_ratio: null, used: null, total: null, seats: 5, ...firm },
  burst: null,
  own: null,
  ...over,
});

test("额度提示条：剩余不足 10% 时提示，日期按北京时间写 MM-DD；够用时不提示", () => {
  assert.equal(LOW_REMAINING, 0.1);
  assert.equal(shortDay("2026-11-30T16:00:00.000Z"), "12-01", "北京时间 12 月 1 日 0 点");
  assert.equal(quotaNotice(base()), null);
  const low = quotaNotice(base({}, { used_ratio: 0.93, remaining_ratio: 0.07 }))!;
  assert.equal(low.tone, "warn");
  assert.equal(low.text, "你本月的额度已不足 10%，将于 12-01 重置");
  assert.equal(low.key, "2026-11:firm-low");
});

test("额度提示条：用完、到律所上限、5 小时过快、个人上限的优先级与说法", () => {
  const all = quotaNotice(base({}, { used_ratio: 1, remaining_ratio: 0, paused: "allowance" }))!;
  assert.deepEqual([all.tone, all.text], ["stop", "你本月的 AI 额度已用完，新任务暂不能发起，将于 12-01 重置"]);
  const cap = quotaNotice(base({}, { used_ratio: 0.8, remaining_ratio: 0.2, paused: "cap", cap_pct: 80 }))!;
  assert.equal(cap.text, "本月用量已到设定的上限（80%），新任务暂不能发起，将于 12-01 重置");
  const burst = quotaNotice(base({ burst: { hours: 5, pct: 50, used_ratio: 1, resets_at: "2026-11-19T07:30:00.000Z" } }, { paused: "burst" }))!;
  assert.deepEqual([burst.tone, burst.text], ["warn", "最近 5 小时用得太快，AI 处理暂时放缓，15:30 起逐步恢复"]);
  const own = { used_ratio: 1, denominator: "account_limit" as const, enforced: true, used: 100, total: 100, requests: 3, tokens: 100, value_cny: null, estimated_rows: 0 };
  assert.equal(quotaNotice(base({ own }))!.text, "你的个人上限已用完，新任务暂不能发起，将于 12-01 重置");
  // 本所已暂停时说本所（更要紧），不说个人
  assert.equal(quotaNotice(base({ own }, { paused: "allowance", remaining_ratio: 0 }))!.key, "2026-11:allowance");
  // 只作参考的每人额度（不限制）满了不提示
  assert.equal(quotaNotice(base({ own: { ...own, denominator: "seat_quota", enforced: false } })), null);
});

test("额度提示条：本地开发与试用版（没有控制面）不提示、不显示套餐；周期为周时说“本周”", () => {
  assert.equal(quotaNotice({ mode: "local_dev", note: "开发形态" }), null);
  assert.equal(quotaNotice(null), null);
  assert.equal(planBadge({ mode: "local_dev", edition: "trial" }), "试用");
  assert.equal(planBadge({ mode: "local_dev" }), null);
  assert.equal(planBadge(base()), "标准");
  assert.equal(planBadge(base({ plan: { id: "x", label: "专业版" } })), "专业");
  const week = base({ period: { kind: "week", key: "2026-W47", start: "2026-11-15T16:00:00.000Z", resets_at: "2026-11-22T16:00:00.000Z" } }, { remaining_ratio: 0.05, used_ratio: 0.95 });
  assert.equal(quotaNotice(week)!.text, "你本周的额度已不足 10%，将于 11-23 重置");
  // 第 66 批：菜单只说本人用量（“套餐与用量”右侧小字）
  assert.equal(quotaMenuLine(base()), "已用 30%");
  assert.equal(quotaMenuLine({ mode: "local_dev" }), null);
});

test("首页“推荐”：最近用过的场景在前（至多 3 个），其余按缺省组合补齐 6 个，不重复", async () => {
  const { recommendedCards, RECOMMENDED_DEFAULT } = await import("../src/lib/recommend.ts");
  const fresh = recommendedCards([]);
  assert.deepEqual(
    fresh.map((c) => c.id),
    [...RECOMMENDED_DEFAULT],
  );
  const used = recommendedCards([
    { scenario: "a1.agent_task", skill: "contract-review" },
    { scenario: "s2.case_file", skill: null },
    { scenario: "a1.agent_task", skill: "contract-review" },
  ]);
  assert.equal(used.length, 6);
  assert.equal(new Set(used.map((c) => c.id)).size, 6, "不重复");
  assert.ok(used.slice(0, 2).some((c) => c.skill === "contract-review"), "最近用过的在前");
  // 自由描述的任务（没有方法）不匹配任何卡
  assert.deepEqual(recommendedCards([{ scenario: "a1.agent_task", skill: null }]).map((c) => c.id), [...RECOMMENDED_DEFAULT]);
});

test("使用明细：中断未计入、失败未计入、估算标出；元单位（第 62 批）只写占本人额度的比例（控制面给 charge_ratio，客户端不折算金额）", async () => {
  const { recordChargeText } = await import("../src/lib/firm-usage.ts");
  const row = { at: "2026-11-19T10:00:00Z", kind: "task" as const, alias: "legal/k3", label: "K3", tokens_in: 1000, tokens_cached: 800, tokens_out: 200, charge: 1200, unit: "tokens" as const, value_cny: 0.01, outcome: "ok", partial: false, estimated: false };
  assert.equal(recordChargeText(row), "1,200 token");
  assert.equal(recordChargeText({ ...row, estimated: true }), "1,200 token（估算）");
  assert.equal(recordChargeText({ ...row, partial: true, charge: 0 }), "中途中断，未计入");
  assert.equal(recordChargeText({ ...row, outcome: "upstream_error", charge: 0 }), "未成功，未计入");
  assert.equal(recordChargeText({ ...row, unit: "cny", charge: 1_653_748, charge_ratio: 0.0079 }), "占本人额度 0.8%");
  assert.equal(recordChargeText({ ...row, unit: "cny", charge: 1_653_748 }), "已计入", "旧控制面没给比例：不拿 charge 折算金额");
  assert.doesNotMatch(recordChargeText({ ...row, unit: "cny", charge: 1_653_748, charge_ratio: 0.0079 }), /元/);
  assert.equal(recordChargeText({ ...row, charge: 0, estimated: true, pending: true }), "未取得用量，未计入（待核对）");
});

test("侧栏（Kimi Work 信息架构）：Work / Chat 切换、新建任务 ⌘K、成果 / 期限提醒 / 方法库、事项与任务两个可折叠分组、Chat 模式的问答记录", () => {
  const sb = src("components/Sidebar.tsx");
  assert.match(sb, /className="mode-switch" role="tablist"/);
  assert.match(sb, />Work</);
  assert.match(sb, />Chat</);
  assert.match(sb, /data-tour="nav-chat"/);
  assert.match(sb, /<kbd>\{MOD\}<\/kbd>\s*<kbd>K<\/kbd>/);
  for (const k of ["deliverables", "reminders", "methods"]) assert.match(sb, new RegExp(`key: "${k}"`));
  assert.match(sb, /<SectionHead label="事项"/);
  assert.match(sb, /<SectionHead label="任务"/);
  assert.match(sb, /<SectionHead label="问答记录"/);
  assert.match(sb, /api\s*\.recentRuns\(8\)/, "任务分组来自内核的最近任务");
  assert.match(sb, /api\s*\.chatList\(\)/, "问答记录来自本机问答");
  assert.match(sb, /const SECTIONS_KEY = "kwl\.sidebar\.sections";/);
  assert.match(sb, /requestNewMatter\(\)/, "事项分组的 + 真能新建事项");
  // 问答页不再自带左侧列表
  assert.doesNotMatch(src("pages/Chat.tsx"), /className="chat-list"/);
});

test("用户卡与用户菜单：套餐标识、额度一行、套餐与用量 / 设置 / 上手指南 / 退出登录都是真实入口；不放购买或加油包入口", () => {
  const sb = src("components/Sidebar.tsx");
  assert.match(sb, /role="menu" aria-label="账号菜单"/);
  assert.match(sb, /go\("\/connections\/usage"\)/);
  assert.match(sb, /go\("\/connections"\)/);
  assert.match(sb, /new Event\(OPEN_GUIDE\)/);
  assert.match(sb, /account\s*\.logout\(\)/);
  assert.match(sb, /notifyAccountChanged\(\)/, "退出后通知外壳刷新登录状态");
  assert.match(sb, /className="plan-badge"/);
  assert.doesNotMatch(sb + src("pages/Home.tsx"), /加油包|去升级|开启加油|购买/, "律师端没有自助购买：不做 Kimi 的加油包入口");
  // 首页额度提示条：只有“查看用量”，指向设置 · 套餐与用量
  const home = src("pages/Home.tsx");
  assert.match(home, /quotaNotice\(quota\)/);
  assert.match(home, /nav\("\/connections\/usage"\)/);
});

test("快捷键与新建事项请求：⌘K 新建任务并聚焦输入框，Chat 模式下新建问答；从首页以外新建事项先记请求再回首页", () => {
  const app = src("App.tsx");
  assert.match(app, /if \(r\.page === "chat"\) return nav\("\/chat"\);/);
  assert.match(app, /new Event\(FOCUS_COMPOSER\)/);
  assert.match(app, /export function requestNewMatter\(\): void \{/);
  assert.match(src("pages/Home.tsx"), /if \(consumeNewMatterRequest\(\)\) setNewMatter\(true\);/);
  assert.match(src("components/Composer.tsx"), /"kwl:focus-composer"/);
});

test("输入框：运行模式在“+”右边；任务模型只读显示（不是按钮、不是下拉）；问答模型选择走内核 chat.models / chatSendWithModel", () => {
  const c = src("components/Composer.tsx");
  const bar = c.slice(c.indexOf('className="composer-bar"'), c.indexOf('className="composer-context"'));
  assert.ok(bar.indexOf("tool-plus") < bar.indexOf("<ModeSelector") && bar.indexOf("<ModeSelector") < bar.indexOf('className="spacer"'), "运行模式在左侧");
  assert.match(bar, /<span className="model-label" title="[^"]+">K3<\/span>/);
  assert.doesNotMatch(bar, /<button[^>]*model-label/);
  const chat = src("pages/Chat.tsx");
  assert.match(chat, /api\s*\.chatModels\(\)/);
  assert.match(chat, /api\.chatSendWithModel\(/);
  assert.match(chat, /m\.route_label \? `\$\{m\.route_label\} · `/, "回答下面写用的是哪个模型");
});

test("设置：用量在“套餐与用量”一页（律师与管理员同一入口）；顶部提醒是居中胶囊", () => {
  const conn = src("pages/Connections.tsx");
  assert.match(conn, /usage: "套餐与用量",/);
  assert.match(conn, /\{tab === "usage" && <PersonalUsage \/>\}/);
  assert.doesNotMatch(conn, /\["usage", "用量"\]/, "管理页不再重复一个用量子页");
  assert.match(src("App.tsx"), /className=\{`top-notice \$\{reminder\.tone === "red" \? "tone-red" : "tone-orange"\}`\}/);
  assert.match(src("pages/FirmUsage.tsx"), /我的使用明细（最近 20 条）/);
});
