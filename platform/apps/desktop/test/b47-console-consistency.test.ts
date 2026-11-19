/**
 * 第 47 批：网页控制台与律师端的用量说法逐值一致（重置时刻、重置句、百分比写法、分母说明）。
 * 放在客户端一侧：独立云端仓库只导出控制台、不含客户端代码（同第 46 批 release-config-tool 等的做法）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(import.meta.dirname, "..", "..", "..");
const mod = async (rel: string): Promise<any> => import(pathToFileURL(join(root, rel)).href);

test("控制台与客户端：重置时刻、重置句、百分比、分母说明同一套", async () => {
  const { fmt } = await mod("apps/console/ui.js");
  const resets = "2026-11-30T16:00:00.000Z";
  const desk = await mod("apps/desktop/src/lib/firm-usage.ts");
  assert.equal(fmt.resets(resets), desk.atLabel(resets));
  assert.equal(fmt.resetLine(resets), desk.resetLabel(resets));
  assert.equal(fmt.resetLine(undefined), desk.resetLabel(undefined));
  for (const r of [0, 0.0004, 0.0031, 0.031, 0.5, 0.996, 1.2]) assert.equal(fmt.pct(r), desk.fmtPct(r));
  // 剩余往下取：已用 0.3% 时剩余写 99%，不写 100%
  for (const r of [0, 0.0004, 0.031, 0.5, 0.58, 0.29, 0.997, 0.9999, 1]) assert.equal(fmt.left(r), desk.fmtLeft(r));
  assert.deepEqual([desk.fmtLeft(0.58), desk.fmtLeft(0.29)], ["58%", "29%"], "浮点误差不吃掉一个百分点");
  assert.deepEqual([desk.fmtLeft(0.997), desk.fmtLeft(1), desk.fmtLeft(0.0957), desk.fmtLeft(0)], ["99%", "100%", "9.5%", "0%"]);
  const { DENOMINATOR } = await mod("apps/console/domain.js");
  assert.ok(DENOMINATOR.seat_quota.includes(desk.ownDenominatorText({ denominator: "seat_quota" })));
  assert.ok(DENOMINATOR.account_limit.includes(desk.ownDenominatorText({ denominator: "account_limit" })));
});
