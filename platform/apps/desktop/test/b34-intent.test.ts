// 第 34 批：意图建议先看律师“要什么”的请求句，案情事实里的词不再抢走或排除卡片
// （真实走查：“帮我起草一份民事起诉状。基本事实：……违约金……分段计算……”被建议成“金额测算”，按建议点下去只出 Excel 计算明细）
import assert from "node:assert/strict";
import test from "node:test";
import { guessContractType, suggestScenario } from "../src/lib/scenarios.ts";

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

test("合同类型预选：事项名括注的立场（“采购方”）不当作合同类型；SaaS / 数据处理协议预选“服务 / 技术服务”；任务说明也参与（第 34 批 T2 真实走查）", () => {
  assert.equal(guessContractType([], "康禾大药房SaaS订阅与数据处理协议（采购方）"), "服务 / 技术服务");
  assert.equal(guessContractType([], "康禾大药房项目（采购方）"), null, "括注的立场不参与");
  assert.equal(guessContractType([], "某某项目", "起草一份SaaS订阅服务与数据处理协议，我方是采购方"), "服务 / 技术服务");
  assert.equal(guessContractType(["设备采购合同.docx"], "某某项目（采购方）"), "买卖", "文件名仍优先");
  assert.equal(guessContractType([], "甲公司股权转让（受让方）"), "股权转让");
});

test("复合请求（“整理成证据目录，并写一份证据分析、说明能主张的本金和利息”）不建议单张卡；不调用 AI 的本机整理卡不接要分析、计算的请求（第 34 批 T6）", () => {
  const t6 = "当事人蒋文博借钱给方立新一直没还，准备起诉。帮我把借条、转账流水、还款记录和微信聊天整理成证据目录（Excel），并写一份证据分析，说明能主张的本金和利息、哪些款项有争议。";
  assert.equal(suggestScenario(t6), null);
  assert.notEqual(suggestScenario("整理证据目录，分析一下能主张多少本金")?.id, "casefile");
  assert.equal(suggestScenario("帮我整理一下证据目录")?.id, "casefile", "只要目录的仍是本机整理");
  assert.equal(suggestScenario("帮我算一下违约金，然后起草起诉状")?.id, "pleading", "“然后”不算并列成果，起诉状方法本身会算金额");
  assert.equal(suggestScenario(D1)?.id, "pleading");
});

test("路由体检（第 34 批，30 句律师常用说法）：审对方回稿、答辩状并整理证据、员工已主张后的应诉", () => {
  assert.equal(suggestScenario("这份租赁合同对方改了几处，帮我看看他们改了什么，哪些不能接受")?.id, "redraft");
  assert.equal(suggestScenario("我们是被告，原告的起诉状说我们欠款200万，其实已经付了80万，帮我写答辩状并整理付款证据"), null, "一句话两种成果，交给助手分步做");
  assert.equal(suggestScenario("员工主张违法解除赔偿金，我们是用人单位，帮我评估风险")?.id, "labor-response");
  assert.equal(suggestScenario("解除劳动合同前的风险")?.id, "labor-termination", "解除前的评估不变");
  assert.equal(suggestScenario("帮我把这份律师函里的金额改成85万，期限改成15日")?.id, "doc-revise", "我方改文书不变");
});
