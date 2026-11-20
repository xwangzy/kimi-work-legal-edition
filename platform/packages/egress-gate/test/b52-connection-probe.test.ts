/**
 * 连接检测与证书类失败的错误代码（第 52 批（第 50 批 IP 部署虚机演练后补））：
 * - 检测走与真实流量相同的传输策略（同一钉住集、同一演示 CA、证书校验不放宽），对 127.0.0.1 上的本机 TLS 服务分出
 *   ok / tls_pin_mismatch / tls_name_mismatch / tls_verify_failed / unreachable / http_<状态> / config_invalid / not_configured；
 * - 钉住不符时请求不到达服务端，只给服务器出示公钥的短前缀；
 * - 闸门自己的证书类拒绝在说明末尾附“[kwl:代码]”（问答与任务据此说清是证书问题，不说成“连不上”）。
 * 证书沿用 ip-cloud-ca.test.ts 的夹具（演示 CA 签发的 IP SAN 叶子、只有域名的叶子、另一把自签）。
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttps, type Server as HttpsServer } from "node:https";
import { createServer as createNet } from "node:net";
import { request } from "node:http";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spkiPin } from "../src/tls-check.ts";
import { pinPrefix, probeFailureClass, probeUpstreams } from "../src/probe.ts";
import { EgressGateServer } from "../src/server.ts";
import type { AuthorizeResult, GateAuthority, GateEgressRecord, GateUpstreams, MatterEgressContext } from "../src/types.ts";
import { ipcPath } from "./ipc-path.ts";

const fx = (n: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url)), "utf8");
const der = (pem: string) => Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ""), "base64");
const DEMO_CA = fx("demo-ca.pem");
const LEAF_IP = fx("demo-leaf-ip.pem");
const LEAF_DNS = fx("demo-leaf-dns.pem");
const SELF_SIGNED = fx("tls-test-cert.pem");
const LEAF_IP_PIN = spkiPin(der(LEAF_IP));
const LEAF_DNS_PIN = spkiPin(der(LEAF_DNS));
const SELF_PIN = spkiPin(der(SELF_SIGNED));
const BACKUP_PIN = `sha256/${Buffer.alloc(32, 5).toString("base64")}`;

async function serve(cert: string, key: string, status = 200): Promise<{ srv: HttpsServer; base: string; port: number; hits: () => number; paths: string[] }> {
  let n = 0;
  const paths: string[] = [];
  const srv = createHttps({ cert, key }, (req, res) => {
    n++;
    paths.push(`${req.method} ${req.url} auth=${req.headers.authorization ? "yes" : "no"}`);
    req.resume();
    res.writeHead(status, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as AddressInfo).port;
  return { srv, port, base: `https://127.0.0.1:${port}/v1`, hits: () => n, paths };
}

/** 一个确定关着的端口（先占再放）。 */
async function closedPort(): Promise<number> {
  const s = createNet();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const strict = { allowLoopbackHttp: false, requirePins: true };

describe("连接检测（probe.ts）：与真实流量同一传输策略", () => {
  let ip: Awaited<ReturnType<typeof serve>>;
  let dns: Awaited<ReturnType<typeof serve>>;
  let self: Awaited<ReturnType<typeof serve>>;
  let busy: Awaited<ReturnType<typeof serve>>;
  before(async () => {
    ip = await serve(LEAF_IP, fx("demo-leaf-ip.key.pem"));
    dns = await serve(LEAF_DNS, fx("demo-leaf-dns.key.pem"));
    self = await serve(SELF_SIGNED, fx("tls-test-key.pem"));
    busy = await serve(LEAF_IP, fx("demo-leaf-ip.key.pem"), 503);
  });
  after(async () => {
    for (const s of [ip, dns, self, busy]) await new Promise<void>((r) => s.srv.close(() => r()));
  });

  test("正确的服务器：ok，主机与端口照写，GET /healthz、不带任何凭据；钉住只给短前缀", async () => {
    const before = ip.paths.length;
    const u: GateUpstreams = { model: null, search: null, fetch: "disabled", controlPlane: { baseUrl: ip.base, pins: [BACKUP_PIN, LEAF_IP_PIN] }, tls: strict, cloudCaPem: DEMO_CA };
    const items = await probeUpstreams(u);
    const cp = items.find((x) => x.upstream === "control_plane")!;
    assert.equal(cp.class, "ok");
    assert.equal(cp.host, "127.0.0.1");
    assert.equal(cp.port, ip.port);
    assert.equal(cp.cloud_ca, true);
    assert.ok(cp.elapsed_ms >= 0);
    assert.deepEqual(ip.paths.slice(before), ["GET /healthz auth=no"]);
    assert.deepEqual(cp.pins, [pinPrefix(BACKUP_PIN), pinPrefix(LEAF_IP_PIN)]);
    for (const p of cp.pins) assert.ok(p.length <= "sha256/".length + 13, "不给全量钉住值");
    // 其余未配置的上游
    assert.deepEqual(items.filter((x) => x.upstream !== "control_plane").map((x) => x.class), ["not_configured", "not_configured", "not_configured", "not_configured", "not_configured", "not_configured"]);
  });

  test("同一 CA、同一 IP、换了私钥（钉住不符）：tls_pin_mismatch，请求不到达服务端，只给服务器公钥短前缀", async () => {
    const before = ip.hits();
    const items = await probeUpstreams({ model: null, search: null, fetch: "disabled", controlPlane: { baseUrl: ip.base, pins: [BACKUP_PIN, SELF_PIN] }, tls: strict, cloudCaPem: DEMO_CA });
    const cp = items.find((x) => x.upstream === "control_plane")!;
    assert.equal(cp.class, "tls_pin_mismatch");
    assert.equal(ip.hits(), before, "握手阶段断开，服务端收不到请求");
    assert.ok(cp.presented.includes(pinPrefix(LEAF_IP_PIN)), "服务器出示的叶子公钥短前缀");
    assert.ok(!JSON.stringify(cp).includes(LEAF_IP_PIN), "不出现全量钉住值");
  });

  test("证书上没有这个 IP（服务器换了 IP）：tls_name_mismatch；自签证书：tls_verify_failed；都不到达服务端", async () => {
    const d0 = dns.hits();
    const s0 = self.hits();
    const items = await probeUpstreams({
      model: null,
      search: null,
      fetch: "disabled",
      dist: { baseUrl: dns.base, seatToken: "", pins: [LEAF_DNS_PIN, BACKUP_PIN] },
      support: { baseUrl: self.base, pins: [SELF_PIN, BACKUP_PIN] },
      tls: strict,
      cloudCaPem: DEMO_CA,
    });
    assert.equal(items.find((x) => x.upstream === "dist")!.class, "tls_name_mismatch");
    assert.equal(items.find((x) => x.upstream === "support")!.class, "tls_verify_failed");
    assert.equal(dns.hits(), d0);
    assert.equal(self.hits(), s0);
  });

  test("正式包不附演示 CA、服务器用演示 CA 签的证书：tls_verify_failed", async () => {
    const items = await probeUpstreams({ model: null, search: null, fetch: "disabled", controlPlane: { baseUrl: ip.base, pins: [LEAF_IP_PIN, BACKUP_PIN] }, tls: strict });
    const cp = items.find((x) => x.upstream === "control_plane")!;
    assert.equal(cp.class, "tls_verify_failed");
    assert.equal(cp.cloud_ca, false);
  });

  test("连不上、服务回 503、安装包配置不合格（http 地址、缺钉住）各自分类", async () => {
    const port = await closedPort();
    const items = await probeUpstreams({
      model: { baseUrl: `https://127.0.0.1:${port}/v1`, seatToken: "x", pins: [LEAF_IP_PIN, BACKUP_PIN] },
      search: { baseUrl: busy.base, seatToken: "x", pins: [LEAF_IP_PIN, BACKUP_PIN] },
      fetch: "disabled",
      notify: { baseUrl: "http://203.0.113.9/v1" },
      relay: { baseUrl: "https://203.0.113.9/v1" },
      tls: strict,
      cloudCaPem: DEMO_CA,
    });
    const by = Object.fromEntries(items.map((x) => [x.upstream, x]));
    assert.equal(by.model!.class, "unreachable");
    assert.equal(by.search!.class, "http_503");
    assert.equal(by.notify!.class, "config_invalid");
    assert.equal(by.notify!.detail, "upstream_tls_required");
    assert.equal(by.relay!.class, "config_invalid");
    assert.equal(by.relay!.detail, "upstream_pins_missing");
    assert.equal(by.relay!.host, "203.0.113.9");
    assert.equal(by.relay!.port, 443);
  });

  test("超时与重定向的分类（纯函数）", () => {
    assert.equal(probeFailureClass(new Error("x"), true).cls, "timeout");
    assert.equal(probeFailureClass(Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }), false).cls, "timeout");
    assert.equal(probeFailureClass(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }), false).cls, "unreachable");
    assert.equal(probeFailureClass(Object.assign(new TypeError("fetch failed"), { cause: new Error("redirect count exceeded") }), false).cls, "http_redirect");
  });
});

describe("闸门自己的证书类拒绝附“[kwl:代码]”", () => {
  test("模型通道钉住不符：502、说明带 [kwl:tls_pin_mismatch]；安装包缺钉住：503、说明带 [kwl:upstream_pins_missing]", async () => {
    const srv = await serve(LEAF_IP, fx("demo-leaf-ip.key.pem"));
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
      tokenizer: { keyB64: Buffer.alloc(32, 7).toString("base64"), parties: [], table: [], fullPseudonym: false, tableVersion: 1 },
    };
    const authority: GateAuthority = {
      authorize: async (): Promise<AuthorizeResult> => ({ ok: true, ctx }),
      record: (_r: GateEgressRecord) => {},
      tokens: () => {},
    };
    const seat = `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.y`;
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "kwl-b50-")));
    const post = (sock: string) =>
      new Promise<{ status: number; text: string }>((resolve, reject) => {
        const body = JSON.stringify({ model: "legal/k3", messages: [{ role: "user", content: "你好" }] });
        const rq = request({ socketPath: sock, path: "/m/m1/v1/chat/completions", method: "POST", headers: { "content-type": "application/json", authorization: "Bearer t" } }, (res) => {
          let t = "";
          res.on("data", (c) => (t += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, text: t }));
        });
        rq.on("error", reject);
        rq.end(body);
      });
    try {
      const sock1 = ipcPath(dir, "g1.sock");
      const g1 = new EgressGateServer({ authority, upstreams: { model: { baseUrl: srv.base, seatToken: seat, pins: [BACKUP_PIN] }, search: null, fetch: "disabled", tls: strict, cloudCaPem: DEMO_CA } });
      await g1.listen(sock1);
      const r1 = await post(sock1);
      await g1.close();
      assert.equal(r1.status, 502, r1.text);
      const e1 = JSON.parse(r1.text).error;
      assert.equal(e1.code, "tls_pin_mismatch");
      assert.match(e1.message, /证书校验未通过.*\[kwl:tls_pin_mismatch\]$/);
      assert.equal(srv.hits(), 0, "请求不到达服务端");

      const sock2 = ipcPath(dir, "g2.sock");
      const g2 = new EgressGateServer({ authority, upstreams: { model: { baseUrl: srv.base, seatToken: seat }, search: null, fetch: "disabled", tls: strict } });
      await g2.listen(sock2);
      const r2 = await post(sock2);
      await g2.close();
      assert.equal(r2.status, 503, r2.text);
      assert.match(JSON.parse(r2.text).error.message, /\[kwl:upstream_pins_missing\]$/);
    } finally {
      await new Promise<void>((r) => srv.srv.close(() => r()));
    }
  });
});
