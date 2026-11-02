// 第 35 批：审查与改原件的分辨
// （真实走查 N3：“请审查德隆发来的《设备采购及安装合同》……出一份审查意见书，并给出建议的修改条款”被建议成“按你的意见修改文书”，
// 按建议点下去只出修订稿与清洁稿，律师要的审查意见书不会出）
import assert from "node:assert/strict";
import test from "node:test";
import { SCENARIOS, startPanelInitial, suggestScenario } from "../src/lib/scenarios.ts";

const N3 =
  "请审查德隆发来的《设备采购及安装合同》，我方是买方恒川精密。结合采购部的背景说明，重点看价款与税、付款、交货与风险、验收、质保、违约责任和争议解决，出一份审查意见书，并给出建议的修改条款。";

test("要审查成果（审查意见书、修改建议）的引到审合同，不引到按意见修改文书（真实走查原句）", () => {
  assert.equal(suggestScenario(N3)?.id, "contract-review");
  assert.equal(suggestScenario("审一下这份采购合同，提出修改建议")?.id, "contract-review");
  assert.equal(suggestScenario("帮我看看这份合同有什么风险，给出修改建议")?.id, "contract-review");
  assert.equal(suggestScenario("审查这份合同并提修改意见")?.id, "contract-review", "“审查+合同”与“修改+合同”同分、没有改写动作：审查");
  assert.equal(suggestScenario("这份合同帮我把关一下")?.id, "contract-review");
  assert.equal(suggestScenario("请出具一份审查意见书")?.id, "contract-review");
});

test("有明确改写动作的仍是我方改原件", () => {
  assert.equal(suggestScenario("审查合同，按我方立场修改后出修订稿")?.id, "doc-revise");
  assert.equal(suggestScenario("请按以下意见修改这份合同：付款期改为30日")?.id, "doc-revise");
  assert.equal(suggestScenario("我方是承租人。对方发来的《房屋租赁合同》请按以下意见直接在原件上修改，出修订稿和清洁稿")?.id, "doc-revise");
  assert.equal(suggestScenario("帮我把这份律师函里的金额改成85万，期限改成15日")?.id, "doc-revise");
});

// 第 35 批真实走查 R3：首页写的三个问题进了“补充要求”，必填的“问题”为空、开始按钮点不了

test("开始面板：卡片有必填的“问题”时，输入框里的话预填进问题栏，补充要求留空；其余卡片照旧作补充要求", () => {
  const advice = SCENARIOS.find((c) => c.skill === "client-advice")!;
  const ask = "客户问三个问题：一是解除是否合法；二是竞业限制能否追责；三是下一步怎么办。请出一份正式的法律意见书。";
  assert.deepEqual(startPanelInitial(advice, ask), { values: { question: ask }, extra: "" });
  const memo = SCENARIOS.find((c) => c.skill === "legal-research-memo" && c.fields.some((f) => f.key === "question" && f.required))!;
  assert.equal(startPanelInitial(memo, "股东未实缴出资时对公司债务的责任").values.question, "股东未实缴出资时对公司债务的责任");
  const draft = SCENARIOS.find((c) => c.skill === "contract-draft")!;
  assert.deepEqual(startPanelInitial(draft, "起草一份股权转让协议"), { values: {}, extra: "起草一份股权转让协议" });
  assert.deepEqual(startPanelInitial(advice, "  "), { values: {}, extra: "  " }, "空输入不预填");
});
