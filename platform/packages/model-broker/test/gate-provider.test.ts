/**
 * 闸门 provider（v9 第 04 篇 §1.2 第 3 条：内核不直连上游，一律经出站闸门进程的本机套接字）：
 * - 请求发往 `/m/<事项>/v1/chat/completions`，带本任务的闸门令牌；`model` 为路由别名；
 * - 非流式响应缺失 finish_reason 时如实为 null（复审 N-07）；中止信号贯通（复审 N-01）；
 * - 闸门拒绝按“出站被拦截”报告；闸门不可用按“模型通道不可用”（排队，不改为直连）；
 * - 请求 ID 取闸门的 x-kwl-gate-request-id（与闸门回送的用量去重）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateProvider } from "../src/providers/gate.ts";
import type { RouteDef } from "../src/config.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "kwl-gp-")));
const socket = join(dir, "gate.sock");
let hits = 0;
const seen: { path: string; auth: string; body: any }[] = [];
let mode: "ok" | "deny" | "busy" = "ok";
const srv: Server = createServer((req, res) => {
  hits += 1;
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = JSON.parse(body);
    seen.push({ path: req.url ?? "", auth: String(req.headers.authorization ?? ""), body: j });
    if (mode === "deny") {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "kwl_gate_denied", code: "l3b_no_standard_endpoint", message: "当事人限制事项禁止经标准端点推理" } }));
      return;
    }
    if (mode === "busy") {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "kwl_gate_denied", code: "model_upstream_unavailable", message: "模型通道未配置" } }));
      return;
    }
    if (j.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "x-kwl-gate-request-id": "kwlg_stream_1" });
      let i = 0;
      const t = setInterval(() => {
        if (res.destroyed) return clearInterval(t);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `片段${i++}` }, finish_reason: null }] })}\n\n`);
      }, 30);
      res.on("close", () => clearInterval(t));
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "x-kwl-gate-request-id": "kwlg_req_1" });
    // 上游漏报 finish_reason
    res.end(JSON.stringify({ id: "x", choices: [{ index: 0, message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 3, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 2 } } }));
  });
});
await new Promise<void>((r) => srv.listen(socket, () => r()));
after(() => {
  srv.closeAllConnections();
  srv.close();
});

let gateUp = true;
const provider = createGateProvider({
  socket: async () => {
    if (!gateUp) throw new Error("闸门进程退出");
    return socket;
  },
  token: (t) => `gate-token-${t.rid}`,
});
const route: RouteDef = { alias: "legal/k3", provider: "upstream", providerModel: "kimi-k3", supportsEffort: false, defaultEffort: null, allowedEfforts: [], temperature: 1, priceKey: "k3" };
const task = { tid: "t1", uid: "u1", mid: "m_1", rid: "r1", aid: "a1" };

test("经闸门：路径带事项、令牌按任务签发、model 为路由别名；请求 ID 取闸门的；N-07 缺失 finish_reason 如实为 null；用量含缓存命中", async () => {
  mode = "ok";
  const r = await provider.chat(route, { model: "legal/k3", messages: [{ role: "user", content: "hi" }] }, { nonce: "n", clientIdempotencyId: "i", task });
  assert.equal(r.finishReason, null);
  assert.equal(r.requestId, "kwlg_req_1");
  assert.equal(r.usage.cached_input, 2);
  assert.equal(r.usage.uncached_input, 1);
  const s = seen.at(-1)!;
  assert.equal(s.path, "/m/m_1/v1/chat/completions");
  assert.equal(s.auth, "Bearer gate-token-r1");
  assert.equal(s.body.model, "legal/k3");
  // 调用方已持有令牌（本机端点转发宿主请求）：原样交给闸门再验
  await provider.chat(route, { model: "legal/k3", messages: [] }, { nonce: "n", clientIdempotencyId: "i", task, bearer: "host-run-token" });
  assert.equal(seen.at(-1)!.auth, "Bearer host-run-token");
});

test("闸门拒绝 → egress_blocked；闸门 503 → provider_unavailable；闸门进程不可用 → provider_unavailable（不改为直连）", async () => {
  mode = "deny";
  await assert.rejects(provider.chat(route, { model: "legal/k3", messages: [] }, { nonce: "n", clientIdempotencyId: "i", task }), (e: any) => e.code === "egress_blocked" && /当事人限制/.test(e.message));
  mode = "busy";
  await assert.rejects(provider.chat(route, { model: "legal/k3", messages: [] }, { nonce: "n", clientIdempotencyId: "i", task }), (e: any) => e.code === "provider_unavailable");
  mode = "ok";
  gateUp = false;
  const before = hits;
  try {
    await assert.rejects(provider.chat(route, { model: "legal/k3", messages: [] }, { nonce: "n", clientIdempotencyId: "i", task }), (e: any) => e.code === "provider_unavailable" && /不会改为直连/.test(e.message));
  } finally {
    gateUp = true;
  }
  assert.equal(hits, before);
});

test("N-01 中止：已中止的请求不发往闸门；在途流被中止后迭代立即结束", async () => {
  mode = "ok";
  const before = hits;
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(provider.chat(route, { model: "legal/k3", messages: [] }, { nonce: "n", clientIdempotencyId: "i", task, signal: ac.signal }), /在途模型请求已中止/);
  assert.equal(hits, before, "已中止的请求一个都没有到达闸门");

  const ac2 = new AbortController();
  const s = await provider.chatStream(route, { model: "legal/k3", messages: [] }, { nonce: "n", clientIdempotencyId: "i2", task, signal: ac2.signal });
  assert.equal(s.requestId, "kwlg_stream_1");
  const t0 = Date.now();
  let n = 0;
  await assert.rejects(
    (async () => {
      for await (const _c of s.chunks) {
        n += 1;
        if (n === 2) ac2.abort();
      }
    })(),
  );
  assert.ok(Date.now() - t0 < 3_000, "中止后流立即结束");
});
