/**
 * V14 第 39 批独立评分发现的两类交付件问题，交付前检查要报出来：
 * ①争点矩阵里出现“称呼与全名代号按任务说明通常指同一人”（写给助手的隐私代号说明进了交付件）；
 * ②案情分析备忘录三个“二、基本案情”、六个“三、争点”（同一级标题分次写、每次重写序号）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDeliverable, headingNumberIssues } from "../src/services/deliverable-check.ts";

test("代号与任务说明的说法被报为内部用语；正文里正常的“产品代号”不报", () => {
  const r = checkDeliverable("争点证据矩阵", [{ heading: "说明", paragraphs: ["周总与周启明的称呼与全名代号按任务说明通常指同一人。", "本合同项下产品代号为 RC-F860。"] }]);
  const hits = r.issues.filter((i) => i.kind === "internal_term").map((i) => i.text);
  assert.ok(hits.some((t) => /全名代号/.test(t)), JSON.stringify(r.issues));
  assert.ok(hits.some((t) => /按任务说明/.test(t)));
  assert.equal(hits.some((t) => /产品代号/.test(t)), false);
});

test("节标题序号重复、跳号报出；正常的一、二、三不报", () => {
  const ok = headingNumberIssues([{ heading: "一、结论", paragraphs: [] }, { heading: "二、基本案情", paragraphs: [] }, { heading: "三、争点", paragraphs: [] }, { heading: "十、附件", paragraphs: [] }].slice(0, 3));
  assert.deepEqual(ok, []);
  const dup = headingNumberIssues([{ heading: "一、结论", paragraphs: [] }, { heading: "二、基本案情", paragraphs: [] }, { heading: "二、基本案情（续）", paragraphs: [] }, { heading: "三、争点", paragraphs: [] }]);
  assert.equal(dup.length, 1);
  assert.match(dup[0]!.fix, /重复/);
  const gap = headingNumberIssues([{ heading: "一、结论", paragraphs: [] }, { heading: "三、争点", paragraphs: [] }]);
  assert.equal(gap.length, 1);
  assert.match(gap[0]!.fix, /不连续/);
  // 十一、十二 照常识别
  assert.deepEqual(headingNumberIssues(Array.from({ length: 12 }, (_, i) => ({ heading: `${["一","二","三","四","五","六","七","八","九","十","十一","十二"][i]}、第${i + 1}部分`, paragraphs: [] }))), []);
});

test("上诉状核对清单里的“住所代号”“律师任务说明”“费用工具提示”报为内部用语（表格也查）", () => {
  const r = checkDeliverable("提交前核对清单", [{ heading: "核对清单", paragraphs: [], table: { columns: ["事项", "依据"], rows: [["当事人信息", "双方名称、住所代号、统一社会信用代码代号及法定代表人已按判决书填写。"], ["上诉期限", "律师任务说明；民诉法解释第三百二十一条"], ["上诉费", "费用工具提示一"]] } }]);
  const hits = r.issues.filter((i) => i.kind === "internal_term").map((i) => i.text);
  assert.ok(hits.some((t) => /住所代号/.test(t)), JSON.stringify(r.issues));
  assert.ok(hits.some((t) => /信用代码代号/.test(t)));
  assert.ok(hits.some((t) => /律师任务说明/.test(t)));
  assert.ok(hits.some((t) => /费用工具/.test(t)));
  const ok = checkDeliverable("核对清单", [{ heading: "说明", paragraphs: ["本合同项下产品代号为 RC-F860；上诉状已按一审判决书核对当事人住所。"] }]);
  assert.equal(ok.issues.filter((i) => i.kind === "internal_term").length, 0, JSON.stringify(ok.issues));
});

test("同一级的“（一）（二）”节标题重复报出（法规研究备忘录：每个小节都带上一层序号）；正常的（一）（二）（三）与“一、”下重新计数不报；“已核验且支持命题”“任务事实”报为内部用语", () => {
  const h = (heading: string) => ({ heading, paragraphs: [] as string[] });
  const bad = headingNumberIssues([h("一、问题与范围"), h("二、分析"), h("（一）相关规则"), h("（一）适用于本事项"), h("（二）质保期内质量问题"), h("（二）相关规则：减价"), h("三、相反依据")]);
  assert.equal(bad.length, 2, JSON.stringify(bad));
  assert.match(bad[0]!.fix, /重复/);
  const ok = headingNumberIssues([h("一、结论"), h("（一）检验期"), h("（二）质保期"), h("二、分析"), h("（一）规则"), h("（二）适用"), h("（三）小结")]);
  assert.deepEqual(ok, []);
  const r = checkDeliverable("研究备忘录", [{ heading: "一、简答", paragraphs: ["该条已核验且支持命题。", "按任务事实，买方于验收后8个月提出异议。"] }]);
  const hits = r.issues.filter((i) => i.kind === "internal_term").map((i) => i.text);
  assert.ok(hits.some((t) => /支持命题/.test(t)), JSON.stringify(r.issues));
  assert.ok(hits.some((t) => /任务事实/.test(t)));
});

test("互引的条存在、但说的事项在别的条：报出（A 评分：13.1“第二十条约定的过渡期”，过渡期在第二十一条）；指对了、法条引用、事项不在任何条标题里的都不报", () => {
  const art = (h: string, ps: string[] = ["……"]) => ({ heading: h, paragraphs: ps });
  const secs = [
    art("第一条 定义"), art("第十三条 商标与知识产权许可", ["13.1 在本协议期限及第二十条约定的过渡期内，甲方许可乙方使用商标。", "13.2 第二十一条约定的过渡期届满后乙方停止使用。", "13.3 依《民法典》第二十条的规定处理。", "13.4 按第二十条约定的价格回购。", "13.5 第二十条约定的通知方式另行确定。"]),
    art("第二十条 终止后的库存回购"), art("第二十一条 终止后过渡期与交接"), art("第二十二条 通知与送达"),
  ];
  const hits = checkDeliverable("经销协议", secs).issues.filter((i) => i.kind === "cross_ref");
  assert.equal(hits.length, 2, JSON.stringify(hits));
  assert.match(hits[0]!.fix, /第 20 条是“终止后的库存回购”，“过渡期”在第 21 条/);
  assert.match(hits[1]!.fix, /“通知”在第 22 条/);
});
