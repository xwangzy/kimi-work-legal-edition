/**
 * 第 72 批真实端到端验收（研究目录 10-真实端到端验收.md）云端三处的正式用例：
 * - Q-1 电脑“最近使用”取真实活动（会话核对 / 设备签名请求 / 网关计量，取最近者）——正在用的电脑在同时登录选择页上是“刚刚用过”、不会被预选；
 * - Q-7 会话绑到一台电脑时，同一账号同一电脑上的其它桌面会话以 replaced 收回；
 * - Q-5 被团队移出 / 退出团队的成员身份不计入客户行成员数与未占席，另给 members_removed。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDeviceKeys, generateFirmRoot, issueDeviceCertificate, type DeviceCertificate, type DeviceRole } from "@zr-legal/keys";
import { deviceEnrollProofBytes, enrollProofBytes, firmBundleBytes, openEnvelope, publicKeyMap, signDeviceRequest } from "@zr-legal/firm-trust";
import { accountDeviceId, createAuditLog, createControlPlane, devControlPlaneKeys, UsageBook, type ControlPlane } from "../src/index.ts";
import { devStaffOf, staffEmail, staffToken, call } from "./staff-fixture.ts";

const keys = devControlPlaneKeys({ accountCa: true });
const SECRET = "b72-acc-service-secret-0123456789abcdef0";
const PW = "Lawyer2026secure";
let cp: ControlPlane;
let base = "";
/** 控制面时钟偏移（只在不涉及设备签名的步骤里拨动：邀请过期）。 */
let skew = 0;
const dir = mkdtempSync(join(tmpdir(), "kwl-b72q-"));

before(async () => {
  cp = createControlPlane({ keys, auditLog: createAuditLog(), serviceSecret: SECRET, now: () => Date.now() + skew, usageBook: new UsageBook({ dir: join(dir, "usage") }), routing: { bootstrap: { provider: { base_url: "https://maas.example.test/v1" } }, key_id: "0123456789abcdef" }, devStaff: devStaffOf({ op_7401: ["operator"] }) });
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
const service = (path: string, body: unknown) => req("POST", path, body, { authorization: `Bearer ${SECRET}` });
const tokens = new Map<string, string>();
const ops = async (who: string, method: string, path: string, body?: unknown) => {
  if (!tokens.has(who)) tokens.set(who, await staffToken(base, staffEmail(who)));
  return call(base, method, path, body, { authorization: `Bearer ${tokens.get(who)}` });
};

function deviceOf(tid: string, cert: DeviceCertificate, k: ReturnType<typeof generateDeviceKeys>) {
  const callDev = async (method: string, path: string, body?: unknown, session?: string, asTid = tid) => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const h = signDeviceRequest({ method, path, body: raw, tid: asTid, deviceId: cert.deviceId, signPrivateKeyPem: k.signPrivateKeyPem, now: Date.now() + skew });
    const r = await fetch(`${base}${path}`, { method, headers: { ...h, ...(raw ? { "content-type": "application/json" } : {}), ...(session ? S(session) : {}) }, ...(raw ? { body: raw } : {}) });
    return { status: r.status, json: (await r.json()) as any };
  };
  return { k, cert, call: callDev, register: (session?: string) => callDev("POST", "/v1/devices/register", { tid, cert }, session) };
}

/** 自助注册个人工作室 → 创始开通（上传律所公钥包）→ 登记创始电脑（会话绑上）。 */
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
  assert.equal((await dev.register(reg.json.session_token)).status, 200);
  return { tid, aid: reg.json.account.aid as string, memberId, dev, session: reg.json.session_token as string, reg: reg.json, email };
}

/** 以一份登录 / 切换应答（needs_device_auto）在新电脑上自动登记并登记设备（会话绑上、有空席即占席）。 */
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
  assert.equal((await dev.register(r.session_token)).status, 200);
  return dev;
}

const W = { version: "0.11.0", platform: "darwin" };
const minutesAgo = (v: string | null) => (v ? (Date.now() + skew - Date.parse(v)) / 60_000 : Infinity);
/** 客户端“默认预选登录中最久没用的一台”（apps/desktop/src/lib/account.ts defaultSignoutPick 的同一规则）。 */
const preselect = (devs: any[], thisDevice: string | null = null) => [...devs.filter((d) => d.state === "signed_in" && d.device_id !== thisDevice)].sort((x, y) => (x.last_seen_at ?? x.last_seen_on ?? x.registered_at ?? "").localeCompare(y.last_seen_at ?? y.last_seen_on ?? y.registered_at ?? ""))[0]?.device_id ?? null;

test("Q-1：一台电脑持续有请求（会话核对 / 设备签名请求 / 网关计量）——选择页上它是“刚刚用过”，不会被预选；没在用的那台才是", async () => {
  const F = await signup("q1-b72@example.cn", "钱律师", "钱律师工作室");
  cp.ops.account("q1-b72@example.cn")!.device_limit = 2;
  const li2 = await post("/v1/auth/login", { email: "q1-b72@example.cn", password: PW, client: W });
  const D2 = await enrollFrom(li2.json);
  skew = 50 * 60_000;
  try {
    // 50 分钟后：创始电脑一直在用（内核每 2 分钟核对一次会话）；第二台没动
    assert.equal((await get("/v1/auth/me", F.session)).status, 200);
    const n3 = await post("/v1/auth/login", { email: "q1-b72@example.cn", password: PW, client: W });
    assert.equal(n3.json.onboarding.state, "device_limit", JSON.stringify(n3.json.onboarding));
    const by = (id: string) => n3.json.onboarding.devices.find((d: any) => d.device_id === id);
    assert.ok(minutesAgo(by(F.dev.cert.deviceId).last_seen_at) < 1, `会话核对：刚刚用过（${by(F.dev.cert.deviceId).last_seen_at}）`);
    assert.ok(minutesAgo(by(D2.cert.deviceId).last_seen_at) > 45, "没在用的那台：约 50 分钟前");
    assert.equal(preselect(n3.json.onboarding.devices), D2.cert.deviceId, "预选的是没在用的那台");
    assert.equal(n3.json.onboarding.devices[0].device_id, F.dev.cert.deviceId, "登录中、最近用过的在前");
    // 第二台经网关有一次 AI 调用（计量记录带这台电脑）：它也成了“刚刚用过”
    const t = cp.ops.tenant(F.tid)!;
    const sid = t.seatsByUser.get(F.memberId)!.sid;
    const l = await service("/v1/quota/lease", { tid: F.tid, sid, holder: "gw-q1", need_estimate: { alias: "legal/k3", input: 100, output: 50 } });
    assert.equal(l.status, 200, JSON.stringify(l.json));
    const at = new Date(Date.now() + skew).toISOString();
    const rec = { request_id: "kwlgw_q1_1", client_request_id: "c_q1", upstream_request_id: "u_q1", at, sid, uid: F.memberId, dev: D2.cert.deviceId, alias: "legal/k3", provider: "maas", upstream_model: "kimi-k3.1-pro", stream: true, status: 200, outcome: "ok", qa: false, usage: { input: 100, cached: 0, output: 50, reasoning: 0 }, usage_source: "upstream", latency_ms: 10, attempts: [{ provider: "maas", status: 200, error: null, ms: 10 }], lease_id: l.json.lease_id };
    assert.equal((await service("/v1/quota/settle", { tid: F.tid, lease_id: l.json.lease_id, holder: "gw-q1", records: [rec], final: true })).status, 200);
    const n4 = await post("/v1/auth/login", { email: "q1-b72@example.cn", password: PW, client: W });
    assert.ok(minutesAgo(n4.json.onboarding.devices.find((d: any) => d.device_id === D2.cert.deviceId).last_seen_at) < 1, "网关计量：刚刚用过");
    // 设备签名请求同样算：10 分钟后只有第二台发签名请求
    skew = 60 * 60_000;
    assert.equal((await D2.call("GET", "/v1/directory")).status, 200);
    const n5 = await post("/v1/auth/login", { email: "q1-b72@example.cn", password: PW, client: W });
    const d5 = n5.json.onboarding.devices;
    assert.ok(minutesAgo(d5.find((d: any) => d.device_id === D2.cert.deviceId).last_seen_at) < 1, "设备签名请求：刚刚用过");
    assert.equal(preselect(d5), F.dev.cert.deviceId, "这回没在用的是创始电脑（10 分钟前核对过）");
    // 本人“登录过的电脑”与会话视图同一口径
    const me = await get("/v1/auth/me", F.session);
    assert.ok(minutesAgo(me.json.devices.find((d: any) => d.device_id === D2.cert.deviceId).last_seen_at) < 1);
    assert.ok(me.json.sessions.every((x: any) => typeof x.last_seen_at === "string"));
  } finally {
    skew = 0;
  }
});

test("Q-1：会话最近活动只改内存、不为它整份写盘（状态存储写入次数不因核对而增加），随下一次正常落盘写出（快照里的 activity）", async () => {
  let saved: string | null = null;
  let saves = 0;
  const store = { load: () => saved, save: (j: string) => ((saved = j), (saves += 1)) };
  const c1 = createControlPlane({ keys, auditLog: createAuditLog(), serviceSecret: SECRET, stateStore: store });
  await new Promise<void>((r) => c1.server.listen(0, "127.0.0.1", () => r()));
  const b1 = `http://127.0.0.1:${(c1.server.address() as AddressInfo).port}`;
  try {
    const reg = await fetch(`${b1}/v1/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "q1s-b72@example.cn", password: PW, name: "某", client: { platform: "web" } }) });
    const tok = ((await reg.json()) as any).session_token as string;
    const n0 = saves;
    for (let i = 0; i < 5; i++) assert.equal((await fetch(`${b1}/v1/auth/me`, { headers: { authorization: `Bearer ${tok}` } })).status, 200);
    assert.equal(saves, n0, "核对会话不触发写盘");
    // 下一次正常落盘（状态有变）把活动一并写出
    assert.equal((await fetch(`${b1}/v1/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${tok}` } })).status, 200);
    assert.ok(saves > n0);
    const act = JSON.parse(saved!).activity;
    assert.ok(Array.isArray(act.sessions) && act.sessions.length >= 1 && Array.isArray(act.devices));
  } finally {
    c1.server.closeAllConnections();
    await new Promise<void>((r) => c1.server.close(() => r()));
  }
});

test("Q-7：会话经席位令牌 / onboarding 才绑到这台电脑时，同一账号同一电脑上的旧桌面会话以 replaced 收回（一台电脑只留一个）", async () => {
  const F = await signup("q7-b72@example.cn", "孙律师", "孙律师工作室");
  // 不带签名再登录一次（换账号打开已有档案的路径）：会话先不绑
  const li = await post("/v1/auth/login", { email: "q7-b72@example.cn", password: PW, client: W });
  assert.equal(li.status, 200);
  assert.equal((await get("/v1/auth/me", F.session)).status, 200, "绑定前旧会话还在");
  // 席位令牌这一步（账号闸）把新会话绑到这台电脑：旧会话收回
  assert.equal((await F.dev.call("POST", "/v1/seat-token", {}, li.json.session_token)).status, 200);
  const old = await get("/v1/auth/me", F.session);
  assert.equal(old.status, 401, "旧会话已收回");
  const me = await get("/v1/auth/me", li.json.session_token);
  assert.equal(me.json.sessions.filter((x: any) => x.device_id === F.dev.cert.deviceId).length, 1, "这台电脑上只剩一个有效桌面会话");
  // /v1/auth/onboarding 带签名绑定同样收回
  const li2 = await post("/v1/auth/login", { email: "q7-b72@example.cn", password: PW, client: W });
  const ob = await F.dev.call("POST", "/v1/auth/onboarding", {}, li2.json.session_token);
  assert.deepEqual([ob.status, ob.json.onboarding.state], [200, "ready"]);
  assert.equal((await get("/v1/auth/me", li.json.session_token)).status, 401);
  const me2 = await get("/v1/auth/me", li2.json.session_token);
  assert.equal(me2.json.sessions.filter((x: any) => x.device_id === F.dev.cert.deviceId).length, 1);
});

test("Q-5：被团队移出 / 退出团队的成员身份不计入客户行成员数与未占席（另给 members_removed）；组织详情同一行；本所概览同口径", async () => {
  const A = await signup("q5a-b72@example.cn", "周律师", "周律师工作室");
  assert.equal((await post("/v1/workspace/upgrade", { name: "周律师事务所" }, A.session)).status, 200);
  const mk = async (email: string, name: string) => {
    const iv = await post("/v1/team/invites", { name, role: "lawyer" }, A.session);
    const r = await post("/v1/auth/register", { email, password: PW, name, team_invite_code: iv.json.code, client: { platform: "web" } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json as any;
  };
  const x1 = await mk("q5b-b72@example.cn", "吴律师");
  const x2 = await mk("q5c-b72@example.cn", "郑律师");
  const row0 = (await ops("op_7401", "GET", "/v1/ops/tenants")).json.tenants.find((t: any) => t.tid === A.tid);
  assert.deepEqual([row0.member_count, row0.members_removed], [3, 0]);
  assert.equal((await post(`/v1/firm/members/${x1.account.aid}/remove`, {}, A.session)).status, 200);
  const row = (await ops("op_7401", "GET", "/v1/ops/tenants?kind=team")).json.tenants.find((t: any) => t.tid === A.tid);
  assert.deepEqual([row.member_count, row.members_removed, row.seat_used], [2, 1, 1], "移出的不计入成员数，另计 members_removed");
  const det = await ops("op_7401", "GET", `/v1/ops/tenants/${A.tid}`);
  assert.equal(det.status, 200, det.text);
  const dt = det.json.tenant ?? det.json;
  assert.deepEqual([dt.member_count, dt.members_removed], [2, 1], "组织详情页头用同一行数据");
  // 未占席：只算有效成员（被移出的不算）
  const acc = await ops("op_7401", "GET", `/v1/ops/accounts?tid=${A.tid}&status=unseated`);
  assert.deepEqual(acc.json.accounts.map((a: any) => a.aid), [x2.account.aid]);
  const ov = await get("/v1/firm/overview", A.session);
  assert.deepEqual([ov.json.counts.members, ov.json.counts.members_removed], [2, 1]);
  // 人员行：工作空间项带停用来源（控制台据此不写“另在 N 个团队”）
  const pp = await ops("op_7401", "GET", "/v1/ops/people?q=q5b-b72");
  const p = pp.json.people.find((y: any) => y.aid === x1.account.aid);
  assert.deepEqual(p.workspaces.map((w: any) => [w.status, w.disabled_by]), [["disabled", "team"]]);
});
