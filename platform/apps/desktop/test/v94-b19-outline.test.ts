/**
 * v9.4 第 19 批 C-04 任务页：逐条决定的组装（改写才传、去掉的依据、至少留一条）、Agent 确认题的识别与代答、依据核验的律师说法；
 * 任务页源码：提纲卡在时确认题不再单独出现，确认先记决定再代答。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basisStateText, confirmAndAnswer, decisionsOf, emptyDraft, keptCount, outlineAnswer, outlineQuestion, type OutlineView } from "../src/lib/outline.ts";

const o: Pick<OutlineView, "items"> = {
  items: [
    { arg_id: "a1", claim: "被告应支付货款", basis: [{ law: "民法典", article: 509, note: null, check: "version_verified", matched: null, article_text: "当事人应当……", demo: false }, { law: "民法典", article: 585, note: null, check: "version_verified", matched: null, article_text: null, demo: false }], facts: [], counter: null },
    { arg_id: "a2", claim: "被告应承担违约金", basis: [], facts: [], counter: null },
  ],
};

test("逐条决定：原样不传 claim、改写才传；去掉的依据按下标留其余；删掉的 keep=false", () => {
  const plain = (s: string) => s;
  assert.deepEqual(decisionsOf(o, emptyDraft(), plain), [{ arg_id: "a1", keep: true }, { arg_id: "a2", keep: true }]);
  const d = { drop: { a2: true }, claim: { a1: "被告应支付货款 " }, dropBasis: { a1: [1] } };
  assert.deepEqual(decisionsOf(o, d, plain), [{ arg_id: "a1", keep: true, basis_keep: [0] }, { arg_id: "a2", keep: false }], "只多一个空格不算改写");
  assert.deepEqual(decisionsOf(o, { ...emptyDraft(), claim: { a2: "被告应按日万分之五承担违约金" } }, plain)[1], { arg_id: "a2", keep: true, claim: "被告应按日万分之五承担违约金" });
  assert.equal(keptCount(o, { ...emptyDraft(), drop: { a1: true, a2: true } }), 0);
});

test("确认题：题干含“论点”、选项以“已确认”开头；代答选第一项或“先不起草”；和别的题同卡时也认（第 31 批，others 记同卡另有几题）", () => {
  const q = { question_id: "q1", questions: [{ id: "x", question: "论点与依据已列在任务页，请确认后选择", options: [{ id: "o1", label: "已确认，按确认的论点起草" }, { id: "o2", label: "先不起草" }] }] };
  const other = { question_id: "q0", questions: [{ id: "y", question: "我方是哪一方？", options: [{ id: "p", label: "原告" }] }] };
  const m = outlineQuestion([other, q])!;
  assert.deepEqual(m, { question_id: "q1", qid: "x", confirm: "o1", stop: "o2", others: 0 });
  assert.deepEqual(outlineAnswer(m, true), { x: { kind: "single", option_id: "o1" } });
  assert.deepEqual(outlineAnswer(m, false), { x: { kind: "single", option_id: "o2" } });
  assert.deepEqual(outlineAnswer({ ...m, stop: null }, false), { x: { kind: "other", text: "先不起草" } });
  assert.equal(outlineQuestion([other]), null);
  // 第 31 批真实走查：助手把论点确认与“赔偿基数”“欠薪范围”放在同一张卡里——原先认不出，律师要在两处各确认一次
  assert.deepEqual(outlineQuestion([{ question_id: "q2", questions: [other.questions[0]!, q.questions[0]!] }]), { question_id: "q2", qid: "x", confirm: "o1", stop: "o2", others: 1 });
});

test("依据说法：系统核过的不说成你认可；拦截与未核实写明；演示数据标出", () => {
  assert.match(basisStateText({ check: "version_verified", article_text: "x", demo: false }), /是否撑得住论点由你判断 · 条文原文见下/);
  assert.match(basisStateText({ check: "intercepted", article_text: null, demo: false }), /核对未通过/);
  assert.match(basisStateText({ check: "unchecked", article_text: null, demo: false }), /须你查官方文本/);
  assert.match(basisStateText({ check: "support_pending", article_text: "x", demo: true }), /演示数据/);
});

test("确认的先后：先记决定再代答；没有确认题只记决定；代答失败时决定已记下、错误照常抛出（复核 Q2-20）", async () => {
  const log: string[] = [];
  assert.equal(await confirmAndAnswer({ decide: async () => void log.push("decide"), answer: async () => void log.push("answer") }), "decided_and_answered");
  assert.deepEqual(log, ["decide", "answer"]);
  assert.equal(await confirmAndAnswer({ decide: async () => void log.push("d2"), answer: null }), "decided_only");
  await assert.rejects(confirmAndAnswer({ decide: async () => void log.push("d3"), answer: async () => Promise.reject(new Error("问题不存在或已处理")) }), /问题不存在/);
  assert.equal(log.at(-1), "d3");
  let answered = false;
  await assert.rejects(confirmAndAnswer({ decide: async () => Promise.reject(new Error("至少留一条")), answer: async () => void (answered = true) }), /至少留一条/);
  assert.equal(answered, false, "决定没记下就不代答");
});

test("任务页源码：单题的确认题并进提纲卡、和别的题同卡时确认那一项跟着提纲卡走（第 31 批）；确认走 confirmAndAnswer", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/pages/RunView.tsx", import.meta.url)), "utf8");
  assert.match(src, /questions\.filter\(\(q\) => !\(outlineQ && outlineQ\.others === 0 && q\.question_id === outlineQ\.question_id\)\)/);
  assert.match(src, /answer: outlineQ && outlineQ\.others === 0 \?/);
  assert.match(src, /outlineLock: \{ qid: outlineQ\.qid, confirm: outlineQ\.confirm, confirmed: outline\?\.status === "confirmed" \}/);
  assert.match(src, /confirmAndAnswer\(\{\s*decide: \(\) => api\.decideOutline/);
});
