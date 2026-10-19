/**
 * 输出上限按路由配置（复核 B13-C01）：K3 与 K2.6 各自的缺省上限写在路由表里（可经环境变量调），请求给了 max_tokens 则以请求为准；
 * 网关按响应尾部取上游结束原因（length = 被上限截断）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRoutes } from "../src/config.ts";
import { ModelBroker } from "../src/broker.ts";
import { extractFinishReason } from "../../../services/legal-gateway/src/gateway.ts";

test("路由表：缺省 32,000；环境变量可分别调整；越界值不采用", () => {
  const d = buildRoutes({});
  assert.equal(d["legal/k3"]!.maxOutputTokens, 32_000);
  assert.equal(d["legal/k2.6"]!.maxOutputTokens, 32_000);
  const e = buildRoutes({ ZR_MODEL_K3_MAX_TOKENS: "64000", ZR_MODEL_K26_MAX_TOKENS: "16000" });
  assert.equal(e["legal/k3"]!.maxOutputTokens, 64_000);
  assert.equal(e["legal/k2.6"]!.maxOutputTokens, 16_000);
  assert.equal(buildRoutes({ ZR_MODEL_K3_MAX_TOKENS: "9999999" })["legal/k3"]!.maxOutputTokens, 32_000);
});

test("请求未给 max_tokens 用路由的上限；给了以请求为准", () => {
  const routes = buildRoutes({ ZR_MODEL_K3_MAX_TOKENS: "48000", ZR_MODEL_K26_MAX_TOKENS: "12000" });
  const build = (ModelBroker.prototype as any).buildRequest as (r: unknown, a: unknown) => { max_tokens: number };
  assert.equal(build.call({}, routes["legal/k3"], { messages: [] }).max_tokens, 48_000);
  assert.equal(build.call({}, routes["legal/k2.6"], { messages: [] }).max_tokens, 12_000);
  assert.equal(build.call({}, routes["legal/k3"], { messages: [], maxTokens: 2_000 }).max_tokens, 2_000);
});

test("网关取上游结束原因：流式取最后一个非空值；非流式直接取", () => {
  const sse = ['data: {"choices":[{"delta":{"content":"a"},"finish_reason":null}]}', 'data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":1,"completion_tokens":2}}', "data: [DONE]"].join("\n");
  assert.equal(extractFinishReason(sse), "length");
  assert.equal(extractFinishReason('{"choices":[{"message":{"content":"x"},"finish_reason":"stop"}]}'), "stop");
  assert.equal(extractFinishReason("no reason here"), null);
});
