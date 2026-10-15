/**
 * 运行过程快照（Kimi Code 增量核查 K7-P）：引擎事件 → 工作清单、子任务、后台任务、上下文整理、方法模板、模型重试；
 * 里程碑只含编号、状态与计数（不含模型写的文字）；长度与条数有上限；不在已验签清单里的方法模板名不记。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROGRESS_LIMITS, ProgressTracker } from "../src/progress.ts";

test("K7-P 过程快照：TodoList（只认主 Agent）、子任务起止、压缩、后台任务、模型重试与方法模板", () => {
  const t = new ProgressTracker(new Set(["contract-review"]));
  assert.equal(t.apply("tool.call.started", { agentId: "sub_1", name: "TodoList", args: { todos: [{ title: "子任务清单", status: "done" }] } }).changed, false, "子 Agent 的清单不取代主清单");
  assert.equal(t.apply("tool.call.started", { agentId: "main", name: "TodoList", args: { todos: [{ title: "读合同", status: "done" }, { title: "", status: "done" }, { title: "列风险", status: "bogus" }] } }).changed, true);
  assert.deepEqual(t.snapshot().todo, [{ title: "读合同", status: "done" }, { title: "列风险", status: "pending" }]);
  const sp = t.apply("subagent.spawned", { subagentId: "s1", subagentName: "coder", description: "核对第七条〔自然人·ABC123〕", swarmIndex: 0, runInBackground: false });
  assert.deepEqual(sp.milestone, { type: "run.subagent", payload: { subagent_id: "s1", event: "spawned", swarm_index: 0, background: false } });
  assert.ok(!JSON.stringify(sp.milestone).includes("核对第七条"), "里程碑不含模型写的文字");
  const done = t.apply("subagent.completed", { subagentId: "s1", resultSummary: "无异常", usage: { inputOther: 100, output: 20, inputCacheRead: 5, inputCacheCreation: 0 } });
  assert.deepEqual(done.milestone, { type: "run.subagent", payload: { subagent_id: "s1", event: "done", tokens: 125 } });
  assert.equal(t.snapshot().subagents[0]!.summary, "无异常");
  t.apply("compaction.started", { agentId: "main", trigger: "auto" });
  assert.equal(t.snapshot().compaction.running, true);
  // 上游 compaction.completed 没有 trigger 字段（只在 started）：触发方式由 started 带出（复核 B4-B01）
  const c = t.apply("compaction.completed", { agentId: "main", result: { summary: "含材料原文的摘要", tokensBefore: 200000, tokensAfter: 30000, compactedCount: 40, droppedCount: 3 } });
  assert.deepEqual(c.milestone, { type: "run.compaction", payload: { event: "completed", trigger: "auto", tokens_before: 200000, tokens_after: 30000, dropped: 3, count: 1 } });
  assert.ok(!JSON.stringify(t.snapshot()).includes("含材料原文的摘要"), "压缩摘要正文不出宿主");
  assert.deepEqual({ ...t.snapshot().compaction, last_at: null }, { count: 1, running: false, blocked: false, last_at: null, tokens_before: 200000, tokens_after: 30000 });
  t.apply("background.task.started", { info: { taskId: "b1", kind: "process", description: "导出表格", status: "running", startedAt: 1, endedAt: null } });
  t.apply("task.started", { agentId: "main", info: { taskId: "q1", kind: "question", description: "提问", status: "running", startedAt: 1, endedAt: null, questionCount: 1 } });
  assert.deepEqual(t.snapshot().tasks, [{ id: "b1", kind: "bash", description: "导出表格", status: "running" }], "提问不算后台任务");
  t.apply("background.task.terminated", { info: { taskId: "b1", kind: "process", description: "导出表格", status: "killed", startedAt: 1, endedAt: 2 } });
  assert.equal(t.snapshot().tasks[0]!.status, "stopped");
  t.apply("turn.step.retrying", { agentId: "main", turnId: 1, step: 2, failedAttempt: 1, nextAttempt: 2, maxAttempts: 5, delayMs: 1000, errorName: "APIError", errorMessage: "503", statusCode: 503 });
  assert.equal(t.snapshot().retry?.attempt, 2);
  assert.equal(t.apply("turn.step.retrying", { agentId: "sub_1", nextAttempt: 3, maxAttempts: 5 }).changed, false, "只报告主 Agent 的重试");
  t.apply("turn.step.completed", { agentId: "main" });
  assert.equal(t.snapshot().retry, null, "下一步成功即清除重试提示");
  assert.equal(t.apply("tool.call.started", { agentId: "main", toolCallId: "skx", name: "Skill", args: { skill: "伪造模板" } }).changed, false, "不在已验签清单里的名字不记");
  assert.equal(t.apply("tool.result", { agentId: "main", toolCallId: "skx", output: "x" }).milestone, undefined);
  const started = t.apply("tool.call.started", { agentId: "main", toolCallId: "sk1", name: "Skill", args: { skill: "contract-review" } });
  assert.equal(started.milestone, undefined, "调用发起时不记（可能被参数校验或审批拒绝）");
  const sk = t.apply("tool.result", { agentId: "main", toolCallId: "sk1", output: "方法正文" });
  assert.deepEqual(sk.milestone, { type: "run.skill", payload: { skill: "contract-review" } });
  assert.deepEqual(t.snapshot().skills, ["contract-review"]);
  t.apply("tool.call.started", { agentId: "main", toolCallId: "sk2", name: "Skill", args: { skill: "contract-review" } });
  assert.equal(t.apply("tool.result", { agentId: "main", toolCallId: "sk2", output: "方法正文" }).changed, false, "同一模板只记一次");
});

test("复核 B4-B01：子 Agent 的上下文整理不计入主任务；第 33 个子任务仍有起止里程碑；方法模板调用失败不记里程碑", () => {
  const t = new ProgressTracker(new Set(["contract-review", "citation-check"]));
  // 子 Agent 的压缩：不改主任务的整理计数、不出现“对话过长”
  assert.equal(t.apply("compaction.started", { agentId: "sub_1", trigger: "auto" }).changed, false);
  assert.equal(t.apply("compaction.completed", { agentId: "sub_1", result: { summary: "s", tokensBefore: 9, tokensAfter: 1, compactedCount: 1 } }).milestone, undefined);
  assert.equal(t.apply("compaction.blocked", { agentId: "sub_1" }).milestone, undefined);
  assert.deepEqual({ ...t.snapshot().compaction }, { count: 0, running: false, blocked: false, last_at: null, tokens_before: null, tokens_after: null });
  // 触发方式只取 manual|auto；未知值记 null
  t.apply("compaction.started", { agentId: "main", trigger: "<script>".repeat(100) });
  assert.equal(t.apply("compaction.completed", { agentId: "main", result: { summary: "s", tokensBefore: 9, tokensAfter: 1, compactedCount: 1 } }).milestone?.payload.trigger, null);
  // 第 33 个及以后的子任务：快照不再加项，起止里程碑照发；没有派出记录的完成事件不发里程碑
  for (let i = 0; i < PROGRESS_LIMITS.subagents; i++) t.apply("subagent.spawned", { subagentId: `s${i}`, subagentName: "coder", runInBackground: false });
  const s33 = t.apply("subagent.spawned", { subagentId: "s32", subagentName: "coder", swarmIndex: 32, runInBackground: false });
  assert.equal(s33.changed, false);
  assert.deepEqual(s33.milestone, { type: "run.subagent", payload: { subagent_id: "s32", event: "spawned", swarm_index: 32, background: false } });
  assert.equal(t.snapshot().subagents.length, PROGRESS_LIMITS.subagents);
  assert.equal(t.apply("subagent.spawned", { subagentId: "s32", subagentName: "coder", runInBackground: false }).milestone, undefined, "同一编号只记一次");
  assert.deepEqual(t.apply("subagent.failed", { subagentId: "s32", error: "超时" }).milestone, { type: "run.subagent", payload: { subagent_id: "s32", event: "failed", tokens: null } });
  assert.equal(t.apply("subagent.completed", { subagentId: "never-spawned", resultSummary: "x" }).milestone, undefined);
  // 方法模板：返回错误（isError 或 output.isError）不记；之后成功的调用照常记
  t.apply("tool.call.started", { agentId: "main", toolCallId: "e1", name: "Skill", args: { skill: "contract-review" } });
  assert.equal(t.apply("tool.result", { agentId: "main", toolCallId: "e1", isError: true, output: "参数无效" }).milestone, undefined);
  t.apply("tool.call.started", { agentId: "main", toolCallId: "e2", name: "Skill", args: { skill: "contract-review" } });
  assert.equal(t.apply("tool.result", { agentId: "main", toolCallId: "e2", output: { isError: true } }).milestone, undefined);
  assert.deepEqual(t.snapshot().skills, []);
  // 子 Agent 调用 Skill 不记入主任务
  assert.equal(t.apply("tool.call.started", { agentId: "sub_1", toolCallId: "e3", name: "Skill", args: { skill: "citation-check" } }).changed, false);
  assert.equal(t.apply("tool.result", { agentId: "sub_1", toolCallId: "e3", output: "ok" }).milestone, undefined);
  t.apply("tool.call.started", { agentId: "main", toolCallId: "e4", name: "Skill", args: { skill: "contract-review" } });
  assert.deepEqual(t.apply("tool.result", { agentId: "main", toolCallId: "e4", output: "方法正文" }).milestone, { type: "run.skill", payload: { skill: "contract-review" } });
});

test("K7-P 过程快照的上限：清单、标题、子任务、通知条数与长度", () => {
  const t = new ProgressTracker();
  t.apply("tool.call.started", { agentId: "main", name: "TodoList", args: { todos: Array.from({ length: 100 }, (_, i) => ({ title: `第${i}项`.repeat(50), status: "pending" })) } });
  const s = t.snapshot();
  assert.equal(s.todo.length, PROGRESS_LIMITS.todo);
  assert.ok(s.todo.every((x) => x.title.length <= PROGRESS_LIMITS.todoTitle));
  for (let i = 0; i < 50; i++) t.apply("subagent.spawned", { subagentId: `s${i}`, subagentName: "coder", runInBackground: false });
  assert.equal(t.snapshot().subagents.length, PROGRESS_LIMITS.subagents);
  for (let i = 0; i < 9; i++) t.apply("tool.call.started", { agentId: "main", name: "NotifyUser", args: { message: `进展${i}` } });
  assert.deepEqual(t.snapshot().notes.map((n) => n.text), ["进展4", "进展5", "进展6", "进展7", "进展8"]);
});

test("压缩验收取证（2026-10-14）：事件顺序 started → blocked → completed——blocked 是“本步等整理完成”，不是失败：不出里程碑、不丢触发方式", () => {
  const t = new ProgressTracker(new Set());
  t.apply("compaction.started", { agentId: "main", trigger: "auto" });
  const b = t.apply("compaction.blocked", { agentId: "main", turnId: 0 });
  assert.equal(b.milestone, undefined, "不出“对话过长”的里程碑");
  assert.equal(t.snapshot().compaction.blocked, true);
  assert.equal(t.snapshot().compaction.running, true);
  const c = t.apply("compaction.completed", { agentId: "main", result: { summary: "s", tokensBefore: 38340, tokensAfter: 29194, compactedCount: 5 } });
  assert.deepEqual(c.milestone?.payload, { event: "completed", trigger: "auto", tokens_before: 38340, tokens_after: 29194, dropped: null, count: 1 });
  assert.equal(t.snapshot().compaction.blocked, false);
});


test("阶段与心跳（P0-D）：主 Agent 思考/写/执行工具/重试切换即推送；只有心跳时按 15 秒节流；子 Agent 只更新心跳、不改主阶段", async () => {
  const { ProgressTracker, HEARTBEAT_PUSH_MS } = await import("../src/progress.ts");
  const t = new ProgressTracker();
  const t0 = new Date("2026-10-15T08:00:00.000Z");
  const at = (ms: number) => new Date(t0.getTime() + ms);
  assert.equal(t.apply("turn.started", { agentId: "main" }, at(0)).beat, true);
  assert.equal(t.snapshot().activity.phase, "thinking");
  assert.equal(t.apply("thinking.delta", { agentId: "main" }, at(1_000)).beat, false, "同一阶段、未到心跳间隔：不推");
  assert.equal(t.snapshot().activity.heartbeat_at, at(1_000).toISOString(), "快照里的心跳照样更新");
  assert.equal(t.apply("thinking.delta", { agentId: "main" }, at(HEARTBEAT_PUSH_MS + 1)).beat, true, "到了心跳间隔：推一次");
  const r = t.apply("tool.call.started", { agentId: "main", name: "ReadFile", toolCallId: "c1", args: {} }, at(20_000));
  assert.equal(r.beat, true);
  assert.equal(r.changed, false, "过程内容没有变化");
  assert.deepEqual({ phase: t.snapshot().activity.phase, tool: t.snapshot().activity.tool, since: t.snapshot().activity.since }, { phase: "tool", tool: "ReadFile", since: at(20_000).toISOString() });
  t.apply("assistant.delta", { agentId: "sub_1", delta: "x" }, at(21_000));
  assert.equal(t.snapshot().activity.phase, "tool", "子 Agent 不改主阶段");
  assert.equal(t.snapshot().activity.heartbeat_at, at(21_000).toISOString(), "子 Agent 的事件也算心跳");
  t.apply("assistant.delta", { agentId: "main", delta: "好" }, at(22_000));
  assert.equal(t.snapshot().activity.phase, "writing");
  t.apply("turn.ended", { agentId: "main" }, at(23_000));
  assert.deepEqual({ phase: t.snapshot().activity.phase, since: t.snapshot().activity.since }, { phase: null, since: null });
});
