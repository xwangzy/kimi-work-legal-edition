/**
 * 宿主 HTTP 出口（v9 第 04 篇 §1.2 第 3 条、§5.1 第②级）：只认 gate.kwl / tools.kwl；模型请求按会话换任务令牌，
 * 未绑定会话、事项不符、读不出会话键、其他主机一律在本进程内失败（不发起连接）。
 * 检索与抓取（阶段 4）：按工具调用 ID 与参数摘要对到宿主策略放行的那一次裁决，每次裁决只换一次运行令牌。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostEgressDispatcher, type ModelBinding } from "../src/host-egress.ts";
import { egressDigest } from "../src/policy.ts";

interface Seen {
  path: string;
  auth: string | undefined;
  body: string;
}

function listen(socket: string, seen: Seen[]): Promise<Server> {
  const srv = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ path: req.url ?? "", auth: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((r) => srv.listen(socket, () => r(srv)));
}

const dir = mkdtempSync(join(tmpdir(), "eg-"));
const gateSeen: Seen[] = [];
const toolsSeen: Seen[] = [];
const gate = await listen(join(dir, "gate.sock"), gateSeen);
const tools = await listen(join(dir, "tools.sock"), toolsSeen);
const bindings = new Map<string, ModelBinding>([["sess-a", { matterId: "m1", runId: "run-a", token: "TOKEN-RUN-A" }]]);
const egress = new HostEgressDispatcher({
  modelSocket: join(dir, "gate.sock"),
  toolsSocket: join(dir, "tools.sock"),
  authority: {
    modelBinding: (s) => bindings.get(s) ?? null,
    toolsToken: (m) => (m === "m1" ? "TOKEN-TOOLS-M1" : null),
    // 宿主策略放行过的检索/抓取裁决（一次性）
    toolEgressBinding: (m, tool, callId, digest) => {
      const k = `${m}|${tool}|${callId}|${digest}`;
      if (!approvedEgress.has(k)) return null;
      approvedEgress.delete(k);
      return { matterId: m, runId: "run-a", token: "TOKEN-RUN-A" };
    },
  },
});
const approvedEgress = new Set<string>([
  `m1|WebSearch|call_7|${egressDigest("WebSearch", "股东出资责任")}`,
  `m1|FetchURL|call_8|${egressDigest("FetchURL", "https://www.court.gov.cn/a")}`,
]);

after(async () => {
  await egress.close();
  gate.close();
  tools.close();
});

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer engine-placeholder", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
    dispatcher: egress,
  } as unknown as RequestInit);

test("模型请求：按会话换上任务令牌（引擎自带的凭据被剥离），保留事项前缀转给出站闸门，请求体原样", async () => {
  const body = { model: "legal/k3", messages: [{ role: "user", content: "hi" }], prompt_cache_key: "sess-a", stream: false };
  const r = await post("http://gate.kwl/m/m1/v1/chat/completions", body);
  assert.equal(r.status, 200);
  const last = gateSeen.at(-1)!;
  assert.equal(last.path, "/m/m1/v1/chat/completions", "转给出站闸门时保留事项前缀");
  assert.equal(last.auth, "Bearer TOKEN-RUN-A");
  assert.deepEqual(JSON.parse(last.body), body);
  assert.equal(egress.records.at(-1)?.route, "model");
  assert.equal(egress.records.at(-1)?.runId, "run-a");
});

test("流式请求体同样按会话路由", async () => {
  const text = JSON.stringify({ model: "legal/k3", prompt_cache_key: "sess-a", messages: [] });
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(text.slice(0, 10)));
      c.enqueue(new TextEncoder().encode(text.slice(10)));
      c.close();
    },
  });
  const r = await fetch("http://gate.kwl/m/m1/v1/chat/completions", { method: "POST", body: stream, duplex: "half", dispatcher: egress } as unknown as RequestInit);
  assert.equal(r.status, 200);
  assert.equal(gateSeen.at(-1)!.body, text);
});

test("失败关闭：未绑定会话、事项不符、无会话键、非 JSON、其他主机与 https 一律不发起连接", async () => {
  const before = gateSeen.length;
  const cases: [string, unknown, string][] = [
    ["http://gate.kwl/m/m1/v1/chat/completions", { prompt_cache_key: "sess-unknown" }, "session_not_bound_or_run_not_live"],
    ["http://gate.kwl/m/m2/v1/chat/completions", { prompt_cache_key: "sess-a" }, "matter_mismatch"],
    ["http://gate.kwl/m/m1/v1/chat/completions", { messages: [] }, "session_key_missing"],
    ["http://gate.kwl/m/m1/v1/chat/completions", "not-json", "session_key_missing"],
    ["http://gate.kwl/v1/chat/completions", { prompt_cache_key: "sess-a" }, "matter_prefix_missing"],
    ["http://api.moonshot.cn/m/m1/v1/chat/completions", { prompt_cache_key: "sess-a" }, "host_not_allowed"],
    ["https://gate.kwl/m/m1/v1/chat/completions", { prompt_cache_key: "sess-a" }, "host_not_allowed"],
    ["http://127.0.0.1:8443/m/m1/v1", { prompt_cache_key: "sess-a" }, "host_not_allowed"],
  ];
  for (const [url, body, reason] of cases) {
    await assert.rejects(post(url, body), (e: Error) => /fetch failed/.test(e.message) && /宿主出口拒绝/.test(String((e as { cause?: Error }).cause?.message)), url);
    const rec = egress.records.at(-1)!;
    assert.equal(rec.route, "denied", url);
    assert.ok(rec.reason?.startsWith(reason), `${url}: ${rec.reason}`);
  }
  assert.equal(gateSeen.length, before, "被拒绝的请求一个都没有到达闸门");
});

test("任务结束（绑定撤销）后，同一会话的模型请求立即失败", async () => {
  bindings.set("sess-b", { matterId: "m1", runId: "run-b", token: "TOKEN-RUN-B" });
  assert.equal((await post("http://gate.kwl/m/m1/v1/chat/completions", { prompt_cache_key: "sess-b" })).status, 200);
  bindings.delete("sess-b");
  await assert.rejects(post("http://gate.kwl/m/m1/v1/chat/completions", { prompt_cache_key: "sess-b" }), /fetch failed/);
});

test("法律 MCP：按路径中的事项换上事项工具令牌；没有令牌的事项拒绝", async () => {
  const rpc = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  const r = await post("http://tools.kwl/m/m1/mcp", rpc);
  assert.equal(r.status, 200);
  assert.equal(toolsSeen.at(-1)!.path, "/mcp");
  assert.equal(toolsSeen.at(-1)!.auth, "Bearer TOKEN-TOOLS-M1");
  await assert.rejects(post("http://tools.kwl/m/m9/mcp", rpc), /fetch failed/);
  assert.equal(egress.records.at(-1)?.reason, "tools_token_unavailable");
});

test("检索与抓取：工具调用 ID 与参数摘要对上宿主策略放行的那次裁决才换运行令牌（一次性）；缺调用 ID、参数不符、带查询串、已用过一律拒绝", async () => {
  const before = gateSeen.length;
  const r = await post("http://gate.kwl/m/m1/search", { text_query: "股东出资责任" }, { "X-Msh-Tool-Call-Id": "call_7" });
  assert.equal(r.status, 200);
  const last = gateSeen.at(-1)!;
  assert.equal(last.path, "/m/m1/search", "保留事项前缀转给闸门");
  assert.equal(last.auth, "Bearer TOKEN-RUN-A");
  assert.equal(JSON.parse(last.body).text_query, "股东出资责任");
  // 同一裁决不能再换一次
  await assert.rejects(post("http://gate.kwl/m/m1/search", { text_query: "股东出资责任" }, { "X-Msh-Tool-Call-Id": "call_7" }), /fetch failed/);
  // 参数与裁决不符（同一调用 ID 换了查询）
  await assert.rejects(post("http://gate.kwl/m/m1/fetch", { url: "https://www.court.gov.cn/b" }, { "X-Msh-Tool-Call-Id": "call_8" }), /fetch failed/);
  // 缺调用 ID
  await assert.rejects(post("http://gate.kwl/m/m1/search", { text_query: "股东出资责任" }), /fetch failed/);
  // 带查询串
  await assert.rejects(post("http://gate.kwl/m/m1/fetch?x=1", { url: "https://www.court.gov.cn/a" }, { "X-Msh-Tool-Call-Id": "call_8" }), /fetch failed/);
  // 正确的抓取（参数一致）
  const f = await post("http://gate.kwl/m/m1/fetch", { url: "https://www.court.gov.cn/a" }, { "X-Msh-Tool-Call-Id": "call_8" });
  assert.equal(f.status, 200);
  assert.equal(gateSeen.length, before + 2, "被拒绝的请求一个都没有到达闸门");
  const reasons = egress.records.filter((x) => x.route === "denied").map((x) => x.reason);
  for (const why of ["tool_call_not_approved_or_args_mismatch", "tool_call_id_missing", "query_string_not_allowed"]) assert.ok(reasons.includes(why), why);
});

test("闸门未配置（modelSocket 为空）：模型、检索、抓取一律在本进程内失败，不改走别的通道；法律 MCP 不受影响", async () => {
  const eg = new HostEgressDispatcher({
    modelSocket: null,
    toolsSocket: join(dir, "tools.sock"),
    authority: { modelBinding: (s) => bindings.get(s) ?? null, toolsToken: (m) => (m === "m1" ? "TOKEN-TOOLS-M1" : null) },
  });
  try {
    const go = (url: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), dispatcher: eg } as unknown as RequestInit);
    const before = gateSeen.length;
    await assert.rejects(go("http://gate.kwl/m/m1/v1/chat/completions", { prompt_cache_key: "sess-a", messages: [] }), /fetch failed/);
    await assert.rejects(go("http://gate.kwl/m/m1/search", { text_query: "x" }, { "X-Msh-Tool-Call-Id": "c" }), /fetch failed/);
    assert.equal(gateSeen.length, before);
    assert.ok(eg.records.some((r) => r.reason === "egress_gate_not_configured"));
    const mcp = await go("http://tools.kwl/m/m1/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.equal(mcp.status, 200);
  } finally {
    await eg.close();
  }
});
