/**
 * 第 55 批 K3（审计 B 5.3）：席位令牌取不到时，按最近一次同步“取席位令牌”那一步的结果码说清原因与办法——
 * 席位用完（控制面答 no_seat）说“请联系管理员释放或增购”，不再只说“席位令牌未取得或已失效”。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SEAT_NONE_REASON, SEAT_PENDING_REASON, SEAT_REVOKED_REASON, seatBlockReason } from "../src/account-session.ts";

test("no_seat → 席位已用完，联系管理员释放或增购", () => {
  const r = seatBlockReason("no_seat");
  assert.equal(r, SEAT_NONE_REASON);
  assert.match(r, /本所席位已用完/);
  assert.match(r, /律所管理员/);
  assert.match(r, /释放闲置席位或增购席位/);
  assert.doesNotMatch(r, /席位令牌/);
});

test("seat_revoked → 席位被收回；其余（网络、未同步）仍是“联网后自动续期”", () => {
  assert.equal(seatBlockReason("seat_revoked"), SEAT_REVOKED_REASON);
  assert.match(SEAT_REVOKED_REASON, /收回/);
  for (const c of [null, undefined, "cp_unreachable", "cp_timeout", "skipped:license_missing"]) assert.equal(seatBlockReason(c), SEAT_PENDING_REASON, String(c));
  // 发起阻断原因不以“四项依据”开头：类别仍是 policy（不提示去记录客户授权）
  for (const r of [SEAT_NONE_REASON, SEAT_REVOKED_REASON, SEAT_PENDING_REASON]) assert.ok(!r.startsWith("四项依据"));
});

test("估价与发起的阻断原因接上同步结果码（不是只看有没有席位令牌）", () => {
  const src = readFileSync(new URL("../src/api/index.ts", import.meta.url), "utf8");
  assert.match(src, /seatBlockReason\(deps\.controlPlane\?\.lastSync\?\.steps\?\.seat \?\? null\)/);
});
