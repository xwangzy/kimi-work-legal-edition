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
