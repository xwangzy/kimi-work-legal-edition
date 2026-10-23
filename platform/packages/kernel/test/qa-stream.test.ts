// 问答流式输出：回答边生成边推给界面（chat.delta），推送的是还原后的文字、未闭合的代号先不推；
// 只有完整结束的回答才保存，中途中断与错误事件（网关内容安全拦截）按“未能取得回答”记。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { makeKernel } from "./helpers.ts";
import { collectStreamText, QaChatService } from "../src/services/qa-chat.ts";

const k = await makeKernel({}, "qa-stream-firm");
after(() => k.kernel.close());
const TID = "ten_qa-stream-firm";
const UID = "usr_qa-stream-firm_test-lawyer";
const noParties = { partiesIn: () => [] } as any;

async function* sse(...payloads: string[]): AsyncIterable<string> {
  for (const p of payloads) yield p;
}
const delta = (content: string, finish: string | null = null) => JSON.stringify({ choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finish }] });

test("collectStreamText：拼出全文并逐段回调；错误事件与没有结束标志的流都抛错", async () => {
  const seen: string[] = [];
  assert.equal(await collectStreamText(sse(delta("依据"), "not json", delta("《民法典》"), delta("", "stop"), "[DONE]"), (p) => seen.push(p)), "依据《民法典》");
  assert.deepEqual(seen, ["依据", "《民法典》"]);
  await assert.rejects(
    collectStreamText(sse(delta("半截"), JSON.stringify({ error: { code: "content_blocked_output", message: "模型输出命中内容安全策略（x），已中止" } }))),
    /内容安全策略/,
  );
  await assert.rejects(collectStreamText(sse(delta("半截"))), /中途中断/);
  assert.equal(await collectStreamText(sse(delta("只有"), "[DONE]")), "只有", "只有 [DONE] 也算正常结束");
});

test("部分回答按会话令牌表还原后推送；跨段的代号拼完整前不推半截", async () => {
  const pushed: { id: string; text: string }[] = [];
  let tokenSeen = "";
  const qa = new QaChatService({
    db: k.kernel.db,
    tokens: noParties,
    onPartial: (id, text) => pushed.push({ id, text }),
    ask: async (input) => {
      // 问题里的电话号码出站前已是代号：模型原样引用，代号被拆在两段里
      tokenSeen = /〔电话·[0-9A-Z]+〕/.exec(input.messages.at(-1)!.content)![0];
      const pieces = ["这个号码", tokenSeen.slice(0, 5), `${tokenSeen.slice(5)}的机主`, "可以查询。"];
      for (const p of pieces) {
        input.onDelta!(p);
        await sleep(100);
      }
      return pieces.join("");
    },
  });
  const r = await qa.send({ text: "13800138000 这个号码的机主怎么查？", streamId: "qs_test_0001" }, TID, UID);
  assert.ok(pushed.length >= 3, `推了 ${pushed.length} 次`);
  assert.ok(pushed.every((p) => p.id === "qs_test_0001"));
  for (const p of pushed) assert.ok(!p.text.includes("〔"), `推送里不出现代号或半截代号：${p.text}`);
  assert.equal(pushed.at(-1)!.text, "这个号码13800138000的机主可以查询。");
  assert.equal(r.messages.find((m) => m.role === "assistant")!.text, pushed.at(-1)!.text, "保存的回答与最后一次推送一致");
  // 没有 streamId：不推送
  pushed.length = 0;
  await qa.send({ conversationId: r.conversation_id, text: "还有别的办法吗？" }, TID, UID);
  assert.equal(pushed.length, 0);
});

test("回答中途失败：不保存半截回答、失败后不再推送", async () => {
  const pushed: string[] = [];
  const qa = new QaChatService({
    db: k.kernel.db,
    tokens: noParties,
    onPartial: (_id, text) => pushed.push(text),
    ask: async (input) => {
      input.onDelta!("先推一段");
      input.onDelta!("，再来一段"); // 节流窗口内：排在定时器里
      throw new Error("回答中途中断，请重试");
    },
  });
  const r = await qa.send({ text: "违约金怎么调整？", streamId: "qs_test_0002" }, TID, UID);
  await sleep(150);
  assert.deepEqual(pushed, ["先推一段"], "排着的那次推送随失败取消");
  assert.equal(r.messages.some((m) => m.role === "assistant"), false);
  assert.match(r.messages.at(-1)!.text, /^未能取得回答：回答中途中断/);
});

test("内核 chat.send：stream_id 合法才推 chat.delta 广播，推送的都是保存回答的前缀", async () => {
  const got: Record<string, unknown>[] = [];
  k.kernel.onBroadcast((m) => {
    if (m.type === "chat.delta") got.push(m);
  });
  const sent = await k.inv("chat.send", { text: "合同全面履行原则的依据？", stream_id: "qs_kernel_0001" });
  const answer = sent.messages.find((m: any) => m.role === "assistant").text;
  assert.ok(got.length >= 1);
  assert.ok(got.every((m) => m.stream_id === "qs_kernel_0001"));
  // 离线 mock 一次吐完：节流窗口里的后续推送随结束取消（界面随即换成保存的记录）
  for (const m of got) assert.ok(answer.startsWith(String(m.text)), String(m.text));
  got.length = 0;
  await k.inv("chat.send", { conversation_id: sent.conversation_id, text: "还有呢？", stream_id: "bad id with spaces" });
  assert.equal(got.length, 0, "不合法的流编号不推");
});
