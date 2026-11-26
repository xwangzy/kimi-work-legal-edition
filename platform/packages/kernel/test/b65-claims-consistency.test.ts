// 第 65 批：诉讼请求“并用 / 择一”交付前检查（V39 第二轮研究 R3 第 10 节 C1～C14；R1 第 6 节 N2、N3）
import test from "node:test";
import assert from "node:assert/strict";
import { claimsConsistencyIssues } from "../src/services/claims-consistency.ts";

type Sec = { heading?: string; paragraphs: string[] };

/** 与 deliverable-check.ts 的 flatten 同样的段落写法：节标题一段（“××（标题）”），正文“××第 n 段”。 */
function paras(title: string, sections: Sec[]) {
  const out = [{ where: "标题", text: title }];
  sections.forEach((s, si) => {
    const heading = (s.heading ?? "").trim();
    const name = heading || `第 ${si + 1} 节`;
    if (heading) out.push({ where: `${name}（标题）`, text: heading });
    s.paragraphs.forEach((t, pi) => out.push({ where: `${name}第 ${pi + 1} 段`, text: t }));
  });
  return out;
}

const HEAD: Sec = { paragraphs: ["原告：苏州锐川精密机械有限公司", "被告：嘉兴禾丰包装科技有限公司"] };
const FACTS: Sec = { heading: "事实与理由", paragraphs: ["双方签订《设备采购合同》，约定定金200,000元及违约金条款，被告未按期交货。"] };

function complaint(claims: string[], extra: Sec[] = [], title = "民事起诉状") {
  return claimsConsistencyIssues(title, paras(title, [HEAD, { heading: "诉讼请求", paragraphs: claims }, FACTS, ...extra]));
}

function ids(issues: { fix: string }[]): string[] {
  return issues.map((i) => /（([^）]*第[^）]*条[^）]*)）/.exec(i.fix)?.[1] ?? i.fix.slice(0, 12));
}

test("C1 定金罚则与违约金并请报回（民法典第五百八十八条第一款）；片段不超过 60 字", () => {
  const got = complaint(["1. 判令被告双倍返还定金200,000.00元；", "2. 判令被告支付违约金300,000.00元；", "3. 本案诉讼费由被告承担。"]);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.kind, "claims");
  assert.match(got[0]!.fix, /第五百八十八条第一款/);
  assert.match(got[0]!.text, /双倍返还定金.*违约金/);
  assert.ok(got[0]!.text.length <= 60);
  assert.match(got[0]!.where, /诉讼请求第 1 段、诉讼请求第 2 段/);
  // 同一项里并请也报；“定金罚则”“无权请求返还定金”同样是定金罚则
  assert.equal(complaint(["1. 判令被告双倍返还定金200,000元并支付违约金300,000元；"]).length, 1);
  assert.equal(complaint(["1. 确认被告无权请求返还已交付的定金50,000元；", "2. 判令被告支付违约金80,000元。"]).length, 1);
});

test("C1 反例：备位、择一、超过定金数额的损失、单倍返还定金、否定语境都不报", () => {
  assert.equal(complaint(["1. 判令被告双倍返还定金200,000元；", "2. 如第1项不予支持，则判令被告支付违约金300,000元。"]).length, 0);
  assert.equal(complaint(["1. 判令被告双倍返还定金200,000元或者支付违约金300,000元（由原告择一主张）。"]).length, 0);
  assert.equal(complaint(["1. 判令被告双倍返还定金200,000元；", "2. 判令被告支付违约金300,000元；", "上述第1、2项由原告选择适用。"]).length, 0);
  // 第五百八十八条第二款：定金不足以弥补损失的，可以请求赔偿超过定金数额的损失——不是违约金
  assert.equal(complaint(["1. 判令被告双倍返还定金200,000元；", "2. 判令被告赔偿超过定金数额的损失50,000元。"]).length, 0);
  // 解除后单倍返还定金不是定金罚则
  assert.equal(complaint(["1. 判令被告返还定金100,000元；", "2. 判令被告支付违约金30,000元。"]).length, 0);
  assert.equal(complaint(["1. 判令被告双倍返还定金200,000元（不再主张违约金）。"]).length, 0);
});

test("C2 订金、押金、保证金主张双倍返还报回（合同编通则解释第六十七条第一款）；写明定金性质或单倍返还不报", () => {
  const got = complaint(["1. 判令被告双倍返还订金40,000元；"]);
  assert.equal(got.length, 1);
  assert.match(got[0]!.fix, /合同编通则解释第六十七条第一款/);
  assert.equal(complaint(["1. 判令被告返还押金5,000元及保证金10,000元；"]).length, 0);
  assert.equal(complaint(["1. 判令被告双倍返还订金40,000元（合同第3条约定该订金具有定金性质）；"]).length, 0);
  assert.equal(complaint(["1. 判令被告双倍返还定金40,000元；"]).length, 0);
});

test("C4 解除合同与继续履行同一合同报回（民法典第五百六十六条第一款）；部分解除、不同合同、确认解除通知无效不报", () => {
  const got = complaint(["1. 判令解除原被告签订的《设备采购合同》；", "2. 判令被告继续履行《设备采购合同》项下交货义务。"]);
  assert.equal(got.length, 1);
  assert.match(got[0]!.fix, /第五百六十六条第一款/);
  assert.equal(complaint(["1. 判令解除《设备采购合同》项下第二批订单；", "2. 判令被告继续履行其余订单的交货义务。"]).length, 0);
  assert.equal(complaint(["1. 确认《设备采购合同》已于2026年5月1日解除；", "2. 判令被告继续履行《技术服务合同》。"]).length, 0);
  assert.equal(complaint(["1. 确认被告发出的解除《设备采购合同》的通知无效；", "2. 判令被告继续履行《设备采购合同》。"]).length, 0);
  assert.equal(complaint(["1. 判令被告继续履行《设备采购合同》；", "2. 如被告不能履行，则判令解除《设备采购合同》并赔偿损失。"]).length, 0);
});

test("C5、C6 不报：迟延违约金与继续履行并用（民法典第五百八十五条第三款）；解除与违约金、赔偿损失并用（第五百六十六条第二款）", () => {
  assert.equal(complaint(["1. 判令被告继续履行《设备采购合同》，交付剩余设备3台；", "2. 判令被告支付迟延交货违约金45,000元。"]).length, 0);
  assert.equal(complaint(["1. 确认《设备采购合同》于2026年5月1日解除；", "2. 判令被告返还已付货款500,000元；", "3. 判令被告支付违约金100,000元；", "4. 判令被告赔偿替代采购差价损失46,800元。"]).length, 0);
});

test("C7 确认合同无效又请求违约金或继续履行报回（民法典第一百五十七条、第五百零七条）；条款无效、备位不报", () => {
  const got = complaint(["1. 确认原被告签订的《股权转让协议》无效；", "2. 判令被告支付违约金100,000元。"]);
  assert.equal(got.length, 1);
  assert.match(got[0]!.fix, /第一百五十七条/);
  assert.equal(complaint(["1. 撤销原被告签订的《股权转让协议》；", "2. 判令被告继续履行付款义务。"]).length, 1);
  assert.equal(complaint(["1. 确认《股权转让协议》第8条无效；", "2. 判令被告支付违约金100,000元。"]).length, 0);
  assert.equal(complaint(["1. 判令被告继续履行《股权转让协议》并支付违约金100,000元；", "2. 如《股权转让协议》被认定无效，则判令被告返还股权转让款1,000,000元。"]).length, 0);
});

test("C9 请求里同时写违约责任与侵权责任报回（民法典第一百八十六条）；写明选择的不报", () => {
  const got = complaint(["1. 判令被告承担违约责任，赔偿原告损失80,000元；", "2. 判令被告承担侵权责任，赔偿医疗费20,000元。"]);
  assert.equal(got.length, 1);
  assert.match(got[0]!.fix, /第一百八十六条/);
  assert.equal(complaint(["1. 判令被告赔偿原告损失100,000元（原告选择请求被告承担违约责任，不再主张侵权责任）。"]).length, 0);
});

test("C11 非借贷案件逾期付款违约金与逾期利息并请报回；借贷案件一并主张不报（民间借贷规定第二十九条）", () => {
  const sale = ["1. 判令被告支付货款310,000.00元；", "2. 判令被告支付逾期付款违约金69,010.00元（以310,000.00元为基数，自2025年12月4日起按日万分之五计算至实际清偿之日）；", "3. 判令被告支付逾期付款利息（以310,000.00元为基数，自2025年12月4日起按一年期贷款市场报价利率计算至实际清偿之日）。"];
  const got = complaint(sale);
  assert.equal(got.length, 1);
  assert.match(got[0]!.fix, /第五百八十五条第二款/);
  assert.match(got[0]!.fix, /买卖合同解释第十八条第四款/);
  // 同项“违约金及利息”
  assert.equal(complaint(["1. 判令被告支付拖欠货款200,000元及逾期付款违约金、逾期利息。"]).length, 1);
  // 借贷：出借人可以选择主张逾期利息、违约金，也可以一并主张
  const loan = complaint(["1. 判令被告归还借款本金500,000元；", "2. 判令被告支付逾期利息（以500,000元为基数，自2025年7月1日起按年利率12%计算至实际清偿之日）；", "3. 判令被告支付逾期还款违约金50,000元。"], [], "民事起诉状（民间借贷纠纷）");
  assert.equal(loan.length, 0);
  // 基数不同、期间不重叠的不报
  assert.equal(complaint(["1. 判令被告支付逾期付款违约金（以310,000元为基数计算）；", "2. 判令被告支付垫付款利息损失（以45,000元为基数计算）。"]).length, 0);
  assert.equal(complaint(["1. 判令被告支付逾期付款违约金（自2025年1月1日起至2025年6月30日止）；", "2. 判令被告支付资金占用损失（自2025年7月1日起至实际清偿之日止）。"]).length, 0);
  // 只主张违约金的（真实起诉状 m06）不报；执行阶段“迟延履行期间的债务利息”不算利息请求
  assert.equal(complaint(["1. 判令被告支付货款310,000.00元；", "2. 判令被告支付逾期付款违约金69,010.00元；", "3. 如被告未按期履行，加倍支付迟延履行期间的债务利息。"]).length, 0);
});

const LABOR = "劳动人事争议仲裁申请书";
function labor(claims: string[], extra: Sec[] = [], title = LABOR) {
  return claimsConsistencyIssues(title, paras(title, [{ paragraphs: ["申请人：张某", "被申请人：苏州某科技有限公司"] }, { heading: "仲裁请求", paragraphs: claims }, { heading: "事实与理由", paragraphs: ["申请人不要求继续履行劳动合同。被申请人违法解除劳动合同，应依照劳动合同法第八十七条支付赔偿金。"] }, ...extra]));
}

test("C12 违法解除赔偿金（2N）与经济补偿（N）同时主张报回（劳动合同法实施条例第二十五条）", () => {
  const got = labor(["一、裁令被申请人支付违法解除劳动合同赔偿金80,000元；", "二、裁令被申请人支付解除劳动合同经济补偿金40,000元；", "三、裁令被申请人支付2026年8月工资12,000元。"]);
  assert.equal(got.length, 1);
  assert.match(got[0]!.fix, /实施条例第二十五条/);
  assert.equal(labor(["一、裁令被申请人支付违法解除劳动合同赔偿金80,000元及经济补偿金40,000元。"]).length, 1);
});

test("C12 反例：赔偿金按经济补偿标准计算、竞业限制经济补偿、加付赔偿金、备位都不报", () => {
  assert.equal(labor(["一、裁令被申请人支付违法解除劳动合同赔偿金80,000元（按经济补偿标准的二倍计算，即经济补偿金40,000元×2）；"]).length, 0);
  assert.equal(labor(["一、裁令被申请人支付违法解除劳动合同赔偿金421,948.32元；", "五、裁令被申请人继续按月向申请人支付竞业限制经济补偿，标准为2,500.00元/月；", "六、裁令被申请人出具解除劳动合同证明。"]).length, 0);
  assert.equal(labor(["一、裁令被申请人支付拖欠工资及加付赔偿金6,000元；", "二、裁令被申请人支付解除劳动合同经济补偿40,000元。"]).length, 0);
  assert.equal(labor(["一、裁令被申请人支付违法解除劳动合同赔偿金80,000元；", "二、如仲裁委认定解除合法，则裁令被申请人支付经济补偿40,000元。"]).length, 0);
});

test("C13 恢复劳动关系与违法解除赔偿金同时主张报回（劳动合同法第四十八条）；写明不能继续履行再主张赔偿金的不报", () => {
  const got = labor(["一、裁令恢复申请人与被申请人的劳动关系；", "二、裁令被申请人支付违法解除劳动合同赔偿金80,000元。"]);
  assert.equal(got.length, 1);
  assert.match(got[0]!.fix, /第四十八条/);
  assert.equal(labor(["一、裁令被申请人继续履行与申请人的劳动合同；", "二、如劳动合同不能继续履行，则裁令被申请人支付违法解除劳动合同赔偿金80,000元。"]).length, 0);
  // 事实与理由里“不要求继续履行”不在请求节，不算
  assert.equal(labor(["一、裁令被申请人支付违法解除劳动合同赔偿金80,000元。"]).length, 0);
});

test("C14 惩罚性赔偿没写法定依据报回（民法典第一百七十九条第二款）；事实与理由写了条文的不报", () => {
  const got = complaint(["1. 判令被告退还购车款200,000元；", "2. 判令被告支付购车款三倍的赔偿金600,000元。"]);
  assert.equal(got.length, 1);
  assert.match(got[0]!.fix, /第一百七十九条第二款/);
  assert.equal(complaint(["1. 判令被告退还购车款200,000元；", "2. 判令被告支付购车款三倍的赔偿金600,000元。"], [{ heading: "法律依据", paragraphs: ["被告构成欺诈，依照《中华人民共和国消费者权益保护法》第五十五条第一款，应按购车款的三倍增加赔偿。"] }]).length, 0);
});

test("文书类型与请求节：答辩书、说明类标题、没有请求节的都不查；“诉讼请求：”写成普通段也能找到", () => {
  const bad = ["1. 判令被告双倍返还定金200,000元；", "2. 判令被告支付违约金300,000元。"];
  assert.equal(complaint(bad, [], "民事答辩状").length, 0);
  assert.equal(complaint(bad, [], "起诉状要点说明").length, 0);
  assert.equal(claimsConsistencyIssues("民事起诉状", paras("民事起诉状", [HEAD, { heading: "事实与理由", paragraphs: bad }])).length, 0);
  const inline = paras("民事起诉状", [{ paragraphs: ["原告：甲公司", "被告：乙公司", "诉讼请求：1. 判令被告双倍返还定金20万元；2. 判令被告支付违约金30万元。", "事实与理由：双方签订买卖合同……", "此致"] }]);
  assert.equal(claimsConsistencyIssues("民事起诉状", inline).length, 1);
  // 请求节在“事实与理由”处结束：理由里讨论违约金与定金不报
  const stop = paras("民事起诉状", [{ paragraphs: ["诉讼请求：", "1. 判令被告支付违约金30万元。", "事实与理由：", "被告曾主张双倍返还定金，原告不予认可。"] }]);
  assert.equal(claimsConsistencyIssues("民事起诉状", stop).length, 0);
});

test("上诉请求：撤销一审判项里的违约金不算请求违约金", () => {
  const t = "民事上诉状";
  const p = paras(t, [{ paragraphs: ["上诉人（原审被告）：乙公司"] }, { heading: "上诉请求", paragraphs: ["一、撤销一审判决第二项中关于上诉人支付违约金的部分；", "二、维持一审判决第一项（双倍返还定金200,000元）。"] }]);
  assert.equal(claimsConsistencyIssues(t, p).length, 0);
  const p2 = paras(t, [{ paragraphs: ["上诉人（原审原告）：甲公司"] }, { heading: "上诉请求", paragraphs: ["一、维持一审判决第一项（被上诉人双倍返还定金200,000元）；", "二、改判被上诉人另行支付违约金300,000元。"] }]);
  assert.equal(claimsConsistencyIssues(t, p2).length, 1);
});

test("律师函、催告函：只查列项的要求事项与四条规则；真实催告函（m45）不报", () => {
  const t = "律师函";
  const p = paras(t, [{ paragraphs: ["致：乙公司", "本所受甲公司委托，现要求贵司：", "一、双倍返还定金200,000元；", "二、支付违约金300,000元。", "如贵司逾期不履行，本所将依法提起诉讼。"] }]);
  assert.equal(claimsConsistencyIssues(t, p).length, 1);
  // 函件不查 C11、C14
  const p2 = paras(t, [{ paragraphs: ["现要求贵司：", "一、支付逾期付款违约金50,000元；", "二、支付逾期付款利息8,000元。"] }]);
  assert.equal(claimsConsistencyIssues(t, p2).length, 0);
  // 列项后面的“如贵司……我方将解除合同”不在要求事项里
  const m45 = paras("最后催告函", [{ paragraphs: [
    "为避免损失进一步扩大，我方现最后催告贵司，自本函送达之日起3日内完成以下全部事项：",
    "一、补足第一批A型合格纸箱30,000个，并自行取回现存于我方3号库的不合格A型纸箱30,000个，相关费用由贵司承担。",
    "二、将第二批全部货物交付至订单约定地点，并保证货物符合合同及订单约定的质量标准。",
    "三、支付第二批货物逾期交货违约金1,850.85元。对于第一批A型纸箱，我方主张暂计违约金3,780.00元及替代采购差价损失46,800.00元；其中属于同一损失的部分，依合同第7.4款由贵司支付超过违约金弥补范围的差额，不作重复主张。",
    "四、停止以我方先支付第一批货款作为补货或继续履约的条件。",
    "如贵司在上述期限届满时仍未补足第一批A型合格纸箱，我方将依合同第7.2、8.1款及《中华人民共和国民法典》第五百六十三条行使解除权，并要求继续履行其余订单。",
  ] }]);
  assert.equal(claimsConsistencyIssues("最后催告函", m45).length, 0);
  // 没有列项的函件（真实律师函 m22：一段话写付款要求）不查
  assert.equal(claimsConsistencyIssues(t, paras(t, [{ paragraphs: ["请贵司自本函送达之日起七日内双倍返还定金200,000元并支付违约金300,000元。"] }])).length, 0);
});

test("同一文书同一条规则只报一次；所有片段不超过 60 字", () => {
  const got = complaint([
    "1. 判令被告双倍返还定金200,000元，该定金系原告于2025年9月12日依据《设备采购合同》第三条约定支付至被告指定账户的款项；",
    "2. 判令被告支付违约金300,000元，违约金按合同总价款百分之二十计算，合同总价款为1,500,000元；",
    "3. 判令被告再支付违约金50,000元；",
    "4. 判令被告双倍返还订金40,000元；",
  ]);
  assert.equal(got.length, 2);
  for (const i of got) assert.ok(i.text.length <= 60, i.text);
  assert.deepEqual(ids(got).length, 2);
});

test("当事人与合同不同的不按择一判：一房二卖确认被告与第三人的合同无效、向不同被告分别主张违约与侵权、保证金之外双倍返还定金", () => {
  assert.equal(complaint(["1. 确认被告与第三人签订的《房屋买卖合同》无效；", "2. 判令被告继续履行与原告签订的《房屋买卖合同》，协助原告办理过户登记；", "3. 判令被告支付逾期办证违约金30,000元。"]).length, 0);
  assert.equal(complaint(["1. 撤销被告与第三人签订的《股权转让协议》；", "2. 判令被告偿还货款500,000元并支付违约金50,000元。"]).length, 0);
  assert.equal(complaint(["1. 判令被告一承担违约责任，退还购车款200,000元；", "2. 判令被告二承担侵权责任，赔偿医疗费20,000元。"]).length, 0);
  assert.equal(complaint(["1. 判令被告返还履约保证金50,000元并双倍返还定金200,000元；"]).length, 0);
  assert.equal(complaint(["1. 判令被告双倍返还定金及保证金。"]).length, 0);
});

test("“解除前、解除后”是时间点、劳动合同的解除不是民事合同解除请求（压力回放发现的两类）", () => {
  assert.equal(complaint(["1. 判令被告继续履行《设备采购合同》，交付剩余设备；", "2. 判令被告承担《设备采购合同》解除前已发生的维修费用20,000元。"]).length, 0);
  assert.equal(labor(["一、裁令被申请人继续履行《竞业限制协议》，按月支付竞业限制经济补偿；", "二、确认双方劳动合同于2026年9月4日解除。"]).length, 0);
});
