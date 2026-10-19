/**
 * 开通与入组的复核处置（第 13 批复核 A-02/04/05/07/11、B13-O06）：
 * 入组申请须带邀请码本机秘密段的 HMAC、设备编号只能是 dev_<律所>_<成员>、两把公钥按算法解析；
 * 已兑换的码只在首次兑换后 10 分钟内、尚未提交申请时可再兑换；成员可撤回待批准申请；
 * 未认证入口对未知租户与凭据错误回同一错误；新建租户缺省要求开通码。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { sign } from "node:crypto";
import { generateDeviceKeys, generateFirmRoot, signBytes } from "@zr-legal/keys";
import { enrollProofBytes, inviteMac, joinMacBytes, joinProofBytes, newInviteSecret, signDeviceRequest } from "@zr-legal/firm-trust";
import { createControlPlane, devControlPlaneKeys, type ControlPlane } from "../src/index.ts";

let clock = Date.now();
let cp: ControlPlane;
let base = "";
before(async () => {
  cp = createControlPlane({ keys: devControlPlaneKeys(), serviceSecret: "hardening-secret", now: () => clock });
  await new Promise<void>((r) => cp.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(cp.server.address() as AddressInfo).port}`;
});
after(async () => {
  cp.server.closeAllConnections();
  await new Promise<void>((r) => cp.server.close(() => r()));
});

const post = async (path: string, body: unknown) => {
  const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as any };
};

/** 建租户、创始登记、管理员设备（直接用控制面运维与证书），返回发邀请的函数。 */
async function firm(tid: string) {
  cp.ops.createTenant({ tid, edition: "team", seats: 5 });
  assert.equal(cp.ops.tenant(tid)!.activation_required, true, "新建租户缺省要求开通码（复核 A-05）");
  const { code } = cp.ops.issueActivationCode(tid, { member: { slug: "boss" } });
  const red = await post("/v1/activation/redeem", { code });
  const root = generateFirmRoot();
  const ts = clock;
  const proof = sign(null, enrollProofBytes(tid, root.publicKeyPem, ts), root.privateKeyPem).toString("base64url");
  assert.equal((await post("/v1/enroll", { tid, root_public_key_pem: root.publicKeyPem, ts, proof, activation_id: red.json.activation_id, claim_secret: red.json.claim_secret })).status, 200);
  const { issueDeviceCertificate } = await import("@zr-legal/keys");
  const dk = generateDeviceKeys();
  const deviceId = `dev_${tid.slice(4)}_boss`;
  const cert = issueDeviceCertificate(root.privateKeyPem, { certId: `c_${deviceId}`, memberId: `usr_${tid.slice(4)}_boss`, deviceId, role: "admin", signPublicKeyPem: dk.signPublicKeyPem, encPublicKeyPem: dk.encPublicKeyPem, issuedAt: new Date(clock - 60_000).toISOString(), expiresAt: new Date(clock + 86400_000 * 365).toISOString() });
  const call = async (method: string, path: string, body?: unknown) => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const h = signDeviceRequest({ method, path, body: raw, tid, deviceId, signPrivateKeyPem: dk.signPrivateKeyPem, now: clock });
    const r = await fetch(`${base}${path}`, { method, headers: { ...h, ...(raw ? { "content-type": "application/json" } : {}) }, ...(raw ? { body: raw } : {}) });
    return { status: r.status, json: (await r.json()) as any };
  };
  assert.equal((await call("POST", "/v1/devices/register", { tid, cert })).status, 200);
  return { call, invite: async (slug: string) => (await call("POST", "/v1/invitations", { member_slug: slug, role: "lawyer" })).json };
}

function joinBody(tid: string, red: any, o: { deviceId?: string; secret?: string | null; encPub?: string } = {}) {
  const mk = generateDeviceKeys();
  const deviceId = o.deviceId ?? `dev_${tid.slice(4)}_${red.member.slug}`;
  const enc = o.encPub ?? mk.encPublicKeyPem;
  const S = o.secret === undefined ? newInviteSecret() : o.secret;
  return {
    tid,
    activation_id: red.activation_id,
    claim_secret: red.claim_secret,
    device_id: deviceId,
    sign_pub: mk.signPublicKeyPem,
    enc_pub: enc,
    proof: signBytes(mk.signPrivateKeyPem, joinProofBytes({ tid, activationId: red.activation_id, deviceId, signPublicKeyPem: mk.signPublicKeyPem, encPublicKeyPem: enc })),
    ...(S ? { mac: inviteMac(S, joinMacBytes({ tid, activationId: red.activation_id, deviceId, signPublicKeyPem: mk.signPublicKeyPem, encPublicKeyPem: enc, memberSlug: red.member.slug, role: red.member.role })) } : {}),
  };
}

test("入组申请：缺 HMAC、设备编号不是 dev_<律所>_<成员>、加密公钥不是 X25519 一律拒绝", async () => {
  const tid = "ten_hard-join";
  const f = await firm(tid);
  const inv = await f.invite("li");
  const red = (await post("/v1/activation/redeem", { code: inv.code })).json;
  assert.equal((await post("/v1/join-requests", joinBody(tid, red, { secret: null }))).json.error.code, "join_mac_missing");
  assert.equal((await post("/v1/join-requests", joinBody(tid, red, { deviceId: "dev_hard-join_boss" }))).json.error.code, "device_id_invalid", "不能抢占别的成员的设备编号");
  const notX25519 = generateDeviceKeys().signPublicKeyPem;
  assert.equal((await post("/v1/join-requests", joinBody(tid, red, { encPub: notX25519 }))).json.error.code, "public_key_invalid");
  assert.equal((await post("/v1/join-requests", joinBody(tid, red))).status, 200);
});

test("再兑换：首次兑换后 10 分钟内且未提交申请可再兑换（旧凭据作废）；提交申请后、超出窗口都不行", async () => {
  const tid = "ten_hard-redeem";
  const f = await firm(tid);
  const inv = await f.invite("wu");
  const r1 = (await post("/v1/activation/redeem", { code: inv.code })).json;
  clock += 60_000;
  const r2 = (await post("/v1/activation/redeem", { code: inv.code })).json;
  assert.equal(r2.ok, true, "应答丢失后重试可再兑换");
  assert.equal((await post("/v1/join-requests", joinBody(tid, r1))).json.error.code, "claim_invalid", "旧凭据作废");
  assert.equal((await post("/v1/join-requests", joinBody(tid, r2))).status, 200);
  assert.equal((await post("/v1/activation/redeem", { code: inv.code })).json.error.code, "code_invalid", "已提交申请后不能再兑换");
  const inv2 = await f.invite("zhou");
  await post("/v1/activation/redeem", { code: inv2.code });
  clock += 11 * 60_000;
  assert.equal((await post("/v1/activation/redeem", { code: inv2.code })).json.error.code, "code_invalid", "超出 10 分钟窗口");
});

test("撤回：成员凭认领凭据撤回待批准申请；之后取回为 rejected；管理员列表里不再出现", async () => {
  const tid = "ten_hard-withdraw";
  const f = await firm(tid);
  const inv = await f.invite("qian");
  const red = (await post("/v1/activation/redeem", { code: inv.code })).json;
  const jr = (await post("/v1/join-requests", joinBody(tid, red))).json;
  assert.equal((await post(`/v1/join-requests/${jr.join_request_id}/withdraw`, { tid, claim_secret: "x".repeat(43) })).json.error.code, "claim_invalid");
  assert.equal((await post(`/v1/join-requests/${jr.join_request_id}/withdraw`, { tid, claim_secret: red.claim_secret })).json.status, "withdrawn");
  assert.equal((await post(`/v1/join-requests/${jr.join_request_id}/fetch`, { tid, claim_secret: red.claim_secret })).json.status, "rejected");
  assert.equal((await f.call("GET", "/v1/join-requests")).json.join_requests.length, 0);
});

test("未认证入口：未知租户与凭据错误回同一错误（不可借此枚举租户）", async () => {
  const unknown = await post("/v1/join-requests", { tid: "ten_no-such-firm", activation_id: "act_x", claim_secret: "y".repeat(43) });
  const known = await post("/v1/join-requests", { tid: "ten_hard-join", activation_id: "act_x", claim_secret: "y".repeat(43) });
  assert.equal(unknown.status, known.status);
  assert.equal(unknown.json.error.code, "claim_invalid");
  assert.equal(known.json.error.code, "claim_invalid");
  const f1 = await post("/v1/join-requests/jr_aaaaaaaaaaaaaaaa/fetch", { tid: "ten_no-such-firm", claim_secret: "z" });
  assert.equal(f1.json.error.code, "claim_invalid");
});

test("清理（复核 A-16）：提交申请即清空成员姓名；过期未用的码清空姓名；结束 31 天后码记录与申请记录删除", async () => {
  const tid = "ten_hard-sweep";
  const f = await firm(tid);
  const a = (await f.call("POST", "/v1/invitations", { member_slug: "sun", role: "lawyer", name: "孙律师" })).json;
  const b = (await f.call("POST", "/v1/invitations", { member_slug: "zhao", role: "lawyer", name: "赵律师" })).json;
  const ra = (await post("/v1/activation/redeem", { code: a.code })).json;
  assert.equal(ra.member.name, "孙律师", "兑换时回显姓名");
  await post("/v1/join-requests", joinBody(tid, ra));
  const t = cp.ops.tenant(tid)!;
  assert.equal(t.activations.get(ra.activation_id)!.member.name, null, "提交申请后控制面不留姓名");
  const bid = [...t.activations.values()].find((r) => r.member.slug === "zhao")!.id;
  assert.equal(t.activations.get(bid)!.member.name, "赵律师");
  clock += 4 * 86400_000; // 邀请缺省 72 小时过期
  assert.ok(cp.ops.sweepOnboarding().names_cleared >= 1);
  assert.equal(t.activations.get(bid)!.member.name, null, "过期未用的邀请清空姓名");
  assert.ok(t.activations.has(bid), "未满 31 天的记录保留");
  clock += 35 * 86400_000;
  const r = cp.ops.sweepOnboarding();
  assert.ok(r.records_removed >= 2);
  assert.equal(t.activations.has(bid), false);
  assert.equal(t.activations.has(ra.activation_id), false);
  assert.equal([...t.joinRequests.values()].some((x) => x.activation_id === ra.activation_id), false, "申请记录一并删除");
  assert.equal((await post("/v1/activation/redeem", { code: b.code })).json.error.code, "code_invalid");
});
