/**
 * V10 第 36 批（真实走查 V2）：按意见修改文书卡的“修改意见”是单行输入框，律师贴进 9 条意见（535 字）只能看到开头一截、不好改。
 * 承载主要请求的栏（修改意见、问题、基本情况、履约问题）改为多行文字；输入框里的话照旧预填进去，整段进任务说明。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCENARIOS, buildGoal, startPanelInitial } from "../src/lib/scenarios.ts";

test("主要请求栏是多行文字，并照旧接住输入框里的整段话", () => {
  const keys = new Set(["opinion", "question", "situation", "issue"]);
  const fields = SCENARIOS.flatMap((c) => c.fields.filter((f) => keys.has(f.key) && f.required).map((f) => ({ card: c.id, f })));
  assert.ok(fields.length >= 4);
  for (const { card, f } of fields) assert.equal(f.kind, "long", `${card}.${f.key}`);
  const revise = SCENARIOS.find((c) => c.fields.some((f) => f.key === "opinion"))!;
  const req = "1. 合同总价改为3,240,000元；\n2. 验收期限改为15个工作日；\n3. 争议解决改为宁波仲裁委员会仲裁。";
  const init = startPanelInitial(revise, req);
  assert.equal(init.values.opinion, req, "多行意见原样预填");
  assert.ok(buildGoal(revise, init.values, "").includes("3. 争议解决改为宁波仲裁委员会仲裁"), "整段进任务说明");
});
