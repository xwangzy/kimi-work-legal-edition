/**
 * V12 出站代理：运行环境只允许经 HTTP CONNECT 代理出网时（律所内网、云端容器），闸门按显式配置的代理建隧道；
 * 只改“怎么连”不改“连谁”——证书校验与钉住集照常对目标服务器核对，回环地址不走代理，代理地址带口令或写错按未配置处理。
 * 改前：upstreamFetch 只用直连 Agent，配置了代理也直连（容器里直连被拒，真实模型一次都调不通）。
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttps, type Server as HttpsServer } from "node:https";
import { createServer as createHttp, type Server as HttpServer } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spkiPin } from "../src/tls-check.ts";
import { transportFailureReason, upstreamFetch, viaProxy } from "../src/tls-policy.ts";

const fx = (n: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url)), "utf8");
const CERT = fx("tls-test-cert.pem");
const KEY_PEM = fx("tls-test-key.pem");
const CERT_PIN = spkiPin(Buffer.from(CERT.replace(/-----[^-]+-----|\s/g, ""), "base64"));
const OTHER_PIN = `sha256/${Buffer.alloc(32, 7).toString("base64")}`;

describe("闸门经 CONNECT 代理出站", () => {
  let target: HttpsServer;
  let proxy: HttpServer;
  let targetUrl = "";
  let proxyUrl = "";
  const tunnels: string[] = [];
  let targetHits = 0;
  before(async () => {
    target = createHttps({ key: KEY_PEM, cert: CERT }, (req, res) => {
      targetHits++;
      req.resume();
      res.end("ok");
    });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", () => r()));
    targetUrl = `https://localhost:${(target.address() as AddressInfo).port}/v1/chat/completions`;
    proxy = createHttp((_req, res) => {
      res.writeHead(405);
      res.end();
    });
    proxy.on("connect", (req, sock, head) => {
      tunnels.push(String(req.url));
      const [host, port] = String(req.url).split(":");
      const up = connect(Number(port), host === "localhost" ? "127.0.0.1" : host!, () => {
        sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) up.write(head);
        up.pipe(sock);
        sock.pipe(up);
      });
      up.on("error", () => sock.destroy());
      sock.on("error", () => up.destroy());
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
    proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  });
  after(async () => {
    proxy.closeAllConnections();
    target.closeAllConnections();
    await new Promise<void>((r) => proxy.close(() => r()));
    await new Promise<void>((r) => target.close(() => r()));
  });

  test("配置代理：经 CONNECT 隧道到达目标，代理看到的是目标主机与端口，证书仍对目标核对", async () => {
    const f = upstreamFetch({ pins: [], proxy: { url: proxyUrl, caPem: CERT } });
    const r = await f(targetUrl, { method: "POST", body: "{}" });
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "ok");
    assert.ok(tunnels.some((t) => t.startsWith("localhost:")), `代理应收到 CONNECT localhost:…，实际 ${JSON.stringify(tunnels)}`);
  });

  test("经代理时钉住集照常核对：不符即在握手阶段断开，目标收不到请求", async () => {
    const before = targetHits;
    const f = upstreamFetch({ pins: [OTHER_PIN], proxy: { url: proxyUrl, caPem: CERT } });
    const e = await f(targetUrl, { method: "POST", body: "令牌化后的正文" }).then(() => null, (x: unknown) => x);
    assert.ok(e, "应当失败");
    assert.equal(transportFailureReason(e, false), "tls_pin_mismatch");
    assert.equal(targetHits, before);
    const ok = await upstreamFetch({ pins: [CERT_PIN], proxy: { url: proxyUrl, caPem: CERT } })(targetUrl, { method: "POST", body: "{}" });
    assert.equal(ok.status, 200);
  });

  test("代理的根证书只追加信任：不给就按系统根校验，自签目标失败关闭", async () => {
    const e = await upstreamFetch({ pins: [], proxy: { url: proxyUrl } })(targetUrl, { method: "POST", body: "{}" }).then(() => null, (x: unknown) => x);
    assert.ok(e, "应当失败");
    assert.equal(transportFailureReason(e, false), "tls_verify_failed");
  });

  test("哪些上游走代理：回环地址、未配置、地址缺失一律直连", () => {
    const p = { url: proxyUrl };
    assert.deepEqual(viaProxy("https://maas.example.cn/v1", p), p);
    assert.equal(viaProxy("http://127.0.0.1:7801/v1", p), null);
    assert.equal(viaProxy("http://localhost:7801/v1", p), null);
    assert.equal(viaProxy("https://maas.example.cn/v1", null), null);
    assert.equal(viaProxy(undefined, p), null);
  });
});
