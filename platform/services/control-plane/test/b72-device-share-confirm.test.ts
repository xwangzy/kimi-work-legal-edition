/**
 * 第 72 批（U-2，D-304）：团队成员由账号签发钥（account_ca）直接登记的电脑“事后确认”为可接收团队共享事项。
 * 复用入组申请记录（kind = "upgrade"）：成员电脑凭本人会话 + 本机设备签名发起；律所根电脑上的有效管理员核对核对码后，
 * 用律所根签同编号、同公钥、同成员与角色的新证书批准；控制面把设备记录的证书原位替换，成员电脑凭设备签名取回。
 *
 * 安全不变量（逐条一个用例）：
 * S1 控制面不能自己把 account_ca 电脑变成律所根电脑——批准只认律所根签名（账号签发钥伪造的、别的根签的一律 cert_mismatch，登记同样拒）；
 * S2 被移出 / 停用的成员不能发起，也不能被批准（申请从待确认列表消失、批准 409 upgrade_stale）；角色被调低后原申请作废；
 * S3 批准的证书公钥须与申请里的、与设备记录里的一致（换签名公钥或加密公钥 → cert_mismatch，设备记录不变）；
 * S4 核对码：申请里的编号与公钥就是成员电脑本机的（两端按同一函数独立算出同一串 12 位数字；人工核对在内核用例里强制）；
 * S5 账号签发钥电脑仍不能做律所根动作（列申请、批准、发邀请）——包括 account_ca 的管理员电脑；
 * S6 升级后旧 account_ca 证书不再被接受为这台设备的身份（重新登记 409 device_cert_superseded，设备记录仍是律所根证书）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDeviceKeys, generateFirmRoot, issueDeviceCertificate, type DeviceCertificate, type DeviceRole } from "@zr-legal/keys";
import { deviceEnrollProofBytes, enrollProofBytes, firmBundleBytes, joinCheckCode, openEnvelope, publicKeyMap, signDeviceRequest } from "@zr-legal/firm-trust";
import { accountDeviceId, createAuditLog, createControlPlane, devControlPlaneKeys, UsageBook, type ControlPlane } from "../src/index.ts";

const keys = devControlPlaneKeys({ accountCa: true });
const SECRET = "b72-u2-service-secret-0123456789abcdef0";
const PW = "Lawyer2026secure";
const auditLog = createAuditLog();
let cp: ControlPlane;
let base = "";
const dir = mkdtempSync(join(tmpdir(), "kwl-b72u2-"));

before(async () => {
  cp = createControlPlane({ keys, auditLog, serviceSecret: SECRET, usageBook: new UsageBook({ dir: join(dir, "usage") }), routing: { bootstrap: { provider: { base_url: "https://maas.example.test/v1" } }, key_id: "0123456789abcdef" } });
  await new Promise<void>((r) => cp.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(cp.server.address() as AddressInfo).port}`;
});
after(async () => {
  cp.server.closeAllConnections();
  await new Promise<void>((r) => cp.server.close(() => r()));
});

const req = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const raw = body === undefined ? undefined : JSON.stringify(body);
  const r = await fetch(`${base}${path}`, { method, headers: { ...(raw ? { "content-type": "application/json" } : {}), ...headers }, ...(raw ? { body: raw } : {}) });
  return { status: r.status, json: (await r.json()) as any };
};
const S = (session: string) => ({ "x-kwl-session": session });
const post = (path: string, body: unknown, session?: string) => req("POST", path, body, session ? S(session) : {});
const get = (path: string, session?: string) => req("GET", path, undefined, session ? S(session) : {});

function deviceOf(tid: string, cert: DeviceCertificate, k: ReturnType<typeof generateDeviceKeys>) {
  const callDev = async (method: string, path: string, body?: unknown, session?: string) => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const h = signDeviceRequest({ method, path, body: raw, tid, deviceId: cert.deviceId, signPrivateKeyPem: k.signPrivateKeyPem });
    const r = await fetch(`${base}${path}`, { method, headers: { ...h, ...(raw ? { "content-type": "application/json" } : {}), ...(session ? S(session) : {}) }, ...(raw ? { body: raw } : {}) });
    return { status: r.status, json: (await r.json()) as any };
  };
  return { k, cert, tid, call: callDev, register: (c: DeviceCertificate = cert, session?: string) => callDev("POST", "/v1/devices/register", { tid, cert: c }, session) };
}

/** 自助注册个人工作室 → 创始开通 → 登记创始电脑（律所根签发）；返回律所根私钥（用例扮演管理员电脑的内核签发证书）。 */
async function signup(email: string, name: string, org: string) {
  const reg = await post("/v1/auth/register", { email, password: PW, name, org_name: org, client: { version: "0.11.0", platform: "win32" } });
  assert.equal(reg.status, 200, JSON.stringify(reg.json));
  const onb = reg.json.onboarding;
  const tid = onb.claim.tid as string;
  const root = generateFirmRoot();
  const recovery = generateFirmRoot();
  const ts = Date.now();
  const proof = sign(null, enrollProofBytes(tid, root.publicKeyPem, ts), root.privateKeyPem).toString("base64url");
  const firm_bundle = { recovery_public_key_pem: recovery.publicKeyPem, sig: sign(null, firmBundleBytes(tid, root.publicKeyPem, recovery.publicKeyPem), root.privateKeyPem).toString("base64url") };
  assert.equal((await post("/v1/enroll", { tid, root_public_key_pem: root.publicKeyPem, ts, proof, activation_id: onb.claim.activation_id, claim_secret: onb.claim.claim_secret, firm_bundle })).status, 200);
  const memberId = `usr_${tid.slice(4)}_${onb.member.slug}`;
  const k = generateDeviceKeys();
  const deviceId = accountDeviceId(tid.slice(4), onb.member.slug, 1);
  const cert = issueDeviceCertificate(root.privateKeyPem, { certId: `cert_${deviceId}`, memberId, deviceId, role: "admin" as DeviceRole, signPublicKeyPem: k.signPublicKeyPem, encPublicKeyPem: k.encPublicKeyPem, issuedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 365 * 86400_000).toISOString() });
  const dev = deviceOf(tid, cert, k);
  assert.equal((await dev.register(cert, reg.json.session_token)).status, 200);
  return { tid, aid: reg.json.account.aid as string, memberId, dev, root, session: reg.json.session_token as string };
}

/** 以一份登录 / 切换应答（needs_device_auto）在新电脑上由账号签发钥直接登记（会话绑上）。 */
async function enrollFrom(r: any) {
  assert.equal(r.onboarding.state, "needs_device_auto", JSON.stringify(r.onboarding));
  const k = generateDeviceKeys();
  const deviceId = String(r.onboarding.device_id);
  const proof = sign(null, deviceEnrollProofBytes({ tid: r.onboarding.tid, aid: r.account.aid, sid: r.session.sid, deviceId, signPublicKeyPem: k.signPublicKeyPem, encPublicKeyPem: k.encPublicKeyPem }), k.signPrivateKeyPem).toString("base64url");
  const e = await post("/v1/auth/devices/enroll", { device_id: deviceId, sign_pub: k.signPublicKeyPem, enc_pub: k.encPublicKeyPem, proof, client: { version: "0.11.0", platform: "darwin" } }, r.session_token);
  assert.equal(e.status, 200, JSON.stringify(e.json));
  const o = openEnvelope<any>(e.json, "kwl-device-enroll", publicKeyMap(cp.publicKeys.envelope));
  assert.ok(o.ok);
  const dev = deviceOf(r.onboarding.tid, (o.ok ? o.body : null).cert, k);
  assert.equal((await dev.register(dev.cert, r.session_token)).status, 200);
  return dev;
}

/** 管理员电脑内核的签发（与 onboarding.ts membersApi.approve 同形）：律所根签同编号、给定公钥、同成员与角色。 */
function rootCert(rootPriv: string, x: { deviceId: string; memberId: string; role: string; signPub: string; encPub: string }): DeviceCertificate {
  const now = Date.now();
  return issueDeviceCertificate(rootPriv, { certId: `cert_${x.deviceId}_${now.toString(36)}`, memberId: x.memberId, deviceId: x.deviceId, role: x.role as DeviceRole, signPublicKeyPem: x.signPub, encPublicKeyPem: x.encPub, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 365 * 86400_000).toISOString() });
}

const W = { version: "0.11.0", platform: "darwin" };
type Member = { aid: string; session: string; dev: ReturnType<typeof deviceOf> };
let A: Awaited<ReturnType<typeof signup>>;
let L: Member; // 律师（主角）
let M: Member; // 将被移出
let N: Member; // 将被停用
let P: Member; // 合伙人（将被调低角色）
let aNew: ReturnType<typeof deviceOf>; // 甲自己的第二台电脑（account_ca，管理员角色）
const admin = () => A.dev;

async function joinTeam(email: string, name: string, role: string): Promise<Member> {
  const inv = await post("/v1/team/invites", { name, role }, A.session);
  assert.equal(inv.status, 200, JSON.stringify(inv.json));
  const me = await signup(email, name, `${name}工作室`);
  const j = await post("/v1/teams/join", { code: inv.json.code, client: W }, me.session);
  assert.equal(j.status, 200, JSON.stringify(j.json));
  return { aid: j.json.account.aid, session: j.json.session_token, dev: await enrollFrom(j.json) };
}
const upgrade = (m: Member) => m.dev.call("POST", "/v1/join-requests/upgrade", {}, m.session);
const pendingList = async () => {
  const r = await admin().call("GET", "/v1/join-requests");
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.join_requests as any[];
};

test("准备：甲（团队管理员，律所根电脑）；乙丙丁戊以账号签发钥电脑加入团队；甲在第二台电脑上登录（account_ca 管理员电脑）", async () => {
  A = await signup("a-u2@example.cn", "甲律师", "甲工作室");
  assert.equal((await post("/v1/workspace/upgrade", { name: "甲律师事务所" }, A.session)).status, 200);
  L = await joinTeam("l-u2@example.cn", "乙律师", "lawyer");
  M = await joinTeam("m-u2@example.cn", "丙律师", "lawyer");
  N = await joinTeam("n-u2@example.cn", "丁律师", "lawyer");
  P = await joinTeam("p-u2@example.cn", "戊律师", "partner");
  assert.equal(L.dev.cert.issuer, "account_ca");
  const meta = await get("/v1/meta");
  assert.ok(meta.json.features.includes("device_share_confirm"));
  const lg = await post("/v1/auth/login", { email: "a-u2@example.cn", password: PW, client: W });
  assert.equal(lg.status, 200, JSON.stringify(lg.json));
  aNew = await enrollFrom(lg.json);
  assert.equal(aNew.cert.issuer, "account_ca");
  assert.equal(aNew.cert.role, "admin");
});

test("发起：要本人会话 + 本机设备签名；个人空间 / 已是律所根电脑拒绝；同一台重发原样返回；电脑行标“待确认”", async () => {
  const noSession = await L.dev.call("POST", "/v1/join-requests/upgrade", {});
  assert.equal(noSession.status, 401, JSON.stringify(noSession.json));
  const wrongSession = await L.dev.call("POST", "/v1/join-requests/upgrade", {}, M.session);
  assert.equal(wrongSession.status, 403, JSON.stringify(wrongSession.json));
  const unsigned = await post("/v1/join-requests/upgrade", {}, L.session);
  assert.equal(unsigned.status, 401, "不带设备签名不行");
  const r1 = await upgrade(L);
  assert.equal(r1.status, 200, JSON.stringify(r1.json));
  assert.equal(r1.json.status, "pending");
  assert.match(r1.json.join_request_id, /^jr_[A-Za-z0-9_-]{16}$/);
  const r2 = await upgrade(L);
  assert.equal(r2.json.join_request_id, r1.json.join_request_id, "同一台同时只一个待处理申请");
  // 律所根电脑本身：已可接收
  const self = await A.dev.call("POST", "/v1/join-requests/upgrade", {}, A.session);
  assert.deepEqual([self.status, self.json.error?.code], [409, "already_firm_root"]);
  // 个人空间
  const X = await signup("x-u2@example.cn", "己律师", "己工作室");
  const px = await X.dev.call("POST", "/v1/join-requests/upgrade", {}, X.session);
  assert.deepEqual([px.status, px.json.error?.code], [409, "team_only"]);
  const devs = await get("/v1/firm/devices", A.session);
  assert.equal(devs.status, 200, JSON.stringify(devs.json));
  const row = devs.json.devices.find((d: any) => d.device_id === L.dev.cert.deviceId);
  assert.deepEqual([row.issuer, row.share_pending], ["account_ca", true]);
  // 不进“待批准的新电脑”旧口径（那台电脑早已登记）
  const mem = await get("/v1/firm/members", A.session);
  assert.ok(!mem.json.pending_joins.some((x: any) => x.device_id === L.dev.cert.deviceId));
});

test("S4：管理员电脑列出的申请里，编号与两把公钥就是成员电脑本机的——两端各自算出的 12 位核对码逐位一致", async () => {
  const x = (await pendingList()).find((j) => j.device_id === L.dev.cert.deviceId);
  assert.ok(x, "律所根管理员电脑看得到");
  assert.deepEqual([x.kind, x.via, x.role, x.account.name, x.account.email], ["upgrade", "upgrade", "lawyer", "乙律师", null]);
  // 补测 D3：没起名的电脑按最近一次桌面登录的平台与第几台派生（与客户端电脑选择页同一口径）
  const nth = /_D(\d+)$/.exec(L.dev.cert.deviceId)?.[1] ?? "1";
  assert.equal(x.device_name, `Mac 电脑 · 第 ${nth} 台`);
  const memberSide = joinCheckCode({ tid: A.tid, deviceId: L.dev.cert.deviceId, signPublicKeyPem: L.dev.k.signPublicKeyPem, encPublicKeyPem: L.dev.k.encPublicKeyPem });
  const adminSide = joinCheckCode({ tid: A.tid, deviceId: x.device_id, signPublicKeyPem: x.sign_pub, encPublicKeyPem: x.enc_pub });
  assert.match(memberSide, /^\d{3} \d{3} \d{3} \d{3}$/);
  assert.equal(adminSide, memberSide);
});

test("S5：账号签发钥电脑不能做律所根动作——列申请、批准、发邀请一律 firm_root_device_required（包括甲自己的 account_ca 管理员电脑）", async () => {
  const id = (await pendingList()).find((j) => j.device_id === L.dev.cert.deviceId).id;
  for (const d of [aNew, L.dev]) {
    const ls = await d.call("GET", "/v1/join-requests");
    assert.equal(ls.status, 403, JSON.stringify(ls.json));
    const ap = await d.call("POST", `/v1/join-requests/${id}/approve`, { cert: rootCert(A.root.privateKeyPem, { deviceId: L.dev.cert.deviceId, memberId: L.dev.cert.memberId, role: "lawyer", signPub: L.dev.k.signPublicKeyPem, encPub: L.dev.k.encPublicKeyPem }) });
    assert.equal(ap.status, 403, JSON.stringify(ap.json));
  }
  const ga = await aNew.call("GET", "/v1/join-requests");
  assert.equal(ga.json.error.code, "firm_root_device_required");
  const inv = await aNew.call("POST", "/v1/invitations", { member_slug: "m-x", name: "x", role: "lawyer", ttl_hours: 1 });
  assert.deepEqual([inv.status, inv.json.error.code], [403, "firm_root_device_required"]);
  assert.equal(cp.ops.tenant(A.tid)!.devices.get(L.dev.cert.deviceId)!.cert.issuer, "account_ca", "什么都没变");
});

test("S1：控制面不能自己把 account_ca 电脑变成律所根电脑——账号签发钥签的“律所根证书”、别家律所根签的证书，批准与登记都拒绝", async () => {
  const id = (await pendingList()).find((j) => j.device_id === L.dev.cert.deviceId).id;
  const now = Date.now();
  const caPriv = keys.accountDeviceCa!.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  // 控制面手里只有账号签发钥：用它签一张不写 issuer（= 声称律所根）的证书
  const forged = issueDeviceCertificate(caPriv, { certId: `cert_forged_${now}`, memberId: L.dev.cert.memberId, deviceId: L.dev.cert.deviceId, role: "lawyer", signPublicKeyPem: L.dev.k.signPublicKeyPem, encPublicKeyPem: L.dev.k.encPublicKeyPem, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 86400_000).toISOString() });
  const otherRoot = rootCert(generateFirmRoot().privateKeyPem, { deviceId: L.dev.cert.deviceId, memberId: L.dev.cert.memberId, role: "lawyer", signPub: L.dev.k.signPublicKeyPem, encPub: L.dev.k.encPublicKeyPem });
  for (const cert of [forged, otherRoot, L.dev.cert]) {
    const ap = await admin().call("POST", `/v1/join-requests/${id}/approve`, { cert });
    assert.deepEqual([ap.status, ap.json.error?.code], [400, "cert_mismatch"], JSON.stringify(ap.json));
  }
  // 登记这条路同样不认：账号签发钥签的“律所根证书”不是本所律所根签的
  const rg = await L.dev.register(forged);
  assert.deepEqual([rg.status, rg.json.error?.code], [400, "cert_invalid"]);
  const d = cp.ops.tenant(A.tid)!.devices.get(L.dev.cert.deviceId)!;
  assert.equal(d.cert.issuer, "account_ca");
  assert.equal(d.cert.signature, L.dev.cert.signature, "设备记录不变");
});

test("S3：批准的证书公钥须与申请、设备记录一致——换签名公钥或加密公钥（即使律所根签的）一律 cert_mismatch；成员与角色也不能改", async () => {
  const id = (await pendingList()).find((j) => j.device_id === L.dev.cert.deviceId).id;
  const evil = generateDeviceKeys();
  const good = { deviceId: L.dev.cert.deviceId, memberId: L.dev.cert.memberId, role: "lawyer", signPub: L.dev.k.signPublicKeyPem, encPub: L.dev.k.encPublicKeyPem };
  for (const bad of [
    { ...good, signPub: evil.signPublicKeyPem },
    { ...good, encPub: evil.encPublicKeyPem },
    { ...good, memberId: M.dev.cert.memberId },
    { ...good, role: "admin" },
    { ...good, deviceId: M.dev.cert.deviceId },
  ]) {
    const ap = await admin().call("POST", `/v1/join-requests/${id}/approve`, { cert: rootCert(A.root.privateKeyPem, bad) });
    assert.deepEqual([ap.status, ap.json.error?.code], [400, "cert_mismatch"], JSON.stringify(bad));
  }
  assert.equal(cp.ops.tenant(A.tid)!.devices.get(L.dev.cert.deviceId)!.cert.issuer, "account_ca");
});

test("取回 / 撤回只认发起申请的那台电脑；别的电脑、无签名的认领通道都 404 / 403", async () => {
  const id = (await pendingList()).find((j) => j.device_id === L.dev.cert.deviceId).id;
  const other = await M.dev.call("POST", `/v1/join-requests/${id}/fetch`, {});
  assert.deepEqual([other.status, other.json.error?.code], [404, "join_unknown"]);
  const ow = await M.dev.call("POST", `/v1/join-requests/${id}/withdraw`, {});
  assert.equal(ow.status, 404);
  const claim = await post(`/v1/join-requests/${id}/fetch`, { tid: A.tid, claim_secret: "x".repeat(43) });
  assert.equal(claim.status, 403, "认领通道取不到 upgrade 申请");
  const mine = await L.dev.call("POST", `/v1/join-requests/${id}/fetch`, {});
  assert.deepEqual([mine.status, mine.json.status, mine.json.cert], [200, "pending", undefined]);
});

test("批准 → 设备记录原位换成律所根证书（编号、公钥、成员、角色、电脑名不变）→ 目录列出新证书 → 成员电脑取回 → 审计只记编号", async () => {
  const x = (await pendingList()).find((j) => j.device_id === L.dev.cert.deviceId);
  const before = cp.ops.tenant(A.tid)!.devices.get(L.dev.cert.deviceId)!;
  const regAt = before.registered_at;
  const dirV = cp.ops.tenant(A.tid)!.directoryVersion;
  const cert = rootCert(A.root.privateKeyPem, { deviceId: x.device_id, memberId: L.dev.cert.memberId, role: x.role, signPub: x.sign_pub, encPub: x.enc_pub });
  const ap = await admin().call("POST", `/v1/join-requests/${x.id}/approve`, { cert });
  assert.equal(ap.status, 200, JSON.stringify(ap.json));
  const d = cp.ops.tenant(A.tid)!.devices.get(L.dev.cert.deviceId)!;
  assert.equal(d.cert.signature, cert.signature);
  assert.equal(d.cert.issuer, undefined, "律所根签的证书不写 issuer");
  assert.deepEqual([d.cert.signPublicKeyPem, d.cert.encPublicKeyPem, d.cert.memberId, d.cert.role, d.registered_at, d.revoked_at], [L.dev.k.signPublicKeyPem, L.dev.k.encPublicKeyPem, L.dev.cert.memberId, "lawyer", regAt, null]);
  assert.ok(cp.ops.tenant(A.tid)!.directoryVersion > dirV);
  const dirDoc = await admin().call("GET", "/v1/directory");
  const o = openEnvelope<any>(dirDoc.json, "kwl-device-directory", publicKeyMap(cp.publicKeys.envelope));
  assert.ok(o.ok);
  assert.equal((o.ok ? o.body : null).devices.find((c: any) => c.deviceId === L.dev.cert.deviceId).signature, cert.signature, "目录列出律所根证书");
  const f = await L.dev.call("POST", `/v1/join-requests/${x.id}/fetch`, {});
  assert.equal(f.json.status, "approved");
  assert.equal(f.json.cert.signature, cert.signature);
  assert.equal(f.json.root_public_key_pem, A.root.publicKeyPem);
  // 已批准的不能再批 / 拒
  assert.equal((await admin().call("POST", `/v1/join-requests/${x.id}/reject`, {})).status, 404);
  const devs = await get("/v1/firm/devices", A.session);
  const row = devs.json.devices.find((y: any) => y.device_id === L.dev.cert.deviceId);
  assert.deepEqual([row.issuer, row.share_pending], ["firm_root", false]);
  // 被拒的批准也记（result 非 ok）；成功的只有这一次
  const au = auditLog.list(A.tid, 0, 500).filter((e: any) => e.action === "device.upgrade_approve" && e.result === "ok");
  assert.equal(au.length, 1, JSON.stringify(auditLog.list(A.tid, 0, 500).filter((e: any) => e.action === "device.upgrade_approve").map((e: any) => e.result)));
  assert.equal(au[0]!.target, L.dev.cert.deviceId);
  assert.equal(au[0]!.actor.id, A.dev.cert.deviceId);
  assert.ok(auditLog.list(A.tid, 0, 500).some((e: any) => e.action === "device.upgrade_request" && e.target === L.dev.cert.deviceId));
});

test("S6：升级后旧 account_ca 证书不再被接受为这台设备的身份——重新登记 409，设备记录仍是律所根证书；用新证书登记照常；再申请 already_firm_root", async () => {
  const old = L.dev.cert;
  const rg = await L.dev.register(old, L.session);
  assert.deepEqual([rg.status, rg.json.error?.code], [409, "device_cert_superseded"]);
  const d = cp.ops.tenant(A.tid)!.devices.get(L.dev.cert.deviceId)!;
  assert.equal(d.cert.issuer, undefined);
  assert.notEqual(d.cert.signature, old.signature);
  const ok = await L.dev.register(d.cert, L.session);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const again = await upgrade(L);
  assert.deepEqual([again.status, again.json.error?.code], [409, "already_firm_root"]);
  // 律师角色的律所根电脑也不是管理员电脑
  const inv = await L.dev.call("POST", "/v1/invitations", { member_slug: "m-y", name: "y", role: "lawyer", ttl_hours: 1 });
  assert.deepEqual([inv.status, inv.json.error?.code], [403, "admin_required"]);
});

test("S2：被移出团队 / 被停用的成员——待确认申请从列表消失、批准 409；之后不能再发起", async () => {
  const rm = await upgrade(M);
  const rn = await upgrade(N);
  assert.equal(rm.status, 200);
  assert.equal(rn.status, 200);
  assert.equal((await pendingList()).filter((j) => [M.dev.cert.deviceId, N.dev.cert.deviceId].includes(j.device_id)).length, 2);
  assert.equal((await post(`/v1/firm/members/${M.aid}/remove`, {}, A.session)).status, 200);
  assert.equal((await post(`/v1/firm/members/${N.aid}/disable`, {}, A.session)).status, 200);
  const list = await pendingList();
  assert.ok(!list.some((j) => [M.dev.cert.deviceId, N.dev.cert.deviceId].includes(j.device_id)), "已移出 / 已停用的成员不在待确认里");
  for (const [m, r] of [[M, rm], [N, rn]] as const) {
    const ap = await admin().call("POST", `/v1/join-requests/${r.json.join_request_id}/approve`, { cert: rootCert(A.root.privateKeyPem, { deviceId: m.dev.cert.deviceId, memberId: m.dev.cert.memberId, role: "lawyer", signPub: m.dev.k.signPublicKeyPem, encPub: m.dev.k.encPublicKeyPem }) });
    assert.deepEqual([ap.status, ap.json.error?.code], [409, "upgrade_stale"], JSON.stringify(ap.json));
    assert.equal(cp.ops.tenant(A.tid)!.devices.get(m.dev.cert.deviceId)!.cert.issuer, "account_ca");
    const again = await upgrade(m);
    assert.ok(again.status === 401 || again.status === 403, `${again.status} ${JSON.stringify(again.json)}`);
  }
});

test("S2（角色）：申请之后成员被调低角色——原申请作废（列表不再出现、批准 409），新申请按调低后的角色", async () => {
  const r = await upgrade(P);
  assert.equal((await pendingList()).find((j) => j.id === r.json.join_request_id).role, "partner");
  assert.equal((await post(`/v1/firm/members/${P.aid}/role`, { role: "lawyer" }, A.session)).status, 200);
  assert.ok(!(await pendingList()).some((j) => j.id === r.json.join_request_id));
  const ap = await admin().call("POST", `/v1/join-requests/${r.json.join_request_id}/approve`, { cert: rootCert(A.root.privateKeyPem, { deviceId: P.dev.cert.deviceId, memberId: P.dev.cert.memberId, role: "partner", signPub: P.dev.k.signPublicKeyPem, encPub: P.dev.k.encPublicKeyPem }) });
  assert.deepEqual([ap.status, ap.json.error?.code], [409, "upgrade_stale"]);
  // 改角色吊销了会话：重新登录（同一台电脑，带设备签名）再申请
  const lg = await P.dev.call("POST", "/v1/auth/login", { email: "p-u2@example.cn", password: PW, client: W });
  assert.equal(lg.status, 200, JSON.stringify(lg.json));
  const sess = lg.json.session_token as string;
  // 原申请仍待处理（同一台）：原样返回；撤回后再发起，新申请按 lawyer
  const same = await P.dev.call("POST", "/v1/join-requests/upgrade", {}, sess);
  if (same.json.join_request_id === r.json.join_request_id) {
    const w = await P.dev.call("POST", `/v1/join-requests/${r.json.join_request_id}/withdraw`, {});
    assert.equal(w.json.status, "withdrawn");
  }
  const r2 = await P.dev.call("POST", "/v1/join-requests/upgrade", {}, sess);
  assert.equal(r2.status, 200, JSON.stringify(r2.json));
  assert.equal((await pendingList()).find((j) => j.id === r2.json.join_request_id).role, "lawyer");
  // 拒绝 → 成员电脑取回 rejected，设备记录不变
  assert.equal((await admin().call("POST", `/v1/join-requests/${r2.json.join_request_id}/reject`, {})).status, 200);
  const rj = await P.dev.call("POST", `/v1/join-requests/${r2.json.join_request_id}/fetch`, {});
  assert.equal(rj.json.status, "rejected");
  assert.ok(Date.parse(rj.json.decided_at) > 0, "带处理时刻（补测 D5）");
  assert.equal(cp.ops.tenant(A.tid)!.devices.get(P.dev.cert.deviceId)!.cert.issuer, "account_ca");
  assert.ok(auditLog.list(A.tid, 0, 500).some((e: any) => e.action === "device.upgrade_reject"));
});

test("过期：7 天没人处理 → 取回为 expired、批准 404；撤回后批准 404", async () => {
  const lg = await P.dev.call("POST", "/v1/auth/login", { email: "p-u2@example.cn", password: PW, client: W });
  const sess = lg.json.session_token as string;
  const r = await P.dev.call("POST", "/v1/join-requests/upgrade", {}, sess);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const jr = cp.ops.tenant(A.tid)!.joinRequests.get(r.json.join_request_id)!;
  jr.created_at = new Date(Date.now() - 8 * 86400_000).toISOString();
  assert.equal((await P.dev.call("POST", `/v1/join-requests/${jr.id}/fetch`, {})).json.status, "expired");
  const cert = rootCert(A.root.privateKeyPem, { deviceId: P.dev.cert.deviceId, memberId: P.dev.cert.memberId, role: "lawyer", signPub: P.dev.k.signPublicKeyPem, encPub: P.dev.k.encPublicKeyPem });
  assert.equal((await admin().call("POST", `/v1/join-requests/${jr.id}/approve`, { cert })).status, 404);
  const r2 = await P.dev.call("POST", "/v1/join-requests/upgrade", {}, sess);
  assert.notEqual(r2.json.join_request_id, jr.id, "过期的不算待处理，可重新发起");
  assert.equal((await P.dev.call("POST", `/v1/join-requests/${r2.json.join_request_id}/withdraw`, {})).json.status, "withdrawn");
  assert.equal((await admin().call("POST", `/v1/join-requests/${r2.json.join_request_id}/approve`, { cert })).status, 404);
});
