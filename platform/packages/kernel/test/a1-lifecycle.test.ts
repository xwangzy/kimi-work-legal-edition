/**
 * 探针 1 生命周期补齐（方案 §16.3 探针 1：新建、提示、取消、急停、崩溃恢复）：
 * - 取消：A1 运行中 runs.cancel → 宿主被取消/退出 → run cancelled、账本留痕；
 *   任务令牌撤销 → 本机端点对已取消 rid 的请求一律 401（经命名管道取证）。
 * - 崩溃恢复：以「现场重构」复刻崩溃（run running + attempt running 残留）→ 新内核 recover →
 *   attempt interrupted、新尝试整任务重跑到 succeeded、事件 seq 无重复。
 *   （A1 恢复粒度为任务级：agent_start/agent_wait 不落检查点，见 executor 注释。）
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Agent, fetch as undiciFetch, setGlobalDispatcher } from "undici";
import { makeKernel, importText, waitRun, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";

let tk: TestKernel;
const kernels: TestKernel[] = [];

before(async () => {
  tk = await makeKernel({ ZR_MODEL_PROVIDER: "mock", ZR_KERNEL_TCP: "off" }, "a1-life-firm");
  kernels.push(tk);
});

after(async () => {
  for (const k of kernels) {
    try {
      await k.kernel.close();
    } catch {
      // 已关闭
    }
  }
  setGlobalDispatcher(new Agent());
});

async function startA1(t: TestKernel, title: string, goal: string): Promise<{ matterId: string; runId: string }> {
  const { inv } = t;
  const { matter } = await inv("matters.create", { title, stance: "受让方", consent_status: "not_required", key_dates: { analysis_as_of: "2026-10-01" } });
  const doc = await importText(inv, matter.matter_id, "协议.txt", "股权转让协议\n第七条 乙方应当遵守《律师法》第三十八条规定的保密义务。");
  const est = await inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [doc.document_version_id] });
  const run = await inv("runs.start", {
    matter_id: matter.matter_id,
    estimate_id: est.estimate_id,
    idempotency_key: `a1-life-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    goal,
  });
  return { matterId: matter.matter_id, runId: run.run_id };
}

async function waitEvent(t: TestKernel, runId: string, type: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const d = await t.inv("runs.events", { run_id: runId, limit: 200 });
    if (d.events.some((e: any) => e.type === type)) return;
    if (Date.now() > deadline) throw new Error(`等不到事件 ${type}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

test("探针 1 取消：runs.cancel → 宿主退出、账本 cancelled、任务令牌端点 401", { timeout: 300_000 }, async () => {
  const { runId } = await startA1(tk, "A1 取消探针", "请逐条核验这份协议的法条引用并展开分析（尽量详细）。");
  await waitEvent(tk, runId, "agent.task_started");

  await tk.inv("runs.cancel", { run_id: runId, expected_version: 2, reason: "探针 1 取消用例" });
  const done = await waitRun(tk.inv, runId, 120_000);
  assert.equal(done.run.status, "cancelled", `终态应 cancelled，实际 ${done.run.status}`);
  // 权威状态由 API 先行置 cancelled；执行器轮询发现后取消宿主并补终态事件——等留痕落账再断言
  await waitEvent(tk, runId, "run.cancelled", 60_000);
  const att = tk.kernel.db.get(`SELECT status FROM attempts WHERE run_id = ? ORDER BY seq DESC LIMIT 1`, [runId]) as any;
  assert.equal(att.status, "cancelled", "尝试应 cancelled");

  // 任务令牌撤销：经命名管道对已取消 rid 的模型请求一律 401（端点急停证据）
  const token = mintTaskToken({ tid: tk.kernel.identity.tenantId, uid: tk.kernel.identity.userId, mid: done.run.matter_id, rid: runId, scope: ["model:chat"] }, 300);
  const agent = new Agent({ connect: { socketPath: tk.kernel.pipePath } });
  const res = await undiciFetch("http://broker.kwl/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: "legal/k3", messages: [{ role: "user", content: "ping" }] }),
    dispatcher: agent,
  });
  assert.equal(res.status, 401, `已取消 rid 的任务令牌应被端点拒绝（401），实际 ${res.status}`);
  await agent.close();
});

test("探针 1 崩溃恢复：现场重构崩溃 → recover 整任务重跑到 succeeded", { timeout: 300_000 }, async () => {
  // 现场重构（recovery.test.ts 同法）：直接落「run running + attempt running」的崩溃残留，
  // 不经队列（模拟内核断电瞬间）；recover 应将其标 interrupted 并重排。
  const { inv, kernel, dir } = tk;
  const { matter } = await inv("matters.create", { title: "A1 恢复探针", stance: "受让方", consent_status: "not_required", key_dates: { analysis_as_of: "2026-10-01" } });
  const doc = await importText(inv, matter.matter_id, "协议.txt", "股权转让协议\n第七条 乙方应当遵守《律师法》第三十八条规定的保密义务。");
  const runBId = "run_a1_crash_b";
  const attBId = "att_a1_crash_b";
  kernel.db.run(
    `INSERT INTO runs (run_id, tenant_id, matter_id, scenario, workflow_version, status, idempotency_key, input_snapshot, budget_points, points_reserved, created_by)
     VALUES (?,?,?,?,'v5.0.0-g0','running',?,?,?,?,?)`,
    [
      runBId,
      matter.tenant_id,
      matter.matter_id,
      "a1.agent_task",
      `a1-crash-${Date.now()}`,
      JSON.stringify({ document_version_ids: [doc.document_version_id], goal: "核验这份协议的法条引用并给出结论。" }),
      60,
      60,
      matter.created_by,
    ],
  );
  kernel.db.run(`INSERT INTO attempts (attempt_id, run_id, seq, status, fence_token) VALUES (?,?,1,'running',1)`, [attBId, runBId]);
  await tk.kernel.close(); // 崩溃现场落盘；k2 负责恢复
  kernels.length = 0;

  const { createKernel } = await import("../src/index.ts");
  const kernel2 = await createKernel({ dataDir: dir, firmSlug: "a1-life-firm", userSlug: "test-lawyer", env: { ...process.env, ZR_MODEL_PROVIDER: "mock", ZR_KERNEL_TCP: "off" } });
  tk.kernel = kernel2;
  tk.inv = (m, p) => kernel2.invoke(m, p);
  kernels.push(tk);

  const attB = kernel2.db.get(`SELECT status FROM attempts WHERE attempt_id = ?`, [attBId]) as any;
  assert.equal(attB.status, "interrupted", "残留尝试应标 interrupted");

  const done = await waitRun(tk.inv, runBId, 240_000);
  assert.equal(done.run.status, "succeeded", `恢复后应续跑到 succeeded，实际 ${done.run.status}：${JSON.stringify(done.events.map((e: any) => e.type))}`);
  const atts = kernel2.db.all(`SELECT status FROM attempts WHERE run_id = ? ORDER BY seq`, [runBId]) as any[];
  assert.deepEqual(atts.map((a) => a.status), ["interrupted", "succeeded"], "中断尝试 + 新尝试 succeeded");
  const dup = kernel2.db.get(`SELECT seq, COUNT(*) AS n FROM run_events WHERE run_id = ? GROUP BY seq HAVING n > 1`, [runBId]);
  assert.equal(dup, undefined, "事件 seq 无重复");
  const draft = done.artifacts.find((a: any) => a.kind === "a1_agent_draft");
  assert.ok(draft, "恢复重跑后应有 a1_agent_draft 成果");
  assert.equal(draft.status, "draft");
});
