/**
 * V16 第 41 批真实成果：代理词正文 14 处“页码【待确认】”，质证意见里“律师提示”，催告函正文 4 处【待确认】，答辩书证据“待补”，
 * 交付前检查都报“未发现问题”。要递交法院或发给对方的文书，正文里给律师的标记要报出来；内部文书、【待填】不报。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDeliverable } from "../src/services/deliverable-check.ts";

const notes = (title: string, paragraphs: string[], table?: { columns: string[]; rows: unknown[][] }) =>
  checkDeliverable(title, [{ heading: "正文", paragraphs, ...(table ? { table } : {}) }]).issues.filter((i) => i.kind === "note_to_lawyer");

test("对外文书正文里的【待确认】【待核实】、“律师提示”、“请律师”开头的句子、“待补”状态报出", () => {
  const a = notes("代理词", ["原告提交的送货单（证据三，页码【待确认】）载明交付日期。", "被告的抗辩不能成立。律师提示：庭后五日内提交书面代理词。"]);
  assert.ok(a.some((i) => i.text.includes("【待确认】")), JSON.stringify(a));
  assert.ok(a.some((i) => i.text.includes("律师提示")));
  assert.match(a[0]!.fix, /附条件写法[\s\S]*核对附件[\s\S]*最终答复/);
  assert.match(a[0]!.fix, /留【待填】/);
  const b = notes("催告函", ["贵司尚欠货款【待核实】元。", "请律师核对发函地址后再寄出。"]);
  assert.equal(b.length, 2, JSON.stringify(b));
  assert.equal(notes("质证意见", ["对证据二的真实性无异议。提请律师注意举证期限。"]).length, 1);
  const c = notes("民事答辩状（草稿）", [], { columns: ["证据", "状态"], rows: [["付款回单", "待补"], ["对账函", "已提供"]] });
  assert.equal(c.length, 1, JSON.stringify(c));
  assert.equal(notes("劳动仲裁申请书", ["申请人入职日期【待补充】。"]).length, 1);
});

test("【待填】【金额待测算确认】与正文里的“待补缴”“补正”等普通用语不报", () => {
  assert.deepEqual(notes("民事起诉状", ["原告：【待填】，住所【待填】。", "违约金【金额待测算确认】。", "被告应为原告办理待补缴的社会保险。", "原告已按通知补正材料。"]), []);
});

test("内部文书与给律师的附件不查：备忘录、案情分析、意见书草稿、核对清单、起草说明、表格", () => {
  for (const title of ["案情分析备忘录", "争点与证据分析", "法律意见书（草稿）", "代理词提交前核对清单", "起草说明", "证据核对表"]) {
    assert.deepEqual(notes(title, ["证据三页码【待确认】。律师提示：核对原件。", "状态：待补"]), [], title);
  }
});
