// 第 34 批：意图建议先看律师“要什么”的请求句，案情事实里的词不再抢走或排除卡片
// （真实走查：“帮我起草一份民事起诉状。基本事实：……违约金……分段计算……”被建议成“金额测算”，按建议点下去只出 Excel 计算明细）
import assert from "node:assert/strict";
import test from "node:test";
import { suggestScenario } from "../src/lib/scenarios.ts";

const D1 =
  "帮我起草一份民事起诉状。基本事实：2025年11月3日，我方杭州云帆网络科技有限公司（乙方）与宁波百川贸易有限公司（甲方）签订《供应链管理系统软件开发合同》，合同总价48万元，分三期付款：签约后5日内付30%（14.4万元）；系统上线后10日内付40%（19.2万元）；验收合格后15日内付30%（14.4万元）。" +
  "合同第9.2条约定：甲方逾期付款的，每逾期一日按逾期金额的万分之五支付违约金，违约金总额不超过合同总价的10%。2026年7月10日我方发出律师催告函。" +
  "诉请：支付合同款33.6万元；支付逾期付款违约金（分段计算至实际付清之日，以4.8万元为限）；诉讼费由被告承担。";

test("请求句点名了文书，事实里的“违约金……计算”不再把它引到金额测算（真实走查原句）", () => {
  assert.equal(suggestScenario(D1)?.id, "pleading");
  assert.equal(suggestScenario("对方欠我们货款，违约金一直没算。帮我写起诉状。")?.id, "pleading");
  assert.equal(suggestScenario("诉讼请求：判令被告支付利息。请帮我起草起诉状")?.id, "pleading", "“诉讼请求”“诉请”里的“请”不算请求句");
});

test("事实里出现排除词（“修改”）不再排除请求句点名的卡", () => {
  assert.equal(suggestScenario("帮我写起诉状。对方曾两次要求修改合同付款条款，我方未同意。")?.id, "pleading");
  assert.equal(suggestScenario("原告申请财产保全后，法院裁定冻结。帮我写答辩状。")?.id, "defense", "“申请”里的“请”不算请求句");
});

test("请求句里认不出时仍按全文（原有行为）", () => {
  assert.equal(suggestScenario("收到员工的劳动仲裁申请书")?.id, "labor-arb-defense");
  assert.equal(suggestScenario("帮我看看。对方欠款的违约金怎么计算")?.id, "amount");
  assert.equal(suggestScenario("这份合同的违约金条款帮我改一下")?.id, "doc-revise");
});
