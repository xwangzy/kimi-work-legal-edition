/**
 * 纯公网 IP 部署：网关、检索调用控制面时 control_plane.connect_address（scripts/lib/cp-connect.mjs）。
 * TCP 连到回环，证书按 control_plane.url 的主机（公网 IP 的 IP SAN）完整核对：SAN 不符、证书链不可信一律拒绝，不关任何校验。
 * 用例里的“公网 IP”用文档保留地址 203.0.113.7 / 198.51.100.9（RFC 5737，本机连不到），所以能连上只可能是走了 connect_address。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error 纯 JS 模块（生产入口的辅助库）
import { connectAddressFetch, controlPlaneFetch } from "../../../scripts/lib/cp-connect.mjs";

const haveOpenssl = spawnSync("openssl", ["version"]).status === 0;
const dir = mkdtempSync(join(tmpdir(), "kwl-cp-connect-"));
const PUBLIC_IP = "203.0.113.7";
const OTHER_IP = "198.51.100.9";
const servers: Server[] = [];
let ca = "";
const seen: Array<{ host: string | undefined; sni: string | false | null; remote: string | undefined; method: string | undefined; body: string }> = [];

const ossl = (...args: string[]) => {
  const r = spawnSync("openssl", args, { encoding: "utf8", cwd: dir });
  assert.equal(r.status, 0, r.stderr);
};
/** 测试 CA 签一张叶子证书。显式选 SHA-256 与命名曲线，避免 OpenSSL 和系统 LibreSSL 的默认值不同。 */
function leaf(name: string, san: string): { cert: string; key: string } {
  ossl("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-pkeyopt", "ec_param_enc:named_curve", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${name}`);
  writeFileSync(join(dir, `${name}.ext`), `subjectAltName=${san}\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\n`);
  ossl("x509", "-req", "-sha256", "-in", `${name}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-days", "1", "-out", `${name}.crt`, "-extfile", `${name}.ext`);
  return { cert: readFileSync(join(dir, `${name}.crt`), "utf8"), key: readFileSync(join(dir, `${name}.key`), "utf8") };
}
async function serve(tls: { cert: string; key: string }): Promise<number> {
  const s = createServer(tls, (req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const sock = req.socket as import("node:tls").TLSSocket;
      seen.push({ host: req.headers.host, sni: sock.servername, remote: sock.remoteAddress, method: req.method, body });
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "https://example.com/" }).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, path: req.url }));
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as AddressInfo).port;
}

let portIp = 0;
let portOther = 0;
let portDns = 0;
before(async () => {
  if (!haveOpenssl) return;
  ossl("req", "-x509", "-sha256", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-pkeyopt", "ec_param_enc:named_curve", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "1", "-subj", "/CN=kwl test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
  ca = readFileSync(join(dir, "ca.crt"), "utf8");
  portIp = await serve(leaf("ip", `IP:${PUBLIC_IP}`));
  portOther = await serve(leaf("other", `IP:${OTHER_IP}`));
  portDns = await serve(leaf("dns", "DNS:cp.kwl.test"));
});
after(() => {
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
});

test("连到回环、证书按 url 里的公网 IP 核对：IP SAN 相符即通；不发 SNI，Host 头是公网 IP", { skip: !haveOpenssl && "本机没有 openssl" }, async () => {
  const f = connectAddressFetch({ origin: `https://${PUBLIC_IP}:${portIp}`, connectAddress: "127.0.0.1", ca });
  const r = await f(`https://${PUBLIC_IP}:${portIp}/v1/feed/gateway?x=1`, { headers: { authorization: "Bearer t" }, redirect: "error" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, path: "/v1/feed/gateway?x=1" });
  const last = seen.at(-1)!;
  assert.equal(last.host, `${PUBLIC_IP}:${portIp}`);
  assert.equal(last.sni, false, "url 主机是 IP 时不发 SNI");
  assert.equal(last.remote, "127.0.0.1");
  // POST 带请求体（额度账本、健康回报）
  const p = await f(`https://${PUBLIC_IP}:${portIp}/v1/quota/lease`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ a: 1 }) });
  assert.equal(p.status, 200);
  assert.equal(seen.at(-1)!.method, "POST");
  assert.equal(seen.at(-1)!.body, '{"a":1}');
});

test("证书 SAN 不含 url 里的 IP：拒绝（换连接地址不放松主机名校验）", { skip: !haveOpenssl && "本机没有 openssl" }, async () => {
  const f = connectAddressFetch({ origin: `https://${PUBLIC_IP}:${portOther}`, connectAddress: "127.0.0.1", ca });
  await assert.rejects(f(`https://${PUBLIC_IP}:${portOther}/v1/meta`), (e: Error & { code?: string }) => e.code === "ERR_TLS_CERT_ALTNAME_INVALID");
  // 同一张证书、url 写它真正的 IP 就通：说明上面拒的是主机名而不是别的
  const g = connectAddressFetch({ origin: `https://${OTHER_IP}:${portOther}`, connectAddress: "127.0.0.1", ca });
  assert.equal((await g(`https://${OTHER_IP}:${portOther}/v1/meta`)).status, 200);
});

test("证书链不可信（不在缺省信任里）：拒绝", { skip: !haveOpenssl && "本机没有 openssl" }, async () => {
  const f = connectAddressFetch({ origin: `https://${PUBLIC_IP}:${portIp}`, connectAddress: "127.0.0.1" });
  await assert.rejects(f(`https://${PUBLIC_IP}:${portIp}/v1/meta`), (e: Error & { code?: string }) => /UNABLE_TO_VERIFY|SELF_SIGNED|UNABLE_TO_GET_ISSUER/.test(String(e.code)));
});

test("url 是域名时照发 SNI、按域名核对", { skip: !haveOpenssl && "本机没有 openssl" }, async () => {
  const f = connectAddressFetch({ origin: `https://cp.kwl.test:${portDns}`, connectAddress: "127.0.0.1", ca });
  assert.equal((await f(`https://cp.kwl.test:${portDns}/v1/meta`)).status, 200);
  assert.equal(seen.at(-1)!.sni, "cp.kwl.test");
});

test("只服务控制面同源请求；不跟随跳转；配置校验", { skip: !haveOpenssl && "本机没有 openssl" }, async () => {
  const f = connectAddressFetch({ origin: `https://${PUBLIC_IP}:${portIp}`, connectAddress: "127.0.0.1", ca });
  await assert.rejects(f("https://example.com/v1/meta"), /只用于控制面/);
  await assert.rejects(f(`https://${PUBLIC_IP}:${portIp}/redirect`, { redirect: "error" }), /跳转 302/);
  assert.throws(() => connectAddressFetch({ origin: `http://${PUBLIC_IP}:8443`, connectAddress: "127.0.0.1" }), /只用于 https/);
  assert.throws(() => connectAddressFetch({ origin: `https://${PUBLIC_IP}:8443`, connectAddress: "localhost" }), /IP 字面量/);
  const fail = (m: string): never => {
    throw new Error(m);
  };
  assert.equal(controlPlaneFetch({ url: `https://${PUBLIC_IP}:8443` }, fail), undefined, "不配就用全局 fetch");
  assert.throws(() => controlPlaneFetch({ url: `https://${PUBLIC_IP}:8443`, connect_address: "cp.internal" }, fail), /须为 IP 字面量/);
  assert.equal(typeof controlPlaneFetch({ url: `https://${PUBLIC_IP}:8443`, connect_address: "127.0.0.1" }, fail), "function");
});
