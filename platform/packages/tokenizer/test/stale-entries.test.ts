/**
 * 旧规则误认、已存进事项令牌表的条目（v9.4 第 25 批）：“律师的任务说明”让“任务”成了〔自然人·…〕，并写进事项令牌表——
 * 此后这个事项的每个任务都把“任务”换掉。现行规则不再认它；表里的旧条目保留（旧成果里的代号照常还原），但不再拿去匹配新文字。
 * 律师登记的当事人词典条目与令牌表里来源为词典的条目不受影响。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { MatterTokenizer, recognizeNames, restoreTokens, stillLooksLikeName } from "../src/index.ts";

const KEY = randomBytes(32);

test("现行规则：方法正文里的常见写法不再认作姓名，真的姓名照常认出", () => {
  for (const t of [
    "模板与律师的任务说明冲突时，以律师的说明为准。",
    "有限公司股东向股东以外的人转让股权；自记载于股东名册时起可以主张行使股东权利。",
    "遇到时告知律师；上诉范围须律师逐项确认；内容待律师判断；以哪一份为准时问律师。",
    "利息（先息后本或按约定）由律师确认；不明时向律师确认。",
    "十类请求逐项写 涉及·不涉及·待确认 与理由；证据（原件·申请鉴定·申请证人出庭·补充反证·调查取证）。",
    "被认定违法解除、劳动者主张赔偿金；出租人解除权；全体董事和监事；章程另有规定的除外。",
  ]) assert.deepEqual([...recognizeNames(t)], [], t);
  assert.deepEqual([...recognizeNames("原告：王明，男。证人李华说明了情况。委托代理人张晓律师到庭。")].sort(), ["张晓", "李华", "王明"].sort());
  assert.deepEqual([...recognizeNames("证人阿卜杜拉·买买提出庭作证。")], ["阿卜杜拉·买买提"]);
});

test("stillLooksLikeName：旧误认的值不像姓名，常见姓名照常像", () => {
  for (const v of ["任务", "权利", "时告知", "由律师", "向股东", "解除权", "涉及·不涉及·待"]) assert.equal(stillLooksLikeName(v), false, v);
  for (const v of ["王明", "李华", "欧阳晓晨", "张晓", "阿卜杜拉·买买提", "任晓东"]) assert.equal(stillLooksLikeName(v), true, v);
});

test("令牌表里旧规则认出的“任务”：不再匹配新文字，旧代号照常还原；律师登记的词典条目照常匹配", () => {
  const old = new MatterTokenizer({ matterKey: KEY });
  const stale = old.tokenFor("person", "任务", "recognizer");
  const real = old.tokenFor("person", "任晓东", "recognizer");
  const t = new MatterTokenizer({ matterKey: KEY, table: old.table() });
  const r = t.tokenize("本任务由任晓东负责。任务说明见附件。");
  assert.equal(r.text, `本任务由${real.token}负责。任务说明见附件。`);
  // 旧成果里的代号照常还原
  assert.equal(restoreTokens(`【${stale.token}】审查合同`, t.table()).text, "【任务】审查合同");
  // 律师自己登记的（词典来源）不受影响
  const dict = new MatterTokenizer({ matterKey: KEY, parties: [{ name: "任务", kind: "person" }] as any });
  assert.match(dict.tokenize("任务到场").text, /〔自然人·/);
});

test("复核 Q7-01 / Q7-04：音译名与含“项、监、劳”等字的真名照常整名认出；退役只针对列明的误认值", () => {
  const cases: [string, string][] = [
    ["证人阿不都热依木·买买提出庭作证。", "阿不都热依木·买买提"],
    ["原告：理查德·史密斯，男。", "理查德·史密斯"],
    ["证人约翰·理查兹出庭作证。", "约翰·理查兹"],
    ["证人阿不来提·吐尔逊出庭作证。", "阿不来提·吐尔逊"],
    ["证人艾力·阿不力孜出庭作证。", "艾力·阿不力孜"],
    ["联系人：查尔斯·王，电话", "查尔斯·王"],
    ["证人王项明说", "王项明"],
    ["联系人：张小项，电话 1", "张小项"],
    ["委托代理人李劳动律师到庭", "李劳动"],
    ["王监军律师到庭", "王监军"],
  ];
  for (const [t, n] of cases) assert.deepEqual([...recognizeNames(t)], [n], t);
  for (const v of ["阿不都热依木·买买提", "理查德·史密斯", "王项明", "王监军", "李劳动", "查尔斯·王"]) assert.equal(stillLooksLikeName(v), true, v);
  // 以前认出、存在表里的音译名：仍当已知姓名匹配新文字
  const old = new MatterTokenizer({ matterKey: KEY });
  const e = old.tokenFor("person", "理查德·史密斯", "recognizer");
  assert.equal(new MatterTokenizer({ matterKey: KEY, table: old.table() }).tokenize("理查德·史密斯签了字").text, `${e.token}签了字`);
});


test("“承担任何……”不是“担任 + 姓名”（第 27 批真实模型走查：“不承担任何间接损失”的“何间接”曾被认成姓名）；真正的“担任”照常认", async () => {
  const { recognizeNames } = await import("../src/names.ts");
  for (const t of ["卖方在本合同项下的全部赔偿责任以已收取价款的 10% 为限，且不承担任何间接损失、利润损失。", "乙方不承担任何间接或附带损失。", "买方不承担任何连带责任。"]) {
    assert.deepEqual([...recognizeNames(t)], [], t);
  }
  assert.ok(recognizeNames("由公司股东会选举产生，担任：张明月，任期三年。").has("张明月"), "“担任：姓名”照常认出");
});

test("合同里“角色词 + 常用词”不是姓名（第 27 批真实模型走查：卖方严重违约、买方严格按照、乙方全面履行、承租人连续两个月）；早先误认进令牌表的这些值不再匹配新文字", async () => {
  const { recognizeNames } = await import("../src/names.ts");
  for (const t of ["卖方严重违约的，买方有权解除合同。", "买方严格按照约定验收。", "乙方全面履行合同义务。", "承租人连续两个月未付租金的，出租人可以解除。", "卖方严重迟延交付的。"]) {
    assert.deepEqual([...recognizeNames(t)], [], t);
  }
  assert.ok(recognizeNames("卖方：严明，男，1980 年出生。").has("严明"), "真名照常认出");
  assert.ok(recognizeNames("证人连晓峰出庭作证。").has("连晓峰"));
  // 复核 Q8-01：有明确边界或强证据时，以这四个词开头的真名照常认出（只在“角色词后没有边界”的那一支排除）
  assert.ok(recognizeNames("原告：严重阳，男，1985 年出生。").has("严重阳"), "逗号边界");
  assert.ok(recognizeNames("被告全面辩称，双方未约定。").has("全面"), "言语动词边界");
  assert.ok(recognizeNames("本案由王严格律师代理。").has("王严格"), "称谓");
  assert.ok(recognizeNames("被告：严格，女，汉族。").has("严格"), "两字真名");
  assert.ok(recognizeNames("证人全面红出庭作证。").has("全面红"), "出庭类右边界");
  for (const v of ["何间接", "严重违", "严重迟", "全面履", "连续两"]) assert.equal(stillLooksLikeName(v), false, v);
  assert.equal(stillLooksLikeName("严格"), true, "两字值可能是以前认对的真名，不退役（复核 Q8-02）");
});

test("合同里“角色词 + 应缴纳 / 任期……”不是姓名（第 29 批真实模型走查：股权转让协议税费与任期条款）；以“应”“任”为姓的真名照常认出", async () => {
  const { recognizeNames } = await import("../src/names.ts");
  for (const t of ["包括但不限于甲方应缴纳的个人所得税、双方应缴纳的印花税。", "甲方继续担任目标公司总经理，任期三年。", "董事任期三年，可以连选连任。", "监事任期届满未及时改选的。", "法定代表人任期内离职。", "承租人应缴纳租金。", "出租人应保证租赁物符合约定用途。", "劳动者应遵守用人单位的规章制度。"]) {
    assert.deepEqual([...recognizeNames(t)], [], t);
  }
  assert.ok(recognizeNames("原告：应晓明，男，1980 年出生。").has("应晓明"));
  assert.ok(recognizeNames("被告应晓明于 2025 年 3 月借款。").has("应晓明"), "没有标点边界的真名照常认出");
  assert.ok(recognizeNames("被告应保国于 2025 年 3 月借款。").has("应保国"), "“应保”开头的真名不受影响（只排除三字短语）");
  assert.ok(recognizeNames("总经理任明辉表示同意。").has("任明辉"));
  for (const v of ["应缴纳", "任期三", "任期届", "应遵守"]) assert.equal(stillLooksLikeName(v), false, v);
  // 同批：助手自己写的审查意见里的误认（出站令牌化时认出、进了令牌表，合同原文“任何一方”“向乙方支付”随之被换掉，风险卡定位不到）
  for (const t of ["遭受损失的，甲方应全额赔偿。", "乙方付款义务缺乏控制阀门。", "乙方任何付款义务均以下列条件满足为前提。", "登记义务以乙方付清全款为起点。", "甲方应负责并促使目标公司配合。", "甲方任何披露或乙方按现状受让。", "甲方向乙方陈述并保证。", "乙方应依法保障员工合法权益。", "甲方任职期间还应遵守竞业限制。", "解除通知自到达甲方时生效。", "由双方另行协商。"]) {
    assert.deepEqual([...recognizeNames(t)], [], t);
  }
  assert.ok(recognizeNames("被告付清华于 2025 年 3 月借款。").has("付清华"), "“付清”开头的真名照常认出");
  assert.ok(recognizeNames("被告向乙明于 2025 年 3 月借款。").has("向乙明"), "“向乙”后不是“方”的照常认出");
  assert.ok(recognizeNames("原告：任何平，男，1980 年出生。").has("任何平"), "有标点边界的“任何”开头真名照常认出");
  for (const v of ["应全额", "任何", "向乙", "向甲", "由双", "由对", "付款义", "时生效"]) assert.equal(stillLooksLikeName(v), false, v);
  assert.deepEqual([...recognizeNames("乙方向甲方交付货物，由对方承担运费。")], [], "向甲方、由对方");
});

test("第 29 批复测：介词接角色词、“对方”的“方”不是姓名；退役值任何一支都不出（令牌表先换掉后文时也一样）；真名照常认出", () => {
  for (const t of ["判令被告向原告支付货款人民币 735,800 元。", "2025 年 10 月 20 日，被告向原告出具对账确认函。", "上诉人向原审法院提交证据。", "申请人向原单位提出异议。", "微信中对方亦确认前台收到。", "当事人名称、住所、法定代表人和联系方式。", "甲方和实际收货人一致。", "原告和联系人到场。", "由原告承担诉讼费用。"]) {
    assert.deepEqual([...recognizeNames(t)], [], t);
  }
  assert.ok(recognizeNames("被告向原明于 2025 年 3 月借款。").has("向原明"), "“向原”后不是角色词的真名照常认出");
  assert.ok(recognizeNames("原告和联辉于 2025 年 3 月签约。").has("和联辉"), "“和联”后不是“系”的真名照常认出");
  assert.ok(recognizeNames("原告方亦农诉称，双方约定。").has("方亦农"), "“方”前不是“对 / 双 / 甲……”的真名照常认出");
  for (const v of ["向原", "方采", "方亦", "和联", "和实", "封样"]) assert.equal(stillLooksLikeName(v), false, v);
  // 真实走查的形态：当事人词典（或令牌表）里的值先把“方采”换掉，“甲方向乙方采购”只剩“向乙”接代号——不得因此把“向乙”认成姓名，
  // 否则同一段里的“向乙方发出订单”跟着被换掉（合同第 3.1、4.2、6.1 条）
  const tz = new MatterTokenizer({ matterKey: KEY, parties: [{ name: "方采", kind: "person" }] });
  const out = tz.tokenize("就甲方向乙方采购薄膜。甲方应以微信方式向乙方发出订单。").text;
  assert.match(out, /以微信方式向乙方发出订单/, out);
});
