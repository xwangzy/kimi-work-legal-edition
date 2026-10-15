/**
 * 复核 S5-B03：内核重启时停在“等待律师”的开放任务——待决的确认卡与提问只在 Agent 宿主内存中，重启后无法恢复：
 * 按“过期”收尾（终态事件留痕、预留点数释放），其出站批准作废；不静默拉起、不永久停在等待。
 * 以“现场重构”复刻崩溃（与 a1-lifecycle 同法）：直接落“运行等待中 + 尝试执行中”的残留，再在同一数据目录重开内核。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { makeKernel, type TestKernel } from "./helpers.ts";
import { EgressApprovalStore } from "../src/services/egress-approvals.ts";

const kernels: TestKernel["kernel"][] = [];
after(async () => {
  for (const k of kernels) await k.close().catch(() => {});
});

test("内核重启：等待律师中的开放任务按“过期”收尾、预留点数释放、终态事件留痕、批准作废", { timeout: 120_000 }, async () => {
  const tk = await makeKernel({ ZR_MODEL_PROVIDER: "mock", ZR_KERNEL_TCP: "off" }, "w1-restart-firm");
  kernels.push(tk.kernel);
  const { inv, kernel, dir } = tk;
  const { matter } = await inv("matters.create", { title: "重启事项", stance: "原告", consent_status: "not_required" });
  for (const [runId, status] of [
    ["run_wait_approval", "waiting_approval"],
    ["run_wait_input", "waiting_input"],
  ] as const) {
    kernel.db.run(
      `INSERT INTO runs (run_id, tenant_id, matter_id, scenario, workflow_version, status, idempotency_key, input_snapshot, budget_points, points_reserved, created_by)
       VALUES (?,?,?,?,'v5.0.0-g0',?,?,?,?,?,?)`,
      [runId, matter.tenant_id, matter.matter_id, "a1.agent_task", status, `idem-${runId}`, JSON.stringify({ goal: "研究" }), 60, 60, matter.created_by],
    );
    kernel.db.run(`INSERT INTO attempts (attempt_id, run_id, seq, status, fence_token) VALUES (?,?,1,'running',1)`, [`att_${runId}`, runId]);
  }
  const keys = generateKeyPairSync("ed25519");
  const store = new EgressApprovalStore(kernel.db, {
    deviceId: "dev_t",
    signPrivateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    signPublicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  });
  store.issue({ approvalId: "apr_restart", tenantId: matter.tenant_id, matterId: matter.matter_id, runId: "run_wait_approval", userId: matter.created_by, channel: "desktop", purpose: "search", reason: "search_entity_requires_confirmation", digest: null, dest: "search_service", variant: "generalized", scope: "task", policy: "fp" });
  await kernel.close();
  kernels.length = 0;

  const { createKernel } = await import("../src/index.ts");
  const k2 = await createKernel({ dataDir: dir, firmSlug: "w1-restart-firm", userSlug: "test-lawyer", env: { ...process.env, ZR_MODEL_PROVIDER: "mock", ZR_KERNEL_TCP: "off" } });
  kernels.push(k2);
  for (const runId of ["run_wait_approval", "run_wait_input"]) {
    const r = k2.db.get<{ status: string; points_reserved: number; terminal_reason: string }>(`SELECT status, points_reserved, terminal_reason FROM runs WHERE run_id = ?`, [runId])!;
    assert.equal(r.status, "expired", `${runId} 应按过期收尾，不停在等待`);
    assert.equal(r.points_reserved, 0, "预留点数释放");
    assert.match(r.terminal_reason, /无法恢复/);
    const ev = k2.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND type = 'run.expired'`, [runId])!;
    assert.equal(ev.n, 1, "终态事件留痕");
  }
  const live = k2.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM egress_approvals WHERE run_id = 'run_wait_approval' AND revoked_at IS NULL`)!.n;
  assert.equal(live, 0, "其出站批准作废");
});
