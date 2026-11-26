/**
 * 第 70 批（V44）：
 * 1. 最近记录“用在哪”：whereView（任务名 · 事项名、问答会话标题、另一台电脑、点开去哪）；collapseFree 不把不同任务的调用并成一行；
 * 2. 电脑名称：deviceName / canRenameDevices / checkDeviceName；deviceLine、deviceChoiceLine、sessionLine 用名字，电脑类型挪到说明行；
 * 3. 全库统一：十张卡的立场栏都叫“我方地位”、下拉的都必填；不再写“按事项立场预选，可改”；开始面板主按钮始终是主按钮样式；
 *    “先填写”不用橙色；文字链不用蓝色；禁用主按钮用 --btn-primary-disabled（浅色、深色都定义）；标签对齐控件第一行。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { collapseFree, whereView, type UsageRow } from "../src/lib/personal-usage.ts";
import { canRenameDevices, checkDeviceName, deviceChoiceLine, deviceLine, deviceName, sessionLine, type AccountDevice } from "../src/lib/account.ts";
import { SCENARIOS } from "../src/lib/scenarios.ts";

const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test("whereView：任务 = 卡片名 + 事项名并能点开任务页；问答 = 会话标题、点开会话；另一台电脑；对不上为 null", () => {
  assert.deepEqual(whereView({ task: "诉讼成本与回收测算", matter: "锐川诉禾丰", matter_id: "mat_1", run_id: "run_1", conversation_id: null, how: "id" }), { main: "诉讼成本与回收测算", sub: "锐川诉禾丰", href: "#/run/run_1/mat_1", elsewhere: false, full: "诉讼成本与回收测算 · 锐川诉禾丰" }); // 第 71 批：悬停全称
  assert.deepEqual(whereView({ task: "问答", matter: "诉讼时效从什么时候起算？", matter_id: null, run_id: null, conversation_id: "qac_1", how: "id" }), { main: "诉讼时效从什么时候起算？", sub: null, href: "#/chat/qac_1", elsewhere: false, full: "诉讼时效从什么时候起算？" });
  assert.deepEqual(whereView({ elsewhere: true }), { main: "在另一台电脑上", sub: null, href: null, elsewhere: true, full: null });
  assert.equal(whereView(undefined), null);
});

test("collapseFree：同一分钟、同一模型但用在不同任务的调用不并成一行；同一任务的照旧合并", () => {
  const at = "2026-11-26T07:21:10.000Z";
  const row = (run: string, ratio: number): UsageRow => ({ at, kind: "task", alias: "legal/k3", label: "K3", tokens_in: 1000, tokens_cached: 0, tokens_out: 100, outcome: "ok", partial: false, estimated: false, charge_ratio: ratio, where: { task: "测算", matter: "甲诉乙", matter_id: "mat_1", run_id: run, conversation_id: null, how: "id" } });
  assert.equal(collapseFree([row("run_1", 0.01), row("run_1", 0.02)], 1).length, 1, "同一任务合并");
  assert.equal(collapseFree([row("run_1", 0.01), row("run_2", 0.02)], 1).length, 2, "不同任务不合并");
});

const dev = (o: Partial<AccountDevice>): AccountDevice => ({ device_id: "dev_qian_qian", registered_at: "2026-11-20T02:00:00Z", client_version: "0.9.1", last_seen_on: "2026-11-26", platform: "darwin", last_seen_at: "2026-11-26T06:00:00Z", session: "active", ...o });

test("电脑名称：起过名字的用名字（这台电脑写“名字（这台电脑）”），电脑类型挪到说明行；没起过照旧；旧云端没有 name 字段不显示改名", () => {
  const now = Date.parse("2026-11-26T07:00:00Z");
  assert.equal(deviceLine(dev({ name: "办公室 iMac", current: true }), now).title, "办公室 iMac（这台电脑）");
  assert.match(deviceLine(dev({ name: "办公室 iMac", current: true }), now).meta, /^Mac 电脑 · /);
  assert.equal(deviceLine(dev({ name: null, current: true }), now).title, "这台电脑");
  assert.equal(deviceLine(dev({ name: "家里的 ThinkPad", platform: "win32", device_id: "dev_qian_qian_D2" }), now).title, "家里的 ThinkPad");
  // 第 71 批：没起名字的别的电脑与选择卡、登录记录同一写法（两台同型号时靠第几台区分）
  assert.equal(deviceLine(dev({ name: null, device_id: "dev_qian_qian_D2" }), now).title, "Mac 电脑 · 第 2 台");
  const c = deviceChoiceLine(dev({ name: "办公室 iMac", device_id: "dev_qian_qian_D3" }), now);
  assert.equal(c.title, "办公室 iMac");
  assert.match(c.meta, /^Mac 电脑 · 最近使用/);
  assert.equal(deviceChoiceLine(dev({ device_id: "dev_qian_qian_D3" }), now).title, "Mac 电脑 · 第 3 台");
  assert.equal(deviceName(dev({ name: "  " })), null);
  assert.equal(canRenameDevices([dev({ name: null }), dev({ name: "甲" })]), true);
  assert.equal(canRenameDevices([dev({})]), false, "旧云端（没有 name 字段）不显示改名");
  assert.equal(canRenameDevices([]), false);
  const s = { sid: "ses_x", kind: "desktop" as const, device_id: "dev_qian_qian_D2", created_at: "2026-11-26T01:00:00Z", last_seen_at: null, idle_expires_at: "2026-12-10T01:00:00Z", client: { platform: "win32" } };
  assert.match(sessionLine(s, now, [dev({ device_id: "dev_qian_qian_D2", name: "家里的 ThinkPad" })]).title, /^家里的 ThinkPad/);
  // 第 71 批（独立评分区域 4-5）：“Windows 电脑（第 2 台） · 当前这次登录”括号后再接间隔点，改为“Windows 电脑 · 第 2 台”
  assert.match(sessionLine(s, now).title, /^Windows 电脑 · 第 2 台/);
});

test("checkDeviceName：与云端同一口径（去首尾空白并空白；空 = 去掉名字；超 20 字与控制、方向、零宽字符给原因）", () => {
  assert.deepEqual(checkDeviceName("  办公室   iMac "), { ok: true, name: "办公室 iMac" });
  assert.deepEqual(checkDeviceName(""), { ok: true, name: "" });
  assert.equal(checkDeviceName("x".repeat(21)).ok, false);
  assert.equal(checkDeviceName("a‮b").ok, false);
  assert.equal(checkDeviceName("王​律师").ok, false);
});

test("全库统一：立场栏都叫“我方地位”，下拉的都必填；开始面板不再写“按事项立场预选，可改”，主按钮始终是主按钮样式", () => {
  const sides = SCENARIOS.flatMap((c) => c.fields.filter((f) => f.key === "side").map((f) => ({ id: c.id, f })));
  assert.ok(sides.length >= 10);
  for (const { id, f } of sides) {
    assert.equal(f.label, "我方地位", id);
    if (f.kind === "select") assert.equal(f.required, true, `${id}：下拉的我方地位必填（按事项立场预选）`);
  }
  const ss = src("../src/components/ScenarioStart.tsx");
  assert.doesNotMatch(ss, /muted">按事项立场预选/, "不再渲染这句（注释里提到它不算）");
  assert.match(ss, /<button className="btn-primary" disabled=\{busy \|\| !ready\}/);
  assert.match(ss, /data-kind=\{f\.kind === "select" && f\.chips \? "chips" : f\.kind\}/);
});

test("全库统一：文字链不用蓝色；“先填写”不用橙色；禁用主按钮浅色深色都有定义；标签按控件第一行对齐", () => {
  const css = src("../src/styles.css");
  assert.match(css, /\.btn-link \{[^}]*color: var\(--text-primary\)/);
  assert.doesNotMatch(css, /\.btn-link \{[^}]*accent-text/);
  assert.match(css, /\.btn-primary:disabled \{ background: var\(--btn-primary-disabled\)/);
  const start = src("../src/styles-start.css");
  assert.doesNotMatch(start, /ss-foot-why \{[^}]*status-warning-text/);
  assert.doesNotMatch(start, /\.ss-send-more \{[^}]*accent-text/);
  assert.match(start, /\.ss3 \.ss-field \{ align-items: start; \}/);
  const tokens = readFileSync(new URL("../../../packages/design-tokens/src/tokens.css", import.meta.url), "utf8");
  assert.equal((tokens.match(/--btn-primary-disabled:/g) ?? []).length, 2, "浅色、深色各一");
  const auth = src("../src/styles-auth.css");
  assert.match(auth, /\.auth-btn:disabled \{ background: var\(--btn-primary-disabled\)/);
});
