/**
 * 风险卡的建议性质与谈判梯度（v9.3 P2 / Astra M-1）：没有标性质的旧卡按类别推定；正文按“首选 → 可退让 → 底线”，只有一级时仍叫“建议改为”；
 * 律师改写过的用“你的修改”替代首选。工作台确实用了这两个函数（源码对照）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ladderRows, NATURE_LABEL, natureOf, natureText } from "../src/lib/risk-ladder.ts";

test("性质：给了就用；没给按类别与严重程度推定；没有建议文本的不推定为“必须修改”；推定的标“（推定）”（复核 RB16B-03/04）", () => {
  assert.equal(natureOf({ category: "legal", severity: "high", suggestion: "" }), "should");
  assert.equal(natureText({ nature: "must", nature_inferred: true, category: "legal", severity: "high" }), "必须修改（推定）");
  assert.equal(natureText({ nature: "must", nature_inferred: false, category: "legal", severity: "high" }), "必须修改");
  assert.equal(natureOf({ nature: "negotiable", category: "legal", severity: "high" }), "negotiable");
  assert.equal(natureOf({ category: "commercial", severity: "high" }), "negotiable");
  assert.equal(natureOf({ category: "legal", severity: "high", suggestion: "改为……" }), "must");
  assert.equal(natureOf({ category: "legal", severity: "mid" }), "should");
  assert.equal(natureOf({ category: "both", severity: "high" }), "should");
  assert.deepEqual(Object.values(NATURE_LABEL), ["必须修改", "建议修改", "可谈判"]);
});

test("梯度：三级齐全时首选 / 可退让 / 底线；只有一级叫“建议改为”；改写过的用“你的修改”", () => {
  const full = { status: "proposed", suggestion: "受让方所在地法院", final_text: null, fallback: "被告所在地法院", bottom_line: "须约定送达地址" };
  assert.deepEqual(ladderRows(full).map((r) => r.label), ["首选", "可退让", "建议底线（待客户定）"]);
  assert.deepEqual(ladderRows({ ...full, fallback: null, bottom_line: null }).map((r) => r.label), ["建议改为"]);
  assert.deepEqual(ladderRows({ ...full, status: "modified", final_text: "律师改写" }).map((r) => [r.label, r.text]), [["你的修改", "律师改写"], ["可退让", "被告所在地法院"], ["建议底线（待客户定）", "须约定送达地址"]]);
  assert.deepEqual(ladderRows({ status: "accepted", suggestion: null, final_text: null, fallback: null }), [], "知悉、不改动的卡没有梯度行");
});

test("工作台用的是这套梯度与性质胶囊（原“可退让方案”一行已并入梯度）", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/components/ReviewWorkbench.tsx", import.meta.url)), "utf8");
  assert.match(src, /ladderRows\(c\)\.map/);
  assert.match(src, /natureText\(c\)/);
  assert.match(src, /setRiskCardNature|setNature\(c,/, "律师可以改性质");
  assert.doesNotMatch(src, /可退让方案/);
});
