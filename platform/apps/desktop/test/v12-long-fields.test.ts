/**
 * V12 真实界面走查（用例 2，起草四方投资协议）：“交易要点”是单行输入框，律师贴进来的 8 条条款清单换行全丢、挤成一行 906 字。
 * 承载多项内容的栏（交易要点、请求项、拟议事项、业务背景、争议焦点、已知争点与疑点、对方已履行情况）一律多行。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { SCENARIOS } from "../src/lib/scenarios.ts";

test("承载多项内容的栏是多行输入", () => {
  const multi = new Set(["points", "claims", "matters", "background", "focus_points", "issues", "extra", "paid"]);
  const bad = SCENARIOS.flatMap((c) => c.fields.filter((f) => multi.has(f.key) && f.kind === "text" && !/一句话/.test(f.label)).map((f) => `${c.id}.${f.key}（${f.label}）`));
  assert.deepEqual(bad, []);
  assert.equal(SCENARIOS.find((c) => c.skill === "contract-draft")?.fields.find((f) => f.key === "points")?.kind, "long");
});

test("多行内容进任务说明时保留换行", async () => {
  const { buildGoal } = await import("../src/lib/scenarios.ts");
  const card = SCENARIOS.find((c) => c.skill === "contract-draft")!;
  const g = buildGoal(card, { type: "投资协议（增资 / 股权收购）", points: "1. 老股转让 5%\n2. 增资 4,500 万元" }, "");
  assert.match(g, /1\. 老股转让 5%\n2\. 增资 4,500 万元/);
});
