/**
 * V10 第 36 批真实走查 V11：2027 年放假通知未发布，倒排工期按“只认元旦、劳动节、国庆”把除夕至初三当成工作日，
 * “2 月 11 日终验、留 18 天缓冲”正压在春节上。农历与节气假日的公历日期是确定的，现在 2027～2030 年按放假办法认这些天。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dayStatus, isRestDay, lunarHolidaysKnown } from "../src/tools/tools/cn-holidays.ts";
import { calcDeadline, notCollectedWarning } from "../src/tools/tools/deadline.ts";

test("2027 年：除夕至初三、清明、端午、中秋是法定假日（放假通知未收录也认）", () => {
  for (const d of ["2027-02-05", "2027-02-06", "2027-02-07", "2027-02-08", "2027-04-05", "2027-06-09", "2027-09-15"]) {
    assert.equal(isRestDay(d), true, d);
    assert.match(dayStatus(d).name ?? "", /放假办法法定假日/, d);
  }
  assert.equal(dayStatus("2027-02-09").kind, "workday", "初四（周二）不在放假办法规定的四天内，调休未知");
  assert.equal(dayStatus("2027-01-01").name, "元旦（放假办法固定日期）");
  assert.equal(lunarHolidaysKnown(2027), true);
  assert.equal(lunarHolidaysKnown(2031), false);
});

test("跨春节的期限：顺延与工作日计数都跳过除夕至初三；警告写明调休与补假未知", () => {
  const civil = calcDeadline({ start: "2027-01-22", period: { unit: "day", n: 15 }, rule: "civil" });
  assert.equal(civil.deadline, "2027-02-09", "名义末日 02-06（初一）→ 02-07、02-08 仍是假日 → 02-09");
  const work = calcDeadline({ start: "2027-02-01", period: { unit: "workday", n: 5 }, rule: "workday" });
  assert.equal(work.deadline, "2027-02-10", "02-02①、02-03②、02-04③，除夕至初三跳过，02-09④、02-10⑤");
  assert.match(notCollectedWarning(2027, "civil"), /春节除夕至初三.*调休上班与周末补假未知/);
  assert.match(notCollectedWarning(2031, "civil"), /春节、清明、端午、中秋与调休未知/);
});
