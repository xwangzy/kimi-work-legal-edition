/**
 * 第 60 批（域名云端验收演练“设备被吊销”）：内核处于退出模式时，闸门按退出原因码说清楚为什么拒绝、找谁；
 * 原先一律说“任务已结束、已取消或凭据已过期：请重新运行任务”，重新运行并不会生效。问答页把这句话原样给律师看（qaFailureText 只剥错误码）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gateRefusalText } from "../src/server.ts";
import { qaFailureText } from "../../kernel/src/services/qa-chat.ts";

test("退出原因码各有说明；吊销时明确“重新运行不会生效”；其余原因维持原说法", () => {
  assert.match(gateRefusalText("device_revoked"), /已被律所停用.*重新运行不会生效.*管理员/);
  assert.match(gateRefusalText("license_expired"), /许可已到期.*续期/);
  assert.match(gateRefusalText("license_missing"), /还没有取得本所的使用许可/);
  assert.match(gateRefusalText("control_plane_unconfigured"), /没有配置云端服务/);
  for (const r of ["run_not_live", "token_invalid_or_scope", "matter_unknown", ""]) assert.equal(gateRefusalText(r), "这次 AI 请求没有获准发出（任务已结束、已取消或凭据已过期）：请重新运行任务");
  // 退出原因码与内核 exitMode 的取值一致（新增退出原因时这里要补说明）
  const gov = readFileSync(join(import.meta.dirname, "../../kernel/src/control-plane/governance.ts"), "utf8");
  const body = /exitMode\(\): ExitMode \| null \{([\s\S]*?)\n {2}\}/.exec(gov)?.[1] ?? "";
  const codes = [...body.matchAll(/code: "([a-z_]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(codes, ["control_plane_unconfigured", "device_revoked", "license_expired", "license_missing"]);
  for (const c of codes) assert.notEqual(gateRefusalText(c), gateRefusalText(""));
});

test("问答页：闸门的吊销说明连同错误码传回时，律师看到的是这句中文说明（不再是“请重新运行任务”）", () => {
  const msg = `模型通道错误 403：${gateRefusalText("device_revoked")} [kwl:device_revoked]`;
  assert.equal(qaFailureText(msg), gateRefusalText("device_revoked"));
  assert.doesNotMatch(qaFailureText(msg), /请重新运行任务/);
});

test("模型请求输出上限：超过 32,000 压到上限、没给就补上限、较小的原样；只对对话请求；请求方原值记在报告里", async () => {
  const { capOutputTokens, MAX_OUTPUT_TOKENS_CEILING, processChatPayload } = await import("../src/chat-payload.ts");
  assert.equal(MAX_OUTPUT_TOKENS_CEILING, 32_000);
  const a: Record<string, unknown> = { max_tokens: 131_072 };
  assert.equal(capOutputTokens(a), 131_072);
  assert.equal(a.max_tokens, 32_000);
  const b: Record<string, unknown> = { max_completion_tokens: 200_000 };
  capOutputTokens(b);
  assert.deepEqual(b, { max_completion_tokens: 32_000 }, "只给了 max_completion_tokens 时不另补 max_tokens");
  const c: Record<string, unknown> = {};
  assert.equal(capOutputTokens(c), null);
  assert.equal(c.max_tokens, 32_000);
  const d: Record<string, unknown> = { max_tokens: 8_000 };
  capOutputTokens(d);
  assert.equal(d.max_tokens, 8_000);
  // 经完整的出站处理：对话请求被封顶（令牌化器用最小桩：本用例只看结构参数）
  const { MatterTokenizer } = await import("@zr-legal/tokenizer");
  const { randomBytes } = await import("node:crypto");
  const tz = new MatterTokenizer({ matterKey: randomBytes(32), parties: [] });
  const r = processChatPayload({ model: "legal/k3", stream: true, messages: [{ role: "user", content: "你好" }] }, tz);
  assert.equal(r.body.max_tokens, 32_000);
  assert.equal(r.outputTokensRequested, null);
  const r2 = processChatPayload({ model: "legal/k3", max_tokens: 131_072, messages: [{ role: "user", content: "你好" }] }, tz);
  assert.equal(r2.body.max_tokens, 32_000);
  assert.equal(r2.outputTokensRequested, 131_072);
});
