/** V18 第 43 批：排队中的任务要能说出“前面有几个任务在等你确认或回答”，界面不再只写“排队中”。 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeKernel, type TestKernel } from "./helpers.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel();
});
after(async () => {
  await tk.kernel.close();
});

function insertRun(matterId: string, runId: string, status: string): void {
  const id = tk.kernel.identity;
  tk.kernel.db.run(
    `INSERT INTO runs (run_id, tenant_id, matter_id, scenario, workflow_version, status, idempotency_key, created_by) VALUES (?,?,?,?,?,?,?,?)`,
    [runId, id.tenantId, matterId, "a1.agent_task", "test", status, `idem-${runId}`, id.userId],
  );
}

test("排队中的任务：返回正在等律师的任务数；不在排队的任务恒为 0", async () => {
  const { matter } = await tk.inv("matters.create", { title: "排队提示", stance: "买方", consent_status: "not_required" });
  insertRun(matter.matter_id, "run_b43_wait_a", "waiting_approval");
  insertRun(matter.matter_id, "run_b43_wait_b", "waiting_input");
  insertRun(matter.matter_id, "run_b43_done", "succeeded");
  // 直接写成 queued 而不入队：只验证接口口径，不让队列把它拉起
  insertRun(matter.matter_id, "run_b43_queued", "queued");
  const q = await tk.inv("runs.get", { run_id: "run_b43_queued" });
  assert.equal(q.waiting_ahead, 2);
  const w = await tk.inv("runs.get", { run_id: "run_b43_wait_a" });
  assert.equal(w.waiting_ahead, 0);
  const d = await tk.inv("runs.get", { run_id: "run_b43_done" });
  assert.equal(d.waiting_ahead, 0);
});
