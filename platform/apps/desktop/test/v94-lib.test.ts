/**
 * v9.4 新增纯函数的用例（复核 Q1-24）：备份提醒推迟、本地日期、近期期限、本机与安全三块结论、卡片方法参数。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { localDay, reminderSnoozed } from "../src/lib/recovery-reminder.ts";
import { upcomingDeadlines } from "../src/lib/reminders.ts";
import { backupTile, deviceSafetyTile } from "../src/lib/device-status.ts";
import { skillArgsOf } from "../src/lib/scenarios.ts";

test("明天提醒：橙色可推到明天、红色不能推；跨月跨年按本地日期", () => {
  assert.equal(reminderSnoozed({ tone: "orange" }, "2026-10-22", "2026-10-21"), true);
  assert.equal(reminderSnoozed({ tone: "orange" }, "2026-10-22", "2026-10-22"), false, "到了那一天就再提醒");
  assert.equal(reminderSnoozed({ tone: "red" }, "2026-10-22", "2026-10-21"), false, "备份失败等红色提醒不能推迟");
  assert.equal(reminderSnoozed({ tone: "orange" }, null, "2026-10-21"), false);
  assert.equal(localDay(1, new Date(2026, 11, 31, 23, 59)), "2027-01-01");
  assert.equal(localDay(1, new Date(2026, 1, 28, 8)), "2026-03-01");
});

test("近期期限：只列未结案、未撤销、14 天内（含已过 3 天内）的，按到期日排序", () => {
  const now = Date.parse("2026-10-21T04:00:00Z"); // 北京时间 12:00
  const r = (due_date: string, o: Partial<{ cloud_state: string; matter_lifecycle: string }> = {}) => ({ due_date, cloud_state: "local", matter_lifecycle: "active", ...o });
  const out = upcomingDeadlines([r("2026-11-10"), r("2026-10-30"), r("2026-10-18"), r("2026-10-17"), r("2026-10-25", { cloud_state: "cancelled" }), r("2026-10-26", { matter_lifecycle: "closed" }), r("2026-11-04")], now);
  assert.deepEqual(out.map((x) => x.due_date), ["2026-10-18", "2026-10-30", "2026-11-04"]);
});

test("本机与安全“案卷安全”：不写“AI 计算时不联网”（复核 Q1-12）；电脑环境有警告、退出状态时不显示 ✓（复核 Q1-13）", () => {
  const ok = deviceSafetyTile(true, true);
  assert.equal(ok.tone, "ok");
  assert.doesNotMatch(ok.line, /AI 计算时不联网/);
  assert.match(ok.line, /本机计算不联网/);
  assert.equal(deviceSafetyTile(true, true, { envWarn: 2 }).tone, "warn");
  assert.match(deviceSafetyTile(true, true, { envWarn: 2 }).line, /2 项/);
  assert.equal(deviceSafetyTile(true, true, { exitMessage: "许可已到期" }).tone, "warn");
  assert.equal(deviceSafetyTile(false, true).tone, "warn");
  assert.equal(deviceSafetyTile(true, false).tone, "warn");
});

test("备份结论：缺恢复包 → 未设备份 → 没成功过 → 3 天没成功 → 正常", () => {
  assert.equal(backupTile(null).tone, "info");
  assert.match(backupTile({ packages_created: 0 }).line, /还没有恢复包/);
  assert.match(backupTile({ packages_created: 1, configured: false }).line, /还没有设置每天自动备份/);
  assert.match(backupTile({ packages_created: 1, configured: true, last_ok_at: null }).line, /还没有成功过/);
  assert.match(backupTile({ packages_created: 1, configured: true, last_ok_at: "2026-10-17T01:00:00Z", stale_days: 4 }).line, /4 天/);
  assert.equal(backupTile({ packages_created: 1, configured: true, last_ok_at: "2026-10-21T01:00:00Z", stale_days: 0 }).tone, "ok");
});

test("卡片方法参数：固定参数在前、律师填写的覆盖同名；空值不传；多选用“、”；每项至多 300 字；键名不合法的不传", () => {
  const card = { args: { mode: "仲裁应对", side: "用人单位" }, fields: [{ key: "claim", label: "", kind: "text" as const }, { key: "focus", label: "", kind: "multi" as const }, { key: "empty", label: "", kind: "text" as const }, { key: "Bad", label: "", kind: "text" as const }] };
  const out = skillArgsOf(card, { claim: " 支付加班费 ", focus: ["付款", "违约责任"], empty: "  ", Bad: "x" });
  assert.deepEqual(out, { mode: "仲裁应对", side: "用人单位", claim: "支付加班费", focus: "付款、违约责任" });
  assert.equal([...skillArgsOf({ fields: [{ key: "claim", label: "", kind: "text" }] }, { claim: "字".repeat(400) }).claim!].length, 300);
});
