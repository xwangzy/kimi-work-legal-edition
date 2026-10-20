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
  assert.deepEqual(norm("借款人民币壹拾万元整（小写：100,000元）。", "amount"), ["100000 元", "100000 元"]);
  assert.deepEqual(norm("货款壹佰贰拾叁万肆仟伍佰元伍角陆分", "amount"), ["1234500.56 元"]);
  assert.deepEqual(norm("违约金十万元，另付三千五百元", "amount"), ["100000 元", "3500 元"]);
  const f = facts("借款人民币壹拾万元整");
  assert.equal(f[0]!.text, "人民币壹拾万元整");
  assert.equal(f[0]!.assertion, "material_record");
});
