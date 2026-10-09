/**
 * 出站闸门专项（方案 v5.0 第 4 篇 §8.3 与 §1.1 约束 2；探针 4 的 v0 版）：
 * - 「待取得」只用本机能力；「已拒绝」只能私有模型；「不使用模型」拦截；
 * - 未配置端点显式报不可用（不静默降级）；白名单按主机分列；
 * - 化名校验：未替换直接标识符零外发（block 策略拦截并记录）；mock 链路如实记 mock_local。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeKernel, runScenario, importText, DEMO_CONTRACT, type TestKernel } from "./helpers.ts";

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

test("闸门：保密等级 strict（v0 视为拒绝云端）→ 标准端点拦截", { timeout: 90_000 }, async () => {
  const { matter, doc } = await matterWith({ confidentiality: "strict", consent_status: "agreed", model_endpoint: "standard" });
  const { run, events } = await runScenario(tk.inv, matter.matter_id, "s1.contract_review", { document_version_ids: [doc.document_version_id] });
  assert.equal(run.status, "failed");
  assert.match(events.find((e: any) => e.type === "run.failed").payload.error, /strict|拒绝云端/);
});

test("闸门 + 化名：block 策略下未替换直接标识符被拦截并写入去向记录（真实 findings）", { timeout: 90_000 }, async () => {
  // 独立内核：强制 upstream 提供方（BYOK 端点默认 api.moonshot.cn 在白名单内；拦截先于发送，假密钥不会真正发出）。
  // 绕过点选择：材料片段经全流程化名已替换——本测试把标识符放进「立场」（进入系统提示、不经全流程化名），验证闸门兜底。
  const tk2 = await makeKernel({ ZR_MODEL_PROVIDER: "upstream", ZR_BYOK_API_KEY: "fake-key-for-block-test" }, "egress-byok-firm");
  try {
    const { matter } = await tk2.inv("matters.create", {
      title: "化名拦截",
      stance: "受让方（联系 13800138000）",
      model_endpoint: "byok",
      consent_status: "not_required",
      key_dates: { analysis_as_of: "2026-10-01" },
    });
    const doc = await importText(tk2.inv, matter.matter_id, "协议.txt", DEMO_CONTRACT);
    const { run, events } = await runScenario(tk2.inv, matter.matter_id, "s1.contract_review", {
      document_version_ids: [doc.document_version_id],
      topic_hint: "保密义务",
    });
    assert.equal(run.status, "failed", "未化名内容不得外发");
    const failed = events.find((e: any) => e.type === "run.failed");
    assert.match(failed.payload.error, /化名校验拦截|直接标识符/, failed.payload.error);
    const eg = await tk2.inv("egress.records", { run_id: run.run_id });
    assert.equal(eg.records.length, 1, "拦截也写入去向记录");
    assert.equal(eg.records[0].destination_kind, "byok_model");
    assert.equal(eg.records[0].outcome, "blocked");
    assert.equal(eg.records[0].pseudonym_findings, 1, "记录真实 findings（不写 0）");
    assert.match(eg.records[0].note, /已拦截/);
  } finally {
    await tk2.kernel.close();
  }
});

test("闸门：策略变更即时生效——「待取得」改为「无需」后模型步骤放行（mock 链路）", { timeout: 150_000 }, async () => {
  const { matter, doc } = await matterWith({ consent_status: "pending", model_endpoint: "standard" });
  const first = await runScenario(tk.inv, matter.matter_id, "s1.contract_review", { document_version_ids: [doc.document_version_id] });
  assert.equal(first.run.status, "failed");
  await tk.inv("matters.update", { matter_id: matter.matter_id, patch: { consent_status: "not_required" } });
  const second = await runScenario(tk.inv, matter.matter_id, "s1.contract_review", { document_version_ids: [doc.document_version_id] });
  assert.equal(second.run.status, "succeeded");
});

test("闸门 replace 策略：补替换真实生效——上游收到遮盖值而非明文（独立复核阻断-1 回归）", { timeout: 90_000 }, async () => {
  // 回环假上游捕获请求体
  const { createServer } = await import("node:http");
  let captured = "";
  const fake = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      captured = Buffer.concat(chunks).toString("utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "fake_up_1",
        object: "chat.completion",
        created: 0,
        model: "kimi-k3",
        choices: [{ index: 0, message: { role: "assistant", content: "（假上游回包）" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
  const port = (fake.address() as any).port;
  const tk3 = await makeKernel(
    { ZR_MODEL_PROVIDER: "upstream", ZR_BYOK_BASE: `http://127.0.0.1:${port}`, ZR_BYOK_API_KEY: "fake-key", ZR_PSEUDONYM_POLICY: "replace" },
    "egress-replace-firm",
  );
  try {
    const { matter } = await tk3.inv("matters.create", { title: "replace 策略", stance: "受让方", model_endpoint: "byok", consent_status: "not_required", key_dates: { analysis_as_of: "2026-10-01" } });
    const doc = await importText(tk3.inv, matter.matter_id, "协议.txt", DEMO_CONTRACT);
    const { run } = await runScenario(tk3.inv, matter.matter_id, "s1.contract_review", { document_version_ids: [doc.document_version_id], topic_hint: "保密义务" });
    assert.equal(run.status, "succeeded");
    assert.ok(captured.length > 0, "假上游应收到请求");
    assert.ok(!captured.includes("13800138000"), "上游不得收到明文手机号");
    assert.ok(captured.includes("138****8000"), "上游应收到遮盖值");
    const eg = await tk3.inv("egress.records", { run_id: run.run_id });
    assert.equal(eg.records[0].outcome, "sent");
  } finally {
    await tk3.kernel.close();
    fake.close();
  }
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
  // 未取消的任务令牌不受影响（鉴权通过，业务报错而非 401）
  const okToken = mintTaskToken({ tid: matter.tenant_id, uid: matter.created_by, mid: matter.matter_id, rid: "run_other", scope: ["tool:legal"] }, 600);
  const mcp2 = await fetch(`http://127.0.0.1:${kernel.localPort}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${okToken}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(mcp2.status, 200);
});

test("mock 链路去向记录：如实携带全流程化名统计（不谎报「无未替换标识符」）", { timeout: 90_000 }, async () => {
  const { inv } = tk;
  const { matter } = await inv("matters.create", { title: "mock 如实", stance: "受让方", consent_status: "not_required", key_dates: { analysis_as_of: "2026-10-01" } });
  const doc = await importText(inv, matter.matter_id, "协议.txt", DEMO_CONTRACT);
  const { run } = await runScenario(inv, matter.matter_id, "s1.contract_review", { document_version_ids: [doc.document_version_id], topic_hint: "保密义务" });
  assert.equal(run.status, "succeeded");
  const eg = await inv("egress.records", { run_id: run.run_id });
  assert.equal(eg.records.length, 1);
  assert.equal(eg.records[0].destination_kind, "mock_local");
  assert.match(eg.records[0].note, /全流程化名：发送前已按规则替换 1 处直接标识符/, eg.records[0].note);
  assert.equal(eg.records[0].outcome, "mock");
});
