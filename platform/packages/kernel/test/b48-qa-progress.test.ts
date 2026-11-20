// 第 48 批：问答等待体验。推理型模型先静默“思考”1～3 分钟才出第一个字（实测 K3.1-Pro 首字约 194 秒），
// 所以：① 思考增量（reasoning_content）只数字数、不收内容，进度经 chat.progress 推给界面；② “深度思考”开关：缺省快速回答（给上游传 thinking: disabled）。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeKernel } from "./helpers.ts";
import { collectStreamText, QaChatService, type QaAskInput, type QaProgress } from "../src/services/qa-chat.ts";
import { gateBody, thinkingParams } from "../../model-broker/src/providers/gate.ts";

const k = await makeKernel({}, "qa-progress-firm");
after(() => k.kernel.close());
const TID = "ten_qa-progress-firm";
const UID = "usr_qa-progress-firm_test-lawyer";
const noParties = { partiesIn: () => [] } as any;

async function* sse(...payloads: string[]): AsyncIterable<string> {
  for (const p of payloads) yield p;
}
const think = (s: string) => JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: s }, finish_reason: null }] });
const delta = (content: string, finish: string | null = null) => JSON.stringify({ choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finish }] });

test("collectStreamText：思考增量只回调字数、不进回答；没有思考增量的流照旧", async () => {
  const counts: number[] = [];
  const pieces: string[] = [];
  const text = await collectStreamText(sse(think("先看第五百八十五条"), think("再看司法解释"), delta("违约金过高的，"), delta("法院可以调整。", "stop"), "[DONE]"), (p) => pieces.push(p), (n) => counts.push(n));
  assert.equal(text, "违约金过高的，法院可以调整。", "回答里没有思考内容");
  assert.deepEqual(counts, [9, 6], "只给字数");
  assert.deepEqual(pieces, ["违约金过高的，", "法院可以调整。"]);
  // 不给回调也不影响
  assert.equal(await collectStreamText(sse(think("想"), delta("答", "stop"))), "答");
  // 空的思考增量不回调
  const none: number[] = [];
  await collectStreamText(sse(think(""), delta("答", "stop")), undefined, (n) => none.push(n));
  assert.deepEqual(none, []);
});

test("回答进度：思考中带字数（每秒至多一次），第一段正文时推一次撰写中；没有流编号不推", async () => {
  const got: { id: string; p: QaProgress }[] = [];
  const asks: QaAskInput[] = [];
  const qa = new QaChatService({
    db: k.kernel.db,
    tokens: noParties,
    onProgress: (id, p) => got.push({ id, p }),
    ask: async (input) => {
      asks.push(input);
      // 一连收到几段思考：第一段立刻推，其余落在 1 秒节流窗口内
      input.onReasoning!(120);
      input.onReasoning!(80);
      input.onReasoning!(50);
      input.onDelta!("这是");
      input.onDelta!("回答");
      // 开始写正文之后的思考增量（不该再出现，出现也不再推“思考中”）
      input.onReasoning!(10);
      return "这是回答";
    },
  });
  const r = await qa.send({ text: "违约金过高怎么办？", streamId: "qs_prog_0001" }, TID, UID);
  assert.deepEqual(
    got.map((g) => g.p),
    [
      { phase: "thinking", thought_chars: 120 },
      { phase: "writing", thought_chars: 250 },
    ],
  );
  assert.ok(got.every((g) => g.id === "qs_prog_0001"));
  assert.equal(r.messages.find((m) => m.role === "assistant")!.text, "这是回答");
  // 没有 streamId：不推，也不给提供方回调
  got.length = 0;
  await qa.send({ conversationId: r.conversation_id, text: "还有呢？" }, TID, UID);
  assert.equal(got.length, 0);
  assert.equal(asks.at(-1)!.onReasoning, undefined);
});

test("深度思考开关：缺省快速回答（deep=false）；send 可显式开；defaultDeep 改缺省", async () => {
  const deeps: boolean[] = [];
  const mk = (defaultDeep?: boolean) =>
    new QaChatService({
      db: k.kernel.db,
      tokens: noParties,
      ...(defaultDeep !== undefined ? { defaultDeep } : {}),
      ask: async (input) => {
        deeps.push(input.deep);
        return "答";
      },
    });
  const qa = mk();
  assert.equal(qa.defaultDeep(), false);
  await qa.send({ text: "问题一" }, TID, UID);
  await qa.send({ text: "问题二", deep: true }, TID, UID);
  await qa.send({ text: "问题三", deep: false }, TID, UID);
  assert.deepEqual(deeps, [false, true, false]);
  deeps.length = 0;
  const qaDeep = mk(true);
  assert.equal(qaDeep.defaultDeep(), true);
  await qaDeep.send({ text: "问题四" }, TID, UID);
  await qaDeep.send({ text: "问题五", deep: false }, TID, UID);
  assert.deepEqual(deeps, [true, false]);
});

test("内核：chat.models 给出 default_deep（缺省 false）；chat.send 的 deep 只认布尔；chat.progress 广播不带思考内容", async () => {
  const models = (await k.inv("chat.models")) as any;
  assert.equal(models.default_deep, false);
  const prog: Record<string, unknown>[] = [];
  k.kernel.onBroadcast((m) => {
    if (m.type === "chat.progress") prog.push(m);
  });
  // 离线 mock 提供方不吐思考增量：只会有“撰写中”（或没有）；形状必须是 流编号 + 阶段 + 字数，别的字段一个没有
  const sent = (await k.inv("chat.send", { text: "合同全面履行原则的依据？", stream_id: "qs_kernel_prog1", deep: "yes" })) as any;
  assert.ok(sent.messages.some((m: any) => m.role === "assistant"), "deep 不是布尔：忽略它，按缺省照常回答");
  for (const m of prog) {
    assert.deepEqual(Object.keys(m).sort(), ["phase", "stream_id", "thought_chars", "type"]);
    assert.equal(m.stream_id, "qs_kernel_prog1");
    assert.ok(m.phase === "thinking" || m.phase === "writing");
    assert.ok(Number.isSafeInteger(m.thought_chars) && (m.thought_chars as number) >= 0);
  }
});

test("模型通道（第 49 批按官方参数表）：K3 只发 reasoning_effort、K2.6 只发 thinking；温度一律不发；不支持的参数在出口丢弃", () => {
  const k3 = { alias: "legal/k3", temperature: null, supportsEffort: true, thinkingControl: "effort" } as any;
  const k26 = { alias: "legal/k2.6", temperature: null, supportsEffort: false, thinkingControl: "toggle" } as any;
  // 开关 → 参数
  assert.deepEqual(thinkingParams(k3, true), { reasoning_effort: "max" });
  assert.deepEqual(thinkingParams(k3, false), { reasoning_effort: "low" });
  assert.deepEqual(thinkingParams(k26, true), { thinking: { type: "enabled" } });
  assert.deepEqual(thinkingParams(k26, false), { thinking: { type: "disabled" } });
  // 老配置没写 thinkingControl：按 supportsEffort 推断；都不支持的不发任何思考参数
  assert.deepEqual(thinkingParams({ alias: "x", supportsEffort: false } as any, true), {});
  // 出口：K3 即使调用方塞了 thinking 也不发（官方：K3 不支持 thinking）
  const k3body = gateBody(k3, { model: "legal/k3", messages: [], stream: true, reasoning_effort: "low", thinking: { type: "disabled" } }, true);
  assert.equal(k3body.reasoning_effort, "low");
  assert.equal("thinking" in k3body, false);
  assert.equal("temperature" in k3body, false, "温度固定值不发");
  // 出口：K2.6 不发 reasoning_effort；thinking 只认 enabled / disabled
  const k26body = gateBody(k26, { model: "legal/k2.6", messages: [], reasoning_effort: "high", thinking: { type: "disabled" } }, false);
  assert.deepEqual(k26body.thinking, { type: "disabled" });
  assert.equal("reasoning_effort" in k26body, false);
  assert.equal("temperature" in k26body, false);
  assert.equal("thinking" in gateBody(k26, { model: "legal/k2.6", messages: [], thinking: "off" as any }, false), false);
  assert.equal("thinking" in gateBody(k26, { model: "legal/k2.6", messages: [], thinking: { type: "auto" } as any }, false), false);
  // 仍可为将来可调温度的模型发数字温度
  assert.equal(gateBody({ ...k26, temperature: 0.3 }, { model: "legal/k2.6", messages: [] }, false).temperature, 0.3);
});
