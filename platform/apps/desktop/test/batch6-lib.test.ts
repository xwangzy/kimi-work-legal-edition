/**
 * 第 6 批界面纯函数：召回评测标注（选区、重叠、自然人编号）、审查工作台卡片导航（W-1）、完成后“接着做”（D-4）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { addSpan, mergeDocs, nextPersonId, personsOf, removeSpan, segments, trimRange, updateSpan } from "../src/lib/eval-annotate.ts";
import { firstOpenCard, nextOpenCard, stepCard } from "../src/lib/workbench.ts";
import { NEXT_STEPS, nextScenarios, SCENARIOS, scenarioOfRun } from "../src/lib/scenarios.ts";

const doc = (text: string) => ({ doc_id: "d", source: "firm_onsite", text, known_parties: [], spans: [] as any[] });

test("标注：去掉两端空白；重叠拒绝；同一写法沿用编号、不同写法新编号；改类别时补/去编号；分段覆盖全文", () => {
  const t = "原告 张明月 ，被告李四。张明月主张。";
  assert.deepEqual(trimRange(t, 2, 7), { start: 3, end: 6 });
  assert.equal(trimRange(t, 2, 3), null);
  let d: any = doc(t);
  let r = addSpan(d, 2, 7, "person");
  assert.ok(r.ok);
  d = r.ok ? r.doc : d;
  assert.deepEqual(d.spans[0], { start: 3, end: 6, category: "person", person_id: "P1" });
  assert.equal(addSpan(d, 4, 9, "org").ok, false, "重叠拒绝");
  r = addSpan(d, t.indexOf("李四"), t.indexOf("李四") + 2, "person");
  d = r.ok ? r.doc : d;
  r = addSpan(d, t.lastIndexOf("张明月"), t.lastIndexOf("张明月") + 3, "person");
  d = r.ok ? r.doc : d;
  assert.deepEqual(d.spans.map((s: any) => s.person_id), ["P1", "P2", "P1"]);
  assert.deepEqual(personsOf(d).map((p) => [p.id, p.first, p.mentions]), [["P1", "张明月", 2], ["P2", "李四", 1]]);
  assert.equal(nextPersonId(d.spans), "P3");
  const asOrg = updateSpan(d, 1, { category: "org" });
  assert.equal(asOrg.spans[1]!.person_id, undefined);
  assert.equal(updateSpan(asOrg, 1, { category: "person" }).spans[1]!.person_id, "P2", "改回自然人：取未用的最小编号");
  const segs = segments(t, d.spans);
  assert.equal(segs.map((g) => t.slice(g.start, g.end)).join(""), t);
  assert.equal(segs.filter((g) => g.span >= 0).length, 3);
  assert.equal(removeSpan(d, 0).spans.length, 2);
  assert.deepEqual(mergeDocs([d, { ...doc("x"), doc_id: "e" }], [{ ...doc("y"), doc_id: "d" }]).map((x) => x.text), ["y", "x"]);
});

test("工作台导航（W-1）：先开重大未处理卡；处理完跳到下一张未处理（循环）；J/K 不越界", () => {
  const cards = [
    { card_id: "a", seq: 1, severity: "low" as const, status: "proposed" },
    { card_id: "b", seq: 2, severity: "high" as const, status: "accepted" },
    { card_id: "c", seq: 3, severity: "high" as const, status: "proposed" },
    { card_id: "d", seq: 4, severity: "mid" as const, status: "proposed" },
  ];
  assert.equal(firstOpenCard(cards), "c");
  assert.equal(nextOpenCard(cards, "c"), "d");
  assert.equal(nextOpenCard(cards, "d"), "a", "到末尾从头找");
  assert.equal(nextOpenCard(cards.map((c) => ({ ...c, status: "accepted" })), "a"), null);
  assert.equal(stepCard(["a", "b", "c"], "c", 1), "c");
  assert.equal(stepCard(["a", "b", "c"], null, 1), "a");
  assert.equal(stepCard(["a", "b", "c"], "b", -1), "a");
});

test("接着做（D-4）：下一步只指向已有场景卡；按方法模板或工作流找到本次场景", () => {
  const ids = new Set(SCENARIOS.map((c) => c.id));
  for (const [k, v] of Object.entries(NEXT_STEPS)) {
    assert.ok(ids.has(k), k);
    for (const x of v) assert.ok(ids.has(x), `${k} → ${x}`);
  }
  const amount = scenarioOfRun({ scenario: "a1.agent_task", input_snapshot: JSON.stringify({ skill: "amount-calc" }) });
  assert.equal(amount?.id, "amount");
  assert.deepEqual(nextScenarios(amount).map((c) => c.id), ["pleading", "demand-lit"]);
  assert.equal(scenarioOfRun({ scenario: "s2.case_file", input_snapshot: {} })?.id, "casefile");
  assert.deepEqual(nextScenarios(null), []);
});

test("复核处置：接着做按律师所在业务线挑场景卡（S6B-05）；改成自然人时沿用同一写法的编号（S6B-06）", () => {
  const run = { scenario: "a1.agent_task", input_snapshot: { skill: "contract-review" } };
  assert.equal(scenarioOfRun(run, "inhouse")?.id, "contract-review-inhouse");
  assert.equal(scenarioOfRun(run, "transactional")?.id, "contract-review");
  assert.equal(scenarioOfRun(run, null)?.id, "contract-review");
  const t = "张三与张三";
  let d: any = doc(t);
  const r1 = addSpan(d, 0, 2, "person");
  d = r1.ok ? r1.doc : d;
  const r2 = addSpan(d, 3, 5, "org");
  d = r2.ok ? r2.doc : d;
  assert.equal(updateSpan(d, 1, { category: "person" }).spans[1]!.person_id, "P1");
});
