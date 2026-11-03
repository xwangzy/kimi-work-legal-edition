/**
 * 第 35 批真实走查 R2：合同里“甲方应进行验收”送给模型时成了“甲方〔自然人〕行验收”，审查意见据此误判“表述不完整”。
 * 合同当事人角色词后直接接的“应”是“应当”，不是姓“应”；诉讼角色词后、有分隔的真名照常认出（召回不变）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { recognizeNames, stillLooksLikeName } from "../src/names.ts";

test("合同当事人角色词 + 应 + 动词：不是姓名（逐个动词补短语补不完）", () => {
  const verbs = ["进行", "通知", "开具", "完成", "采取", "继续", "签署", "办理", "交付", "配合", "提供", "按照", "进一步", "进入", "在", "于", "向"];
  for (const role of ["甲方", "乙方", "出租人", "承租人", "受让方", "劳动者", "买方", "保证人"]) {
    for (const v of verbs) {
      const t = `${role}应${v}相关事项。`;
      assert.deepEqual([...recognizeNames(t)], [], t);
    }
  }
  assert.deepEqual([...recognizeNames("设备安装调试完成后，甲方应进行验收，验收期限为7日。")], []);
});

test("真名照常认出：有分隔的合同角色、诉讼角色、称谓与言语动词", () => {
  assert.ok(recognizeNames("甲方：应保国，身份证号码见附件。").has("应保国"));
  assert.ok(recognizeNames("联系人：应进，电话见下。").has("应进"));
  assert.ok(recognizeNames("被告应晓明于 2025 年 3 月借款。").has("应晓明"));
  assert.ok(recognizeNames("证人应保国出庭作证。").has("应保国"));
  assert.ok(recognizeNames("应保国律师已到庭。").has("应保国"));
});

test("合同当事人代称后没有分隔的两个字不是姓名；“劳动”等常用词不作姓名（第 35 批真实走查 R3：“乙方劳动合同”把“劳动”登记成人名）", () => {
  for (const t of ["标准为乙方劳动合同解除或终止前十二个月平均工资的30%。", "甲方付款后十日内交货。", "乙方计算利息的方式。", "买方时限届满未提出异议的。", "受让方成果交付后。", "员工劳动纪律按手册执行。", "劳动者劳务报酬按月支付。"]) {
    assert.deepEqual([...recognizeNames(t)], [], t);
  }
  // 召回：有分隔的代称、叙述里常直接接人名的角色词照常认出
  assert.ok(recognizeNames("乙方：张建华，身份证号码见附件。").has("张建华"));
  assert.ok(recognizeNames("乙方（劳动者）：张建华").has("张建华"));
  assert.ok(recognizeNames("出借人王建国于 2024 年 3 月出借。").has("王建国"));
  assert.ok(recognizeNames("员工李明于 2025 年入职。").has("李明"));
  assert.ok(recognizeNames("原告劳志远诉称。").has("劳志远"), "以“劳”为姓的真名在诉讼角色词后照常认出");
});

test("已误登记进事项令牌表的常用词退役：“劳动”“付款”不再替换，真名照旧", async () => {
  const { randomBytes } = await import("node:crypto");
  const { MatterTokenizer } = await import("../src/index.ts");
  for (const v of ["劳动", "劳务", "付款", "方迟延", "方违反", "向第三"]) assert.equal(stillLooksLikeName(v), false, v);
  assert.equal(stillLooksLikeName("张建华"), true);
  const t = new MatterTokenizer({ matterKey: randomBytes(32), parties: [], fullPseudonym: false, table: [{ token: "〔自然人·QQ83M8〕", category: "person", value: "劳动", source: "recognizer" }] } as any);
  assert.equal(t.tokenize("依据《中华人民共和国劳动合同法》第三十九条。").text, "依据《中华人民共和国劳动合同法》第三十九条。");
});

test("地址前混进的叙述（日期、搬迁、入职、变更）留在原文，只把地址换成代号（第 35 批真实走查 R3）", async () => {
  const { findIdentifiers } = await import("../src/patterns.ts");
  const addr = (s: string) => (findIdentifiers as any)(s).filter((h: any) => h.category === "address").map((h: any) => h.value);
  // V10 第 36 批（拍板 B）：省、市、区县留在原文，只换街道门牌
  assert.deepEqual(addr("公司研发中心自2026年9月1日起整体搬迁至苏州工业园区星湖街328号。"), ["星湖街328号"]);
  assert.deepEqual(addr("已于10月8日入职上海市浦东新区张江路100号的某公司"), ["张江路100号"]);
  assert.deepEqual(addr("现住所变更为上海市浦东新区张江路100号"), ["张江路100号"]);
  assert.deepEqual(addr("住所：江西省于都县长征大道8号"), ["长征大道8号"], "以引导字开头的真实地名不截");
});
