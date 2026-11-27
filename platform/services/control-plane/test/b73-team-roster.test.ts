/**
 * 第 73 批（V47，契约 1.1，D-308）：GET /v1/team/roster——团队成员可读的同事名单（律师电脑的“和同事一起办”选人、事项成员标“已离开团队”用）。
 *
 * 不变量（逐条一个用例）：
 * R1 鉴权与 /v1/quota 同一口径：本人账号会话 + 这台电脑的设备签名，缺一不可；会话与设备须是同一成员、同一工作空间；网页会话不行；
 * R2 团队里的律师（账号签发钥电脑）与管理员（律所根电脑）都能读，读到的是同一份；
 * R3 个人空间 403 team_only；
 * R4 应答只有 member_slug / name / role / status / seat：不含邮箱、手机号、账号编号（aid）、设备与席位编号；按姓名排序；
 * R7（第 73 批验收 P2）：seat = 此刻是否占有席位（只是 true / false）——与管理员看到的席位一致，分配 / 收回席位后名单随之变化；移出即无席位；
 * R5 跨租户不可读：别的团队的会话或设备一律 403，读到的只是本团队的人；
 * R6 被移出 / 停用 / 本人退出之后：这些人的会话读名单 401；名单里仍有他们，status 分别为 removed / disabled / left；启用后回到 active；
 *    平台停用这个人（主账号）时名单里记 disabled。
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

const keys = devControlPlaneKeys({ accountCa: true });
const SECRET = "b73-roster-service-secret-0123456789abcdef";
const PW = "Lawyer2026secure";
let cp: ControlPlane;
let base = "";
const dir = mkdtempSync(join(tmpdir(), "kwl-b73roster-"));

before(async () => {
  cp = createControlPlane({ keys, auditLog: createAuditLog(), serviceSecret: SECRET, usageBook: new UsageBook({ dir: join(dir, "usage") }), routing: { bootstrap: { provider: { base_url: "https://maas.example.test/v1" } }, key_id: "0123456789abcdef" } });
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
    const text = await r.text();
    return { status: r.status, text, json: JSON.parse(text) as any };
  };
  return { k, cert, tid, call: callDev, register: (c: DeviceCertificate = cert, session?: string) => callDev("POST", "/v1/devices/register", { tid, cert: c }, session) };
}
type Dev = ReturnType<typeof deviceOf>;

/** 自助注册个人工作室 → 创始开通 → 登记创始电脑（律所根签发）。 */
async function signup(email: string, name: string, org: string) {
  const reg = await post("/v1/auth/register", { email, password: PW, name, org_name: org, client: { version: "0.12.0", platform: "win32" } });
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
  return { tid, aid: reg.json.account.aid as string, email, memberId, dev, session: reg.json.session_token as string };
}

/** 以一份登录 / 切换应答（needs_device_auto）在新电脑上由账号签发钥直接登记（会话绑上）。 */
async function enrollFrom(r: any): Promise<Dev> {
  assert.equal(r.onboarding.state, "needs_device_auto", JSON.stringify(r.onboarding));
  const k = generateDeviceKeys();
  const deviceId = String(r.onboarding.device_id);
  const proof = sign(null, deviceEnrollProofBytes({ tid: r.onboarding.tid, aid: r.account.aid, sid: r.session.sid, deviceId, signPublicKeyPem: k.signPublicKeyPem, encPublicKeyPem: k.encPublicKeyPem }), k.signPrivateKeyPem).toString("base64url");
  const e = await post("/v1/auth/devices/enroll", { device_id: deviceId, sign_pub: k.signPublicKeyPem, enc_pub: k.encPublicKeyPem, proof, client: { version: "0.12.0", platform: "darwin" } }, r.session_token);
  assert.equal(e.status, 200, JSON.stringify(e.json));
  const o = openEnvelope<any>(e.json, "kwl-device-enroll", publicKeyMap(cp.publicKeys.envelope));
  assert.ok(o.ok);
  const dev = deviceOf(r.onboarding.tid, (o.ok ? o.body : null).cert, k);
  assert.equal((await dev.register(dev.cert, r.session_token)).status, 200);
  return dev;
}

const W = { version: "0.12.0", platform: "darwin" };
type Admin = Awaited<ReturnType<typeof signup>>;
type Member = { aid: string; email: string; name: string; session: string; dev: Dev };
let A: Admin; // 甲：团队管理员（律所根电脑）
let L: Member; // 乙：律师（账号签发钥电脑）
let M: Member; // 丙：将被移出
let N: Member; // 丁：将被停用
let Q: Member; // 戊：将本人退出团队
let P: Member; // 己：合伙人（最后被平台停用这个人）
let X: Admin; // 个人工作室
let B: Admin; // 另一个团队的管理员
let B1: Member; // 另一个团队的律师

async function joinTeam(admin: Admin, email: string, name: string, role: string): Promise<Member> {
  const inv = await post("/v1/team/invites", { name, role }, admin.session);
  assert.equal(inv.status, 200, JSON.stringify(inv.json));
  const me = await signup(email, name, `${name}工作室`);
  const j = await post("/v1/teams/join", { code: inv.json.code, client: W }, me.session);
  assert.equal(j.status, 200, JSON.stringify(j.json));
  return { aid: j.json.account.aid, email, name, session: j.json.session_token, dev: await enrollFrom(j.json) };
}
const roster = (d: Dev, session?: string) => d.call("GET", "/v1/team/roster", undefined, session);
const byName = (r: { json: any }) => Object.fromEntries((r.json.members as any[]).map((m) => [m.name, m]));

test("准备：甲开团队并邀请乙丙丁戊己（账号签发钥电脑）；另有个人工作室与另一个团队", async () => {
  A = await signup("a-b73@example.cn", "甲律师", "甲工作室");
  assert.equal((await post("/v1/workspace/upgrade", { name: "甲律师事务所" }, A.session)).status, 200);
  L = await joinTeam(A, "l-b73@example.cn", "乙律师", "lawyer");
  M = await joinTeam(A, "m-b73@example.cn", "丙律师", "lawyer");
  N = await joinTeam(A, "n-b73@example.cn", "丁律师", "lawyer");
  Q = await joinTeam(A, "q-b73@example.cn", "戊律师", "assistant");
  P = await joinTeam(A, "p-b73@example.cn", "己律师", "partner");
  assert.equal(L.dev.cert.issuer, "account_ca");
  X = await signup("x-b73@example.cn", "庚律师", "庚工作室");
  B = await signup("b-b73@example.cn", "辛律师", "辛工作室");
  assert.equal((await post("/v1/workspace/upgrade", { name: "辛律师事务所" }, B.session)).status, 200);
  B1 = await joinTeam(B, "b1-b73@example.cn", "壬律师", "lawyer");
});

test("/v1/meta：features 含 team_roster", async () => {
  const m = await get("/v1/meta");
  assert.equal(m.status, 200);
  assert.ok(m.json.features.includes("team_roster"), JSON.stringify(m.json.features));
});

test("R2 + R4：律师与管理员都能读、读到同一份；只有成员标识、姓名、角色、状态、是否有席位，按姓名排序；不含邮箱、手机号、账号编号、设备与席位编号", async () => {
  const rl = await roster(L.dev, L.session);
  assert.equal(rl.status, 200, rl.text);
  const ra = await roster(A.dev, A.session);
  assert.equal(ra.status, 200, ra.text);
  assert.deepEqual(rl.json, ra.json, "律师与管理员读到的是同一份");
  assert.equal(rl.json.ok, true);
  assert.equal(rl.json.tid, A.tid);
  const ms = rl.json.members as any[];
  assert.deepEqual(ms.map((m) => m.name).sort(), ["丁律师", "丙律师", "乙律师", "己律师", "戊律师", "甲律师"].sort());
  for (const m of ms) assert.deepEqual(Object.keys(m).sort(), ["member_slug", "name", "role", "seat", "status"], JSON.stringify(m));
  for (const m of ms) assert.equal(typeof m.seat, "boolean", "席位只给是 / 否");
  assert.doesNotMatch(rl.text, /seat_ten_|"sid"/, "不给席位编号");
  const n = byName(rl);
  assert.deepEqual([n["甲律师"].role, n["乙律师"].role, n["戊律师"].role, n["己律师"].role], ["admin", "lawyer", "assistant", "partner"]);
  assert.ok(ms.every((m) => m.status === "active"));
  // 成员标识 = 内核用户编号 usr_<firm>_<member_slug> 的后半段（与设备证书同一编号）
  assert.equal(`usr_${A.tid.slice(4)}_${n["乙律师"].member_slug}`, L.dev.cert.memberId);
  assert.equal(`usr_${A.tid.slice(4)}_${n["甲律师"].member_slug}`, A.memberId);
  // 按姓名排序（中文按拼音）
  const collator = new Intl.Collator("zh-Hans-CN");
  assert.deepEqual(ms.map((m) => m.name), [...ms.map((m) => m.name)].sort(collator.compare));
  // 不含敏感字段
  for (const who of [A, L, M, N, Q, P]) {
    assert.ok(!rl.text.includes(who.email), `不含邮箱 ${who.email}`);
    assert.ok(!rl.text.includes(who.aid), "不含账号编号");
    assert.ok(!rl.text.includes(who.dev.cert.deviceId), "不含设备编号");
  }
  assert.doesNotMatch(rl.text, /acc_[A-Za-z0-9_-]{16}|@|phone|device|aid/);
});

test("R1：会话与设备签名缺一不可；会话与设备须是同一成员；网页会话不行；已绑别的电脑的会话不行", async () => {
  const noSession = await roster(L.dev);
  assert.deepEqual([noSession.status, noSession.json.error?.code], [401, "session_required"]);
  const unsigned = await get("/v1/team/roster", L.session);
  assert.equal(unsigned.status, 401, "不带设备签名不行");
  assert.match(unsigned.json.error.code, /^device_auth/);
  const wrong = await roster(L.dev, M.session);
  assert.deepEqual([wrong.status, wrong.json.error?.code], [403, "session_member_mismatch"]);
  // 网页会话（控制台登录）+ 本人电脑签名：不认
  const web = await post("/v1/auth/login", { email: L.email, password: PW, client: { platform: "web" } });
  assert.equal(web.status, 200, JSON.stringify(web.json));
  assert.equal(web.json.session.kind, "web");
  const ws = await roster(L.dev, web.json.session_token);
  assert.deepEqual([ws.status, ws.json.error?.code], [401, "session_invalid"]);
  // 甲本人的另一台电脑（账号签发钥）登录得到的会话已绑那台电脑：拿去配甲的律所根电脑签名不行
  const lg = await post("/v1/auth/login", { email: A.email, password: PW, client: W });
  assert.equal(lg.status, 200, JSON.stringify(lg.json));
  const a2 = await enrollFrom(lg.json);
  assert.equal((await roster(a2, lg.json.session_token)).status, 200, "那台电脑自己读可以");
  const cross = await roster(A.dev, lg.json.session_token);
  assert.deepEqual([cross.status, cross.json.error?.code], [401, "session_invalid"]);
});

test("R3：个人空间 403 team_only", async () => {
  const r = await roster(X.dev, X.session);
  assert.deepEqual([r.status, r.json.error?.code], [403, "team_only"]);
});

test("R5：跨租户不可读——别的团队的会话 / 设备一律 403；各自只读到本团队的人", async () => {
  const rb = await roster(B1.dev, B1.session);
  assert.equal(rb.status, 200, rb.text);
  assert.equal(rb.json.tid, B.tid);
  assert.deepEqual(rb.json.members.map((m: any) => m.name).sort(), ["壬律师", "辛律师"].sort());
  assert.ok(!rb.text.includes("乙律师") && !rb.text.includes(A.tid), "看不到甲团队的人");
  const s1 = await roster(L.dev, B1.session);
  assert.deepEqual([s1.status, s1.json.error?.code], [403, "session_member_mismatch"]);
  const s2 = await roster(B1.dev, L.session);
  assert.deepEqual([s2.status, s2.json.error?.code], [403, "session_member_mismatch"]);
  // 查询串里写别的租户也没用（租户只取会话所在的工作空间）
  const q = await L.dev.call("GET", `/v1/team/roster?tid=${B.tid}`, undefined, L.session);
  assert.equal(q.status, 200, q.text);
  assert.equal(q.json.tid, A.tid);
});

test("R7：seat 与管理员看到的席位一致；收回 / 分配席位后名单随之变化（律师读到的同一份）", async () => {
  const held = async () => {
    const fm = await get("/v1/firm/members", A.session);
    assert.equal(fm.status, 200, JSON.stringify(fm.json));
    return Object.fromEntries((fm.json.members as any[]).map((x) => [x.name, x.seat !== null]));
  };
  const seats = async () => {
    const r = await roster(L.dev, L.session);
    assert.equal(r.status, 200, r.text);
    return Object.fromEntries((r.json.members as any[]).map((x) => [x.name, x.seat]));
  };
  assert.deepEqual(await seats(), await held(), "与管理员成员页的席位一致");
  // 腾出一个席位给乙（乙原本有就先收回乙的）：收回 → false，分配 → true
  const before = await held();
  const other = Object.keys(before).find((n) => before[n] && n !== "乙律师" && n !== "甲律师");
  const otherAid = { 丙律师: M.aid, 丁律师: N.aid, 戊律师: Q.aid, 己律师: P.aid }[other as "丙律师"];
  if (before["乙律师"]) {
    assert.equal((await post(`/v1/firm/seats/${L.aid}/release`, {}, A.session)).status, 200);
  } else {
    assert.ok(otherAid, "没有可腾出的席位");
    assert.equal((await post(`/v1/firm/seats/${otherAid}/release`, {}, A.session)).status, 200);
    assert.equal((await seats())[other!], false);
  }
  assert.equal((await seats())["乙律师"], false, "收回后名单里乙没有席位");
  const as = await post(`/v1/firm/seats/${L.aid}/assign`, {}, A.session);
  assert.equal(as.status, 200, JSON.stringify(as.json));
  assert.equal((await seats())["乙律师"], true, "分配后名单里乙有席位");
  assert.deepEqual(await seats(), await held());
  // 收回乙的、再还给乙（来回一次，名单每次都跟着变）
  assert.equal((await post(`/v1/firm/seats/${L.aid}/release`, {}, A.session)).status, 200);
  assert.equal((await seats())["乙律师"], false);
  assert.equal((await post(`/v1/firm/seats/${L.aid}/assign`, {}, A.session)).status, 200);
  assert.equal((await seats())["乙律师"], true);
});

test("R6：移出 / 停用 / 本人退出之后——这些人的会话 401；名单里仍有他们并标 removed / disabled / left；启用后回到 active", async () => {
  assert.equal((await post(`/v1/firm/members/${M.aid}/remove`, {}, A.session)).status, 200);
  assert.equal((await post(`/v1/firm/members/${N.aid}/disable`, {}, A.session)).status, 200);
  const lv = await post("/v1/teams/leave", { client: W }, Q.session);
  assert.equal(lv.status, 200, JSON.stringify(lv.json));
  const rm = await roster(M.dev, M.session);
  assert.deepEqual([rm.status, rm.json.error?.code], [401, "session_team_removed"]);
  const rn = await roster(N.dev, N.session);
  assert.equal(rn.status, 401, rn.text);
  const rq = await roster(Q.dev, Q.session);
  assert.deepEqual([rq.status, rq.json.error?.code], [401, "session_team_left"]);
  // 退出后切回的个人工作空间会话配团队电脑：不是同一工作空间
  const rq2 = await roster(Q.dev, lv.json.session_token);
  assert.equal(rq2.status, 403, rq2.text);
  const r = await roster(L.dev, L.session);
  assert.equal(r.status, 200, r.text);
  const n = byName(r);
  assert.deepEqual([n["丙律师"].status, n["丁律师"].status, n["戊律师"].status, n["乙律师"].status, n["甲律师"].status], ["removed", "disabled", "left", "active", "active"]);
  assert.equal(n["丙律师"].role, "lawyer", "离开的人保留最后的角色");
  for (const who of ["丙律师", "丁律师", "戊律师"]) assert.equal(n[who].seat, false, `${who}：移出 / 停用 / 退出即释放席位`);
  // 启用丁 → active
  assert.equal((await post(`/v1/firm/members/${N.aid}/enable`, {}, A.session)).status, 200);
  assert.equal(byName(await roster(L.dev, L.session))["丁律师"].status, "active");
  // 平台停用了己这个人（主账号）：他的团队会话不能再用；名单里记 disabled
  const person = cp.ops.account(P.email)!;
  Object.assign(person, { status: "disabled", disabled_by: "platform" });
  const rp = await roster(P.dev, P.session);
  assert.deepEqual([rp.status, rp.json.error?.code], [403, "account_disabled"]);
  assert.equal(byName(await roster(L.dev, L.session))["己律师"].status, "disabled");
});
