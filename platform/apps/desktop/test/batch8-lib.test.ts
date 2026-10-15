/**
 * 第 8 批界面纯函数：在线内容更新的律师语言（设置 → 资料来源）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { contentCheckLine, contentSourceLine } from "../src/lib/content-labels.ts";

test("在线更新：每种检查结果都有一句律师语言，不出现序号、通道、签名等工程用语；方法模板注明下次打开生效", () => {
  const outcomes = ["installed", "up_to_date", "staged_rollout", "not_configured", "unreachable", "rollback_ignored", "reverted", "rejected"] as const;
  for (const kind of ["lawdb", "skills"] as const) {
    for (const outcome of outcomes) {
      const line = contentCheckLine({ kind, outcome, at: "2026-10-15T00:00:00Z", seq: 7, reason: "manifest_signature" });
      assert.ok(line && line.length > 4, `${kind}/${outcome}`);
      assert.doesNotMatch(line!, /seq|序号|通道|channel|签名|manifest|7/i, `${kind}/${outcome}: ${line}`);
    }
  }
  assert.match(contentCheckLine({ kind: "skills", outcome: "installed", at: "" })!, /下次打开/);
  assert.match(contentCheckLine({ kind: "lawdb", outcome: "installed", at: "" })!, /已在使用新版本/);
  assert.equal(contentCheckLine(null), null);
  assert.equal(contentSourceLine("lawdb", { configured: true, lawdb: { source: "installed", seq: 3, version: "g0.x", last_check: null } }), "法规库：在线更新的版本");
  assert.match(contentSourceLine("skills", { configured: true, skills: { source: "bundled", seq: 0, version: "x", pending: { seq: 4, version: "y" }, last_check: null } })!, /下次打开 Kimi Work 时生效/);
  assert.equal(contentSourceLine("lawdb", { configured: false }), null);
});
