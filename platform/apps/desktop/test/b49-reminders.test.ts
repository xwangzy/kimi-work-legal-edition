/**
 * 第 49 批：期限提醒页信息架构精修——我设的与收到的提醒合成一份日程，新到的就地标“新”，不再另起一块重复列同一条；
 * 远近只用倒计时文字颜色。这里测纯函数 agendaEntries / countTone 与页面结构。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { agendaEntries, countTone, dueBuckets } from "../src/lib/reminders.ts";

const mine = (id: string, due: string, extra: Record<string, unknown> = {}) => ({ reminder_id: id, due_date: due, cloud_state: "local", ...extra });
const got = (id: string, version: number, due: string, read_at: string | null, extra: Record<string, unknown> = {}) => ({ reminder_id: id, version, due_date: due, read_at, ...extra });

test("合成日程：我设的提醒的未读收件就地标“新”（不再另列一行）", () => {
  const { entries, history, unread } = agendaEntries([mine("r1", "2026-11-22"), mine("r2", "2026-11-26")], [got("r1", 1, "2026-11-22", null), got("r1", 2, "2026-11-22", null)]);
  assert.equal(entries.length, 2, "同一条只出现一次");
  const r1 = entries.find((e) => e.key === "r1")!;
  assert.deepEqual(r1.fresh.map((i) => i.version), [1, 2], "“知道了”提交这一行全部未读版本");
  assert.equal(entries.find((e) => e.key === "r2")!.fresh.length, 0);
  assert.equal(unread.length, 2);
  assert.equal(history.length, 0);
});

test("合成日程：事项成员设的、别的设备送来的未读提醒单独成行（只能“知道了”），取最新版本的日期", () => {
  const { entries } = agendaEntries([mine("r1", "2026-11-22")], [got("t9", 1, "2026-11-23", null, { from_me: false }), got("t9", 2, "2026-11-24", null, { from_me: false })]);
  const t9 = entries.find((e) => e.key === "in:t9")!;
  assert.equal(t9.reminder, null);
  assert.equal(t9.received!.version, 2);
  assert.equal(t9.due_date, "2026-11-24");
  assert.equal(t9.fresh.length, 2);
});

test("看过的提醒：已读且日程里还有这条的不重复列；已读且日程里没有的进页底", () => {
  const { entries, history } = agendaEntries([mine("r1", "2026-11-22")], [got("r1", 1, "2026-11-22", "2026-11-19T01:00:00Z"), got("gone", 1, "2026-11-10", "2026-11-08T01:00:00Z")]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.fresh.length, 0, "已读的不标“新”");
  assert.deepEqual(history.map((i) => i.reminder_id), ["gone"]);
});

test("分组仍按到期日：今天 / 7 天内 / 以后 / 已过期；已撤销的不列；收到的提醒也参与分组", () => {
  const now = Date.parse("2026-11-20T04:00:00Z");
  const { entries } = agendaEntries([mine("a", "2026-11-20"), mine("b", "2026-11-26"), mine("c", "2026-12-18"), mine("d", "2026-11-01"), mine("x", "2026-11-21", { cloud_state: "cancelled" })], [got("in", 1, "2026-11-22", null)]);
  const b = dueBuckets(entries, now);
  assert.deepEqual(
    b.map((g) => [g.key, g.items.map((e) => e.key)]),
    [
      ["today", ["a"]],
      ["week", ["in:in", "b"]],
      ["later", ["c"]],
      ["past", ["d"]],
    ],
  );
});

test("倒计时颜色是唯一的远近信号：3 天内红、7 天内橙、更远平常、过期另一档", () => {
  const now = Date.parse("2026-11-20T04:00:00Z");
  assert.equal(countTone("2026-11-22", now), "red");
  assert.equal(countTone("2026-11-26", now), "orange");
  assert.equal(countTone("2026-12-05", now), "plain");
  assert.equal(countTone("2026-11-19", now), "past");
});

test("页面结构：不再有“新到的提醒（n）”块与左侧色条；新到的标圆点 + 读屏文字；操作悬停出现且键盘可达", () => {
  const page = readFileSync(new URL("../src/pages/Reminders.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/styles-reminders.css", import.meta.url), "utf8");
  assert.doesNotMatch(page, /新到的提醒（\{unread\.length\}）/);
  assert.doesNotMatch(page, /className="rm-inbox"/);
  assert.match(page, /<span className="sr-only">新到的提醒：<\/span>/);
  assert.match(page, /import "\.\.\/styles-reminders\.css";/);
  assert.doesNotMatch(css, /border-left/, "不再用左侧色条");
  assert.doesNotMatch(css, /\.rm-count-red \{[^}]*background/, "倒计时不再叠胶囊底色");
  // 操作平时用 clip-path 裁掉（visibility: hidden 的按钮键盘 Tab 不到；降透明度门禁不许），悬停或聚焦时出现
  assert.match(css, /\.rm-actions \{[^}]*clip-path: inset\(0 0 0 100%\)/);
  assert.match(css, /\.rm-row:hover \.rm-actions, \.rm-row:focus-within \.rm-actions \{ clip-path: none; pointer-events: auto; \}/);
  assert.doesNotMatch(css, /\.rm-actions \{[^}]*(visibility: hidden|opacity: 0)/);
});
