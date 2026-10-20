/**
 * 开通向导（v9.3 第 14 批续）：三步的完成判定与顶上一句话；激活与入组批准后落到向导，恢复后直接进首页；缺恢复包的提醒回到向导。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { welcomeHeadline, welcomeSteps } from "../src/lib/welcome-steps.ts";
import { recoveryReminder } from "../src/lib/recovery-reminder.ts";

test("三步按备份状态判定：生成恢复包 → 试一下 → 备份位置且成功备份过一次", () => {
  assert.deepEqual(welcomeSteps(null).map((x) => x.done), [false, false, false]);
  assert.deepEqual(welcomeSteps({ packages_created: 1 }).map((x) => x.done), [true, false, false]);
  assert.deepEqual(welcomeSteps({ packages_created: 1, packages_verified: 1, configured: true, last_ok_at: null }).map((x) => x.done), [true, true, false], "设了位置但还没成功备份过：不算");
  const all = welcomeSteps({ packages_created: 2, packages_verified: 1, configured: true, last_ok_at: "2026-10-20T01:00:00Z" });
  assert.ok(all.every((x) => x.done));
  assert.match(welcomeHeadline(all), /都设好了/);
  assert.match(welcomeHeadline(welcomeSteps({ packages_created: 1 })), /还差 2 步/);
});

test("复核 R15B-25：顶上一句话按缺的那一步说；重新生成恢复包后“试一下”回到未完成", () => {
  const ok = { configured: true, last_ok_at: "2026-10-20T01:00:00Z" };
  assert.match(welcomeHeadline(welcomeSteps({})), /还没有恢复包：.*无法找回/);
  assert.match(welcomeHeadline(welcomeSteps({ packages_created: 1, packages_verified: 1 })), /还差 1 步。还没有备份/);
  const onlyVerify = welcomeHeadline(welcomeSteps({ packages_created: 1, ...ok }));
  assert.match(onlyVerify, /还差 1 步。恢复包和备份都有了/);
  assert.doesNotMatch(onlyVerify, /无法找回/);
  const regenerated = welcomeSteps({ packages_created: 2, packages_verified: 1, latest_package_verified: false, ...ok });
  assert.equal(regenerated[1]!.done, false);
  assert.match(regenerated[1]!.hint, /重新生成过恢复包/);
  assert.equal(welcomeSteps({ packages_created: 2, packages_verified: 2, latest_package_verified: true, ...ok })[1]!.done, true);
  assert.equal(welcomeSteps({ packages_created: 1, packages_verified: 1, ...ok })[1]!.done, true, "旧内核没有这一项：按试过任意一份");
});

test("激活与入组批准后落到向导；从备份恢复后直接进首页；缺恢复包的提醒“去完成”回到向导", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/pages/Activate.tsx", import.meta.url)), "utf8");
  assert.equal((src.match(/"#\/welcome"\);/g) ?? []).length, 2, "开通码激活与入组批准两处");
  assert.match(src, /void waitForActivated\(onStuck\);/, "从备份恢复不进向导");
  assert.equal(recoveryReminder({ packages_created: 0 })!.kind, "package");
  assert.equal(recoveryReminder({ packages_created: 1, configured: false })!.kind, "folder");
  const app = readFileSync(fileURLToPath(new URL("../src/App.tsx", import.meta.url)), "utf8");
  assert.match(app, /if \(reminder\.kind === "package"\) return nav\("\/welcome"\);/);
});
