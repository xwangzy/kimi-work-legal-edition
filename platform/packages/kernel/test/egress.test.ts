/**
 * 事项出站策略（方案 v5.0 第 4 篇 §8.3；v9 第 02 篇 §8.1–§8.2）：
 * - 「待取得」只用本机能力；「已拒绝」只能私有模型；「不使用模型」拦截；当事人限制（L3b）只允许私有端点；策略变更即时生效；
 * - mock 链路如实记 mock_local（含令牌化统计）；急停撤销即刻生效。
 * 真实链路（经出站闸门进程：令牌化、端点、去向记录、用量）的用例在 gate.test.ts。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeKernel, runScenario, importText, DEMO_CONTRACT, type TestKernel } from "./helpers.ts";
import { liveTaskIdentity } from "./helpers.ts";

let tk: TestKernel;

before(async () => {
  tk = await makeKernel({}, "egress-firm");
});

after(async () => {
  await tk.kernel.close();
});

async function matterWith(patch: Record<string, unknown>): Promise<any> {
  const { matter } = await tk.inv("matters.create", { title: `闸门-${JSON.stringify(patch)}`, stance: "受让方", key_dates: { analysis_as_of: "2026-10-01" }, ...patch });
  const doc = await importText(tk.inv, matter.matter_id, "协议.txt", DEMO_CONTRACT);
  return { matter, doc };
}

test("闸门：当事人同意「待取得」→ 模型步骤被拦截（只用本机能力），事件说人话", { timeout: 90_000 }, async () => {
  const { matter, doc } = await matterWith({ consent_status: "pending", model_endpoint: "standard" });
  const { run, events } = await runScenario(tk.inv, matter.matter_id, "s1.contract_review", {
    document_version_ids: [doc.document_version_id],
    topic_hint: "保密义务",
  });
  assert.equal(run.status, "failed", "待取得状态下模型步骤不得外发");
  const failed = events.find((e: any) => e.type === "run.failed");
  assert.match(failed.payload.error, /待取得/, failed.payload.error);
  // 但本机步骤已完成：引用核验（离线）照常
  assert.ok(events.some((e: any) => e.type === "citations.verified"), "本机引用核验不受同意状态影响");
});

test("闸门：当事人「已拒绝」+ 标准端点 → 拦截（只能私有模型或不使用模型）", { timeout: 90_000 }, async () => {
  const { matter, doc } = await matterWith({ consent_status: "refused", model_endpoint: "standard" });
  const { run, events } = await runScenario(tk.inv, matter.matter_id, "s1.contract_review", { document_version_ids: [doc.document_version_id] });
  assert.equal(run.status, "failed");
  assert.match(events.find((e: any) => e.type === "run.failed").payload.error, /已拒绝|私有模型/);
});

test("闸门：「不使用模型」事项 → 模型步骤拦截；S1b/S6/S2 本机场景不受影响", { timeout: 120_000 }, async () => {
  const { matter, doc } = await matterWith({ model_endpoint: "none", consent_status: "not_required" });
  const { run, events } = await runScenario(tk.inv, matter.matter_id, "s1.contract_review", { document_version_ids: [doc.document_version_id] });
  assert.equal(run.status, "failed");
  assert.match(events.find((e: any) => e.type === "run.failed").payload.error, /不使用模型/);
  // 本机脱敏照常（不调用模型）
  const s6 = await runScenario(tk.inv, matter.matter_id, "s6.redaction", { document_version_ids: [doc.document_version_id] });
  assert.equal(s6.run.status, "succeeded");
});

test("闸门：当事人限制（L3b，保密等级 strict）→ 标准端点拦截", { timeout: 90_000 }, async () => {
  const { matter, doc } = await matterWith({ confidentiality: "strict", consent_status: "agreed", model_endpoint: "standard" });
  const { run, events } = await runScenario(tk.inv, matter.matter_id, "s1.contract_review", { document_version_ids: [doc.document_version_id] });
  assert.equal(run.status, "failed");
  assert.match(events.find((e: any) => e.type === "run.failed").payload.error, /当事人限制（L3b）.*私有模型端点/);
});

test("闸门：策略变更即时生效——「待取得」改为「无需」后模型步骤放行（mock 链路）", { timeout: 150_000 }, async () => {
  const { matter, doc } = await matterWith({ consent_status: "pending", model_endpoint: "standard" });
  const first = await runScenario(tk.inv, matter.matter_id, "s1.contract_review", { document_version_ids: [doc.document_version_id] });
  assert.equal(first.run.status, "failed");
  await tk.inv("matters.update", { matter_id: matter.matter_id, patch: { consent_status: "not_required" } });
  const second = await runScenario(tk.inv, matter.matter_id, "s1.contract_review", { document_version_ids: [doc.document_version_id] });
  assert.equal(second.run.status, "succeeded");
});

test("急停撤销：取消任务后，绑定该任务的任务令牌即刻被端点拒绝（§15.2/§6.1）", { timeout: 60_000 }, async () => {
  const { inv, kernel } = tk;
  const { matter } = await inv("matters.create", { title: "撤销测试", stance: "受让方", consent_status: "not_required" });
  // 手工插入 queued 任务并取消
  const runId = "run_revoke_test";
  kernel.db.run(
    `INSERT INTO runs (run_id, tenant_id, matter_id, scenario, workflow_version, status, idempotency_key, created_by)
     VALUES (?,?,?,?,'v5.0.0-g0','queued',?,?)`,
    [runId, matter.tenant_id, matter.matter_id, "s1.contract_review", `revoke-${Date.now()}`, matter.created_by],
  );
  await inv("runs.cancel", { run_id: runId, expected_version: 1, reason: "撤销测试" });
  const { mintTaskToken } = await import("../src/identity.ts");
  const token = mintTaskToken({ tid: matter.tenant_id, uid: matter.created_by, mid: matter.matter_id, rid: runId, scope: ["model:chat", "tool:legal"] }, 600);
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
  const chat = await fetch(`http://127.0.0.1:${kernel.localPort}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "legal/k3", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(chat.status, 401, "已取消任务的令牌应被模型端点拒绝");
  const mcp = await fetch(`http://127.0.0.1:${kernel.localPort}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(mcp.status, 401, "已取消任务的令牌应被工具端点拒绝");
  // 未取消、尝试仍在执行的任务令牌不受影响（鉴权通过）；凭空编造的 rid/aid 一律 401（attempt_unknown）
  const live = liveTaskIdentity(tk, matter.matter_id, "egress_ok");
  const okToken = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, scope: ["tool:legal"] }, 600);
  const mcp2 = await fetch(`http://127.0.0.1:${kernel.localPort}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${okToken}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(mcp2.status, 200);
});

test("mock 链路去向记录：如实携带令牌化统计（不谎报「无未替换标识符」）", { timeout: 90_000 }, async () => {
  const { inv } = tk;
  const { matter } = await inv("matters.create", { title: "mock 如实", stance: "受让方", consent_status: "not_required", key_dates: { analysis_as_of: "2026-10-01" } });
  const doc = await importText(inv, matter.matter_id, "协议.txt", DEMO_CONTRACT);
  const { run } = await runScenario(inv, matter.matter_id, "s1.contract_review", { document_version_ids: [doc.document_version_id], topic_hint: "保密义务" });
  assert.equal(run.status, "succeeded");
  const eg = await inv("egress.records", { run_id: run.run_id });
  assert.equal(eg.records.length, 1);
  assert.equal(eg.records[0].destination_kind, "mock_local");
  assert.match(eg.records[0].note, /令牌化：发送前已替换 \d+ 处（[^）]*phone×1/, eg.records[0].note);
  assert.equal(eg.records[0].outcome, "mock");
});
