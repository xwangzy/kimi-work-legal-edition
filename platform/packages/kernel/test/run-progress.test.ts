/** 内核按白名单重建宿主交来的过程快照（K7-P）：未知字段丢弃、枚举外的值改为缺省、长度与条数截断、非对象返回 null。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeProgress, slimAgentPayload } from "../src/executor/run-progress.ts";

test("K7-P 内核过程快照白名单：未知字段丢弃、非法枚举改缺省、超长截断", () => {
  assert.equal(sanitizeProgress(null), null);
  assert.equal(sanitizeProgress("x"), null);
  const p = sanitizeProgress({
    todo: [{ title: "读合同", status: "done", extra: "丢弃" }, { title: "x".repeat(500), status: "hacked" }, { title: 42 }],
    subagents: [{ id: "s1", name: "coder", description: "核对", status: "weird", swarm_index: "1", background: "yes", summary: "y".repeat(5000) }, { name: "无编号" }],
    tasks: [{ id: "t1", kind: "exec", description: "导出", status: "done" }],
    notes: [{ at: "2026-10-14T01:02:03.000Z", text: "进展", agent_id: "main" }, { at: "不是时间", text: "丢弃" }],
    compaction: { count: 9999, running: "true", blocked: true, last_at: "2026-10-14T01:02:03.000Z", tokens_before: 1, tokens_after: "2" },
    skills: ["contract-review", "../etc", 7],
    retry: { attempt: 2, max: 5, status_code: 503, at: "2026-10-14T01:02:03.000Z" },
    injected: { html: "<script>" },
  })!;
  assert.deepEqual(Object.keys(p).sort(), ["compaction", "notes", "retry", "skills", "subagents", "tasks", "todo"]);
  assert.deepEqual(p.todo[0], { title: "读合同", status: "done" });
  assert.equal(p.todo[1]!.title.length, 120);
  assert.equal(p.todo[1]!.status, "pending");
  assert.equal(p.todo.length, 2);
  assert.equal(p.subagents.length, 1);
  assert.deepEqual({ ...p.subagents[0]!, summary: p.subagents[0]!.summary?.length }, { id: "s1", name: "coder", description: "核对", status: "running", swarm_index: null, background: false, summary: 1000 });
  assert.deepEqual(p.tasks, [{ id: "t1", kind: "other", description: "导出", status: "done" }]);
  assert.deepEqual(p.notes, [{ at: "2026-10-14T01:02:03.000Z", text: "进展", agent_id: "main" }]);
  assert.deepEqual(p.compaction, { count: 1000, running: false, blocked: true, last_at: "2026-10-14T01:02:03.000Z", tokens_before: 1, tokens_after: null });
  assert.deepEqual(p.skills, ["contract-review"]);
  assert.deepEqual(p.retry, { attempt: 2, max: 5, status_code: 503, at: "2026-10-14T01:02:03.000Z" });
});

test("复核 B4-B02 里程碑载荷白名单（进账本前按字段重建）：未知字段丢弃、超长截断、非法枚举改缺省、非有限数改 null；B4-B21 agent.error 保留 retryable", () => {
  const sub = slimAgentPayload("agent.subagent", { subagent_id: "s".repeat(500), event: "hijacked", swarm_index: "3", background: "yes", tokens: Number.POSITIVE_INFINITY, description: "模型写的文字", extra: { html: "<b>" } });
  assert.deepEqual(sub, { subagent_id: "s".repeat(80), event: "spawned", swarm_index: null, background: false, tokens: null });
  assert.deepEqual(slimAgentPayload("agent.subagent", { subagent_id: "a1", event: "failed", swarm_index: 2, background: true, tokens: 125 }), { subagent_id: "a1", event: "failed", swarm_index: 2, background: true, tokens: 125 });
  const comp = slimAgentPayload("agent.compaction", { event: "completed", trigger: "x".repeat(10_000), tokens_before: 200000, tokens_after: "30000", dropped: 3, count: 1, summary: "含材料原文的摘要" });
  assert.deepEqual(comp, { event: "completed", trigger: null, tokens_before: 200000, tokens_after: null, dropped: 3, count: 1 });
  assert.equal(slimAgentPayload("agent.compaction", { event: "blocked", trigger: "auto" }).trigger, "auto");
  assert.equal(slimAgentPayload("agent.compaction", { event: "weird" }).event, "completed");
  assert.deepEqual(slimAgentPayload("agent.skill", { skill: "contract-review", note: "x" }), { skill: "contract-review" });
  assert.deepEqual(slimAgentPayload("agent.skill", { skill: "../../etc/passwd" }), { skill: null });
  assert.deepEqual(slimAgentPayload("agent.skill", { skill: "x".repeat(81) }), { skill: null });
  // 引擎错误是否由引擎自动重试：界面据此写“正在自动重试”（此前被裁掉，分支不可达）
  assert.deepEqual(slimAgentPayload("agent.error", { code: "provider_unavailable", message: "m".repeat(400), retryable: true, stack: "…" }), { code: "provider_unavailable", message: "m".repeat(300), retryable: true });
  assert.equal(slimAgentPayload("agent.error", { code: "x", message: "y", retryable: "true" }).retryable, false);
  assert.equal(slimAgentPayload("agent.error", { code: "x", message: "y" }).retryable, false);
  // 其余既有分支不变
  assert.deepEqual(slimAgentPayload("agent.question", { question_id: "q", questions: [1, 2] }), { question_id: "q", n: 2 });
});

test("WR-1 Windows 命名管道名：按“Windows 用户名 + 数据目录”取唯一后缀——同一律所的两位律师（RDS/云桌面同机）不冲突；同一用户稳定", async () => {
  const { pipeSuffix } = await import("../src/config.ts");
  const a = pipeSuffix("C:\\Users\\zhang\\AppData\\Roaming\\KimiWorkLegal\\demo-firm", "zhang");
  const b = pipeSuffix("C:\\Users\\li\\AppData\\Roaming\\KimiWorkLegal\\demo-firm", "li");
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(a, b);
  assert.equal(a, pipeSuffix("c:\\users\\zhang\\appdata\\roaming\\kimiworklegal\\demo-firm", "zhang"), "路径大小写不敏感（Windows）");
  assert.notEqual(a, pipeSuffix("C:\\Users\\zhang\\AppData\\Roaming\\KimiWorkLegal\\demo-firm", "li"));
});
