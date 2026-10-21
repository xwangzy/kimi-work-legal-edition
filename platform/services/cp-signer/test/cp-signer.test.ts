/**
 * 控制面签名服务 cp-signer（v9.3 A-8；云端持久化与 KMS 设计 v1 §4.8 的用例）：
 * 与进程内签名逐字节相同；按种类拒签并记账；签名账哈希链、记不进去不签；mTLS 只认登记的调用方；
 * 控制面接签名服务后进程内不持私钥（ops.seal 不可用、胡椒必须另给）；席位密钥按受众拆分。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDeviceKeys, generateFirmRoot, issueDeviceCertificate } from "@zr-legal/keys";
import { enrollProofBytes, openEnvelope, publicKeyMap, signDeviceRequest, type LicenseBody } from "@zr-legal/firm-trust";
import { verifySeatToken } from "@zr-legal/seat-token";
import {
  connectRemoteSigner,
  createControlPlane,
  devControlPlaneKeys,
  localSigner,
  NOTIFY_TOKEN_TTL_SECONDS,
  RELAY_TOKEN_TTL_SECONDS,
  SEAT_TTL_BOUNDS,
  SEAT_TTL_DEFAULT_SECONDS,
  SUPPORT_TOKEN_TTL_SECONDS,
  type CpSigner,
} from "../../control-plane/src/index.ts";
import { createSignerService, openSignerLedger, verifySignerLedger, type SignerService } from "../src/index.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "kwl-signer-"));

async function listen(svc: SignerService): Promise<string> {
  await new Promise<void>((r) => svc.server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(svc.server.address() as AddressInfo).port}`;
}

async function post(base: string, path: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
}

test("与进程内签名逐字节相同：信封与四类席位令牌；客户端照常验过；受众令牌由各自的密钥签、通用公钥表验不过", async () => {
  const keys = devControlPlaneKeys({ audiences: true });
  const dir = tmp();
  const svc = createSignerService({ keys, ledgerFile: join(dir, "ledger.jsonl"), allowedCallers: [], insecureForTest: true });
  const base = await listen(svc);
  const remote = await connectRemoteSigner({ url: base, insecureLoopbackForTest: true });
  const local = localSigner(keys);
  try {
    const at = Date.now();
    const lic: LicenseBody = { tid: "ten_gold", edition: "team", seats: 3, issued_at: new Date(at).toISOString(), expires_at: new Date(at + 30 * 86400_000).toISOString() };
    const a = await local.sealEnvelope("kwl-license", lic, at);
    const b = await remote.sealEnvelope("kwl-license", lic, at);
    assert.deepEqual(b, a, "Ed25519 确定性签名：远程与进程内逐字节相同");
    assert.ok(openEnvelope(b, "kwl-license", publicKeyMap(remote.publicKeys().envelope)).ok);
    const general = publicKeyMap({ [remote.publicKeys().seat_general]: remote.publicKeys().seat[remote.publicKeys().seat_general]! });
    for (const [aud, ttl] of [[undefined, SEAT_TTL_DEFAULT_SECONDS], ["support", SUPPORT_TOKEN_TTL_SECONDS], ["notify", NOTIFY_TOKEN_TTL_SECONDS], ["relay", RELAY_TOKEN_TTL_SECONDS]] as const) {
      const req = { tid: "ten_gold", uid: "usr_a", sid: "seat_1", dev: "dev_a", ttlSeconds: ttl, at, ...(aud ? { aud } : {}) };
      const tl = await local.issueSeatToken(req);
      const tr = await remote.issueSeatToken(req);
      assert.equal(tr, tl, `${aud ?? "通用"}：逐字节相同`);
      const all = publicKeyMap(remote.publicKeys().seat);
      const claims = verifySeatToken(tr, all, { ...(aud ? { audience: aud } : {}) });
      if (aud) {
        assert.equal(claims.kid, remote.publicKeys().seat_audiences[aud], "受众令牌由该受众的密钥签");
        assert.throws(() => verifySeatToken(tr, general, { audience: aud }), /unknown_key/, "只放通用公钥的服务（网关）不认受众令牌");
      } else assert.equal(claims.kid, keys.seat.kid);
    }
    // 签名账：每次签名一行、链完整、不含文档内容
    const text = readFileSync(join(dir, "ledger.jsonl"), "utf8");
    assert.equal(verifySignerLedger(text).ok, true);
    assert.equal(text.trim().split("\n").length, 5);
    assert.ok(!text.includes("ten_gold\",\"edition") && !text.includes('"seats"'), "账里只有摘要，没有文档");
  } finally {
    remote.close?.();
    svc.close();
  }
});

test("拒签并记账：未登记种类、夹带原始字节、时刻偏差、有效期超限、文档不合格、受众不认、字段越界", async () => {
  const keys = devControlPlaneKeys({ audiences: true });
  const dir = tmp();
  const svc = createSignerService({ keys, ledgerFile: join(dir, "ledger.jsonl"), allowedCallers: [], insecureForTest: true });
  const base = await listen(svc);
  try {
    const now = Date.now();
    const lic = { tid: "ten_r", edition: "team", seats: 1, issued_at: new Date(now).toISOString(), expires_at: new Date(now + 30 * 86400_000).toISOString() };
    const env = (x: Record<string, unknown>) => post(base, "/v1/sign/envelope", { request_id: "req-0000001", req_now: Date.now(), ...x });
    const seat = (x: Record<string, unknown>) => post(base, "/v1/sign/seat-token", { request_id: "req-0000002", req_now: Date.now(), tid: "ten_r", uid: "usr_a", sid: "seat_1", dev: "dev_a", ttl_s: SEAT_TTL_DEFAULT_SECONDS, ...x });
    const cases: [Promise<{ status: number; json: any }>, string][] = [
      [env({ kind: "kwl-anything", body: {} }), "kind_not_allowed"],
      [env({ kind: "kwl-license", body: lic, bytes: "a3dsLWNvbnRyb2wtcGxhbmU=" }), "field_not_allowed"],
      [env({ kind: "kwl-license", body: lic, req_now: Date.now() - 60_000 }), "req_now_skew"],
      [env({ kind: "kwl-license", body: { ...lic, expires_at: new Date(now + 31 * 86400_000).toISOString() } }), "license_ttl_too_long"],
      [env({ kind: "kwl-license", body: { ...lic, issued_at: new Date(now - 3600_000).toISOString(), expires_at: new Date(now + 86400_000).toISOString() } }), "issued_at_not_now"],
      [env({ kind: "kwl-tenant-salt", body: { tid: "ten_r", purpose: "anon_matter", salt_b64: "c2hvcnQ=", issued_at: new Date(now).toISOString() } }), "salt_too_short"],
      [env({ kind: "kwl-device-revoked", body: { tid: "ten_r", device_id: "dev/../x", revoked_at: new Date(now).toISOString() } }), "revoked_malformed"],
      [env({ kind: "kwl-firm-policy-current", body: { doc: { kind: "nope" }, admin_signatures: [] } }), "policy_doc_invalid"],
      [seat({ ttl_s: 200 * 3600 }), "ttl_out_of_range"],
      [seat({ ttl_s: 3600 }), "ttl_out_of_range"],
      [seat({ aud: "support", ttl_s: 3600 }), "ttl_out_of_range"],
      [seat({ aud: "gateway" }), "audience_not_allowed"],
      [seat({ dev: "dev a" }), "seat_fields_invalid"],
      [seat({ kid: "seat-dev1" }), "field_not_allowed"],
      [post(base, "/v1/sign/seat-token", { req_now: Date.now(), tid: "ten_r" }), "request_id_invalid"],
    ];
    for (const [p, code] of cases) {
      const r = await p;
      assert.equal(r.status, 400, code);
      assert.equal(r.json.error, code);
    }
    const text = readFileSync(join(dir, "ledger.jsonl"), "utf8");
    const recs = text.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(recs.length, cases.length, "每次拒签都记账");
    assert.ok(recs.every((r) => r.result === "rejected" && r.signed_sha256 === null));
    assert.equal(verifySignerLedger(text).ok, true);
    assert.equal(svc.metrics().counts["envelope/kwl-license/rejected"], 4);
  } finally {
    svc.close();
  }
});

test("签名账：被改动即不启动；记不进去就不签（503、没有签名交出）", async () => {
  const keys = devControlPlaneKeys();
  const dir = tmp();
  const file = join(dir, "ledger.jsonl");
  const svc = createSignerService({ keys, ledgerFile: file, allowedCallers: [], insecureForTest: true });
  const base = await listen(svc);
  const now = Date.now();
  const body = { tid: "ten_l", device_id: "dev_l", revoked_at: new Date(now).toISOString() };
  assert.equal((await post(base, "/v1/sign/envelope", { request_id: "req-ledger-1", req_now: Date.now(), kind: "kwl-device-revoked", body })).status, 200);
  assert.equal((await post(base, "/v1/sign/envelope", { request_id: "req-ledger-2", req_now: Date.now(), kind: "kwl-device-revoked", body })).status, 200);
  svc.close();
  // 改动第一行：链断开，重新打开即拒绝
  const lines = readFileSync(file, "utf8").split("\n");
  writeFileSync(file, [lines[0]!.replace("ten_l", "ten_x"), ...lines.slice(1)].join("\n"));
  assert.equal(verifySignerLedger(readFileSync(file, "utf8")).ok, false);
  assert.throws(() => createSignerService({ keys, ledgerFile: file, allowedCallers: [], insecureForTest: true }), /签名账核验不通过/);
  // 账本写不进去：不交出签名
  const good = openSignerLedger(join(tmp(), "ledger.jsonl"));
  const broken = { append: () => { throw new Error("磁盘满"); }, head: good.head, close: good.close };
  const svc2 = createSignerService({ keys, ledger: broken, allowedCallers: [], insecureForTest: true });
  const base2 = await listen(svc2);
  try {
    const r = await post(base2, "/v1/sign/envelope", { request_id: "req-ledger-3", req_now: Date.now(), kind: "kwl-device-revoked", body });
    assert.equal(r.status, 503);
    assert.equal(r.json.error, "ledger_unavailable");
    assert.equal(r.json.envelope, undefined);
  } finally {
    svc2.close();
  }
});

test("控制面接签名服务：设备照常取许可、目录与四类凭据；进程内没有私钥（ops.seal 不可用、胡椒必须另给）；签名服务停了回 503", async () => {
  const keys = devControlPlaneKeys({ audiences: true });
  const svc = createSignerService({ keys, ledgerFile: join(tmp(), "ledger.jsonl"), allowedCallers: [], insecureForTest: true });
  const sbase = await listen(svc);
  const signer: CpSigner = await connectRemoteSigner({ url: sbase, insecureLoopbackForTest: true });
  assert.throws(() => createControlPlane({ signer, serviceSecret: "s".repeat(40) }), /胡椒/);
  const cp = createControlPlane({ signer, serviceSecret: "s".repeat(40), codePepper: Buffer.alloc(32, 7) });
  await new Promise<void>((r) => cp.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(cp.server.address() as AddressInfo).port}`;
  try {
    assert.throws(() => cp.ops.seal("kwl-license", {}), /进程内/);
    assert.deepEqual(Object.keys(cp.publicKeys.seatFor("relay")), ["seat-relay-dev1"], "中继只拿自己受众的公钥");
    assert.deepEqual(Object.keys(cp.publicKeys.seatFor()), ["seat-dev1"]);
    const tid = "ten_remote";
    cp.ops.createTenant({ activationRequired: false, tid, edition: "team", seats: 2 });
    const root = generateFirmRoot();
    const ts = Date.now();
    const proof = sign(null, enrollProofBytes(tid, root.publicKeyPem, ts), root.privateKeyPem).toString("base64url");
    assert.equal((await fetch(`${base}/v1/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tid, root_public_key_pem: root.publicKeyPem, ts, proof }) })).status, 200);
    const k = generateDeviceKeys();
    const cert = issueDeviceCertificate(root.privateKeyPem, { certId: "cert_r", memberId: "usr_r", deviceId: "dev_r", role: "admin", signPublicKeyPem: k.signPublicKeyPem, encPublicKeyPem: k.encPublicKeyPem, issuedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86400_000).toISOString() });
    const call = async (method: string, path: string, body?: unknown) => {
      const raw = body === undefined ? "" : JSON.stringify(body);
      const h = signDeviceRequest({ method, path, body: raw, tid, deviceId: "dev_r", signPrivateKeyPem: k.signPrivateKeyPem });
      const r = await fetch(`${base}${path}`, { method, headers: { ...h, ...(raw ? { "content-type": "application/json" } : {}) }, ...(raw ? { body: raw } : {}) });
      return { status: r.status, json: (await r.json()) as any };
    };
    assert.equal((await call("POST", "/v1/devices/register", { tid, cert })).status, 200);
    const envKeys = publicKeyMap(cp.publicKeys.envelope);
    assert.ok(openEnvelope((await call("GET", "/v1/license")).json, "kwl-license", envKeys).ok);
    assert.ok(openEnvelope((await call("GET", "/v1/directory")).json, "kwl-device-directory", envKeys).ok);
    assert.ok(openEnvelope((await call("GET", "/v1/tenant-salt")).json, "kwl-tenant-salt", envKeys).ok);
    assert.ok(openEnvelope((await call("GET", "/v1/policy")).json, "kwl-firm-policy-current", envKeys).ok);
    assert.ok(openEnvelope((await call("GET", "/v1/connectors")).json, "kwl-firm-connectors", envKeys).ok);
    assert.ok(openEnvelope((await call("GET", "/v1/quota")).json, "kwl-quota-view", envKeys).ok);
    assert.ok(openEnvelope((await call("GET", "/v1/audit")).json, "kwl-cp-audit-page", envKeys).ok);
    const feed = await fetch(`${base}/v1/feed/gateway`, { headers: { authorization: `Bearer ${"s".repeat(40)}` } });
    assert.ok(openEnvelope(await feed.json(), "kwl-gateway-feed", envKeys).ok);
    const seat = (await call("POST", "/v1/seat-token")).json.token as string;
    verifySeatToken(seat, publicKeyMap(cp.publicKeys.seatFor()));
    for (const aud of ["support", "notify", "relay"] as const) {
      const tok = (await call("POST", `/v1/${aud}-token`)).json.token as string;
      verifySeatToken(tok, publicKeyMap(cp.publicKeys.seatFor(aud)), { audience: aud, requireAudience: true });
      assert.throws(() => verifySeatToken(tok, publicKeyMap(cp.publicKeys.seatFor()), { audience: aud }), /unknown_key/);
    }
    // 吊销通知同样经签名服务签
    cp.ops.revokeDevice(tid, "dev_r");
    const revoked = await call("GET", "/v1/license");
    assert.equal(revoked.status, 403);
    assert.ok(openEnvelope(revoked.json.notice, "kwl-device-revoked", envKeys).ok);
    // 签名服务停了：控制面回 503（不降级为进程内签名）
    svc.close();
    svc.server.closeAllConnections();
    signer.close?.();
    const r = await fetch(`${base}/v1/feed/gateway`, { headers: { authorization: `Bearer ${"s".repeat(40)}` } });
    assert.equal(r.status, 503);
    assert.equal(((await r.json()) as any).error.code, "signer_unavailable");
  } finally {
    cp.server.closeAllConnections();
    await new Promise<void>((r) => cp.server.close(() => r()));
    svc.close();
  }
});

test("有效期范围与控制面常量一致", () => {
  assert.ok(SEAT_TTL_DEFAULT_SECONDS >= SEAT_TTL_BOUNDS.general[0] && SEAT_TTL_DEFAULT_SECONDS <= SEAT_TTL_BOUNDS.general[1]);
  assert.equal(SUPPORT_TOKEN_TTL_SECONDS, SEAT_TTL_BOUNDS.support[1]);
  assert.equal(NOTIFY_TOKEN_TTL_SECONDS, SEAT_TTL_BOUNDS.notify[1]);
  assert.equal(RELAY_TOKEN_TTL_SECONDS, SEAT_TTL_BOUNDS.relay[1]);
});

const haveOpenssl = spawnSync("openssl", ["version"]).status === 0;

test("mTLS：只认登记的调用方证书；别的证书 403、不带证书握手失败", { skip: !haveOpenssl && "本机没有 openssl", timeout: 60_000 }, async () => {
  const dir = tmp();
  const ossl = (args: string[]) => {
    const r = spawnSync("openssl", args, { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
  ossl(["req", "-x509", ...ec, "-keyout", "ca.key", "-out", "ca.crt", "-days", "1", "-subj", "/CN=kwl-test-ca"]);
  const leaf = (name: string, ext: string) => {
    writeFileSync(join(dir, `${name}.ext`), ext);
    ossl(["req", ...ec, "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${name}`]);
    ossl(["x509", "-req", "-in", `${name}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.crt`, "-days", "1", "-extfile", `${name}.ext`]);
  };
  leaf("signer", "subjectAltName=IP:127.0.0.1,URI:spiffe://kwl/test/cp-signer\n");
  leaf("cpapi", "subjectAltName=URI:spiffe://kwl/test/cp-api\n");
  leaf("other", "subjectAltName=URI:spiffe://kwl/test/gateway\n");
  const f = (n: string) => readFileSync(join(dir, n), "utf8");
  const keys = devControlPlaneKeys();
  const svc = createSignerService({ keys, ledgerFile: join(dir, "ledger.jsonl"), allowedCallers: ["spiffe://kwl/test/cp-api"] });
  const handler = svc.server.listeners("request")[0] as (...a: unknown[]) => void;
  const https = createHttpsServer({ cert: f("signer.crt"), key: f("signer.key"), ca: f("ca.crt"), requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.2" }, handler);
  await new Promise<void>((r) => https.listen(0, "127.0.0.1", () => r()));
  const url = `https://127.0.0.1:${(https.address() as AddressInfo).port}`;
  try {
    const ok = await connectRemoteSigner({ url, tls: { cert: f("cpapi.crt"), key: f("cpapi.key"), ca: f("ca.crt") } });
    const now = Date.now();
    const e = await ok.sealEnvelope("kwl-device-revoked", { tid: "ten_m", device_id: "dev_m", revoked_at: new Date(now).toISOString() }, now);
    assert.ok(openEnvelope(e, "kwl-device-revoked", publicKeyMap(ok.publicKeys().envelope)).ok);
    const rec = JSON.parse(readFileSync(join(dir, "ledger.jsonl"), "utf8").trim());
    assert.equal(rec.caller, "spiffe://kwl/test/cp-api", "签名账记下调用方证书身份");
    ok.close?.();
    await assert.rejects(connectRemoteSigner({ url, tls: { cert: f("other.crt"), key: f("other.key"), ca: f("ca.crt") } }), /caller_not_allowed/);
    // 不带客户端证书：握手即被拒
    const noCert = await new Promise<string>((resolve) => {
      const req = httpsRequest(`${url}/v1/public-keys`, { ca: f("ca.crt") }, (res) => resolve(`status ${res.statusCode}`));
      req.on("error", (err) => resolve(`error ${(err as NodeJS.ErrnoException).code ?? err.message}`));
      req.end();
    });
    assert.match(noCert, /^error /);
    assert.equal(svc.metrics().counts["caller/rejected"], 1);
  } finally {
    https.closeAllConnections();
    https.close();
    svc.close();
  }
});
