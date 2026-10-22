/**
 * v9.4 第 19 批 C-04 任务页：逐条决定的组装（改写才传、去掉的依据、至少留一条）、Agent 确认题的识别与代答、依据核验的律师说法；
 * 任务页源码：提纲卡在时确认题不再单独出现，确认先记决定再代答。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basisStateText, decisionsOf, emptyDraft, keptCount, outlineAnswer, outlineQuestion, type OutlineView } from "../src/lib/outline.ts";

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

test("确认题：只认单题、题干含“论点”、选项以“已确认”开头；代答选第一项或“先不起草”", () => {
  const q = { question_id: "q1", questions: [{ id: "x", question: "论点与依据已列在任务页，请确认后选择", options: [{ id: "o1", label: "已确认，按确认的论点起草" }, { id: "o2", label: "先不起草" }] }] };
  const other = { question_id: "q0", questions: [{ id: "y", question: "我方是哪一方？", options: [{ id: "p", label: "原告" }] }] };
  const m = outlineQuestion([other, q])!;
  assert.deepEqual(m, { question_id: "q1", qid: "x", confirm: "o1", stop: "o2" });
  assert.deepEqual(outlineAnswer(m, true), { x: { kind: "single", option_id: "o1" } });
  assert.deepEqual(outlineAnswer(m, false), { x: { kind: "single", option_id: "o2" } });
  assert.deepEqual(outlineAnswer({ ...m, stop: null }, false), { x: { kind: "other", text: "先不起草" } });
  assert.equal(outlineQuestion([other]), null);
  assert.equal(outlineQuestion([{ question_id: "q2", questions: [q.questions[0]!, other.questions[0]!] }]), null, "多题的不是确认题");
});

test("依据说法：系统核过的不说成你认可；拦截与未核实写明；演示数据标出", () => {
  assert.match(basisStateText({ check: "version_verified", article_text: "x", demo: false }), /是否撑得住论点由你判断 · 条文原文见下/);
  assert.match(basisStateText({ check: "intercepted", article_text: null, demo: false }), /核对未通过/);
  assert.match(basisStateText({ check: "unchecked", article_text: null, demo: false }), /须你查官方文本/);
  assert.match(basisStateText({ check: "support_pending", article_text: "x", demo: true }), /演示数据/);
});

test("任务页源码：确认题并进提纲卡；先记决定再代答", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/pages/RunView.tsx", import.meta.url)), "utf8");
  assert.match(src, /questions\.filter\(\(q\) => q\.question_id !== outlineQ\?\.question_id\)/);
  const confirm = src.slice(src.indexOf("const confirmOutline"), src.indexOf("const stopOutline"));
  assert.ok(confirm.indexOf("api.decideOutline") < confirm.indexOf("api.answer"), "先记下律师决定，再答确认题");
});
