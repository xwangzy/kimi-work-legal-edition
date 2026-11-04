// V13 真实走查（K3.1-Pro、真实界面）：姓名识别的两处误认与一处漏认
// - N2 仓储合同审查：法规检索结果里的《民法典》原文“当事人一方违约”“当事人一方明确表示”学出“方违约”“方明”，此后意见书里的
//   “乙方违约”“甲方违约”送给模型时成了“乙〔自然人〕”，交付前独立复核据此判“正文被占位符截断”，修正轮把清洁的 Word 改坏；
// - N1 商铺租赁：承租人法定代表人“郑可欣”在合同首部、签署栏、EMS 签收记录里一处都没认出，按原文发给模型；
// - N1：律师写的“我方代理出租人明远商业”把客户简称学成自然人“明远商”。
import assert from "node:assert/strict";
import test from "node:test";
import { MatterTokenizer } from "../src/index.ts";
import { recognizeNames, stillLooksLikeName } from "../src/names.ts";

const persons = (t: MatterTokenizer) => t.table().filter((e) => e.category === "person").map((e) => e.value);

test("法条原文“当事人一方违约”“一方明确表示”不学出姓名；“当事人一：张三”的序号写法照常", () => {
  for (const s of ["当事人一方违约的，应当承担继续履行、采取补救措施或者赔偿损失等违约责任", "在履行期限届满前，当事人一方明确表示或者以自己的行为表明不履行主要债务", "当事人一方因第三人的原因造成违约的"]) {
    assert.deepEqual([...recognizeNames(s)], [], s);
  }
  assert.deepEqual([...recognizeNames("当事人一：张三，男")], ["张三"]);
  assert.deepEqual([...recognizeNames("原告一：李四，")], ["李四"]);
});

test("已学进令牌表的“方违约”“方明”“单次涨”“位复核”退役：不再替换新文字，旧代号照常还原", () => {
  for (const v of ["方违约", "方明", "单次涨", "位复核", "官网", "应否", "和送达"]) assert.equal(stillLooksLikeName(v), false, v);
  const t = new MatterTokenizer({ matterKey: Buffer.alloc(32, 7), table: [{ token: "〔自然人·GJ62GK〕", category: "person", value: "方违约", normalized: "方违约", source: "recognizer" }] });
  assert.equal(t.tokenize("因乙方违约导致合同解除的，甲方无需支付补偿").text, "因乙方违约导致合同解除的，甲方无需支付补偿");
});

test("角色词 + 冒号后的两字名首字是“可、中、承……”：照常认出（“法定代表人：郑可欣”）；没有分隔符的“甲方可以”“当事人可能”不受影响", () => {
  for (const [s, want] of [
    ["法定代表人：郑可欣\n住所：杭州市", "郑可欣"],
    ["联系人：郑可欣，电话 0571-0000-2210", "郑可欣"],
    ["签收人：郑可欣。", "郑可欣"],
    ["授权代表：郑可欣", "郑可欣"],
    ["法定代表人：王中华，", "王中华"],
    ["收货人：李承志", "李承志"],
  ] as const) {
    assert.deepEqual([...recognizeNames(s)], [want], s);
  }
  for (const s of ["甲方可以解除本合同", "当事人可能因此遭受损失", "乙方中途退出的", "出租人可于期满前通知", "联系人：方可，"]) {
    assert.deepEqual([...recognizeNames(s)], [], s);
  }
});

test("本段里接着已知机构名称往下写的“姓名”是机构简称（“出租人明远商业，”）；以创始人姓名作字号的公司，其法定代表人照常识别", () => {
  const t = new MatterTokenizer({ matterKey: Buffer.alloc(32, 7), parties: [{ name: "杭州钱塘明远商业管理有限公司", kind: "org" }] });
  const r = t.tokenize("我方代理出租人明远商业，准备起诉。法定代表人：周明远，");
  assert.equal(r.text.includes("明远商业"), true, r.text);
  assert.deepEqual(persons(t), ["周明远"]);
  const t2 = new MatterTokenizer({ matterKey: Buffer.alloc(32, 7), parties: [{ name: "北京李宁体育用品有限公司", kind: "org" }] });
  t2.tokenize("法定代表人：李宁，");
  assert.deepEqual(persons(t2), ["李宁"]);
});

test("“当事人解释：”“原告解答，”“甲方解约。”里的“解”字头常用词不是姓名；已学进的“解释”退役；“解”姓真名照常（“原告：解小飞，”）", () => {
  for (const s of ["当事人解释：不同意", "原告解答，", "出租人解约。", "被告解决：", "申请人解押，"]) assert.deepEqual([...recognizeNames(s)], [], s);
  assert.equal(stillLooksLikeName("解释"), false);
  assert.deepEqual([...recognizeNames("原告：解小飞，男")], ["解小飞"]);
});
