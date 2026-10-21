/**
 * 工作台“接受后”预览（Z3 M-5）：与修订稿同一口径——修改后接受用律师文本、接受用首选建议、知悉不改动与未处理的不进；
 * 只标改动的那一段；原文出现多处、找不到、与另一项重叠的列为“未体现”。工作台有切换（源码对照）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { acceptPreview, type PreviewCard } from "../src/lib/accept-preview.ts";

const paras = ["2.2 受让方应于协议签署后五日内一次性支付全部价款。", "7.1 受让方逾期付款的，每日按应付未付金额的千分之五支付违约金。", "9.1 提交转让方所在地人民法院诉讼解决。"];
const card = (o: Partial<PreviewCard>): PreviewCard => ({ card_id: "c", seq: 1, status: "accepted", anchor_status: "located", anchor_text: "", suggestion: "", final_text: "", ...o });
const text = (segs: { text: string }[]) => segs.map((s) => s.text).join("");

test("接受、修改后接受进预览；知悉、未处理、不采纳不进；只标改动段", () => {
  const r = acceptPreview(paras, [
    card({ card_id: "a", seq: 1, anchor_text: "受让方应于协议签署后五日内一次性支付全部价款", suggestion: "受让方应于目标股权变更登记完成后五个工作日内支付全部价款" }),
    card({ card_id: "b", seq: 2, status: "modified", anchor_text: "千分之五", suggestion: "万分之三", final_text: "万分之五" }),
    card({ card_id: "c", seq: 3, anchor_text: "转让方所在地", suggestion: "" }),
    card({ card_id: "d", seq: 4, status: "proposed", anchor_text: "人民法院", suggestion: "仲裁委员会" }),
  ]);
  assert.equal(r.applied, 2);
  assert.equal(text(r.paragraphs[0]!), "2.2 受让方应于目标股权变更登记完成后五个工作日内支付全部价款。");
  const ins = r.paragraphs[0]!.find((s) => s.ins)!;
  assert.equal(ins.text, "目标股权变更登记完成后五个工作日内");
  assert.equal(ins.ins!.was, "协议签署后五日内一次性");
  assert.equal(text(r.paragraphs[1]!), "7.1 受让方逾期付款的，每日按应付未付金额的万分之五支付违约金。", "修改后接受用律师文本");
  assert.equal(text(r.paragraphs[2]!), paras[2]);
  assert.deepEqual(r.skipped, []);
});

test("原文出现多处、找不到、重叠：列为未体现", () => {
  const r = acceptPreview(paras, [
    card({ card_id: "a", seq: 1, anchor_status: "ambiguous", anchor_text: "受让方", suggestion: "买方" }),
    card({ card_id: "b", seq: 2, anchor_text: "不存在的文字", suggestion: "x" }),
    card({ card_id: "c", seq: 3, anchor_text: "千分之五支付", suggestion: "万分之三支付" }),
    card({ card_id: "d", seq: 4, anchor_text: "千分之五", suggestion: "万分之五" }),
  ]);
  assert.equal(r.applied, 1);
  assert.deepEqual(r.skipped.map((x) => [x.seq, x.reason]), [[1, "原文出现多处"], [2, "未能定位原文"], [4, "与另一项改动重叠"]]);
});

test("工作台有“原文 / 接受后”切换", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/components/ReviewWorkbench.tsx", import.meta.url)), "utf8");
  assert.match(src, /acceptPreview\(/);
  assert.match(src, />原文</);
  assert.match(src, /接受后/);
});
