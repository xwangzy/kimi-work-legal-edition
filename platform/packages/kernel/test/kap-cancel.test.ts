/**
 * 取消竞态与同事项第二个任务（Kimi Code 增量核查 N-1；第 4 批复核 B4-B07/B4-B08/B4-B11/B4-B12）：
 * - kap 适配器的取消结果：只对版本冲突重试；宿主已先收尾即无需取消；重试耗尽或发起人不一致时强制取消；强制取消也失败 → 未确认（桩宿主稳定复现）；
 * - 执行器把取消结果直接写入事项账本（轮询已退出，宿主事件流里的记录再没有人镜像）：未确认 → agent.cancel_unconfirmed，经强制取消 → agent.cancel_forced；
 * - 同一事项上一任务尚未收尾时，适配器先等它收尾再发起（不让宿主以“已有运行中的任务”拒绝）；
 * - 内核预检：崩溃恢复中的任务算“进行中”；重试与发起同一口径（409 + 进行中的任务编号）。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "kap-cancel-test-secret-0123456789ab";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createKapAgentClient } from "../src/executor/kap-agent-client.ts";
import { createLegalWorkflow } from "../src/executor/executor.ts";
import type { AgentCancelOutcome, AgentClient } from "../src/executor/agent-client.ts";
import { Semaphore } from "../src/mutex.ts";
import { TaskQueue } from "../src/queue.ts";
import { makeKernel } from "./helpers.ts";

const STUB = fileURLToPath(new URL("./stub-kap-host.ts", import.meta.url));

function stubClient() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kwl-kapcancel-")));
  const client = createKapAgentClient({
    entryPath: STUB,
    dataRoot: root,
    kernelSocket: join(root, "k.sock"),
    trustedRgPath: null,
    manifests: () => [],
    legalMcpTools: [],
    matterPolicy: () => ({ dataLevel: "L2", basisComplete: true, fetchAllowlist: [], allowedPreauthorizations: [], budget: { maxToolCalls: 10, maxSubagents: 0 }, maxMode: "default", purpose: "legal_analysis" }),
    ioMutex: new Semaphore(2),
  });
  const setMode = (m: Record<string, string>) => writeFileSync(join(root, "stub-mode.json"), JSON.stringify(m));
  const calls = () => {
    try {
      return readFileSync(join(root, "calls.log"), "utf8").trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  const id = (mid: string, rid: string) => ({ tid: "t", uid: "u", mid, rid, aid: "a1", fence: 1 });
  const start = async (mid: string, rid: string) => {
    mkdirSync(join(root, mid, "work"), { recursive: true });
    return client.start(id(mid, rid), { goal: "x", materials: [] });
  };
  return { root, client, setMode, calls, id, start };
}

test("复核 B4-B07/B4-B08 取消结果（桩宿主）：版本冲突重试后成功；持续冲突 → 强制取消；强制取消也失败 → 未确认；发起人不一致 → 不重试、记原因并强制；宿主已先收尾 → 不再取消", { timeout: 60_000 }, async () => {
  const s = stubClient();
  try {
    // ① 确认卡恰好到达一次：重取版本重试后成功（不强制）
    s.setMode({ cancel: "conflict_once" });
    const t1 = await s.start("m1", "r1");
    let mark = s.calls().length;
    assert.deepEqual(await s.client.cancel(s.id("m1", "r1"), t1, "用户取消"), { confirmed: true, forced: false });
    assert.deepEqual(s.calls().slice(mark), ["events", "cancel", "events", "cancel"]);
    // ② 取消与确认卡持续同时到达：重试 3 次后强制取消（成功）
    s.setMode({ cancel: "conflict" });
    const t2 = await s.start("m2", "r2");
    mark = s.calls().length;
    assert.deepEqual(await s.client.cancel(s.id("m2", "r2"), t2, "用户取消"), { confirmed: true, forced: true, cause: "version_conflict" });
    assert.deepEqual(s.calls().slice(mark), ["events", "cancel", "events", "cancel", "events", "cancel", "forceCancel"]);
    // ③ 强制取消也失败：未确认（执行器据此写入账本）
    s.setMode({ cancel: "conflict", force: "fail" });
    const t3 = await s.start("m3", "r3");
    const o3 = await s.client.cancel(s.id("m3", "r3"), t3, "用户取消");
    assert.equal(o3.confirmed, false);
    assert.equal(o3.forced, true);
    assert.equal(o3.cause, "version_conflict");
    assert.match(String(o3.error), /引擎没有响应中止/);
    // ④ 发起人不一致（forbidden）：不重试，记原因，强制取消（停下来是安全方向）
    s.setMode({ cancel: "forbidden" });
    const t4 = await s.start("m4", "r4");
    mark = s.calls().length;
    assert.deepEqual(await s.client.cancel(s.id("m4", "r4"), t4, "用户取消"), { confirmed: true, forced: true, cause: "forbidden" });
    assert.deepEqual(s.calls().slice(mark), ["events", "cancel", "forceCancel"]);
    // ⑤ 宿主已先收尾（终态事件尚未送达内核）：不再发取消
    s.setMode({ events: "settled" });
    const t5 = await s.start("m5", "r5");
    mark = s.calls().length;
    assert.deepEqual(await s.client.cancel(s.id("m5", "r5"), t5, "用户取消"), { confirmed: true, forced: false });
    assert.deepEqual(s.calls().slice(mark), ["events"]);
  } finally {
    await s.client.close();
  }
});

test("复核 B4-B11 同一事项上一任务刚取消、宿主尚未收尾：新任务等它收尾后发起，不被宿主以“已有运行中的任务”拒绝", { timeout: 60_000 }, async () => {
  const s = stubClient();
  try {
    s.setMode({ cancel: "ok" });
    const t1 = await s.start("mw", "rw1");
    const second = s.start("mw", "rw2");
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(s.calls(), ["startRun"], "上一任务未收尾时不向宿主发起");
    await s.client.cancel(s.id("mw", "rw1"), t1, "用户取消");
    const t2 = await second;
    assert.match(t2, /^kap_rw2_/);
    assert.deepEqual(s.calls(), ["startRun", "events", "cancel", "startRun"]);
    assert.equal(s.client.getTask(t1)?.status, "cancelled");
    assert.equal(s.client.getTask(t2)?.status, "running");
  } finally {
    await s.client.close();
  }
});

test("复核 B4-B07 执行器把取消结果写入事项账本：未确认 → agent.cancel_unconfirmed（runs.events 可见）；经强制取消 → agent.cancel_forced；按版本取消成功 → 不记", { timeout: 120_000 }, async () => {
  const tk = await makeKernel({}, "kap-cancel-firm");
  const db = tk.kernel.db;
  try {
    const { matter } = await tk.inv("matters.create", { title: "取消结果入账", stance: "原告", consent_status: "not_required" });
    const seed = (label: string): string => {
      const runId = `run_cancel_${label}_${Date.now()}`;
      db.run(
        `INSERT INTO runs (run_id, tenant_id, matter_id, scenario, workflow_version, status, idempotency_key, input_snapshot, created_by)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [runId, tk.kernel.identity.tenantId, matter.matter_id, "a1.agent_task", "v9-test", "queued", `idem-${runId}`, JSON.stringify({ goal: "整理" }), tk.kernel.identity.userId],
      );
      db.run(`INSERT INTO attempts (attempt_id, run_id, seq, status, fence_token) VALUES (?,?,1,'interrupted',1)`, [`att_old_${runId}`, runId]);
      db.run(`INSERT INTO step_checkpoints (run_id, step_name, attempt_id, result_json) VALUES (?,?,?,?)`, [runId, "load_materials", `att_old_${runId}`, "[]"]);
      return runId;
    };
    const run = async (label: string, cancel: AgentClient["cancel"]) => {
      const runId = seed(label);
      let started = false;
      const agent: AgentClient = {
        start: async () => {
          started = true;
          return `agt_${label}`;
        },
        poll: async () => ({ status: "running", events: [], next_cursor: 0, preview_text: "", error: null, reason: null, artifacts: [] }),
        cancel,
      };
      const q = new TaskQueue(db, { concurrency: 1 });
      q.register("legalRun", createLegalWorkflow({ db, blobs: tk.kernel.blobs, broker: {} as never, agentClient: agent, lawdb: { packageVersion: "test" } as never, signer: tk.kernel.signer }));
      q.enqueue(runId);
      for (let i = 0; i < 200 && !started; i++) await new Promise((r) => setTimeout(r, 25));
      assert.ok(started, "Agent 任务应已开始");
      // 律师取消（runs.cancel 的效果）：执行器下一轮轮询发现后取消宿主
      db.run(`UPDATE runs SET status = 'cancelled', status_version = status_version + 1 WHERE run_id = ?`, [runId]);
      for (let i = 0; i < 200; i++) {
        const a = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM attempts WHERE run_id = ? AND status = 'running'`, [runId])!;
        if (a.n === 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await q.shutdown();
      const ev = await tk.inv("runs.events", { run_id: runId, limit: 200 });
      return ev.events as { type: string; payload: Record<string, unknown> }[];
    };
    const unconfirmed: AgentCancelOutcome = { confirmed: false, forced: true, cause: "version_conflict", error: "模拟：引擎没有响应中止" };
    const e1 = await run("unconfirmed", async () => unconfirmed);
    const u = e1.find((e) => e.type === "agent.cancel_unconfirmed");
    assert.ok(u, `账本应有取消未确认事件：${e1.map((e) => e.type).join(",")}`);
    assert.deepEqual(u.payload, { agent_task_id: "agt_unconfirmed", forced: true, cause: "version_conflict", error: "模拟：引擎没有响应中止" });
    const e2 = await run("forced", async () => ({ confirmed: true, forced: true, cause: "forbidden" }));
    assert.deepEqual(e2.find((e) => e.type === "agent.cancel_forced")?.payload, { agent_task_id: "agt_forced", forced: true, cause: "forbidden", error: null });
    assert.ok(!e2.some((e) => e.type === "agent.cancel_unconfirmed"));
    const e3 = await run("ok", async () => ({ confirmed: true, forced: false }));
    assert.ok(!e3.some((e) => e.type === "agent.cancel_unconfirmed" || e.type === "agent.cancel_forced"), "按版本取消成功不另记");
    // 取消调用本身抛错（宿主不可用）：同样记未确认，不再吞掉
    const e4 = await run("throws", async () => {
      throw new Error("kap-host 调用超时：cancel");
    });
    assert.equal(e4.find((e) => e.type === "agent.cancel_unconfirmed")?.payload.error, "kap-host 调用超时：cancel");
  } finally {
    await tk.kernel.close();
  }
});

test("复核 B4-B11/B4-B12 同一事项的进行中任务：崩溃恢复中（recovering）的开放任务算进行中（估价 block_kind=busy、发起 409）；重试与发起同一口径（409 + 进行中的任务编号）", { timeout: 60_000 }, async () => {
  const tk = await makeKernel({}, "kap-busy-firm");
  const db = tk.kernel.db;
  try {
    const seed = (matterId: string, label: string, status: string): string => {
      const runId = `run_busy_${label}_${Date.now()}`;
      db.run(
        `INSERT INTO runs (run_id, tenant_id, matter_id, scenario, workflow_version, status, idempotency_key, input_snapshot, created_by)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [runId, tk.kernel.identity.tenantId, matterId, "a1.agent_task", "v9-test", status, `idem-${runId}`, JSON.stringify({ goal: `${label} 任务` }), tk.kernel.identity.userId],
      );
      return runId;
    };
    const { matter: m1 } = await tk.inv("matters.create", { title: "恢复中", stance: "原告", consent_status: "not_required" });
    const recovering = seed(m1.matter_id, "recovering", "recovering");
    const est = await tk.inv("runs.estimate", { matter_id: m1.matter_id, scenario: "a1.agent_task", document_version_ids: [] });
    assert.equal(est.data_where.block_kind, "busy");
    assert.equal(est.data_where.busy_run_id, recovering);
    await assert.rejects(
      () => tk.inv("runs.start", { matter_id: m1.matter_id, estimate_id: est.estimate_id, idempotency_key: `busy-${Date.now()}`, goal: "第二个", plan_first: false, mode: "default" }),
      (e: { httpStatus?: number; detail?: { run_id?: string } }) => e.httpStatus === 409 && e.detail?.run_id === recovering,
    );
    // 重试：同一事项另有等待作答的任务 → 409，给出那个任务
    const { matter: m2 } = await tk.inv("matters.create", { title: "重试预检", stance: "原告", consent_status: "not_required" });
    const failed = seed(m2.matter_id, "failed", "failed");
    const waiting = seed(m2.matter_id, "waiting", "waiting_input");
    const v = db.get<{ status_version: number }>(`SELECT status_version FROM runs WHERE run_id = ?`, [failed])!.status_version;
    await assert.rejects(
      () => tk.inv("runs.retry", { run_id: failed, expected_version: v }),
      (e: { httpStatus?: number; message?: string; detail?: { run_id?: string } }) => e.httpStatus === 409 && e.detail?.run_id === waiting && /还有一个任务在进行（“waiting 任务”）/.test(String(e.message)),
    );
    assert.equal(db.get<{ status: string }>(`SELECT status FROM runs WHERE run_id = ?`, [failed])!.status, "failed", "被拒的重试不改状态、不入队");
  } finally {
    await tk.kernel.close();
  }
});

test("复核 B4-R11 关闭：宿主收尾需要时间时，close 等它真正退出才返回（安装更新前不得残留宿主进程）", { timeout: 30_000 }, async () => {
  const s = stubClient();
  s.setMode({ shutdown_delay_ms: "800" } as never);
  await s.start("m9", "r9");
  const pid = s.client.hostPid();
  assert.ok(pid);
  const alive = (p: number) => {
    try {
      process.kill(p, 0);
      return true;
    } catch {
      return false;
    }
  };
  const t0 = Date.now();
  await s.client.close();
  assert.ok(Date.now() - t0 >= 700, "close 等到宿主退出");
  assert.equal(alive(pid!), false, "close 返回时宿主已退出");
});
