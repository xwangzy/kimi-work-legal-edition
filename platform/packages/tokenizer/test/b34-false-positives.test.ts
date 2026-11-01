// 第 34 批真实走查（增资协议审查）：四处普通词被认成姓名、学进事项令牌表，助手读到“结果令甲方〔自然人〕”“创始股东〔自然人〕向甲方陈述”
import assert from "node:assert/strict";
import test from "node:test";
import { recognizeNames } from "../src/names.ts";

test("“结果令甲方满意”“创始股东连带地”“全球范围内”“杭州清禾……合伙企业”不认成姓名；同样位置的真名照常认出", () => {
  for (const s of ["甲方完成尽职调查且结果令甲方满意；创始人与核心员工签署", "目标公司和创始股东连带地向甲方陈述并保证：", "不得在全球范围内直接或间接从事竞争业务", "丁方：杭州清禾天使投资合伙企业（有限合伙）", "乙方书面同意后方可转让", "甲方足额支付投资款"]) {
    assert.deepEqual([...recognizeNames(s)], [], s);
  }
  assert.deepEqual([...recognizeNames("甲方：满志强，男")], ["满志强"], "有冒号边界的真名照常认出");
  assert.deepEqual([...recognizeNames("股东连建国签字确认")], ["连建国"]);
});
