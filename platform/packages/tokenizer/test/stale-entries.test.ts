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
