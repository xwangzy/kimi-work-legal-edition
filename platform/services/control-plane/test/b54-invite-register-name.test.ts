/**
 * 第 54 批（Windows 安装包连 116 演示云端真实联调）：凭成员邀请码注册时，回给客户端的成员姓名用管理员写在邀请上的姓名。
 * 新电脑把这个姓名算进入组申请的 HMAC（邀请码本机秘密段），管理员电脑按本机邀请记录的姓名核对；原来回的是律师注册时自己填的名字，
 * 两边一不同（邀请写“王五”、律师填“王五律师”），正当申请就显示“在传送中被改动过，不要批准”，且没有办法批准。
 * 与“直接输入码”的兑换接口（/v1/activation/redeem）一致；账号显示名仍是律师自己填的；开通码（创始）不受影响。
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
  assert.equal(f.account.name, "张律师", "创始：账号与成员都是自己填的名字");
  const inv = await f.dev.call("POST", "/v1/invitations", { member_slug: "wangwu", name: "王五", role: "lawyer" }, f.session);
  assert.equal(inv.status, 200, JSON.stringify(inv.json));
  const reg = await post("/v1/auth/register", { email: "wangwu@example.cn", password: PW, name: "王五律师", code: inv.json.code });
  assert.equal(reg.status, 200, JSON.stringify(reg.json));
  assert.equal(reg.json.onboarding.state, "needs_device_join");
  assert.equal(reg.json.onboarding.member.name, "王五");
  assert.equal(reg.json.onboarding.claim.member.name, "王五");
  assert.equal(cp.ops.account("wangwu@example.cn")!.name, "王五律师");
  // 名字相同时不变
  const inv2 = await f.dev.call("POST", "/v1/invitations", { member_slug: "zhaoliu", name: "赵六", role: "assistant" }, f.session);
  const reg2 = await post("/v1/auth/register", { email: "zhaoliu@example.cn", password: PW, name: "赵六", code: inv2.json.code });
  assert.equal(reg2.json.onboarding.member.name, "赵六");
});
