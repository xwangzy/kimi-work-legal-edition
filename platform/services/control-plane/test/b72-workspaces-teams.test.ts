/**
 * 第 72 批（V46，D-304 / D-305 / D-306，契约 02 §0～§6、§8）：一个人、多个工作空间；就地升级为团队；团队邀请（会话发，不要求律所根电脑）；
 * 接受邀请（已注册的人建关联账号 / 未注册的人注册时直接进团队）；切换；移出与退出团队；团队成员新电脑由账号签发钥直接登记（策略 auto）；
 * /v1/firm/* 补齐（remove、role、席位、上限 ≤ 套餐、平台停用、重置改发短信、成员电脑策略）；账号级上手状态；运营“人员”与代办接口。
 * 越权与隔离：契约 §6 的 1～11 条与 A3 §4.7 的 X1～X9（X10 中继不在控制面，见 relay-api 用例）。全部真实控制面端到端。
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
const SECRET = "b72-test-service-secret-0123456789abcdef";
const PW = "Lawyer2026secure";
let cp: ControlPlane;
let base = "";
/** 控制面时钟偏移（只在不涉及设备签名的步骤里拨动：邀请过期）。 */
let skew = 0;
const dir = mkdtempSync(join(tmpdir(), "kwl-b72-"));

before(async () => {
  cp = createControlPlane({ keys, auditLog: createAuditLog(), serviceSecret: SECRET, now: () => Date.now() + skew, usageBook: new UsageBook({ dir: join(dir, "usage") }), routing: { bootstrap: { provider: { base_url: "https://maas.example.test/v1" } }, key_id: "0123456789abcdef" }, devStaff: devStaffOf({ op_7201: ["sysadmin"], op_7202: ["operator"], op_7204: ["viewer"] }) });
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

// 用例共享的人物：甲（个人 → 升级为团队“甲律师事务所”的管理员）、乙（有个人工作室，又加入甲团队）、丙（未注册，凭邀请注册进甲团队）、丁（另一个团队的管理员）
let A: Awaited<ReturnType<typeof signup>>;
let B: Awaited<ReturnType<typeof signup>>;
let D: Awaited<ReturnType<typeof signup>>;
let bTeam: { aid: string; session: string; dev?: ReturnType<typeof deviceOf> };
let cAid = "";
let cSession = "";

test("/v1/meta：公布 workspaces、team_invites、team_member_auto_enroll、onboarding_state、catalog_epoch", async () => {
  const m = await get("/v1/meta");
  for (const f of ["workspaces", "team_invites", "team_member_auto_enroll", "onboarding_state", "catalog_epoch", "device_auto_enroll"]) assert.ok(m.json.features.includes(f), f);
});

test("契约 §2.1：注册应答带 person / workspace / workspaces；个人空间 kind = personal，只有一个工作空间时与原来相同", async () => {
  A = await signup("jia-b72@example.cn", "甲律师", "甲律师工作室");
  const r = A.reg;
  assert.deepEqual([r.person.aid, r.person.name, r.workspace.aid, r.workspace.kind, r.workspace.tid], [A.aid, "甲律师", A.aid, "personal", A.tid]);
  assert.deepEqual(r.workspaces.map((w: any) => [w.aid, w.kind, w.current, w.status]), [[A.aid, "personal", true, "active"]]);
  assert.deepEqual(r.person.onboarding, { completed_at: null, dismissed_at: null });
  assert.equal(cp.ops.tenant(A.tid)!.kind, "personal");
  assert.equal(cp.ops.tenant(A.tid)!.personal, true, "personal 布尔保留为兼容字段");
});

test("契约 §6.5 / §6.8 / X5 / X9：个人空间调 /v1/firm/* 写 → 403 team_only（不能给自己放宽电脑上限）；发邀请（设备签名 / 会话）→ 409 upgrade_required；不再悄悄转团队", async () => {
  assert.deepEqual(Object.values(await post(`/v1/firm/members/${A.aid}/limits`, { device_limit: 9 }, A.session)).map((x: any) => x?.error?.code ?? x), [403, "team_only"]);
  assert.equal((await post(`/v1/firm/members/${A.aid}/disable`, {}, A.session)).json.error.code, "team_only");
  assert.equal((await get("/v1/firm/members", A.session)).status, 200, "读照常（个人用户看自己的工作室）");
  const inv = await A.dev.call("POST", "/v1/invitations", { member_slug: "x1", name: "某律师", role: "lawyer" }, A.session);
  assert.deepEqual([inv.status, inv.json.error.code], [409, "upgrade_required"]);
  assert.deepEqual([(await post("/v1/team/invites", { name: "某律师", role: "lawyer" }, A.session)).json.error.code], ["upgrade_required"]);
  assert.equal(cp.ops.tenant(A.tid)!.kind, "personal", "类型不因发邀请而改变");
});

test("契约 §3.1 / §6.8：就地升级（同一 tid）——kind → team、策略 auto、改名、试用席位 ≥ 3；再升级 409；非唯一成员 409；审计在", async () => {
  const bad = await post("/v1/workspace/upgrade", { name: "甲" }, A.session);
  assert.equal(bad.json.error.code, "team_name_invalid");
  const up = await post("/v1/workspace/upgrade", { name: "甲律师事务所" }, A.session);
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.deepEqual([up.json.workspace.tid, up.json.workspace.kind, up.json.workspace.name, up.json.workspace.member_device_policy], [A.tid, "team", "甲律师事务所", "auto"]);
  const t = cp.ops.tenant(A.tid)!;
  assert.deepEqual([t.kind, t.personal, t.member_device_policy, t.seats >= 3], ["team", false, "auto", true]);
  assert.equal((await post("/v1/workspace/upgrade", { name: "甲律师事务所" }, A.session)).json.error.code, "not_personal");
  // 非唯一成员：运营开通的两人团队被（用例直接）标成个人，升级仍拒绝
  cp.ops.createTenant({ tid: "ten_b72pair", edition: "team", seats: 2 });
  assert.equal((await ops("op_7202", "POST", "/v1/ops/accounts", { tid: "ten_b72pair", email: "pair1@b72.example", name: "一号", role: "admin" })).status, 200);
  Object.assign(cp.ops.tenant("ten_b72pair")!, { kind: "personal", personal: true, root_public_key_pem: "x" });
  assert.equal((await ops("op_7202", "POST", "/v1/ops/accounts", { tid: "ten_b72pair", email: "pair2@b72.example", name: "二号", role: "lawyer" })).json.error.code, "upgrade_required", "个人工作室不能代建成员");
  Object.assign(cp.ops.tenant("ten_b72pair")!, { kind: "team", personal: false });
  assert.equal((await ops("op_7202", "POST", "/v1/ops/accounts", { tid: "ten_b72pair", email: "pair2@b72.example", name: "二号", role: "lawyer" })).status, 200);
  Object.assign(cp.ops.tenant("ten_b72pair")!, { kind: "personal", personal: true });
  assert.equal((await ops("op_7202", "POST", "/v1/ops/tenants/ten_b72pair/upgrade-team", { name: "二人所" })).json.error.code, "not_sole_member");
  Object.assign(cp.ops.tenant("ten_b72pair")!, { kind: "team", personal: false, root_public_key_pem: null });
  const audit = await ops("op_7202", "GET", `/v1/ops/tenants/${A.tid}/audit`);
  assert.ok(audit.json.records.some((x: any) => x.action === "workspace.upgrade_team" && x.detail?.seats_to >= 3), JSON.stringify(audit.json.records.map((x: any) => x.action)));
  // 升级后可发邀请（设备签名旧接口照常）
  assert.equal((await A.dev.call("POST", "/v1/invitations", { member_slug: "x2", name: "某律师", role: "lawyer" }, A.session)).status, 200);
});

test("契约 §3.2：团队邀请——会话 + admin 发（不要求律所根电脑）；码只此一次、列表不含码；撤销；非管理员 403", async () => {
  const c = await post("/v1/team/invites", { name: "乙律师", role: "lawyer" }, A.session);
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.match(c.json.code, /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  assert.deepEqual([c.json.invite.name, c.json.invite.role, c.json.invite.status, c.json.invite.phone_hint], ["乙律师", "lawyer", "open", null]);
  // 手机号提示只存打码（接受时按末 4 位核对，见 b72-security）
  const h = await post("/v1/team/invites", { name: "提示", role: "lawyer", phone_hint: "13912347201" }, A.session);
  assert.equal(h.json.invite.phone_hint, "139****7201");
  assert.equal((await post(`/v1/team/invites/${h.json.invite.id}/revoke`, {}, A.session)).status, 200);
  const list = await get("/v1/team/invites", A.session);
  assert.equal(list.json.invites.filter((x: any) => x.status === "open").length, 1);
  assert.ok(!JSON.stringify(list.json).includes(c.json.code.replace(/-/g, "").slice(0, 8)) && !("code_hash" in list.json.invites[0]), "列表不含码与摘要");
  (globalThis as any).b72InviteB = c.json.code;
  const r2 = await post("/v1/team/invites", { name: "作废", role: "assistant" }, A.session);
  assert.equal((await post(`/v1/team/invites/${r2.json.invite.id}/revoke`, {}, A.session)).json.invite.status, "revoked");
  (globalThis as any).b72InviteRevoked = r2.json.code;
  assert.equal((await post(`/v1/team/invites/${r2.json.invite.id}/revoke`, {}, A.session)).json.error.code, "invite_not_open");
});

test("契约 §3.3 / §2.2：已注册的人接受邀请——建关联账号（无邮箱 / 手机号 / 密码），应答 = 切换应答；团队成员新电脑直接登记（D-304，account_ca）；重放 / 撤销 / 乱码 invite_invalid；已是成员 409", async () => {
  B = await signup("yi-b72@example.cn", "乙律师", "乙律师工作室");
  const j = await post("/v1/teams/join", { code: (globalThis as any).b72InviteB, client: { version: "0.11.0", platform: "darwin" } }, B.session);
  assert.equal(j.status, 200, JSON.stringify(j.json));
  assert.deepEqual([j.json.workspace.kind, j.json.workspace.tid, j.json.workspace.role, j.json.person.aid], ["team", A.tid, "lawyer", B.aid]);
  assert.deepEqual(j.json.workspaces.map((w: any) => [w.kind, w.current]), [["personal", false], ["team", true]]);
  assert.equal(j.json.account.email, "yi-b72@example.cn", "视图显示这个人的邮箱");
  assert.equal(j.json.account.person, B.aid);
  bTeam = { aid: j.json.account.aid, session: j.json.session_token };
  assert.notEqual(bTeam.aid, B.aid);
  // D-304：团队（策略 auto）成员的新电脑由账号签发钥直接登记；首次满足时团队登记账号设备签发钥
  bTeam.dev = await enrollFrom(j.json);
  assert.equal(bTeam.dev.cert.issuer, "account_ca");
  assert.equal(cp.ops.tenant(A.tid)!.account_device_ca?.kid, "acct-ca-dev1");
  // 账号签发的电脑不能做律所根动作（requireAdmin 原样）
  assert.equal((await bTeam.dev.call("POST", "/v1/invitations", { member_slug: "x3", role: "lawyer" }, bTeam.session)).json.error.code, "admin_required");
  // X7：重放、撤销、乱码统一 invite_invalid；已是成员 409
  assert.equal((await post("/v1/teams/join", { code: (globalThis as any).b72InviteB }, B.session)).json.error.code, "invite_invalid", "重放");
  assert.equal((await post("/v1/teams/join", { code: (globalThis as any).b72InviteRevoked }, B.session)).json.error.code, "invite_invalid", "撤销");
  assert.equal((await post("/v1/teams/join", { code: "ABCD-EFGH-JKMN-PQRS" }, B.session)).json.error.code, "invite_invalid", "乱码");
  const again = await post("/v1/team/invites", { name: "乙律师", role: "lawyer" }, A.session);
  assert.equal((await post("/v1/teams/join", { code: again.json.code }, bTeam.session)).json.error.code, "already_member", "X8：同一团队第二个成员身份");
  assert.equal((await post(`/v1/team/invites/${again.json.invite.id}/revoke`, {}, A.session)).status, 200);
  // 关联账号不进邮箱 / 手机号索引：用乙的邮箱 + 密码登录认证的仍是乙这个人
  assert.equal(cp.ops.account("yi-b72@example.cn")!.aid, B.aid);
});

test("契约 §3.3：未注册的人凭 team_invite_code 注册——主账号直接建在该团队（不建个人空间）；过期的码 invite_invalid", async () => {
  const inv = await post("/v1/team/invites", { name: "丙律师", role: "assistant" }, A.session);
  const n0 = (await ops("op_7202", "GET", "/v1/ops/tenants")).json.tenants.length;
  const r = await post("/v1/auth/register", { email: "bing-b72@example.cn", password: PW, name: "丙", team_invite_code: inv.json.code, client: { version: "0.11.0", platform: "win32" } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.account.tid, r.json.account.name, r.json.account.role, r.json.workspace.kind, r.json.workspaces.length], [A.tid, "丙律师", "assistant", "team", 1]);
  assert.equal(r.json.onboarding.state, "needs_device_auto");
  assert.equal((await ops("op_7202", "GET", "/v1/ops/tenants")).json.tenants.length, n0, "没有新建租户");
  cAid = r.json.account.aid;
  cSession = r.json.session_token;
  // 过期（缺省 7 天）
  const old = await post("/v1/team/invites", { name: "戊律师", role: "lawyer" }, A.session);
  skew = 8 * 86400_000;
  try {
    const x = await post("/v1/auth/register", { email: "wu-b72@example.cn", password: PW, name: "戊", team_invite_code: old.json.code, client: { platform: "web" } });
    assert.deepEqual([x.status, x.json.error.code], [400, "invite_invalid"]);
  } finally {
    skew = 0;
  }
});

test("契约 §6.1 / §6.9 / X3：切换只能到本人的工作空间（别人的 aid、不存在 → 404）；切换应答的会话只属于目标账号；原会话不注销；登录缺省进 last_workspace", async () => {
  assert.equal((await post("/v1/auth/workspaces/switch", { aid: A.aid }, B.session)).json.error.code, "workspace_not_found", "A 的工作空间");
  assert.equal((await post("/v1/auth/workspaces/switch", { aid: `acc_${"z".repeat(16)}` }, B.session)).status, 404);
  const sw = await post("/v1/auth/workspaces/switch", { aid: bTeam.aid, client: { version: "0.11.0", platform: "win32" } }, B.session);
  assert.equal(sw.status, 200, JSON.stringify(sw.json));
  assert.deepEqual([sw.json.account.aid, sw.json.workspace.aid, sw.json.workspace.kind], [bTeam.aid, bTeam.aid, "team"]);
  const me = await get("/v1/auth/me", sw.json.session_token);
  assert.deepEqual([me.json.account.aid, me.json.firm.tid, me.json.workspace.kind, me.json.person.aid], [bTeam.aid, A.tid, "team", B.aid]);
  assert.equal((await get("/v1/auth/me", B.session)).json.account.aid, B.aid, "原工作空间的会话照常");
  // 用切换得到的会话调 /v1/me/*：只返回目标账号（团队成员身份）的数据
  const usage = await get("/v1/me/usage", sw.json.session_token);
  assert.equal(usage.status, 200);
  const ws = await get("/v1/auth/workspaces", B.session);
  assert.deepEqual(ws.json.workspaces.map((w: any) => [w.aid, w.current]), [[B.aid, true], [bTeam.aid, false]]);
  // 切换记下 last_workspace：网页登录缺省进团队
  const li = await post("/v1/auth/login", { email: "yi-b72@example.cn", password: PW, client: { platform: "web" } });
  assert.deepEqual([li.json.account.aid, li.json.workspace.kind], [bTeam.aid, "team"]);
  // 签名的电脑是这个人某个工作空间的已登记电脑：进那个（乙的个人电脑签名 → 个人空间）
  const raw = JSON.stringify({ email: "yi-b72@example.cn", password: PW, client: { version: "0.11.0", platform: "win32" } });
  const h = signDeviceRequest({ method: "POST", path: "/v1/auth/login", body: raw, tid: B.tid, deviceId: B.dev.cert.deviceId, signPrivateKeyPem: B.dev.k.signPrivateKeyPem });
  const li2 = (await (await fetch(`${base}/v1/auth/login`, { method: "POST", headers: { ...h, "content-type": "application/json" }, body: raw })).json()) as any;
  assert.deepEqual([li2.account.aid, li2.onboarding.state], [B.aid, "ready"]);
  // 同一台电脑只留一个有效桌面会话：这次登录替换了注册时的会话
  assert.equal((await get("/v1/auth/me", B.session)).status, 401);
  B.session = li2.session_token;
  // 审计：account.workspace_switch（actor = 主账号）
  const au = await ops("op_7202", "GET", `/v1/ops/tenants/${A.tid}/audit`);
  assert.ok(au.json.records.some((x: any) => x.action === "account.workspace_switch" && x.target === bTeam.aid));
});

test("契约 §6.2 / §6.3 / X2：关联账号（律师）调 /v1/firm/* → 403；个人空间会话看不到团队成员；团队管理员读成员个人空间 → 404", async () => {
  assert.equal((await get("/v1/firm/members", bTeam.session)).json.error.code, "firm_role_required");
  const mine = await get("/v1/firm/members", B.session);
  assert.deepEqual(mine.json.members.map((m: any) => m.aid), [B.aid], "乙个人空间只有乙自己");
  // 甲（团队管理员）对乙的个人空间账号：一律 404
  for (const [m, path] of [["POST", `/v1/firm/members/${B.aid}/limits`], ["POST", `/v1/firm/members/${B.aid}/disable`], ["POST", `/v1/firm/members/${B.aid}/devices/${B.dev.cert.deviceId}/signout`], ["POST", `/v1/firm/seats/${B.aid}/assign`]] as const)
    assert.equal((await req(m, path, m === "POST" ? {} : undefined, S(A.session))).status, 404, path);
  const devs = await get("/v1/firm/devices", A.session);
  assert.ok(!devs.json.devices.some((d: any) => d.device_id === B.dev.cert.deviceId), "团队电脑列表没有成员个人空间的电脑");
  const mem = await get("/v1/firm/members", A.session);
  const row = mem.json.members.find((m: any) => m.aid === bTeam.aid);
  // 安全审查 P2-4：团队看到的是打码邮箱；由团队邀请新建的成员标识是随机串（不从邮箱派生）
  assert.deepEqual([row.email, row.person_phone_masked, row.disabled_by, row.devices_summary.signed_in >= 0, Array.isArray(row.devices)], ["y***@example.cn", null, null, true, true]);
  assert.match(row.member_slug, /^u[0-9a-f]{6}$/);
  assert.ok(row.seat && row.seat.sid, "登记电脑时已占席");
});

test("X1 / X4：别的团队的管理员对本团队真实成员 aid 调 disable / enable / limits / sessions / remove / role / reset-code / signout / seat → 一律 404，状态不变；设备签名冒充别家 tid → 401", async () => {
  D = await signup("ding-b72@example.cn", "丁律师", "丁律师工作室");
  assert.equal((await post("/v1/workspace/upgrade", { name: "丁律师事务所" }, D.session)).status, 200);
  const t = cp.ops.tenant(A.tid)!;
  const before = JSON.stringify([...t.seatsByUser]);
  for (const sub of ["disable", "enable", "limits", "sessions/revoke", "remove", "role", "reset-code"]) assert.equal((await post(`/v1/firm/members/${bTeam.aid}/${sub}`, { role: "admin", device_limit: 1 }, D.session)).status, 404, sub);
  assert.equal((await post(`/v1/firm/members/${bTeam.aid}/devices/${bTeam.dev!.cert.deviceId}/signout`, {}, D.session)).status, 404);
  for (const sub of ["assign", "release"]) assert.equal((await post(`/v1/firm/seats/${bTeam.aid}/${sub}`, {}, D.session)).status, 404, sub);
  assert.equal(JSON.stringify([...t.seatsByUser]), before, "席位不变");
  assert.equal((await get("/v1/auth/me", bTeam.session)).status, 200, "会话仍有效");
  // X4：甲的电脑签名、签名头里写丁的 tid
  const x = await A.dev.call("GET", "/v1/directory", undefined, undefined, D.tid);
  assert.equal(x.status, 401);
});

test("契约 §3.4：成员管理——角色（最后一名管理员不能降级）、席位手动分配 / 收回（不超过席位数）、电脑上限 ≤ 套餐（X5）、成员电脑策略", async () => {
  assert.equal((await post(`/v1/firm/members/${A.aid}/role`, { role: "lawyer" }, A.session)).json.error.code, "last_admin");
  assert.equal((await post(`/v1/firm/members/${cAid}/role`, { role: "partner" }, A.session)).json.member.role, "partner");
  assert.equal((await post(`/v1/firm/members/${cAid}/role`, { role: "root" }, A.session)).json.error.code, "role_invalid");
  // 合伙人：只读
  assert.equal((await get("/v1/firm/members", cSession)).status, 200);
  assert.equal((await post(`/v1/firm/members/${bTeam.aid}/disable`, {}, cSession)).json.error.code, "firm_role_required");
  // 席位
  assert.equal((await post(`/v1/firm/seats/${bTeam.aid}/assign`, {}, A.session)).json.error.code, "seat_assigned");
  assert.equal((await post(`/v1/firm/seats/${bTeam.aid}/release`, {}, A.session)).status, 200);
  assert.equal((await post(`/v1/firm/seats/${bTeam.aid}/release`, {}, A.session)).json.error.code, "seat_unknown");
  const as = await post(`/v1/firm/seats/${bTeam.aid}/assign`, {}, A.session);
  assert.equal(as.status, 200, JSON.stringify(as.json));
  const t = cp.ops.tenant(A.tid)!;
  const used = () => [...t.seatsByUser.values()].filter((x) => !x.revoked_at).length;
  t.seats = used();
  assert.equal((await post(`/v1/firm/seats/${cAid}/assign`, {}, A.session)).json.error.code, "seats_full");
  t.seats = 3;
  // 电脑上限 ≤ 套餐（试用套餐 1 台）
  const planLimit = (await get("/v1/firm/overview", A.session)).json.plan.device_limit as number;
  assert.equal((await post(`/v1/firm/members/${bTeam.aid}/limits`, { device_limit: planLimit + 1 }, A.session)).json.error.code, "device_limit_over_plan");
  assert.equal((await post(`/v1/firm/members/${A.aid}/limits`, { device_limit: planLimit + 1 }, A.session)).json.error.code, "device_limit_over_plan", "管理员也不能给自己放宽");
  assert.equal((await post(`/v1/firm/members/${bTeam.aid}/limits`, { device_limit: planLimit }, A.session)).status, 200);
  // 策略
  assert.equal((await req("PUT", "/v1/firm/policy/member-device", { policy: "sometimes" }, S(A.session))).json.error.code, "policy_invalid");
  assert.equal((await req("PUT", "/v1/firm/policy/member-device", { policy: "approve" }, S(A.session))).json.policy, "approve");
  const inv = await post("/v1/team/invites", { name: "己律师", role: "lawyer" }, A.session);
  const ji = await post("/v1/teams/join", { code: inv.json.code }, D.session);
  assert.equal(ji.json.onboarding.state, "needs_device_join", "策略 approve：新电脑等管理员确认");
  assert.equal((await post("/v1/auth/devices/enroll", { device_id: "x" }, ji.json.session_token)).json.error.code, "device_auto_unavailable");
  assert.equal((await req("PUT", "/v1/firm/policy/member-device", { policy: "auto" }, S(A.session))).json.policy, "auto");
  (globalThis as any).b72DTeam = ji.json.account.aid;
});

test("A3 R3：重置不再给管理员明文——发短信给成员本人（没绑手机号如实说明）", async () => {
  const r = await post(`/v1/firm/members/${bTeam.aid}/reset-code`, {}, A.session);
  assert.deepEqual([r.status, r.json.error.code, "code" in r.json], [409, "phone_unbound", false]);
});

test("契约 §6.6 / X6：平台停用 → 团队管理员启用 → 403 platform_disabled；运营启用后正常；团队停用释放席位、团队启用有空席即还", async () => {
  const dis = await ops("op_7202", "POST", `/v1/ops/accounts/${cAid}/disable`, { reason: "风控" });
  assert.equal(dis.status, 200, dis.text);
  assert.equal(dis.json.account.disabled_by, "platform");
  assert.deepEqual([(await post(`/v1/firm/members/${cAid}/enable`, {}, A.session)).status, (await post(`/v1/firm/members/${cAid}/enable`, {}, A.session)).json.error.code], [403, "platform_disabled"]);
  assert.equal((await ops("op_7202", "POST", `/v1/ops/accounts/${cAid}/enable`, {})).status, 200);
  // 平台停用撤销了丙的会话：重新登录（丙是凭团队邀请注册的主账号，邮箱 + 密码照常）
  const lc = await post("/v1/auth/login", { email: "bing-b72@example.cn", password: PW, client: { platform: "web" } });
  assert.deepEqual([lc.status, lc.json.account.aid], [200, cAid]);
  cSession = lc.json.session_token;
  // 团队停用（R5）：释放席位；启用：有空席即还
  const d2 = await post(`/v1/firm/members/${bTeam.aid}/disable`, { reason: "休假" }, A.session);
  assert.deepEqual([d2.status, d2.json.seat_released, d2.json.member.disabled_by, d2.json.member.seat], [200, 1, "team", null]);
  const e2 = await post(`/v1/firm/members/${bTeam.aid}/enable`, {}, A.session);
  assert.deepEqual([e2.status, e2.json.seat_reassigned, e2.json.member.status], [200, true, "active"]);
  // 启用后重新换一次会话（停用撤销了会话）
  const sw = await post("/v1/auth/workspaces/switch", { aid: bTeam.aid, client: { version: "0.11.0", platform: "win32" } }, B.session);
  assert.equal(sw.status, 200, JSON.stringify(sw.json));
  bTeam.session = sw.json.session_token;
});

test("契约 §4：账号级上手状态挂在主账号上（任何工作空间的会话都看得到；只置不清）", async () => {
  assert.equal((await post("/v1/me/onboarding", { completed: false }, bTeam.session)).json.error.code, "onboarding_invalid");
  const r = await post("/v1/me/onboarding", { completed: true }, bTeam.session);
  assert.equal(r.status, 200);
  assert.ok(r.json.onboarding.completed_at);
  const me = await get("/v1/auth/me", B.session);
  assert.equal(me.json.person.onboarding.completed_at, r.json.onboarding.completed_at, "个人空间会话看到同一时间");
  const r2 = await post("/v1/me/onboarding", { completed: true, dismissed: true }, B.session);
  assert.deepEqual([r2.json.onboarding.completed_at, !!r2.json.onboarding.dismissed_at], [r.json.onboarding.completed_at, true], "只置不清，不覆盖");
});

test("契约 §6.10：两个工作空间各发一次 AI 调用——各自只计入各自租户、各自账号", async () => {
  const tB = cp.ops.tenant(B.tid)!;
  const tA = cp.ops.tenant(A.tid)!;
  const uidTeam = bTeam.dev!.cert.memberId;
  const settle = async (tid: string, uid: string, dev: string, sid: string, id: string, alias: string, qa: boolean) => {
    const l = await service("/v1/quota/lease", { tid, sid, holder: "gw-b72", need_estimate: { alias, input: 1000, output: 500 } });
    assert.equal(l.status, 200, JSON.stringify(l.json));
    const rec = { request_id: id, client_request_id: `c_${id}`, upstream_request_id: `u_${id}`, at: new Date().toISOString(), sid, uid, dev, alias, provider: "maas", upstream_model: alias === "legal/k2.6" ? "kimi-k2.6" : "kimi-k3.1-pro", stream: true, status: 200, outcome: "ok", qa, usage: { input: 1000, cached: 0, output: 500, reasoning: 0 }, usage_source: "upstream", latency_ms: 100, attempts: [{ provider: "maas", status: 200, error: null, ms: 100 }], lease_id: l.json.lease_id };
    const s = await service("/v1/quota/settle", { tid, lease_id: l.json.lease_id, holder: "gw-b72", records: [rec], final: true });
    assert.equal(s.status, 200, JSON.stringify(s.json));
  };
  await settle(B.tid, B.memberId, B.dev.cert.deviceId, tB.seatsByUser.get(B.memberId)!.sid, "kwlgw_b72_p1", "legal/k3", true);
  await settle(A.tid, uidTeam, bTeam.dev!.cert.deviceId, tA.seatsByUser.get(uidTeam)!.sid, "kwlgw_b72_t1", "legal/k2.6", false);
  const pu = await get("/v1/me/usage", B.session);
  const tu = await get("/v1/me/usage", bTeam.session);
  assert.deepEqual([pu.json.own.requests, tu.json.own.requests], [1, 1]);
  assert.deepEqual(pu.json.by_model.map((m: any) => [m.alias, m.label]), [["legal/k3", "K3"]]);
  assert.deepEqual(tu.json.by_model.map((m: any) => [m.alias, m.label]), [["legal/k2.6", "K2.6"]], "显示名与目录同口径（modelMetaOf）");
  const rowsA = cp.usageBook.query({ tid: A.tid }).rows;
  const rowsB = cp.usageBook.query({ tid: B.tid }).rows;
  assert.deepEqual([rowsA.map((r) => r.request_id), rowsB.map((r) => r.request_id)], [["kwlgw_b72_t1"], ["kwlgw_b72_p1"]]);
  assert.deepEqual([rowsA[0]!.aid, rowsB[0]!.aid], [bTeam.aid, B.aid], "各自账号");
  // 逐请求记录照实按模型显示（不做“任务辅助步骤”近似标注：律师主动给任务选 K2.6 时会错标，见契约变更记录 C-8）
  const rec = await get("/v1/firm/usage/records", A.session);
  const x = rec.json.records.find((r: any) => r.request_id === "kwlgw_b72_t1");
  assert.deepEqual([x.alias, x.label, "aux" in x, "purpose_label" in x], ["legal/k2.6", "K2.6", false, false]);
});

test("契约 §8：运营人员与客户——/v1/ops/people（一行 = 一个人，含各工作空间）、详情传关联账号回主账号；客户行 kind / member_count / seat_used、?kind 过滤；账号行带 person；只读人员不能写", async () => {
  const pl = await ops("op_7204", "GET", "/v1/ops/people?q=yi-b72");
  assert.equal(pl.status, 200, pl.text);
  const p = pl.json.people.find((x: any) => x.aid === B.aid);
  assert.deepEqual([p.email_masked, p.workspaces.map((w: any) => [w.kind, w.tid])], ["y***@example.cn", [["personal", B.tid], ["team", A.tid]]]);
  assert.ok(!pl.json.people.some((x: any) => x.aid === bTeam.aid), "关联账号不单列");
  assert.ok((await ops("op_7204", "GET", "/v1/ops/people?q=" + encodeURIComponent("甲律师事务所"))).json.people.some((x: any) => x.aid === B.aid), "按工作空间名搜");
  const det = await ops("op_7204", "GET", `/v1/ops/people/${bTeam.aid}`);
  assert.equal(det.status, 200, det.text);
  assert.deepEqual([det.json.primary_aid, det.json.workspaces.length, det.json.workspaces[1].devices.length >= 1], [B.aid, 2, true]);
  const acc = await ops("op_7204", "GET", `/v1/ops/accounts/${bTeam.aid}`);
  assert.deepEqual([acc.json.account.person, acc.json.account.email, acc.json.account.kind], [B.aid, "yi-b72@example.cn", "team"]);
  const tl = await ops("op_7202", "GET", "/v1/ops/tenants?kind=personal");
  assert.ok(tl.json.tenants.every((t: any) => t.kind === "personal") && tl.json.tenants.some((t: any) => t.tid === B.tid));
  const ta = (await ops("op_7202", "GET", "/v1/ops/tenants?kind=team")).json.tenants.find((t: any) => t.tid === A.tid);
  assert.deepEqual([ta.kind, ta.member_count >= 4, typeof ta.seat_used, typeof ta.seats], ["team", true, "number", "number"]);
  assert.equal((await ops("op_7204", "POST", `/v1/ops/tenants/${A.tid}/invites`, { name: "某", role: "lawyer" })).status, 403);
});

test("契约 §8：运营代发团队邀请（码可用）、手动分配席位（不超过席位数）、代办升级团队（危险操作，审计 actor = staff）；个人空间代发邀请 409", async () => {
  const P = await signup("geng-b72@example.cn", "庚律师", "庚律师工作室");
  assert.equal((await ops("op_7202", "POST", `/v1/ops/tenants/${P.tid}/invites`, { name: "某", role: "lawyer" })).json.error.code, "upgrade_required");
  const up = await ops("op_7202", "POST", `/v1/ops/tenants/${P.tid}/upgrade-team`, { name: "庚律师事务所" });
  assert.equal(up.status, 200, up.text);
  assert.deepEqual([up.json.tenant.kind, cp.ops.tenant(P.tid)!.member_device_policy], ["team", "auto"]);
  const au = await ops("op_7202", "GET", `/v1/ops/tenants/${P.tid}/audit`);
  assert.ok(au.json.records.some((x: any) => x.action === "workspace.upgrade_team" && x.actor?.kind === "ops"), JSON.stringify(au.json.records.map((x: any) => [x.action, x.actor])));
  const inv = await ops("op_7202", "POST", `/v1/ops/tenants/${P.tid}/invites`, { name: "辛律师", role: "lawyer" });
  assert.equal(inv.status, 200, inv.text);
  const j = await post("/v1/teams/join", { code: inv.json.code }, D.session);
  assert.equal(j.status, 200, JSON.stringify(j.json));
  const xin = j.json.account.aid as string;
  const sa = await ops("op_7202", "POST", `/v1/ops/tenants/${P.tid}/seats/${xin}/assign`, {});
  assert.equal(sa.status, 200, sa.text);
  assert.equal((await ops("op_7202", "POST", `/v1/ops/tenants/${P.tid}/seats/${xin}/assign`, {})).json.error.code, "seat_assigned");
  assert.equal((await ops("op_7202", "POST", `/v1/ops/tenants/${A.tid}/seats/${xin}/assign`, {})).status, 404, "不是这家客户的成员");
});

test("契约 §3.4 / §6.4 / X7：移出团队——会话失效、席位释放、旧设备取不到席位令牌、切换到该团队 404；不能移出自己 / 最后一名管理员；成员自己退出团队切回个人空间；唯一工作空间不能退出", async () => {
  assert.equal((await post(`/v1/firm/members/${A.aid}/remove`, {}, A.session)).json.error.code, "cannot_remove_self");
  assert.equal((await bTeam.dev!.call("POST", "/v1/seat-token", {}, bTeam.session)).status, 200, "移出前能取席位令牌");
  const rm = await post(`/v1/firm/members/${bTeam.aid}/remove`, {}, A.session);
  assert.equal(rm.status, 200, JSON.stringify(rm.json));
  assert.deepEqual([rm.json.seat_released, rm.json.member.status, rm.json.member.disabled_by], [1, "disabled", "team"]);
  assert.equal((await get("/v1/auth/me", bTeam.session)).status, 401, "旧会话失效");
  const st = await bTeam.dev!.call("POST", "/v1/seat-token", {}, bTeam.session);
  assert.notEqual(st.status, 200, "旧设备取不到席位令牌");
  assert.equal((await post("/v1/auth/workspaces/switch", { aid: bTeam.aid }, B.session)).status, 404, "切换到已移出的团队 404");
  assert.ok(cp.ops.tenant(A.tid)!.devices.get(bTeam.dev!.cert.deviceId), "设备记录保留（离所交接后再移除）");
  // 乙登录（last_workspace 已清）：回个人空间
  const li = await post("/v1/auth/login", { email: "yi-b72@example.cn", password: PW, client: { platform: "web" } });
  assert.equal(li.json.account.aid, B.aid);
  // 丙（主账号就在甲团队、没有别的工作空间）不能退出；丁加入甲团队的身份可以退出，应答切回丁的个人（已升级的团队）空间
  assert.equal((await post("/v1/teams/leave", {}, cSession)).json.error.code, "no_other_workspace");
  const dTeam = (globalThis as any).b72DTeam as string;
  const sw = await post("/v1/auth/workspaces/switch", { aid: dTeam, client: { platform: "web" } }, D.session);
  assert.equal(sw.status, 200, JSON.stringify(sw.json));
  const lv = await post("/v1/teams/leave", { client: { platform: "web" } }, sw.json.session_token);
  assert.equal(lv.status, 200, JSON.stringify(lv.json));
  assert.deepEqual([lv.json.account.aid, lv.json.workspaces.find((w: any) => w.aid === dTeam).status], [D.aid, "disabled"]);
  assert.equal((await get("/v1/auth/me", sw.json.session_token)).status, 401);
  const au = await ops("op_7202", "GET", `/v1/ops/tenants/${A.tid}/audit`);
  const acts = au.json.records.map((x: any) => x.action);
  for (const a of ["team.invite_create", "team.invite_accept", "team.member_remove", "team.leave", "seat.assign"]) assert.ok(acts.includes(a), a);
  // 唯一管理员不能退出
  assert.equal((await post("/v1/teams/leave", {}, A.session)).json.error.code, "last_admin");
});

test("邀请码限流：同一来源 10 分钟内 10 次没核对上即 429（核对成功不计）", async () => {
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await post("/v1/teams/join", { code: `ZZZZ-ZZZZ-ZZZZ-ZZ${String(i).padStart(2, "2").replace(/[01]/g, "2")}` }, B.session)).status;
  assert.equal(last, 429);
});
