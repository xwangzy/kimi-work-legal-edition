/**
 * 第 44 批：账号（登录 / 注册 / 找回密码、我的电脑、登录记录、登录失效横幅）与用量 v2（一把尺子：tokens 或元）的界面纯函数与源码门禁。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPassword, codeLengthOk, dayLabel, deviceLine, deviceOrdinal, emailLooksValid, loginRequiredText, nameLooksValid, needsLogin, passwordHints, resetNextText, roleLabel, sessionLine, waitApprovalLead } from "../src/lib/account.ts";
import { atLabel, auditActionLabel, fmtAmount, legacyNote, modelLabel, ownDenominatorText, pausedText, periodLabel, periodRange, ratioTone, remainingLine, warnText } from "../src/lib/firm-usage.ts";
import type { QuotaStatus } from "../src/api.ts";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const src = (f: string) => readFileSync(join(SRC, f), "utf8");
const NOW = Date.parse("2026-11-14T04:00:00.000Z");

test("密码规则：10–128 位、同时含字母与数字、不等于邮箱 @ 前面的部分；逐条提示即时打勾", () => {
  assert.equal(checkPassword("abc").ok, false);
  assert.equal(checkPassword("abcdefghij").ok, false, "没有数字");
  assert.equal(checkPassword("1234567890").ok, false, "没有字母");
  assert.equal(checkPassword("lawyer2026x").ok, true);
  assert.equal(checkPassword("zhang12345", "Zhang12345@example.cn").ok, false, "等于邮箱前缀（不分大小写）");
  assert.equal(checkPassword("a1".repeat(65)).length, false, "超过 128 位");
  assert.deepEqual(
    passwordHints("abc1").map((h) => [h.text, h.ok]),
    [
      ["至少 10 位", false],
      ["包含字母", true],
      ["包含数字", true],
    ],
  );
  assert.ok(passwordHints("zhang12345", "zhang12345@example.cn").some((h) => /邮箱/.test(h.text) && !h.ok));
  assert.equal(passwordHints("", "a@b.cn").length, 3, "空密码不提示邮箱那条");
});

test("邮箱、姓名、码长度的即时校验", () => {
  assert.ok(emailLooksValid(" li@example.cn "));
  for (const bad of ["li", "li@", "li@example", "l i@example.cn", ""]) assert.equal(emailLooksValid(bad), false, bad);
  assert.ok(nameLooksValid("李律师"));
  assert.equal(nameLooksValid("   "), false);
  assert.equal(nameLooksValid("字".repeat(41)), false);
  assert.ok(codeLengthOk("ABCD-EFGH-JKLM-NPQR-STUV"));
  assert.ok(codeLengthOk("A".repeat(36)));
  assert.equal(codeLengthOk("A".repeat(21)), false);
});

test("我的电脑与登录记录：第几台、这台电脑、最近使用、版本；登录方式与自动退出日；北京时间", () => {
  assert.equal(deviceOrdinal("dev_firm_li"), 1);
  assert.equal(deviceOrdinal("dev_firm_li_D3"), 3);
  const cur = deviceLine({ device_id: "dev_firm_li", registered_at: "2026-11-01T02:00:00.000Z", client_version: "0.2.0", last_seen_on: "2026-11-14", current: true, session: "active" }, NOW);
  assert.equal(cur.title, "这台电脑");
  // 第 70 批：“最近使用”改为相对时间（与电脑数已满的列表同一写法），当天写“今天”
  assert.equal(cur.meta, "11 月 1 日登记 · 最近使用 今天 · 版本 0.2.0");
  assert.deepEqual(cur.state, { text: "已登录", tone: "ok" });
  const other = deviceLine({ device_id: "dev_firm_li_D2", registered_at: "2025-12-31T17:00:00.000Z", client_version: null, last_seen_on: null, session: "none" }, NOW);
  assert.equal(other.title, "第 2 台电脑");
  assert.equal(other.meta, "2026 年 1 月 1 日登记".replace("2026 年 ", ""), "北京时间已是 1 月 1 日，今年不写年份");
  assert.equal(deviceLine({ device_id: "dev_firm_li_D2", registered_at: null, revoked_at: "2026-11-02T00:00:00Z", client_version: null, last_seen_on: null }, NOW).state.text, "已移除");
  const s = sessionLine({ sid: "ses_aaaaaaaaaaaaaaaa", kind: "desktop", device_id: "dev_firm_li_D2", created_at: "2026-11-10T01:00:00Z", last_seen_at: "2026-11-13T01:00:00Z", idle_expires_at: "2026-12-13T01:00:00Z", client: { platform: "win32" }, current: false }, NOW);
  assert.equal(s.title, "Windows 电脑（第 2 台）");
  assert.equal(s.meta, "11 月 10 日登录 · 最近活动 11 月 13 日 · 不使用到 12 月 13 日会自动退出");
  assert.match(sessionLine({ sid: "ses_bbbbbbbbbbbbbbbb", kind: "web", device_id: null, created_at: "2026-11-14T01:00:00Z", last_seen_at: null, idle_expires_at: "2026-11-14T13:00:00Z", current: true }, NOW).title, /^网页 · 当前这次登录$/);
  assert.equal(dayLabel("bad"), "—");
  assert.equal(roleLabel("partner"), "合伙人");
  assert.equal(roleLabel(undefined), "成员");
});

test("登录失效横幅：写清 AI 暂停、本机资料照常；按原因换说法；kernel.status 与 account.status 两种形状都认", () => {
  for (const r of [null, "session_expired", "session_required", "account_disabled", "session_member_mismatch"]) assert.match(loginRequiredText(r), /请重新登录（本机资料照常可用，AI 暂停）$/, String(r));
  assert.match(loginRequiredText("session_required"), /^你已退出登录/);
  assert.match(loginRequiredText("account_disabled"), /账号已停用/);
  assert.equal(needsLogin({ account: { login_required: true } }), true);
  assert.equal(needsLogin({ login_required: true }), true);
  assert.equal(needsLogin({ account: null }), false);
  assert.equal(needsLogin(null), false);
});

test("等待批准：账号新电脑——管理员本人写“在已登录的另一台电脑上批准”，其他成员写“请律所管理员在其电脑上批准”，都核对 12 位数字；找回密码按通道写下一步", () => {
  // 第 46 批：“设置 → 管理”只有管理员看得到、批准要用管理员电脑——非管理员只能请管理员在其电脑上批准；管理员本人保留原说法
  assert.match(waitApprovalLead({ firm: "示例所", who: "", viaAccount: true, admin: true }), /已登录的另一台电脑（或请律所管理员）.*核对这 12 位数字/);
  assert.match(waitApprovalLead({ firm: "示例所", who: "", viaAccount: true }), /请律所管理员在其电脑上的“设置 → 管理 → 成员”里批准这台电脑.*核对这 12 位数字/);
  assert.doesNotMatch(waitApprovalLead({ firm: "示例所", who: "", viaAccount: true, admin: false }), /你已登录的另一台电脑/);
  assert.match(waitApprovalLead({ firm: "示例所", who: "李律师 · 律师", viaAccount: false }), /^已向「示例所」申请加入（李律师 · 律师）/);
  assert.match(resetNextText({ channel: "email" }), /验证码已发到邮箱/);
  assert.match(resetNextText({ channel: "admin" }), /管理员或客服要一个重置码/);
  assert.equal(resetNextText({ channel: "email", message: "中软的说明" }), "中软的说明");
});

const firm = { used_ratio: 0.42, remaining_ratio: 0.58, in_flight_ratio: 0.01, paused: null, cap_pct: null, boost_pct: 0, legacy_used_ratio: null, used: 4_200_000, total: 10_000_000, seats: 2 };
const base: QuotaStatus = {
  mode: "control_plane",
  plan: { id: "trial", label: "试用" },
  unit: "tokens",
  unit_label: "tokens",
  period: { kind: "month", key: "2026-11", start: "2026-10-31T16:00:00.000Z", resets_at: "2026-11-30T16:00:00.000Z" },
  firm: firm as NonNullable<QuotaStatus["firm"]>,
  burst: null,
  own: { used_ratio: 0.2, denominator: "seat_quota", enforced: false, used: 1_000_000, total: 5_000_000, requests: 12, tokens: 1_000_000, value_cny: 3.2, estimated_rows: 0 },
  history: [],
  models: [],
};

test("用量 v2：单位只有 tokens 与元（过万写万、过亿写亿；元两位小数）；剩余带约数只在看得到总额时；周期与重置写成北京时间", () => {
  assert.equal(fmtAmount(1234, "tokens", "tokens"), "1,234 tokens");
  assert.equal(fmtAmount(4_200_000, "tokens", "tokens"), "420 万 tokens");
  assert.equal(fmtAmount(12_345, "tokens"), "1.2 万 tokens");
  assert.equal(fmtAmount(250_000_000, "tokens"), "2.5 亿 tokens");
  assert.equal(fmtAmount(12.3456, "cny", "元"), "12.35 元");
  assert.equal(fmtAmount(1234.5, "cny", "元"), "1,234.5 元");
  assert.equal(fmtAmount(0.004, "cny", "元"), "不到 0.01 元");
  assert.equal(fmtAmount(null, "cny"), "—");
  assert.equal(remainingLine(base), "剩余 58%（约 580 万 tokens）");
  assert.equal(remainingLine({ ...base, firm: { ...base.firm!, used: null, total: null } }), "剩余 58%", "成员看不到总额：只写比例");
  // 第 62 批：额度按价目（元）计——律师端只看百分比，管理员也不显示金额约数
  assert.equal(remainingLine({ ...base, unit: "cny", unit_label: "元", firm: { ...base.firm!, used: 88.2, total: 210 } }), "剩余 58%");
  assert.equal(periodLabel(base.period), "2026 年 11 月");
  assert.equal(periodRange(base.period), "11 月 1 日 – 11 月 30 日");
  assert.equal(periodLabel({ kind: "week", key: "2026-W46", start: "2026-11-08T16:00:00.000Z", resets_at: "2026-11-15T16:00:00.000Z" }), "本周（11 月 9 日起）");
  assert.equal(atLabel("2026-11-14T07:30:00.000Z"), "11 月 14 日 15:30");
  assert.equal(ownDenominatorText(base.own!), "每人额度（套餐约定，仅作参考、不限制）");
  assert.equal(ownDenominatorText({ ...base.own!, denominator: "account_limit", enforced: true }), "个人上限（管理员设置）");
  assert.equal(modelLabel("legal/k3"), "Kimi K3（主任务）");
  assert.equal(modelLabel("legal/custom-x"), "custom-x");
});

test("用量 v2：暂停三种原因（上限、用完、5 小时频率）；80% 提醒；旧计量口径注明；水位", () => {
  assert.equal(pausedText(base), null);
  assert.match(pausedText({ ...base, firm: { ...base.firm!, paused: "allowance", used_ratio: 1 } })!, /AI 额度已用完（100%）.*或等 12 月 1 日 0:00 重置/);
  assert.match(pausedText({ ...base, firm: { ...base.firm!, paused: "cap", cap_pct: 80 } })!, /已到律所设的上限（80%）/);
  assert.match(pausedText({ ...base, burst: { hours: 5, pct: 20, used_ratio: 1, resets_at: "2026-11-14T09:00:00.000Z" }, firm: { ...base.firm!, paused: "burst" } })!, /最近 5 小时用得太快（超过本期额度的 20%）.*11 月 14 日 17:00 起恢复/);
  assert.equal(warnText(base), null);
  assert.match(warnText({ ...base, firm: { ...base.firm!, used_ratio: 0.85 } })!, /已用 85%，额度即将用完/);
  assert.match(warnText({ ...base, burst: { hours: 5, pct: 20, used_ratio: 0.9, resets_at: null } })!, /最近 5 小时已用到频率上限的 90%/);
  assert.equal(legacyNote(base), null);
  assert.match(legacyNote({ ...base, firm: { ...base.firm!, legacy_used_ratio: 0.12 } })!, /^本期含旧计量口径的用量 12%/);
  assert.deepEqual([0.5, 0.8, 1].map(ratioTone), ["ok", "high", "full"]);
  for (const t of [pausedText({ ...base, firm: { ...base.firm!, paused: "allowance" } }), warnText({ ...base, firm: { ...base.firm!, used_ratio: 0.9 } }), remainingLine(base), legacyNote({ ...base, firm: { ...base.firm!, legacy_used_ratio: 0.1 } })]) {
    assert.doesNotMatch(t ?? "", /点数|积分|单位|席位|租约|网关/, String(t));
  }
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?|css)$/.test(n) ? [p] : [];
  });
}

test("源码门禁：Kimi 账号绑定已撤（组件、方法、样式）；渲染层不出现“旧版点数”“旧版计量”“积分”；旧审计“加量”", () => {
  for (const f of files(SRC)) {
    const t = readFileSync(f, "utf8");
    assert.doesNotMatch(t, /KimiAccountRow|kimi_status|kimi_start|kimi_poll|kimi_unbind|kimiAccountLabel|\.kimi-/, f);
    assert.doesNotMatch(t, /旧版点数|旧版计量|积分/, f);
  }
  assert.equal(auditActionLabel("quota.grant"), "加量");
});

test("源码门禁：激活页缺省登录、可切注册与忘记密码，保留开通码与从备份恢复；退出登录与解绑用自绘确认；App 有登录失效横幅与轮询", () => {
  const act = src("pages/Activate.tsx");
  assert.match(act, /\? "restore" : "login"\);/, "缺省登录");
  for (const s of ["account.login(", "account.register(", "account.resetRequest(", "account.resetConfirm(", "onboarding.redeem(", "<RestoreFromBackup", "via_account", "firm_check_code", "next === \"blocked\""]) assert.ok(act.includes(s), s);
  const panel = src("components/AccountPanel.tsx");
  const flat = panel.replace(/\s+/g, "");
  for (const s of ["account.unbindDevice(", "account.revokeSession(", "account.changePassword(", "account.logout(", "<Modal", "<ConfirmButton"]) assert.ok(flat.includes(s), s);
  assert.doesNotMatch(panel, /window\.confirm\(/);
  assert.match(panel, /AI 处理暂停.*照常保留、照常可用/);
  const app = src("App.tsx");
  assert.match(app, /account\s*\.status\(\)/);
  assert.match(app, /setInterval\(refresh, 30_000\)/);
  assert.match(app, /"account\.login_required"/);
  // 第 64 批：登录失效 → 整窗重新登录页（不再是顶部横幅）
  assert.match(app, /<ReloginPage/);
  const conn = src("pages/Connections.tsx");
  assert.match(conn, /每次 AI 调用的用量（请求编号、模型、token 数、金额）；看不到内容/);
  // 第 47 批：用量移到设置的“套餐与用量”页，律师与管理员同一个入口（管理员另有用量数、按成员与上限）
  // 第 66 批：“套餐与用量”只给个人视图；本所额度与上限在“管理 · 用量与上限”
  // 第 68 批：客户端不再展示团队用量——“管理 · 用量与上限”移除，团队用量与上限统一在云端控制台
  assert.match(conn, /\{tab === "usage" && <PersonalUsage admin=\{isAdmin\} \/>\}/);
  assert.doesNotMatch(conn, /UsagePanel|\["usage", "用量与上限"\]/);
});

test("第 44 批真实验收的发现：时间线里本产品的额度规则写“暂停”，不写“AI 服务连不上”", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../src/lib/timeline.ts", import.meta.url), "utf8");
  assert.match(src, /OWN_QUOTA_RE = \/频率窗口\|额度已用完\|用量上限\|个人额度/);
  assert.match(src, /AI 额度暂时用到限制，这一步暂停/);
});

test("第 44 批真实验收的发现：重新运行后，“还有没做完的地方”只列最后一次运行的问题，上一次的额度暂停不再列", async () => {
  const { buildSteps, problemSteps } = await import("../src/lib/timeline.ts");
  const ev = (id: number, type: string, payload: Record<string, unknown>) => ({ event_id: id, seq: id, type, payload, created_at: "2026-11-14T05:30:00.000Z" }) as any;
  const steps = buildSteps([
    ev(1, "run.started", {}),
    ev(2, "agent.error", { code: "provider.http_402", message: "402 短时间内用量过多（频率窗口已满），请稍后再试", retryable: false }),
    ev(3, "run.failed", { error: "任务没有完成：402 短时间内用量过多（频率窗口已满），请稍后再试" }),
    ev(4, "run.started", {}),
    ev(5, "review.followup", { must: 1, done: 0, justified: 0, open: [1], unknown: [] }),
    ev(6, "run.partial", {}),
  ]);
  const titles = problemSteps(steps).map((s) => s.title);
  assert.ok(titles.some((t) => t.includes("第 1 条没有落实到文件")), titles.join(" | "));
  assert.ok(!titles.some((t) => /额度|402|频率窗口/.test(t)), titles.join(" | "));
  // 只有一次运行时照旧
  const once = buildSteps([ev(1, "run.started", {}), ev(2, "agent.error", { code: "provider.http_402", message: "402 本期 AI 额度已用完", retryable: false }), ev(3, "run.failed", { error: "额度用完" })]);
  assert.ok(problemSteps(once).some((s) => s.title === "AI 额度暂时用到限制，这一步暂停"));
});
