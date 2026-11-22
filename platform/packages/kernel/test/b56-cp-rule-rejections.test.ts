/**
 * 第 56 批（真实流程验收）：律所策略草稿被规则拒绝（没签名就发布、重复发布、草稿过时、草稿不存在）时，
 * 管理员看到的是原因，不是“中软服务暂时不可用，请稍后重试”——那句话只留给真正不认识的代码。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { controlPlaneErrorText, CP_RULE_REJECTIONS } from "../src/account-session.ts";

test("策略草稿的规则类拒绝各有说明，不落到“服务暂时不可用”", () => {
  const generic = controlPlaneErrorText("some_unknown_code");
  assert.equal(generic, "中软服务暂时不可用，请稍后重试");
  for (const code of ["admin_threshold_not_met", "draft_published", "draft_stale", "draft_unknown"]) {
    assert.ok(CP_RULE_REJECTIONS.has(code), code);
    const text = controlPlaneErrorText(code);
    assert.notEqual(text, generic, code);
    assert.doesNotMatch(text, /稍后重试|暂时不可用/, `${code} 不是服务故障`);
    assert.doesNotMatch(text, /[a-z_]{6,}/, `${code} 的说明里不出现内部代码`);
  }
  assert.match(controlPlaneErrorText("admin_threshold_not_met"), /签名/);
  assert.match(controlPlaneErrorText("draft_stale"), /重新起草/);
});
