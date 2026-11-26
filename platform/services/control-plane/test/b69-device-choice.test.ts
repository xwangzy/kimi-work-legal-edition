/**
 * 第 69 批（V43，D-297）云端侧：电脑数已满时“选一台移除”的列表与团队成员编号空间。
 * 头部 founder / device 辅助与第 68 批用例相同。原第 68 批说明：同一台电脑换账号。
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
  cp = createControlPlane({ keys: devControlPlaneKeys({ accountCa: true }), auditLog: createAuditLog(), serviceSecret: "b69-cloud-secret-0123456789abcdef01", usageBook: new UsageBook({ dir: join(mkdtempSync(join(tmpdir(), "kwl-b68c-")), "usage") }), routing: { bootstrap: { provider: { base_url: "https://maas.example.test/v1" } }, key_id: "0123456789abcdef" } });
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


test("电脑数已满：列表每台带平台、最近使用时刻、是否登录中，按最近使用从新到旧；不含 IP 与网段", async () => {
  const f = await founder("adm-b69a@example.cn", "六十九号甲所");
  const me = device(f.tid, f.root.privateKeyPem, f.slug, `dev_${f.tid.slice(4)}_${f.slug}`, "admin");
  assert.equal((await me.register(f.session)).status, 200);
  cp.ops.account("adm-b69a@example.cn")!.device_limit = 1;
  // 另一台电脑（不签名）登录同一账号 → 已满，列出已登记的那台
  const r = await post("/v1/auth/login", { email: "adm-b69a@example.cn", password: PW, client: { version: "0.9.0", platform: "darwin" }, account_switch: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.onboarding.state, "device_limit");
  assert.equal(r.json.onboarding.device_limit, 1);
  const d = r.json.onboarding.devices;
  assert.equal(d.length, 1);
  assert.equal(d[0].device_id, `dev_${f.tid.slice(4)}_${f.slug}`);
  assert.equal(d[0].platform, "win32", "取这个账号在那台电脑上最近一次会话报的平台");
  assert.ok(Number.isFinite(Date.parse(d[0].last_seen_at)), "会话级的最近使用时刻");
  assert.equal(d[0].session, "active");
  assert.deepEqual(Object.keys(d[0]).sort(), ["client_version", "device_id", "last_seen_at", "last_seen_on", "platform", "registered_at", "session"], "不含 IP、网段等定位信息");
  // /v1/auth/me 的设备列表同一口径
  const meView = await fetch(`${base}/v1/auth/me`, { headers: { authorization: `Bearer ${r.json.session_token}` } }).then((x) => x.json() as Promise<any>);
  assert.equal(meView.devices[0].platform, "win32");
});

test("团队成员换过 9 台电脑（含已移除）之后仍能登记新电脑：编号与个人账号同一空间；同时在用的台数仍受云端上限", async () => {
  const f = await founder("adm-b69b@example.cn", "六十九号乙所");
  const admin = device(f.tid, f.root.privateKeyPem, f.slug, `dev_${f.tid.slice(4)}_${f.slug}`, "admin");
  assert.equal((await admin.register(f.session)).status, 200);
  const inv = await admin.call("POST", "/v1/invitations", { member_slug: "bing", name: "丙律师", role: "lawyer" }, f.session);
  assert.equal((await post("/v1/auth/register", { email: "bing-b69@example.cn", password: PW, name: "丙律师", code: inv.json.code })).status, 200);
  const acct = cp.ops.account("bing-b69@example.cn")!;
  acct.device_limit = 2;
  // 丙先后用过 9 台电脑，都已移除（编号 1～9 全部用过）
  const t = cp.ops.tenant(f.tid)!;
  const fs = f.tid.slice(4);
  for (let n = 1; n <= 9; n++) {
    const id = n === 1 ? `dev_${fs}_bing` : `dev_${fs}_bing_D${n}`;
    t.devices.set(id, { cert: { deviceId: id, memberId: `usr_${fs}_bing`, role: "lawyer" } as any, registered_at: new Date(Date.now() - (20 - n) * 86400_000).toISOString(), revoked_at: new Date(Date.now() - (19 - n) * 86400_000).toISOString() });
  }
  const r = await post("/v1/auth/login", { email: "bing-b69@example.cn", password: PW, client: { version: "0.9.0", platform: "win32" }, account_switch: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.onboarding.state, "needs_device_join", "原来：编号 1～9 用尽即回 device_limit 且列表为空，无处可移除");
  assert.equal(r.json.onboarding.device_id, `dev_${fs}_bing_D10`);
  // 在用数仍受上限：再放两台在用的 → 已满，且列出这两台（不是空列表）
  for (const n of [10, 11]) {
    const id = `dev_${fs}_bing_D${n}`;
    t.devices.set(id, { cert: { deviceId: id, memberId: `usr_${fs}_bing`, role: "lawyer" } as any, registered_at: new Date().toISOString(), revoked_at: null });
  }
  for (const jr of t.joinRequests.values()) if (jr.member_slug === "bing") jr.status = "revoked" as any;
  const full = await post("/v1/auth/login", { email: "bing-b69@example.cn", password: PW, client: { version: "0.9.0", platform: "win32" }, account_switch: true });
  assert.equal(full.json.onboarding.state, "device_limit");
  assert.equal(full.json.onboarding.devices.length, 2);
});
