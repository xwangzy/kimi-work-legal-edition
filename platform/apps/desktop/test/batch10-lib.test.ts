/**
 * 第 10 批 S9 期限提醒的界面文字（lib/reminders.ts）：按北京时间计“还有几天”、提醒时刻、云端状态一句话（律师语言）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rejectReasonText, scheduleLine, plannedRemindAt, audienceText, bjToday, cloudStateText, daysUntil, defaultForm, dueText, dueTone, reminderKindLabel, remindAtText, scheduleText } from "../src/lib/reminders.ts";

// 2026-10-16 23:30 北京时间 = 15:30Z
const NOW = Date.parse("2026-10-16T15:30:00.000Z");

test("按北京时间换日：UTC 还是 16 日，北京已是 16 日深夜；次日 00:30 北京即 17 日", () => {
  assert.equal(bjToday(NOW), "2026-10-16");
  assert.equal(bjToday(Date.parse("2026-10-16T16:30:00.000Z")), "2026-10-17");
  assert.equal(daysUntil("2026-10-16", NOW), 0);
  assert.equal(daysUntil("2026-10-17", NOW), 1);
  assert.equal(daysUntil("2026-10-15", NOW), -1);
  assert.deepEqual(["2026-10-16", "2026-10-17", "2026-10-20", "2026-10-14"].map((d) => dueText(d, NOW)), ["今天到期", "明天到期", "还有 4 天", "已过 2 天"]);
  assert.deepEqual(["2026-10-19", "2026-10-23", "2026-10-30"].map((d) => dueTone(d, NOW)), ["red", "orange", "plain"]);
});

test("提醒时刻按北京时间显示；提前天数与提醒对象的说法", () => {
  assert.equal(remindAtText("2026-11-27T01:00:00.000Z"), "11月27日 09:00");
  assert.equal(remindAtText("坏"), "—");
  assert.equal(scheduleText(0, "08:30"), "当天 08:30 提醒");
  assert.equal(scheduleText(3, "09:00"), "提前 3 天 09:00 提醒");
  assert.equal(audienceText("team", true), "提醒事项全体成员");
  assert.equal(audienceText("team", false), "只提醒我（个人事项）");
  assert.equal(reminderKindLabel("appeal"), "上诉期限");
  assert.equal(reminderKindLabel("x"), "期限");
  const f = defaultForm(NOW);
  assert.equal(f.due_date, "2026-10-23");
  assert.equal(f.days_before, 3);
});

test("云端状态一句话：未接通知服务如实写“电脑关机时不提醒”；用语里没有技术词", () => {
  assert.match(cloudStateText("synced", false).text, /关机时不提醒/);
  // 按实际送达的设备数说（复核 S10B-13）：只有这一台电脑时不说“其他设备也会收到”
  assert.match(cloudStateText("synced", true, { targets: 1, audience: "me" }).text, /只有这台电脑/);
  assert.match(cloudStateText("synced", true, { targets: 3, audience: "me" }).text, /其他 2 台设备也会收到/);
  assert.match(cloudStateText("synced", true, { targets: 4, audience: "team" }).text, /事项成员与你的其他设备共 3 台/);
  assert.equal(rejectReasonText("sender_revoked"), "设提醒的那台设备已停用");
  assert.equal(rejectReasonText("held_unknown_sender"), "一天内都没能核对设提醒的设备");
  assert.equal(cloudStateText("failed", true).tone, "warn");
  for (const s of ["local", "pending", "synced", "failed"]) {
    const t = cloudStateText(s, true).text;
    assert.doesNotMatch(t, /密文|版本|设备编号|租约|凭据|token|API/i, t);
  }
});

test("提醒时间一句话：期限临近被改为立即提醒的如实写出（联调回归）", () => {
  assert.equal(plannedRemindAt("2026-11-30", 3, "09:00"), "2026-11-27T01:00:00.000Z");
  assert.equal(scheduleLine({ due_date: "2026-11-30", days_before: 3, remind_time: "09:00", remind_at: "2026-11-27T01:00:00.000Z" }), "提前 3 天 09:00 提醒（11月27日 09:00）");
  assert.equal(scheduleLine({ due_date: "2026-10-17", days_before: 3, remind_time: "09:00", remind_at: "2026-10-15T17:22:00.000Z" }), "期限临近，设好时已立即提醒（10月16日 01:22）");
});
