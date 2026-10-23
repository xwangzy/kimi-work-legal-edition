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
