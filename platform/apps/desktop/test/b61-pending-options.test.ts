/**
 * 第 61 批真实验收 v35-L2-caselaw：抓包发现经“发送什么、发给谁”确认页重新估价后，runs.start 里没有 primary_output——
 * 场景卡指定的主交付物（类案检索报告）被丢掉，内核按方法缺省（研究备忘录）执行。重新估价沿用原发起的全部选项。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { pendingOptions } from "../src/lib/pending-options.ts";

test("重新估价沿用主交付物与其余选项", () => {
  const o = pendingOptions({ skill: "legal-research-memo", label: "类案检索报告（用你提供的判决）", skillArgs: { mode: "类案比对" }, primaryOutput: "类案检索报告.docx", docNames: ["a.docx"] });
  assert.equal(o.primaryOutput, "类案检索报告.docx");
  assert.deepEqual(o.skillArgs, { mode: "类案比对" });
  assert.equal(pendingOptions({}).primaryOutput, undefined);
});
