/**
 * 本地持久任务队列专项（方案 v5.0 第 4 篇 §6.1；探针 1/11 的 v0 版）：
 * - 步骤检查点：崩溃（或失败）后重启，从最后检查点继续，已完成步骤不重放；
 * - 中断尝试落 interrupted，任务重新排队至终态；
 * - 取消：协作式即时生效。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KernelDb } from "../src/db.ts";
import { TaskQueue, type WorkflowContext } from "../src/queue.ts";

let dir: string;
let db: KernelDb;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "kwl-queue-"));
  db = new KernelDb(join(dir, "ledger.db"));
  db.migrate();
});

after(() => {
  db.close();
});

function insertRun(runId: string, status = "queued"): void {
  db.run(`INSERT OR IGNORE INTO tenants (tenant_id, name) VALUES ('ten_q', 'q')`, []);
  db.run(`INSERT OR IGNORE INTO users (user_id, tenant_id, display_name) VALUES ('usr_q', 'ten_q', 'q')`, []);
  db.run(
    `INSERT OR IGNORE INTO matters (matter_id, tenant_id, title, stance, created_by) VALUES ('mat_q', 'ten_q', '队列测试', '受让方', 'usr_q')`,
    [],
  );
  db.run(
    `INSERT INTO runs (run_id, tenant_id, matter_id, scenario, workflow_version, status, idempotency_key, created_by)
     VALUES (?,?,?,?,?,?,?,?)`,
    [runId, "ten_q", "mat_q", "s1.contract_review", "v5.0.0-g0", status, `idem-${runId}`, "usr_q"],
  );
}

test("队列：步骤检查点恢复——失败后重启从检查点续跑，已完成步骤不重放", async () => {
  const executions: string[] = [];
  const q1 = new TaskQueue(db, { concurrency: 1 });
  q1.register("legalRun", async (ctx: WorkflowContext) => {
    await ctx.step("a", () => {
      executions.push("a");
      db.run(`UPDATE runs SET status = 'running' WHERE run_id = ?`, [ctx.runId]);
      return "A";
    });
    await ctx.step("b", () => {
      executions.push("b");
      throw new Error("模拟进程崩溃");
    });
  });
  insertRun("run_crash");
  q1.enqueue("run_crash");
  await new Promise((r) => setTimeout(r, 500));
  await q1.shutdown();
  assert.deepEqual(executions, ["a", "b"], "首跑执行到 b 崩溃");
  const cp = db.get(`SELECT result_json FROM step_checkpoints WHERE run_id = 'run_crash' AND step_name = 'a'`);
  assert.ok(cp, "步骤 a 已落检查点");

  // 模拟重启：标记中断（recover 语义）→ 重新入队 → 从检查点续跑
  db.run(`UPDATE runs SET status = 'queued' WHERE run_id = 'run_crash'`);
  const q2 = new TaskQueue(db, { concurrency: 1 });
  q2.register("legalRun", async (ctx: WorkflowContext) => {
    const a = await ctx.step("a", () => {
      executions.push("a-again");
      return "A";
    });
    assert.equal(a, "A", "检查点结果原样返回");
    await ctx.step("b", () => {
      executions.push("b-retry");
      db.run(`UPDATE runs SET status = 'succeeded' WHERE run_id = ?`, [ctx.runId]);
      return "B";
    });
  });
  const recovered = q2.recover();
  assert.ok(recovered >= 1, "重启后中断任务被重新排队");
  await new Promise((r) => setTimeout(r, 500));
  await q2.shutdown();
  assert.ok(!executions.includes("a-again"), "已完成步骤不重放");
  assert.ok(executions.includes("b-retry"), "未完成的步骤续跑");
  assert.equal(db.get<{ status: string }>(`SELECT status FROM runs WHERE run_id = 'run_crash'`)!.status, "succeeded");
});

test("队列：中断尝试落 interrupted；取消即时生效（协作式）", async () => {
  // 构造一个"运行中"的假象（上次进程崩溃遗留）
  insertRun("run_stuck", "running");
  db.run(
    `INSERT INTO attempts (attempt_id, run_id, seq, status, fence_token) VALUES ('att_stuck', 'run_stuck', 1, 'running', 1)`,
  );
  const q = new TaskQueue(db, { concurrency: 1 });
  let started = false;
  q.register("legalRun", async (ctx: WorkflowContext) => {
    started = true;
    // 协作式取消：步骤内检查权威状态
    for (let i = 0; i < 50; i++) {
      const r = db.get<{ status: string }>(`SELECT status FROM runs WHERE run_id = ?`, [ctx.runId])!;
      if (r.status === "cancelled") return;
      await new Promise((res) => setTimeout(res, 50));
    }
  });
  const recovered = q.recover();
  assert.equal(recovered, 1, "卡住的任务被重新排队");
  assert.equal(db.get<{ status: string }>(`SELECT status FROM attempts WHERE attempt_id = 'att_stuck'`)!.status, "interrupted", "中断尝试落 interrupted");
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(started, "任务已重新拉起");
  // 取消：权威状态即时生效
  db.run(`UPDATE runs SET status = 'cancelled' WHERE run_id = 'run_stuck'`);
  await new Promise((r) => setTimeout(r, 400));
  await q.shutdown();
  assert.equal(db.get<{ status: string }>(`SELECT status FROM runs WHERE run_id = 'run_stuck'`)!.status, "cancelled");
});

test("队列：退出模式下启动只做状态迁移、不拉起（复核 S6-B34）；resumeParked 入队，期间被取消的不拉起", async () => {
  const ran: string[] = [];
  const q = new TaskQueue(db, { concurrency: 1 });
  q.register("legalRun", async (ctx: WorkflowContext) => {
    ran.push(ctx.runId);
    db.run(`UPDATE runs SET status = 'succeeded' WHERE run_id = ?`, [ctx.runId]);
  });
  insertRun("run_parked_a");
  insertRun("run_parked_b");
  const n = q.recover({ start: false });
  assert.ok(n >= 2);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(ran.filter((id) => id.startsWith("run_parked")), [], "暂停：不拉起");
  db.run(`UPDATE runs SET status = 'cancelled' WHERE run_id = 'run_parked_b'`);
  assert.ok(q.resumeParked() >= 2);
  await new Promise((r) => setTimeout(r, 300));
  await q.shutdown();
  assert.deepEqual(ran.filter((id) => id.startsWith("run_parked")), ["run_parked_a"], "恢复后拉起；期间已取消的不拉起");
});

test("队列：拉起前的放行判断（复核 S6-C12）——运行中进入退出模式时，排队的任务同样暂停；放行后 resumeParked 继续", async () => {
  const ran: string[] = [];
  let allowed = false;
  const q = new TaskQueue(db, { concurrency: 1 });
  q.setStartGate(() => allowed);
  q.register("legalRun", async (ctx: WorkflowContext) => {
    ran.push(ctx.runId);
    db.run(`UPDATE runs SET status = 'succeeded' WHERE run_id = ?`, [ctx.runId]);
  });
  insertRun("run_gate_a");
  q.enqueue("run_gate_a");
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(ran.filter((id) => id === "run_gate_a"), [], "不放行：暂停");
  allowed = true;
  assert.equal(q.resumeParked(), 1);
  await new Promise((r) => setTimeout(r, 300));
  await q.shutdown();
  assert.deepEqual(ran.filter((id) => id === "run_gate_a"), ["run_gate_a"]);
});
