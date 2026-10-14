/**
 * 出站闸门阶段 4 的补充用例（第 04 篇 §5.1、§8；第 02 篇 §8.1–§8.3）：
 * - 抓取域名白名单逐跳校验（首跳与每次重定向；防开放重定向绕过）；四项依据未齐备不抓取；
 * - 模型请求的去向记录带模型别名与用量（只在内存中从响应尾部读取，响应流原样）、出站代号数与闸门补替换数；
 * - 自带密钥/私有端点：别名映射到上游模型 ID、补 include_usage、不带任何 x-kwl 头；端点未配置不切换；
 * - 在途请求周期复核：任务失效后在复核周期内中止上游请求（复审 N-01 的闸门侧）。
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, realpathSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EgressGateServer } from "../src/server.ts";
import { FetchDenied, gateFetch } from "../src/fetcher.ts";
import { isPublicAddress } from "../src/url-guard.ts";
import type { AuthorizeResult, GateAuthority, GateEgressRecord, MatterEgressContext } from "../src/types.ts";

const KEY = Buffer.alloc(32, 9).toString("base64");

function ctx(o: Partial<MatterEgressContext> = {}): MatterEgressContext {
  return {
    tenantId: "t1",
    matterId: "m1",
    runId: "r1",
    userId: "u1",
    anonMatterId: "anon-1",
    dataLevel: "L2",
    basisComplete: true,
    modelEndpoint: "standard",
    preauth: { searchGeneralized: false, images: false },
    l3aStandardAllowed: false,
    fetchAllowlist: ["court.gov.cn"],
    policyVersion: 1,
    tokenizer: { keyB64: KEY, parties: [{ name: "孙悦", kind: "person" }], table: [], fullPseudonym: false, tableVersion: 1 },
    ...o,
  };
}

class Authority implements GateAuthority {
  current: MatterEgressContext | null = ctx();
  readonly records: GateEgressRecord[] = [];
  async authorize(): Promise<AuthorizeResult> {
    return this.current ? { ok: true, ctx: this.current } : { ok: false, status: 403, reason: "run_not_live" };
  }
  record(r: GateEgressRecord): void {
    this.records.push(r);
  }
  tokens(): void {}
}

async function listen(handler: (req: IncomingMessage, body: string, res: ServerResponse) => void): Promise<{ server: Server; url: string; port: number; seen: { path: string; headers: IncomingMessage["headers"]; body: any }[]; closed: () => number }> {
  const seen: { path: string; headers: IncomingMessage["headers"]; body: any }[] = [];
  let closed = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      seen.push({ path: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : null });
      res.on("close", () => {
        if (!res.writableEnded) closed += 1;
      });
      handler(req, raw, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return { server, url: `http://127.0.0.1:${port}`, port, seen, closed: () => closed };
}

function call(socket: string, path: string, body: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request({ socketPath: socket, path, method: "POST", headers: { "content-type": "application/json", authorization: "Bearer t", "content-length": Buffer.byteLength(data) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

test("抓取白名单逐跳：首跳不在白名单即拒；白名单站点重定向到白名单之外即拒（防开放重定向）；白名单内照常", async () => {
  const site = await listen((req, _b, res) => {
    if (req.url === "/ok") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("公告正文");
    } else if (req.url === "/open-redirect") {
      res.writeHead(302, { location: `http://evil.example:${(site.server.address() as AddressInfo).port}/ok` });
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  try {
    const opts = {
      allowedPorts: [site.port],
      resolver: async () => [{ address: "127.0.0.1", family: 4 as const }],
      addressPolicy: (ip: string) => ip === "127.0.0.1" || isPublicAddress(ip),
      allowHost: (h: string) => h === "court.gov.cn" || h.endsWith(".court.gov.cn"),
    };
    const ok = await gateFetch(`http://www.court.gov.cn:${site.port}/ok`, opts);
    assert.equal(ok.text, "公告正文");
    await assert.rejects(gateFetch(`http://evil.example:${site.port}/ok`, opts), (e: unknown) => e instanceof FetchDenied && e.reason === "fetch_domain_not_allowlisted");
    await assert.rejects(gateFetch(`http://www.court.gov.cn:${site.port}/open-redirect`, opts), (e: unknown) => e instanceof FetchDenied && e.reason === "redirect_domain_not_allowlisted");
  } finally {
    site.server.close();
  }
});

describe("闸门服务（阶段 4 补充）", () => {
  let dir: string;
  let socket: string;
  let gate: EgressGateServer;
  const authority = new Authority();
  let gw: Awaited<ReturnType<typeof listen>>;
  let byok: Awaited<ReturnType<typeof listen>>;
  let slowMode = false;

  before(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "kwl-g4-")));
    socket = join(dir, "g.sock");
    const SSE = (model: string) =>
      `data: ${JSON.stringify({ id: "c1", model, choices: [{ index: 0, delta: { content: "好的" }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id: "c1", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 7 } } })}\n\n` +
      "data: [DONE]\n\n";
    gw = await listen((_r, body, res) => {
      if (slowMode) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "开始" } }] })}\n\n`);
        const t = setTimeout(() => res.end("data: [DONE]\n\n"), 20_000);
        res.on("close", () => clearTimeout(t));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(SSE(JSON.parse(body).model));
    });
    byok = await listen((_r, body, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(SSE(JSON.parse(body).model));
    });
    gate = new EgressGateServer({
      authority,
      upstreams: {
        model: { baseUrl: `${gw.url}/v1`, seatToken: "seat" },
        byok: { baseUrl: `${byok.url}/v1`, apiKey: "byok-key", models: { "legal/k3": "kimi-k3" } },
        private: null,
        search: null,
        fetch: "local",
      },
      recheckIntervalMs: 100,
    });
    await gate.listen(socket);
  });

  after(async () => {
    await gate.close();
    gw.server.close();
    byok.server.close();
  });

  test("模型去向记录：带模型别名、用量（缓存命中、推理）与出站代号数；闸门补替换数单列；响应原样", async () => {
    authority.current = ctx();
    const r = await call(socket, "/m/m1/v1/chat/completions", { model: "legal/k3", stream: true, messages: [{ role: "user", content: "孙悦的电话 13900001111，请核对〔自然人·ABCDEF〕的借款。" }] });
    assert.equal(r.status, 200);
    assert.match(r.text, /"reasoning_tokens":7/);
    const rec = authority.records.at(-1)!;
    assert.equal(rec.model, "legal/k3");
    assert.deepEqual(rec.usage, { input: 120, output: 30, cached: 100, cacheWrite: 0, reasoning: 7 });
    assert.equal(rec.tokenized.person, 2, "出站代号数含已有代号与闸门补替换的");
    assert.equal(rec.replacedAtGate?.person, 1);
    assert.equal(rec.replacedAtGate?.phone, 1);
  });

  test("自带密钥端点：别名映射到上游模型 ID、补 include_usage、不带 x-kwl 头；私有端点未配置即 503（不切换端点）", async () => {
    authority.current = ctx({ modelEndpoint: "byok" });
    const r = await call(socket, "/m/m1/v1/chat/completions", { model: "legal/k3", stream: true, messages: [{ role: "user", content: "你好" }] });
    assert.equal(r.status, 200);
    const s = byok.seen.at(-1)!;
    assert.equal(s.body.model, "kimi-k3");
    assert.deepEqual(s.body.stream_options, { include_usage: true });
    assert.equal(s.headers.authorization, "Bearer byok-key");
    assert.equal(s.headers["x-kwl-anon-matter"], undefined);
    assert.equal(s.headers["x-kwl-data-level"], undefined);
    assert.equal(authority.records.at(-1)!.destination, "byok_model");
    authority.current = ctx({ modelEndpoint: "private" });
    const p = await call(socket, "/m/m1/v1/chat/completions", { model: "legal/k3", messages: [] });
    assert.equal(p.status, 503);
    assert.equal(JSON.parse(p.text).error.code, "model_upstream_unavailable");
  });

  test("抓取：四项依据未齐备不抓取（只运行不出站的本机能力）；白名单之外的域名被闸门拒绝并记录", async () => {
    authority.current = ctx({ basisComplete: false });
    const a = await call(socket, "/m/m1/fetch", { url: "https://www.court.gov.cn/" });
    assert.equal(a.status, 403);
    assert.equal(JSON.parse(a.text).error.code, "basis_pending_no_egress");
    authority.current = ctx();
    const b = await call(socket, "/m/m1/fetch", { url: "https://www.example.org/x" });
    assert.equal(b.status, 403);
    assert.equal(JSON.parse(b.text).error.code, "fetch_domain_not_allowlisted");
    assert.equal(authority.records.at(-1)!.outcome, "blocked");
  });

  test("当事人词典变更（策略版本递增、令牌表未变）：闸门重建令牌化器，新加入的当事人立即令牌化", async () => {
    const text = "关于欧阳某某娜的借款事实。";
    authority.current = ctx({ policyVersion: 7, tokenizer: { ...ctx().tokenizer, parties: [], tableVersion: 3 } });
    await call(socket, "/m/m1/v1/chat/completions", { model: "legal/k3", messages: [{ role: "user", content: text }] });
    assert.ok(JSON.stringify(gw.seen.at(-1)!.body).includes("欧阳某某娜"), "词典里没有时（且无上下文）不识别");
    authority.current = ctx({ policyVersion: 8, tokenizer: { ...ctx().tokenizer, parties: [{ name: "欧阳某某娜", kind: "person" }], tableVersion: 3 } });
    await call(socket, "/m/m1/v1/chat/completions", { model: "legal/k3", messages: [{ role: "user", content: text }] });
    assert.ok(!JSON.stringify(gw.seen.at(-1)!.body).includes("欧阳某某娜"), "词典加入后立即令牌化");
  });

  test("S4-01 客户端中途断开：闸门立即中止上游请求；去向记录先预写“已发出”、结束时补全为中止", async () => {
    authority.current = ctx();
    slowMode = true;
    try {
      const before = gw.closed();
      const nRec = authority.records.length;
      await new Promise<void>((resolve, reject) => {
        const data = JSON.stringify({ model: "legal/k3", stream: true, messages: [{ role: "user", content: "长任务" }] });
        const req = request({ socketPath: socket, path: "/m/m1/v1/chat/completions", method: "POST", headers: { "content-type": "application/json", authorization: "Bearer t", "content-length": Buffer.byteLength(data) } }, (res) => {
          res.once("data", () => {
            // 收到首块即断开（宿主取消或超时）
            req.destroy();
            resolve();
          });
        });
        req.on("error", () => {});
        req.end(data);
        setTimeout(() => reject(new Error("no first chunk")), 5_000);
      });
      const t0 = Date.now();
      for (let i = 0; i < 80 && gw.closed() === before; i++) await new Promise((r) => setTimeout(r, 25));
      assert.equal(gw.closed(), before + 1, "上游请求被中止");
      assert.ok(Date.now() - t0 < 1_500, `中止应立即发生：${Date.now() - t0} ms`);
      for (let i = 0; i < 40 && !authority.records.slice(nRec).some((r) => r.phase === "end"); i++) await new Promise((r) => setTimeout(r, 25));
      const recs = authority.records.slice(nRec);
      assert.ok(recs.some((r) => r.phase === "start" && r.outcome === "sent"), "转发前预写");
      const end = recs.find((r) => r.phase === "end");
      assert.ok(end, "结束时补全");
      assert.equal(end!.outcome, "failed");
      assert.equal(end!.reason, "aborted");
    } finally {
      slowMode = false;
    }
  });

  test("在途请求周期复核：任务在流式返回中途失效，闸门在复核周期内中止上游请求", async () => {
    authority.current = ctx();
    slowMode = true;
    try {
      const before = gw.closed();
      const pending = call(socket, "/m/m1/v1/chat/completions", { model: "legal/k3", stream: true, messages: [{ role: "user", content: "长任务" }] });
      await new Promise((r) => setTimeout(r, 300));
      const t0 = Date.now();
      authority.current = null; // 内核：尝试已结束 / 任务被取消
      await pending;
      for (let i = 0; i < 40 && gw.closed() === before; i++) await new Promise((r) => setTimeout(r, 25));
      assert.equal(gw.closed(), before + 1, "上游请求被中止");
      assert.ok(Date.now() - t0 < 2_000, `中止应在复核周期量级：${Date.now() - t0} ms`);
    } finally {
      slowMode = false;
      authority.current = ctx();
    }
  });
});
