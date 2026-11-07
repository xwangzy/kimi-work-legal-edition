/**
 * V13 第 38 批：交付前检查加“表格合计”——带合计行的表逐列核对各行之和（付款计划、价款明细、设备清单）。
 * 出题 W1：条款清单把第二期 40% 写成 35,400,000 元（应为 34,400,000），四期之和 87,000,000 ≠ 总价 86,000,000；照抄进合同就是自相矛盾的付款表。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDeliverable, tableSumIssues } from "../src/services/deliverable-check.ts";

const plan = (second: string) => ({
  heading: "第三条 价款与支付",
  paragraphs: ["3.1 转让价款总额为人民币86,000,000元，按下表分四期支付："],
  table: { columns: ["期次", "比例", "金额（元）", "付款条件"], rows: [["第一期", "30%", "25,800,000", "签约后 5 个工作日内"], ["第二期", "40%", second, "交割日"], ["第三期", "15%", "12,900,000", "登记完成"], ["第四期", "15%", "12,900,000", "保留期届满"], ["合计", "100%", "86,000,000", ""]] },
});

test("付款表各期之和与合计不一致：报 table_sum，写出各行之和与合计", () => {
  const issues = tableSumIssues([plan("35,400,000")]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.kind, "table_sum");
  assert.match(issues[0]!.fix, /87,000,000.*86,000,000/);
  const c = checkDeliverable("资产收购协议", [plan("35,400,000")]);
  assert.equal(c.ok, false);
  assert.ok(c.issues.some((i) => i.kind === "table_sum"));
});

test("合计正确、列里有说明文字或待填、单价与比例列：不报", () => {
  assert.deepEqual(tableSumIssues([plan("34,400,000")]), []);
  assert.deepEqual(tableSumIssues([plan("【待定】")]), [], "列里有待定的不比");
  const priced = { heading: "第一条 设备", table: { columns: ["名称", "数量", "单价（元）", "金额（元）"], rows: [["压装机", "2", "1,200,000", "2,400,000"], ["检测台", "1", "300,000", "300,000"], ["合计", "3", "1,500,000", "2,700,000"]] } };
  assert.deepEqual(tableSumIssues([priced]), [], "单价列不比；数量与金额合计正确");
  const wan = { heading: "x", table: { columns: ["项目", "金额"], rows: [["设备", "5,640万元"], ["存货", "860万元"], ["合计", "6,500万元"]] } };
  assert.deepEqual(tableSumIssues([wan]), [], "带“万元”单位照样比");
  const wanBad = { heading: "x", table: { columns: ["项目", "金额"], rows: [["设备", "5,640万元"], ["存货", "960万元"], ["合计", "6,500万元"]] } };
  assert.equal(tableSumIssues([wanBad]).length, 1);
});
