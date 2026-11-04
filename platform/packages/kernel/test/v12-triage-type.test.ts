/**
 * V12 真实界面走查（用例 4）：《咨询服务框架协议》初判成“合同 · 买卖”——开头几行里的当事人行“甲方（服务采购方）：……”含“采购”，
 * 规则又先查买卖、后查服务。审合同卡按初判预选合同类型，审查用错一套类型要点。合同类型只看文件名与合同自己的标题行。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { triageText } from "../src/services/material-triage.ts";

test("当事人行里的“采购”不决定合同类型；标题行与文件名决定", () => {
  const head = "咨询服务框架协议\n协议编号：QHZC-FW-2026-117\n甲方（服务采购方）：苏州星衡生物科技有限公司\n乙方（服务提供方）：深圳前海智策管理咨询有限公司\n第一条 服务内容";
  assert.equal(triageText("B-咨询服务框架协议-对方稿.docx", head, 3562, null).contract_type, "服务 / 技术服务");
  assert.equal(triageText("对方稿.docx", head, 3562, null).contract_type, "服务 / 技术服务", "文件名没有类型时看标题行");
});

test("对照：设备采购合同仍是买卖；没有标题行的照旧", () => {
  const a = "设备采购合同\n合同编号：YF-CG-2026-0318\n买方（甲方）：杭州云帆智能装备有限公司\n卖方（乙方）：上海临港精工机械有限公司";
  assert.equal(triageText("A-设备采购合同-待修订.docx", a, 4932, null).contract_type, "买卖");
  assert.equal(triageText("股权转让协议.docx", "股权转让协议\n转让方：甲\n受让方：乙", 2000, null).contract_type, "股权转让");
});
