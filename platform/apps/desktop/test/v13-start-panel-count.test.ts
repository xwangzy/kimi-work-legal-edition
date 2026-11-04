/**
 * V13 真实界面走查 N3：首页输入“请基于三份材料出具法律意见书”，路由到“合规问答 / 顾问答复”后三份材料一份都没勾——
 * V12 只认“全部 / 本事项的 / 以上”等说法。律师点了份数且与事项里的材料数一致才全勾；对不上不猜。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { preselectMaterials, requestNamesAllMaterials, SCENARIOS } from "../src/lib/scenarios.ts";

const docs = [1, 2, 3].map((i) => ({ document_version_id: `d${i}`, filename: `F${i}.docx`, created_at: `2026-11-0${i}` }));
const advice = SCENARIOS.find((c) => c.skill === "client-advice")!;

test("“基于三份材料”“3 份证据”与材料数一致：全勾；份数对不上、没提份数：不勾", () => {
  assert.deepEqual(preselectMaterials(advice, docs, "公司想追究前销售总监的责任。请基于三份材料出具法律意见书"), ["d1", "d2", "d3"]);
  assert.deepEqual(preselectMaterials(advice, docs, "结合这 3 份证据分析时效"), ["d1", "d2", "d3"]);
  assert.deepEqual(preselectMaterials(advice, docs, "根据材料判断能否解除"), ["d1", "d2", "d3"]);
  assert.deepEqual(preselectMaterials(advice, docs, "请基于两份材料出具意见"), [], "份数与材料数不一致，不猜");
  assert.deepEqual(preselectMaterials(advice, docs, "竞业限制违约金一般能调到多少"), []);
  assert.equal(requestNamesAllMaterials("基于五份材料", 0), false);
});
