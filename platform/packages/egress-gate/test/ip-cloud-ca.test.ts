/**
 * 公网 IP 部署（偏离 D-212）：中软云端没有域名时，证书按 IP 地址（IP SAN）核对；演示环境的私有 CA 只对中软上游生效、替换公共根，
 * 钉住集照常必须命中——不放宽任何一项证书校验。
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttps, type Server as HttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { spkiPin } from "../src/tls-check.ts";
import { transportFailureReason, upstreamFetch } from "../src/tls-policy.ts";
import { gateUpstreamsFromEnv } from "../../kernel/src/egress/kernel-gate.ts";

const fx = (n: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url)), "utf8");
const der = (pem: string) => Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ""), "base64");
const DEMO_CA = fx("demo-ca.pem");
const LEAF_IP = fx("demo-leaf-ip.pem");
const LEAF_DNS = fx("demo-leaf-dns.pem");
const SELF_SIGNED = fx("tls-test-cert.pem"); // 另一把自签 CA（同样带 IP:127.0.0.1）
const LEAF_IP_PIN = spkiPin(der(LEAF_IP));
const LEAF_DNS_PIN = spkiPin(der(LEAF_DNS));
const SELF_PIN = spkiPin(der(SELF_SIGNED));
const BACKUP_PIN = `sha256/${Buffer.alloc(32, 5).toString("base64")}`;

async function serve(cert: string, key: string): Promise<{ srv: HttpsServer; url: string; hits: () => number }> {
  let n = 0;
  const srv = createHttps({ cert, key }, (req, res) => {
    n++;
    req.resume();
    res.end("ok");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  return { srv, url: `https://127.0.0.1:${(srv.address() as AddressInfo).port}/v1/meta`, hits: () => n };
}

describe("按 IP 地址访问中软云端", () => {
  let ip: Awaited<ReturnType<typeof serve>>;
  let dns: Awaited<ReturnType<typeof serve>>;
  let other: Awaited<ReturnType<typeof serve>>;
  before(async () => {
    ip = await serve(LEAF_IP, fx("demo-leaf-ip.key.pem"));
    dns = await serve(LEAF_DNS, fx("demo-leaf-dns.key.pem"));
    other = await serve(SELF_SIGNED, fx("tls-test-key.pem"));
  });
  after(async () => {
    for (const s of [ip, dns, other]) await new Promise<void>((r) => s.srv.close(() => r()));
  });

  const fails = async (f: typeof fetch, url: string) => {
    const e = await f(url).then(() => null, (x: unknown) => x);
    assert.ok(e, "应当失败");
    return transportFailureReason(e, false);
  };

  test("演示 CA + IP SAN + 钉住（叶子当前 + 备份）：正常往返", async () => {
    const r = await upstreamFetch({ pins: [BACKUP_PIN, LEAF_IP_PIN], caPem: DEMO_CA })(ip.url);
    assert.equal(r.status, 200);
  });

  test("钉住演示 CA 本身（链上任一证书命中即可）也能往返", async () => {
    const r = await upstreamFetch({ pins: [spkiPin(der(DEMO_CA)), BACKUP_PIN], caPem: DEMO_CA })(ip.url);
    assert.equal(r.status, 200);
  });

  test("不附演示 CA：只认公共根，证书校验失败、请求不到达服务端", async () => {
    const before = ip.hits();
    assert.equal(await fails(upstreamFetch({ pins: [LEAF_IP_PIN, BACKUP_PIN] }), ip.url), "tls_verify_failed");
    assert.equal(ip.hits(), before);
  });

  test("附了演示 CA 但钉住不符：握手阶段断开（tls_pin_mismatch），请求不到达服务端", async () => {
    const before = ip.hits();
    assert.equal(await fails(upstreamFetch({ pins: [BACKUP_PIN], caPem: DEMO_CA }), ip.url), "tls_pin_mismatch");
    assert.equal(ip.hits(), before);
  });

  test("证书只写了域名（没有该 IP 的 SAN）：按 IP 访问即失败——不因为 CA 可信就放过主机身份", async () => {
    const before = dns.hits();
    assert.equal(await fails(upstreamFetch({ pins: [LEAF_DNS_PIN, BACKUP_PIN], caPem: DEMO_CA }), dns.url), "tls_verify_failed");
    assert.equal(dns.hits(), before);
  });

  test("演示 CA 替换而非追加：别的 CA 签的证书即使钉住命中也不被接受", async () => {
    const before = other.hits();
    assert.equal(await fails(upstreamFetch({ pins: [SELF_PIN, BACKUP_PIN], caPem: DEMO_CA }), other.url), "tls_verify_failed");
    assert.equal(other.hits(), before);
  });
});

describe("内核把私有 CA 交给闸门", () => {
  const base = { ZR_GATEWAY_BASE: "https://203.0.113.10:8444/v1", ZR_GATEWAY_PINS: `${LEAF_IP_PIN},${BACKUP_PIN}`, ZR_CONTROL_PLANE_BASE: "https://203.0.113.10:8443", ZR_CONTROL_PLANE_PINS: `${LEAF_IP_PIN},${BACKUP_PIN}`, ZR_UPSTREAM_TLS: "strict" };

  test("ZR_CLOUD_CA_PEM 进入闸门上游配置；缺省不带", () => {
    assert.equal(gateUpstreamsFromEnv({ ...base, ZR_CLOUD_CA_PEM: DEMO_CA }, { seatToken: "t" }).cloudCaPem, DEMO_CA);
    assert.equal(gateUpstreamsFromEnv(base, { seatToken: "t" }).cloudCaPem, undefined);
    // 不像证书的值不进入（失败关闭：按公共根校验）
    assert.equal(gateUpstreamsFromEnv({ ...base, ZR_CLOUD_CA_PEM: "not a pem" }, { seatToken: "t" }).cloudCaPem, undefined);
  });

  test("IP 地址的上游在安装包形态照常要求钉住", () => {
    const u = gateUpstreamsFromEnv({ ...base, ZR_GATEWAY_PINS: "" }, { seatToken: "t" });
    assert.equal(u.tls?.requirePins, true);
    assert.deepEqual(u.model?.pins, undefined);
  });
});
