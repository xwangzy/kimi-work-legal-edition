/**
 * 上游传输安全（审计 S5 / 隐私安全审查 P0-5）：非回环必须 https、开发形态之外回环 http 也拒绝、安装包形态中软上游必须带钉住集；
 * 钉住按证书链 SPKI 摘要核对，不命中即在发送请求字节之前断开；证书校验失败同样不发出；去向记录写明原因。
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttps, type Server as HttpsServer } from "node:https";
import { createServer as createHttp, request, type IncomingMessage, type Server as HttpServer } from "node:http";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkUpstream, normalizePins, spkiPin } from "../src/tls-check.ts";
import { transportFailureReason, upstreamFetch } from "../src/tls-policy.ts";
import { relayControlPlane } from "../src/cp-relay.ts";
import { EgressGateServer } from "../src/server.ts";
import type { AuthorizeResult, GateAuthority, GateEgressRecord, MatterEgressContext } from "../src/types.ts";

const fx = (n: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url)), "utf8");
const CERT = fx("tls-test-cert.pem");
const KEY_PEM = fx("tls-test-key.pem");
const CERT_PIN = spkiPin(Buffer.from(CERT.replace(/-----[^-]+-----|\s/g, ""), "base64"));
const OTHER_PIN = `sha256/${Buffer.alloc(32, 9).toString("base64")}`;

describe("传输检查（纯函数）", () => {
  test("非回环 http 一律拒绝；回环 http 只在开发形态允许；地址带口令拒绝", () => {
    assert.deepEqual(checkUpstream("http://gateway.example.cn/v1", { allowLoopbackHttp: true }), { state: "invalid", reason: "upstream_tls_required" });
    assert.equal(checkUpstream("http://127.0.0.1:7801/v1", { allowLoopbackHttp: true }).state, "insecure_loopback");
    assert.equal(checkUpstream("http://localhost:7801/v1", { allowLoopbackHttp: true }).state, "insecure_loopback");
    assert.equal(checkUpstream("http://[::1]:7801/v1", { allowLoopbackHttp: true }).state, "insecure_loopback");
    assert.deepEqual(checkUpstream("http://127.0.0.1:7801/v1", { allowLoopbackHttp: false }), { state: "invalid", reason: "upstream_tls_required" });
    // 看起来像回环的主机名不算回环
    assert.equal(checkUpstream("http://127.0.0.1.example.cn/v1", { allowLoopbackHttp: true }).state, "invalid");
    assert.equal(checkUpstream("https://u:p@gateway.example.cn/v1", { allowLoopbackHttp: true }).reason, "upstream_url_credentials");
    assert.equal(checkUpstream("ftp://gateway.example.cn/", { allowLoopbackHttp: true }).reason, "upstream_url_invalid");
    assert.equal(checkUpstream(null, { allowLoopbackHttp: true }).state, "none");
  });

  test("钉住集：安装包形态缺钉住即拒绝；形态不合法整组无效；合法即 pinned", () => {
    assert.deepEqual(checkUpstream("https://gateway.example.cn/v1", { allowLoopbackHttp: false, requirePins: true }), { state: "invalid", reason: "upstream_pins_missing" });
    assert.equal(checkUpstream("https://gateway.example.cn/v1", { allowLoopbackHttp: false }).state, "tls");
    assert.equal(checkUpstream("https://gateway.example.cn/v1", { allowLoopbackHttp: false, requirePins: true, pins: [CERT_PIN, OTHER_PIN] }).state, "pinned");
    assert.equal(checkUpstream("https://gateway.example.cn/v1", { allowLoopbackHttp: false, pins: ["sha256/abc"] }).reason, "upstream_pins_malformed");
    assert.equal(normalizePins([` ${CERT_PIN} `, CERT_PIN, ""])!.length, 1);
  });

  test("钉住值按 SPKI 计算（与 openssl pkey -pubin -outform der | sha256 一致的形态）", () => {
    assert.match(CERT_PIN, /^sha256\/[A-Za-z0-9+/]{43}=$/);
  });
});

describe("握手时核对钉住集", () => {
  let srv: HttpsServer;
  let sink: HttpServer;
  let url = "";
  let sinkUrl = "";
  let hits = 0;
  let sinkHits = 0;
  before(async () => {
    // 重定向目标：明文 http（模拟把请求体引到别处）
    sink = createHttp((req, res) => {
      sinkHits++;
      req.resume();
      res.end("sink");
    });
    await new Promise<void>((r) => sink.listen(0, "127.0.0.1", () => r()));
    sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/sink`;
    srv = createHttps({ key: KEY_PEM, cert: CERT }, (req, res) => {
      hits++;
      req.resume();
      if (req.url === "/redirect") {
        res.writeHead(307, { location: sinkUrl });
        res.end();
        return;
      }
      res.end("ok");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    url = `https://localhost:${(srv.address() as AddressInfo).port}/`;
  });
  after(async () => {
    await new Promise<void>((r) => srv.close(() => r()));
    await new Promise<void>((r) => sink.close(() => r()));
  });

  test("上游要求重定向（307）：不跟随，请求体不到达重定向目标，原因 upstream_redirect_refused（复核 B3-A01）", async () => {
    const f = upstreamFetch({ pins: [CERT_PIN], caPem: CERT });
    // 调用方即使写了 follow 也被覆盖
    const e = await f(`${url}redirect`, { method: "POST", body: "令牌化后的正文", redirect: "follow" }).then(() => null, (x: unknown) => x);
    assert.ok(e, "应当失败");
    assert.equal(transportFailureReason(e, false), "upstream_redirect_refused");
    assert.equal(sinkHits, 0, "重定向目标收不到任何请求");
  });

  test("钉住命中：正常往返", async () => {
    const f = upstreamFetch({ pins: [OTHER_PIN, CERT_PIN], caPem: CERT });
    const r = await f(url, { method: "POST", body: "x" });
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "ok");
  });

  test("钉住不符：握手阶段断开，服务端收不到任何请求，原因 tls_pin_mismatch", async () => {
    const before = hits;
    const f = upstreamFetch({ pins: [OTHER_PIN], caPem: CERT });
    const e = await f(url, { method: "POST", body: "令牌化后的正文" }).then(() => null, (x: unknown) => x);
    assert.ok(e, "应当失败");
    assert.equal(transportFailureReason(e, false), "tls_pin_mismatch");
    assert.equal(hits, before, "请求没有到达服务端");
  });

  test("证书不受信任（未附 CA）：不发出，原因 tls_verify_failed", async () => {
    const before = hits;
    const e = await upstreamFetch({ pins: [CERT_PIN] })(url, { method: "POST", body: "x" }).then(() => null, (x: unknown) => x);
    assert.equal(transportFailureReason(e, false), "tls_verify_failed");
    assert.equal(hits, before);
  });

  test("控制面通道：钉住不符或明文地址都不发出", async () => {
    const before = hits;
    const req = { method: "GET", path: "/v1/directory", headers: {}, body: "" };
    const r1 = await relayControlPlane(req, { baseUrl: url.replace(/\/$/, ""), fetchImpl: upstreamFetch({ pins: [OTHER_PIN], caPem: CERT }) });
    assert.deepEqual(r1, { ok: false, reason: "cp_tls_pin_mismatch" });
    const r2 = await relayControlPlane(req, {
      baseUrl: "http://cp.example.cn",
      transport: checkUpstream("http://cp.example.cn", { allowLoopbackHttp: true }),
    });
    assert.deepEqual(r2, { ok: false, reason: "cp_upstream_tls_required" });
    assert.equal(hits, before);
  });
});

describe("闸门按传输策略拒绝或中断", () => {
  const KEY = Buffer.alloc(32, 7).toString("base64");
  const ctx: MatterEgressContext = {
    tenantId: "t1",
    matterId: "m1",
    runId: "r1",
    userId: "u1",
    anonMatterId: "anon-7f3a",
    dataLevel: "L2",
    basisComplete: true,
    modelEndpoint: "standard",
    preauth: { searchGeneralized: true, images: false },
    l3aStandardAllowed: false,
    fetchAllowlist: [],
    policyVersion: 1,
    tokenizer: { keyB64: KEY, parties: [{ name: "孙悦", kind: "person" }], table: [], fullPseudonym: false, tableVersion: 1 },
  };
  class Auth implements GateAuthority {
    readonly records: GateEgressRecord[] = [];
    async authorize(): Promise<AuthorizeResult> {
      return { ok: true, ctx };
    }
    record(rec: GateEgressRecord): void {
      this.records.push(rec);
    }
    tokens(): void {}
  }
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kwl-tls-")));
  let n = 0;
  async function gate(upstreams: ConstructorParameters<typeof EgressGateServer>[0]["upstreams"]): Promise<{ g: EgressGateServer; a: Auth; sock: string }> {
    const a = new Auth();
    const g = new EgressGateServer({ authority: a, upstreams });
    const sock = join(dir, `g${n++}.sock`);
    await g.listen(sock);
    return { g, a, sock };
  }
  function post(sock: string, path: string, body: unknown): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = request({ socketPath: sock, path, method: "POST", headers: { "content-type": "application/json", authorization: "Bearer t", "content-length": Buffer.byteLength(data) } }, (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end(data);
    });
  }
  const seat = `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.y`;
  const chat = { model: "legal/k3", messages: [{ role: "user", content: "孙悦的合同" }] };

  test("非回环 http 的网关与检索服务：不发出，去向记录为拦截", async () => {
    const { g, a, sock } = await gate({ model: { baseUrl: "http://gateway.example.cn/v1", seatToken: seat }, search: { baseUrl: "http://search.example.cn/s", seatToken: seat }, fetch: "disabled" });
    try {
      const r = await post(sock, "/m/m1/v1/chat/completions", chat);
      assert.equal(r.status, 503);
      assert.match(r.text, /upstream_tls_required/);
      const s = await post(sock, "/m/m1/search", { text_query: "民法典 违约金 调整" });
      assert.equal(s.status, 503);
      assert.ok(a.records.every((x) => x.outcome === "blocked" && x.destination === "none"), JSON.stringify(a.records.map((x) => [x.outcome, x.reason])));
      assert.deepEqual(a.records.map((x) => x.reason), ["upstream_tls_required", "upstream_tls_required"]);
      assert.equal(g.transportStates().legal_gateway!.state, "invalid");
    } finally {
      await g.close();
    }
  });

  test("安装包形态：回环 http 也拒绝；https 缺钉住拒绝", async () => {
    const { g, sock } = await gate({ model: { baseUrl: "http://127.0.0.1:9/v1", seatToken: seat }, search: { baseUrl: "https://search.example.cn/s", seatToken: seat }, fetch: "disabled", tls: { allowLoopbackHttp: false, requirePins: true } });
    try {
      assert.match((await post(sock, "/m/m1/v1/chat/completions", chat)).text, /upstream_tls_required/);
      assert.match((await post(sock, "/m/m1/search", { text_query: "民法典 违约金 调整" })).text, /upstream_pins_missing/);
    } finally {
      await g.close();
    }
  });

  test("证书校验失败：请求未到达上游，去向记录 end 阶段写 tls_verify_failed", async () => {
    let hits = 0;
    const srv = createHttps({ key: KEY_PEM, cert: CERT }, (req, res) => {
      hits++;
      req.resume();
      res.end("{}");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as AddressInfo).port;
    const { g, a, sock } = await gate({ model: { baseUrl: `https://localhost:${port}/v1`, seatToken: seat, pins: [CERT_PIN] }, search: null, fetch: "disabled", tls: { allowLoopbackHttp: false, requirePins: true } });
    try {
      const r = await post(sock, "/m/m1/v1/chat/completions", chat);
      assert.equal(r.status, 502);
      assert.match(r.text, /tls_verify_failed/);
      assert.equal(hits, 0);
      const end = a.records.find((x) => x.phase === "end");
      assert.equal(end?.outcome, "failed");
      assert.equal(end?.reason, "tls_verify_failed");
    } finally {
      await g.close();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});
