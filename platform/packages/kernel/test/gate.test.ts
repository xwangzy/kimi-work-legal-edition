/**
 * 出站闸门（v9 第 04 篇 §1.2 第 3 条“唯一出口”、§5.1；第 02 篇 §8.2–§8.4；探针 P5/P6/P7 的本机部分）：
 * 内核确定性工作流的模型调用经出站闸门进程——
 * - 标准端点：闸门 → 法律模型网关 v0（席位令牌、匿名事项编号）→ 上游（mock）；上游只见代号（自然人姓名、电话），机构名称保留；
 * - 去向记录写入事项账本（目的地类别、出站代号数），用量按闸门请求 ID 入账且只一条；代号表在本机，界面还原；
 * - 自带密钥端点：闸门直连，模型别名映射到上游模型 ID，不带任何 x-kwl 头；
 * - 闸门进程起不来：模型步骤失败（不直连）；撤销任务：闸门中止该任务的在途上游请求。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { makeKernel, runScenario, importText, waitRun, type TestKernel } from "./helpers.ts";
import { startCloudV0, type CloudV0 } from "./cloud-v0.ts";

const CONTRACT = [
  "借款合同（示例）",
  "出借人：孙悦，手机 13800138000，身份证号 11010519491231002X。",
  "借款人：甲科技有限公司。",
  "第三条 借款金额人民币伍万元，年利率 6%。",
].join("\n");

let cloud: CloudV0;
let tk: TestKernel;

before(async () => {
  cloud = await startCloudV0({ tenant: "ten_gate-firm" });
  tk = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream" }, "gate-firm");
});

after(async () => {
  await tk.kernel.close();
  await cloud.close();
});

test("标准端点经出站闸门到法律模型网关：上游只见代号（姓名、电话、证件号），机构名称保留；去向记录 legal_gateway；用量只一条；代号可在界面还原", { timeout: 120_000 }, async () => {
  const { matter } = await tk.inv("matters.create", {
    title: "借款纠纷",
    stance: "出借人",
    client_name: "孙悦",
    counterparty: "甲科技有限公司",
    consent_status: "agreed",
    model_endpoint: "standard",
    key_dates: { analysis_as_of: "2026-10-01" },
  });
  const doc = await importText(tk.inv, matter.matter_id, "借款合同.txt", CONTRACT);
  const before = cloud.model.seen.length;
  const { run, events } = await runScenario(tk.inv, matter.matter_id, "s1.contract_review", { document_version_ids: [doc.document_version_id] });
  assert.equal(run.status, "succeeded", JSON.stringify(events.find((e: any) => e.type === "run.failed")?.payload ?? {}));
  assert.ok(cloud.model.seen.length > before, "请求经闸门与网关到达上游");
  const sent = JSON.stringify(cloud.model.seen.at(-1));
  for (const secret of ["孙悦", "13800138000", "11010519491231002X"]) assert.ok(!sent.includes(secret), `上游不得收到 ${secret}`);
  assert.ok(sent.includes("甲科技有限公司"), "机构名称默认保留");
  assert.match(sent, /〔自然人·[0-9A-Z]{6}〕/);
  assert.match(sent, /〔电话·[0-9A-Z]{6}〕/);
  // 去向记录（事项账本）
  const eg = await tk.inv("egress.records", { run_id: run.run_id });
  const rec = eg.records.find((r: any) => r.destination_kind === "legal_gateway");
  assert.ok(rec, JSON.stringify(eg.records));
  assert.equal(rec.outcome, "sent");
  assert.ok(rec.pseudonym_findings >= 3, `出站代号数如实：${rec.pseudonym_findings}`);
  assert.match(rec.request_id, /^kwlg_/);
  // 用量：按闸门请求 ID 入账，broker 与闸门回送去重为一条
  const usage = tk.kernel.db.all<{ request_id: string }>(`SELECT request_id FROM usage_records WHERE run_id = ?`, [run.run_id]);
  assert.equal(usage.length, 1, JSON.stringify(usage));
  assert.equal(usage[0]!.request_id, rec.request_id);
  // 网关计量只有元数据（匿名事项编号、席位、token），没有正文
  const settle = cloud.gatewayMeter.filter((m) => m.kind === "settle").at(-1)!;
  assert.ok(settle.anonMatter && settle.anonMatter !== matter.matter_id, "网关只见匿名事项编号");
  assert.ok(!JSON.stringify(cloud.gatewayMeter).includes("孙悦"));
  // 代号表在本机：界面还原
  const tok = tk.kernel.db.get<{ token: string }>(`SELECT token FROM matter_tokens WHERE matter_id = ? AND value = '孙悦'`, [matter.matter_id])!;
  assert.ok(tok, "自然人姓名进入事项令牌表");
  const restored = await tk.inv("matters.tokens.restore", { matter_id: matter.matter_id, text: `${tok.token}的借款` });
  assert.equal(restored.text, "孙悦的借款");
  // 同一事项再跑一次：同一姓名同一代号（跨轮稳定）
  const second = await runScenario(tk.inv, matter.matter_id, "s1.contract_review", { document_version_ids: [doc.document_version_id] });
  assert.equal(second.run.status, "succeeded");
  assert.ok(JSON.stringify(cloud.model.seen.at(-1)).includes(tok.token), "代号跨轮稳定");
});

test("当事人词典：事项头之外的证人加入词典后同样令牌化；L3a（高敏）在管理员未放开时经标准端点被拒绝", { timeout: 120_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "证人", stance: "原告", consent_status: "agreed", model_endpoint: "standard", key_dates: { analysis_as_of: "2026-10-01" } });
  await tk.inv("matters.parties.upsert", { matter_id: matter.matter_id, name: "欧阳娜娜", kind: "person", aliases: ["娜娜"] });
  const doc = await importText(tk.inv, matter.matter_id, "证言.txt", "证人欧阳娜娜陈述：当日娜娜在场。");
  const r = await runScenario(tk.inv, matter.matter_id, "s1.contract_review", { document_version_ids: [doc.document_version_id] });
  assert.equal(r.run.status, "succeeded");
  const sent = JSON.stringify(cloud.model.seen.at(-1));
  assert.ok(!sent.includes("欧阳娜娜") && !sent.includes("娜娜在场"), sent.slice(0, 400));
  const parties = await tk.inv("matters.parties.list", { matter_id: matter.matter_id });
  assert.ok(parties.parties.some((p: any) => p.name === "欧阳娜娜" && p.source === "dictionary"));
  // L3a：闸门要求全部化名（自动强制）+ 管理员放开；未放开即拒绝
  const { matter: hi } = await tk.inv("matters.create", { title: "高敏", stance: "辩护人", confidentiality: "high", consent_status: "agreed", model_endpoint: "standard", key_dates: { analysis_as_of: "2026-10-01" } });
  const doc2 = await importText(tk.inv, hi.matter_id, "卷宗.txt", "第一条 示例。");
  const n = cloud.model.seen.length;
  const r2 = await runScenario(tk.inv, hi.matter_id, "s1.contract_review", { document_version_ids: [doc2.document_version_id] });
  assert.equal(r2.run.status, "failed");
  assert.match(JSON.stringify(r2.events.find((e: any) => e.type === "run.failed")?.payload ?? {}), /管理员放开|l3a_standard_not_enabled/);
  assert.equal(cloud.model.seen.length, n, "被拒绝的请求没有到达上游");
  const eg = await tk.inv("egress.records", { run_id: r2.run.run_id });
  assert.ok(eg.records.some((x: any) => x.destination_kind === "gate_blocked" && x.outcome === "blocked"));
});

async function fakeUpstream(handler: (req: IncomingMessage, body: string, res: import("node:http").ServerResponse) => void): Promise<{ server: Server; url: string; seen: { headers: IncomingMessage["headers"]; body: any }[]; closed: number }> {
  const seen: { headers: IncomingMessage["headers"]; body: any }[] = [];
  const state = { closed: 0 };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ headers: req.headers, body: JSON.parse(body || "{}") });
      res.on("close", () => {
        if (!res.writableEnded) state.closed += 1;
      });
      handler(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    server,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    get closed() {
      return state.closed;
    },
  };
}

const OK_JSON = JSON.stringify({ id: "up_1", object: "chat.completion", model: "kimi-k3", choices: [{ index: 0, message: { role: "assistant", content: "（假上游）审查完成。" }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 4 } });

test("自带密钥端点经闸门直连：模型别名映射到上游 ID、不带 x-kwl 头、凭据只在闸门；上游只见代号；去向记录 byok_model", { timeout: 120_000 }, async () => {
  const up = await fakeUpstream((_r, _b, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(OK_JSON);
  });
  const k = await makeKernel({ ZR_MODEL_PROVIDER: "upstream", ZR_BYOK_BASE: up.url, ZR_BYOK_API_KEY: "byok-fake-key" }, "gate-byok-firm");
  try {
    const { matter } = await k.inv("matters.create", { title: "自带密钥", stance: "受让方（联系 13800138000）", model_endpoint: "byok", consent_status: "not_required", key_dates: { analysis_as_of: "2026-10-01" } });
    const doc = await importText(k.inv, matter.matter_id, "协议.txt", CONTRACT);
    const { run } = await runScenario(k.inv, matter.matter_id, "s1.contract_review", { document_version_ids: [doc.document_version_id] });
    assert.equal(run.status, "succeeded");
    const last = up.seen.at(-1)!;
    assert.equal(last.body.model, "kimi-k3", "别名映射到上游模型 ID");
    assert.equal(last.headers.authorization, "Bearer byok-fake-key");
    assert.equal(last.headers["x-kwl-anon-matter"], undefined, "直连端点不带 x-kwl 头");
    const sent = JSON.stringify(last.body);
    assert.ok(!sent.includes("13800138000") && !sent.includes("孙悦"), "立场（系统提示）与材料都已令牌化");
    const eg = await k.inv("egress.records", { run_id: run.run_id });
    assert.ok(eg.records.some((r: any) => r.destination_kind === "byok_model" && r.outcome === "sent"));
  } finally {
    await k.kernel.close();
    up.server.close();
  }
});

test("闸门进程起不来：模型步骤失败（说明“不会改为直连”），上游零请求", { timeout: 120_000 }, async () => {
  const up = await fakeUpstream((_r, _b, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(OK_JSON);
  });
  const k = await makeKernel({ ZR_MODEL_PROVIDER: "upstream", ZR_BYOK_BASE: up.url, ZR_BYOK_API_KEY: "k", ZR_EGRESS_GATE_ENTRY: "/nonexistent/kwl-egress-gate/main.ts" }, "gate-down-firm");
  try {
    const { matter } = await k.inv("matters.create", { title: "闸门不可用", stance: "受让方", model_endpoint: "byok", consent_status: "not_required", key_dates: { analysis_as_of: "2026-10-01" } });
    const doc = await importText(k.inv, matter.matter_id, "协议.txt", CONTRACT);
    const { run, events } = await runScenario(k.inv, matter.matter_id, "s1.contract_review", { document_version_ids: [doc.document_version_id] });
    assert.equal(run.status, "failed");
    assert.match(JSON.stringify(events.find((e: any) => e.type === "run.failed")?.payload ?? {}), /出站闸门不可用|不会改为直连/);
    assert.equal(up.seen.length, 0);
  } finally {
    await k.kernel.close();
    up.server.close();
  }
});

test("撤销任务：闸门立即中止该任务的在途上游请求（复审 N-01 的闸门侧）", { timeout: 120_000 }, async () => {
  let release: () => void = () => {};
  const up = await fakeUpstream((_r, _b, res) => {
    // 迟迟不回：直到被中止
    const t = setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(OK_JSON);
    }, 30_000);
    release = () => clearTimeout(t);
    res.on("close", () => clearTimeout(t));
  });
  const k = await makeKernel({ ZR_MODEL_PROVIDER: "upstream", ZR_BYOK_BASE: up.url, ZR_BYOK_API_KEY: "k" }, "gate-revoke-firm");
  try {
    const { matter } = await k.inv("matters.create", { title: "撤销", stance: "受让方", model_endpoint: "byok", consent_status: "not_required", key_dates: { analysis_as_of: "2026-10-01" } });
    const doc = await importText(k.inv, matter.matter_id, "协议.txt", CONTRACT);
    const est = await k.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "s1.contract_review", document_version_ids: [doc.document_version_id] });
    const r = await k.inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `rv-${Date.now()}` });
    const deadline = Date.now() + 30_000;
    while (up.seen.length === 0 && Date.now() < deadline) await new Promise((x) => setTimeout(x, 50));
    assert.equal(up.seen.length, 1, "请求已在途");
    const cur = await k.inv("runs.get", { run_id: r.run_id });
    const t0 = Date.now();
    await k.inv("runs.cancel", { run_id: r.run_id, expected_version: cur.run.status_version, reason: "测试撤销" });
    while (up.closed === 0 && Date.now() - t0 < 5_000) await new Promise((x) => setTimeout(x, 25));
    assert.equal(up.closed, 1, "在途上游请求被中止");
    assert.ok(Date.now() - t0 < 3_000, `中止应在秒级内：${Date.now() - t0} ms`);
    const done = await waitRun(k.inv, r.run_id, 30_000);
    assert.equal(done.run.status, "cancelled");
  } finally {
    release();
    await k.kernel.close();
    up.server.close();
  }
});

test("S4-01 整链：宿主在模型流式返回途中断开（本机端点 → 模型代理 → 出站闸门 → 上游），上游请求被中止，去向记录补全为中止", { timeout: 120_000 }, async () => {
  const { liveTaskIdentity } = await import("./helpers.ts");
  const { mintTaskToken } = await import("../src/identity.ts");
  const { request } = await import("node:http");
  const up = await fakeUpstream((_r, _b, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    let i = 0;
    const t = setInterval(() => {
      if (res.destroyed) return clearInterval(t);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `片段${i++}` }, finish_reason: null }] })}\n\n`);
    }, 50);
    res.on("close", () => clearInterval(t));
  });
  const k = await makeKernel({ ZR_MODEL_PROVIDER: "upstream", ZR_BYOK_BASE: up.url, ZR_BYOK_API_KEY: "k" }, "gate-hangup-firm");
  try {
    const { matter } = await k.inv("matters.create", { title: "断开", stance: "受让方", model_endpoint: "byok", consent_status: "not_required" });
    const live = liveTaskIdentity(k, matter.matter_id, "hangup");
    const token = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, scope: ["model:chat"] }, 600);
    await new Promise<void>((resolve, reject) => {
      const data = JSON.stringify({ model: "legal/k3", stream: true, messages: [{ role: "user", content: "请逐段输出" }] });
      const req = request(
        { host: "127.0.0.1", port: k.kernel.localPort, path: "/v1/chat/completions", method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "content-length": Buffer.byteLength(data) } },
        (res) => {
          res.once("data", () => {
            req.destroy();
            resolve();
          });
        },
      );
      req.on("error", () => {});
      req.end(data);
      setTimeout(() => reject(new Error("no first chunk")), 20_000);
    });
    const t0 = Date.now();
    while (up.closed === 0 && Date.now() - t0 < 5_000) await new Promise((x) => setTimeout(x, 25));
    assert.equal(up.closed, 1, "上游请求被中止");
    assert.ok(Date.now() - t0 < 3_000, `中止应在秒级：${Date.now() - t0} ms`);
    let rec: any = null;
    for (let i = 0; i < 80 && !(rec && rec.outcome === "failed"); i++) {
      rec = k.kernel.db.get(`SELECT * FROM egress_records WHERE run_id = ? AND destination_kind = 'byok_model'`, [live.rid]);
      await new Promise((x) => setTimeout(x, 25));
    }
    assert.ok(rec, "转发前已预写去向记录");
    assert.equal(rec.outcome, "failed");
    assert.match(String(rec.note), /aborted|stream_interrupted/);
  } finally {
    await k.kernel.close();
    up.server.close();
  }
});

test("S4-11 闸门运行时摘要：给出 KWL_GATE_NODE_SHA256 且不符即不拉起闸门（模型步骤失败、不直连）；相符照常", { timeout: 120_000 }, async () => {
  const { createHash } = await import("node:crypto");
  const { readFileSync } = await import("node:fs");
  const good = createHash("sha256").update(readFileSync(process.execPath)).digest("hex");
  const up = await fakeUpstream((_r, _b, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(OK_JSON);
  });
  for (const [digest, expectOk] of [["0".repeat(64), false], [good, true]] as const) {
    const k = await makeKernel({ ZR_MODEL_PROVIDER: "upstream", ZR_BYOK_BASE: up.url, ZR_BYOK_API_KEY: "k", KWL_GATE_NODE: process.execPath, KWL_GATE_NODE_SHA256: digest }, `gate-digest-${expectOk ? "ok" : "bad"}`);
    try {
      const { matter } = await k.inv("matters.create", { title: "摘要", stance: "受让方", model_endpoint: "byok", consent_status: "not_required", key_dates: { analysis_as_of: "2026-10-01" } });
      const doc = await importText(k.inv, matter.matter_id, "协议.txt", CONTRACT);
      const { run, events } = await runScenario(k.inv, matter.matter_id, "s1.contract_review", { document_version_ids: [doc.document_version_id] });
      if (expectOk) assert.equal(run.status, "succeeded");
      else {
        assert.equal(run.status, "failed");
        assert.match(JSON.stringify(events.find((e: any) => e.type === "run.failed")?.payload ?? {}), /摘要不符|出站闸门不可用/);
      }
    } finally {
      await k.kernel.close();
    }
  }
  up.server.close();
});
