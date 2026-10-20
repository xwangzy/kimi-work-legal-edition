// v9.3 第 15 批 B-5（评审 Z1 P1-2：“整理案卷”只认阿拉伯数字日期与金额）：中文数字日期、大写与中文数字金额、没有年份的日期；
// 不猜年份、不合并同日同额；完整日期里的“月日”不重复计。
import { test } from "node:test";
import assert from "node:assert/strict";
import { cnAmountToInt, extractFacts } from "../src/executor/casefile.ts";

const facts = (text: string) => extractFacts({ document_version_id: "d", parse_version_id: "p", filename: "f.txt", text });
const norm = (text: string, kind: string) => facts(text).filter((f) => f.kind === kind).map((f) => f.normalized);

test("B-5 中文数字：大写、小写、万与亿", () => {
  assert.equal(cnAmountToInt("壹拾万"), 100000);
  assert.equal(cnAmountToInt("壹佰贰拾叁万肆仟伍佰"), 1234500);
  assert.equal(cnAmountToInt("十万"), 100000);
  assert.equal(cnAmountToInt("三千五百"), 3500);
  assert.equal(cnAmountToInt("一亿二千万"), 120000000);
  assert.equal(cnAmountToInt("两万零五百"), 20500);
  assert.equal(cnAmountToInt("十二"), 12);
  assert.equal(cnAmountToInt("一万零十"), 10010);
  assert.equal(cnAmountToInt("甲"), null);
});

test("B-5 日期：中文数字日期、没有年份的日期（不猜年份）；完整日期里的月日不重复计", () => {
  assert.deepEqual(norm("双方于二〇二三年三月五日签订合同，二零二三年十二月三十一日到期。", "date"), ["2023-03-05", "2023-12-31"]);
  assert.deepEqual(norm("被告于3月5日签收，十月八日再次催告。", "date"), ["年份不明-03-05", "年份不明-10-08"]);
  assert.deepEqual(norm("2023年3月5日付款；2024-01-02 到期。", "date"), ["2023-03-05", "2024-01-02"], "完整日期不另计“3月5日”");
  assert.deepEqual(norm("13月5日、二月三十二日", "date"), [], "不合法的月日不计");
});

test("B-5 金额：大写（含角分与“整”）、中文数字、阿拉伯数字；同额不合并", () => {
  // 同一笔金额的大写与小写合并成一条，原文涵盖两处（复核 R15B-17）
  assert.deepEqual(norm("借款人民币壹拾万元整（小写：100,000元）。", "amount"), ["100000 元"]);
  assert.equal(facts("借款人民币壹拾万元整（小写：100,000元）。")[0]!.text, "人民币壹拾万元整（小写：100,000元");
  assert.deepEqual(norm("货款壹佰贰拾叁万肆仟伍佰元伍角陆分", "amount"), ["1234500.56 元"]);
  assert.deepEqual(norm("违约金十万元，另付三千五百元", "amount"), ["100000 元", "3500 元"]);
  const f = facts("借款人民币壹拾万元整");
  assert.equal(f[0]!.text, "人民币壹拾万元整");
  assert.equal(f[0]!.assertion, "material_record");
});

test("复核 R15B-06/17：阿拉伯数字与千百万混写、约数与“二元结构”不提、圆、元月、相对年份、年月日间空白", async () => {
  const { mixedAmountToNumber } = await import("../src/executor/casefile.ts");
  assert.equal(mixedAmountToNumber("3万5千"), 35000);
  assert.equal(mixedAmountToNumber("3百万"), 3000000);
  assert.equal(mixedAmountToNumber("2千万"), 20000000);
  assert.equal(mixedAmountToNumber("1亿2千万"), 120000000);
  assert.deepEqual(norm("借款5千元，另欠3万5千元", "amount"), ["5000 元", "35000 元"]);
  assert.deepEqual(norm("损失数千万元，涉及几十万元、上百万元的款项", "amount"), [], "约数不当确数");
  assert.deepEqual(norm("统一元素与二元结构，北京三元食品", "amount"), [], "不是金额");
  assert.deepEqual(norm("支付三元", "amount"), ["3 元"], "有金额语境的单字仍算");
  assert.deepEqual(norm("货款壹仟圆整", "amount"), ["1000 元"]);
  assert.deepEqual(norm("二〇二三年元月五日签约", "date"), ["2023-01-05"]);
  assert.deepEqual(norm("同年3月5日交货，次年五月十日付款", "date"), ["年份不明-03-05", "年份不明-05-10"]);
  assert.deepEqual(norm("2023 年 3 月 5 日签订", "date"), ["2023-03-05"]);
});
