// 问答“深度思考”开关的出站参数，在整条链路（内核 → 出站闸门 → 法律模型网关 → 上游）的出口上核对。
// 第 49 批按 Kimi 官方《模型参数参考》（platform.kimi.com/docs/api/models-overview）改：
//   · K3 系列：始终思考，不支持 thinking 参数；推理强度用顶层 reasoning_effort（low / high / max，默认 max）；温度固定 1.0，建议不要传；
//   · K2.6：thinking.type 默认 enabled、可传 disabled；不支持 reasoning_effort；温度思考 1.0 / 非思考 0.6 固定，建议不要传。
// 所以：K3 深度 = reasoning_effort "max"、快速 = "low"；K2.6 深度 = thinking enabled、快速 = disabled；两者都不带温度。
// （第 48 批曾对 K3 发 thinking: disabled——官方未支持，MaaS 上一类后端会忽略它、照样先想一百多秒，属“开关看似生效”。）
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeKernel, type TestKernel } from "./helpers.ts";
import { startCloudV0, type CloudV0 } from "./cloud-v0.ts";

let tk: TestKernel;
let cloud: CloudV0;

before(async () => {
  cloud = await startCloudV0({ tenant: "ten_qa-wire-firm" });
  tk = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_KERNEL_TCP: "off" }, "qa-wire-firm");
});

after(async () => {
  await tk.kernel.close();
  await cloud.close();
});

/** 发一条问答，返回网关发给上游的那条请求体（无事项问答的系统提示含“无事项问答”）。 */
async function askAndCapture(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  let seen: Record<string, unknown> | null = null;
  cloud.model.script = (body) => {
    const sys = JSON.stringify((body.messages as { content?: unknown }[] | undefined)?.[0]?.content ?? "");
    if (!sys.includes("无事项问答")) return null;
    seen = body;
    return { content: "违约金过高的，当事人可以请求予以适当减少。" };
  };
  try {
    const r = (await tk.inv("chat.send", payload)) as any;
    assert.equal(r.blocked, undefined, JSON.stringify(r));
    assert.ok(r.messages.some((m: any) => m.role === "assistant"));
  } finally {
    cloud.model.script = null;
  }
  assert.ok(seen, "请求经闸门与网关到达上游");
  return seen as Record<string, unknown>;
}

test("K3 深度思考：上游收到 reasoning_effort=max，不带 thinking、不带温度", { timeout: 120_000 }, async () => {
  const body = await askAndCapture({ text: "买卖合同违约金过高怎么调整？", deep: true });
  assert.equal(body.reasoning_effort, "max");
  assert.equal("thinking" in body, false, "K3 不支持 thinking 参数");
  assert.equal("temperature" in body, false, "K3 温度固定 1.0，不传");
  assert.equal(body.stream, true);
});

test("K3 快速回答：上游收到 reasoning_effort=low，不带 thinking、不带温度", { timeout: 120_000 }, async () => {
  const body = await askAndCapture({ text: "劳动合同试用期最长多久？", deep: false });
  assert.equal(body.reasoning_effort, "low");
  assert.equal("thinking" in body, false);
  assert.equal("temperature" in body, false);
});

test("缺省（没带 deep）= 快速回答：与显式 deep=false 的出站请求一致", { timeout: 120_000 }, async () => {
  const body = await askAndCapture({ text: "诉讼时效一般是几年？" });
  assert.equal(body.reasoning_effort, "low");
  assert.equal("thinking" in body, false);
  assert.equal("temperature" in body, false);
});

test("K2.6：深度 = thinking enabled、快速 = thinking disabled；不带 reasoning_effort、不带温度", { timeout: 120_000 }, async () => {
  const deep = await askAndCapture({ text: "什么是表见代理？", deep: true, route: "legal/k2.6" });
  assert.deepEqual(deep.thinking, { type: "enabled" });
  assert.equal("reasoning_effort" in deep, false, "K2.6 不支持 reasoning_effort");
  assert.equal("temperature" in deep, false);
  const fast = await askAndCapture({ text: "什么是缔约过失？", deep: false, route: "legal/k2.6" });
  assert.deepEqual(fast.thinking, { type: "disabled" });
  assert.equal("reasoning_effort" in fast, false);
  assert.equal("temperature" in fast, false);
});

test("chat.models：每个可选模型带 thinking（K3 = effort、K2.6 = toggle），界面据此说明开关", { timeout: 120_000 }, async () => {
  const r = (await tk.inv("chat.models", {})) as { choices: { alias: string; thinking: string }[] };
  const by = Object.fromEntries(r.choices.map((c) => [c.alias, c.thinking]));
  assert.equal(by["legal/k3"], "effort");
  if (by["legal/k2.6"] !== undefined) assert.equal(by["legal/k2.6"], "toggle");
});
