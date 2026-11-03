/**
 * V11 路由体检：成果已入库、结算前中断（断电、内核重启）后按检查点结算时，同样核对主交付物。
 * 原先这条路径直接按检查点里宿主的终态结算：起诉状任务只交了一张表，第一次结算前中断，恢复后记“已完成”。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { TaskQueue } from "../src/queue.ts";
import { createLegalWorkflow } from "../src/executor/executor.ts";
import { makeKernel, type TestKernel } from "./helpers.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({ ZR_MODEL_PROVIDER: "mock" }, "v11-resume");
});
after(async () => {
  await tk.kernel.close();
});

function seed(matterId: string, label: string, snapshot: Record<string, unknown>, artifact: { kind: string; filename: string }): string {
  const db = tk.kernel.db;
  const runId = `run_${label}_${Date.now()}`;
  db.run(
    `INSERT INTO runs (run_id, tenant_id, matter_id, scenario, workflow_version, status, idempotency_key, input_snapshot, created_by) VALUES (?,?,?,?,?,?,?,?,?)`,
    [runId, tk.kernel.identity.tenantId, matterId, "a1.agent_task", "v11-test", "queued", `idem-${runId}`, JSON.stringify(snapshot), tk.kernel.identity.userId],
  );
  db.run(`INSERT INTO attempts (attempt_id, run_id, seq, status, fence_token) VALUES (?,?,1,'interrupted',1)`, [`att_old_${runId}`, runId]);
  db.run(`INSERT INTO step_checkpoints (run_id, step_name, attempt_id, result_json) VALUES (?,?,?,?)`, [runId, "load_materials", `att_old_${runId}`, "[]"]);
  const blob = tk.kernel.blobs.put(Buffer.from(`成果-${runId}`), matterId);
  const avId = `av_${runId}`;
  db.run(
    `INSERT INTO artifact_versions (artifact_version_id, tenant_id, matter_id, run_id, kind, version, audience, status, filename, sha256, storage_uri, open_items, manifest, created_by) VALUES (?,?,?,?,?,1,'internal','draft',?,?,?,'[]','{}',?)`,
    [avId, tk.kernel.identity.tenantId, matterId, runId, artifact.kind, artifact.filename, blob.sha256, blob.storage_uri, tk.kernel.identity.userId],
  );
  db.run(`INSERT INTO step_checkpoints (run_id, step_name, attempt_id, result_json) VALUES (?,?,?,?)`, [
    runId,
    "agent_store_draft",
    `att_old_${runId}`,
    JSON.stringify({ status: "succeeded", reason: null, remaining: [], artifacts: [{ artifact_version_id: avId, sha256: blob.sha256 }] }),
  ]);
  return runId;
}

async function runWorkflow(runId: string): Promise<string> {
  const db = tk.kernel.db;
  let started = 0;
  const agent = { start: async () => (started++, "agt_never"), poll: async () => ({ status: "failed", events: [], next_cursor: 0, preview_text: "", error: "x", reason: "x", artifacts: [] }), cancel: async () => {} };
  const q = new TaskQueue(db, { concurrency: 1 });
  q.register("legalRun", createLegalWorkflow({ db, blobs: tk.kernel.blobs, broker: {} as any, agentClient: agent as any, lawdb: { packageVersion: "test" } as any, signer: tk.kernel.signer }));
  q.enqueue(runId);
  for (let i = 0; i < 200; i++) {
    const r = db.get<{ status: string }>(`SELECT status FROM runs WHERE run_id = ?`, [runId])!;
    if (!["queued", "running", "recovering"].includes(r.status)) break;
    await new Promise((r2) => setTimeout(r2, 50));
  }
  await q.shutdown();
  assert.equal(started, 0, "按检查点结算，不重跑 Agent");
  return db.get<{ status: string }>(`SELECT status FROM runs WHERE run_id = ?`, [runId])!.status;
}

test("按检查点恢复结算：文书类方法只交了表 → 部分完成并写明缺失；交了 Word → 完成；律师点名 Word 的同样核对", { timeout: 60_000 }, async () => {
  const newMatter = async () => (await tk.inv("matters.create", { title: "检查点核对主交付物", stance: "原告", consent_status: "not_required" })).matter;
  const pleading = { goal: "起草起诉状", skill: "pleading-draft", skill_primary_output: "民事起诉状（草稿）.docx" };
  const a = seed((await newMatter()).matter_id, "sheetonly", pleading, { kind: "agent_table", filename: "证据目录.xlsx" });
  assert.equal(await runWorkflow(a), "partial", "只交了表的起诉状任务恢复后不记“已完成”");
  const ev = tk.kernel.db.get<{ payload: string }>(`SELECT payload FROM run_events WHERE run_id = ? AND type = 'agent.primary_missing'`, [a]);
  assert.equal(JSON.parse(ev!.payload).cause, "no_word_output");

  const b = seed((await newMatter()).matter_id, "word", pleading, { kind: "agent_report", filename: "民事起诉状.docx" });
  assert.equal(await runWorkflow(b), "succeeded");

  const c = seed((await newMatter()).matter_id, "asked", { goal: "回稿意见给我 Word", skill: "redraft-review", skill_primary_output: "变更清单.xlsx", deliverable_request: { formats: ["docx"], not: [], document: null } }, { kind: "agent_table", filename: "变更清单.xlsx" });
  assert.equal(await runWorkflow(c), "partial", "律师点名 Word、只交了变更清单");
});
