/**
 * 第 46 批统一账号（契约 §2、§3）：首个系统管理员引导与找回、平台人员登录、复核、人员管理约束、角色表；
 * 第 53 批（D-218）：平台人员邮箱 + 密码即登录（没有两步验证、受限会话），/v1/auth/mfa/* 一律 410，复核只要密码；
 * 老状态里的 TOTP 密钥、恢复码与受限会话标记读回即丢弃；本所接口 /v1/firm/*（admin 读写、partner 只读）与 /v1/me/usage；客户端最低版本 426、/v1/meta；
 * 账本 partial / retry_of（服务出错的行不扣额度、成本照记）。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDeviceKeys, generateFirmRoot, issueDeviceCertificate } from "@zr-legal/keys";
import { enrollProofBytes, signDeviceRequest } from "@zr-legal/firm-trust";
import { randomBytes } from "node:crypto";
import { accountDeviceId, createAuditLog, createControlPlane, devControlPlaneKeys, fileStateStore, type ControlPlane, type CpOpsAccessRecord } from "../src/index.ts";
import { call, devStaffOf, STAFF_PW, staffEmail, staffToken } from "./staff-fixture.ts";

const SECRET = "staff-console-test-service-secret-0123456789";
const PW = "Counsel2026secure";
const ADMIN = "root.admin@csi.example.cn";
const ADMIN_PW = "Sysadmin2026secure";
const dataDir = mkdtempSync(join(tmpdir(), "kwl-staff-"));
const access: CpOpsAccessRecord[] = [];
let cp: ControlPlane;
let base = "";
let cp2: ControlPlane;
let base2 = "";
const logs: string[] = [];

before(async () => {
  const log = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  try {
    cp = createControlPlane({ keys: devControlPlaneKeys(), serviceSecret: SECRET, dataDir, bootstrapAdmin: { email: ADMIN, name: "系统管理员" }, opsAccessLog: (r) => void access.push(r) });
  } finally {
    console.log = log;
  }
  cp2 = createControlPlane({ keys: devControlPlaneKeys(), serviceSecret: SECRET, auditLog: createAuditLog(), devStaff: devStaffOf({ op_7001: ["operator", "sysadmin"] }), routing: { bootstrap: { provider: { base_url: "https://maas.example.test/v1" } } } });
  for (const c of [cp, cp2]) await new Promise<void>((r) => c.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(cp.server.address() as AddressInfo).port}`;
  base2 = `http://127.0.0.1:${(cp2.server.address() as AddressInfo).port}`;
});
after(async () => {
  for (const c of [cp, cp2]) {
    c.server.closeAllConnections();
    await new Promise<void>((r) => c.server.close(() => r()));
  }
});

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const web = { platform: "web" };
const readBootstrap = () => Object.fromEntries(readFileSync(join(dataDir, "bootstrap-admin.txt"), "utf8").split("\n").filter((l) => /^[a-z_]+: /.test(l)).map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 2)]));

test("首个系统管理员：引导文件 0600 只含邮箱与设置码（日志只有路径）→ 设密码（文件删）→ 邮箱 + 密码直接登录（不要两步验证、不受限）→ 两步验证接口一律 410 → 危险操作要先用密码复核", async () => {
  const f = join(dataDir, "bootstrap-admin.txt");
  assert.equal(statSync(f).mode & 0o777, 0o600);
  const boot = readBootstrap();
  assert.equal(boot.email, ADMIN);
  assert.match(boot.setup_code!, /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  assert.ok(logs.some((l) => l.includes(f)) && !logs.some((l) => l.includes(boot.setup_code!)), "日志只写文件路径，不写设置码");
  assert.match((await call(base, "POST", "/v1/auth/login", { email: ADMIN, password: ADMIN_PW, client: web })).json.error.message, /设置码/);
  const set = await call(base, "POST", "/v1/auth/password-reset/confirm", { email: ADMIN, code: boot.setup_code, password: ADMIN_PW });
  assert.deepEqual([set.status, set.json.kind], [200, "staff"]);
  assert.equal(existsSync(f), false, "设置码用过即删引导文件");
  // 平台人员不能登录桌面客户端
  const desk = await call(base, "POST", "/v1/auth/login", { email: ADMIN, password: ADMIN_PW, client: { platform: "win32", version: "1.0.0" } });
  assert.deepEqual([desk.status, desk.json.error.code], [403, "staff_client_forbidden"]);
  // 密码错：401，不发会话
  const bad = await call(base, "POST", "/v1/auth/login", { email: ADMIN, password: "Wrong2026password", client: web });
  assert.deepEqual([bad.status, bad.json.error.code, "session_token" in bad.json], [401, "auth_invalid", false]);
  // 密码对：直接发完整会话（没有 mfa_required / mfa_token / restricted）
  const r1 = await call(base, "POST", "/v1/auth/login", { email: ADMIN, password: ADMIN_PW, client: web });
  assert.equal(r1.status, 200, r1.text);
  assert.deepEqual([r1.json.kind, typeof r1.json.session_token, "mfa_required" in r1.json, "mfa_token" in r1.json, "restricted" in r1.json.session, "mfa" in r1.json.account], ["staff", "string", false, false, false, false]);
  const t1 = r1.json.session_token as string;
  assert.ok(Date.parse(r1.json.session.idle_expires_at) - Date.now() <= 30 * 60_000 + 1000, "人员会话闲置 30 分钟");
  // 登录后立即可用运营接口与本人接口（不再有“先绑定两步验证”的受限会话）
  assert.equal((await call(base, "GET", "/v1/ops/staff", undefined, bearer(t1))).status, 200);
  const me1 = await call(base, "GET", "/v1/auth/me", undefined, bearer(t1));
  assert.deepEqual([me1.json.kind, "restricted" in me1.json, me1.json.account.roles, me1.json.account.perms.includes("staff.manage"), "mfa" in me1.json.account], ["staff", false, ["sysadmin"], true, false]);
  // 平台人员不能调成员接口
  assert.equal((await call(base, "GET", "/v1/me/usage", undefined, bearer(t1))).json.error.code, "member_only");
  // 两步验证的接口全部取消：有没有会话都是 410
  for (const [path, h] of [["/v1/auth/mfa/verify", {}], ["/v1/auth/mfa/totp/setup", bearer(t1)], ["/v1/auth/mfa/totp/enable", bearer(t1)], ["/v1/auth/mfa/totp/disable", bearer(t1)]] as const) {
    const x = await call(base, "POST", path, { code: "123456", mfa_token: "kwm1.x" }, h);
    assert.deepEqual([x.status, x.json.error.code], [410, "mfa_removed"], path);
  }
  // 危险操作（人员管理）：未复核 401 → 复核只要密码；密码错 401
  const noRe = await call(base, "POST", "/v1/ops/staff", { email: "fin@csi.example.cn", name: "财务", roles: ["finance"] }, bearer(t1));
  assert.deepEqual([noRe.status, noRe.json.error.code], [401, "reauth_required"]);
  assert.doesNotMatch(noRe.json.error.message, /验证码/);
  assert.equal((await call(base, "POST", "/v1/auth/reauth", { password: "Wrong2026password" }, bearer(t1))).json.error.code, "reauth_invalid");
  const re = await call(base, "POST", "/v1/auth/reauth", { password: ADMIN_PW }, bearer(t1));
  assert.equal(re.status, 200, re.text);
  const fin = await call(base, "POST", "/v1/ops/staff", { email: "fin@csi.example.cn", name: "财务", roles: ["finance"] }, bearer(t1));
  assert.equal(fin.status, 200, fin.text);
  assert.match(fin.json.setup_code, /^[2-9A-HJ-NP-Z]{4}-/);
  const st = cp.ops.staff(ADMIN)!;
  assert.equal("mfa" in st, false, "人员记录不再有两步验证字段");
  assert.equal(JSON.stringify(access).includes(ADMIN_PW) || JSON.stringify(access).includes(t1), false, "访问审计不含密码与令牌");
  assert.ok(access.some((x) => x.action === "staff.login" && x.operator === st.aid && x.email === ADMIN && x.result === "ok"));
  assert.ok(access.some((x) => x.action === "staff.login" && x.operator === st.aid && x.result === "rejected:auth_invalid" && x.source === "127.0.0.1"), "密码错也记访问审计（含来源地址）");
  assert.ok(access.some((x) => x.action === "staff.login" && x.operator === st.aid && x.result === "ok" && x.source === "127.0.0.1"), "登录成功记来源地址");
  await call(base, "POST", "/v1/auth/logout", {}, bearer(t1));
  assert.equal((await call(base, "GET", "/v1/auth/me", undefined, bearer(t1))).status, 401);
  // 未登录访问受保护资源：401
  assert.equal((await call(base, "GET", "/v1/ops/staff")).status, 401);
  assert.equal((await call(base, "GET", "/v1/auth/me")).status, 401);
});

test("人员管理：邮箱跨两表唯一、角色组合（1–3 个、运营与开通专员互斥）、不能停用 / 降级 / 重置自己；停用即吊销会话；重置发新设置码（旧控制台带的 reset_mfa 忽略）；角色表；越权 403", async () => {
  const st = cp.ops.staff(ADMIN)!;
  const h = bearer(await staffToken(base, ADMIN, { password: ADMIN_PW }));
  const roles = await call(base, "GET", "/v1/ops/roles", undefined, h);
  assert.deepEqual(roles.json.roles.map((x: any) => [x.id, x.label]), [["sysadmin", "系统管理员"], ["operator", "客户运营"], ["issuer", "开通专员"], ["finance", "财务"], ["support", "客服"], ["viewer", "只读"]]);
  assert.equal("mfa_policy" in roles.json, false);
  const add = async (body: unknown) => call(base, "POST", "/v1/ops/staff", body, h);
  assert.equal((await add({ email: "x@csi.example.cn", name: "x", roles: ["operator", "issuer"] })).json.error.code, "roles_invalid");
  assert.equal((await add({ email: "x@csi.example.cn", name: "x", roles: [] })).json.error.code, "roles_invalid");
  assert.equal((await add({ email: "x@csi.example.cn", name: "x", roles: ["boss"] })).json.error.code, "roles_invalid");
  assert.equal((await add({ email: "fin@csi.example.cn", name: "x", roles: ["viewer"] })).json.error.code, "email_taken");
  const sup = await add({ email: "sup@csi.example.cn", name: "客服", roles: ["support"] });
  assert.equal(sup.status, 200);
  const sAid = sup.json.staff.aid as string;
  assert.equal((await call(base, "POST", `/v1/ops/staff/${st.aid}/roles`, { roles: ["viewer"] }, h)).json.error.code, "cannot_demote_self");
  assert.equal((await call(base, "POST", `/v1/ops/staff/${st.aid}/disable`, {}, h)).json.error.code, "cannot_disable_self");
  assert.equal((await call(base, "POST", `/v1/ops/staff/${st.aid}/reset`, {}, h)).json.error.code, "cannot_reset_self");
  // 客服设密码、登录（直接得完整会话）→ 越权访问人员管理 403 → 被停用即失效 → 启用 → 重置发新设置码
  assert.equal((await call(base, "POST", "/v1/auth/password-reset/confirm", { email: "sup@csi.example.cn", code: sup.json.setup_code, password: "Helpdesk2026secure" })).status, 200);
  const sl = await call(base, "POST", "/v1/auth/login", { email: "sup@csi.example.cn", password: "Helpdesk2026secure", client: web });
  assert.deepEqual([sl.status, "restricted" in sl.json.session], [200, false]);
  const sh = bearer(sl.json.session_token);
  const deny = await call(base, "GET", "/v1/ops/staff", undefined, sh);
  assert.deepEqual([deny.status, deny.json.error.code], [403, "perm_denied"], "客服不能看人员管理");
  assert.equal((await call(base, "POST", "/v1/auth/reauth", { password: "Helpdesk2026secure" }, sh)).status, 200);
  assert.deepEqual([(await call(base, "POST", "/v1/ops/staff", { email: "evil@csi.example.cn", name: "x", roles: ["sysadmin"] }, sh)).status], [403], "复核过也不能越权建人员");
  const dis = await call(base, "POST", `/v1/ops/staff/${sAid}/disable`, { reason: "离职" }, h);
  assert.deepEqual([dis.status, dis.json.sessions_revoked, dis.json.staff.status], [200, 1, "disabled"]);
  assert.equal((await call(base, "GET", "/v1/auth/me", undefined, sh)).status, 401);
  assert.equal((await call(base, "POST", "/v1/auth/login", { email: "sup@csi.example.cn", password: "Helpdesk2026secure", client: web })).json.error.code, "account_disabled");
  assert.equal((await call(base, "POST", `/v1/ops/staff/${sAid}/enable`, {}, h)).status, 200);
  const rs = await call(base, "POST", `/v1/ops/staff/${sAid}/reset`, { reset_mfa: true }, h);
  assert.deepEqual([rs.status, "mfa_reset" in rs.json], [200, false]);
  assert.match(rs.json.setup_code, /^[2-9A-HJ-NP-Z]{4}-/);
  assert.equal((await call(base, "POST", `/v1/ops/staff/${sAid}/roles`, { roles: ["support", "viewer"] }, h)).json.staff.roles.join(), "support,viewer");
  const list = await call(base, "GET", "/v1/ops/staff", undefined, h);
  assert.ok(list.json.staff.some((x: any) => x.email === ADMIN && !("mfa" in x)));
  assert.equal("mfa_policy" in list.json, false);
  // 律师注册不能用平台人员的邮箱
  cp.ops.createTenant({ tid: "ten_mail", edition: "team", seats: 1 });
  const c = cp.ops.issueActivationCode("ten_mail", { member: { slug: "boss" } });
  assert.equal((await call(base, "POST", "/v1/auth/register", { email: "fin@csi.example.cn", password: PW, name: "x", code: c.code })).json.error.code, "email_taken");
});

test("登录防护照旧：同一来源每分钟至多 20 次登录尝试（429）；平台人员连错 10 次锁 15 分钟（423，锁定期间密码对也不发会话）", async () => {
  const cpL = createControlPlane({ keys: devControlPlaneKeys(), serviceSecret: SECRET, devStaff: devStaffOf({ op_7101: ["viewer"] }) });
  await new Promise<void>((r) => cpL.server.listen(0, "127.0.0.1", () => r()));
  const at = `http://127.0.0.1:${(cpL.server.address() as AddressInfo).port}`;
  try {
    const email = staffEmail("op_7101");
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await call(at, "POST", "/v1/auth/login", { email, password: `Wrong2026pass${i}`, client: web })).status);
    assert.deepEqual([...new Set(codes)], [401]);
    const lk = await call(at, "POST", "/v1/auth/login", { email, password: STAFF_PW, client: web });
    assert.deepEqual([lk.status, lk.json.error.code, "session_token" in lk.json], [423, "account_locked", false]);
    const more: number[] = [];
    for (let i = 0; i < 12; i++) more.push((await call(at, "POST", "/v1/auth/login", { email: "nobody@csi.example.cn", password: "x", client: web })).status);
    assert.ok(more.includes(429), `同一来源超过每分钟 20 次即 429：${more.join(",")}`);
  } finally {
    cpL.server.closeAllConnections();
    await new Promise<void>((r) => cpL.server.close(() => r()));
  }
});

test("全部系统管理员失联：服务器上写 admin-recovery.request → 吊销会话、作废密码、写新设置码；无效邮箱的请求只删除；找回后直接登录", async () => {
  const st = cp.ops.staff(ADMIN)!;
  const live = await staffToken(base, ADMIN, { password: ADMIN_PW, reauth: false });
  writeFileSync(join(dataDir, "admin-recovery.request"), "nobody@csi.example.cn\n");
  cp.adminTick();
  assert.equal(existsSync(join(dataDir, "admin-recovery.request")), false);
  assert.equal(existsSync(join(dataDir, "bootstrap-admin.txt")), false, "无效请求不发码");
  assert.ok(st.pw, "无效请求不动现有管理员");
  writeFileSync(join(dataDir, "admin-recovery.request"), `# 找回\n${ADMIN}\n`);
  cp.adminTick();
  assert.equal(existsSync(join(dataDir, "admin-recovery.request")), false);
  const boot = readBootstrap();
  assert.equal(boot.email, ADMIN);
  assert.equal(st.pw, null);
  assert.equal((await call(base, "GET", "/v1/auth/me", undefined, bearer(live))).status, 401, "找回即吊销旧会话");
  assert.match((await call(base, "POST", "/v1/auth/login", { email: ADMIN, password: ADMIN_PW, client: web })).json.error.message, /设置码/);
  assert.equal((await call(base, "POST", "/v1/auth/password-reset/confirm", { email: ADMIN, code: boot.setup_code, password: "Recovered2026secure" })).status, 200);
  const r = await call(base, "POST", "/v1/auth/login", { email: ADMIN, password: "Recovered2026secure", client: web });
  assert.deepEqual([r.status, typeof r.json.session_token, "restricted" in r.json.session], [200, "string", false], "找回后设好密码即可登录");
  assert.ok(access.some((x) => x.action === "staff.recovery" && x.result === "ok"));
});

// ─── 本所接口、本人用量、最低版本、元信息、账本 partial（第二个控制面：两步验证 optional + 开发人员） ───
const ops = async (method: string, path: string, body?: unknown) => call(base2, method, path, body, bearer(await opsToken()));
let opsTok = "";
const opsToken = async () => (opsTok ||= await staffToken(base2, staffEmail("op_7001")));
const login2 = async (email: string, password = PW, client: Record<string, string> = web) => (await call(base2, "POST", "/v1/auth/login", { email, password, client })).json.session_token as string;

async function firm() {
  const tid = "ten_firmweb";
  assert.equal((await ops("POST", "/v1/ops/tenants", { tid, name: "网页所", edition: "team", seats: 5 })).status, 200);
  const code = cp2.ops.issueActivationCode(tid, { member: { slug: "boss" } });
  const reg = await call(base2, "POST", "/v1/auth/register", { email: "boss@firmweb.cn", password: PW, name: "王主任", code: code.code, client: { platform: "win32", version: "1.0.0" } });
  assert.equal(reg.status, 200, reg.text);
  const root = generateFirmRoot();
  const ts = Date.now();
  const proof = sign(null, enrollProofBytes(tid, root.publicKeyPem, ts), root.privateKeyPem).toString("base64url");
  assert.equal((await call(base2, "POST", "/v1/enroll", { tid, root_public_key_pem: root.publicKeyPem, ts, proof, activation_id: reg.json.onboarding.claim.activation_id, claim_secret: reg.json.onboarding.claim.claim_secret })).status, 200);
  const k = generateDeviceKeys();
  const memberId = `usr_${tid.slice(4)}_boss`;
  const deviceId = accountDeviceId(tid.slice(4), "boss", 1);
  const cert = issueDeviceCertificate(root.privateKeyPem, { certId: "c_firmweb", memberId, deviceId, role: "admin", signPublicKeyPem: k.signPublicKeyPem, encPublicKeyPem: k.encPublicKeyPem, issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 86400_000 * 365).toISOString() });
  const raw = JSON.stringify({ tid, cert, client: { version: "1.0.0" } });
  const h = signDeviceRequest({ method: "POST", path: "/v1/devices/register", body: raw, tid, deviceId, signPrivateKeyPem: k.signPrivateKeyPem });
  assert.equal((await fetch(`${base2}/v1/devices/register`, { method: "POST", headers: { ...h, "content-type": "application/json", "x-kwl-session": reg.json.session_token }, body: raw })).status, 200);
  const member = async (slug: "partner" | "lawyer") => {
    const c = await ops("POST", "/v1/ops/accounts", { tid, email: `${slug}@firmweb.cn`, name: `${slug}律师`, role: slug });
    assert.equal(c.status, 200, c.text);
    assert.equal((await call(base2, "POST", "/v1/auth/password-reset/confirm", { email: `${slug}@firmweb.cn`, code: c.json.setup_code, password: PW })).status, 200);
    return { aid: c.json.account.aid as string, token: await login2(`${slug}@firmweb.cn`) };
  };
  const partner = await member("partner");
  const lawyer = await member("lawyer");
  const seat = cp2.ops.tenant(tid)!.seatsByUser.get(memberId)!.sid;
  return { tid, memberId, deviceId, seat, k, boss: { aid: reg.json.account.aid as string, token: await login2("boss@firmweb.cn") }, desktopSession: reg.json.session_token as string, partner, lawyer };
}
let F: Awaited<ReturnType<typeof firm>>;

test("本所接口：admin 读写、partner 只读、律师 403；不能停自己；个人上限不超过本所总额度、设备数 1–9；停用 / 启用 / 下线 / 重置码；月度上限与设备签名同一字段；账单不含成本", async () => {
  F = await firm();
  const as = (who: { token: string }, method: string, path: string, body?: unknown) => call(base2, method, path, body, bearer(who.token));
  const ov = await as(F.partner, "GET", "/v1/firm/overview");
  assert.equal(ov.status, 200, ov.text);
  assert.deepEqual([ov.json.firm.tid, ov.json.firm.name, ov.json.seats.total, ov.json.counts.members, ov.json.plan.id], [F.tid, "网页所", 5, 3, "standard"]);
  assert.equal(typeof ov.json.quota.used_ratio, "number");
  assert.deepEqual([(await as(F.lawyer, "GET", "/v1/firm/overview")).status, (await as(F.lawyer, "GET", "/v1/firm/overview")).json.error.code], [403, "firm_role_required"]);
  const pw = await as(F.partner, "POST", `/v1/firm/members/${F.lawyer.aid}/disable`, {});
  assert.deepEqual([pw.status, pw.json.error.code], [403, "firm_role_required"], "合伙人只读");
  const mem = await as(F.boss, "GET", "/v1/firm/members");
  assert.deepEqual(mem.json.members.map((m: any) => m.role).sort(), ["admin", "lawyer", "partner"]);
  assert.deepEqual(mem.json.pending_joins, []);
  assert.equal(mem.json.members.find((m: any) => m.role === "admin").devices.length, 1);
  assert.equal((await as(F.boss, "POST", `/v1/firm/members/${F.boss.aid}/disable`, {})).json.error.code, "cannot_disable_self");
  // 别家律所的账号：404
  assert.equal((await as(F.boss, "POST", `/v1/firm/members/acc_${"x".repeat(16)}/enable`, {})).status, 404);
  // 个人上限与设备数
  const total = ov.json.quota.total as number;
  assert.equal((await as(F.boss, "POST", `/v1/firm/members/${F.lawyer.aid}/limits`, { quota_limit: total + 1 })).json.error.code, "quota_limit_too_large");
  assert.equal((await as(F.boss, "POST", `/v1/firm/members/${F.lawyer.aid}/limits`, { device_limit: 10 })).json.error.code, "device_limit_invalid");
  assert.equal((await as(F.boss, "POST", `/v1/firm/members/${F.lawyer.aid}/limits`, { device_limit: 0 })).json.error.code, "device_limit_invalid");
  // 第 72 批（A3 R1）：团队侧电脑上限不得超过套餐（standard 每账号 2 台）
  assert.equal((await as(F.boss, "POST", `/v1/firm/members/${F.lawyer.aid}/limits`, { device_limit: 3 })).json.error.code, "device_limit_over_plan");
  const lim = await as(F.boss, "POST", `/v1/firm/members/${F.lawyer.aid}/limits`, { quota_limit: 1_000_000, device_limit: 2 });
  assert.deepEqual([lim.status, lim.json.member.quota_limit, lim.json.member.device_limit], [200, 1_000_000, 2]);
  // 停用：会话吊销、登录被拒；启用：解锁；下线；重置码给本人在“忘记密码”里用
  const dis = await as(F.boss, "POST", `/v1/firm/members/${F.lawyer.aid}/disable`, { reason: "休假" });
  assert.deepEqual([dis.status, dis.json.sessions_revoked, dis.json.member.status], [200, 1, "disabled"]);
  assert.equal((await as(F.lawyer, "GET", "/v1/auth/me")).status, 401);
  assert.equal((await call(base2, "POST", "/v1/auth/login", { email: "lawyer@firmweb.cn", password: PW, client: web })).json.error.code, "account_disabled");
  assert.equal((await as(F.boss, "POST", `/v1/firm/members/${F.lawyer.aid}/enable`, {})).json.member.status, "active");
  F.lawyer.token = await login2("lawyer@firmweb.cn");
  assert.equal((await as(F.boss, "POST", `/v1/firm/members/${F.lawyer.aid}/sessions/revoke`, {})).json.revoked, 1);
  // 第 72 批（A3 R3）：管理员不再拿到重置码明文——改为给成员本人绑定的手机号发找回密码短信；没绑手机号时如实说明（不回任何码）
  const rc = await as(F.boss, "POST", `/v1/firm/members/${F.lawyer.aid}/reset-code`, {});
  assert.deepEqual([rc.status, rc.json.error.code, "code" in rc.json], [409, "phone_unbound", false]);
  const orc = await ops("POST", `/v1/ops/accounts/${F.lawyer.aid}/reset-code`, {});
  assert.equal(orc.status, 200, orc.text);
  assert.equal((await call(base2, "POST", "/v1/auth/password-reset/confirm", { email: "lawyer@firmweb.cn", code: orc.json.reset_code, password: "Counsel2027secure" })).status, 200);
  F.lawyer.token = await login2("lawyer@firmweb.cn", "Counsel2027secure");
  // 第 46 批复核：管理员之间不互发重置码（拿到码即可接管对方账号）；给自己发不受限
  const admin2 = await ops("POST", "/v1/ops/accounts", { tid: F.tid, email: "admin2@firmweb.cn", name: "第二管理员", role: "admin" });
  assert.equal(admin2.status, 200, admin2.text);
  const rc2 = await as(F.boss, "POST", `/v1/firm/members/${admin2.json.account.aid}/reset-code`, {});
  assert.deepEqual([rc2.status, rc2.json.error.code], [403, "admin_reset_by_support"]);
  assert.equal((await as(F.boss, "POST", `/v1/firm/members/${F.boss.aid}/reset-code`, {})).json.error.code, "phone_unbound", "给自己发同样走短信（没绑手机号即说明）");
  // 月度上限：网页与设备签名 PUT /v1/quota/cap 同一字段；律所流水记账号
  assert.equal((await as(F.partner, "PUT", "/v1/firm/cap", { monthly_cap_pct: 70 })).status, 403);
  assert.equal((await as(F.boss, "PUT", "/v1/firm/cap", { monthly_cap_pct: 101 })).json.error.code, "cap_invalid");
  assert.deepEqual((await as(F.boss, "PUT", "/v1/firm/cap", { monthly_cap_pct: 70 })).json, { ok: true, cap_pct: 70 });
  assert.equal(cp2.ops.tenant(F.tid)!.quota.cap_pct, 70);
  const row = (await ops("GET", `/v1/ops/tenants/${F.tid}/usage`)).json;
  assert.equal(row.cap_set_by, "account");
  const devs = await as(F.partner, "GET", "/v1/firm/devices");
  assert.deepEqual(devs.json.devices.map((d: any) => [d.device_id, d.version, d.revoked]), [[F.deviceId, "1.0.0", false]]);
  const bill = await as(F.partner, "GET", "/v1/firm/billing");
  assert.equal(bill.status, 200);
  assert.ok("revenue_cny" in bill.json && !("cost_cny" in bill.json) && !("margin_cny" in bill.json), "本所账单不含成本与毛利");
});

test("账本 partial / retry_of：服务出错的行不扣额度、售价 0；估算的成本另记待对账（第 62 批：估算不当作实测）；本人用量、本所逐请求与 CSV、运营明细都标“服务出错，用量按估算（不计费，成本待对账）”", async () => {
  const at = new Date().toISOString();
  const rec = (id: string, u: { input: number; output: number }, extra: Record<string, unknown> = {}) => ({ request_id: id, client_request_id: `c-${id}`, at, sid: F.seat, uid: F.memberId, dev: F.deviceId, alias: "legal/k3", provider: "maas", stream: true, status: 200, outcome: "ok", usage: { input: u.input, cached: 0, output: u.output, reasoning: 0 }, usage_source: "upstream", attempts: [], ...extra });
  // 价目（成本价）：partial 行按估算记成本
  assert.equal((await ops("PUT", "/v1/ops/routing/prices", { items: { "legal/k3": { input: 4, cached_input: 1, output: 16, cost_input: 2, cost_cached_input: 0.5, cost_output: 8 } } })).status, 200);
  const bad = await call(base2, "POST", "/v1/quota/settle", { tid: F.tid, records: [rec("kwlgw_bad1", { input: 1, output: 1 }, { retry_of: "bad id!" })] }, bearer(SECRET));
  assert.deepEqual([bad.status, bad.json.error.code], [400, "records_invalid"]);
  const s = await call(base2, "POST", "/v1/quota/settle", { tid: F.tid, records: [rec("kwlgw_ok1", { input: 1000, output: 500 }), rec("kwlgw_part1", { input: 3000, output: 2000 }, { outcome: "timeout", usage_source: "estimated", partial: true }), rec("kwlgw_retry1", { input: 100, output: 50 }, { retry_of: "kwlgw_ok1" })] }, bearer(SECRET));
  assert.deepEqual([s.status, s.json.accepted], [200, 3], s.text);
  const rows = cp2.usageBook.query({ tid: F.tid }).rows;
  const part = rows.find((r) => r.request_id === "kwlgw_part1")!;
  assert.deepEqual([part.partial, part.usage, part.charge, part.value_micro, part.partial_usage?.input], [true, null, 0, 0, 3000]);
  // 第 62 批：估算的用量不当作实测——成本不进实测成本（cost_micro 为 null），按估算折的成本另记 est_cost_micro，标待对账
  assert.equal(part.cost_micro, null, "估算成本不混进实测成本");
  assert.deepEqual([part.reconcile, part.est_usage?.input, part.est_cost_micro], ["pending", 3000, 3000 * 2 + 2000 * 8], "估算成本另记（对账）");
  assert.equal(rows.find((r) => r.request_id === "kwlgw_retry1")!.retry_of, "kwlgw_ok1");
  // 本人用量：只算 ok + retry 两行的 token
  const boss = { token: await login2("boss@firmweb.cn") };
  const me = await call(base2, "GET", "/v1/me/usage?days=7", undefined, bearer(boss.token));
  assert.equal(me.status, 200, me.text);
  assert.deepEqual([me.json.unit, me.json.own.used, me.json.daily.length], ["tokens", 1650, 7]);
  assert.deepEqual(me.json.by_model.map((m: any) => [m.alias, m.tokens]), [["legal/k3", 1650]]);
  assert.equal(me.json.firm.cap_pct, 70);
  assert.equal((await call(base2, "GET", "/v1/ops/tenants/" + F.tid + "/usage", undefined, bearer(boss.token))).json.error.code, "staff_required");
  const fr = await call(base2, "GET", "/v1/firm/usage/records", undefined, bearer(boss.token));
  const pr = fr.json.records.find((r: any) => r.request_id === "kwlgw_part1");
  assert.deepEqual([pr.partial, pr.note, pr.tokens_in, pr.member], [true, "服务出错，用量按估算（不计费，成本待对账）", 0, "王主任"]);
  assert.equal(fr.json.records.find((r: any) => r.request_id === "kwlgw_retry1").note, "重试");
  const csv = await fetch(`${base2}/v1/firm/usage/records.csv`, { headers: bearer(boss.token) });
  assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
  assert.ok((await csv.text()).includes("服务出错，用量按估算（不计费，成本待对账）"));
  const sum = await call(base2, "GET", "/v1/firm/usage/summary?days=7", undefined, bearer(boss.token));
  assert.deepEqual([sum.json.totals.tokens, sum.json.totals.requests, sum.json.by_member[0].name], [1650, 3, "王主任"]);
  const opsRec = (await ops("GET", `/v1/ops/usage/records?${new URLSearchParams({ tid: F.tid })}`)).json.records.find((r: any) => r.request_id === "kwlgw_part1");
  assert.equal(opsRec.billing_note, "服务出错，用量按估算（不计费，成本待对账）");
  assert.deepEqual([opsRec.cost_cny, opsRec.est_cost_cny], [null, 0.022]);
  const opsCsv = await fetch(`${base2}/v1/ops/usage/records.csv?${new URLSearchParams({ tid: F.tid })}`, { headers: bearer(await opsToken()) });
  assert.ok((await opsCsv.text()).includes("估算token(不计费)"));
});

test("客户端最低版本：低于 min_version 的桌面客户端登录、注册、续期席位令牌 426；网页不拦；/v1/meta 无鉴权（不再有 staff_mfa）；旧控制台带的 staff_mfa 忽略；设置校验", async () => {
  const meta0 = await call(base2, "GET", "/v1/meta");
  // 第 62 批起另有能力字段（registration_policy、sms_available、features；契约 docs/contract-b62-registration.md）
  // 第 68 批（V42）另有 account_switch（同一台电脑换账号）
  const { registration_policy: pol0, sms_available: _s0, features: _f0, account_switch: sw0, ...meta0Base } = meta0.json;
  assert.equal(sw0, true);
  assert.deepEqual(meta0Base, { api: "kwl-cp/2", min_client_version: null, registration: "open" });
  assert.deepEqual([pol0.mode, pol0.require_phone, pol0.sms_available], ["open", false, false]);
  assert.equal((await ops("PUT", "/v1/ops/settings", { clients: { min_version: "1.2" } })).json.error.code, "min_version_invalid");
  const put = await ops("PUT", "/v1/ops/settings", { clients: { min_version: "1.2.0" }, staff_mfa: "required" });
  assert.deepEqual([put.status, put.json.clients.min_version, "staff_mfa" in put.json], [200, "1.2.0", false]);
  assert.equal((await call(base2, "GET", "/v1/meta")).json.min_client_version, "1.2.0");
  const old = await call(base2, "POST", "/v1/auth/login", { email: "boss@firmweb.cn", password: PW, client: { platform: "win32", version: "1.1.9" } });
  assert.deepEqual([old.status, old.json.error.code, old.json.error.min_version], [426, "client_outdated", "1.2.0"]);
  assert.match(old.json.error.message, /升级到 1\.2\.0/);
  assert.equal((await call(base2, "POST", "/v1/auth/login", { email: "boss@firmweb.cn", password: PW, client: { platform: "win32", version: "1.2.0" } })).status, 200);
  assert.equal((await call(base2, "POST", "/v1/auth/login", { email: "boss@firmweb.cn", password: PW, client: web })).status, 200, "网页不拦");
  assert.equal((await call(base2, "POST", "/v1/auth/register", { email: "new@x.cn", password: PW, name: "新人", client: { platform: "win32", version: "0.9.0" } })).status, 426);
  // 已登录的旧客户端续期席位令牌（设备登记时报的是 1.0.0）
  const raw = "";
  const h = signDeviceRequest({ method: "POST", path: "/v1/seat-token", body: raw, tid: F.tid, deviceId: F.deviceId, signPrivateKeyPem: F.k.signPrivateKeyPem });
  const st = await fetch(`${base2}/v1/seat-token`, { method: "POST", headers: { ...h, "x-kwl-session": F.desktopSession } });
  const sj = (await st.json()) as any;
  assert.deepEqual([st.status, sj.error.code], [426, "client_outdated"], JSON.stringify(sj));
  assert.equal((await ops("PUT", "/v1/ops/settings", { clients: { min_version: null } })).json.clients.min_version, null);
});

test("状态快照带人员与客户端版本（封装落盘、重启读回）；第 46 批之前的快照（没有 staff 字段）读回为空人员、注册方式保持原值", async () => {
  const d = mkdtempSync(join(tmpdir(), "kwl-staff-state-"));
  const key = randomBytes(32);
  const keys = devControlPlaneKeys();
  const mk = (extra: Record<string, unknown> = {}) => createControlPlane({ keys, serviceSecret: SECRET, stateStore: fileStateStore(join(d, "state"), { key }), ...extra });
  const a = mk({ devStaff: devStaffOf({ op_8001: ["finance"] }), clients: { min_version: "0.9.0" }, billing: {} });
  const raw = readFileSync(join(d, "state.1")).toString("latin1") + (existsSync(join(d, "state.2")) ? readFileSync(join(d, "state.2")).toString("latin1") : "");
  assert.equal(raw.includes(staffEmail("op_8001")), false, "人员记录随快照封装加密（明文里看不到邮箱）");
  a.server.close();
  const b = mk();
  assert.deepEqual(b.ops.staff(staffEmail("op_8001"))?.roles, ["finance"], "重启读回人员");
  await new Promise<void>((r) => b.server.listen(0, "127.0.0.1", () => r()));
  const at = `http://127.0.0.1:${(b.server.address() as AddressInfo).port}`;
  const { registration_policy: polB, sms_available: _sB, features: _fB, account_switch: _swB, ...metaB } = (await call(at, "GET", "/v1/meta")).json;
  assert.deepEqual(metaB, { api: "kwl-cp/2", min_client_version: "0.9.0", registration: "code" }, "最低版本与“给了 billing 段缺省 code”都随状态读回");
  assert.equal(polB.invite_required, true);
  assert.equal(typeof (await staffToken(at, staffEmail("op_8001"))), "string");
  b.server.closeAllConnections();
  await new Promise<void>((r) => b.server.close(() => r()));
  // 旧快照：没有 staff / clients；注册方式 open 保持（不被新缺省改成 code）
  const d2 = mkdtempSync(join(tmpdir(), "kwl-staff-old-"));
  const old = fileStateStore(join(d2, "state"), { key });
  const c0 = createControlPlane({ keys, serviceSecret: SECRET, stateStore: old });
  c0.ops.createTenant({ tid: "ten_old", edition: "team", seats: 1 });
  c0.server.close();
  const snap = JSON.parse(old.load()!);
  delete snap.staff;
  delete snap.clients;
  old.save(JSON.stringify(snap));
  const c1 = createControlPlane({ keys, serviceSecret: SECRET, stateStore: fileStateStore(join(d2, "state"), { key }), billing: {} });
  assert.equal(c1.ops.staff("anyone@x.cn"), undefined);
  await new Promise<void>((r) => c1.server.listen(0, "127.0.0.1", () => r()));
  const at1 = `http://127.0.0.1:${(c1.server.address() as AddressInfo).port}`;
  assert.equal((await call(at1, "GET", "/v1/meta")).json.registration, "open", "旧状态的注册方式保持原值");
  c1.server.closeAllConnections();
  await new Promise<void>((r) => c1.server.close(() => r()));
});

test("第 53 批（D-218）之前的快照：人员记录里的 TOTP 密钥与恢复码摘要、受限会话标记读回即丢弃——已登录的受限会话变成普通会话，下次落盘不再含密钥", async () => {
  const d = mkdtempSync(join(tmpdir(), "kwl-staff-mfa-old-"));
  const key = randomBytes(32);
  const keys = devControlPlaneKeys();
  const store = fileStateStore(join(d, "state"), { key });
  const a = createControlPlane({ keys, serviceSecret: SECRET, stateStore: store, devStaff: devStaffOf({ op_8101: ["sysadmin"] }) });
  await new Promise<void>((r) => a.server.listen(0, "127.0.0.1", () => r()));
  const tok = await staffToken(`http://127.0.0.1:${(a.server.address() as AddressInfo).port}`, staffEmail("op_8101"), { reauth: false });
  a.server.closeAllConnections();
  await new Promise<void>((r) => a.server.close(() => r()));
  // 造一份第 46～52 批形态的快照：人员带 mfa（绑定过 TOTP），会话带 restricted
  const SECRET_B32 = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
  const snap = JSON.parse(store.load()!);
  for (const x of snap.staff) x.mfa = { totp: { secret: SECRET_B32, enabled_at: new Date().toISOString(), last_step: 1 }, pending: null, recovery: ["ab".repeat(32)] };
  for (const x of snap.sessions) x.restricted = "mfa_enroll";
  store.save(JSON.stringify(snap));
  const b = createControlPlane({ keys, serviceSecret: SECRET, stateStore: fileStateStore(join(d, "state"), { key }) });
  await new Promise<void>((r) => b.server.listen(0, "127.0.0.1", () => r()));
  const at = `http://127.0.0.1:${(b.server.address() as AddressInfo).port}`;
  try {
    assert.equal("mfa" in b.ops.staff(staffEmail("op_8101"))!, false);
    const me = await call(at, "GET", "/v1/auth/me", undefined, bearer(tok));
    assert.deepEqual([me.status, "restricted" in me.json], [200, false], "旧受限会话读回为普通会话");
    assert.equal((await call(at, "GET", "/v1/ops/staff", undefined, bearer(tok))).status, 200);
    const fresh = await call(at, "POST", "/v1/auth/login", { email: staffEmail("op_8101"), password: STAFF_PW, client: web });
    assert.deepEqual([fresh.status, typeof fresh.json.session_token, "mfa_required" in fresh.json], [200, "string", false], "绑定过 TOTP 的人也只要密码");
    // 落盘一次后快照里不再有密钥
    const again = await call(at, "POST", "/v1/auth/logout", {}, bearer(fresh.json.session_token));
    assert.equal(again.status, 200);
    const now = JSON.parse(fileStateStore(join(d, "state"), { key }).load()!);
    assert.equal(JSON.stringify(now).includes(SECRET_B32), false, "TOTP 密钥不再落盘");
    // 落盘只留一个不含密钥的空旧字段（给回滚到第 52 批的旧版读，不崩）；会话不再带 restricted
    assert.deepEqual(now.staff.map((x: any) => x.mfa), [{ totp: null, pending: null, recovery: [] }]);
    assert.equal(now.sessions.every((x: any) => !("restricted" in x)), true);
  } finally {
    b.server.closeAllConnections();
    await new Promise<void>((r) => b.server.close(() => r()));
  }
});
