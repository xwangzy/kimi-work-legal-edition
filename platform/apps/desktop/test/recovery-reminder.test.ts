/**
 * 恢复与备份提醒（第 14 批第二轮复核 R2B-05、R2B-06）：缺哪样说哪样；备份盘不是原来那块有专门的一句。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { recoveryReminder } from "../src/lib/recovery-reminder.ts";

test("提醒按情形给出：未生成恢复包 → 未设备份位置 → 备份盘换了 → 上次失败 → 多日未备份；吊销后不提醒", () => {
  assert.match(recoveryReminder({ packages_created: 0 })!.text, /生成恢复包/);
  assert.match(recoveryReminder({ packages_created: 1, configured: false })!.text, /还没有设置备份位置/);
  const changed = recoveryReminder({ packages_created: 1, configured: true, last_error: "location_changed" })!;
  assert.match(changed.text, /备份盘不是原来那块/);
  assert.equal(changed.tone, "red");
  assert.equal(changed.everywhere, true);
  assert.match(recoveryReminder({ packages_created: 1, configured: true, last_error: "ENOSPC" })!.text, /没有成功/);
  assert.match(recoveryReminder({ packages_created: 1, configured: true, stale_days: 4 })!.text, /4 天/);
  assert.equal(recoveryReminder({ packages_created: 1, configured: true, stale_days: 1 }), null);
  assert.equal(recoveryReminder({ revoked: true, packages_created: 0 }), null);
});
