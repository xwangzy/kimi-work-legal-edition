/**
 * 断电恢复端到端（方案 §6.1 核心承诺；探针 11 的 v0 版；独立复核阻断-2 的回归）：
 * 以「现场重构」手法复刻崩溃现场（检查点停在 verify_citations 之后、尝试 running 残留），
 * 重启内核 → recover → 真实 legalRun 从检查点续跑到 succeeded，且：
 * - 中断尝试落 interrupted，新尝试 succeeded；
 * - 检查点步骤不重放（citations 工具调用不重复落账）；
 * - 成果不重复（同 sha256 内容去重）；事件 seq 无重复。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importText, DEMO_CONTRACT, waitRun } from "./helpers.ts";

process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "recovery-test-secret-0123456789ab";

const dir = mkdtempSync(join(tmpdir(), "kwl-recovery-"));
let k1: any;
let k2: any;

before(async () => {
  const { createKernel } = await import("../src/index.ts");
  k1 = await createKernel({ dataDir: dir, firmSlug: "rec-firm", userSlug: "rec-lawyer", env: { ...process.env, ZR_MODEL_PROVIDER: "mock" } });
});

after(async () => {
  for (const k of [k1, k2]) {
    try {
      await k?.close();
    } catch {
      // 已关闭
    }
  }
});

test("断电恢复：真实 legalRun 从最后检查点续跑到成功（不重演、不重复）", { timeout: 120_000 }, async () => {
  const inv1 = (m: string, p?: any) => k1.invoke(m, p);
  // 1. 先跑一个完整 S1（制造合法检查点内容与 v1 成果）
  const { matter } = await inv1("matters.create", { title: "恢复测试事项", stance: "受让方", consent_status: "not_required", key_dates: { analysis_as_of: "2026-10-01" } });
  const doc = await importText(inv1, matter.matter_id, "协议.txt", DEMO_CONTRACT);
  const est = await inv1("runs.estimate", { matter_id: matter.matter_id, scenario: "s1.contract_review", document_version_ids: [doc.document_version_id] });
  const runA = await inv1("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `rec-a-${Date.now()}` });
  const doneA = await waitRun(inv1, runA.run_id, 60_000);
  assert.equal(doneA.run.status, "succeeded");

  // 2. 现场重构：run B 崩在 verify_citations 之后（检查点复制自 run A，尝试 running 残留）
  const runBId = "run_crash_b";
  const attBId = "att_crash_b";
  const cps = k1.db.all(`SELECT step_name, result_json FROM step_checkpoints WHERE run_id = ? AND step_name IN ('load_materials','verify_citations')`, [runA.run_id]);
  assert.equal(cps.length, 2, "前置条件：run A 应有两个检查点");
  k1.db.run(
    `INSERT INTO runs (run_id, tenant_id, matter_id, scenario, workflow_version, status, idempotency_key, input_snapshot, budget_points, points_reserved, created_by)
     VALUES (?,?,?,?,'v5.0.0-g0','running',?,?,?,?,?)`,
    [runBId, matter.tenant_id, matter.matter_id, "s1.contract_review", `rec-b-${Date.now()}`, JSON.stringify({ document_version_ids: [doc.document_version_id], topic_hint: "保密义务" }), 40, 40, matter.created_by],
  );
  k1.db.run(`INSERT INTO attempts (attempt_id, run_id, seq, status, fence_token) VALUES (?,?,1,'running',1)`, [attBId, runBId]);
  for (const cp of cps) {
    k1.db.run(`INSERT INTO step_checkpoints (run_id, step_name, attempt_id, result_json, created_at) VALUES (?,?,?,?,?)`, [
      runBId,
      cp.step_name,
      attBId,
      cp.result_json,
      new Date().toISOString(),
    ]);
  }

  // 3. 模拟断电：直接关库（不经 queue.shutdown）
  k1.db.close();
  try {
    await k1.close();
  } catch {
    // 断电模拟：忽略关闭异常
  }

  // 4. 重启内核：recover 应把 run B 重置并重新拉起
  const { createKernel } = await import("../src/index.ts");
  k2 = await createKernel({ dataDir: dir, firmSlug: "rec-firm", userSlug: "rec-lawyer", env: { ...process.env, ZR_MODEL_PROVIDER: "mock" } });
  const doneB = await waitRun((m: string, p?: any) => k2.invoke(m, p), runBId, 60_000);
  assert.equal(doneB.run.status, "succeeded", `恢复后应为 succeeded；事件: ${JSON.stringify(doneB.events.map((e: any) => [e.type, e.payload?.error ?? ""]))}`);

  // 5. 中断尝试 interrupted，新尝试 succeeded
  const attempts = k2.db.all(`SELECT seq, status FROM attempts WHERE run_id = ? ORDER BY seq`, [runBId]);
  assert.deepEqual(attempts.map((a: any) => a.status), ["interrupted", "succeeded"]);

  // 6. 检查点步骤不重放：citations.verify 工具调用只落账一次（在恢复后的新尝试上为零）
  const citOps = k2.db.all(`SELECT * FROM tool_operations WHERE run_id = ? AND tool = 'citations.verify'`, [runBId]);
  assert.equal(citOps.length, 0, "verify_citations 检查点命中，工具调用不重放不落账");
  const modelOps = k2.db.all(`SELECT * FROM tool_operations WHERE run_id = ? AND tool = 'model'`, [runBId]);
  assert.equal(modelOps.length, 1, "model_review 未完成的步骤续跑一次");

  // 7. 成果与事件完整性：issue_table 与 run A 内容相同 → 内容 hash 去重复用版本；事件 seq 无重复
  const issueTables = k2.db.all(`SELECT artifact_version_id, version FROM artifact_versions WHERE matter_id = ? AND kind = 's1_issue_table'`, [matter.matter_id]);
  assert.equal(issueTables.length, 1, "同内容成果以内容 hash 去重（不产生重复版本）");
  const seqs = doneB.events.map((e: any) => e.seq);
  assert.equal(new Set(seqs).size, seqs.length, "事件 seq 无重复");
});

test("同内容复跑：s1_issue_table 内容 hash 去重，s1_opinion 因含请求 ID 生成新版本", { timeout: 120_000 }, async () => {
  const inv2 = (m: string, p?: any) => k2.invoke(m, p);
  const { matter } = await inv2("matters.create", { title: "去重测试", stance: "受让方", consent_status: "not_required", key_dates: { analysis_as_of: "2026-10-01" } });
  const doc = await importText(inv2, matter.matter_id, "协议.txt", DEMO_CONTRACT);
  for (const tag of ["x", "y"]) {
    const est = await inv2("runs.estimate", { matter_id: matter.matter_id, scenario: "s1.contract_review", document_version_ids: [doc.document_version_id], topic_hint: "保密义务" });
    const run = await inv2("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `dedup-${tag}-${Date.now()}` });
    const done = await waitRun(inv2, run.run_id, 60_000);
    assert.equal(done.run.status, "succeeded");
  }
  const issues = k2.db.all(`SELECT * FROM artifact_versions WHERE matter_id = ? AND kind = 's1_issue_table'`, [matter.matter_id]);
  assert.equal(issues.length, 1, "同内容问题表去重");
  const opinions = k2.db.all(`SELECT * FROM artifact_versions WHERE matter_id = ? AND kind = 's1_opinion'`, [matter.matter_id]);
  assert.equal(opinions.length, 2, "意见书含每次请求 ID，内容不同各自成版");
});
