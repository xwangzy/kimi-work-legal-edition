/**
 * 第 58 批（D-236）：“方”姓真名紧挨当事方称谓或动词“让”时漏换。
 * 第 35 批起为了不把“转让方违反陈述”“出让方迟延”里的“方违反”认成方姓，“X方”后面的“方”一律不作姓氏读；
 * 代价是 10-24 那批反向用例里的两种写法以真名发给了模型：
 * - “转让方方明表示同意”：称谓“转让方”之后直接写姓名，言语动词那一支只认边界或功能字之后的姓名；
 * - “请让方明签字确认”：“让”在当事方称谓用字表里（为了“转让方”“受让方”），动词“让”后面的“方明”被当成称谓。
 * 修法：“让”只在“转 / 受 / 出”之后才是称谓用字；以“方”结尾的当事方称谓在言语动词那一支等同边界。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { findTokens, MatterTokenizer, recognizeNames } from "../src/index.ts";

const KEY = randomBytes(32);

test("“方”姓真名：称谓后直接写姓名、动词“让”之后，照常识别并替换", () => {
  const cases: [string, string][] = [
    ["转让方方明表示同意。", "方明"],
    ["请让方明签字确认。", "方明"],
    ["受让方方晓东签字确认。", "方晓东"],
    ["让方晓东确认收货。", "方晓东"],
    ["经协商，甲方方立新表示愿意分期付款。", "方立新"],
    // 10-24 反向用例里原本就能识别的写法，保持
    ["法定代表人：方明", "方明"],
    ["转让方：方晓东，身份证号见附件。", "方晓东"],
    ["证人方晓东陈述了当晚经过。", "方晓东"],
    ["和方晓东律师联系。", "方晓东"],
    ["方明，男，1980年生。", "方明"],
  ];
  for (const [text, name] of cases) {
    assert.ok(recognizeNames(text).has(name), `${text} 认出：${[...recognizeNames(text)].join("、")}`);
    const r = new MatterTokenizer({ matterKey: KEY }).tokenize(text);
    assert.ok(!r.text.includes(name), `${text} → ${r.text}`);
    assert.ok(findTokens(r.text).length >= 1, text);
  }
});

test("当事方称谓 + 动词仍不认作姓名，原文不变（第 35 批口径不回退）", () => {
  for (const t of [
    "7.2　转让方违反陈述与保证的，应赔偿受让方因此遭受的直接损失。",
    "受让方违反陈述与保证的，转让方有权解除合同。",
    "出让方违反陈述的，应承担违约责任。",
    "转让方违反表示的，视为根本违约。",
    "转让方明确表示不再履行。",
    "出让方明知标的物存在瑕疵。",
    "受让方明确表示接受。",
    "对方当庭陈述与事实不符。",
    "申请方违反陈述义务。",
    "交易相对方违反陈述与保证。",
    "当事人一方明确表示不履行主要债务。",
    "出租方迟延交付租赁物。",
    "守约方依法解除合同。",
    "双方方案已经确认。",
    "各方方面均表示同意。",
  ]) {
    assert.deepEqual([...recognizeNames(t)], [], t);
    assert.equal(new MatterTokenizer({ matterKey: KEY }).tokenize(t).text, t, t);
  }
});

// 第 58 批（D-241）：关联线索——同姓且名字只差一字的两位自然人，只写代号
import { relationLegend } from "../src/index.ts";
test("关联线索：同姓、名字只差一字的两位自然人列出代号；其余不列", () => {
  const t = new MatterTokenizer({ matterKey: KEY });
  const r = t.tokenize("原告法定代表人：沈立群。受托方法定代表人：沈立芳。证人：沈晓东。被告法定代表人：顾承远。");
  const legend = relationLegend(t.table(), [r.text]);
  const tok = (v: string) => t.table().find((e) => e.value === v)!.token;
  assert.ok(legend.includes(`${tok("沈立群")}与${tok("沈立芳")}同姓、名字只差一字`), legend);
  assert.ok(!legend.includes(tok("沈晓东")), "名字差两字的不列");
  assert.ok(!legend.includes(tok("顾承远")));
  for (const v of ["沈立群", "沈立芳", "顾承远"]) assert.ok(!legend.includes(v), "不含原文");
  assert.equal(relationLegend(t.table(), ["没有代号的文字"]), "", "文字里没出现的代号不列");
});

test("角色词（括注）后接连词是并列，不读姓名；写明冒号的照常识别（第 58 批真实复测：“和投资”被认成姓名）", () => {
  for (const t of ["我们站在受让方（目标公司）和投资方一边写。", "转让方（创始人）与受让方另行约定。", "原告（反诉被告）及其代理人到庭。"]) {
    assert.deepEqual([...recognizeNames(t)], [], t);
    assert.equal(new MatterTokenizer({ matterKey: KEY }).tokenize(t).text, t, t);
  }
  assert.ok(recognizeNames("受让方（自然人）：和平，身份证号见附件。").has("和平"));
});
