/**
 * 意图建议（复核 B3-B24）：取命中最具体的场景；模板不支持的文书不引到起诉状模板。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestScenario } from "../src/lib/scenarios.ts";

test("意图建议：最具体者优先；答辩状、仲裁申请书不引到起诉状模板", () => {
  assert.equal(suggestScenario("帮我起草一份民事起诉状")?.id, "pleading");
  assert.equal(suggestScenario("核对起诉状里的引用是否有效")?.id, "research-lit");
  assert.equal(suggestScenario("帮我写一份答辩状"), null);
  assert.equal(suggestScenario("准备仲裁申请书"), null);
  assert.equal(suggestScenario("员工申请劳动仲裁怎么应对")?.id, "labor-response");
  assert.equal(suggestScenario("审查这份采购合同的风险")?.id, "contract-review");
});
