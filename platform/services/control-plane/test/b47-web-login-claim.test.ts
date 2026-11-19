/**
 * 第 47 批真实走查发现：律师在网页控制台登录（没有设备签名）时，控制面按“同一账号同一种类只留一份”生成了新的入组认领凭据，
 * 把这个账号正在等批准的新电脑申请撤掉了——管理员那边申请消失，新电脑一直停在“等待批准”。修正：网页登录只报状态、不生成认领凭据。
 * 用例复用第 44 批账号用例的搭建（独立控制面实例，避免与其登录限速共用计数）。
 */
/**
 * 第 44 批：自有账号（注册、登录、会话、设备入组、停用、重置）、账号闸（席位令牌与网关暂停设备）、API 路由登记与签名订阅、
 * 用量账本（按请求编号去重、按价目版本计价、落盘重启）、额度 v2（按席位租约、上限、个人上限、频率窗口）、旧状态迁移。
 * 对端（网关）用服务凭据直接调接口；律所侧用真实的设备密钥与律所根签名（与内核同一套 firm-trust / keys）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createECDH, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDeviceKeys, generateFirmRoot, issueDeviceCertificate, type DeviceRole } from "@zr-legal/keys";
import { enrollProofBytes, firmBundleBytes, joinProofBytes, openEnvelope, publicKeyMap, signDeviceRequest } from "@zr-legal/firm-trust";
import { accountDeviceId, accountDeviceIndex, createControlPlane, devControlPlaneKeys, fileStateStore, passwordProblems, UsageBook, type ControlPlane } from "../src/index.ts";

const keys = devControlPlaneKeys();
const SECRET = "b44-test-service-secret-0123456789abcdef";
const PW = "Lawyer2026secure";
let cp: ControlPlane;
let base = "";
const dir = mkdtempSync(join(tmpdir(), "kwl-b47-"));

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

const feed = async () => {
  const r = await get("/v1/feed/gateway", { authorization: `Bearer ${SECRET}` });
  const o = openEnvelope<any>(r.json, "kwl-gateway-feed", publicKeyMap(cp.publicKeys.envelope));
  assert.ok(o.ok);
  return o.ok ? o.body : null;
};

test("第 47 批：网页控制台登录不撤回同一账号等批准的新电脑申请（网页登录只报状态、不生成认领凭据）；客户端重新登录仍换新凭据", async () => {
  const f = await signupFounder("founder7@example.cn", "七号律所");
  cp.ops.account("founder7@example.cn")!.device_limit = 2;
  const desk = await post("/v1/auth/login", { email: "founder7@example.cn", password: PW, client: { platform: "darwin" } });
  const onb = desk.json.onboarding;
  assert.equal(onb.state, "needs_device_join");
  const k2 = generateDeviceKeys();
  const proof = sign(null, joinProofBytes({ tid: f.tid, activationId: onb.claim.activation_id, deviceId: onb.device_id, signPublicKeyPem: k2.signPublicKeyPem, encPublicKeyPem: k2.encPublicKeyPem }), k2.signPrivateKeyPem).toString("base64url");
  const jr = await post("/v1/join-requests", { tid: f.tid, activation_id: onb.claim.activation_id, claim_secret: onb.claim.claim_secret, device_id: onb.device_id, sign_pub: k2.signPublicKeyPem, enc_pub: k2.encPublicKeyPem, proof });
  assert.equal(jr.status, 200, JSON.stringify(jr.json));
  const pendingIds = async () => (await f.dev.call("GET", "/v1/join-requests", undefined, f.session)).json.join_requests.map((x: any) => x.id);
  assert.deepEqual(await pendingIds(), [jr.json.join_request_id]);
  // 律师在网页控制台登录（没有设备签名）：只报状态，不带认领凭据，申请仍在
  const web = await post("/v1/auth/login", { email: "founder7@example.cn", password: PW, client: { platform: "web", version: "1.0.0" } });
  assert.equal(web.status, 200);
  assert.equal(web.json.onboarding.state, "needs_device_join");
  assert.equal(web.json.onboarding.claim, undefined, "网页登录不生成认领凭据");
  assert.deepEqual(await pendingIds(), [jr.json.join_request_id], "等批准的申请没有被撤回");
  // 客户端（没有设备签名的新电脑）再登录：按原设计换新凭据，旧申请撤回（同一账号同一种类只留一份）
  const desk2 = await post("/v1/auth/login", { email: "founder7@example.cn", password: PW, client: { platform: "darwin" } });
  assert.ok(desk2.json.onboarding.claim?.activation_id);
  assert.deepEqual(await pendingIds(), [], "客户端重新登录换新凭据，旧申请撤回");
});
