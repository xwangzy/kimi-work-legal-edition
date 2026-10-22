/**
 * v9.4 第 20 批：事项概览的阶段条、事件时点与待办（S-08、C1 §3.2），事项页首屏（G-09）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eventDateProblem, STAGE_LABELS, stagesFor } from "../src/lib/matter-stage.ts";
import { derivedTodoText, todoMeta } from "../src/lib/todos.ts";

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

test("阶段条按我方立场给一条线；当前阶段不在线上时补在末尾；取值与内核一致", () => {
  assert.deepEqual(stagesFor("原告").map((s) => STAGE_LABELS[s]), ["立案前", "一审", "二审", "再审", "执行"]);
  assert.deepEqual(stagesFor("劳动者").map((s) => STAGE_LABELS[s]), ["立案前", "仲裁", "一审", "二审", "执行"], "劳动争议仲裁前置");
  assert.deepEqual(stagesFor("买方").map((s) => STAGE_LABELS[s]), ["尽调", "谈判", "签约", "交割", "履约"]);
  assert.equal(stagesFor("常年顾问")[0], "advisory");
  assert.deepEqual(stagesFor("原告", "arbitration").slice(-1), ["arbitration"]);
  const kernel = readFileSync(new URL("../../../packages/kernel/src/services/matter-facts.ts", import.meta.url), "utf8");
  for (const [k, v] of Object.entries(STAGE_LABELS)) assert.ok(kernel.includes(`${k}: "${v}"`), `内核同名同义：${k}`);
});

test("事件时点：只到月或到日；按日历核", () => {
  assert.equal(eventDateProblem(""), null);
  assert.equal(eventDateProblem("2023-05"), null);
  assert.equal(eventDateProblem("2024-02-29"), null);
  assert.ok(eventDateProblem("2023-02-29"));
  assert.ok(eventDateProblem("2023-13"));
  assert.ok(eventDateProblem("2023/05/06"));
});

test("待办说法：推出的待办写清谁做；手工待办只写填了的", () => {
  const base = { goal: "", scenario: "a1.agent_task", filename: null, done_by_ai: true, run_id: "r", artifact_version_id: null, count: 2, at: "" };
  assert.deepEqual(derivedTodoText({ ...base, kind: "drafts_to_review", goal: "起草起诉状" }, () => "x"), { title: "复核 2 份草稿：起草起诉状", who: "AI 已完成 · 待你复核" });
  assert.equal(derivedTodoText({ ...base, kind: "run_waiting" }, () => "通用任务").title, "回答任务里的确认：通用任务");
  assert.equal(derivedTodoText({ ...base, kind: "to_sign", filename: "意见书.docx" }, () => "x").title, "签发：意见书.docx");
  assert.equal(todoMeta({ assignee_kind: "me", assignee_name: null, reviewer_name: null }), "");
  assert.equal(todoMeta({ assignee_kind: "assistant", assignee_name: "小王", reviewer_name: "张律师" }), "助理小王做 · 张律师复核");
  assert.equal(todoMeta({ assignee_kind: "ai", assignee_name: null, reviewer_name: null }), "AI做");
});

test("事项页：输入框不常驻（标题行“发起任务”展开）；“任务”改名“AI 记录”；概览有阶段条与待办", () => {
  const m = src("pages/Matter.tsx");
  assert.ok(m.includes("发起任务"));
  assert.ok(/\(composerOpen \|\| !!value\.goal\.trim\(\)\) && <div className="matter-composer/.test(m), "没展开且没写字时不渲染输入框");
  assert.ok(m.includes("`AI 记录（${runs.length}）`"));
  assert.ok(!m.includes("`任务（${runs.length}）`"));
  const b = src("pages/Boards.tsx");
  assert.ok(b.includes("<StageStrip") && b.includes("<MatterTodos"));
  // 删除清单不再露出英文键名
  const lc = src("components/MatterLifecycle.tsx");
  for (const k of ["outlines", "review_tables", "review_cells", "todos", "reminders", "relay", "exports"]) assert.ok(new RegExp(`\\n  ${k}: "`).test(lc), k);
  assert.ok(!lc.includes("INVENTORY_LABELS[k] ?? k}"));
});

test("复核页：按事件时点核对的引用单列一组，须勾选；勾选键与内核同名", async () => {
  const { citationChecklist, citationNeeds, citationsAllowSign } = await import("../src/lib/citation-review.ts");
  const n = citationNeeds({ checked: true, wrong: 0, unverified_offline: 0, outside_registry: 0, timing: 1, event_date: "2019-05", items: [{ raw: "《民法典》第五百八十五条", kind: "ok", reason: null, timing: "事件发生时……" }] });
  assert.equal(n.counts.timing, 1);
  assert.equal(n.eventDate, "2019-05");
  assert.equal(citationsAllowSign(n, { cases: false, outside: false, unchecked: false }), false);
  assert.equal(citationsAllowSign(n, { cases: false, outside: false, unchecked: false, timing: true }), true);
  assert.deepEqual(citationChecklist(n, { cases: false, outside: false, unchecked: false, timing: true }), { citations_event_time_checked: true });
  const kernel = readFileSync(new URL("../../../packages/kernel/src/services/artifact-citations.ts", import.meta.url), "utf8");
  assert.ok(kernel.includes('CITATIONS_EVENT_TIME_CHECK_KEY = "citations_event_time_checked"'));
  assert.ok(src("pages/Review.tsx").includes("已按事件时点和地域核对上面的引用"));
});

test("期限提醒：从事项导入关键日期与待办期限（分析截止日、过去的、已设过的不列）；过期的分组收起；常用期间", async () => {
  const { importCandidates, splitByDue, kindForKey, PERIOD_PRESETS } = await import("../src/lib/reminders.ts");
  const ms = [
    { matter_id: "m1", title: "甲案", key_dates: { analysis_as_of: "2026-12-01", 开庭日: "2026-11-20", 举证期限: "2026-10-01" } },
    { matter_id: "m2", title: "乙案", key_dates: {}, lifecycle: "closed" },
  ];
  const todos = new Map([["m1", [{ title: "提交答辩状", due_date: "2026-11-05", status: "open" }, { title: "已完成的", due_date: "2026-11-06", status: "done" }]], ["m2", [{ title: "结案事项", due_date: "2026-12-01", status: "open" }]]]);
  const c = importCandidates(ms, todos, new Set(["m1|2026-11-20|不同说明"]), "2026-10-22");
  assert.deepEqual(c.map((x) => [x.due_date, x.label, x.kind, x.source]), [["2026-11-05", "提交答辩状", "other", "todo"], ["2026-11-20", "开庭日", "hearing", "key_date"]]);
  assert.equal(importCandidates(ms, todos, new Set(["m1|2026-11-20|开庭日"]), "2026-10-22").length, 1, "已设过的不列");
  assert.equal(kindForKey("举证期限"), "evidence");
  const now = Date.parse("2026-10-22T04:00:00Z");
  const g = splitByDue([{ due_date: "2026-10-21" }, { due_date: "2026-10-22" }, { due_date: "2026-11-01" }], now);
  assert.deepEqual([g.upcoming.length, g.past.length], [2, 1]);
  assert.ok(PERIOD_PRESETS.some((p) => p.label === "判决上诉期（15 日）" && p.unit === "day" && p.n === 15));
  const page = readFileSync(new URL("../src/pages/Reminders.tsx", import.meta.url), "utf8");
  assert.ok(page.includes("api.computeDeadline") && page.includes("用这个日期") && page.includes("从事项导入") && page.includes("已过期"));
  assert.ok(!page.includes("系统不推算法定期间"), "说明与新功能一致");
});
