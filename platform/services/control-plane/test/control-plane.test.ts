/**
 * 控制面最小集 v0（v9 第 02 篇 §7.1 #1–#5、§10；第 06 篇 §1 G0“控制面最小集”）：
 * 开通（律所根公钥入组）、设备登记（证书须由本所律所根签发）、席位令牌（≥ 72 小时）、许可到期不签发、
 * 律所策略与连接器登记的起草—管理员设备签名—发布（诚实控制面同样检查门限）、吊销、网关订阅鉴权。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import { generateDeviceKeys, generateFirmRoot, issueDeviceCertificate, type DeviceCertificate, type DeviceRole } from "@zr-legal/keys";
import { verifySeatToken, MIN_SEAT_TTL_SECONDS } from "@zr-legal/seat-token";
import { enrollProofBytes, openEnvelope, publicKeyMap, signDeviceRequest, strictestTemplate, DIRECTORY_MAX_TTL_MS, type DeviceRevocationNotice, type DirectoryBody, type GatewayFeedBody, type LicenseBody, type SignedFirmPolicy } from "@zr-legal/firm-trust";
import { createControlPlane, devControlPlaneKeys, GatewayFeedSubscriber, type ControlPlane } from "../src/index.ts";

const keys = devControlPlaneKeys();
let cp: ControlPlane;
let base = "";
const SECRET = "cp-test-service-secret";
const root = generateFirmRoot();

before(async () => {
  cp = createControlPlane({ keys, serviceSecret: SECRET });
  await new Promise<void>((r) => cp.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(cp.server.address() as AddressInfo).port}`;
});
after(async () => {
  cp.server.closeAllConnections();
  await new Promise<void>((r) => cp.server.close(() => r()));
});

function cpKeys() {
  return publicKeyMap(cp.publicKeys.envelope);
}

function makeDevice(tid: string, role: DeviceRole, member: string, id: string, rootPriv = root.privateKeyPem) {
  const k = generateDeviceKeys();
  const cert: DeviceCertificate = issueDeviceCertificate(rootPriv, {
    certId: `cert_${id}`,
    memberId: member,
    deviceId: id,
    role,
    signPublicKeyPem: k.signPublicKeyPem,
    encPublicKeyPem: k.encPublicKeyPem,
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 365 * 86400_000).toISOString(),
  });
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const h = signDeviceRequest({ method, path, body: raw, tid, deviceId: id, signPrivateKeyPem: k.signPrivateKeyPem });
    const r = await fetch(`${base}${path}`, { method, headers: { ...h, ...(raw ? { "content-type": "application/json" } : {}) }, ...(raw ? { body: raw } : {}) });
    return { status: r.status, json: await r.json() };
  };
  return { cert, keys: k, call, register: () => call("POST", "/v1/devices/register", { tid, cert }) };
}

async function enroll(tid: string, r = root): Promise<number> {
  const ts = Date.now();
  const proof = sign(null, enrollProofBytes(tid, r.publicKeyPem, ts), r.privateKeyPem).toString("base64url");
  const res = await fetch(`${base}/v1/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tid, root_public_key_pem: r.publicKeyPem, ts, proof }) });
  return res.status;
}

test("开通与设备登记：根公钥入组后，只接受本所律所根签发的证书；席位自动分配并签发 ≥ 72 小时席位令牌", async () => {
  const tid = "ten_cp_basic";
  cp.ops.createTenant({ tid, edition: "team", seats: 2 });
  const admin = makeDevice(tid, "admin", "usr_admin", "dev_admin");
  assert.equal((await admin.register()).json.error.code, "root_not_enrolled");
  assert.equal(await enroll(tid), 200);
  assert.equal(await enroll(tid, generateFirmRoot()), 409, "已入组后不能换成另一把根公钥");
  const reg = await admin.register();
  assert.equal(reg.status, 200);
  assert.ok(reg.json.seat);
  const foreign = makeDevice(tid, "lawyer", "usr_x", "dev_x", generateFirmRoot().privateKeyPem);
  assert.equal((await foreign.register()).json.error.code, "cert_invalid");

  const dir = await admin.call("GET", "/v1/directory");
  const opened = openEnvelope<DirectoryBody>(dir.json, "kwl-device-directory", cpKeys());
  assert.ok(opened.ok);
  assert.deepEqual(opened.ok && opened.body.devices.map((d) => d.deviceId), ["dev_admin"]);

  const lic = openEnvelope<LicenseBody>((await admin.call("GET", "/v1/license")).json, "kwl-license", cpKeys());
  assert.ok(lic.ok && lic.body.edition === "team");
  const seat = await admin.call("POST", "/v1/seat-token", {});
  assert.equal(seat.status, 200);
  const claims = verifySeatToken(seat.json.token, publicKeyMap(cp.publicKeys.seat));
  assert.equal(claims.dev, "dev_admin");
  assert.ok(claims.exp - claims.iat >= MIN_SEAT_TTL_SECONDS);
  assert.ok(claims.exp - claims.iat >= 96 * 3600, "签发 96 小时：客户端剩余不足 73 小时即续期，停机时仍有 ≥ 72 小时（复核 S6-A01）");

  // 新租户的初始策略是最严模板（不比最严模板宽：只有控制面签名即可）
  const pol = openEnvelope<SignedFirmPolicy>((await admin.call("GET", "/v1/policy")).json, "kwl-firm-policy-current", cpKeys());
  assert.ok(pol.ok);
  assert.deepEqual(pol.ok && pol.body.doc.body, strictestTemplate());
  assert.deepEqual(pol.ok && pol.body.admin_signatures, []);
});

test("许可到期不签发席位令牌；吊销的设备、席位不再能续期；已吊销设备的请求得到控制面签名的吊销通知；合伙人设备可吊销", async () => {
  const tid = "ten_cp_revoke";
  cp.ops.createTenant({ tid, edition: "team", seats: 3 });
  assert.equal(await enroll(tid), 200);
  const admin = makeDevice(tid, "admin", "usr_admin", "dev_ra");
  const lawyer = makeDevice(tid, "lawyer", "usr_l", "dev_rl");
  await admin.register();
  await lawyer.register();
  assert.equal((await lawyer.call("POST", "/v1/seat-token", {})).status, 200);
  assert.equal((await lawyer.call("POST", "/v1/devices/dev_ra/revoke", {})).status, 403, "律师设备不能吊销");
  assert.equal((await admin.call("POST", "/v1/seats/usr_l/revoke", {})).status, 200);
  assert.equal((await lawyer.call("POST", "/v1/seat-token", {})).json.error.code, "seat_revoked");
  assert.equal((await admin.call("POST", "/v1/devices/dev_rl/revoke", {})).status, 200);
  const after = await lawyer.call("POST", "/v1/seat-token", {});
  assert.equal(after.status, 403, "吊销的设备不能再续期");
  assert.equal(after.json.error.code, "device_revoked");
  const notice = openEnvelope<DeviceRevocationNotice>(after.json.notice, "kwl-device-revoked", cpKeys());
  assert.ok(notice.ok && notice.body.device_id === "dev_rl" && notice.body.tid === tid, "附带控制面签名的吊销通知（复核 S6-A02、S6-B01）");
  const reg = await lawyer.register();
  assert.equal(reg.json.error.code, "device_revoked");
  assert.ok(openEnvelope<DeviceRevocationNotice>(reg.json.notice, "kwl-device-revoked", cpKeys()).ok, "登记时同样附带通知");
  // 合伙人设备可吊销（与本机吊销的角色口径一致；复核 S6-B04）
  const partner = makeDevice(tid, "partner", "usr_p", "dev_rp");
  await partner.register();
  const extra = makeDevice(tid, "lawyer", "usr_e", "dev_re");
  await extra.register();
  assert.equal((await partner.call("POST", "/v1/devices/dev_re/revoke", {})).status, 200);
  cp.ops.terminateLicense(tid);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await admin.call("POST", "/v1/seat-token", {})).json.error.code, "license_expired");
});

test("许可按设备签到滚动签发（复核 S6-A06）：每次取回都是新签发的 ≤ 30 天许可，不超过订阅截止；终止后签发的许可立即到期", async () => {
  const tid = "ten_cp_license";
  cp.ops.createTenant({ tid, edition: "team", seats: 2, subscriptionDays: 365 });
  assert.equal(await enroll(tid), 200);
  const d = makeDevice(tid, "admin", "usr_lic", "dev_lic");
  await d.register();
  const l1 = openEnvelope<LicenseBody>((await d.call("GET", "/v1/license")).json, "kwl-license", cpKeys());
  await new Promise((r) => setTimeout(r, 5));
  const l2 = openEnvelope<LicenseBody>((await d.call("GET", "/v1/license")).json, "kwl-license", cpKeys());
  assert.ok(l1.ok && l2.ok);
  assert.ok(l1.ok && l2.ok && Date.parse(l2.body.issued_at) > Date.parse(l1.body.issued_at), "每次签到都是新签发");
  assert.ok(l2.ok && Date.parse(l2.body.expires_at) - Date.parse(l2.body.issued_at) <= 30 * 86400_000);
  cp.ops.renewLicense(tid, 3);
  const l3 = openEnvelope<LicenseBody>((await d.call("GET", "/v1/license")).json, "kwl-license", cpKeys());
  assert.ok(l3.ok && Date.parse(l3.body.expires_at) - Date.now() <= 3 * 86400_000 + 5000, "不超过订阅截止");
  cp.ops.terminateLicense(tid);
  await new Promise((r) => setTimeout(r, 5));
  const l4 = openEnvelope<LicenseBody>((await d.call("GET", "/v1/license")).json, "kwl-license", cpKeys());
  assert.ok(l4.ok && Date.parse(l4.body.expires_at) <= Date.now(), "终止后签发的许可立即到期");
});

test("起草—签名—发布：放宽类策略须管理员设备签名（律所版 2 名），版本单调；非管理员设备不能起草", async () => {
  const tid = "ten_cp_policy";
  cp.ops.createTenant({ tid, edition: "firm", seats: 5 });
  assert.equal(await enroll(tid), 200);
  const a = makeDevice(tid, "admin", "usr_a", "dev_pa");
  const b = makeDevice(tid, "admin", "usr_b", "dev_pb");
  const l = makeDevice(tid, "lawyer", "usr_l", "dev_pl");
  for (const d of [a, b, l]) assert.equal((await d.register()).status, 200);
  const relaxed = { max_mode: "auto", auto_preauthorizations: ["search_generalized"], fetch_allowlist_extra: [], l3a_standard_model: "deny" };
  assert.equal((await l.call("POST", "/v1/drafts", { kind: "policy", body: relaxed })).status, 403);
  const d1 = (await a.call("POST", "/v1/drafts", { kind: "policy", body: relaxed })).json;
  assert.deepEqual(d1.relaxations, ["max_mode:auto", "auto_preauthorization:search_generalized"]);
  const id = d1.draft.draft_id as string;
  assert.equal((await a.call("POST", `/v1/drafts/${id}/publish`, {})).json.error.code, "admin_threshold_not_met");
  const { policySigningBytes, adminSign } = await import("@zr-legal/firm-trust");
  const sigA = adminSign(policySigningBytes(d1.draft.doc), a.cert, a.keys.signPrivateKeyPem);
  assert.equal((await a.call("POST", `/v1/drafts/${id}/signatures`, sigA)).status, 200);
  assert.equal((await a.call("POST", `/v1/drafts/${id}/publish`, {})).json.error.code, "admin_threshold_not_met", "律所版须 2 名管理员");
  const sigL = adminSign(policySigningBytes(d1.draft.doc), l.cert, l.keys.signPrivateKeyPem);
  assert.equal((await a.call("POST", `/v1/drafts/${id}/signatures`, sigL)).json.error.code, "admin_signature_invalid", "非管理员证书的签名不收");
  const sigB = adminSign(policySigningBytes(d1.draft.doc), b.cert, b.keys.signPrivateKeyPem);
  assert.equal((await b.call("POST", `/v1/drafts/${id}/signatures`, sigB)).status, 200);
  assert.equal((await b.call("POST", `/v1/drafts/${id}/publish`, {})).status, 200);
  const pol = openEnvelope<SignedFirmPolicy>((await l.call("GET", "/v1/policy")).json, "kwl-firm-policy-current", cpKeys());
  assert.ok(pol.ok && pol.body.doc.version === 2 && pol.body.admin_signatures.length === 2);
});

test("草稿不占版本号（复核 S6-B29）：版本 = 当前已发布版本 + 1；再多未发布的草稿，发布出去的也只比上一版大一；已过时的草稿拒绝发布", async () => {
  const tid = "ten_cp_drafts";
  cp.ops.createTenant({ tid, edition: "team", seats: 5 });
  assert.equal(await enroll(tid), 200);
  const a = makeDevice(tid, "admin", "usr_da", "dev_da");
  assert.equal((await a.register()).status, 200);
  const strict = strictestTemplate();
  const current = cp.ops.tenant(tid)!.policy!.doc.version;
  const drafts = [];
  for (let i = 0; i < 5; i++) drafts.push((await a.call("POST", "/v1/drafts", { kind: "policy", body: strict })).json.draft);
  assert.deepEqual([...new Set(drafts.map((d) => d.doc.version))], [current + 1], "未发布的草稿共用下一个版本号");
  assert.equal((await a.call("POST", `/v1/drafts/${drafts[4].draft_id}/publish`, {})).status, 200);
  assert.equal(cp.ops.tenant(tid)!.policy!.doc.version, current + 1);
  // 同号的其余草稿发布时作废（复核 S6-C11）
  assert.deepEqual((await a.call("GET", "/v1/drafts")).json.drafts, []);
  const gone = await a.call("POST", `/v1/drafts/${drafts[0].draft_id}/publish`, {});
  assert.deepEqual([gone.status, gone.json.error.code], [404, "draft_unknown"]);
  const next = (await a.call("POST", "/v1/drafts", { kind: "policy", body: strict })).json.draft;
  assert.equal(next.doc.version, current + 2);
  // 期间另有更高版本发布（模拟其他途径）：已过时的草稿拒绝发布
  cp.ops.tenant(tid)!.policy!.doc.version = current + 2;
  const stale = await a.call("POST", `/v1/drafts/${next.draft_id}/publish`, {});
  assert.deepEqual([stale.status, stale.json.error.code], [409, "draft_stale"]);
});

test("连接器草稿编号（复核 S6-B29、S6-C06）：版本 = 已发布过的最高版本 + 1；撤下后重新登记不回退", async () => {
  const tid = "ten_cp_conn_ver";
  cp.ops.createTenant({ tid, edition: "team", seats: 5 });
  assert.equal(await enroll(tid), 200);
  const a = makeDevice(tid, "admin", "usr_ca2", "dev_cca2");
  assert.equal((await a.register()).status, 200);
  const { connectorSigningBytes, adminSign } = await import("@zr-legal/firm-trust");
  const connector = {
    connector_id: "firm-dms",
    name: "律所文档系统",
    server: "firm-dms",
    url: "https://dms.example-firm.cn/mcp",
    max_data_level: "L2",
    tools: [{ name: "search", side_effect: "read", schema_hash: "a".repeat(64) }],
  };
  const publish = async () => {
    const d = (await a.call("POST", "/v1/drafts", { kind: "connector", connector })).json.draft;
    const sig = adminSign(connectorSigningBytes(d.doc), a.cert, a.keys.signPrivateKeyPem);
    assert.equal((await a.call("POST", `/v1/drafts/${d.draft_id}/signatures`, sig)).status, 200);
    assert.equal((await a.call("POST", `/v1/drafts/${d.draft_id}/publish`, {})).status, 200);
    return d.doc.version as number;
  };
  assert.equal(await publish(), 1);
  // 未发布的草稿不占版本号
  const d2a = (await a.call("POST", "/v1/drafts", { kind: "connector", connector })).json.draft;
  const d2b = (await a.call("POST", "/v1/drafts", { kind: "connector", connector })).json.draft;
  assert.deepEqual([d2a.doc.version, d2b.doc.version], [2, 2]);
  assert.equal(await publish(), 2);
  // 撤下后重新登记：版本不回退
  assert.equal((await a.call("DELETE", "/v1/connectors/firm-dms")).status, 200);
  assert.equal(await publish(), 3);
});

test("预先吊销（复核 S6-B31）：吊销尚未登记的设备编号——列入目录与网关订阅，之后它登记即收到吊销通知；编号不合法即拒绝", async () => {
  const tid = "ten_cp_prerevoke";
  cp.ops.createTenant({ tid, edition: "team", seats: 5 });
  assert.equal(await enroll(tid), 200);
  const a = makeDevice(tid, "admin", "usr_pa", "dev_ppa");
  assert.equal((await a.register()).status, 200);
  const later = makeDevice(tid, "lawyer", "usr_pl", "dev_ppl");
  // 尚未登记的设备只凭它的律所根签发证书预先吊销（复核 S6-C05）：不附证书、证书非本所根签发或编号不符一律拒绝
  assert.equal((await a.call("POST", "/v1/devices/dev_ppl/revoke", {})).json.error.code, "cert_required");
  const foreign = makeDevice(tid, "lawyer", "usr_pl", "dev_ppl", generateFirmRoot().privateKeyPem);
  assert.equal((await a.call("POST", "/v1/devices/dev_ppl/revoke", { cert: foreign.cert })).json.error.code, "cert_invalid");
  assert.equal((await a.call("POST", "/v1/devices/dev_ppx/revoke", { cert: later.cert })).json.error.code, "cert_invalid", "编号不符");
  assert.equal((await a.call("POST", "/v1/devices/dev_ppl/revoke", { cert: later.cert })).status, 200);
  assert.equal(cp.ops.tenant(tid)!.preRevoked.get("dev_ppl")?.by, "dev_ppa", "记下发起吊销的设备");
  const dir = openEnvelope<DirectoryBody>((await a.call("GET", "/v1/directory")).json, "kwl-device-directory", cpKeys());
  assert.ok(dir.ok && dir.body.revoked_devices.some((r) => r.device_id === "dev_ppl"), "列入目录");
  const feed = await fetch(`${base}/v1/feed/gateway`, { headers: { authorization: `Bearer ${SECRET}` } });
  const fb = openEnvelope<GatewayFeedBody>(await feed.json(), "kwl-gateway-feed", cpKeys());
  assert.ok(fb.ok && fb.body.revoked_devices.some((r) => r.tid === tid && r.device_id === "dev_ppl"), "列入网关订阅");
  const reg = await later.register();
  assert.equal(reg.status, 403);
  assert.equal(reg.json.error.code, "device_revoked");
  const n = openEnvelope<DeviceRevocationNotice>(reg.json.notice, "kwl-device-revoked", cpKeys());
  assert.ok(n.ok && n.body.device_id === "dev_ppl");
  assert.equal((await a.call("POST", "/v1/devices/dev%2Eppl/revoke", {})).json.error.code, "device_id_invalid");
});

test("预先吊销的数量上限（复核 S6-C09、S6-C16）：每租户达到上限即拒绝（409 pre_revocation_limit），已登记设备的吊销不受影响", async () => {
  const small = createControlPlane({ keys: devControlPlaneKeys(), serviceSecret: "cap-secret", maxPreRevoked: 2 });
  const tid = "ten_cp_cap";
  small.ops.createTenant({ tid, edition: "team", seats: 5 });
  small.ops.tenant(tid)!.root_public_key_pem = root.publicKeyPem;
  for (const id of ["dev_cap_1", "dev_cap_2"]) small.ops.revokeDevice(tid, id, { cert: makeDevice(tid, "lawyer", `usr_${id}`, id).cert, by: "dev_admin" });
  assert.throws(() => small.ops.revokeDevice(tid, "dev_cap_3", { cert: makeDevice(tid, "lawyer", "usr_dev_cap_3", "dev_cap_3").cert, by: "dev_admin" }), (e: Error & { code?: string }) => e.code === "pre_revocation_limit");
  assert.equal(small.ops.tenant(tid)!.preRevoked.size, 2);
  // 已登记设备的吊销不受上限影响
  const reg = makeDevice(tid, "lawyer", "usr_cap_reg", "dev_cap_reg");
  small.ops.tenant(tid)!.devices.set("dev_cap_reg", { cert: reg.cert, registered_at: new Date().toISOString(), revoked_at: null });
  small.ops.revokeDevice(tid, "dev_cap_reg");
  assert.ok(small.ops.tenant(tid)!.devices.get("dev_cap_reg")!.revoked_at);
});

test("设备目录的有效期（复核 S6-C01）：签发与到期取同一时刻——控制面时钟每次读取都前进 1 毫秒时，有效期仍恰为 30 天", async () => {
  let t = Date.now();
  const tick = createControlPlane({ keys: devControlPlaneKeys(), serviceSecret: "tick-secret", now: () => (t += 1) });
  await new Promise<void>((r) => tick.server.listen(0, "127.0.0.1", () => r()));
  try {
    const tbase = `http://127.0.0.1:${(tick.server.address() as AddressInfo).port}`;
    const tid = "ten_cp_tick";
    tick.ops.createTenant({ tid, edition: "team", seats: 5 });
    const ts = t;
    const proof = sign(null, enrollProofBytes(tid, root.publicKeyPem, ts), root.privateKeyPem).toString("base64url");
    assert.equal((await fetch(`${tbase}/v1/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tid, root_public_key_pem: root.publicKeyPem, ts, proof }) })).status, 200);
    const k = generateDeviceKeys();
    const cert = issueDeviceCertificate(root.privateKeyPem, {
      certId: "cert_dev_tick",
      memberId: "usr_tick",
      deviceId: "dev_tick",
      role: "lawyer",
      signPublicKeyPem: k.signPublicKeyPem,
      encPublicKeyPem: k.encPublicKeyPem,
      issuedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 365 * 86400_000).toISOString(),
    });
    const call = async (method: string, path: string, body?: unknown) => {
      const raw = body === undefined ? "" : JSON.stringify(body);
      const h = signDeviceRequest({ method, path, body: raw, tid, deviceId: "dev_tick", signPrivateKeyPem: k.signPrivateKeyPem, now: t });
      return fetch(`${tbase}${path}`, { method, headers: { ...h, ...(raw ? { "content-type": "application/json" } : {}) }, ...(raw ? { body: raw } : {}) });
    };
    assert.equal((await call("POST", "/v1/devices/register", { tid, cert })).status, 200);
    for (let i = 0; i < 20; i++) {
      const dir = openEnvelope<DirectoryBody>(await (await call("GET", "/v1/directory")).json(), "kwl-device-directory", publicKeyMap(tick.publicKeys.envelope));
      assert.ok(dir.ok);
      if (dir.ok) assert.ok(Date.parse(dir.body.expires_at) - Date.parse(dir.body.issued_at) <= DIRECTORY_MAX_TTL_MS, `第 ${i} 次：有效期超过 30 天`);
    }
  } finally {
    tick.server.closeAllConnections();
    await new Promise<void>((r) => tick.server.close(() => r()));
  }
});

test("时钟偏差（复核 S6-B37）：设备签名请求的时间戳偏差超过 5 分钟即拒绝，并附控制面当前时间（客户端据此提示校准系统时间）", async () => {
  const tid = "ten_cp_clock";
  cp.ops.createTenant({ tid, edition: "team", seats: 5 });
  assert.equal(await enroll(tid), 200);
  const a = makeDevice(tid, "admin", "usr_ca", "dev_cca");
  assert.equal((await a.register()).status, 200);
  const raw = "";
  const h = signDeviceRequest({ method: "GET", path: "/v1/license", body: raw, tid, deviceId: "dev_cca", signPrivateKeyPem: a.keys.signPrivateKeyPem, now: Date.now() - 10 * 60_000 });
  const r = await fetch(`${base}/v1/license`, { headers: h });
  const j = (await r.json()) as { error: { code: string }; server_time?: string };
  assert.equal(r.status, 401);
  assert.equal(j.error.code, "device_auth_stale");
  assert.ok(j.server_time && Math.abs(Date.parse(j.server_time) - Date.now()) < 60_000);
  // 登记接口同样附控制面时间（复核 S6-C02：每次同步第一步就是登记）
  const body = JSON.stringify({ tid, cert: a.cert });
  const hr = signDeviceRequest({ method: "POST", path: "/v1/devices/register", body, tid, deviceId: "dev_cca", signPrivateKeyPem: a.keys.signPrivateKeyPem, now: Date.now() - 10 * 60_000 });
  const rr = await fetch(`${base}/v1/devices/register`, { method: "POST", headers: { ...hr, "content-type": "application/json" }, body });
  const rj = (await rr.json()) as { error: { code: string }; server_time?: string };
  assert.deepEqual([rr.status, rj.error.code, typeof rj.server_time], [401, "device_auth_stale", "string"]);
});

test("网关订阅：只认服务凭据；含吊销集与事项匿名摘要（不含事项名称与内容）", async () => {
  const tid = "ten_cp_feed";
  cp.ops.createTenant({ tid, edition: "team", seats: 2 });
  assert.equal(await enroll(tid), 200);
  const d = makeDevice(tid, "admin", "usr_f", "dev_f");
  await d.register();
  const anon = "A".repeat(22);
  const put = await d.call("PUT", `/v1/anon-matters/${anon}`, { anon, level: "L3b", endpoint: "private", basis_complete: true, version: 3, updated_at: new Date().toISOString() });
  assert.equal(put.status, 200);
  assert.equal((await d.call("PUT", `/v1/anon-matters/${anon}`, { anon, level: "L2", endpoint: "standard", basis_complete: true, version: 4, updated_at: new Date().toISOString(), title: "x" })).status, 400, "摘要只收固定字段");
  // 信息落后的设备（较低版本）不能把摘要改回较宽；同一版本按更严合并（复核 S6-A07）
  assert.equal((await d.call("PUT", `/v1/anon-matters/${anon}`, { anon, level: "L2", endpoint: "standard", basis_complete: true, version: 2, updated_at: new Date().toISOString() })).status, 200);
  const anon2 = "B".repeat(22);
  await d.call("PUT", `/v1/anon-matters/${anon2}`, { anon: anon2, level: "L2", endpoint: "standard", basis_complete: true, version: 5, updated_at: new Date().toISOString() });
  await d.call("PUT", `/v1/anon-matters/${anon2}`, { anon: anon2, level: "L3a", endpoint: "standard", basis_complete: false, version: 5, updated_at: new Date().toISOString() });
  assert.equal((await fetch(`${base}/v1/feed/gateway`)).status, 401);
  assert.equal((await fetch(`${base}/v1/feed/gateway`, { headers: { authorization: "Bearer wrong" } })).status, 401);
  const feed = await (await fetch(`${base}/v1/feed/gateway`, { headers: { authorization: `Bearer ${SECRET}` } })).json();
  const opened = openEnvelope<GatewayFeedBody>(feed, "kwl-gateway-feed", cpKeys());
  assert.ok(opened.ok);
  const m = opened.ok ? opened.body.matters.find((x) => x.anon === anon) : null;
  assert.deepEqual(m && Object.keys(m).sort(), ["anon", "basis_complete", "endpoint", "level", "tid", "updated_at", "version"]);
  assert.equal(m?.level, "L3b", "较低版本没有覆盖");
  const m2 = opened.ok ? opened.body.matters.find((x) => x.anon === anon2) : null;
  assert.deepEqual([m2?.level, m2?.basis_complete], ["L3a", false], "同版本按更严合并");
});

test("真实订阅器：只认控制面签名、版本只进不退、吊销粘滞并按租户区分、不合法的摘要丢弃", async () => {
  const tid = "ten_cp_sub";
  cp.ops.createTenant({ tid, edition: "team", seats: 2 });
  assert.equal(await enroll(tid), 200);
  const d = makeDevice(tid, "admin", "usr_sub", "dev_sub");
  const x = makeDevice(tid, "lawyer", "usr_subx", "dev_subx");
  await d.register();
  await x.register();
  const sub = new GatewayFeedSubscriber({ url: `${base}/v1/feed/gateway`, serviceSecret: SECRET, keys: cpKeys(), minRefreshMs: 0 });
  await sub.refresh();
  assert.ok(sub.ready());
  const v1 = sub.currentVersion;
  cp.ops.revokeDevice(tid, "dev_subx");
  await sub.refresh();
  assert.ok(sub.currentVersion > v1);
  assert.equal(sub.revokedDevice(tid, "dev_subx"), true);
  assert.equal(sub.revokedDevice("ten_other", "dev_subx"), false, "按租户区分");
  // 伪造的订阅（别的密钥签名）不被接受；吊销保持
  const forged = new GatewayFeedSubscriber({ url: `${base}/v1/feed/gateway`, serviceSecret: SECRET, keys: publicKeyMap({ x: (await import("node:crypto")).generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" }).toString() }), minRefreshMs: 0 });
  await forged.refresh();
  assert.equal(forged.ready(), false, "信封不是固定的控制面公钥签的：拒收");
  assert.equal(forged.stats.rejected, 1);
  // 不合法的摘要条目丢弃（订阅器按 validateSummary 过滤）
  const t = cp.ops.tenant(tid)!;
  t.anon.set("C".repeat(22), { anon: "C".repeat(22), level: "L9" as never, endpoint: "standard", basis_complete: true, version: 1, updated_at: new Date().toISOString() });
  cp.ops.touch();
  await sub.refresh();
  assert.equal(sub.matter(tid, "C".repeat(22)), null);
  assert.ok(sub.stats.droppedSummaries >= 1);
  // 版本只进不退、吊销粘滞：先收高版本（含吊销），再收低版本（不含吊销）与更高版本（不再列出吊销）
  let next: unknown = null;
  const scripted = new GatewayFeedSubscriber({ url: "http://feed.invalid/v1/feed/gateway", serviceSecret: SECRET, keys: cpKeys(), minRefreshMs: 0, fetchImpl: (async () => new Response(JSON.stringify(next))) as unknown as typeof fetch });
  const body = (version: number, revoked: GatewayFeedBody["revoked_devices"]): GatewayFeedBody => ({ version, issued_at: new Date().toISOString(), revoked_devices: revoked, revoked_seats: [], matters: [], policies: [] });
  next = cp.ops.seal("kwl-gateway-feed", body(50, [{ tid, device_id: "dev_lost" }]));
  await scripted.refresh();
  assert.equal(scripted.currentVersion, 50);
  next = cp.ops.seal("kwl-gateway-feed", body(40, []));
  await scripted.refresh();
  assert.equal(scripted.currentVersion, 50, "低版本订阅拒收");
  assert.equal(scripted.stats.rejected, 1);
  next = cp.ops.seal("kwl-gateway-feed", body(60, []));
  await scripted.refresh();
  assert.equal(scripted.currentVersion, 60);
  assert.equal(scripted.revokedDevice(tid, "dev_lost"), true, "吊销粘滞：之后的订阅不再列出也不恢复");
});
