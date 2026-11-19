/**
 * 第 46 批统一账号（契约 §2、§3）：首个系统管理员引导与找回、平台人员登录 + TOTP（用本仓库实现的 RFC 6238 算码）+ 恢复码、
 * 受限会话、复核、人员管理约束、角色表；本所接口 /v1/firm/*（admin 读写、partner 只读）与 /v1/me/usage；客户端最低版本 426、/v1/meta；
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
import { base32Decode, hotp, totpAt, verifyTotp } from "../src/totp.ts";
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
  cp2 = createControlPlane({ keys: devControlPlaneKeys(), serviceSecret: SECRET, auditLog: createAuditLog(), staffMfa: "optional", devStaff: devStaffOf({ op_7001: ["operator", "sysadmin"] }), routing: { bootstrap: { provider: { base_url: "https://maas.example.test/v1" } } } });
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
/** 首个用例绑定时拿到的恢复码（后面的用例用它登录与复核）。 */
let RECOVERY: string[] = [];
const readBootstrap = () => Object.fromEntries(readFileSync(join(dataDir, "bootstrap-admin.txt"), "utf8").split("\n").filter((l) => /^[a-z_]+: /.test(l)).map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 2)]));

test("TOTP 算法：RFC 6238 附录 B 的 SHA-1 向量；±1 步、同一步不得重用", () => {
  const key = Buffer.from("12345678901234567890");
  // RFC 6238 附录 B（8 位码的末 6 位即 6 位码）
  for (const [t, want] of [[59, "287082"], [1111111109, "081804"], [1111111111, "050471"], [1234567890, "005924"], [2000000000, "279037"]] as const) assert.equal(hotp(key, Math.floor(t / 30)), want, String(t));
  const b32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.deepEqual(base32Decode(b32), key);
  const t0 = 1_800_000_000_000;
  assert.equal(totpAt(b32, t0), hotp(key, Math.floor(t0 / 30_000)));
  assert.equal(verifyTotp(b32, totpAt(b32, t0 - 30_000), t0, null), Math.floor(t0 / 30_000) - 1, "前 1 步可用");
  assert.equal(verifyTotp(b32, totpAt(b32, t0 - 60_000), t0, null), null, "前 2 步不可用");
  assert.equal(verifyTotp(b32, totpAt(b32, t0), t0, Math.floor(t0 / 30_000)), null, "用过的步不能再用");
  assert.equal(verifyTotp(b32, "12345", t0, null), null);
});

test("首个系统管理员：引导文件 0600 只含邮箱与设置码（日志只有路径）→ 设密码（文件删）→ 受限会话只能绑定 → 绑定得 8 个恢复码 → 动态码登录、同一步不能重用 → 恢复码一次性 → 复核后才能做危险操作", async () => {
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
  // 策略 required、还没绑定：受限会话
  const r1 = await call(base, "POST", "/v1/auth/login", { email: ADMIN, password: ADMIN_PW, client: web });
  assert.deepEqual([r1.status, r1.json.kind, r1.json.session.restricted, r1.json.account.mfa], [200, "staff", "mfa_enroll", { enabled: false, required: true, recovery_left: 0 }]);
  const t1 = r1.json.session_token as string;
  assert.ok(Date.parse(r1.json.session.idle_expires_at) - Date.now() <= 30 * 60_000 + 1000, "人员会话闲置 30 分钟");
  assert.equal((await call(base, "GET", "/v1/ops/staff", undefined, bearer(t1))).json.error.code, "mfa_enroll_required");
  assert.equal((await call(base, "POST", "/v1/auth/password", { current: ADMIN_PW, next: "Another2026secure" }, bearer(t1))).json.error.code, "mfa_enroll_required");
  const me1 = await call(base, "GET", "/v1/auth/me", undefined, bearer(t1));
  assert.deepEqual([me1.json.kind, me1.json.restricted, me1.json.account.roles, me1.json.account.perms.includes("staff.manage")], ["staff", "mfa_enroll", ["sysadmin"], true]);
  // 平台人员不能调成员接口
  assert.equal((await call(base, "GET", "/v1/me/usage", undefined, bearer(t1))).json.error.code, "member_only");
  const setup = await call(base, "POST", "/v1/auth/mfa/totp/setup", {}, bearer(t1));
  assert.equal(setup.status, 200);
  const secret = setup.json.secret as string;
  assert.match(setup.json.otpauth_uri, new RegExp(`^otpauth://totp/.+secret=${secret}&`));
  assert.equal((await call(base, "POST", "/v1/auth/mfa/totp/enable", { code: "000000" === totpAt(secret, Date.now()) ? "111111" : "000000" }, bearer(t1))).json.error.code, "mfa_invalid");
  const en = await call(base, "POST", "/v1/auth/mfa/totp/enable", { code: totpAt(secret, Date.now()) }, bearer(t1));
  assert.equal(en.status, 200, en.text);
  const recovery = (RECOVERY = en.json.recovery_codes as string[]);
  assert.equal(recovery.length, 8);
  assert.equal(new Set(recovery).size, 8);
  const st = cp.ops.staff(ADMIN)!;
  assert.equal(JSON.stringify(st.mfa.recovery).includes(recovery[0]!.replace(/-/g, "")), false, "服务端只存恢复码的 HMAC");
  assert.equal((await call(base, "GET", "/v1/ops/staff", undefined, bearer(t1))).status, 200, "绑定后本会话解除受限");
  await call(base, "POST", "/v1/auth/logout", {}, bearer(t1));
  assert.equal((await call(base, "GET", "/v1/auth/me", undefined, bearer(t1))).status, 401);
  // 密码 → 一次性票据 → 动态码；刚才绑定用掉的那一步不能再用
  const r2 = await call(base, "POST", "/v1/auth/login", { email: ADMIN, password: ADMIN_PW, client: web });
  assert.deepEqual([r2.json.mfa_required, r2.json.methods, "session_token" in r2.json], [true, ["totp", "recovery"], false]);
  assert.match(r2.json.mfa_token, /^kwm1\./);
  const reuse = await call(base, "POST", "/v1/auth/mfa/verify", { mfa_token: r2.json.mfa_token, code: totpAt(secret, Date.now()) });
  assert.deepEqual([reuse.status, reuse.json.error.code], [401, "mfa_invalid"]);
  const ok2 = await call(base, "POST", "/v1/auth/mfa/verify", { mfa_token: r2.json.mfa_token, code: totpAt(secret, Date.now() + 30_000) });
  assert.equal(ok2.status, 200, ok2.text);
  assert.equal(ok2.json.session.restricted, null);
  assert.equal((await call(base, "POST", "/v1/auth/mfa/verify", { mfa_token: r2.json.mfa_token, code: totpAt(secret, Date.now() + 30_000) })).json.error.code, "mfa_token_invalid", "票据一次性");
  // 恢复码登录：一次性
  const r3 = await call(base, "POST", "/v1/auth/login", { email: ADMIN, password: ADMIN_PW, client: web });
  const ok3 = await call(base, "POST", "/v1/auth/mfa/verify", { mfa_token: r3.json.mfa_token, code: recovery[0] });
  assert.equal(ok3.status, 200);
  const t3 = ok3.json.session_token as string;
  const r4 = await call(base, "POST", "/v1/auth/login", { email: ADMIN, password: ADMIN_PW, client: web });
  assert.equal((await call(base, "POST", "/v1/auth/mfa/verify", { mfa_token: r4.json.mfa_token, code: recovery[0] })).json.error.code, "mfa_invalid");
  assert.equal((await call(base, "GET", "/v1/auth/me", undefined, bearer(t3))).json.account.mfa.recovery_left, 7);
  assert.equal((await call(base, "POST", "/v1/auth/mfa/totp/disable", { password: ADMIN_PW, code: recovery[1] }, bearer(t3))).json.error.code, "mfa_required_by_policy");
  // 危险操作（人员管理）：未复核 401 → 复核（密码 + 恢复码）后可以
  const noRe = await call(base, "POST", "/v1/ops/staff", { email: "fin@csi.example.cn", name: "财务", roles: ["finance"] }, bearer(t3));
  assert.deepEqual([noRe.status, noRe.json.error.code], [401, "reauth_required"]);
  assert.equal((await call(base, "POST", "/v1/auth/reauth", { password: ADMIN_PW }, bearer(t3))).json.error.code, "reauth_invalid", "绑定了动态码的人复核要带码");
  assert.equal((await call(base, "POST", "/v1/auth/reauth", { password: ADMIN_PW, code: recovery[1] }, bearer(t3))).status, 200);
  const fin = await call(base, "POST", "/v1/ops/staff", { email: "fin@csi.example.cn", name: "财务", roles: ["finance"] }, bearer(t3));
  assert.equal(fin.status, 200, fin.text);
  assert.match(fin.json.setup_code, /^[2-9A-HJ-NP-Z]{4}-/);
  assert.equal(JSON.stringify(access).includes(secret) || JSON.stringify(access).includes(ADMIN_PW) || JSON.stringify(access).includes(t3), false, "访问审计不含密钥、密码与令牌");
  assert.ok(access.some((x) => x.action === "staff.login" && x.operator === st.aid && x.email === ADMIN && x.result === "ok"));
});

test("人员管理：邮箱跨两表唯一、角色组合（1–3 个、运营与开通专员互斥）、不能停用 / 降级 / 重置自己；停用即吊销会话；重置可清两步验证；角色表", async () => {
  // 用上一个用例留下的恢复码登录与复核（动态码同一步不能重用，避开 30 秒边界）
  const st = cp.ops.staff(ADMIN)!;
  const secret = st.mfa.totp!.secret;
  const r = await call(base, "POST", "/v1/auth/login", { email: ADMIN, password: ADMIN_PW, client: web });
  const ok = await call(base, "POST", "/v1/auth/mfa/verify", { mfa_token: r.json.mfa_token, code: RECOVERY[2] });
  assert.equal(ok.status, 200, ok.text);
  const h = bearer(ok.json.session_token as string);
  const roles = await call(base, "GET", "/v1/ops/roles", undefined, h);
  assert.deepEqual(roles.json.roles.map((x: any) => [x.id, x.label]), [["sysadmin", "系统管理员"], ["operator", "客户运营"], ["issuer", "开通专员"], ["finance", "财务"], ["support", "客服"], ["viewer", "只读"]]);
  assert.equal((await call(base, "POST", "/v1/auth/reauth", { password: ADMIN_PW, code: RECOVERY[3] }, h)).status, 200);
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
  // 客服设密码、登录（策略 required：受限会话）→ 被停用即失效 → 启用 → 重置（清两步验证）发新设置码
  assert.equal((await call(base, "POST", "/v1/auth/password-reset/confirm", { email: "sup@csi.example.cn", code: sup.json.setup_code, password: "Helpdesk2026secure" })).status, 200);
  const sl = await call(base, "POST", "/v1/auth/login", { email: "sup@csi.example.cn", password: "Helpdesk2026secure", client: web });
  assert.equal(sl.json.session.restricted, "mfa_enroll");
  const dis = await call(base, "POST", `/v1/ops/staff/${sAid}/disable`, { reason: "离职" }, h);
  assert.deepEqual([dis.status, dis.json.sessions_revoked, dis.json.staff.status], [200, 1, "disabled"]);
  assert.equal((await call(base, "GET", "/v1/auth/me", undefined, bearer(sl.json.session_token))).status, 401);
  assert.equal((await call(base, "POST", "/v1/auth/login", { email: "sup@csi.example.cn", password: "Helpdesk2026secure", client: web })).json.error.code, "account_disabled");
  assert.equal((await call(base, "POST", `/v1/ops/staff/${sAid}/enable`, {}, h)).status, 200);
  const rs = await call(base, "POST", `/v1/ops/staff/${sAid}/reset`, { reset_mfa: true }, h);
  assert.deepEqual([rs.status, rs.json.mfa_reset], [200, true]);
  assert.match(rs.json.setup_code, /^[2-9A-HJ-NP-Z]{4}-/);
  assert.equal((await call(base, "POST", `/v1/ops/staff/${sAid}/roles`, { roles: ["support", "viewer"] }, h)).json.staff.roles.join(), "support,viewer");
  const list = await call(base, "GET", "/v1/ops/staff", undefined, h);
  assert.ok(list.json.staff.some((x: any) => x.email === ADMIN && x.mfa.enabled === true));
  assert.equal(JSON.stringify(list.json).includes(secret), false, "人员列表不含动态码密钥");
  // 律师注册不能用平台人员的邮箱
  cp.ops.createTenant({ tid: "ten_mail", edition: "team", seats: 1 });
  const c = cp.ops.issueActivationCode("ten_mail", { member: { slug: "boss" } });
  assert.equal((await call(base, "POST", "/v1/auth/register", { email: "fin@csi.example.cn", password: PW, name: "x", code: c.code })).json.error.code, "email_taken");
});

test("全部系统管理员失联：服务器上写 admin-recovery.request → 清两步验证、吊销会话、作废密码、写新设置码；无效邮箱的请求只删除", async () => {
  const st = cp.ops.staff(ADMIN)!;
  writeFileSync(join(dataDir, "admin-recovery.request"), "nobody@csi.example.cn\n");
  cp.adminTick();
  assert.equal(existsSync(join(dataDir, "admin-recovery.request")), false);
  assert.equal(existsSync(join(dataDir, "bootstrap-admin.txt")), false, "无效请求不发码");
  assert.ok(st.mfa.totp, "无效请求不动现有管理员");
  writeFileSync(join(dataDir, "admin-recovery.request"), `# 找回\n${ADMIN}\n`);
  cp.adminTick();
  assert.equal(existsSync(join(dataDir, "admin-recovery.request")), false);
  const boot = readBootstrap();
  assert.equal(boot.email, ADMIN);
  assert.equal(st.mfa.totp, null);
  assert.equal(st.pw, null);
  assert.match((await call(base, "POST", "/v1/auth/login", { email: ADMIN, password: ADMIN_PW, client: web })).json.error.message, /设置码/);
  assert.equal((await call(base, "POST", "/v1/auth/password-reset/confirm", { email: ADMIN, code: boot.setup_code, password: "Recovered2026secure" })).status, 200);
  const r = await call(base, "POST", "/v1/auth/login", { email: ADMIN, password: "Recovered2026secure", client: web });
  assert.deepEqual([r.status, r.json.session.restricted], [200, "mfa_enroll"], "找回后须重新绑定两步验证");
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
  const lim = await as(F.boss, "POST", `/v1/firm/members/${F.lawyer.aid}/limits`, { quota_limit: 1_000_000, device_limit: 3 });
  assert.deepEqual([lim.status, lim.json.member.quota_limit, lim.json.member.device_limit], [200, 1_000_000, 3]);
  // 停用：会话吊销、登录被拒；启用：解锁；下线；重置码给本人在“忘记密码”里用
  const dis = await as(F.boss, "POST", `/v1/firm/members/${F.lawyer.aid}/disable`, { reason: "休假" });
  assert.deepEqual([dis.status, dis.json.sessions_revoked, dis.json.member.status], [200, 1, "disabled"]);
  assert.equal((await as(F.lawyer, "GET", "/v1/auth/me")).status, 401);
  assert.equal((await call(base2, "POST", "/v1/auth/login", { email: "lawyer@firmweb.cn", password: PW, client: web })).json.error.code, "account_disabled");
  assert.equal((await as(F.boss, "POST", `/v1/firm/members/${F.lawyer.aid}/enable`, {})).json.member.status, "active");
  F.lawyer.token = await login2("lawyer@firmweb.cn");
  assert.equal((await as(F.boss, "POST", `/v1/firm/members/${F.lawyer.aid}/sessions/revoke`, {})).json.revoked, 1);
  const rc = await as(F.boss, "POST", `/v1/firm/members/${F.lawyer.aid}/reset-code`, {});
  assert.deepEqual([rc.status, rc.json.purpose], [200, "reset"]);
  assert.equal((await call(base2, "POST", "/v1/auth/password-reset/confirm", { email: "lawyer@firmweb.cn", code: rc.json.code, password: "Counsel2027secure" })).status, 200);
  F.lawyer.token = await login2("lawyer@firmweb.cn", "Counsel2027secure");
  // 第 46 批复核：管理员之间不互发重置码（拿到码即可接管对方账号）；给自己发不受限
  const admin2 = await ops("POST", "/v1/ops/accounts", { tid: F.tid, email: "admin2@firmweb.cn", name: "第二管理员", role: "admin" });
  assert.equal(admin2.status, 200, admin2.text);
  const rc2 = await as(F.boss, "POST", `/v1/firm/members/${admin2.json.account.aid}/reset-code`, {});
  assert.deepEqual([rc2.status, rc2.json.error.code], [403, "admin_reset_by_support"]);
  assert.equal((await as(F.boss, "POST", `/v1/firm/members/${F.boss.aid}/reset-code`, {})).status, 200);
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

test("账本 partial / retry_of：服务出错的行不扣额度、售价 0、成本照记；本人用量、本所逐请求与 CSV、运营明细都标“服务出错（已产生成本，不计费）”", async () => {
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
  assert.ok((part.cost_micro ?? 0) > 0, "成本按估算照记（对账）");
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
  assert.deepEqual([pr.partial, pr.note, pr.tokens_in, pr.member], [true, "服务出错（已产生成本，不计费）", 0, "王主任"]);
  assert.equal(fr.json.records.find((r: any) => r.request_id === "kwlgw_retry1").note, "重试");
  const csv = await fetch(`${base2}/v1/firm/usage/records.csv`, { headers: bearer(boss.token) });
  assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
  assert.ok((await csv.text()).includes("服务出错（已产生成本，不计费）"));
  const sum = await call(base2, "GET", "/v1/firm/usage/summary?days=7", undefined, bearer(boss.token));
  assert.deepEqual([sum.json.totals.tokens, sum.json.totals.requests, sum.json.by_member[0].name], [1650, 3, "王主任"]);
  const opsRec = (await ops("GET", `/v1/ops/usage/records?${new URLSearchParams({ tid: F.tid })}`)).json.records.find((r: any) => r.request_id === "kwlgw_part1");
  assert.equal(opsRec.billing_note, "服务出错（已产生成本，不计费）");
  const opsCsv = await fetch(`${base2}/v1/ops/usage/records.csv?${new URLSearchParams({ tid: F.tid })}`, { headers: bearer(await opsToken()) });
  assert.ok((await opsCsv.text()).includes("估算token(不计费)"));
});

test("客户端最低版本：低于 min_version 的桌面客户端登录、注册、续期席位令牌 426；网页不拦；/v1/meta 无鉴权；staff_mfa 只读；设置校验", async () => {
  const meta0 = await call(base2, "GET", "/v1/meta");
  assert.deepEqual(meta0.json, { api: "kwl-cp/2", min_client_version: null, registration: "open", staff_mfa: "optional" });
  assert.equal((await ops("PUT", "/v1/ops/settings", { clients: { min_version: "1.2" } })).json.error.code, "min_version_invalid");
  assert.equal((await ops("PUT", "/v1/ops/settings", { staff_mfa: "required" })).json.error.code, "staff_mfa_readonly");
  const put = await ops("PUT", "/v1/ops/settings", { clients: { min_version: "1.2.0" } });
  assert.deepEqual([put.status, put.json.clients.min_version, put.json.staff_mfa], [200, "1.2.0", "optional"]);
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
  const mk = (extra: Record<string, unknown> = {}) => createControlPlane({ keys, serviceSecret: SECRET, stateStore: fileStateStore(join(d, "state"), { key }), staffMfa: "optional", ...extra });
  const a = mk({ devStaff: devStaffOf({ op_8001: ["finance"] }), clients: { min_version: "0.9.0" }, billing: {} });
  const raw = readFileSync(join(d, "state.1")).toString("latin1") + (existsSync(join(d, "state.2")) ? readFileSync(join(d, "state.2")).toString("latin1") : "");
  assert.equal(raw.includes(staffEmail("op_8001")), false, "人员记录随快照封装加密（明文里看不到邮箱）");
  a.server.close();
  const b = mk();
  assert.deepEqual(b.ops.staff(staffEmail("op_8001"))?.roles, ["finance"], "重启读回人员");
  await new Promise<void>((r) => b.server.listen(0, "127.0.0.1", () => r()));
  const at = `http://127.0.0.1:${(b.server.address() as AddressInfo).port}`;
  assert.deepEqual((await call(at, "GET", "/v1/meta")).json, { api: "kwl-cp/2", min_client_version: "0.9.0", registration: "code", staff_mfa: "optional" }, "最低版本与“给了 billing 段缺省 code”都随状态读回");
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
