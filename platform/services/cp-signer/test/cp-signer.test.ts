/**
 * 控制面签名服务 cp-signer（v9.3 A-8；云端持久化与 KMS 设计 v1 §4.8 的用例）：
 * 与进程内签名逐字节相同；按种类拒签并记账；签名账哈希链、记不进去不签；mTLS 只认登记的调用方；
 * 控制面接签名服务后进程内不持私钥（ops.seal 不可用、胡椒必须另给）；席位密钥按受众拆分。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fsyncSync, ftruncateSync, mkdtempSync, readFileSync, writeFileSync, writeSync } from "node:fs";
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
  const svc = createSignerService({ keys, ledgerFile: join(dir, "ledger.jsonl"), initLedger: true, allowedCallers: [], insecureForTest: true });
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
  const svc = createSignerService({ keys, ledgerFile: join(dir, "ledger.jsonl"), initLedger: true, allowedCallers: [], insecureForTest: true });
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
  const svc = createSignerService({ keys, ledgerFile: file, initLedger: true, allowedCallers: [], insecureForTest: true });
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
  const good = openSignerLedger(join(tmp(), "ledger.jsonl"), { createIfMissing: true });
  const broken = { append: () => { throw new Error("磁盘满"); }, head: good.head, broken: () => false, close: good.close };
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
  const svc = createSignerService({ keys, ledgerFile: join(tmp(), "ledger.jsonl"), initLedger: true, allowedCallers: [], insecureForTest: true });
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
  const svc = createSignerService({ keys, ledgerFile: join(dir, "ledger.jsonl"), initLedger: true, allowedCallers: ["spiffe://kwl/test/cp-api"] });
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

test("签名账（复核 RB16A-01/02）：账本不在且没有显式初始化即拒绝启动；写一半或 fsync 失败截回上一条、链不错位；截不回去即停签；末行序号经指标给外部对账", async () => {
  const keys = devControlPlaneKeys();
  const dir = tmp();
  const file = join(dir, "ledger.jsonl");
  assert.throws(() => createSignerService({ keys, ledgerFile: file, allowedCallers: [], insecureForTest: true }), /签名账不存在/, "整本被删也能发现");
  // 写入原语注入：第 2 次写只写进一半然后报错、第 3 次 fsync 报错
  let writes = 0;
  let fsyncs = 0;
  const io = {
    writeSync: (fd: number, buf: Buffer, off: number) => {
      writes += 1;
      if (writes === 2) {
        writeSync(fd, buf.subarray(off, off + 10));
        throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
      }
      return writeSync(fd, buf, off);
    },
    fsyncSync: (fd: number) => {
      fsyncs += 1;
      if (fsyncs === 4) throw Object.assign(new Error("EIO"), { code: "EIO" });
      fsyncSync(fd);
    },
    ftruncateSync,
  };
  const lg = openSignerLedger(file, { createIfMissing: true, io });
  const rec = (n: string) => ({ request_id: n, caller: "c", op: "envelope" as const, kind: "kwl-license", kid: "k", tid: null, body_sha256: null, signed_sha256: "s", result: "ok" as const, reason: null });
  lg.append(rec("r1"), "t");
  assert.throws(() => lg.append(rec("r2"), "t"), /ENOSPC/, "写一半：报错");
  lg.append(rec("r3"), "t");
  assert.throws(() => lg.append(rec("r4"), "t"), /EIO/, "fsync 失败：报错（这一行已截掉）");
  lg.append(rec("r5"), "t");
  const v = verifySignerLedger(readFileSync(file, "utf8"));
  assert.ok(v.ok && v.seq === 3, "只留下 r1、r3、r5 三条完整记录，序号连续");
  assert.deepEqual(readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l).request_id), ["r1", "r3", "r5"]);
  assert.equal(lg.head().seq, 3);
  // 截不回去：置损坏，之后一律拒绝
  const lg2 = openSignerLedger(join(dir, "l2.jsonl"), { createIfMissing: true, io: { writeSync: () => { throw new Error("EIO"); }, fsyncSync, ftruncateSync: () => { throw new Error("EBADF"); } } });
  assert.throws(() => lg2.append(rec("x"), "t"), /EIO/);
  assert.equal(lg2.broken(), true);
  assert.throws(() => lg2.append(rec("y"), "t"), /已损坏/);
  // 指标给出末行序号（外部记下的序号变小即被截尾）
  const svc = createSignerService({ keys, ledgerFile: join(dir, "l3.jsonl"), initLedger: true, allowedCallers: [], insecureForTest: true });
  const base = await listen(svc);
  try {
    await post(base, "/v1/sign/envelope", { request_id: "req-metric-1", req_now: Date.now(), kind: "kwl-device-revoked", body: { tid: "ten_m", device_id: "dev_m", revoked_at: new Date().toISOString() } });
    await post(base, "/v1/sign/seat-token", { request_id: "req-metric-2", req_now: Date.now(), tid: "ten_m", uid: "u", sid: "s", dev: "d", aud: "x".repeat(5000), ttl_s: 900 });
    const m = svc.metrics();
    assert.equal(m.ledger.seq, 2);
    assert.equal(m.ledger.broken, false);
    assert.deepEqual(Object.keys(m.counts).sort(), ["envelope/kwl-device-revoked/ok", "seat_token/invalid/rejected"], "计数键只用登记过的种类与受众（RB16A-03）");
  } finally {
    svc.close();
  }
});

test("远程签名者先验回复再交付（复核 RB16A-04）；等签名期间席位被吊销则不交付令牌（RB16A-05）", async () => {
  // 签名服务报的公钥表与实际签名用的私钥对不上（轮换配错或被替换）：控制面这一侧即报 reply_invalid，不把验不过的信封与令牌交给设备
  const keys = devControlPlaneKeys();
  const other = devControlPlaneKeys();
  const { createServer: mkServer } = await import("node:http");
  const { signerPublicKeys } = await import("../../control-plane/src/index.ts");
  const { sealEnvelope } = await import("@zr-legal/firm-trust");
  const { issueSeatToken } = await import("@zr-legal/seat-token");
  const fake = mkServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/public-keys") return res.end(JSON.stringify(signerPublicKeys(keys)));
      const b = JSON.parse(raw);
      if (req.url === "/v1/sign/envelope") {
        const e = sealEnvelope(b.kind, b.body, { kid: keys.envelope.kid, privateKey: other.envelope.privateKey });
        return res.end(JSON.stringify({ envelope: { kind: e.kind, kid: e.kid, sig: e.sig } }));
      }
      // 席位令牌：签对了，但把席位编号换掉
      return res.end(JSON.stringify({ token: issueSeatToken({ tid: b.tid, uid: b.uid, sid: "seat_other", dev: b.dev, kid: keys.seat.kid }, keys.seat.privateKey, b.ttl_s, b.req_now) }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
  try {
    const remote = await connectRemoteSigner({ url: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`, insecureLoopbackForTest: true });
    const now = Date.now();
    await assert.rejects(remote.sealEnvelope("kwl-device-revoked", { tid: "ten_x", device_id: "dev_x", revoked_at: new Date(now).toISOString() }, now), (e: any) => e.code === "reply_invalid");
    await assert.rejects(remote.issueSeatToken({ tid: "ten_x", uid: "u", sid: "seat_1", dev: "dev_x", ttlSeconds: SEAT_TTL_DEFAULT_SECONDS, at: now }), (e: any) => e.code === "reply_invalid", "字段与申请不一致");
    remote.close?.();
  } finally {
    fake.close();
  }
  // 等签名期间席位被吊销：交付前再核一次，回 403、不给令牌
  const k2 = devControlPlaneKeys();
  const local = localSigner(k2);
  let cpRef: ReturnType<typeof createControlPlane> | null = null;
  const slow: CpSigner = {
    ...local,
    mode: "local",
    sealEnvelope: local.sealEnvelope,
    publicKeys: local.publicKeys,
    async issueSeatToken(r) {
      cpRef!.ops.revokeSeat(r.tid, r.uid);
      return local.issueSeatToken(r);
    },
  };
  const cp = createControlPlane({ signer: slow, serviceSecret: "s".repeat(40), codePepper: Buffer.alloc(32, 3) });
  cpRef = cp;
  await new Promise<void>((r) => cp.server.listen(0, "127.0.0.1", () => r()));
  const cbase = `http://127.0.0.1:${(cp.server.address() as AddressInfo).port}`;
  try {
    const tid = "ten_race";
    cp.ops.createTenant({ activationRequired: false, tid, edition: "team", seats: 2 });
    const root = generateFirmRoot();
    const ts = Date.now();
    const proof = sign(null, enrollProofBytes(tid, root.publicKeyPem, ts), root.privateKeyPem).toString("base64url");
    await fetch(`${cbase}/v1/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tid, root_public_key_pem: root.publicKeyPem, ts, proof }) });
    const dk = generateDeviceKeys();
    const cert = issueDeviceCertificate(root.privateKeyPem, { certId: "cert_race", memberId: "usr_race", deviceId: "dev_race", role: "lawyer", signPublicKeyPem: dk.signPublicKeyPem, encPublicKeyPem: dk.encPublicKeyPem, issuedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86400_000).toISOString() });
    const call = async (method: string, path: string, body?: unknown) => {
      const raw = body === undefined ? "" : JSON.stringify(body);
      const h = signDeviceRequest({ method, path, body: raw, tid, deviceId: "dev_race", signPrivateKeyPem: dk.signPrivateKeyPem });
      const r = await fetch(`${cbase}${path}`, { method, headers: { ...h, ...(raw ? { "content-type": "application/json" } : {}) }, ...(raw ? { body: raw } : {}) });
      return { status: r.status, json: (await r.json()) as any };
    };
    assert.equal((await call("POST", "/v1/devices/register", { tid, cert })).status, 200);
    const r = await call("POST", "/v1/seat-token");
    assert.equal(r.status, 403);
    assert.equal(r.json.error.code, "seat_revoked");
    assert.equal(r.json.token, undefined);
  } finally {
    cp.server.closeAllConnections();
    await new Promise<void>((r) => cp.server.close(() => r()));
  }
});

test("签名账外送（复核 RB16A-01 余项）：按批写到对象存储；启动比对发现截尾、换旧副本与改行；外送一直失败积压过多即停签", async () => {
  const { checkLedgerAgainstArchive, startLedgerArchiver } = await import("../src/index.ts");
  const { fsBlobStore } = await import("@zr-legal/blob-store");
  const keys = devControlPlaneKeys();
  const dir = tmp();
  const file = join(dir, "ledger.jsonl");
  const store = fsBlobStore(join(dir, "worm"));
  const archiver = startLedgerArchiver({ archive: store, ledgerFile: file, intervalMs: 3_600_000 });
  const svc = createSignerService({ keys, ledgerFile: file, initLedger: true, archiver, allowedCallers: [], insecureForTest: true });
  const base = await listen(svc);
  try {
    for (let i = 0; i < 3; i++) await post(base, "/v1/sign/envelope", { request_id: `req-arch-${i}0`, req_now: Date.now(), kind: "kwl-device-revoked", body: { tid: "ten_a", device_id: "dev_a", revoked_at: new Date().toISOString() } });
    await archiver.flush();
    assert.deepEqual(svc.metrics().archive, { pending: 0, archived_seq: 3, failures: 0, conflict: false });
    const keysNow = (await store.list("signer-ledger/")).map((x) => x.key);
    assert.equal(keysNow.length, 1);
    assert.match(keysNow[0]!, /^signer-ledger\/000000000001-000000000003-0{16}-[0-9a-f]{16}\.jsonl$/, "键名带首行 prev 与末行哈希（复核 RC-A-01）");
  } finally {
    await archiver.stop();
    svc.close();
  }
  const text = readFileSync(file, "utf8");
  const ok = await checkLedgerAgainstArchive(text, store);
  assert.ok(ok.ok && ok.archivedSeq === 3 && ok.localSeq === 3 && ok.archivedOffset === Buffer.byteLength(text));
  const lines = text.trim().split("\n");
  const cut = await checkLedgerAgainstArchive(`${lines.slice(0, 2).join("\n")}\n`, store);
  assert.ok(!cut.ok && /被截尾/.test(cut.reason), "截掉末行：外部锚点发现");
  assert.ok(!(await checkLedgerAgainstArchive("", store)).ok, "整本删除后从头新建：发现");
  // 改了最后一行（重算链也没用：与已外送的同序号行不同）
  const tampered = JSON.parse(lines[2]!);
  tampered.tid = "ten_x";
  const rechained = [lines[0], lines[1], JSON.stringify(tampered)].join("\n") + "\n";
  const t2 = await checkLedgerAgainstArchive(rechained, store);
  assert.ok(!t2.ok);
  // 外送一直失败：积压到上限即停签（503）
  const failing = { kind: "s3" as const, put: async () => { throw new Error("down"); }, get: async () => null, delete: async () => {}, list: async () => [] };
  const a2 = startLedgerArchiver({ archive: failing, ledgerFile: join(dir, "l2.jsonl"), intervalMs: 3_600_000, maxPending: 2 });
  const svc2 = createSignerService({ keys, ledgerFile: join(dir, "l2.jsonl"), initLedger: true, archiver: a2, allowedCallers: [], insecureForTest: true });
  const base2 = await listen(svc2);
  try {
    const sign = (i: number) => post(base2, "/v1/sign/envelope", { request_id: `req-back-${i}0`, req_now: Date.now(), kind: "kwl-device-revoked", body: { tid: "ten_a", device_id: "dev_a", revoked_at: new Date().toISOString() } });
    assert.equal((await sign(1)).status, 200);
    assert.equal((await sign(2)).status, 200);
    const r = await sign(3);
    assert.equal(r.status, 503);
    assert.equal(r.json.error, "ledger_archive_backlog");
  } finally {
    await a2.stop(10);
    svc2.close();
  }
});

/** 模拟版本化 + 对象锁的桶：删除只加删除标记、覆盖写成为新的当前版本（复核 RC-A-01 的威胁模型）；条件写已存在即 exists。 */
function versionedStore() {
  const versions = new Map<string, { body: Buffer | null }[]>();
  const live = (k: string) => {
    const v = versions.get(k);
    return v && v[v.length - 1]!.body ? v[v.length - 1]!.body : null;
  };
  return {
    versions,
    store: {
      kind: "s3" as const,
      keyPrefix: "",
      async put(k: string, b: Buffer) {
        versions.set(k, [...(versions.get(k) ?? []), { body: b }]);
      },
      async putIfAbsent(k: string, b: Buffer) {
        if (live(k)) return "exists" as const;
        versions.set(k, [...(versions.get(k) ?? []), { body: b }]);
        return "created" as const;
      },
      async get(k: string) {
        return live(k);
      },
      async delete(k: string) {
        versions.set(k, [...(versions.get(k) ?? []), { body: null }]);
      },
      async list(p: string) {
        return [...versions.keys()].filter((k) => k.startsWith(p) && live(k)).map((key) => ({ key, size: live(key)!.length, mtime: 1 }));
      },
      async listVersions(p: string) {
        return [...versions.entries()].filter(([k]) => k.startsWith(p)).flatMap(([key, vs]) => vs.map((v, i) => ({ key, versionId: String(i), latest: i === vs.length - 1, deleteMarker: v.body === null })));
      },
    },
  };
}

test("签名账外送（余项续复核 RC-A-01/02/06）：删除标记、覆盖写、批次接不上一律拒绝启动；重启补送尾巴；同一批重试不重叠", async () => {
  const { checkLedgerAgainstArchive, startLedgerArchiver } = await import("../src/index.ts");
  const keys = devControlPlaneKeys();
  const dir = tmp();
  const file = join(dir, "ledger.jsonl");
  const v = versionedStore();
  const sign = (base: string, i: number) => post(base, "/v1/sign/envelope", { request_id: `req-ver-${i}0`, req_now: Date.now(), kind: "kwl-device-revoked", body: { tid: "ten_a", device_id: "dev_a", revoked_at: new Date().toISOString() } });
  // 第一轮：记 3 行并外送；再记 2 行后停机（停机时限时补送）
  let a = startLedgerArchiver({ archive: v.store, ledgerFile: file, intervalMs: 3_600_000 });
  let svc = createSignerService({ keys, ledgerFile: file, initLedger: true, archiver: a, allowedCallers: [], insecureForTest: true });
  let base = await listen(svc);
  for (let i = 1; i <= 3; i++) await sign(base, i);
  await a.flush();
  for (let i = 4; i <= 5; i++) await sign(base, i);
  // 模拟被 kill：不调 stop，尾巴（第 4、5 行）没送出去
  svc.close();
  let text = readFileSync(file, "utf8");
  let chk = await checkLedgerAgainstArchive(text, v.store);
  assert.ok(chk.ok && chk.archivedSeq === 3 && chk.localSeq === 5);
  // 重启：从账本文件读出第 4、5 行立刻补送（复核 RC-A-02）
  a = startLedgerArchiver({ archive: v.store, ledgerFile: file, start: { seq: chk.archivedSeq, hash: chk.archivedHash, offset: chk.archivedOffset }, headSeq: chk.localSeq, intervalMs: 3_600_000 });
  await a.flush();
  assert.equal(a.stats().archived_seq, 5);
  svc = createSignerService({ keys, ledgerFile: file, archiver: a, allowedCallers: [], insecureForTest: true });
  base = await listen(svc);
  await sign(base, 6);
  await a.stop(2_000);
  svc.close();
  assert.equal(a.stats().archived_seq, 6, "停机时限时补送尾巴");
  text = readFileSync(file, "utf8");
  chk = await checkLedgerAgainstArchive(text, v.store);
  assert.ok(chk.ok && chk.archivedSeq === 6);
  const batchKeys = [...v.versions.keys()].sort();
  assert.equal(batchKeys.length, 3);
  const lines = text.trim().split("\n");

  // ① 删掉后面的批（只加删除标记）再截尾：拒绝
  const v1 = versionedStore();
  for (const [k, vs] of v.versions) v1.versions.set(k, [...vs]);
  await v1.store.delete(batchKeys[2]!);
  const r1 = await checkLedgerAgainstArchive(`${lines.slice(0, 5).join("\n")}\n`, v1.store);
  assert.ok(!r1.ok && /删除标记/.test(r1.reason), JSON.stringify(r1));
  // ② 改第 2 行、重算链并覆盖写第一批：同一键有两个版本，拒绝
  const v2 = versionedStore();
  for (const [k, vs] of v.versions) v2.versions.set(k, [...vs]);
  await v2.store.put(batchKeys[0]!, Buffer.from("x"));
  const r2 = await checkLedgerAgainstArchive(text, v2.store);
  assert.ok(!r2.ok && /覆盖/.test(r2.reason));
  // ③ 没有版本列举的存储：中间一批被换成接不上的键也发现（批与批首尾相接）
  const { fsBlobStore } = await import("@zr-legal/blob-store");
  const fsStore = fsBlobStore(join(dir, "fs"));
  for (const k of batchKeys) await fsStore.put(k, (await v.store.get(k))!);
  assert.ok((await checkLedgerAgainstArchive(text, fsStore)).ok);
  await fsStore.delete(batchKeys[1]!);
  const r3 = await checkLedgerAgainstArchive(text, fsStore);
  assert.ok(!r3.ok && /不连续/.test(r3.reason));
  // ④ 中间批的末行与本机不同（本机账本整本重算过链）：按键名里的末行哈希发现，不必下载
  const forged = lines.map((l) => JSON.parse(l));
  forged[1].tid = "ten_x";
  const { createHash } = await import("node:crypto");
  let prev = "0".repeat(64);
  const relinked = forged.map((r) => {
    r.prev = prev;
    const line = JSON.stringify(r);
    prev = createHash("sha256").update(line).digest("hex");
    return line;
  });
  const r4 = await checkLedgerAgainstArchive(`${relinked.join("\n")}\n`, v.store);
  assert.ok(!r4.ok && /账本被改过/.test(r4.reason));
  // ⑤ 外送位置里同名对象内容不同（有人抢先写了）：外送器停签
  const probe = versionedStore();
  const ap = startLedgerArchiver({ archive: probe.store, ledgerFile: file, headSeq: 6, intervalMs: 3_600_000 });
  await ap.flush();
  await ap.stop(10);
  const preKey = [...probe.versions.keys()][0]!;
  const v5 = versionedStore();
  await v5.store.put(preKey, Buffer.from("别人写的"));
  const a5 = startLedgerArchiver({ archive: v5.store, ledgerFile: file, headSeq: 6, intervalMs: 3_600_000 });
  await a5.flush();
  assert.equal(a5.stats().conflict, true);
  assert.equal(a5.blocked(), true);
  await a5.stop(10);
  // ⑥ 同一批重试：第一次写进去了但回复丢了 → 第二次 exists 且内容相同 → 视为成功，不写出重叠的批
  const v6 = versionedStore();
  let lose = true;
  const flaky = { ...v6.store, async putIfAbsent(k: string, b: Buffer) {
    const r = await v6.store.putIfAbsent(k, b);
    if (lose) {
      lose = false;
      throw new Error("回复丢了");
    }
    return r;
  } };
  const a6 = startLedgerArchiver({ archive: flaky, ledgerFile: file, headSeq: 6, intervalMs: 3_600_000, now: () => 1e15 });
  await a6.flush();
  assert.equal(a6.stats().archived_seq, 0);
  assert.equal(a6.stats().failures, 1);
  await a6.flush();
  assert.equal(a6.stats().archived_seq, 6);
  assert.equal([...v6.versions.keys()].length, 1, "同一批键名不变");
  assert.ok((await checkLedgerAgainstArchive(text, v6.store)).ok);
  await a6.stop(10);
});
