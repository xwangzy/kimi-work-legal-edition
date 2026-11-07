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

test("事项页、任务页点“新建任务”带上当前事项（V10 走查：开始面板预选了最近新建的另一个事项）；其他页面照旧回首页", async () => {
  const { newTaskHref } = await import("../src/lib/nav-target.ts");
  assert.equal(newTaskHref("/", { page: "matter", matterId: "mat_1" }), "/new/mat_1");
  assert.equal(newTaskHref("/", { page: "run", matterId: "mat_2" }), "/new/mat_2");
  assert.equal(newTaskHref("/", { page: "matters" }), "/");
  assert.equal(newTaskHref("/matters", { page: "matter", matterId: "mat_1" }), "/matters", "其他导航项不受影响");
});

test("起草合同的“交易要点”也是多行文字（V13 第 38 批真实走查 W1：323 字的委托说明在单行框里只看得到末尾）", () => {
  const card = SCENARIOS.find((c) => c.id === "contract-draft")!;
  assert.equal(card.fields.find((f) => f.key === "points")?.kind, "long");
});
