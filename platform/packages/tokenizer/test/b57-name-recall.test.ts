/**
 * 第 57 批全量验收（D-232）：自然人姓名漏换。48 张卡的材料逐份回放（一个事项一个令牌表），材料里 122 处“卡 × 自然人”有 22 处没换成代号、
 * 以真名发给了模型：客户法定代表人“顾承远”（18 张诉讼卡的材料只有“法定代表人：顾承远”一种写法，“承”在 STOP 里）、
 * 劳动卡访谈记录的“接待律师：许蔓”、法律意见书卡工商登记摘录里只跟着身份证号出现的股东“李慧敏”。
 * 修复后同一回放只剩 2 处（“甘露”同时是常用词、“刘建峰”只出现在“；刘建峰 认缴600万元”），新增识别全部是真名、没有误认。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MatterTokenizer, findTokens, idHolderNames } from "../src/index.ts";

const KEY = Buffer.alloc(32, 57);
const tok = (s: string) => new MatterTokenizer({ matterKey: KEY }).tokenize(s).text;

test("角色词后写明冒号是强证据：名字里有一个常作名字用字的功能字（“承”）也认", () => {
  for (const s of ["法定代表人：顾承远，董事长。", "法定代表人：顾承远", "委托代理人：顾承远，", "联系人：郑承远。"]) {
    const out = tok(s);
    assert.equal(findTokens(out).length, 1, out);
    assert.doesNotMatch(out, /承远/, out);
  }
});

test("冒号后不是姓名的照旧不认：角色词后接动词、常用词、机构名", () => {
  for (const s of ["法定代表人：承担连带责任。", "股东：同意本次增资。", "联系人：以书面形式通知，", "负责人：于是决定", "甲方：苏州锐川精密机械有限公司"]) {
    assert.equal(tok(s), s, s);
  }
});

test("没有冒号的角色词后仍按原口径（不放宽到强证据）", () => {
  // “法定代表人顾承远签字”没有冒号：仍由别的上下文（同一事项里有冒号写法时按词典）处理，这里不认
  const out = tok("由法定代表人顾承远签字确认");
  assert.equal(findTokens(out).length, 0, out);
});

test("接待律师、承办律师等表头后的姓名", () => {
  const out = tok("接待律师：许蔓 （本记录供代理劳动者一方使用）");
  assert.equal(findTokens(out).length, 1, out);
  assert.doesNotMatch(out, /许蔓/, out);
  assert.doesNotMatch(tok("承办律师：许蔓。"), /许蔓/);
});

test("冒号后跟校验位正确的 18 位身份证号：冒号前的是证件持有人", () => {
  const s = "自然人信息（我司签约时留存的身份证复印件） 张宏伟：340202197603120153 李慧敏：340202197908250282（复印件）";
  assert.deepEqual([...idHolderNames(s)].sort(), ["张宏伟", "李慧敏"].sort());
  const out = tok(s);
  assert.doesNotMatch(out, /张宏伟|李慧敏|3402021/, out);
  // 同一事项里此后的普通句子也按词典换掉（“股东是……和李慧敏（40%）”本身没有强上下文）
  const t = new MatterTokenizer({ matterKey: KEY });
  t.tokenize(s);
  assert.doesNotMatch(t.tokenize("棣升的两个股东是张宏伟（60%）和李慧敏（40%）。").text, /李慧敏|张宏伟/);
});

test("证件号校验位不对、或冒号前是“证件号／身份证”字样：不认作姓名", () => {
  assert.equal(idHolderNames("李慧敏：340202197908250283").size, 0);
  assert.equal(idHolderNames("证件号：340202197603120153").size, 0);
  assert.equal(idHolderNames("身份证：340202197603120153").size, 0);
  assert.equal(idHolderNames("公民身份号码：340202197603120153").size, 0);
});
