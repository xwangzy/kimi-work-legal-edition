/**
 * V12 真实界面走查用例 5：诉讼事项里“基于本事项的全部材料……出具一份法律意见书”——五份材料一份都没勾；面板还问“这是诉讼仲裁事项，确定在这里做吗”。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { lineMismatchText, preselectMaterials, SCENARIOS } from "../src/lib/scenarios.ts";

const docs = [1, 2, 3].map((i) => ({ document_version_id: `d${i}`, filename: `C${i}.docx`, created_at: `2026-11-0${i}` }));
const advice = SCENARIOS.find((c) => c.skill === "client-advice")!;

test("说了“全部材料 / 本事项的材料 / 以上证据”的勾上全部；没说的照旧不勾", () => {
  assert.deepEqual(preselectMaterials(advice, docs, "基于本事项的全部材料，出具一份法律意见书"), ["d1", "d2", "d3"]);
  assert.deepEqual(preselectMaterials(advice, docs, "结合以上证据分析时效"), ["d1", "d2", "d3"]);
  assert.deepEqual(preselectMaterials(advice, docs, "股权转让要不要其他股东同意"), []);
  assert.deepEqual(preselectMaterials(advice, docs), []);
});

test("答复与研究类方法在任何业务线都不问“确定在这里做吗”；其他卡照旧提示", () => {
  assert.equal(lineMismatchText(advice, { stance: "原告" }), null);
  const draft = SCENARIOS.find((c) => c.skill === "contract-draft")!;
  assert.match(lineMismatchText(draft, { stance: "原告" }) ?? "", /确定在这里做/);
});
