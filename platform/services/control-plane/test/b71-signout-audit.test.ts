import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { sign } from "node:crypto";
import { generateDeviceKeys, generateFirmRoot, issueDeviceCertificate } from "@zr-legal/keys";
import { enrollProofBytes, firmBundleBytes, signDeviceRequest } from "@zr-legal/firm-trust";
import { createAuditLog, createControlPlane, devControlPlaneKeys } from "../src/index.ts";
import { devStaffOf, staffClient } from "./staff-fixture.ts";
/**
 * 第 71 批（V45）：让电脑退出登录的三条路径都进这家律所的审计链（控制台“操作记录”据此显示）——本人（device.signout）、客服（account.device_signout）。
 * 原来运营路由只记平台访问日志，客服让出的那条在律所操作记录里看不到。
 */
test("让电脑退出登录：本人与客服两条路径都进律所审计链", async () => {
  const cp = createControlPlane({ keys: devControlPlaneKeys({ accountCa: true }), auditLog: createAuditLog(), serviceSecret: "probe-secret-0123456789abcdef0123456", devStaff: devStaffOf({ op_0203: ["support"] }), opsAccessLog: () => {} });
  await new Promise<void>((r) => cp.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(cp.server.address() as AddressInfo).port}`;
  const ops = staffClient(() => base);
  const post = async (p: string, b: unknown, h: Record<string, string> = {}) => { const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(b) }); return { status: r.status, json: (await r.json()) as any }; };
  const reg = await post("/v1/auth/register", { email: "pz@example.cn", password: "Lawyer2026secure", name: "管理员", client: { version: "0.10.0", platform: "win32" } });
  const onb = reg.json.onboarding; const tid = onb.claim.tid; const root = generateFirmRoot(); const rec = generateFirmRoot(); const ts = Date.now();
  await post("/v1/enroll", { tid, root_public_key_pem: root.publicKeyPem, ts, proof: sign(null, enrollProofBytes(tid, root.publicKeyPem, ts), root.privateKeyPem).toString("base64url"), activation_id: onb.claim.activation_id, claim_secret: onb.claim.claim_secret, firm_bundle: { recovery_public_key_pem: rec.publicKeyPem, sig: sign(null, firmBundleBytes(tid, root.publicKeyPem, rec.publicKeyPem), root.privateKeyPem).toString("base64url") } });
  const slug = onb.member.slug; const mk = (id: string) => { const k = generateDeviceKeys(); const cert = issueDeviceCertificate(root.privateKeyPem, { certId: `c_${id}`, memberId: `usr_${tid.slice(4)}_${slug}`, deviceId: id, role: "admin", signPublicKeyPem: k.signPublicKeyPem, encPublicKeyPem: k.encPublicKeyPem, issuedAt: new Date(Date.now() - 60000).toISOString(), expiresAt: new Date(Date.now() + 86400000 * 365).toISOString() }); return { id, call: async (m: string, p: string, b: unknown, s?: string) => { const raw = JSON.stringify(b); const r = await fetch(base + p, { method: m, headers: { ...signDeviceRequest({ method: m, path: p, body: raw, tid, deviceId: id, signPrivateKeyPem: k.signPrivateKeyPem }), "content-type": "application/json", ...(s ? { "x-kwl-session": s } : {}) }, body: raw }); return { status: r.status, json: await r.json() as any }; }, cert }; };
  const a = mk(`dev_${tid.slice(4)}_${slug}`); const b = mk(`dev_${tid.slice(4)}_${slug}_D2`);
  await a.call("POST", "/v1/devices/register", { tid, cert: a.cert }, reg.json.session_token);
  cp.ops.account("pz@example.cn")!.device_limit = 3;
  await b.call("POST", "/v1/devices/register", { tid, cert: b.cert });
  const lb = await b.call("POST", "/v1/auth/login", { email: "pz@example.cn", password: "Lawyer2026secure", client: { version: "0.10.0", platform: "darwin" }, account_switch: true });
  const s1 = await post(`/v1/auth/devices/${b.id}/signout`, {}, { "x-kwl-session": reg.json.session_token });
  const aid = reg.json.account.aid;
  const lb2 = await b.call("POST", "/v1/auth/login", { email: "pz@example.cn", password: "Lawyer2026secure", client: { version: "0.10.0", platform: "darwin" }, account_switch: true });
  const s2 = await ops("op_0203", "POST", `/v1/ops/accounts/${aid}/devices/${b.id}/signout`, {});
  const au = await ops("op_0203", "GET", `/v1/ops/tenants/${tid}/audit`);
  assert.deepEqual([s1.status, s2.status, lb.json.onboarding?.state, lb2.json.onboarding?.state], [200, 200, "ready", "ready"]);
  const actions = au.json.records.map((r: any) => r.action);
  assert.ok(actions.includes("device.signout"), JSON.stringify(actions));
  assert.ok(actions.includes("account.device_signout"), JSON.stringify(actions));
  cp.server.closeAllConnections(); await new Promise<void>((r) => cp.server.close(() => r()));
});
