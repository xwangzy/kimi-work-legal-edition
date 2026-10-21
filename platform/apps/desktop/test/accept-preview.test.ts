/**
 * 工作台“接受后”预览（Z3 M-5）：与修订稿同一口径——修改后接受用律师文本、接受用首选建议、知悉不改动与未处理的不进；
 * 只标改动的那一段；原文出现多处、找不到、与另一项重叠的列为“未体现”。工作台有切换（源码对照）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { acceptPreview, kernelPreview, type PreviewCard, type PreviewSeg } from "../src/lib/accept-preview.ts";

const paras = ["2.2 受让方应于协议签署后五日内一次性支付全部价款。", "7.1 受让方逾期付款的，每日按应付未付金额的千分之五支付违约金。", "9.1 提交转让方所在地人民法院诉讼解决。"];
const card = (o: Partial<PreviewCard>): PreviewCard => ({ card_id: "c", seq: 1, status: "accepted", anchor_status: "located", anchor_text: "", suggestion: "", final_text: "", ...o });
/** 接受后的文字：普通文字 + 修改的新文本。 */
const after = (segs: PreviewSeg[]) => segs.map((s) => s.text + (s.edit?.ins ?? "")).join("");

test("接受、修改后接受进预览；知悉、未处理、不采纳不进；只标改动段（本机预览：非 Word 材料）", () => {
  const r = acceptPreview(paras, [
    card({ card_id: "a", seq: 1, anchor_text: "受让方应于协议签署后五日内一次性支付全部价款", suggestion: "受让方应于目标股权变更登记完成后五个工作日内支付全部价款" }),
    card({ card_id: "b", seq: 2, status: "modified", anchor_text: "千分之五", suggestion: "万分之三", final_text: "万分之五" }),
    card({ card_id: "c", seq: 3, anchor_text: "转让方所在地", suggestion: "" }),
    card({ card_id: "d", seq: 4, status: "proposed", anchor_text: "人民法院", suggestion: "仲裁委员会" }),
  ]);
  assert.equal(r.applied, 2);
  assert.equal(after(r.paragraphs[0]!), "2.2 受让方应于目标股权变更登记完成后五个工作日内支付全部价款。");
  const e = r.paragraphs[0]!.find((s) => s.edit)!.edit!;
  assert.equal(e.ins, "目标股权变更登记完成后五个工作日内");
  assert.equal(e.del, "协议签署后五日内一次性", "删掉的原文作为删除线显示，不只在悬停提示里");
  assert.equal(after(r.paragraphs[1]!), "7.1 受让方逾期付款的，每日按应付未付金额的万分之五支付违约金。", "修改后接受用律师文本");
  assert.equal(after(r.paragraphs[2]!), paras[2]);
  assert.deepEqual(r.skipped, []);
});

test("原文出现多处、找不到、改动段重叠：列为未体现；锚点重叠但改动段不重叠的两处都体现（余项续复核 RC-B-01）", () => {
  const r = acceptPreview(paras, [
    card({ card_id: "a", seq: 1, anchor_status: "ambiguous", anchor_text: "受让方", suggestion: "买方" }),
    card({ card_id: "b", seq: 2, anchor_text: "不存在的文字", suggestion: "x" }),
    card({ card_id: "c", seq: 3, anchor_text: "千分之五支付", suggestion: "万分之三支付" }),
    card({ card_id: "d", seq: 4, anchor_text: "千分之五", suggestion: "万分之五" }),
  ]);
  assert.equal(r.applied, 1);
  assert.deepEqual(r.skipped.map((x) => [x.card_id, x.reason]), [["a", "原文出现多处"], ["b", "原文里找不到"], ["d", "与另一项改动重叠"]]);
  const two = acceptPreview(paras, [
    card({ card_id: "x", seq: 1, anchor_text: "协议签署后五日内一次性", suggestion: "协议签署后十日内一次性" }),
    card({ card_id: "y", seq: 2, anchor_text: "一次性支付全部价款", suggestion: "分两期支付全部价款" }),
  ]);
  assert.equal(two.applied, 2, "复核复现的例子：“五日 → 十日”与“一次性 → 分两期”的改动段不重叠");
  assert.equal(after(two.paragraphs[0]!), "2.2 受让方应于协议签署后十日内分两期支付全部价款。");
});

test("空白不同也能定位（与内核 locateQuote 同一口径）", () => {
  const r = acceptPreview(["甲方 应于 五日内 付款"], [card({ anchor_text: "甲方应于五日内付款", suggestion: "甲方应于十日内付款" })]);
  assert.equal(r.applied, 1);
  // 锚点按忽略空白定位到原文“甲方 应于 五日内 付款”；改动段从第一处不同（空格）算起，与修订稿的最小修改范围同一口径
  assert.equal(after(r.paragraphs[0]!), "甲方应于十日内付款");
});

test("改后与原文相同：不改动、不计数，写明原因；纯删除显示被删的原文（余项续复核 RC-B-02）", () => {
  const same = acceptPreview(paras, [card({ status: "modified", anchor_text: "五日内", final_text: "五日内" })]);
  assert.equal(same.applied, 0);
  assert.deepEqual(same.skipped.map((x) => x.reason), ["改后与原文相同，不改动"]);
  const del = acceptPreview(paras, [card({ anchor_text: "一次性支付", suggestion: "支付" })]);
  const e = del.paragraphs[0]!.find((s) => s.edit)!.edit!;
  assert.deepEqual([e.del, e.ins], ["一次性", ""]);
  assert.equal(after(del.paragraphs[0]!), "2.2 受让方应于协议签署后五日内支付全部价款。");
});

test("内核落点排版：按内核给的段落与起止排；不成立的卡写明生成时会被拦下", () => {
  const r = kernelPreview(paras, [
    { card_id: "a", ok: true, para: 1, start: paras[1]!.indexOf("千分之五"), end: paras[1]!.indexOf("千分之五") + 4, old: "千分之五", new: "万分之三" },
    { card_id: "b", ok: false, reason: "anchor_ambiguous" },
    { card_id: "c", ok: false, reason: "unchanged" },
  ]);
  assert.equal(r.applied, 1);
  assert.equal(after(r.paragraphs[1]!), "7.1 受让方逾期付款的，每日按应付未付金额的万分之三支付违约金。");
  assert.deepEqual(r.skipped.map((x) => x.reason), ["原文出现多处，生成修订稿时会被拦下", "改后与原文相同，不改动"]);
});

test("工作台有“原文 / 接受后”切换；Word 材料用内核预览；修改可用键盘聚焦", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/components/ReviewWorkbench.tsx", import.meta.url)), "utf8");
  assert.match(src, /api\s*\.previewRedline\(/);
  assert.match(src, />原文</);
  assert.match(src, /接受后/);
  assert.match(src, /<del className="wb-del">/);
  assert.match(src, /tabIndex=\{0\}/);
  assert.doesNotMatch(src, /（删除）/);
});
