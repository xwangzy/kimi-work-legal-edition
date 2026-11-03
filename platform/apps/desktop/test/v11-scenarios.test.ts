/**
 * V11 界面走查与路由体检：开始面板预选最旧的一版 Word（D6）；“起草 + 文书名”不带“一份”时落到只出 Excel 的卡（F8）；
 * 律师点名要法律意见书时主交付物仍是《顾问答复》（D10）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGoal, preselectMaterials, primaryOutputOf, SCENARIOS, startPanelInitial, suggestScenario } from "../src/lib/scenarios.ts";

const card = (id: string) => SCENARIOS.find((c) => c.id === id)!;

test("D6 审合同 / 按意见修改 / 文稿体检预选最近导入的一份 Word（内核按新到旧返回；有 created_at 时按时间取，不依赖顺序）", () => {
  // 内核 matters.get 的顺序：新到旧
  const kernelOrder = [
    { document_version_id: "v3", filename: "付款记录.xlsx", created_at: "2026-11-03T10:03:00Z" },
    { document_version_id: "v2", filename: "采购合同_对方回稿.docx", created_at: "2026-11-03T10:02:00Z" },
    { document_version_id: "v1", filename: "采购合同_初稿.docx", created_at: "2026-11-03T10:01:00Z" },
  ];
  for (const skill of ["contract-review", "doc-revise", "citation-check"]) {
    const c = SCENARIOS.find((x) => x.skill === skill && x.minMaterials > 0)!;
    assert.deepEqual(preselectMaterials(c, kernelOrder), ["v2"], skill);
    assert.deepEqual(preselectMaterials(c, [...kernelOrder].reverse()), ["v2"], `${skill}：顺序反过来也取最新`);
    assert.deepEqual(preselectMaterials(c, kernelOrder.map(({ created_at: _c, ...d }) => d)), ["v2"], `${skill}：没有时间按新到旧取第一份`);
  }
  assert.deepEqual(preselectMaterials({ minMaterials: 1, scenario: "a1.agent_task", skill: "contract-review" }, [{ document_version_id: "p", filename: "扫描件.pdf", created_at: "2026-11-03T10:00:00Z" }]), ["p"]);
});

test("F8 “起草 + 文书名”不带“一份”：建议起草文书的卡，不落到只出 Excel 的金额测算", () => {
  for (const g of ["帮我起草起诉状，违约金分段计算", "请起草答辩状，对方主张的利息要重新计算", "撰写起诉状，金额按合同约定计算违约金"]) {
    const s = suggestScenario(g);
    assert.ok(s, g);
    assert.notEqual(s!.skill, "amount-calc", g);
    assert.match(String(s!.skill), /pleading-draft|defense-draft/, g);
  }
  // 对照：真的只要算钱的照常建议金额测算
  assert.equal(suggestScenario("帮我算一下违约金和逾期利息")?.skill, "amount-calc");
});

test("D10 顾问答复卡：律师点名要法律意见书时主交付物为《法律意见书（草稿）》，没点名仍是《顾问答复》", () => {
  const c = card("compliance-qa");
  const named = startPanelInitial(c, "公司为股东借款提供担保是否有效？请出具法律意见书");
  assert.equal(named.values.form, "法律意见书（草稿）");
  assert.equal(primaryOutputOf(c, named.values), "法律意见书（草稿）.docx");
  assert.match(buildGoal(c, named.values, named.extra), /交付形式：法律意见书（草稿）/);
  const plain = startPanelInitial(c, "员工加班费的计算基数能不能按最低工资？");
  assert.equal(plain.values.form, undefined);
  assert.notEqual(primaryOutputOf(c, plain.values), "法律意见书（草稿）.docx");
  assert.doesNotMatch(buildGoal(c, plain.values, plain.extra), /交付形式/);
  assert.equal(primaryOutputOf(c, { form: "顾问答复" }), primaryOutputOf(c, {}));
});
