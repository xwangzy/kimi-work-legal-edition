/**
 * 第 71 批（V45，D-298）云端侧：电脑数上限 = 同时登录的电脑数；“让它退出登录”（可逆）与“移除”（吊销）分开。
 * - 已退出登录的电脑不占名额；满了时本次新登录凭一次性票据让一台退出登录，再经 /v1/auth/onboarding 继续；
 * - 已登记的电脑重新登录也占名额：别的电脑同时登录已满时 device_limit（this_device），会话先不绑；让出之后带签名取 onboarding 即 ready 并绑定；
 * - 被让出的电脑下一次访问得到 session_signed_out（不是“过期”）；设备列表 state = signed_out；
 * - 账号闸：没签名登录（换账号打开已有档案）的会话第一次绑电脑也受名额约束 → session_device_limit；
 * - 两台新电脑同时自动登记：等签名期间按账号加锁，不超额、不撞编号；
 * - 云端没有账号设备签发钥的个人账号，没有别的电脑可批准时不再进“等批准”死路：device_enroll_unavailable。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sign } from "node:crypto";
import { generateDeviceKeys, generateFirmRoot, issueDeviceCertificate, type DeviceRole } from "@zr-legal/keys";
import { deviceEnrollProofBytes, enrollProofBytes, firmBundleBytes, signDeviceRequest } from "@zr-legal/firm-trust";
import { createAuditLog, createControlPlane, devControlPlaneKeys, UsageBook, type ControlPlane } from "../src/index.ts";

const PW = "Lawyer2026secure";
const mk = (accountCa: boolean) =>
  createControlPlane({ keys: devControlPlaneKeys({ accountCa }), auditLog: createAuditLog(), serviceSecret: "b71-cloud-secret-0123456789abcdef01", usageBook: new UsageBook({ dir: join(mkdtempSync(join(tmpdir(), "kwl-b71-")), "usage") }), routing: { bootstrap: { provider: { base_url: "https://maas.example.test/v1" } }, key_id: "0123456789abcdef" } });
let cp: ControlPlane;
let cpNoCa: ControlPlane;
let base = "";
let baseNoCa = "";
const listen = async (c: ControlPlane) => {
  await new Promise<void>((r) => c.server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(c.server.address() as AddressInfo).port}`;
};
before(async () => {
  cp = mk(true);
  cpNoCa = mk(false);
  base = await listen(cp);
  baseNoCa = await listen(cpNoCa);
});
after(async () => {
  for (const c of [cp, cpNoCa]) {
    c.server.closeAllConnections();
    await new Promise<void>((r) => c.server.close(() => r()));
  }
});
const req = async (b: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${b}${path}`, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, json: (await r.json()) as any };
};

/** 自助注册的个人工作室（创始设备已登记、会话已绑）。 */
async function founder(b: string, email: string) {
  const reg = await req(b, "POST", "/v1/auth/register", { email, password: PW, name: "管理员", client: { version: "0.9.2", platform: "win32" } });
  assert.equal(reg.status, 200, JSON.stringify(reg.json));
  const onb = reg.json.onboarding;
  const tid = onb.claim.tid as string;
  const root = generateFirmRoot();
  const rec = generateFirmRoot();
  const ts = Date.now();
  const firm_bundle = { recovery_public_key_pem: rec.publicKeyPem, sig: sign(null, firmBundleBytes(tid, root.publicKeyPem, rec.publicKeyPem), root.privateKeyPem).toString("base64url") };
  assert.equal((await req(b, "POST", "/v1/enroll", { tid, root_public_key_pem: root.publicKeyPem, ts, proof: sign(null, enrollProofBytes(tid, root.publicKeyPem, ts), root.privateKeyPem).toString("base64url"), activation_id: onb.claim.activation_id, claim_secret: onb.claim.claim_secret, firm_bundle })).status, 200);
  const slug = onb.member.slug as string;
  const a = device(b, tid, root.privateKeyPem, slug, `dev_${tid.slice(4)}_${slug}`);
  assert.equal((await a.register(reg.json.session_token)).status, 200);
  return { tid, root, slug, a, session: reg.json.session_token as string };
}
/** 一台由律所根签了证书的电脑（模拟这个账号已登记过的另一台电脑）。 */
function device(b: string, tid: string, rootPriv: string, memberSlug: string, deviceId: string, role: DeviceRole = "admin") {
  const k = generateDeviceKeys();
  const cert = issueDeviceCertificate(rootPriv, { certId: `cert_${deviceId}`, memberId: `usr_${tid.slice(4)}_${memberSlug}`, deviceId, role, signPublicKeyPem: k.signPublicKeyPem, encPublicKeyPem: k.encPublicKeyPem, issuedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 365 * 86400_000).toISOString() });
  const call = async (method: string, path: string, body?: unknown, session?: string) => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const h = signDeviceRequest({ method, path, body: raw, tid, deviceId, signPrivateKeyPem: k.signPrivateKeyPem });
    const r = await fetch(`${b}${path}`, { method, headers: { ...h, ...(raw ? { "content-type": "application/json" } : {}), ...(session ? { "x-kwl-session": session } : {}) }, ...(raw ? { body: raw } : {}) });
    return { status: r.status, json: (await r.json()) as any };
  };
  return { id: deviceId, cert, call, register: (session?: string) => call("POST", "/v1/devices/register", { tid, cert }, session) };
}
const me = (b: string, session: string) => req(b, "GET", "/v1/auth/me", undefined, { "x-kwl-session": session });

test("新电脑：同时登录已满 → 列表带 state；凭票据让旧电脑退出登录（不吊销）→ 继续自动登记；旧电脑会话得到 session_signed_out、列表变“已退出登录”", async () => {
  const f = await founder(base, "b71a@example.cn");
  cp.ops.account("b71a@example.cn")!.device_limit = 1;
  const li = await req(base, "POST", "/v1/auth/login", { email: "b71a@example.cn", password: PW, client: { version: "0.9.2", platform: "darwin" }, account_switch: true });
  assert.equal(li.status, 200, JSON.stringify(li.json));
  const onb = li.json.onboarding;
  assert.equal(onb.state, "device_limit");
  assert.equal(onb.limit_kind, "signed_in");
  assert.equal(onb.devices_used, 1, "devices_used = 登录中的电脑数");
  assert.equal(onb.devices[0].device_id, f.a.id);
  assert.equal(onb.devices[0].state, "signed_in");
  const s = li.json.session_token as string;
  // 让旧电脑退出登录（凭这次登录的一次性票据，不要密码）
  const so = await req(base, "POST", `/v1/auth/devices/${f.a.id}/signout`, {}, { "x-kwl-session": s });
  assert.equal(so.status, 200, JSON.stringify(so.json));
  assert.equal(so.json.signed_out, 1);
  // 票据只能用一次
  assert.equal((await req(base, "POST", `/v1/auth/devices/${f.a.id}/signout`, {}, { "x-kwl-session": s })).status, 401);
  // 旧电脑：会话被让出 → 明确的 session_signed_out；设备未吊销（列表里是“已退出登录”）
  const old = await me(base, f.session);
  assert.equal(old.status, 401);
  assert.equal(old.json.error.code, "session_signed_out");
  // 新电脑继续：有名额 → needs_device_auto → 自动登记成功
  const ob = await req(base, "POST", "/v1/auth/onboarding", {}, { "x-kwl-session": s });
  assert.equal(ob.json.onboarding.state, "needs_device_auto", JSON.stringify(ob.json));
  const k = generateDeviceKeys();
  const devId = String(ob.json.onboarding.device_id);
  const proof = sign(null, deviceEnrollProofBytes({ tid: f.tid, aid: li.json.account.aid, sid: li.json.session.sid, deviceId: devId, signPublicKeyPem: k.signPublicKeyPem, encPublicKeyPem: k.encPublicKeyPem }), k.signPrivateKeyPem).toString("base64url");
  const en = await req(base, "POST", "/v1/auth/devices/enroll", { device_id: devId, sign_pub: k.signPublicKeyPem, enc_pub: k.encPublicKeyPem, proof, client: { version: "0.9.2", platform: "darwin" } }, { "x-kwl-session": s });
  assert.equal(en.status, 200, JSON.stringify(en.json));
  const list = (await me(base, s)).json.devices as any[];
  assert.equal(list.find((d) => d.device_id === f.a.id)?.state, "signed_out", "旧电脑没被吊销，只是退出登录");
  assert.ok(list.find((d) => d.device_id === f.a.id)?.signed_out_at, "记下被让出的时刻");
  assert.equal(list.find((d) => d.device_id === devId)?.state, "signed_in");
  assert.equal(list[0].state, "signed_in", "登录中的在前");
});

test("已登记的电脑重新登录也占名额：别的电脑登录中且已满 → device_limit（this_device）、会话不绑；让出之后带签名取 onboarding 即 ready 并绑定", async () => {
  const f = await founder(base, "b71b@example.cn");
  cp.ops.account("b71b@example.cn")!.device_limit = 1;
  // 这个账号已登记过的另一台电脑 B（之前退出登录了：没有会话）
  const b = device(base, f.tid, f.root.privateKeyPem, f.slug, `dev_${f.tid.slice(4)}_${f.slug}_D2`);
  assert.equal((await b.register()).status, 200);
  const li = await b.call("POST", "/v1/auth/login", { email: "b71b@example.cn", password: PW, client: { version: "0.9.2", platform: "darwin" }, account_switch: true });
  assert.equal(li.status, 200, JSON.stringify(li.json));
  assert.equal(li.json.onboarding.state, "device_limit");
  assert.equal(li.json.onboarding.this_device, b.id);
  const s = li.json.session_token as string;
  // 会话没绑 B：B 带这次会话取席位会被账号闸挡（同时登录已满）
  const seat = await b.call("POST", "/v1/seat-token", {}, s);
  assert.equal(seat.status, 401, JSON.stringify(seat.json));
  assert.equal(seat.json.error.code, "session_device_limit");
  // 让 A 退出登录，再带 B 的签名取 onboarding → ready，会话绑到 B
  assert.equal((await req(base, "POST", `/v1/auth/devices/${f.a.id}/signout`, {}, { "x-kwl-session": s })).status, 200);
  const ob = await b.call("POST", "/v1/auth/onboarding", {}, s);
  assert.equal(ob.status, 200, JSON.stringify(ob.json));
  assert.equal(ob.json.onboarding.state, "ready");
  assert.equal((await b.call("POST", "/v1/seat-token", {}, s)).status, 200, "绑定后可取席位");
  // 对称：A 回来重新登录 → B 登录中 → A 也得选
  const back = await f.a.call("POST", "/v1/auth/login", { email: "b71b@example.cn", password: PW, client: { version: "0.9.2", platform: "win32" }, account_switch: true });
  assert.equal(back.json.onboarding.state, "device_limit");
  assert.equal(back.json.onboarding.this_device, f.a.id);
  assert.deepEqual(back.json.onboarding.devices.map((d: any) => [d.device_id, d.state]).sort(), [[b.id, "signed_in"], [f.a.id, "signed_out"]].sort());
});

test("让别的电脑退出登录：正在用的电脑与网页控制台可以；不能让自己这台退出；没有票据的新登录不行；移除仍走 unbind（吊销）", async () => {
  const f = await founder(base, "b71c@example.cn");
  cp.ops.account("b71c@example.cn")!.device_limit = 3;
  const b = device(base, f.tid, f.root.privateKeyPem, f.slug, `dev_${f.tid.slice(4)}_${f.slug}_D2`);
  assert.equal((await b.register()).status, 200);
  const lb = await b.call("POST", "/v1/auth/login", { email: "b71c@example.cn", password: PW, client: { version: "0.9.2", platform: "darwin" }, account_switch: true });
  assert.equal(lb.json.onboarding.state, "ready");
  // A（正在用的电脑）让 B 退出登录
  assert.equal((await req(base, "POST", `/v1/auth/devices/${b.id}/signout`, {}, { "x-kwl-session": f.session })).status, 200);
  assert.equal((await me(base, lb.json.session_token)).json.error.code, "session_signed_out");
  // 不能让自己退出
  assert.equal((await req(base, "POST", `/v1/auth/devices/${f.a.id}/signout`, {}, { "x-kwl-session": f.session })).json.error.code, "signout_self");
  // 网页控制台会话可以
  const web = await req(base, "POST", "/v1/auth/login", { email: "b71c@example.cn", password: PW, client: { version: "0.9.2", platform: "web" } });
  assert.equal((await req(base, "POST", `/v1/auth/devices/${f.a.id}/signout`, {}, { authorization: `Bearer ${web.json.session_token}` })).status, 200);
  // 没满额、没票据的新电脑登录不能让别的电脑退出
  const fresh = await req(base, "POST", "/v1/auth/login", { email: "b71c@example.cn", password: PW, client: { version: "0.9.2", platform: "darwin" }, account_switch: true });
  assert.equal(fresh.json.onboarding.state, "needs_device_auto");
  assert.equal((await req(base, "POST", `/v1/auth/devices/${b.id}/signout`, {}, { "x-kwl-session": fresh.json.session_token })).json.error.code, "signout_not_allowed");
  // /v1/meta 公布 device_signout
  assert.ok((await req(base, "GET", "/v1/meta")).json.features.includes("device_signout"));
});

test("两台新电脑同时自动登记（各自登录时都有 1 个名额）：只有一台成功，另一台 409，不超额、不撞同一设备编号", async () => {
  const f = await founder(base, "b71d@example.cn");
  cp.ops.account("b71d@example.cn")!.device_limit = 2;
  const mkNew = async () => {
    const li = await req(base, "POST", "/v1/auth/login", { email: "b71d@example.cn", password: PW, client: { version: "0.9.2", platform: "darwin" }, account_switch: true });
    assert.equal(li.json.onboarding.state, "needs_device_auto");
    const k = generateDeviceKeys();
    const devId = String(li.json.onboarding.device_id);
    const proof = sign(null, deviceEnrollProofBytes({ tid: f.tid, aid: li.json.account.aid, sid: li.json.session.sid, deviceId: devId, signPublicKeyPem: k.signPublicKeyPem, encPublicKeyPem: k.encPublicKeyPem }), k.signPrivateKeyPem).toString("base64url");
    return () => req(base, "POST", "/v1/auth/devices/enroll", { device_id: devId, sign_pub: k.signPublicKeyPem, enc_pub: k.encPublicKeyPem, proof, client: { version: "0.9.2", platform: "darwin" } }, { "x-kwl-session": li.json.session_token });
  };
  const x = await mkNew();
  const y = await mkNew();
  const [rx, ry] = await Promise.all([x(), y()]);
  const ok = [rx, ry].filter((r) => r.status === 200);
  assert.equal(ok.length, 1, JSON.stringify([rx.json, ry.json]));
  const bad = [rx, ry].find((r) => r.status !== 200)!;
  assert.equal(bad.status, 409);
  assert.ok(["enroll_in_progress", "device_limit", "device_id_mismatch"].includes(bad.json.error.code), bad.json.error.code);
  const st = cp.ops.account("b71d@example.cn")!;
  const live = [...cp.ops.tenant(f.tid)!.devices.values()].filter((d) => !d.revoked_at && d.cert.memberId.endsWith(st.member_slug));
  assert.equal(live.length, 2, "创始一台 + 新登记一台");
});

test("云端没有账号设备签发钥（线上 1.5.0 的配置缺口）：个人账号唯一的电脑移除后，新电脑不再进入“等批准”死路，回 device_enroll_unavailable", async () => {
  const f = await founder(baseNoCa, "b71e@example.cn");
  assert.ok(!(await req(baseNoCa, "GET", "/v1/meta")).json.features.includes("device_auto_enroll"));
  cpNoCa.ops.account("b71e@example.cn")!.device_limit = 2;
  // 有旧电脑在：仍可由那台电脑批准（保留原有退路）
  const li1 = await req(baseNoCa, "POST", "/v1/auth/login", { email: "b71e@example.cn", password: PW, client: { version: "0.9.2", platform: "darwin" }, account_switch: true });
  assert.equal(li1.json.onboarding.state, "needs_device_join");
  // 唯一的电脑移除后：无人可批 → 如实回 device_enroll_unavailable
  assert.equal((await req(baseNoCa, "POST", `/v1/auth/devices/${f.a.id}/unbind`, { password: PW }, { "x-kwl-session": li1.json.session_token })).status, 200);
  const li2 = await req(baseNoCa, "POST", "/v1/auth/login", { email: "b71e@example.cn", password: PW, client: { version: "0.9.2", platform: "darwin" }, account_switch: true });
  assert.equal(li2.json.onboarding.state, "device_enroll_unavailable", JSON.stringify(li2.json.onboarding));
});

test("安全审查 S-01：已登记电脑用 relogin 验证码登录——设备签名只核一次（原来第二次被判重放 device_auth_replayed）；账号没绑手机号时如实回 phone_unbound", async () => {
  const f = await founder(base, "b71s1@example.cn");
  const r = await f.a.call("POST", "/v1/auth/login", { relogin: true, sms_code: "123456", client: { version: "0.9.2", platform: "win32" }, account_switch: true });
  assert.notEqual(r.json.error?.code, "device_auth_replayed", JSON.stringify(r.json));
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, "phone_unbound");
  // 发码同一口径：凭设备签名、不带手机号
  const s = await f.a.call("POST", "/v1/auth/sms/send", { purpose: "login", relogin: true, client: { version: "0.9.2", platform: "win32" } });
  assert.notEqual(s.json.error?.code, "device_auth_replayed");
});

test("安全审查 S-02：网页会话（客户端自报 platform=web）不能当作电脑的登录——取席位被拒、不绑电脑、不能绕过同时登录上限", async () => {
  const f = await founder(base, "b71s2@example.cn");
  cp.ops.account("b71s2@example.cn")!.device_limit = 1;
  const b = device(base, f.tid, f.root.privateKeyPem, f.slug, `dev_${f.tid.slice(4)}_${f.slug}_D2`);
  assert.equal((await b.register()).status, 200);
  const web = await req(base, "POST", "/v1/auth/login", { email: "b71s2@example.cn", password: PW, client: { version: "0.9.2", platform: "web" } });
  assert.equal(web.json.session.kind, "web");
  const st = await b.call("POST", "/v1/seat-token", {}, web.json.session_token);
  assert.equal(st.status, 401, JSON.stringify(st.json));
  assert.equal(st.json.error.code, "session_invalid");
  // 带网页会话登记也不绑
  await b.call("POST", "/v1/devices/register", { tid: f.tid, cert: b.cert }, web.json.session_token);
  const m = await me(base, f.session);
  assert.equal(m.json.devices_signed_in, 1, "只有 A 在登录");
  assert.equal(m.json.devices.find((d: any) => d.device_id === b.id)?.state, "signed_out");
});
