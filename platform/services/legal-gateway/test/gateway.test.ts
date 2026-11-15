/**
 * 法律模型网关 v0（第 04 篇 §5.2、§11 P7；第 06 篇 T13、T15）：席位令牌离线验签与吊销；匿名事项编号与数据级别二次检查；模型路由；
 * 预占/结算（预写日志）与额度不足；按租户排队；响应原样透传（流式）；计量日志只含元数据、正文与错误体零落盘。
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devSeatKeyPair, issueSeatToken } from "@zr-legal/seat-token";
import { createLegalGateway, DEFAULT_ROUTES, extractUsage, fileMeter, METER_FIELDS, MockProvider, type UsageRecord } from "../src/index.ts";

const SECRET_TEXT = "孙悦的借款合同第七条约定违约金为每日万分之五";

describe("法律模型网关 v0", () => {
  const { privateKey, publicKey } = devSeatKeyPair();
  const keys = new Map([["k1", publicKey]]);
  const seat = (tid = "t1", dev = "d1") => issueSeatToken({ tid, uid: "u1", sid: `s-${tid}`, dev, kid: "k1" }, privateKey);
  let server: ReturnType<typeof createLegalGateway>;
  let base: string;
  let meterPath: string;
  const provider = new MockProvider();
  const budgets = new Map<string, number>([
    ["t1", 1_000_000],
    ["poor", 1],
  ]);

  before(async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "kwl-gw-")));
    meterPath = join(dir, "meter.jsonl");
    server = createLegalGateway({ keys, revokedDevices: new Set(["lost-laptop"]), provider, routes: DEFAULT_ROUTES, meter: fileMeter(meterPath), budgets, tenantConcurrency: 1, queueTimeoutMs: 400 });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    server.close();
  });

  const chat = (body: unknown, headers: Record<string, string> = {}, token = seat()) =>
    fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-kwl-anon-matter": "anon-1", "x-kwl-data-level": "L2", ...headers },
      body: JSON.stringify(body),
    });

  test("鉴权：无令牌、伪造令牌、吊销设备一律 401；有效席位令牌可列模型", async () => {
    assert.equal((await fetch(`${base}/v1/models`)).status, 401);
    assert.equal((await chat({ model: "legal/k3", messages: [] }, {}, "zst1.bad.sig")).status, 401);
    assert.equal((await chat({ model: "legal/k3", messages: [] }, {}, seat("t1", "lost-laptop"))).status, 401);
    const models = (await (await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${seat()}` } })).json()) as { data: { id: string; is_default: boolean; label: string }[] };
    assert.deepEqual(models.data.map((m) => m.id), ["legal/k3", "legal/k2.6"]);
    assert.deepEqual(models.data.map((m) => m.is_default), [true, false], "第 44 批：/v1/models 带是否默认与显示名");
    assert.ok(models.data.every((m) => m.label));
  });

  test("二次检查：缺匿名事项编号、L3b/L4 数据级别、未登记模型一律拒绝且不到达上游", async () => {
    const n = provider.seen.length;
    assert.equal((await chat({ model: "legal/k3", messages: [] }, { "x-kwl-anon-matter": "" })).status, 400);
    assert.equal((await chat({ model: "legal/k3", messages: [] }, { "x-kwl-data-level": "L3b" })).status, 403);
    assert.equal((await chat({ model: "legal/k3", messages: [] }, { "x-kwl-data-level": "L4" })).status, 403);
    const r = await chat({ model: "gpt-x", messages: [] });
    assert.equal(r.status, 400);
    assert.equal(((await r.json()) as { error: { code: string } }).error.code, "model_not_routed");
    assert.equal(provider.seen.length, n);
  });

  test("路由与透传：别名换成上游模型 ID，流式请求补 include_usage；响应逐字节原样返回；结算按 usage（tokens：输入 + 输出）", async () => {
    const before = budgets.get("t1")!;
    const r = await chat({ model: "legal/k3", stream: true, messages: [{ role: "user", content: SECRET_TEXT }] });
    assert.equal(r.status, 200);
    assert.ok(r.headers.get("x-kwl-gateway-request-id"));
    const text = await r.text();
    assert.match(text, /^data: /);
    assert.ok(text.endsWith("data: [DONE]\n\n"));
    const sent = provider.seen.at(-1)!;
    assert.equal(sent.model, "kimi-k3");
    assert.deepEqual(sent.stream_options, { include_usage: true });
    const u = extractUsage(text)!;
    assert.ok(u.input > 0 && u.output > 0);
    assert.equal(budgets.get("t1"), before - (u.input + u.output), "第 44 批取消每千 token 4 单位：tokens 单位按上游 usage 原样");
    const settle = readFileSync(meterPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.kind === "settle").at(-1);
    const rec = settle.record as UsageRecord;
    assert.equal(rec.outcome, "ok");
    assert.equal(rec.usage_source, "upstream");
    assert.equal(rec.charge_units, u.input + u.output);
    assert.equal(rec.uid, "u1");
    assert.equal(rec.dev, "d1");
    assert.equal(rec.upstream_request_id, "mock-1", "上游请求编号取响应体 id");
    assert.equal(rec.upstream_model, "kimi-k3");
    assert.equal(rec.attempts.length, 1);
  });

  test("额度：预占失败即 402，不到达上游", async () => {
    const n = provider.seen.length;
    const r = await chat({ model: "legal/k3", messages: [{ role: "user", content: "x" }] }, {}, seat("poor"));
    assert.equal(r.status, 402);
    assert.equal(provider.seen.length, n);
  });

  test("按租户排队：并发上限 1，第二个请求等待；排队超时 429", async () => {
    provider.script = () => null;
    let releaseSlow!: () => void;
    const slow = new Promise<void>((r) => (releaseSlow = r));
    const orig = provider.chat.bind(provider);
    provider.chat = async (b) => {
      if ((b.messages as { content?: string }[])?.[0]?.content === "慢") await slow;
      return orig(b);
    };
    try {
      const first = chat({ model: "legal/k3", messages: [{ role: "user", content: "慢" }] });
      await new Promise((r) => setTimeout(r, 50));
      const second = await chat({ model: "legal/k3", messages: [{ role: "user", content: "快" }] });
      assert.equal(second.status, 429);
      assert.equal(((await second.json()) as { error: { code: string } }).error.code, "tenant_queue_timeout");
      releaseSlow();
      assert.equal((await first).status, 200);
    } finally {
      provider.chat = orig;
    }
  });

  test("S4-01 / 第 44 批 客户端中途断开：网关不立即中止上游，继续读（不再转发）拿到 usage（drained）后结算；随后释放租户并发槽", async () => {
    provider.script = null;
    let aborted = false;
    const orig = provider.chat.bind(provider);
    provider.chat = (async (_b: Record<string, unknown>, o: { signal: AbortSignal }) => {
      o.signal.addEventListener("abort", () => (aborted = true));
      const enc = new TextEncoder();
      return {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: (async function* () {
          for (let i = 0; i < 15; i++) {
            if (o.signal.aborted) return;
            yield enc.encode(`data: ${JSON.stringify({ id: "up-drain-1", choices: [{ index: 0, delta: { content: `段${i}` } }] })}\n\n`);
            await new Promise((r) => setTimeout(r, 20));
          }
          yield enc.encode(`data: ${JSON.stringify({ id: "up-drain-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 30 } })}\n\n`);
          yield enc.encode("data: [DONE]\n\n");
        })(),
      };
    }) as unknown as typeof provider.chat;
    const before = budgets.get("t1")!;
    try {
      const { request } = await import("node:http");
      const url = new URL(`${base}/v1/chat/completions`);
      await new Promise<void>((resolve, reject) => {
        const data = JSON.stringify({ model: "legal/k3", stream: true, max_tokens: 1000, messages: [{ role: "user", content: "长" }] });
        const req = request(
          { host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${seat()}`, "x-kwl-anon-matter": "anon-1", "x-kwl-data-level": "L2", "content-length": Buffer.byteLength(data) } },
          (res) => {
            res.once("data", () => {
              req.destroy();
              resolve();
            });
          },
        );
        req.on("error", () => {});
        req.end(data);
        setTimeout(() => reject(new Error("no first chunk")), 5_000);
      });
      const settled = () => readFileSync(meterPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((r) => r.kind === "settle" && r.record?.upstream_request_id === "up-drain-1");
      for (let i = 0; i < 200 && !settled(); i++) await new Promise((r) => setTimeout(r, 25));
      const s = settled();
      assert.ok(s, "断开的请求照常结算");
      assert.equal(aborted, false, "没有中止上游：读完拿到 usage");
      assert.equal(s.record.outcome, "client_gone");
      assert.equal(s.record.usage_source, "drained");
      assert.deepEqual(s.record.usage, { input: 11, cached: 0, output: 30, reasoning: 0 });
      assert.equal(s.record.charge_units, 41, "按读到的真实 usage 扣，不按预占（max_tokens 1000）收");
      assert.match(s.reason, /^client_gone_/);
      assert.equal(budgets.get("t1"), before - 41);
    } finally {
      provider.chat = orig;
    }
    // 并发槽已释放：并发上限 1 的租户随后的正常请求不排队超时
    const next = await chat({ model: "legal/k3", messages: [{ role: "user", content: "下一条" }] });
    assert.equal(next.status, 200);
  });

  test("留存（第 06 篇 T13）：计量日志只有元数据——正文、错误体都不落盘；预占与结算成对出现", async () => {
    const before = server.metrics();
    provider.script = () => ({ status: 500 });
    const r = await chat({ model: "legal/k2.6", messages: [{ role: "user", content: SECRET_TEXT }] });
    assert.equal(r.status, 500);
    // 第 44 批：上游非 2xx 的响应体规范化，不透传上游原文
    const eb = await r.text();
    assert.deepEqual(JSON.parse(eb), { error: { type: "kwl_gateway", code: "upstream_500", message: "模型服务返回 500" } });
    assert.ok(!eb.includes("mock upstream error"));
    // 上游限流单列（A-9 余项）
    provider.script = () => ({ status: 429 });
    assert.equal((await chat({ model: "legal/k2.6", messages: [{ role: "user", content: "限流" }] })).status, 429);
    provider.script = null;
    const after = server.metrics();
    assert.equal(after.upstream["5xx"] - before.upstream["5xx"], 1);
    assert.equal(after.upstream["429"] - before.upstream["429"], 1);
    assert.ok(after.upstream["2xx"] >= 1);
    assert.ok(!JSON.stringify(after).includes(SECRET_TEXT), "指标里只有计数");
    const log = readFileSync(meterPath, "utf8");
    assert.ok(!log.includes(SECRET_TEXT) && !log.includes("孙悦") && !log.includes("mock upstream error"), "计量日志不得含正文或错误体");
    const recs = log.trim().split("\n").map((l) => JSON.parse(l) as { kind: string; requestId: string; reason: string | null });
    // safety：内容安全命中的类别编号与次数（v9.2 R11），不含文字；finishReason：上游结束原因（复核 B13-C01）；upstreamModel：实际转发的上游型号（第 28 批）；
    // 第 44 批：provider、unit、priceVersion、holder、record（逐请求记录，同样按白名单）
    for (const rec of recs) for (const k of Object.keys(rec)) assert.ok(METER_FIELDS.includes(k), k);
    const recKeys = ["request_id", "client_request_id", "upstream_request_id", "started_at", "at", "tid", "sid", "uid", "dev", "alias", "provider", "upstream_model", "stream", "qa", "status", "outcome", "usage", "usage_source", "reserved_units", "charge_units", "latency_ms", "attempts", "finish_reason", "lease_id", "price_version"];
    for (const rec of recs as unknown as { record?: object | null }[]) if (rec.record) assert.deepEqual(Object.keys(rec.record), recKeys);
    const reserves = recs.filter((x) => x.kind === "reserve").map((x) => x.requestId);
    const settles = new Set(recs.filter((x) => x.kind === "settle").map((x) => x.requestId));
    for (const id of reserves) assert.ok(settles.has(id), `预占 ${id} 没有结算`);
    assert.ok(recs.some((x) => x.kind === "settle" && x.reason === "upstream_error_released"));
    assert.ok(recs.some((x) => x.kind === "settle" && (x as { finishReason?: string | null }).finishReason === "stop"), "成功的调用记下上游结束原因");
  });
});

test("预写计量失败（第 6 批联调发现）：退还预占、释放并发槽、503 失败关闭且不到达上游；之后的请求不因槽位泄漏而排队超时", async () => {
  const { privateKey, publicKey } = devSeatKeyPair();
  const keys = new Map([["k1", publicKey]]);
  const token = issueSeatToken({ tid: "tm", uid: "u1", sid: "s-tm", dev: "d1", kid: "k1" }, privateKey);
  const provider = new MockProvider();
  const budgets = new Map([["tm", 1_000_000]]);
  let failReserve = 3;
  const meter = {
    append: (r: { kind: string }) => {
      if (r.kind === "reserve" && failReserve > 0) {
        failReserve -= 1;
        throw new Error("ENOSPC");
      }
    },
  };
  const server = createLegalGateway({ keys, revokedDevices: new Set(), provider, routes: DEFAULT_ROUTES, meter: meter as never, budgets, tenantConcurrency: 1, queueTimeoutMs: 400 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const chat = () =>
    fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-kwl-anon-matter": "anon-1", "x-kwl-data-level": "L2" },
      body: JSON.stringify({ model: "legal/k3", messages: [{ role: "user", content: "你好" }] }),
    });
  try {
    for (let i = 0; i < 3; i++) {
      const r = await chat();
      assert.equal(r.status, 503);
      assert.equal(((await r.json()) as { error: { code: string } }).error.code, "meter_unavailable");
    }
    assert.equal(provider.seen.length, 0, "计量写不进去就不发往上游");
    assert.equal(budgets.get("tm"), 1_000_000, "预占全部退还");
    const ok = await chat();
    assert.equal(ok.status, 200, "并发上限 1：前三次失败没有占住槽位");
  } finally {
    server.close();
  }
});

test("第 44 批真实验收的缺陷：流式只留尾部时，截断点落在“{”上也照样逐行取到末尾的 usage；兼容 data: 后不带空格", () => {
  const chunk = (i: number) => `data: {"id":"c","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"段${i}"}}]}}]}`;
  const body = [...Array.from({ length: 50 }, (_, i) => chunk(i)), `data: {"id":"c","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`, `data: {"id":"c","choices":[],"usage":{"prompt_tokens":48261,"completion_tokens":596,"prompt_tokens_details":{"cached_tokens":24576}}}`, "data: [DONE]", ""].join("\n");
  // 从某一行中间的“{”处截断（模拟 64 KiB 尾巴）
  const cut = body.slice(body.indexOf('{"index":0,"function"', 400));
  assert.ok(cut.trim().startsWith("{"));
  assert.deepEqual(extractUsage(cut), { input: 48261, output: 596, cached: 24576, reasoning: 0 });
  assert.deepEqual(extractUsage(`data:{"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1}}\r\ndata:[DONE]\r\n`), { input: 5, output: 1, cached: 0, reasoning: 0 });
});
