/**
 * 第 61 批（D-263）论点确认卡：适用方式与要件—事实对照的说法（律师层）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { elementStateText, modeText } from "../src/lib/outline.ts";

test("适用方式：直接适用不标，参照、扩张、类推写明", () => {
  assert.equal(modeText("direct"), null);
  assert.equal(modeText(undefined), null);
  assert.match(modeText("referral")!, /参照适用/);
  assert.match(modeText("analogy")!, /无直接依据/);
});

test("要件状态：有事实按确认与否；没挂事实的提醒；待证、无争议、对方举证", () => {
  assert.equal(elementStateText({ element: "a", status: "fact", facts: [{ fact_id: "f", statement: "s", confirmed: true }] }).text, "有事实 · 已确认");
  assert.equal(elementStateText({ element: "a", status: "fact", facts: [{ fact_id: "f", statement: "s", confirmed: false }] }).tone, "warn");
  assert.match(elementStateText({ element: "a", status: "fact", facts: [] }).text, /没挂事实/);
  assert.equal(elementStateText({ element: "a", status: "to_prove", facts: [] }).text, "待证");
  assert.equal(elementStateText({ element: "a", status: "undisputed", facts: [] }).text, "双方无争议");
  assert.equal(elementStateText({ element: "a", status: "opponent_burden", facts: [] }).text, "对方举证");
});
