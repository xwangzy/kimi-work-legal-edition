/**
 * 第 71 批第三轮：问答“停止生成”。
 * - 流到一半律师点停止：已生成的部分按回答保存并标 stopped（存储时末尾带标注，显示与送回模型的历史里都去掉），不记“未能取得回答”；
 * - 上游连接被关闭：abortableChunks 调用了源迭代器的 return()，且不等下一段到来；
 * - 只能停本人发起的、还在进行的流；没有就返回 false（chat.stop 回 ok:false，不报错）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { makeKernel } from "./helpers.ts";
import { abortableChunks, collectStreamText, QA_STOPPED_MARK, QaChatService, QaStoppedError } from "../src/services/qa-chat.ts";

const k = await makeKernel({}, "qa-stop-firm");
after(() => k.kernel.close());
const TID = "ten_qa-stop-firm";
const UID = "usr_qa-stop-firm_test-lawyer";
const noParties = { partiesIn: () => [] } as any;
const delta = (content: string, finish: string | null = null) => JSON.stringify({ choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finish }] });

/** 先给几段、然后挂住（像上游还在思考）的源；记下 return() 有没有被调用。 */
function hangingSource(first: string[]) {
  const queue = [...first];
  const state = { returned: false };
  const it: AsyncIterableIterator<string> = {
    [Symbol.asyncIterator]() {
      return it;
    },
    async next() {
      if (queue.length > 0) return { value: queue.shift()!, done: false };
      return new Promise<IteratorResult<string>>(() => {});
    },
    async return() {
      state.returned = true;
      return { value: undefined, done: true };
    },
  };
  return { it, state };
}

test("abortableChunks：中止后不等下一段、立即抛“已停止”，并调用源的 return() 关闭连接；没有 signal 时原样转交", async () => {
  const src = hangingSource([delta("第一段"), delta("第二段")]);
  const ac = new AbortController();
  const seen: string[] = [];
  const p = collectStreamText(abortableChunks(src.it, ac.signal), (x) => seen.push(x));
  await sleep(20);
  assert.deepEqual(seen, ["第一段", "第二段"]);
  ac.abort();
  await assert.rejects(p, (e) => e instanceof QaStoppedError);
  await sleep(5);
  assert.equal(src.state.returned, true, "源迭代器的 return() 被调用（提供方据此关闭连接）");
  async function* plain() {
    yield delta("全文");
    yield "[DONE]";
  }
  assert.equal(await collectStreamText(abortableChunks(plain())), "全文");
});

test("流到一半停止：保存已生成的部分并标 stopped，不记“未能取得回答”；送回模型的历史里没有标注；只能停本人的、进行中的", async () => {
  let src = hangingSource([delta("违约金过高时，"), delta("法院可以依当事人请求适当减少")]);
  const asked: { role: string; content: string }[][] = [];
  const partials: string[] = [];
  const qa = new QaChatService({
    db: k.kernel.db,
    tokens: noParties,
    onPartial: (_id, text) => partials.push(text),
    ask: async (input) => {
      asked.push(input.messages);
      return collectStreamText(abortableChunks(src.it, input.signal), input.onDelta, input.onReasoning);
    },
  });
  const pending = qa.send({ text: "违约金过高怎么办？", streamId: "qs_stop_case_001" }, TID, UID);
  await sleep(30);
  assert.equal(qa.stop("qs_stop_case_001", TID, "usr_someone_else"), false, "别人的流停不了");
  assert.equal(qa.stop("qs_not_running_01", TID, UID), false, "没有这个流");
  assert.equal(qa.stop("qs_stop_case_001", TID, UID), true);
  const r = await pending;
  const last = r.messages.at(-1)!;
  assert.equal(last.role, "assistant");
  assert.equal(last.text, "违约金过高时，法院可以依当事人请求适当减少");
  assert.equal(last.stopped, true);
  assert.ok(!r.messages.some((m) => m.role === "notice"), "停止不是失败，不记“未能取得回答”");
  assert.equal(src.state.returned, true, "上游连接被关闭");
  assert.equal(qa.stop("qs_stop_case_001", TID, UID), false, "已经停了的不能再停");
  assert.match(partials.at(-1) ?? "", /适当减少/, "停止时把已生成的部分推给界面");
  // 存储里带标注，送回模型的历史里去掉
  const stored = k.kernel.db.get<{ text: string }>(`SELECT text FROM qa_messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 1`, [r.conversation_id])!.text;
  assert.ok(stored.endsWith(QA_STOPPED_MARK));
  // 第二问用正常结束的流（源迭代器给完就 done）
  src = { it: (async function* () { yield delta("接着答。", "stop"); yield "[DONE]"; })() as AsyncIterableIterator<string>, state: { returned: false } };
  const r2 = await qa.send({ conversationId: r.conversation_id, text: "请接着说", streamId: "qs_stop_case_002" }, TID, UID);
  assert.equal(r2.messages.at(-1)!.text, "接着答。");
  assert.equal(r2.messages.at(-1)!.stopped, undefined);
  const hist = asked.at(-1)!;
  assert.ok(hist.some((m) => m.role === "assistant" && m.content === "违约金过高时，法院可以依当事人请求适当减少"));
  assert.ok(!hist.some((m) => m.content.includes("律师停止了生成")));
});

test("还没生成任何字就停止：记一条“已停止生成”的说明；chat.stop 对不存在的流回 ok:false 不报错", async () => {
  const src = hangingSource([]);
  const qa = new QaChatService({ db: k.kernel.db, tokens: noParties, ask: async (input) => collectStreamText(abortableChunks(src.it, input.signal), input.onDelta) });
  const pending = qa.send({ text: "一个问题", streamId: "qs_stop_case_003" }, TID, UID);
  await sleep(20);
  assert.equal(qa.stop("qs_stop_case_003", TID, UID), true);
  const r = await pending;
  assert.equal(r.messages.at(-1)!.role, "notice");
  assert.match(r.messages.at(-1)!.text, /^已停止生成/);
  assert.deepEqual(await k.inv("chat.stop", { stream_id: "qs_nothing_here_1" }), { ok: false });
});
