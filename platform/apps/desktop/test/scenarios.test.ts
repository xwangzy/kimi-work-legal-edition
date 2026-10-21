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
  // 答辩状模板只做民商事一审答辩：二审、仲裁、行政、劳动答辩不引过去（复核 RB16B-16）
  for (const g of ["帮我写二审答辩状", "被上诉人答辩状怎么写", "准备仲裁答辩", "写一份行政诉讼答辩状"]) assert.notEqual(suggestScenario(g)?.id, "defense", g);
  assert.equal(suggestScenario("准备仲裁申请书"), null);
  assert.equal(suggestScenario("员工申请劳动仲裁怎么应对")?.id, "labor-response");
  assert.equal(suggestScenario("审查这份采购合同的风险")?.id, "contract-review");
});
