/**
 * V11 遗留 F9：要我方在对方回稿上直接改的，引到“按你的意见修改文书”（出修订稿与清洁稿）；审对方改了什么的仍引到回稿重审。
 * 改前：“对方回稿了，按我们的意见把回稿改好，给我 Word”被引到回稿重审卡（只出变更清单），律师拿不到改好的 Word。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { suggestScenario } from "../src/lib/scenarios.ts";

test("在对方回稿上改：引到按意见修改文书", () => {
  for (const s of [
    "对方回稿了，按我们的意见把回稿改好，给我 Word",
    "请在对方回稿上直接修改：付款改为 3-4-3，验收期改为 15 个工作日",
    "按我方上一轮的意见把对方回稿修订好，出修订稿",
    "就对方回稿修改第七条违约责任和第九条争议解决",
  ]) assert.equal(suggestScenario(s)?.id, "doc-revise", s);
});

test("审对方改了什么：仍引到回稿重审（对照）", () => {
  for (const s of [
    "对方回稿了，帮我看看改了什么",
    "对方回稿修改的地方有哪些风险，比对一下",
    "比对我方上一稿与对方回稿，只对改动部分重新审查",
  ]) assert.notEqual(suggestScenario(s)?.id, "doc-revise", s);
});
