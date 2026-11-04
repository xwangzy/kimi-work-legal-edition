// V12：要求起草或修订法律文书，最终却输出 Excel。
// 根因：意图建议按命中字数取卡、不看卡的主交付物格式——起草依据里的“违约金计算”“诉讼时效”“交割清单”“核对引用”、
// 修改对象“对方回稿”命中的是金额测算、程序核查、交割清单、引用核验、回稿比对这类主交付物为 Excel 的卡；
// 按建议发起后内核按卡的主交付物要求“必须用 xlsx.render_table 出表”（executor.ts methodPromptLine），律师要的 Word 文书不出。
import assert from "node:assert/strict";
import test from "node:test";
import { SCENARIOS, primaryOutputOf, suggestScenario } from "../src/lib/scenarios.ts";

/** 与内核同一口径的主交付物：卡写明的，没写的取第一项交付件。 */
const primaryOf = (id: string | undefined) => {
  const c = SCENARIOS.find((x) => x.id === id);
  return c ? (primaryOutputOf(c, {}) ?? c.gets[0] ?? "") : "";
};

test("起草文书：起草依据里的计算、时效、清单、引用不把建议引到只出 Excel 的卡", () => {
  const cases: [string, string | null][] = [
    ["按违约金计算起草律师函", "demand-lit"],
    ["请就诉讼时效问题起草法律意见书", "compliance-qa"],
    ["根据尽调清单起草尽调报告", "dd-findings"],
    ["核对引用后修改这份起诉状", "doc-revise"],
    // 没有对应的文书卡：不建议（交给助手按描述做），也不建议交割清单
    ["根据交割清单起草交割确认函", null],
  ];
  for (const [ask, want] of cases) {
    const got = suggestScenario(ask);
    assert.equal(got?.id ?? null, want, ask);
    assert.doesNotMatch(primaryOf(got?.id), /\.xlsx$/i, `${ask} → 主交付物不能是 Excel`);
  }
});

test("修订对方回稿：明说按我方意见改、出修订稿的，建议“按你的意见修改文书”，不建议回稿比对（变更清单.xlsx）", () => {
  for (const ask of ["对方回稿后，请按我方意见修改合同出修订稿", "对方回稿，按以下意见修改：付款期改为30日", "对方回稿了，请按我方意见直接修改，出修订稿和清洁稿"]) {
    assert.equal(suggestScenario(ask)?.id, "doc-revise", ask);
  }
});

test("要的就是表格的照旧建议表格卡；只看回稿改了什么的仍是回稿比对", () => {
  assert.equal(suggestScenario("帮我算一下违约金")?.id, "amount");
  assert.equal(suggestScenario("根据合同起草一份交割清单")?.id, "closing-checklist");
  assert.equal(suggestScenario("做一份尽调清单")?.id, "dd-list");
  assert.equal(suggestScenario("请帮我修订这份证据目录")?.id, "casefile");
  assert.equal(suggestScenario("帮我核查管辖和诉讼时效")?.id, "procedure");
  assert.equal(suggestScenario("对方回稿了，看看改了什么")?.id, "redraft");
  assert.equal(suggestScenario("按对方修改意见看看回稿改了什么")?.id, "redraft");
  assert.equal(suggestScenario("对方起草的合同回稿了，看看改了哪些")?.id, "redraft", "“起草的合同”是材料，不是要起草");
});
