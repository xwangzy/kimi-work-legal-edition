/**
 * 第 8 批界面纯函数：在线内容更新的律师语言（设置 → 资料来源；复核 S8B-03/13、S8A-13）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTENT_CHECK_FAILED, CONTENT_PANEL_NOTE, STALE_AFTER_MS, contentCheckLine, contentSourceLine, contentStaleLine } from "../src/lib/content-labels.ts";

const JARGON = /seq|序号|通道|channel|签名|凭据|manifest|席位|7/i;

test("在线更新：每种检查结果都有一句律师语言，不出现序号、通道、签名、凭据等工程用语；面板说明与失败提示同样", () => {
  const outcomes = ["installed", "up_to_date", "staged_rollout", "not_configured", "unreachable", "unauthorized", "stale", "rollback_ignored", "reverted", "rejected", "failed", "skipped"] as const;
  for (const kind of ["lawdb", "skills"] as const) {
    for (const outcome of outcomes) {
      const line = contentCheckLine({ kind, outcome, at: "2026-10-15T00:00:00Z", seq: 7, reason: "manifest_signature" });
      assert.ok(line && line.length > 4, `${kind}/${outcome}`);
      assert.doesNotMatch(line!, JARGON, `${kind}/${outcome}: ${line}`);
    }
  }
  for (const t of [CONTENT_PANEL_NOTE, CONTENT_CHECK_FAILED]) assert.doesNotMatch(t, JARGON, t);
  assert.match(contentCheckLine({ kind: "skills", outcome: "installed", at: "" })!, /下次打开/);
  assert.match(contentCheckLine({ kind: "lawdb", outcome: "installed", at: "" })!, /已在使用新版本/);
  assert.match(contentCheckLine({ kind: "lawdb", outcome: "installed", at: "", pending_swap: true })!, /任务结束后启用/);
  assert.match(contentCheckLine({ kind: "lawdb", outcome: "failed", at: "" })!, /这台电脑上出错/, "本机出错不说成连不上");
  assert.doesNotMatch(contentCheckLine({ kind: "lawdb", outcome: "failed", at: "" })!, /连不上/);
  assert.equal(contentCheckLine(null), null);
});

test("来源行：随安装包/在线更新；待生效与撤回待生效如实（复核 S8B-13③）", () => {
  assert.equal(contentSourceLine("lawdb", { configured: true, lawdb: { source: "installed", seq: 3, version: "g0.x", last_check: null } }), "法规库：在线更新的版本");
  assert.match(contentSourceLine("lawdb", { configured: true, lawdb: { source: "bundled", seq: 0, version: "g0.x", pending: { seq: 4, version: "y" }, last_check: null } })!, /任务结束后启用/);
  assert.match(contentSourceLine("skills", { configured: true, skills: { source: "bundled", seq: 0, version: "x", pending: { seq: 4, version: "y" }, last_check: null } })!, /下次打开 Kimi Work 时生效/);
  const revoked = contentSourceLine("skills", { configured: true, skills: { source: "installed", seq: 4, version: "x", pending: null, revoked_pending_restart: true, last_check: null } })!;
  assert.match(revoked, /已被撤回.*换回随安装包/);
  assert.equal(contentSourceLine("lawdb", { configured: false }), null);
});

test("长期没能确认最新时提示（复核 S8A-13）", () => {
  const now = Date.parse("2026-12-31T00:00:00Z");
  const check = { kind: "lawdb" as const, outcome: "stale" as const, at: "2026-12-30T00:00:00Z" };
  const st = (confirmed: string | null) => ({ configured: true, lawdb: { source: "bundled" as const, seq: 0, version: "v", last_check: check, last_confirmed_at: confirmed } });
  assert.ok(contentStaleLine("lawdb", st(new Date(now - STALE_AFTER_MS - 1000).toISOString()), now));
  assert.equal(contentStaleLine("lawdb", st(new Date(now - 1000).toISOString()), now), null);
  assert.ok(contentStaleLine("lawdb", st(null), now), "从没确认过、最近一次又不是最新");
  assert.equal(contentStaleLine("lawdb", { configured: false }, now), null);
});
