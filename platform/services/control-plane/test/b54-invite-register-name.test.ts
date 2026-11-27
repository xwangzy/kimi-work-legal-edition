/**
 * 第 54 批（Windows 安装包连 116 演示云端真实联调）：凭成员邀请码注册时，回给客户端的成员姓名用管理员写在邀请上的姓名。
 * 新电脑把这个姓名算进入组申请的 HMAC（邀请码本机秘密段），管理员电脑按本机邀请记录的姓名核对；原来回的是律师注册时自己填的名字，
 * 两边一不同（邀请写“王五”、律师填“王五律师”），正当申请就显示“在传送中被改动过，不要批准”，且没有办法批准。
 * 与“直接输入码”的兑换接口（/v1/activation/redeem）一致；开通码（创始）不受影响。
 * 第 56 批：账号显示名也改用邀请上的姓名（原先留律师自己填的，同一个人在成员页与用量页两个名字）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDeviceKeys, generateFirmRoot, issueDeviceCertificate, type DeviceRole } from "@zr-legal/keys";
import { enrollProofBytes, signDeviceRequest } from "@zr-legal/firm-trust";
import { accountDeviceId, createControlPlane, devControlPlaneKeys, UsageBook, type ControlPlane } from "../src/index.ts";

const keys = devControlPlaneKeys();
const SECRET = "b54-test-service-secret-0123456789abcdef";
const PW = "Lawyer2026secure";
let cp: ControlPlane;
let base = "";
const dir = mkdtempSync(join(tmpdir(), "kwl-b54-"));

before(async () => {
  cp = createControlPlane({ keys, serviceSecret: SECRET, usageBook: new UsageBook({ dir: join(dir, "usage") }), routing: { bootstrap: { provider: { base_url: "https://maas.example.test/v1" } }, key_id: "0123456789abcdef" } });
  await new Promise<void>((r) => cp.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(cp.server.address() as AddressInfo).port}`;
});
after(async () => {
  cp.server.closeAllConnections();
  await new Promise<void>((r) => cp.server.close(() => r()));
});

const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as any };
};

/**
 * 第 72 批（契约 §3.1，D-305）：取消“发第一张成员邀请就悄悄转团队”——个人工作室发成员邀请前须先就地升级为团队（同名）；
 * 本文件验证的是成员新电脑经管理员批准的流程，所以另把成员电脑策略设为 approve（团队缺省 auto，D-304）。
 */
const toTeam = async (session: string) => {
  const me = await (await fetch(`${base}/v1/auth/me`, { headers: { "x-kwl-session": session } })).json() as any;
  const up = await fetch(`${base}/v1/workspace/upgrade`, { method: "POST", headers: { "content-type": "application/json", "x-kwl-session": session }, body: JSON.stringify({ name: me.firm.name }) });
  assert.equal(up.status, 200, await up.clone().text());
  const pol = await fetch(`${base}/v1/firm/policy/member-device`, { method: "PUT", headers: { "content-type": "application/json", "x-kwl-session": session }, body: JSON.stringify({ policy: "approve" }) });
  assert.equal(pol.status, 200, await pol.clone().text());
};
const get = async (path: string, headers: Record<string, string> = {}) => {
  const r = await fetch(`${base}${path}`, { headers });
  return { status: r.status, json: (await r.json()) as any };
};
const service = (path: string, body: unknown) => post(path, body, { authorization: `Bearer ${SECRET}` });

/** 一台律所侧设备：设备密钥 + 律所根签的证书；请求一律设备签名，可带会话头。 */
function device(tid: string, rootPriv: string, memberId: string, deviceId: string, role: DeviceRole = "admin") {
  const k = generateDeviceKeys();
  const cert = issueDeviceCertificate(rootPriv, { certId: `cert_${deviceId}`, memberId, deviceId, role, signPublicKeyPem: k.signPublicKeyPem, encPublicKeyPem: k.encPublicKeyPem, issuedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 365 * 86400_000).toISOString() });
  const call = async (method: string, path: string, body?: unknown, session?: string) => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const h = signDeviceRequest({ method, path, body: raw, tid, deviceId, signPrivateKeyPem: k.signPrivateKeyPem });
    const r = await fetch(`${base}${path}`, { method, headers: { ...h, ...(raw ? { "content-type": "application/json" } : {}), ...(session ? { "x-kwl-session": session } : {}) }, ...(raw ? { body: raw } : {}) });
    return { status: r.status, json: (await r.json()) as any };
  };
  return { k, cert, call, register: (session?: string) => call("POST", "/v1/devices/register", { tid, cert }, session) };
}

/** 自助注册 → 创始开通（律所根在本机生成、凭账号认领登记）→ 登记设备。返回账号、会话与设备。 */
async function signupFounder(email: string, org = "测试律所") {
  const reg = await post("/v1/auth/register", { email, password: PW, name: "张律师", org_name: org, client: { version: "0.3.0", platform: "win32" } });
  assert.equal(reg.status, 200, JSON.stringify(reg.json));
  const onb = reg.json.onboarding;
  assert.equal(onb.state, "needs_founder_setup");
  const tid = onb.claim.tid as string;
  const root = generateFirmRoot();
  const ts = Date.now();
  const proof = sign(null, enrollProofBytes(tid, root.publicKeyPem, ts), root.privateKeyPem).toString("base64url");
  const en = await post("/v1/enroll", { tid, root_public_key_pem: root.publicKeyPem, ts, proof, activation_id: onb.claim.activation_id, claim_secret: onb.claim.claim_secret });
  assert.equal(en.status, 200, JSON.stringify(en.json));
  const memberId = `usr_${tid.slice(4)}_${onb.member.slug}`;
  const dev = device(tid, root.privateKeyPem, memberId, accountDeviceId(tid.slice(4), onb.member.slug, 1));
  const r = await dev.register(reg.json.session_token);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { tid, root, memberId, slug: onb.member.slug as string, dev, session: reg.json.session_token as string, account: reg.json.account };
}


test("凭邀请码注册：律师填的名字与邀请上的不同，回给客户端的成员姓名仍是邀请上的；账号显示名是律师自己填的；创始开通码照旧用自己填的", async () => {
  const f = await signupFounder("founder-b54@example.cn", "五十四号律所");
  await toTeam(f.session);
  assert.equal(f.account.name, "张律师", "创始：账号与成员都是自己填的名字");
  const inv = await f.dev.call("POST", "/v1/invitations", { member_slug: "wangwu", name: "王五", role: "lawyer" }, f.session);
  assert.equal(inv.status, 200, JSON.stringify(inv.json));
  const reg = await post("/v1/auth/register", { email: "wangwu@example.cn", password: PW, name: "王五律师", code: inv.json.code });
  assert.equal(reg.status, 200, JSON.stringify(reg.json));
  assert.equal(reg.json.onboarding.state, "needs_device_join");
  assert.equal(reg.json.onboarding.member.name, "王五");
  assert.equal(reg.json.onboarding.claim.member.name, "王五");
  assert.equal(cp.ops.account("wangwu@example.cn")!.name, "王五", "第 56 批：账号显示名也用邀请上的姓名（一个成员在本所只有一个名字）");
  // 名字相同时不变
  const inv2 = await f.dev.call("POST", "/v1/invitations", { member_slug: "zhaoliu", name: "赵六", role: "assistant" }, f.session);
  const reg2 = await post("/v1/auth/register", { email: "zhaoliu@example.cn", password: PW, name: "赵六", code: inv2.json.code });
  assert.equal(reg2.json.onboarding.member.name, "赵六");
});

test("第 56 批：被拒后重新受邀——账号原来绑的成员从未入组、获批的电脑属于还没有账号的新成员时，登录即改绑；已入组成员的账号不能借此换到别人的电脑上", async () => {
  const f = await signupFounder("founder-b56@example.cn", "五十六号改绑律所");
  await toTeam(f.session);
  const slugOf = (tid: string, s: string) => `usr_${tid.slice(4)}_${s}`;
  // 第一份邀请：注册了账号，但入组申请被拒（从未登记设备、没有席位）
  const inv1 = await f.dev.call("POST", "/v1/invitations", { member_slug: "zhao-a", name: "赵律师", role: "lawyer" }, f.session);
  const reg = await post("/v1/auth/register", { email: "zhao-b56@example.cn", password: PW, name: "赵律师", code: inv1.json.code });
  assert.equal(reg.status, 200, JSON.stringify(reg.json));
  assert.equal(cp.ops.account("zhao-b56@example.cn")!.member_slug, "zhao-a");
  // 第二份邀请：管理员批准了这台电脑（律所根签的证书，成员编号是新邀请的），设备登记成功
  await f.dev.call("POST", "/v1/invitations", { member_slug: "zhao-b", name: "赵律师（重发）", role: "lawyer" }, f.session);
  const d2 = device(f.tid, f.root.privateKeyPem, slugOf(f.tid, "zhao-b"), `dev_${f.tid.slice(4)}_zhao-b`, "lawyer");
  const r2 = await d2.register();
  assert.equal(r2.status, 200, JSON.stringify(r2.json));
  // 在这台电脑上用原账号登录：改前 409 device_mismatch（且同一邮箱不能再注册——死路）
  const login = await d2.call("POST", "/v1/auth/login", { email: "zhao-b56@example.cn", password: PW, client: { version: "0.3.0", platform: "win32" } });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  const a = cp.ops.account("zhao-b56@example.cn")!;
  assert.equal(a.member_slug, "zhao-b", "账号跟到获批的成员上");
  assert.equal(a.name, "赵律师（重发）", "显示名随新邀请");
  // 改绑后会话可用：带会话登记设备、取额度视图都按新成员
  assert.equal((await d2.register(login.json.session_token)).status, 200);
  // 已入组成员（有登记过的设备）的账号，不能在另一位无账号成员的电脑上登录后“换身份”
  await f.dev.call("POST", "/v1/invitations", { member_slug: "free-c", name: "空位", role: "lawyer" }, f.session);
  const d3 = device(f.tid, f.root.privateKeyPem, slugOf(f.tid, "free-c"), `dev_${f.tid.slice(4)}_free-c`, "lawyer");
  assert.equal((await d3.register()).status, 200);
  // 第 68 批（V42，D-294）：别人的电脑签名的登录不再整个拒绝（同一台电脑可以换账号）——但已入组的账号不改绑、会话不绑那台电脑、
  // 那台电脑也用不了这个会话（席位、额度等仍按“账号就是证书上的成员”核对）
  const hop = await d3.call("POST", "/v1/auth/login", { email: "zhao-b56@example.cn", password: PW, client: { version: "0.3.0", platform: "win32" } });
  assert.equal(hop.status, 200, JSON.stringify(hop.json));
  assert.notEqual(hop.json.onboarding.state, "ready", "不是这台电脑的账号");
  assert.equal(hop.json.session.device_id ?? null, null);
  assert.equal(cp.ops.account("zhao-b56@example.cn")!.member_slug, "zhao-b", "已入组的账号不改绑");
  // 会话没有绑到那台电脑（本人资料里这次会话的设备为空）
  const me = await fetch(`${base}/v1/auth/me`, { headers: { "x-kwl-session": hop.json.session_token } }).then((r) => r.json() as Promise<any>);
  assert.equal(me.session.device_id, null, "会话不绑别人的电脑");
  // 角色不一致不改绑：新建一个从未入组的助理账号，去登律师的电脑
  const inv4 = await f.dev.call("POST", "/v1/invitations", { member_slug: "asst-d", name: "助理丁", role: "assistant" }, f.session);
  assert.equal((await post("/v1/auth/register", { email: "asst-b56@example.cn", password: PW, name: "助理丁", code: inv4.json.code })).status, 200);
  const wrongRole = await d3.call("POST", "/v1/auth/login", { email: "asst-b56@example.cn", password: PW, client: { version: "0.3.0", platform: "win32" } });
  assert.equal(wrongRole.status, 200, JSON.stringify(wrongRole.json));
  assert.equal(cp.ops.account("asst-b56@example.cn")!.member_slug, "asst-d", "角色不同不改绑");
  assert.notEqual(wrongRole.json.onboarding.state, "ready");
});
