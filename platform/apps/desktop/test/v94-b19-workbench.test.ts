/**
 * v9.4 第 19 批 C-02 / C-05 工作台（评审 C1 §2.2）：接受后预览按所选一级、缺失条款排成新段落、没写插入位置的列为未体现；
 * 梯度行标出写进修订稿的一级；类型与依据来源的律师说法；工作台源码含对外 / 内部版选择、导出意见表与“用这一级”。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { acceptPreview, kernelPreview, type PreviewCard, type PreviewSeg } from "../src/lib/accept-preview.ts";
import { adoptedText, KIND_LABEL, kindOf, ladderRows, RULE_SOURCE_LABEL } from "../src/lib/risk-ladder.ts";

const after = (segs: PreviewSeg[]) => segs.map((s) => s.text + (s.edit?.ins ?? "")).join("");
const card = (o: Partial<PreviewCard>): PreviewCard => ({ card_id: "c", seq: 1, status: "accepted", anchor_status: "located", anchor_text: "", suggestion: "", final_text: "", ...o });

test("本机预览：选了可退让按可退让排；缺失条款不在非 Word 材料上排", () => {
  const paras = ["8.1 买方应于验收合格后九十日内支付货款。"];
  const r = acceptPreview(paras, [
    card({ card_id: "a", anchor_text: "九十日", suggestion: "三十日", fallback: "六十日", chosen_level: "fallback" }),
    card({ card_id: "m", kind: "missing", anchor_text: "支付货款。", suggestion: "8.2 新增。" }),
  ]);
  assert.equal(after(r.paragraphs[0]!), "8.1 买方应于验收合格后六十日内支付货款。");
  assert.deepEqual(r.skipped, [{ card_id: "m", reason: "补充条款只能写进 Word 修订稿" }]);
  // 没选可退让：首选
  assert.equal(after(acceptPreview(paras, [card({ anchor_text: "九十日", suggestion: "三十日", fallback: "六十日" })]).paragraphs[0]!), "8.1 买方应于验收合格后三十日内支付货款。");
});

test("内核预览：段后插入排成锚点段落之后的新段落（整段为插入），多行条款分段；没写插入位置的说明原因", () => {
  const paras = ["12.1 双方负有保密义务。", "15.1 争议解决。"];
  const r = kernelPreview(paras, [
    { card_id: "m", ok: true, para: 0, start: 0, end: 4, old: "12.1", new: "12.2 保密五年。\n12.3 违约责任。", insert: true },
    { card_id: "x", ok: false, reason: "no_insert_point" },
  ]);
  assert.equal(r.paragraphs.length, 4);
  assert.equal(after(r.paragraphs[0]!), "12.1 双方负有保密义务。", "锚点段落不动");
  assert.deepEqual(r.paragraphs[1], [{ text: "", edit: { cardId: "m", del: "", ins: "12.2 保密五年。" } }]);
  assert.equal(after(r.paragraphs[2]!), "12.3 违约责任。");
  assert.equal(after(r.paragraphs[3]!), "15.1 争议解决。");
  assert.equal(r.applied, 1, "一张卡算一处修改（多段条款不重复计）");
  assert.match(r.skipped[0]!.reason, /没有写明插在哪里/);
});

test("梯度行：已接受时标出写进修订稿的那一级；缺失卡首行叫“建议补充”；adoptedText 与内核口径一致", () => {
  const base = { suggestion: "三十日", fallback: "六十日", bottom_line: "七十五日", final_text: null };
  const chosenFb = ladderRows({ ...base, status: "accepted", chosen_level: "fallback" });
  assert.deepEqual(chosenFb.filter((r) => r.chosen).map((r) => r.key), ["fallback"]);
  assert.deepEqual(ladderRows({ ...base, status: "accepted" }).filter((r) => r.chosen).map((r) => r.key), ["first"]);
  assert.equal(ladderRows({ ...base, status: "proposed" }).some((r) => r.chosen), false, "未处理的卡不标");
  assert.equal(ladderRows({ suggestion: "补一条", fallback: null, final_text: null, status: "proposed", kind: "missing" })[0]!.label, "建议补充");
  assert.equal(adoptedText({ suggestion: "a", fallback: "b", chosen_level: "fallback" }), "b");
  assert.equal(adoptedText({ suggestion: "a", fallback: " ", chosen_level: "fallback" }), "a", "可退让为空时回到首选");
  assert.equal(kindOf({}), "risk", "旧内核没给类型按风险");
  assert.equal(KIND_LABEL.deviation, "偏离规则");
  assert.equal(RULE_SOURCE_LABEL.general, "通用建议，须你判断");
});

test("工作台源码：对外版缺省、导出审查意见表、可退让“用这一级”、缺失卡写查过的说法与可能误报", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/components/ReviewWorkbench.tsx", import.meta.url)), "utf8");
  assert.match(src, /useState<"external" \| "internal">\("external"\)/, "缺省对外版");
  assert.match(src, /对外版（只有修订）/);
  assert.match(src, /api\.exportReviewTable\(/);
  assert.match(src, /decide\(c, "accept", undefined, "fallback"\)/);
  assert.match(src, /row\.key === "fallback"/, "只有可退让一级能选（底线不能）");
  assert.match(src, /可能误报/);
  assert.match(src, /api\.buildRedline\(matterId, documentVersionId, \{ audience,/);
});
