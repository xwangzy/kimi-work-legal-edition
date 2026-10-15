/**
 * v9 第 04 篇 §9 现有缺陷 F1–F7 回归（探针 P11），含阶段 1 对抗式审查 R-01～R-20 的反例。
 *
 * K9-1（SDK 宿主退役）：旧宿主管理器的用例（假宿主 NDJSON 协议、进程组、stdout 排空、完成记录、清单式授权）随管理器删除；
 * 仍适用于 kap 适配器的不变量在 kap-parity.test.ts 复核，清单式授权在 host-policy authorize.test.ts。
 * 本文件保留执行器、端点、恢复与迁移器层的回归（与 Agent 引擎无关）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAgentOutcome } from "@zr-legal/domain";
import { schemaHash } from "@zr-legal/host-policy";
import { TaskQueue } from "../src/queue.ts";
import { createLegalWorkflow } from "../src/executor/executor.ts";
import { TOOLS, legalToolLockProblems } from "../src/tools/registry.ts";
import { verifyToolsAgainstLock, loadSignedToolLock } from "../src/tools/manifest-lock.ts";
import { makeKernel, importText, liveTaskIdentity, waitRun, type TestKernel } from "./helpers.ts";

const sha = (b: string | Uint8Array): string => createHash("sha256").update(b).digest("hex");
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

let dir: string;
let tk: TestKernel;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "kwl-v9-defects-"));
  tk = await makeKernel({ ZR_MODEL_PROVIDER: "mock" }, "v9-defects");
});

after(async () => {
  await tk.kernel.close();
});

// ─── F1 终态枚举化（含审查 R-03：结束原因白名单） ───

test("F1/R-03 resolveAgentOutcome：结束原因走白名单——缺失、未知、截断、拦截都不是成功", () => {
  const ok = { hostStatus: "succeeded", exitCode: 0, turnEndReason: "completed", finishReason: "end_turn", providerFinishReason: "completed", verifiedArtifacts: 1, invalidArtifacts: 0 };
  assert.deepEqual(resolveAgentOutcome(ok), { outcome: "succeeded", reason: null });
  assert.equal(resolveAgentOutcome({ ...ok, hostStatus: "timeout" }).outcome, "timed_out");
  assert.equal(resolveAgentOutcome({ ...ok, hostStatus: undefined }).reason, "missing_completion_record");
  assert.equal(resolveAgentOutcome({ ...ok, hostStatus: "done" }).reason, "unknown_status");
  assert.equal(resolveAgentOutcome({ ...ok, exitCode: 1 }).reason, "exit_code_mismatch");
  assert.equal(resolveAgentOutcome({ ...ok, exitCode: null }).reason, "exit_code_mismatch");
  assert.equal(resolveAgentOutcome({ ...ok, verifiedArtifacts: 0 }).reason, "missing_artifact");
  assert.equal(resolveAgentOutcome({ ...ok, invalidArtifacts: 1 }).reason, "artifact_hash_mismatch");
  assert.equal(resolveAgentOutcome({ ...ok, turnEndReason: "failed" }).reason, "turn_not_completed");
  // 审查附录 A 的反例：undefined/other/interrupted/error/paused 不再判成功
  for (const fr of [undefined, "other", "interrupted", "error", "paused"]) {
    const d = resolveAgentOutcome({ ...ok, finishReason: fr });
    assert.notEqual(d.outcome, "succeeded", `finishReason=${fr}`);
  }
  assert.deepEqual(resolveAgentOutcome({ ...ok, finishReason: "max_tokens", providerFinishReason: "truncated" }), { outcome: "partial", reason: "length_truncated" });
  assert.deepEqual(resolveAgentOutcome({ ...ok, providerFinishReason: "truncated" }), { outcome: "partial", reason: "length_truncated" });
  assert.deepEqual(resolveAgentOutcome({ ...ok, finishReason: "max_tokens", verifiedArtifacts: 0 }), { outcome: "failed", reason: "length_truncated" });
  assert.deepEqual(resolveAgentOutcome({ ...ok, providerFinishReason: undefined }), { outcome: "partial", reason: "finish_reason_unreported" });
  assert.equal(resolveAgentOutcome({ ...ok, finishReason: "filtered" }).reason, "content_filtered");
});

// ─── F3 清单式授权（含审查 R-08/R-09） ───

test("R-08 清单来自评审后的签名锁文件：实现与锁文件漂移（schema、副作用、资源、版本、未登记）一律不暴露", () => {
  const lockFile = join(ROOT, "content", "tool-manifest", "dist", "tool-manifest.lock.json");
  const pub = (JSON.parse(readFileSync(join(ROOT, "content", "keys", "content-signing-dev.pub.json"), "utf8")) as { publicKeyPem: string }).publicKeyPem;
  const lock = loadSignedToolLock(lockFile, pub);
  // CI 守卫：当前实现与评审后的锁文件完全一致（改 schema 或副作用必须同步改锁文件并经评审）
  assert.deepEqual([...legalToolLockProblems()], [], "实现与锁文件不一致");
  const tool = TOOLS.find((x) => x.name === "materials.read_excerpt")!;
  const drift = (patch: Partial<typeof tool>) => verifyToolsAgainstLock(lock, [{ ...tool, ...patch } as typeof tool]).get(tool.name);
  assert.match(String(drift({ inputSchema: { ...tool.inputSchema, properties: { ...(tool.inputSchema as any).properties, extra: { type: "string" } } } })), /schema hash/);
  assert.match(String(drift({ sideEffect: "write_draft" })), /副作用/);
  assert.match(String(drift({ resource: "pure" })), /资源/);
  assert.match(String(drift({ version: "2" })), /版本/);
  assert.match(String(verifyToolsAgainstLock(lock, [{ ...tool, name: "evil.tool" }]).get("evil.tool")), /未登记/);
  assert.match(String(verifyToolsAgainstLock(null, [tool]).get(tool.name)), /不可用/);
  // 篡改锁文件 → 验签失败
  const tampered = join(dir, "tool-manifest.lock.json");
  writeFileSync(tampered, readFileSync(lockFile, "utf8").replace('"read"', '"write_draft"'));
  writeFileSync(join(dir, "tool-manifest.manifest.json"), readFileSync(lockFile.replace(/lock\.json$/, "manifest.json")));
  assert.throws(() => loadSignedToolLock(tampered, pub), /hash 不符|验签失败/);
  assert.equal(schemaHash(tool.inputSchema), lock.tools.find((x) => x.name === tool.name)!.schemaHash);
});

// ─── F6 令牌撤销、进程组、fencing、outbox（含审查 R-01/R-02/R-06/R-07） ───

test("R-06 fencing：令牌绑定尝试与纪元——尝试结束、被新尝试取代、或凭空编造的身份，端点一律 401", { timeout: 60_000 }, async () => {
  const { mintTaskToken } = await import("../src/identity.ts");
  const { matter } = await tk.inv("matters.create", { title: "fencing", stance: "受让方", consent_status: "not_required" });
  const live = liveTaskIdentity(tk, matter.matter_id, "fence");
  const tok = (claims: Record<string, unknown>) => mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, scope: ["tool:legal"], ...claims } as any, 300);
  const list = async (token: string) =>
    (await fetch(`http://127.0.0.1:${tk.kernel.localPort}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).status;
  const good = tok({ rid: live.rid, aid: live.aid, fen: live.fence });
  assert.equal(await list(good), 200);
  assert.equal(await list(tok({ rid: live.rid, aid: live.aid })), 401, "缺纪元");
  assert.equal(await list(tok({ rid: live.rid, aid: live.aid, fen: 2 })), 401, "纪元不符");
  assert.equal(await list(tok({ rid: "run_made_up", aid: "att_made_up", fen: 1 })), 401, "凭空编造的身份");
  // 新尝试取代旧尝试（stepStart 同款：旧尝试中断）→ 旧令牌立即失效
  tk.kernel.db.run(`UPDATE attempts SET status = 'interrupted' WHERE attempt_id = ?`, [live.aid]);
  tk.kernel.db.run(`INSERT INTO attempts (attempt_id, run_id, seq, status, fence_token) VALUES (?,?,2,'running',2)`, [`${live.aid}_2`, live.rid]);
  assert.equal(await list(good), 401, "旧尝试令牌失效");
  assert.equal(await list(tok({ rid: live.rid, aid: `${live.aid}_2`, fen: 2 })), 200, "新尝试令牌有效");
  // 任务进入终态 → 令牌失效（不依赖内存撤销集）
  tk.kernel.db.run(`UPDATE runs SET status = 'failed' WHERE run_id = ?`, [live.rid]);
  assert.equal(await list(tok({ rid: live.rid, aid: `${live.aid}_2`, fen: 2 })), 401, "任务终态后令牌失效");
});

test("R-06/R-07 outbox：同一任务同一参数只执行一次（新尝试重放存档结果）；旧尝试令牌被 fencing 拒绝；结果不明拒绝重放", { timeout: 60_000 }, async () => {
  const { mintTaskToken, taskTokenKey } = await import("../src/identity.ts");
  const { startLocalServer, localServerPort } = await import("../src/local-server.ts");
  // A1 的 MCP 面只暴露只读工具（设计如此）；这里起一个不带 A1 白名单的本机端点，直接验证 outbox 语义。
  // 副作用类别由任务记录派生（复审 N-03）：用“起草”意图的任务（读 + 写草稿）
  const servers = await startLocalServer(
    { db: tk.kernel.db, blobs: tk.kernel.blobs, broker: {} as any, lawdb: {} as any, secret: taskTokenKey() },
    { port: 0, pipePath: join(dir, "outbox.sock") },
  );
  const port = localServerPort(servers.tcp);
  const { matter } = await tk.inv("matters.create", { title: "outbox-mcp", stance: "受让方", consent_status: "not_required" });
  const live = liveTaskIdentity(tk, matter.matter_id, "outbox", "a1.drafting");
  const db = tk.kernel.db;
  const call = async (aid: string, fen: number, name: string, args: unknown) => {
    const token = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid, fen, fx: ["read", "write_draft"], pur: "drafting", scope: ["tool:legal"] });
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const args = { title: "备忘录", sections: [{ heading: "结论", paragraphs: ["幂等测试"] }] };
  const r1 = await call(live.aid, 1, "docx.render_report", args);
  assert.equal(r1.body.result.isError, false, JSON.stringify(r1.body));
  // 恢复：旧尝试中断、新尝试开始（纪元 2）
  db.run(`UPDATE attempts SET status = 'interrupted' WHERE attempt_id = ?`, [live.aid]);
  db.run(`INSERT INTO attempts (attempt_id, run_id, seq, status, fence_token) VALUES (?,?,2,'running',2)`, [`${live.aid}_2`, live.rid]);
  const stale = await call(live.aid, 1, "docx.render_report", args);
  assert.equal(stale.status, 401, "旧尝试令牌被 fencing 拒绝");
  const r2 = await call(`${live.aid}_2`, 2, "docx.render_report", args);
  assert.deepEqual(r2.body.result.structuredContent, r1.body.result.structuredContent, "新尝试重放返回存档结果");
  const ops = db.all<{ status: string; side_effect: string }>(`SELECT status, side_effect FROM tool_operations WHERE run_id = ? AND tool = 'docx.render_report'`, [live.rid]);
  assert.equal(ops.length, 1, "同一幂等键只有一行（只执行一次）");
  assert.deepEqual([ops[0]!.status, ops[0]!.side_effect], ["succeeded", "write_draft"]);
  db.run(`UPDATE tool_operations SET status = 'unknown' WHERE run_id = ? AND tool = 'docx.render_report'`, [live.rid]);
  const r3 = await call(`${live.aid}_2`, 2, "docx.render_report", args);
  assert.equal(r3.body.result.isError, true);
  assert.match(r3.body.result.content[0].text, /结果不明/);
  // 端点独立裁决（R-09）：令牌未授予 write_draft → 拒绝
  const noFx = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: `${live.aid}_2`, fen: 2, pur: "drafting", scope: ["tool:legal"] });
  const denied = (await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${noFx}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "docx.render_report", arguments: { title: "x", sections: [] } } }),
  }).then((r) => r.json())) as any;
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /未授予副作用类别 write_draft/);
  for (const sv of [servers.tcp, servers.pipe]) if (sv) await new Promise<void>((r) => sv.close(() => r()));
});

test("R-09 端点按数据库复核参数实际指向的事项：他事项解析版本 → 拒绝，且口径与“不存在”相同（不形成存在性探测）", { timeout: 60_000 }, async () => {
  const { mintTaskToken } = await import("../src/identity.ts");
  const { matter: victim } = await tk.inv("matters.create", { title: "受害事项", stance: "受让方", consent_status: "not_required" });
  const vdoc = await importText(tk.inv, victim.matter_id, "机密.txt", "VICTIM-SECRET 内容");
  const { matter: own } = await tk.inv("matters.create", { title: "本事项", stance: "受让方", consent_status: "not_required" });
  const live = liveTaskIdentity(tk, own.matter_id, "xm");
  const token = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, scope: ["tool:legal"] });
  const read = async (pv: string) =>
    (await fetch(`http://127.0.0.1:${tk.kernel.localPort}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "materials.read_excerpt", arguments: { parse_version_id: pv } } }),
    }).then((x) => x.json())) as any;
  const r = await read(vdoc.parse_version_id);
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /^not_found/);
  assert.ok(!/cross_matter|受害|forbidden/.test(JSON.stringify(r)), "不透露对象在别的事项");
  assert.ok(!JSON.stringify(r).includes("VICTIM-SECRET"));
  // 复审 N-02：与“真不存在”逐字对照
  const missing = await read("pv_does_not_exist_000");
  assert.equal(r.result.content[0].text, missing.result.content[0].text, "越界与不存在口径逐字相同");
});

// ─── 恢复与终态（审查 R-04/R-05） ───

async function runWorkflow(runId: string, agent: any): Promise<string> {
  const db = tk.kernel.db;
  const q = new TaskQueue(db, { concurrency: 1 });
  q.register("legalRun", createLegalWorkflow({ db, blobs: tk.kernel.blobs, broker: {} as any, agentClient: agent, lawdb: { packageVersion: "test" } as any, signer: tk.kernel.signer }));
  q.enqueue(runId);
  for (let i = 0; i < 100; i++) {
    const r = db.get<{ status: string }>(`SELECT status FROM runs WHERE run_id = ?`, [runId])!;
    if (!["queued", "running", "recovering"].includes(r.status)) break;
    await new Promise((r2) => setTimeout(r2, 50));
  }
  await q.shutdown();
  return db.get<{ status: string }>(`SELECT status FROM runs WHERE run_id = ?`, [runId])!.status;
}

function seedRun(matterId: string, label: string, status = "queued"): string {
  const runId = `run_${label}_${Date.now()}`;
  tk.kernel.db.run(
    `INSERT INTO runs (run_id, tenant_id, matter_id, scenario, workflow_version, status, idempotency_key, input_snapshot, created_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [runId, tk.kernel.identity.tenantId, matterId, "a1.agent_task", "v9-test", status, `idem-${runId}`, JSON.stringify({ goal: "整理" }), tk.kernel.identity.userId],
  );
  tk.kernel.db.run(`INSERT INTO attempts (attempt_id, run_id, seq, status, fence_token) VALUES (?,?,1,'interrupted',1)`, [`att_old_${runId}`, runId]);
  tk.kernel.db.run(`INSERT INTO step_checkpoints (run_id, step_name, attempt_id, result_json) VALUES (?,?,?,?)`, [runId, "load_materials", `att_old_${runId}`, "[]"]);
  return runId;
}

const neverAgent = () => {
  const calls = { started: 0 };
  return {
    calls,
    agent: {
      start: async () => {
        calls.started += 1;
        return "agt_never";
      },
      poll: async () => ({ status: "failed" as const, events: [], next_cursor: 0, preview_text: "", error: "x", reason: "x", artifacts: [] }),
      cancel: async () => {},
    },
  };
};

test("F6 恢复：上次尝试留下结果不明（pending）的副作用调用 → reconciling，不盲目重跑", { timeout: 60_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "outbox 事项", stance: "受让方", consent_status: "not_required" });
  const runId = seedRun(matter.matter_id, "recon");
  tk.kernel.db.run(
    `INSERT INTO tool_operations (tool_operation_id, run_id, attempt_id, tool, operation, params_hash, status, idempotency_key, side_effect)
     VALUES (?,?,?,?,?,?,'pending',?,?)`,
    [`top_${runId}`, runId, `att_old_${runId}`, "docx.render_report", "mcp_call", "x".repeat(64), "idem-pending", "write_draft"],
  );
  const { agent, calls } = neverAgent();
  assert.equal(await runWorkflow(runId, agent), "reconciling");
  assert.equal(calls.started, 0, "结果不明时不重新拉起 Agent");
});

/** 为种子任务登记一份已入库成果与 agent_store_draft 检查点（模拟“上次尝试成果已入库、结算前中断”）。 */
function seedDraftCheckpoint(matterId: string, runId: string, status: "succeeded" | "partial" = "succeeded"): string {
  const db = tk.kernel.db;
  const blob = tk.kernel.blobs.put(Buffer.from(`成果-${runId}`), matterId);
  const avId = `av_${runId}`;
  db.run(
    `INSERT INTO artifact_versions (artifact_version_id, tenant_id, matter_id, run_id, kind, version, audience, status, filename, sha256, storage_uri, open_items, manifest, created_by)
     VALUES (?,?,?,?,?,1,'internal','draft',?,?,?,'[]','{}',?)`,
    [avId, tk.kernel.identity.tenantId, matterId, runId, "a1_agent_draft", "x.md", blob.sha256, blob.storage_uri, tk.kernel.identity.userId],
  );
  db.run(`INSERT INTO step_checkpoints (run_id, step_name, attempt_id, result_json) VALUES (?,?,?,?)`, [
    runId,
    "agent_store_draft",
    `att_old_${runId}`,
    JSON.stringify({ status, reason: null, remaining: [], artifacts: [{ artifact_version_id: avId, sha256: blob.sha256 }] }),
  ]);
  return avId;
}

test("R-07 人工对账出口：执行中不可对账；逐项确认“已生效/未生效”→ reconciling → failed → runs.retry 重新排队，按检查点结算、不重跑 Agent", { timeout: 60_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "对账事项", stance: "受让方", consent_status: "not_required" });
  const db = tk.kernel.db;
  const runId = seedRun(matter.matter_id, "reconcile");
  seedDraftCheckpoint(matter.matter_id, runId);
  db.run(
    `INSERT INTO tool_operations (tool_operation_id, run_id, attempt_id, tool, operation, params_hash, status, idempotency_key, side_effect)
     VALUES (?,?,?,?,?,?,'unknown',?,?)`,
    [`top_${runId}`, runId, `att_old_${runId}`, "docx.render_report", "mcp_call", "x".repeat(64), "idem-unknown", "write_draft"],
  );
  // 检查点有效但仍有结果不明的调用 → 不结算（审查 R-07：旧实现会照常成功）
  const never = neverAgent();
  assert.equal(await runWorkflow(runId, never.agent), "reconciling");
  assert.equal(never.calls.started, 0);
  // 执行中不可对账（pending 可能是正在进行的合法调用）
  db.run(`UPDATE runs SET status = 'running' WHERE run_id = ?`, [runId]);
  await assert.rejects(tk.inv("runs.reconcile", { run_id: runId, tool_operation_id: `top_${runId}`, resolution: "applied" }), /执行中不能人工对账/);
  db.run(`UPDATE runs SET status = 'reconciling' WHERE run_id = ?`, [runId]);
  await assert.rejects(tk.inv("runs.retry", { run_id: runId, expected_version: 99 }), /须先人工对账/);
  const r = await tk.inv("runs.reconcile", { run_id: runId, tool_operation_id: `top_${runId}`, resolution: "applied" });
  assert.equal(r.remaining_unresolved, 0);
  assert.equal(r.run_status, "failed");
  const op = db.get<{ status: string }>(`SELECT status FROM tool_operations WHERE tool_operation_id = ?`, [`top_${runId}`])!;
  assert.equal(op.status, "succeeded", "已生效 → 重放时按幂等键返回、不再执行");
  await assert.rejects(tk.inv("runs.reconcile", { run_id: runId, tool_operation_id: `top_${runId}`, resolution: "applied" }), /无需对账/);
  const v = db.get<{ status_version: number }>(`SELECT status_version FROM runs WHERE run_id = ?`, [runId])!.status_version;
  await assert.rejects(tk.inv("runs.retry", { run_id: runId, expected_version: v - 1 }), /只有失败的任务可以重试/, "过期的 expected_version 被拒（乐观并发）");
  const retried = await tk.inv("runs.retry", { run_id: runId, expected_version: v });
  assert.equal(retried.status, "queued");
  // 内核队列接手：检查点有效、已无结果不明的调用 → 按检查点结算，不重新拉起 Agent
  const done = await waitRun(tk.inv, runId, 30_000);
  assert.equal(done.run.status, "succeeded");
  assert.ok(!done.events.some((e: any) => e.type === "agent.task_started"), "重试按检查点结算，不重跑 Agent");
});

test("R-07 本次尝试中出现结果不明的副作用调用：成果照常入库，但任务转 reconciling、不结算", { timeout: 60_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "尝试内对账", stance: "受让方", consent_status: "not_required" });
  const db = tk.kernel.db;
  const runId = seedRun(matter.matter_id, "inflight");
  const bytes = Buffer.from("草稿正文");
  let started = 0;
  const agent = {
    start: async (identity: { rid: string; aid: string }) => {
      started += 1;
      // 模拟本次尝试中一次副作用调用以“结果不明”收场（例如写入后连接中断）
      db.run(
        `INSERT INTO tool_operations (tool_operation_id, run_id, attempt_id, tool, operation, params_hash, status, idempotency_key, side_effect)
         VALUES (?,?,?,?,?,?,'unknown',?,?)`,
        [`top_${identity.rid}`, identity.rid, identity.aid, "docx.render_report", "mcp_call", "y".repeat(64), "idem-inflight", "write_draft"],
      );
      return "agt_inflight";
    },
    poll: async () => ({
      status: "succeeded" as const,
      events: [],
      next_cursor: 0,
      preview_text: "",
      error: null,
      reason: null,
      artifacts: [{ kind: "final_message", filename: "final_message.md", sha256: sha(bytes), bytes: new Uint8Array(bytes) }],
    }),
    cancel: async () => {},
  };
  assert.equal(await runWorkflow(runId, agent), "reconciling");
  assert.equal(started, 1);
  const ck = db.get<{ result_json: string }>(`SELECT result_json FROM step_checkpoints WHERE run_id = ? AND step_name = 'agent_store_draft'`, [runId]);
  assert.ok(ck, "成果与检查点已入库，对账后可按检查点结算");
  const charged = db.get<{ points_charged: number }>(`SELECT points_charged FROM runs WHERE run_id = ?`, [runId])!.points_charged;
  assert.equal(charged, 0, "对账前不结算");
});

test("R-04 检查点：恢复按检查点结算（partial 保持 partial 并列明剩余部分），检查点缺 outcome 或成果对不上 → 人工对账，不默认成功", { timeout: 60_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "checkpoint 事项", stance: "受让方", consent_status: "not_required" });
  const db = tk.kernel.db;
  // (a) 检查点缺 outcome（审查 R-04：旧实现默认 succeeded）
  const runA = seedRun(matter.matter_id, "ck_missing");
  db.run(`INSERT INTO step_checkpoints (run_id, step_name, attempt_id, result_json) VALUES (?,?,?,NULL)`, [runA, "agent_store_draft", `att_old_${runA}`]);
  const a = neverAgent();
  assert.equal(await runWorkflow(runA, a.agent), "reconciling");
  assert.equal(a.calls.started, 0);
  // (b) 检查点 outcome=partial 且成果行一致 → 按 partial 结算，不重跑
  const runB = seedRun(matter.matter_id, "ck_partial");
  const blob = tk.kernel.blobs.put(Buffer.from("部分回答"), matter.matter_id);
  const avId = `av_${runB}`;
  db.run(
    `INSERT INTO artifact_versions (artifact_version_id, tenant_id, matter_id, run_id, kind, version, audience, status, filename, sha256, storage_uri, open_items, manifest, created_by)
     VALUES (?,?,?,?,?,1,'internal','draft',?,?,?,'[]','{}',?)`,
    [avId, tk.kernel.identity.tenantId, matter.matter_id, runB, "a1_agent_draft_partial", "x.md", blob.sha256, blob.storage_uri, tk.kernel.identity.userId],
  );
  db.run(`INSERT INTO step_checkpoints (run_id, step_name, attempt_id, result_json) VALUES (?,?,?,?)`, [
    runB,
    "agent_store_draft",
    `att_old_${runB}`,
    JSON.stringify({ status: "partial", reason: "length_truncated", remaining: ["回答被截断"], artifacts: [{ artifact_version_id: avId, sha256: blob.sha256 }] }),
  ]);
  const b = neverAgent();
  assert.equal(await runWorkflow(runB, b.agent), "partial");
  assert.equal(b.calls.started, 0);
  const ev = db.get<{ payload: string }>(`SELECT payload FROM run_events WHERE run_id = ? AND type = 'run.partial'`, [runB])!;
  assert.deepEqual(JSON.parse(ev.payload).remaining, ["回答被截断"], "部分完成列明未完成部分（审查 R-20）");
  // (c) 成果 hash 对不上 → 对账
  const runC = seedRun(matter.matter_id, "ck_bad");
  db.run(`INSERT INTO step_checkpoints (run_id, step_name, attempt_id, result_json) VALUES (?,?,?,?)`, [
    runC,
    "agent_store_draft",
    `att_old_${runC}`,
    JSON.stringify({ status: "succeeded", reason: null, remaining: [], artifacts: [{ artifact_version_id: avId, sha256: "0".repeat(64) }] }),
  ]);
  assert.equal(await runWorkflow(runC, neverAgent().agent), "reconciling");
});

test("R-05 终态 CAS：API 先置 cancelled 后执行器再失败，不改写为 failed；恢复经 recovering 而非直接改回 queued", { timeout: 60_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "CAS 事项", stance: "受让方", consent_status: "not_required" });
  const db = tk.kernel.db;
  const runId = seedRun(matter.matter_id, "cas");
  const racing = {
    start: async () => {
      db.run(`UPDATE runs SET status = 'cancelled', status_version = status_version + 1 WHERE run_id = ?`, [runId]);
      throw new Error("宿主启动失败");
    },
    poll: async () => ({ status: "failed" as const, events: [], next_cursor: 0, preview_text: "", error: "x", reason: "x", artifacts: [] }),
    cancel: async () => {},
  };
  assert.equal(await runWorkflow(runId, racing), "cancelled", "已在终态的任务不被改写");
  const runR = `run_rec_${Date.now()}`;
  db.run(
    `INSERT INTO runs (run_id, tenant_id, matter_id, scenario, workflow_version, status, idempotency_key, created_by) VALUES (?,?,?,?,?,?,?,?)`,
    [runR, tk.kernel.identity.tenantId, matter.matter_id, "a1.agent_task", "v9-test", "running", `idem-${runR}`, tk.kernel.identity.userId],
  );
  const q = new TaskQueue(db, { concurrency: 1 });
  q.recover();
  await q.shutdown();
  assert.equal(db.get<{ status: string }>(`SELECT status FROM runs WHERE run_id = ?`, [runR])!.status, "recovering");
});

// ─── F4 出网（审查 R-14：运行时探针，而不是只扫源码） ───

test("F4/R-14 宿主出网面运行时探针：node:http 遵守代理落入黑洞（拉起时生效）；原生 net 直连仍可行——如实残余，须由闸门与 OS 出站规则强制", { timeout: 60_000 }, async () => {
  const server = createServer((_req, res) => res.end("direct-ok"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const probe = join(dir, "egress-probe.mjs");
  writeFileSync(
    probe,
    `import http from "node:http";
import net from "node:net";
const port = Number(process.argv[2]);
const httpResult = await new Promise((r) => {
  const req = http.get({ host: "127.0.0.1", port, path: "/" }, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => r("direct:" + d)); });
  req.on("error", (e) => r("blocked:" + (e.code ?? e.message)));
  req.setTimeout(3000, () => { req.destroy(); r("blocked:timeout"); });
});
const netResult = await new Promise((r) => {
  const s = net.connect(port, "127.0.0.1", () => { s.end(); r("connected"); });
  s.on("error", (e) => r("blocked:" + e.code));
});
process.stdout.write(JSON.stringify({ httpResult, netResult }));`,
  );
  // 与 kap 适配器拉起宿主时同一组环境变量（kap-agent-client.ts ensureHost）
  const env = { PATH: process.env.PATH ?? "", NODE_USE_ENV_PROXY: "1", HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9", NO_PROXY: "" };
  const child = spawn(process.execPath, [probe, String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  await new Promise((r) => child.on("exit", r));
  server.close();
  const r = JSON.parse(out) as { httpResult: string; netResult: string };
  assert.match(r.httpResult, /^blocked:/, `node:http 不得直连：${r.httpResult}`);
  assert.equal(r.netResult, "connected", "原生 net 直连在应用层挡不住——如实残余（第 04 篇 §5.1 第⑤级 OS 出站规则；阶段 4 闸门）");
  const client = readFileSync(join(ROOT, "packages", "kernel", "src", "executor", "kap-agent-client.ts"), "utf8");
  for (const k of ["NODE_USE_ENV_PROXY: \"1\"", "HTTP_PROXY: \"http://127.0.0.1:9\"", "HTTPS_PROXY: \"http://127.0.0.1:9\"", "ALL_PROXY: \"http://127.0.0.1:9\"", "NO_PROXY: \"\""]) assert.ok(client.includes(k), `kap 宿主环境含 ${k}`);
});

// ─── 阶段 1 复审（N-06、R-05、R-06、N-08、R-16） ───

test("R-05 reconciling 只能经人工对账迁出：执行器的终态迁移不改写它，取消也被拒绝", { timeout: 60_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "R-05 对账", stance: "受让方", consent_status: "not_required" });
  const db = tk.kernel.db;
  const runId = seedRun(matter.matter_id, "r05");
  // 执行中任务转入 reconciling 之后，执行器因别的异常走通用失败分支（markTerminal("failed")）——不得改写 reconciling
  const agent = {
    start: async () => "agt_r05",
    poll: async () => {
      db.run(`UPDATE runs SET status = 'reconciling', status_version = status_version + 1 WHERE run_id = ?`, [runId]);
      throw new Error("轮询异常");
    },
    cancel: async () => {},
  };
  await runWorkflow(runId, agent).catch(() => {});
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(db.get<{ status: string }>(`SELECT status FROM runs WHERE run_id = ?`, [runId])!.status, "reconciling");
  const v = tk.kernel.db.get<{ status_version: number }>(`SELECT status_version FROM runs WHERE run_id = ?`, [runId])!.status_version;
  await assert.rejects(tk.inv("runs.cancel", { run_id: runId, expected_version: v, reason: "x" }), /人工对账中/);
});

test("R-06 提交点检查纪元：尝试在 Agent 返回之前失去租约 → 不登记成果、不写检查点、不结算", { timeout: 60_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "R-06 提交点", stance: "受让方", consent_status: "not_required" });
  const db = tk.kernel.db;
  const runId = seedRun(matter.matter_id, "r06");
  const bytes = Buffer.from("失去租约后的成果");
  const agent = {
    start: async () => "agt_lost",
    poll: async (identity: { aid: string }) => {
      // 模拟恢复竞争：新尝试取代了本尝试（本尝试失去租约）
      db.run(`UPDATE attempts SET status = 'interrupted' WHERE attempt_id = ?`, [identity.aid]);
      return { status: "succeeded" as const, events: [], next_cursor: 0, preview_text: "", error: null, reason: null, artifacts: [{ kind: "final_message", filename: "final_message.md", sha256: sha(bytes), bytes: new Uint8Array(bytes) }] };
    },
    cancel: async () => {},
  };
  const status = await runWorkflow(runId, agent);
  assert.notEqual(status, "succeeded");
  // 复核 M-03：失去租约的执行者不改写任务（任务归持有租约的新尝试处理，这里没有新尝试，保持 running）
  assert.equal(status, "running");
  assert.equal(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM artifact_versions WHERE run_id = ?`, [runId])!.n, 0, "不登记成果");
  assert.equal(db.get(`SELECT 1 AS x FROM step_checkpoints WHERE run_id = ? AND step_name = 'agent_store_draft'`, [runId]), undefined, "不写检查点");
  assert.equal(db.get<{ points_charged: number }>(`SELECT points_charged FROM runs WHERE run_id = ?`, [runId])!.points_charged, 0, "不结算");
});

test("N-08 同内容成果跨任务去重（§6.1）：复用时本任务记 artifact.reused；恢复按同事项同 hash 核对，不误判为对不上", { timeout: 60_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "N-08", stance: "受让方", consent_status: "not_required" });
  const db = tk.kernel.db;
  const bytes = Buffer.from("两次产出的同一结论");
  const okAgent = {
    start: async () => "agt_same",
    poll: async () => ({ status: "succeeded" as const, events: [], next_cursor: 0, preview_text: "", error: null, reason: null, artifacts: [{ kind: "final_message", filename: "final_message.md", sha256: sha(bytes), bytes: new Uint8Array(bytes) }] }),
    cancel: async () => {},
  };
  const a = seedRun(matter.matter_id, "n08a");
  const b = seedRun(matter.matter_id, "n08b");
  assert.equal(await runWorkflow(a, okAgent), "succeeded");
  assert.equal(await runWorkflow(b, okAgent), "succeeded");
  const rowA = db.get<{ artifact_version_id: string }>(`SELECT artifact_version_id FROM artifact_versions WHERE run_id = ?`, [a])!;
  assert.equal(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM artifact_versions WHERE run_id = ?`, [b])!.n, 0, "同内容不产生重复版本");
  const reused = db.get<{ payload: string }>(`SELECT payload FROM run_events WHERE run_id = ? AND type = 'artifact.reused'`, [b]);
  assert.ok(reused, "任务 B 的事件里记录了复用关联");
  assert.equal(JSON.parse(reused!.payload).artifact_version_id, rowA.artifact_version_id);
  assert.equal(JSON.parse(reused!.payload).first_run_id, a);
  // 恢复：检查点指向别的任务登记的同内容成果行 → 按同事项同 hash 核对通过，按检查点结算（旧实现误判为对不上）
  const ck = db.get<{ result_json: string }>(`SELECT result_json FROM step_checkpoints WHERE run_id = ? AND step_name = 'agent_store_draft'`, [b])!;
  const c = seedRun(matter.matter_id, "n08c");
  db.run(`INSERT INTO step_checkpoints (run_id, step_name, attempt_id, result_json) VALUES (?,?,?,?)`, [c, "agent_store_draft", `att_old_${c}`, ck.result_json]);
  const never = neverAgent();
  assert.equal(await runWorkflow(c, never.agent), "succeeded");
  assert.equal(never.calls.started, 0, "按检查点结算，不重跑 Agent");
});

test("R-16 迁移器管理事务：外键违例在提交前回滚（迁移与登记都不生效）；每次启动都检查外键完整性", async () => {
  const { KernelDb } = await import("../src/db.ts");
  const { readdirSync, copyFileSync } = await import("node:fs");
  const base = mkdtempSync(join(tmpdir(), "kwl-r16-"));
  const migDir = join(base, "migrations");
  mkdirSync(migDir);
  const src = fileURLToPath(new URL("../src/migrations/", import.meta.url));
  for (const f of readdirSync(src).filter((x: string) => x.endsWith(".sql"))) copyFileSync(join(src, f), join(migDir, f));
  // 一个会制造外键违例的托管迁移
  writeFileSync(
    join(migDir, "9999_bad.sql"),
    "-- kwl:managed-transaction\nCREATE TABLE r16_probe (x text);\nINSERT INTO attempts (attempt_id, run_id, seq, status, fence_token) VALUES ('att_orphan', 'run_missing', 1, 'running', 1);\n",
  );
  const db1 = new KernelDb(join(base, "a.db"));
  assert.throws(() => db1.migrate(migDir), /外键违例，已回滚/);
  assert.equal(db1.get(`SELECT 1 AS x FROM schema_migrations WHERE name = '9999_bad.sql'`), undefined, "登记未生效");
  assert.equal(db1.get(`SELECT name FROM sqlite_master WHERE name = 'r16_probe'`), undefined, "迁移内容已回滚");
  assert.equal(db1.get(`SELECT 1 AS x FROM attempts WHERE attempt_id = 'att_orphan'`), undefined);
  db1.close();
  // 启动检查：既有数据库里出现违例（例如被外部改动）→ 拒绝启动
  const db2 = new KernelDb(join(base, "b.db"));
  const { rmSync } = await import("node:fs");
  rmSync(join(migDir, "9999_bad.sql"));
  db2.migrate(migDir);
  db2.db.pragma("foreign_keys = OFF");
  db2.run(`INSERT INTO attempts (attempt_id, run_id, seq, status, fence_token) VALUES ('att_orphan2', 'run_missing2', 1, 'running', 1)`);
  db2.db.pragma("foreign_keys = ON");
  assert.throws(() => db2.migrate(migDir), /外键检查发现 1 处违例，拒绝启动/);
  db2.close();
});

