/**
 * 第 68 批（V42，D-294）云端侧：同一台电脑换账号。
 * - 别的成员的设备签名登录不再 409：200、会话不绑那台电脑、onboarding 按账号自己的设备策略；
 * - 安全复核 C-1：这时不签发入组认领（不撤这个账号在别的新电脑上等批准的申请）；真要登记新设备时用这次会话调 /v1/auth/onboarding 取认领；
 * - 安全复核 C-4：能换账号的客户端（account_switch）不做第 56 批的“改绑”；
 * - 设备签名先于验证码 / 密码核对：设备未登记时直接 401，不计密码错误；/v1/meta 公布 account_switch。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sign } from "node:crypto";
import { generateDeviceKeys, generateFirmRoot, issueDeviceCertificate, type DeviceRole } from "@zr-legal/keys";
import { enrollProofBytes, firmBundleBytes, signDeviceRequest } from "@zr-legal/firm-trust";
import { createAuditLog, createControlPlane, devControlPlaneKeys, UsageBook, type ControlPlane } from "../src/index.ts";

const PW = "Lawyer2026secure";
let cp: ControlPlane;
let base = "";
before(async () => {
  cp = createControlPlane({ keys: devControlPlaneKeys({ accountCa: true }), auditLog: createAuditLog(), serviceSecret: "b68-cloud-secret-0123456789abcdef01", usageBook: new UsageBook({ dir: join(mkdtempSync(join(tmpdir(), "kwl-b68c-")), "usage") }), routing: { bootstrap: { provider: { base_url: "https://maas.example.test/v1" } }, key_id: "0123456789abcdef" } });
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

async function founder(email: string, org: string) {
  const reg = await post("/v1/auth/register", { email, password: PW, name: "管理员", org_name: org, client: { version: "0.8.0", platform: "win32" } });
  const onb = reg.json.onboarding;
  const tid = onb.claim.tid as string;
  const root = generateFirmRoot();
  const rec = generateFirmRoot();
  const ts = Date.now();
  const firm_bundle = { recovery_public_key_pem: rec.publicKeyPem, sig: sign(null, firmBundleBytes(tid, root.publicKeyPem, rec.publicKeyPem), root.privateKeyPem).toString("base64url") };
  await post("/v1/enroll", { tid, root_public_key_pem: root.publicKeyPem, ts, proof: sign(null, enrollProofBytes(tid, root.publicKeyPem, ts), root.privateKeyPem).toString("base64url"), activation_id: onb.claim.activation_id, claim_secret: onb.claim.claim_secret, firm_bundle });
  return { tid, root, slug: onb.member.slug as string, session: reg.json.session_token as string };
}
function device(tid: string, rootPriv: string, memberSlug: string, deviceId: string, role: DeviceRole) {
  const k = generateDeviceKeys();
  const cert = issueDeviceCertificate(rootPriv, { certId: `cert_${deviceId}`, memberId: `usr_${tid.slice(4)}_${memberSlug}`, deviceId, role, signPublicKeyPem: k.signPublicKeyPem, encPublicKeyPem: k.encPublicKeyPem, issuedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 365 * 86400_000).toISOString() });
  const call = async (method: string, path: string, body?: unknown, session?: string) => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const h = signDeviceRequest({ method, path, body: raw, tid, deviceId, signPrivateKeyPem: k.signPrivateKeyPem });
    const r = await fetch(`${base}${path}`, { method, headers: { ...h, ...(raw ? { "content-type": "application/json" } : {}), ...(session ? { "x-kwl-session": session } : {}) }, ...(raw ? { body: raw } : {}) });
    return { status: r.status, json: (await r.json()) as any };
  };
  return { cert, call, register: (session?: string) => call("POST", "/v1/devices/register", { tid, cert }, session) };
}

test("别的成员的设备签名登录：不再 device_mismatch；会话不绑那台电脑；不签发认领、不撤别处等批准的申请；取认领走 /v1/auth/onboarding；能换账号的客户端不改绑", async () => {
  const meta = await fetch(`${base}/v1/meta`).then((r) => r.json() as Promise<any>);
  assert.equal(meta.account_switch, true);
  const f = await founder("adm-b68c@example.cn", "六十八号律所");
  await toTeam(f.session);
  const admin = device(f.tid, f.root.privateKeyPem, f.slug, `dev_${f.tid.slice(4)}_${f.slug}`, "admin");
  assert.equal((await admin.register(f.session)).status, 200);
  // 成员乙凭邀请码注册（还没有电脑），设备上限 2
  const inv = await admin.call("POST", "/v1/invitations", { member_slug: "yi", name: "乙律师", role: "lawyer" }, f.session);
  assert.equal((await post("/v1/auth/register", { email: "yi-b68c@example.cn", password: PW, name: "乙律师", code: inv.json.code })).status, 200);
  cp.ops.account("yi-b68c@example.cn")!.device_limit = 2;
  // 乙先在自己的新电脑上登录（不签名）→ needs_device_join + 认领，提交申请等批准
  const own = await post("/v1/auth/login", { email: "yi-b68c@example.cn", password: PW, client: { version: "0.8.0", platform: "win32" }, account_switch: true });
  assert.equal(own.json.onboarding.state, "needs_device_join");
  assert.ok(own.json.onboarding.claim, "真正的新电脑：照常签发认领");
  const t = cp.ops.tenant(f.tid)!;
  const openBefore = [...t.activations.values()].filter((r) => r.via_account && r.status !== "revoked").map((r) => r.id);
  // 乙又在管理员那台电脑上（管理员已退出）登录：带管理员的设备签名
  const hop = await admin.call("POST", "/v1/auth/login", { email: "yi-b68c@example.cn", password: PW, client: { version: "0.8.0", platform: "win32" }, account_switch: true });
  assert.equal(hop.status, 200, JSON.stringify(hop.json));
  assert.equal(hop.json.onboarding.state, "needs_device_join");
  assert.equal(hop.json.onboarding.claim, undefined, "C-1：不签发认领");
  const openAfter = [...t.activations.values()].filter((r) => r.via_account && r.status !== "revoked").map((r) => r.id);
  assert.deepEqual(openAfter, openBefore, "乙在自己新电脑上的认领没有被撤");
  const me = await fetch(`${base}/v1/auth/me`, { headers: { "x-kwl-session": hop.json.session_token } }).then((r) => r.json() as Promise<any>);
  assert.equal(me.session.device_id, null, "会话不绑管理员的电脑");
  // 真要在这台电脑上为乙登记时才取认领
  const ob = await post("/v1/auth/onboarding", {}, { "x-kwl-session": hop.json.session_token });
  assert.equal(ob.status, 200, JSON.stringify(ob.json));
  assert.ok(ob.json.onboarding.claim);
  // 设备签名先于密码核对：未登记的设备签名 → 401，不计密码错误
  const stranger = device(f.tid, f.root.privateKeyPem, "nobody", `dev_${f.tid.slice(4)}_nobody`, "lawyer");
  const bad = await stranger.call("POST", "/v1/auth/login", { email: "yi-b68c@example.cn", password: "wrong-password-1", client: { version: "0.8.0", platform: "win32" } });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error.code, "device_unknown_or_revoked");
  assert.equal(cp.ops.account("yi-b68c@example.cn")!.failed.count, 0);
});

test("安全复核 C-4：能换账号的客户端不做“改绑”（同所从未入组的同事在一位没有账号的成员的电脑上登录，不会变成那位成员）", async () => {
  const f = await founder("adm2-b68c@example.cn", "六十八号乙所");
  await toTeam(f.session);
  const admin = device(f.tid, f.root.privateKeyPem, f.slug, `dev_${f.tid.slice(4)}_${f.slug}`, "admin");
  assert.equal((await admin.register(f.session)).status, 200);
  // 成员丙：管理员发了邀请、电脑已登记（没有账号）
  await admin.call("POST", "/v1/invitations", { member_slug: "bing", name: "丙律师", role: "lawyer" }, f.session);
  const bing = device(f.tid, f.root.privateKeyPem, "bing", `dev_${f.tid.slice(4)}_bing`, "lawyer");
  assert.equal((await bing.register()).status, 200);
  // 同事丁：凭邀请码注册、从未入组、角色相同
  const inv = await admin.call("POST", "/v1/invitations", { member_slug: "ding", name: "丁律师", role: "lawyer" }, f.session);
  assert.equal((await post("/v1/auth/register", { email: "ding-b68c@example.cn", password: PW, name: "丁律师", code: inv.json.code })).status, 200);
  const r = await bing.call("POST", "/v1/auth/login", { email: "ding-b68c@example.cn", password: PW, client: { version: "0.8.0", platform: "darwin" }, account_switch: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(cp.ops.account("ding-b68c@example.cn")!.member_slug, "ding", "没有改绑成丙");
  assert.notEqual(r.json.onboarding.state, "ready");
});
