/**
 * 云端可观测性（v9.3 A-9；Y2 §6.1“只计量不留内容”、§6.2 首批指标；评审 Z4 P0-8）：scripts/lib/obs.mjs——
 * 访问日志按白名单重建（不记查询串、请求头、请求体），来源地址只留网段；错误日志只记代码；/healthz、/readyz；指标只有计数与时效、监听可带令牌；
 * 超过保留期的日志删除。另有日志门禁：云端服务与生产入口的源码里，console 输出不带异常消息、请求或请求头。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error 纯 JS 模块（生产入口的辅助库）
import { ACCESS_FIELDS, createObs, ERROR_FIELDS, netOf, pathOf, requestIdOf } from "../../../scripts/lib/obs.mjs";

const listen = (s: Server) => new Promise<number>((ok) => s.listen(0, "127.0.0.1", () => ok((s.address() as { port: number }).port)));
const call = (port: number, method: string, path: string, headers: Record<string, string> = {}, body = "") =>
  new Promise<{ status: number; body: string }>((ok, no) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => ok({ status: res.statusCode ?? 0, body: b }));
    });
    req.on("error", no);
    req.end(body);
  });

test("A-9 访问日志的字段：路径去查询串、请求编号只认合格形状、来源只留网段", () => {
  assert.equal(pathOf("/v1/chat/completions?api_key=sk-secret#x"), "/v1/chat/completions");
  assert.equal(pathOf(`/${"a".repeat(300)}`).length, 200);
  assert.equal(requestIdOf("req_ABC-123"), "req_ABC-123");
  assert.equal(requestIdOf("张三的请求"), null);
  assert.equal(netOf("203.0.113.57"), "203.0.113.0/24");
  assert.equal(netOf("::ffff:198.51.100.9"), "198.51.100.0/24");
  assert.equal(netOf("2001:db8:abcd:12::1"), "2001:db8:abcd::/48");
  assert.equal(netOf("not-an-ip"), null);
});

test("A-9 包住服务：访问日志逐行只有白名单字段，不含查询串、令牌、签名头与请求体；健康检查与指标", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-obs-"));
  const feed = { lastOk: Date.now(), currentVersion: 7 };
  const obs = createObs({ role: "gateway", dir, feed });
  const svc = createServer(
    obs.wrap((req: any, res: any) => {
      let b = "";
      req.on("data", (d: Buffer) => (b += d));
      req.on("end", () => {
        res.writeHead(req.url.startsWith("/boom") ? 500 : 200, { "content-type": "application/json" });
        res.end(JSON.stringify({ echoed: b.length }));
      });
    }),
  );
  const port = await listen(svc);
  try {
    await call(port, "POST", "/v1/chat/completions?api_key=sk-secret-123", { authorization: "Bearer seat.token.value", "x-kwl-sig": "sigvalue", "x-kwl-request-id": "req_1" }, JSON.stringify({ messages: [{ role: "user", content: "张三借款 100 万元" }] }));
    await call(port, "GET", "/boom", { "x-kwl-request-id": "bad/id with spaces" });
    assert.deepEqual(await call(port, "GET", "/healthz"), { status: 200, body: '{"ok":true}' });
    assert.equal((await call(port, "GET", "/readyz")).status, 200);
    feed.lastOk = Date.now() - 10 * 60_000;
    assert.deepEqual(await call(port, "GET", "/readyz"), { status: 503, body: '{"ok":false,"reason":"feed_stale"}' });
    await new Promise((r) => setTimeout(r, 50));
    const file = readdirSync(dir).find((f) => f.startsWith("access-"))!;
    const raw = readFileSync(join(dir, file), "utf8");
    for (const bad of ["sk-secret", "seat.token", "sigvalue", "张三", "100 万元", "bad/id", "api_key"]) assert.ok(!raw.includes(bad), `访问日志不得含 ${bad}`);
    const rows = raw.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(rows.length, 5);
    for (const r of rows) assert.deepEqual(Object.keys(r), ACCESS_FIELDS);
    assert.deepEqual(
      rows.map((r) => [r.method, r.path, r.status, r.client_request_id, r.net, r.role]),
      [
        ["POST", "/v1/chat/completions", 200, "req_1", "127.0.0.0/24", "gateway"],
        ["GET", "/boom", 500, null, "127.0.0.0/24", "gateway"],
        ["GET", "/healthz", 200, null, "127.0.0.0/24", "gateway"],
        ["GET", "/readyz", 200, null, "127.0.0.0/24", "gateway"],
        ["GET", "/readyz", 503, null, "127.0.0.0/24", "gateway"],
      ],
    );
    const m = obs.metricsText();
    assert.match(m, /kwl_requests_total\{role="gateway",code_class="2xx"\} 3/);
    assert.match(m, /kwl_requests_total\{role="gateway",code_class="5xx"\} 2/);
    assert.match(m, /kwl_request_duration_seconds_count\{role="gateway"\} 5/);
    assert.match(m, /kwl_feed_age_seconds\{role="gateway"\} 6\d\d\.\d/);
    assert.match(m, /kwl_feed_version\{role="gateway"\} 7/);
    assert.doesNotMatch(m, /chat\/completions|req_1|127\.0\.0/, "指标里没有路径、请求编号与地址");
  } finally {
    svc.close();
  }
});

test("A-9 指标监听要令牌时按令牌放行；错误日志只记代码；超过保留期的日志删除", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-obs-"));
  let t = Date.parse("2026-10-20T00:00:00Z");
  const obs = createObs({ role: "relay", dir, retentionDays: 30, now: () => t });
  const ms = createServer(obs.metricsHandler("tok-0123456789abcdef"));
  const port = await listen(ms);
  try {
    assert.equal((await call(port, "GET", "/metrics")).status, 401);
    assert.equal((await call(port, "GET", "/metrics", { authorization: "Bearer wrong" })).status, 401);
    const ok = await call(port, "GET", "/metrics", { authorization: "Bearer tok-0123456789abcdef" });
    assert.equal(ok.status, 200);
    assert.match(ok.body, /kwl_in_flight_requests\{role="relay"\} 0/);
    assert.equal((await call(port, "GET", "/other")).status, 404);
  } finally {
    ms.close();
  }
  obs.recordError("uncaught", Object.assign(new Error("用户输入：张三的身份证 110101199001011234"), { code: "ERR_SOMETHING" }));
  obs.recordError("uncaught", new TypeError("x is not a function: 李四"));
  const errFile = readdirSync(dir).find((f) => f.startsWith("error-"))!;
  const raw = readFileSync(join(dir, errFile), "utf8");
  assert.ok(!raw.includes("张三") && !raw.includes("李四") && !raw.includes("1101011990"), "错误日志不含异常消息");
  const rows = raw.trim().split("\n").map((l) => JSON.parse(l));
  for (const r of rows) assert.deepEqual(Object.keys(r), ERROR_FIELDS);
  assert.deepEqual(rows.map((r) => r.code), ["ERR_SOMETHING", "TypeError"]);
  assert.match(obs.metricsText(), /kwl_process_errors_total\{role="relay",code="ERR_SOMETHING"\} 1/);
  // 保留期：30 天之前的访问与错误日志删除，别的文件不动
  writeFileSync(join(dir, "access-2026-08-01.jsonl"), "{}\n");
  writeFileSync(join(dir, "error-2026-09-25.jsonl"), "{}\n");
  writeFileSync(join(dir, "notes.txt"), "x");
  t = Date.parse("2026-10-20T00:00:00Z");
  assert.equal(obs.prune(), 1);
  assert.deepEqual(readdirSync(dir).sort(), ["error-2026-09-25.jsonl", "error-2026-10-20.jsonl", "notes.txt"]);
});

test("A-9 日志门禁：云端服务与生产入口的 console 输出不带异常消息、请求、请求头或请求体", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const files: string[] = ["scripts/cloud-serve.mjs", "scripts/lib/obs.mjs"];
  for (const svc of readdirSync(join(root, "services"))) {
    const src = join(root, "services", svc, "src");
    try {
      for (const f of readdirSync(src)) if (/\.(ts|mjs|js)$/.test(f)) files.push(`services/${svc}/src/${f}`);
    } catch {
      // 没有 src 目录的不算
    }
  }
  const hits: string[] = [];
  for (const f of files) {
    const text = readFileSync(join(root, f), "utf8");
    for (const m of text.matchAll(/console\.(?:log|error|warn|info|debug)\(([^;]*?)\);/gs)) {
      if (/\.message\b|\.stack\b|\breq\.|\bheaders\b|\bbody\b|\burl\b/.test(m[1]!)) hits.push(`${f}：${m[0].slice(0, 120)}`);
    }
  }
  assert.ok(files.length >= 9, `扫到的文件太少（${files.length}）`);
  assert.deepEqual(hits, []);
});
