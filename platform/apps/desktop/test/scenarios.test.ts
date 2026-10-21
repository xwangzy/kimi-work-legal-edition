/**
 * 意图建议（复核 B3-B24）：取命中最具体的场景；模板不支持的文书不引到起诉状模板。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestScenario } from "../src/lib/scenarios.ts";

test("意图建议：最具体者优先；答辩状、仲裁申请书不引到起诉状模板", () => {
  assert.equal(suggestScenario("帮我起草一份民事起诉状")?.id, "pleading");
  assert.equal(suggestScenario("核对起诉状里的引用是否有效")?.id, "research-lit");
  assert.equal(suggestScenario("帮我写一份答辩状")?.id, "defense", "答辩状有了自己的卡（v9.3 诉讼线文书），不引到起诉状");
  assert.equal(suggestScenario("对方证据怎么写质证意见")?.id, "cross-exam");
  assert.equal(suggestScenario("庭后写一份代理词")?.id, "agency");
  assert.equal(suggestScenario("帮我分析一下案情，这个案子怎么打")?.id, "case-analysis", "Z3 #28");
  assert.equal(suggestScenario("梳理争点和补证")?.id, "issues", "说争点仍引到争点与证据分析");
  // 答辩状模板只做民商事一审答辩：二审、仲裁、行政、劳动答辩不引过去（复核 RB16B-16）
  for (const g of ["帮我写二审答辩状", "被上诉人答辩状怎么写", "准备仲裁答辩", "写一份行政诉讼答辩状"]) assert.notEqual(suggestScenario(g)?.id, "defense", g);
  assert.equal(suggestScenario("准备仲裁申请书"), null);
  assert.equal(suggestScenario("员工申请劳动仲裁怎么应对")?.id, "labor-response");
  assert.equal(suggestScenario("审查这份采购合同的风险")?.id, "contract-review");
});

test("示例事项说明按业务线（Z3 #27）", async () => {
  const { sampleBannerText } = await import("../src/lib/scenarios.ts");
  assert.match(sampleBannerText({ stance: "原告" }), /证据目录.*案情分析与诉讼策略/);
  assert.match(sampleBannerText({ stance: "受让方" }), /审查意见/);
});

test("意图建议不把审合同、劳动争议引到案情分析（余项续复核 RC-B-12）", async () => {
  const { suggestScenario } = await import("../src/lib/scenarios.ts");
  assert.notEqual(suggestScenario("审查这份合同的诉讼风险")?.id, "case-analysis");
  assert.notEqual(suggestScenario("这份合同签了以后有什么诉讼风险")?.id, "case-analysis");
  assert.equal(suggestScenario("员工申请劳动仲裁，帮我分析案情")?.id, "labor-response");
  assert.equal(suggestScenario("这个劳动仲裁案子风险大吗")?.id, "labor-response");
  assert.equal(suggestScenario("帮我分析一下这个买卖合同纠纷的案情")?.id, "case-analysis");
  assert.equal(suggestScenario("被起诉了，风险在哪里")?.id, "case-analysis");
});

test("示例事项说明按整理任务状态写；我方地位分清拟起诉与可能被诉（余项续复核 RC-B-13）", async () => {
  const { sampleBannerText, SCENARIOS } = await import("../src/lib/scenarios.ts");
  const lit = { stance: "原告" };
  assert.match(sampleBannerText(lit, "done"), /已在这台电脑上按规则整理出/);
  assert.match(sampleBannerText(lit, "running"), /正在这台电脑上按规则整理/);
  assert.match(sampleBannerText(lit, "failed"), /整理还没有完成/);
  assert.doesNotMatch(sampleBannerText(lit, null), /已在这台电脑上按规则整理出/);
  const side = SCENARIOS.find((c) => c.id === "case-analysis")!.fields!.find((f) => f.key === "side")!;
  assert.ok(side.options!.includes("尚未起诉（我方拟起诉）") && side.options!.includes("尚未起诉（对方可能起诉）"));
});
