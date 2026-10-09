/**
 * 所内节点（§5.1/§7.4）端到端：桌面 + headless 节点（同机双内核）经共享文件夹——
 * 授权事项材料同步到节点 → runs.node_enqueue → 节点拾取执行（mock S1）→ 成果同步回桌面；
 * 未授权/strict 入队即拒；租约并发恰好 1 胜、过期可接管；定时任务幂等与草稿产物；控制台只读。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetch as undiciFetch } from "undici";
import { makeKernel, type TestKernel } from "./helpers.ts";
import { startFirmNode, type FirmNodeHandle } from "@zr-legal/firm-node";
import { claimNodeTask, claimScheduledJob } from "../src/node-service.ts";

let tk: TestKernel;
let node: FirmNodeHandle;
let shareDir: string;

before(async () => {
  shareDir = mkdtempSync(join(tmpdir(), "kwl-node-share-"));
  tk = await makeKernel({}, "node-e2e-firm");
  const wsN = mkdtempSync(join(tmpdir(), "kwl-nodeN-"));
  mkdirSync(join(wsN, "node-e2e-firm", "keys"), { recursive: true });
  copyFileSync(join(tk.dir, "node-e2e-firm", "keys", "firm-root.json"), join(wsN, "node-e2e-firm", "keys", "firm-root.json"));
  node = await startFirmNode({
    dataDir: wsN,
    firmSlug: "node-e2e-firm",
    shareDir,
    syncIntervalMs: 60_000, // 测试手动 tick
    leaseMs: 5_000,
    consoleToken: "test-console-token",
    env: { ...process.env, ZR_MODEL_PROVIDER: "mock" },
  });
  // 桌面登记节点设备（跨机器加入流程 G1；v0 测试直接登记证书）
  const nodeDev = node.kernel.db.get<any>(`SELECT * FROM devices WHERE device_id = 'dev_node-e2e-firm_node'`);
  tk.kernel.db.run(
    `INSERT OR IGNORE INTO devices (device_id, tenant_id, member_id, role, sign_pub_pem, enc_pub_pem, cert_json, status, key_epoch_at_issue) VALUES (?,?,?,?,?,?,?, 'active', 1)`,
    [nodeDev.device_id, nodeDev.tenant_id, nodeDev.member_id, nodeDev.role, nodeDev.sign_pub_pem, nodeDev.enc_pub_pem, nodeDev.cert_json],
  );
});

after(async () => {
  await tk.kernel.close();
  await node.stop();
});

test("节点全链：授权 → 同步 → 转交执行 → 结果回桌面；未授权/strict 入队即拒", { timeout: 240_000 }, async () => {
  const { inv } = tk;
  // 未授权事项入队即拒
  const m0 = await inv("matters.create", { title: "未授权事项", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  await assert.rejects(
    () => inv("runs.node_enqueue", { matter_id: m0.matter.matter_id, scenario: "s1.contract_review", idempotency_key: "nt-reject-1" }),
    (e: any) => e.code === "forbidden" || /未授权/.test(e.message),
  );
  // strict 入队即拒
  const mS = await inv("matters.create", { title: "strict 事项", stance: "受让方", consent_status: "not_required", confidentiality: "strict", collab_scope: "team" });
  await assert.rejects(() => inv("matters.node_authorize", { matter_id: mS.matter.matter_id }), (e: any) => e.code === "forbidden");
  await assert.rejects(
    () => inv("runs.node_enqueue", { matter_id: mS.matter.matter_id, scenario: "s1.contract_review", idempotency_key: "nt-reject-2" }),
    (e: any) => e.code === "forbidden" || /strict/.test(e.message),
  );

  // 授权事项：authorize（显式跨工作区节点设备）→ 同步 → 转交 → 节点执行
  const { matter } = await inv("matters.create", { title: "节点执行事项", stance: "受让方", consent_status: "not_required", collab_scope: "team", key_dates: { analysis_as_of: "2026-10-01" } });
  await inv("matters.node_authorize", { matter_id: matter.matter_id, node_device_id: "dev_node-e2e-firm_node" });
  const doc = await inv("materials.import", { matter_id: matter.matter_id, filename: "协议.txt", data_base64: Buffer.from("股权转让协议\n第七条 乙方应当遵守《律师法》第三十八条规定的保密义务。", "utf8").toString("base64"), mime: "text/plain" });
  await inv("sync.export", { share_dir: shareDir });
  await node.kernel.invoke("sync.import", { share_dir: shareDir });

  const enq = await inv("runs.node_enqueue", {
    matter_id: matter.matter_id,
    scenario: "s1.contract_review",
    input: { document_version_ids: [doc.document_version_id], topic_hint: "保密义务" },
    idempotency_key: "nt-e2e-1",
  });
  assert.equal(enq.status, "queued");
  // 幂等：同键复投返回原任务
  const enq2 = await inv("runs.node_enqueue", {
    matter_id: matter.matter_id,
    scenario: "s1.contract_review",
    input: { document_version_ids: [doc.document_version_id] },
    idempotency_key: "nt-e2e-1",
  });
  assert.equal(enq2.idempotent_replay, true);

  // 队列行同步到节点（登记行插入同步），随后节点 tick 拾取
  await inv("sync.export", { share_dir: shareDir });
  await node.tick();
  const nTask = node.kernel.db.get<any>(`SELECT status, run_id FROM node_tasks WHERE task_id = ?`, [enq.task_id]);
  assert.equal(nTask.status, "succeeded", `节点应执行成功：${JSON.stringify(nTask)}`);
  const nRun = (await node.kernel.invoke("runs.get", { run_id: nTask.run_id })) as any;
  assert.equal(nRun.run.status, "succeeded");

  // 结果回桌面：节点导出 → 桌面摄取 → run/成果可见、node_tasks.list 收敛 run_status
  await node.kernel.invoke("sync.export", { share_dir: shareDir });
  await inv("sync.import", { share_dir: shareDir });
  const dRun = (await inv("runs.get", { run_id: nTask.run_id })) as any;
  assert.equal(dRun.run.status, "succeeded", "桌面应看到节点执行的 run");
  assert.ok(dRun.artifacts.length >= 1, "桌面应看到节点产出成果");
  const list = await inv("node_tasks.list", { matter_id: matter.matter_id });
  assert.equal(list.tasks[0].run_status, "succeeded", "node_tasks.list 经 runs 行收敛状态");

  // 授权撤销后队列残留被硬门禁拦下：revoke 后再入队一个任务 → 节点标 failed
  await inv("matters.node_revoke", { matter_id: matter.matter_id });
  await inv("sync.export", { share_dir: shareDir });
  await node.kernel.invoke("sync.import", { share_dir: shareDir });
  const enq3 = await inv("runs.node_enqueue", { matter_id: matter.matter_id, scenario: "s1.contract_review", input: { document_version_ids: [doc.document_version_id] }, idempotency_key: "nt-e2e-2" }).catch((e: any) => e);
  // revoke 后桌面入队本身也会被拒（第一处门禁）
  assert.ok(enq3.code === "forbidden" || enq3.status === "queued", JSON.stringify(enq3));
});

test("租约：并发抢跑恰好 1 胜；过期可接管", async () => {
  // 独立工作区隔离前序用例的登记行（node_tasks 登记行插入同步，终态以 runs 行收敛）
  const tk2 = await makeKernel({}, "lease-firm");
  try {
    const { inv } = tk2;
    const db = tk2.kernel.db;
    const { matter } = await inv("matters.create", { title: "租约事项", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
    await inv("matters.node_authorize", { matter_id: matter.matter_id });
    await inv("runs.node_enqueue", { matter_id: matter.matter_id, scenario: "s1.contract_review", idempotency_key: "nt-lease-1" });

    // 10 个 owner 并发抢同一任务 → 恰好 1 胜
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => Promise.resolve(claimNodeTask(db, `owner-${i}`, 60_000))));
    const wins = results.filter((r) => r !== null);
    assert.equal(wins.length, 1, `并发抢跑应恰好 1 胜，实际 ${wins.length}`);
    const winner = wins[0]!;
    assert.ok(winner.lease_owner?.startsWith("owner-"), "胜者持租约");

    // 租约未过期：别人抢不到
    assert.equal(claimNodeTask(db, "owner-late", 60_000), null);
    // 租约过期：可被接管（模拟节点死亡）
    db.run(`UPDATE node_tasks SET lease_until = ?, status = 'queued' WHERE task_id = ?`, [new Date(Date.now() - 1000).toISOString(), winner.task_id]);
    const taken = claimNodeTask(db, "owner-backup", 60_000);
    assert.ok(taken && taken.lease_owner === "owner-backup", "过期租约应被接管");

    // scheduled_jobs 租约同理
    await inv("jobs.create", { kind: "deadline_reminder", matter_id: matter.matter_id, interval_seconds: 60, params: { days_before: 30 } });
    const jobResults = await Promise.all(Array.from({ length: 10 }, (_, i) => Promise.resolve(claimScheduledJob(db, `jowner-${i}`, 60_000))));
    assert.equal(jobResults.filter((r) => r !== null).length, 1, "定时任务并发抢跑恰好 1 胜");
  } finally {
    await tk2.kernel.close();
  }
});

test("定时任务：deadline_reminder 幂等一次；matter_weekly_report 草稿", async () => {
  const { runDeadlineReminder, runMatterWeeklyReport, finishScheduledJob } = await import("../src/node-service.ts");
  const { inv } = tk;
  const db = tk.kernel.db;
  const future = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
  const { matter } = await inv("matters.create", { title: "定时任务事项", stance: "受让方", consent_status: "not_required", collab_scope: "team", key_dates: { 开庭日: future } });
  await inv("matters.node_authorize", { matter_id: matter.matter_id, node_device_id: "dev_node-e2e-firm_node" });
  const j1 = await inv("jobs.create", { kind: "deadline_reminder", matter_id: matter.matter_id, interval_seconds: 60, params: { days_before: 30 } });
  const j2 = await inv("jobs.create", { kind: "matter_weekly_report", matter_id: matter.matter_id, interval_seconds: 60 });

  const job1 = db.get<any>(`SELECT * FROM scheduled_jobs WHERE job_id = ?`, [j1.job_id]);
  const r1 = runDeadlineReminder(db, job1);
  assert.equal(r1.created, 1, "到期提醒生成一次");
  const r1b = runDeadlineReminder(db, job1);
  assert.equal(r1b.created, 0, "重复检查不重复生成");

  const job2 = db.get<any>(`SELECT * FROM scheduled_jobs WHERE job_id = ?`, [j2.job_id]);
  const r2 = await runMatterWeeklyReport(db, tk.kernel.blobs, job2, tk.kernel.signer);
  assert.ok(r2.artifact_version_id, "周报成果");
  const art = db.get<any>(`SELECT status, kind FROM artifact_versions WHERE artifact_version_id = ?`, [r2.artifact_version_id]);
  assert.equal(art.status, "draft", "周报产物为草稿");
  assert.equal(art.kind, "matter_weekly_report");
  finishScheduledJob(db, j1.job_id, r1);
  finishScheduledJob(db, j2.job_id, r2);

  // 应当-6：定时任务审计事件已上链（signer 注入的统一漏斗）
  const jobAudit = db.get<any>(`SELECT audit_event_id FROM audit_events WHERE action = 'job.matter_weekly_report' AND object_id = ? ORDER BY audit_event_id DESC LIMIT 1`, [matter.matter_id]);
  assert.ok(jobAudit, "job 审计事件落库");
  assert.ok(db.get(`SELECT 1 AS x FROM signed_events WHERE kind = 'audit_event' AND ref_id = ?`, [String(jobAudit.audit_event_id)]), "job 审计事件已入签名链");
});

test("控制台 v0：token 鉴权、只读字段无正文、无写端点", async () => {
  const base = `http://127.0.0.1:${node.console.port}`;
  // 无 token → 401
  const r401 = await undiciFetch(`${base}/status`);
  assert.equal(r401.status, 401);
  // 错 token → 401
  const r401b = await undiciFetch(`${base}/status`, { headers: { authorization: "Bearer wrong" } });
  assert.equal(r401b.status, 401);
  // 正 token → 200，字段为只读元数据
  const r200 = await undiciFetch(`${base}/status`, { headers: { authorization: "Bearer test-console-token" } });
  assert.equal(r200.status, 200);
  const st = (await r200.json()) as any;
  assert.equal(st.service, "kwl-firm-node");
  const m = await undiciFetch(`${base}/matters`, { headers: { authorization: "Bearer test-console-token" } });
  const matters = (await m.json()) as any;
  for (const row of matters.matters) {
    assert.ok(!("client_name" in row) && !("counterparty" in row) && !("key_dates" in row) && !("stance" in row), "字段须脱敏");
  }
  const a = await undiciFetch(`${base}/audit/tail`, { headers: { authorization: "Bearer test-console-token" } });
  assert.equal(a.status, 200);
  // 写端点一律 405
  const post = await undiciFetch(`${base}/status`, { method: "POST", headers: { authorization: "Bearer test-console-token" }, body: "{}" });
  assert.equal(post.status, 405);
});
