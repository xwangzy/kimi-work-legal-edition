/**
 * V18 首轮 A3：从场景卡开始面板发起的任务缺省直接开始（不先出计划）；首页、事项页的自由描述输入框照旧缺省先看计划。
 * 组件是 TSX，这里按源码核对缺省值的来源（与 i2-ui-p1 同一做法）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { modeSheetText } from "../src/lib/mode-options.ts";

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

test("开始面板用 scenarioChoice（planFirst: false）；自由描述输入框仍用 defaultChoice（缺省先看计划）", () => {
  const mode = src("components/ModeSelector.tsx");
  assert.match(mode, /export function scenarioChoice\([^)]*\): ModeChoice \{\s*return \{ \.\.\.defaultChoice\(policy\), planFirst: false \};/);
  assert.match(mode, /planFirst: policy\?\.plan_first_default \?\? true/, "自由描述的缺省不变");
  const start = src("components/ScenarioStart.tsx");
  // 面板底部有“开始前先给我看计划”的勾选，缺省不勾（useState(false)）；勾了才走计划确认
  assert.match(start, /const \[planFirst, setPlanFirst\] = useState\(false\);/);
  assert.match(start, /choice: \{ \.\.\.scenarioChoice\(policy\), planFirst \}/);
  assert.match(start, /开始前先给我看计划/);
  assert.equal(/defaultChoice/.test(start), false);
  for (const p of ["pages/Home.tsx", "pages/Matter.tsx"]) assert.match(src(p), /choice: defaultChoice\(/, p);
});

test("开始前确认的“做法”一行与缺省一致：场景卡显示“直接做”", () => {
  assert.match(modeSheetText({ mode: "default", planFirst: false }), /^直接做/);
});

test("开始面板写明材料范围：只读勾选的；没勾的不读、不发给 AI；一份都没勾时可读全部（V18 第 43 批）", async () => {
  const { materialScopeText } = await import("../src/lib/scenarios.ts");
  assert.equal(materialScopeText(1, 3), "助手只读勾选的 1 份；没勾的 2 份这次不会读取，也不会发给 AI。");
  assert.equal(materialScopeText(3, 3), "助手只读勾选的材料（本事项 3 份都勾了）。");
  assert.match(materialScopeText(0, 3), /没有勾选材料：助手可以读本事项的全部 3 份材料/);
  assert.match(src("components/ScenarioStart.tsx"), /materialScopeText\(docIds\.length, documents\.length\)/);
});

test("追问框可以补勾材料（V18 第 43 批续三）：只在上一轮勾了材料时提供；补勾的随追问一起估价与发送核对；说明文字写清沿用、补充与仍不读取的份数", async () => {
  const { followUpMaterialsText } = await import("../src/lib/scenarios.ts");
  assert.equal(followUpMaterialsText(1, 0, 2), "沿用上一轮的 1 份材料。本事项另有 2 份没给助手：需要它看的，勾上再追问。");
  assert.equal(followUpMaterialsText(1, 1, 2), "沿用上一轮的 1 份，这一轮补充 1 份；其余 1 份仍不会读取，也不会发给 AI。");
  assert.equal(followUpMaterialsText(2, 3, 3), "沿用上一轮的 2 份，这一轮补充 3 份。");
  const rv = src("pages/RunView.tsx");
  // 上一轮没勾材料（可读全部）时不出现补勾入口
  assert.match(rv, /if \(inputDocs\.length === 0\) return \[\];/);
  // 估价与发送前核对都用“上一轮的 + 补勾的”
  assert.match(rv, /api\.estimate\(matterId, \{ scenario: "a1\.agent_task", document_version_ids: followDocIds, goal: text \}\)/);
  assert.match(rv, /documentIds=\{followDocIds\}/);
  // 改勾选要重新估价（确认行作废）
  assert.match(rv, /setFollowAdd\([\s\S]{0,160}setFollowConfirm\(null\)/);
  assert.match(rv, /补充 \$\{followAdded\} 份/);
});

