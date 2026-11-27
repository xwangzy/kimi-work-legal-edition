/**
 * 第 72 批（V46）独立安全审查（研究目录 09-安全审查.md）处置的正式用例：复现用例里的场景逐条改写为断言。
 * P0-1 移出不覆盖平台停用；P0-2 设备签名的管理权限按“有效角色”（证书角色与账号当前角色取低、账号停用一律拒）；
 * P1-1 account_ca 电脑不能吊销 / 读审计；P2-2 平台停用主账号 = 停用这个人；P2-3 移出 / 降级撤回其未接受的邀请、phone_hint 末 4 位核对；
 * P2-4 团队视图打码邮箱、团队邀请新建的成员标识随机；P2-5 运营对关联账号的凭证操作作用于主账号并在主账号租户记审计；P2-7 启用有效成员是空操作。
 * （P1-1 存量团队迁移为 approve、P2-1 存量停用回填 platform 见 b72-model-catalog-epoch 的读回定型用例。）
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
const SECRET = "b72-sec-service-secret-0123456789abcdef0";
const PW = "Lawyer2026secure";
let cp: ControlPlane;
let base = "";
/** 控制面时钟偏移（只在不涉及设备签名的步骤里拨动：邀请过期）。 */
let skew = 0;
/** 找回密码邮件（只记收件人）。 */
const mails: string[] = [];
const dir = mkdtempSync(join(tmpdir(), "kwl-b72s-"));

before(async () => {
  cp = createControlPlane({ keys, auditLog: createAuditLog(), serviceSecret: SECRET, now: () => Date.now() + skew, usageBook: new UsageBook({ dir: join(dir, "usage") }), routing: { bootstrap: { provider: { base_url: "https://maas.example.test/v1" } }, key_id: "0123456789abcdef" }, devStaff: devStaffOf({ op_7301: ["operator"], op_7302: ["support"] }), mailer: { from: "noreply@kwl.example.cn", send: async (to: string, _subject: string, _text: string) => void mails.push(to) } });
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
    const h = signDeviceRequest({ method, path, body: raw, tid: asTid, deviceId: cert.deviceId, signPrivateKeyPem: k.signPrivateKeyPem });
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
let A: Awaited<ReturnType<typeof signup>>;
let B: Awaited<ReturnType<typeof signup>>;
let L: Awaited<ReturnType<typeof signup>>;
let bTeam: { aid: string; session: string; dev: ReturnType<typeof deviceOf> };
let lTeam: { aid: string; session: string; dev: ReturnType<typeof deviceOf> };

test("准备：甲（团队管理员，律所根电脑）；乙以合伙人、丁以律师加入，各自新电脑由账号签发钥直接登记", async () => {
  A = await signup("a-sec72@example.cn", "甲律师", "甲工作室");
  assert.equal((await post("/v1/workspace/upgrade", { name: "甲律师事务所" }, A.session)).status, 200);
  const ib = await post("/v1/team/invites", { name: "乙律师", role: "partner" }, A.session);
  B = await signup("b-sec72@example.cn", "乙律师", "乙工作室");
  const jb = await post("/v1/teams/join", { code: ib.json.code, client: W }, B.session);
  assert.equal(jb.status, 200, JSON.stringify(jb.json));
  bTeam = { aid: jb.json.account.aid, session: jb.json.session_token, dev: await enrollFrom(jb.json) };
  const il = await post("/v1/team/invites", { name: "丁律师", role: "lawyer" }, A.session);
  L = await signup("l-sec72@example.cn", "丁律师", "丁工作室");
  const jl = await post("/v1/teams/join", { code: il.json.code, client: W }, L.session);
  lTeam = { aid: jl.json.account.aid, session: jl.json.session_token, dev: await enrollFrom(jl.json) };
  assert.equal(bTeam.dev.cert.issuer, "account_ca");
});

test("P2-4：团队管理员 / 合伙人看到的成员邮箱打码；由团队邀请新建的成员标识是随机串（不从邮箱派生）", async () => {
  const mem = await get("/v1/firm/members", bTeam.session);
  assert.equal(mem.status, 200);
  const row = mem.json.members.find((m: any) => m.aid === lTeam.aid);
  assert.equal(row.email, "l***@example.cn");
  assert.ok(!JSON.stringify(mem.json).includes("l-sec72@example.cn"));
  assert.match(row.member_slug, /^u[0-9a-f]{6}$/);
  assert.ok(!lTeam.dev.cert.memberId.includes("lsec72"), "成员编号不含邮箱本地部分");
});

test("P1-1：账号签发钥（account_ca）签的合伙人电脑不能读本所审计、不能吊销他人电脑与席位（只能在律所根电脑或网页上做）", async () => {
  const au = await bTeam.dev.call("GET", "/v1/audit?after=0&limit=10", undefined, bTeam.session);
  assert.deepEqual([au.status, au.json.error.code], [403, "firm_root_device_required"]);
  const rv = await bTeam.dev.call("POST", `/v1/devices/${lTeam.dev.cert.deviceId}/revoke`, {}, bTeam.session);
  assert.deepEqual([rv.status, rv.json.error.code], [403, "firm_root_device_required"]);
  assert.equal(cp.ops.tenant(A.tid)!.devices.get(lTeam.dev.cert.deviceId)!.revoked_at, null, "丁的电脑没有被吊销");
  const rs = await bTeam.dev.call("POST", `/v1/seats/${encodeURIComponent(lTeam.dev.cert.memberId)}/revoke`, {});
  assert.equal(rs.status, 403);
  // 律所根签发的管理员电脑照常能读审计
  assert.equal((await A.dev.call("GET", "/v1/audit?after=0&limit=10", undefined, A.session)).status, 200);
});

test("P0-1：平台停用 → 团队启用 403 → 团队“移出”不覆盖平台停用（disabled_by 仍为 platform）→ 团队启用仍 403 platform_disabled", async () => {
  const d = await ops("op_7301", "POST", `/v1/ops/accounts/${lTeam.aid}/disable`, { reason: "风控" });
  assert.equal(d.json.account.disabled_by, "platform");
  assert.equal((await post(`/v1/firm/members/${lTeam.aid}/enable`, {}, A.session)).json.error.code, "platform_disabled");
  const rm = await post(`/v1/firm/members/${lTeam.aid}/remove`, {}, A.session);
  assert.deepEqual([rm.status, rm.json.member.disabled_by], [200, "platform"]);
  const e2 = await post(`/v1/firm/members/${lTeam.aid}/enable`, {}, A.session);
  assert.deepEqual([e2.status, e2.json.error.code], [403, "platform_disabled"]);
  // 停用的成员身份：设备取不到许可与席位令牌
  assert.deepEqual([(await lTeam.dev.call("GET", "/v1/license")).json.error.code, (await lTeam.dev.call("POST", "/v1/seat-token", {})).json.error.code], ["account_disabled", "account_disabled"]);
});

test("P2-3：从管理员降级时撤回他发出、未接受的团队邀请（审计记数量）；被撤回的码 invite_invalid", async () => {
  assert.equal((await post(`/v1/firm/members/${bTeam.aid}/role`, { role: "admin" }, A.session)).json.member.role, "admin");
  const iv = await post("/v1/team/invites", { name: "后门", role: "admin" }, bTeam.session);
  assert.equal(iv.status, 200);
  const dm = await post(`/v1/firm/members/${bTeam.aid}/role`, { role: "partner" }, A.session);
  assert.equal(dm.json.member.role, "partner");
  assert.equal(cp.ops.tenant(A.tid)!.team_invites!.get(iv.json.invite.id)!.status, "revoked");
  const au = await ops("op_7301", "GET", `/v1/ops/tenants/${A.tid}/audit`);
  assert.ok(au.json.records.some((x: any) => x.action === "account.role" && x.target === bTeam.aid && x.detail?.invites_revoked === 1), JSON.stringify(au.json.records.filter((x: any) => x.action === "account.role")));
  const r = await post("/v1/auth/register", { email: "x-sec72@example.cn", password: PW, name: "某", team_invite_code: iv.json.code, client: { platform: "web" } });
  assert.deepEqual([r.status, r.json.error.code], [400, "invite_invalid"]);
});

test("P2-3：邀请带手机号提示时，接受人主账号手机号末 4 位须一致（没有手机号或不一致 → invite_invalid）", async () => {
  const iv = await post("/v1/team/invites", { name: "戊律师", role: "lawyer", phone_hint: "13912347201" }, A.session);
  const E = await signup("e-sec72@example.cn", "戊律师", "戊工作室");
  assert.equal((await post("/v1/teams/join", { code: iv.json.code }, E.session)).json.error.code, "invite_invalid", "没有手机号");
  cp.ops.account("e-sec72@example.cn")!.phone = { mac: "0".repeat(64), masked: "139****1111", sealed: "-", verified_at: new Date().toISOString() };
  assert.equal((await post("/v1/teams/join", { code: iv.json.code }, E.session)).json.error.code, "invite_invalid", "末 4 位不一致");
  cp.ops.account("e-sec72@example.cn")!.phone!.masked = "139****7201";
  assert.equal((await post("/v1/teams/join", { code: iv.json.code, client: W }, E.session)).status, 200, "一致即可接受");
});

test("P0-2：被降级的管理员，其律所根电脑即刻失去管理权限；被移出后不带会话的设备签名请求一律 403，许可与席位令牌也拿不到（设备记录保留）", async () => {
  // 乙升为管理员，把甲降为律师
  assert.equal((await post(`/v1/firm/members/${bTeam.aid}/role`, { role: "admin" }, A.session)).status, 200);
  assert.equal((await post(`/v1/firm/members/${A.aid}/role`, { role: "lawyer" }, bTeam.session)).json.member.role, "lawyer");
  const inv = await A.dev.call("POST", "/v1/invitations", { member_slug: "sec72x", name: "某", role: "admin" }, A.session);
  assert.deepEqual([inv.status, inv.json.error.code], [403, "admin_required"]);
  assert.equal((await A.dev.call("GET", "/v1/join-requests", undefined, A.session)).json.error.code, "admin_required");
  assert.equal((await A.dev.call("GET", "/v1/audit?after=0&limit=10", undefined, A.session)).json.error.code, "revoker_required");
  // 乙把甲移出
  const rm = await post(`/v1/firm/members/${A.aid}/remove`, {}, bTeam.session);
  assert.deepEqual([rm.status, rm.json.member.status], [200, "disabled"]);
  for (const [m, path, body] of [["POST", "/v1/invitations", { member_slug: "sec72y", name: "某", role: "admin" }], ["GET", "/v1/join-requests", undefined], ["GET", "/v1/audit?after=0&limit=10", undefined], ["POST", `/v1/devices/${bTeam.dev.cert.deviceId}/revoke`, {}], ["GET", "/v1/license", undefined], ["POST", "/v1/seat-token", {}]] as const) {
    const r = await A.dev.call(m, path, body);
    assert.deepEqual([r.status, r.json.error.code], [403, "account_disabled"], path);
  }
  assert.ok(cp.ops.tenant(A.tid)!.devices.get(A.dev.cert.deviceId) && !cp.ops.tenant(A.tid)!.devices.get(A.dev.cert.deviceId)!.revoked_at, "设备记录保留、不吊销（契约原样）");
  assert.equal(cp.ops.tenant(A.tid)!.devices.get(bTeam.dev.cert.deviceId)!.revoked_at, null);
});

test("P2-7：对已是有效的成员调 enable 是幂等空操作，不清零这个人的登录失败计数", async () => {
  const iv = await post("/v1/team/invites", { name: "庚律师", role: "lawyer" }, bTeam.session);
  const g = await post("/v1/auth/register", { email: "g-sec72@example.cn", password: PW, name: "庚", team_invite_code: iv.json.code, client: { platform: "web" } });
  assert.equal(g.status, 200, JSON.stringify(g.json));
  for (let i = 0; i < 2; i++) assert.equal((await post("/v1/auth/login", { email: "g-sec72@example.cn", password: "Wrong2026password", client: { platform: "web" } })).status, 401);
  assert.equal(cp.ops.account("g-sec72@example.cn")!.failed.count, 2);
  const e = await post(`/v1/firm/members/${g.json.account.aid}/enable`, {}, bTeam.session);
  assert.deepEqual([e.status, e.json.unchanged], [200, true]);
  assert.equal(cp.ops.account("g-sec72@example.cn")!.failed.count, 2, "计数没有被清零");
});

test("P2-5：运营给关联账号发重置码——作用于主账号（这个人的凭证），审计在主账号所在租户与团队租户都有", async () => {
  const r = await ops("op_7302", "POST", `/v1/ops/accounts/${bTeam.aid}/reset-code`, {});
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.person, B.aid);
  const pa = await ops("op_7301", "GET", `/v1/ops/tenants/${B.tid}/audit`);
  assert.ok(pa.json.records.some((x: any) => x.action === "account.reset_code" && x.target === B.aid), "主账号所在租户");
  const ta = await ops("op_7301", "GET", `/v1/ops/tenants/${A.tid}/audit`);
  assert.ok(ta.json.records.some((x: any) => x.action === "account.reset_code" && x.target === bTeam.aid), "团队租户");
  // 重置码用于主账号（邮箱即主账号）
  assert.equal((await post("/v1/auth/password-reset/confirm", { email: "b-sec72@example.cn", code: r.json.reset_code, password: "Partner2027secure" })).status, 200);
});

test("P2-2：团队停用主账号的成员身份不影响他的其他工作空间；平台停用主账号 = 停用这个人——登录进不了任何工作空间、关联账号会话撤销、找回密码不发码；运营启用后照常", async () => {
  // 上一条改了乙的密码（撤了这个人全部会话）：重新登录，缺省进最近使用的团队工作空间
  const lb = await post("/v1/auth/login", { email: "b-sec72@example.cn", password: "Partner2027secure", client: { platform: "web" } });
  assert.deepEqual([lb.status, lb.json.account.aid], [200, bTeam.aid]);
  bTeam.session = lb.json.session_token;
  // 庚的主账号就建在甲团队（凭邀请注册）；丁把个人工作室升级为团队，庚也加入
  assert.equal((await post("/v1/workspace/upgrade", { name: "丁律师事务所" }, L.session)).status, 200);
  const iv = await post("/v1/team/invites", { name: "庚律师", role: "lawyer" }, L.session);
  const g = await post("/v1/auth/login", { email: "g-sec72@example.cn", password: PW, client: { platform: "web" } });
  assert.equal(g.status, 200, JSON.stringify(g.json));
  assert.equal((await post("/v1/teams/join", { code: iv.json.code }, g.json.session_token)).status, 200);
  // 甲团队（管理员乙）停用庚在甲团队的身份（就是他的主账号）：庚仍能登录、进丁团队
  const gAid = g.json.account.aid as string;
  assert.equal((await post(`/v1/firm/members/${gAid}/disable`, {}, bTeam.session)).json.member.disabled_by, "team");
  const g2 = await post("/v1/auth/login", { email: "g-sec72@example.cn", password: PW, client: { platform: "web" } });
  assert.deepEqual([g2.status, g2.json.workspace.tid], [200, L.tid], "团队停用不等于停用这个人");
  // 平台停用乙的主账号
  assert.equal((await post("/v1/auth/password-reset/request", { email: "b-sec72@example.cn" })).status, 202);
  const mails0 = mails.length;
  assert.equal(mails.at(-1), "b-sec72@example.cn", "停用前照常发找回邮件");
  const d = await ops("op_7301", "POST", `/v1/ops/accounts/${B.aid}/disable`, { reason: "平台停用此人" });
  assert.equal(d.status, 200, d.text);
  const li = await post("/v1/auth/login", { email: "b-sec72@example.cn", password: "Partner2027secure", client: { platform: "web" } });
  assert.deepEqual([li.status, li.json.error.code], [403, "account_disabled"], "凭证正确也进不了他的团队工作空间");
  assert.equal((await get("/v1/auth/me", bTeam.session)).status, 401, "关联账号的会话随之撤销");
  assert.equal((await post("/v1/teams/join", { code: "ABCD-EFGH-JKMN-PQRS" }, bTeam.session)).status, 401, "不能再加入团队");
  assert.equal((await post("/v1/auth/password-reset/request", { email: "b-sec72@example.cn" })).status, 202, "应答不变（不泄露）");
  assert.equal(mails.length, mails0, "但不发找回码");
  // 运营启用后照常
  assert.equal((await ops("op_7301", "POST", `/v1/ops/accounts/${B.aid}/enable`, {})).status, 200);
  assert.equal((await post("/v1/auth/login", { email: "b-sec72@example.cn", password: "Partner2027secure", client: { platform: "web" } })).status, 200);
});
