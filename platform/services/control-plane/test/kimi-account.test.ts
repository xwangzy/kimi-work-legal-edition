/**
 * 第 40 批：Kimi 账号对接（设备授权由控制面代办）与套餐目录。
 * - 律师用 Kimi 账号登录 → 绑定本人席位；控制面只存账号引用（HMAC）与打码信息，不存 Kimi 用户编号、完整昵称与令牌；
 * - 未到轮询间隔不打上游；拒绝、过期、别的设备的流程如实回报；同一律所一个 Kimi 账号只绑一个席位；
 * - 律所要求 Kimi 登录时，未绑定的成员领不到席位令牌；运营看得到打码账号、可解绑；绑定与解绑进律所可见的流水；
 * - 配置校验：拒绝 Kimi Code 的 client_id 与非 https 地址；套餐目录与账单口径。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import { generateDeviceKeys, generateFirmRoot, issueDeviceCertificate, type DeviceCertificate, type DeviceRole } from "@zr-legal/keys";
import { enrollProofBytes, openEnvelope, publicKeyMap, signDeviceRequest, type CpAuditPage } from "@zr-legal/firm-trust";
import { createControlPlane, devControlPlaneKeys, maskNickname, monthBill, planOf, validateBilling, validateKimiConfig, DEFAULT_BILLING, type ControlPlane } from "../src/index.ts";
// @ts-expect-error 纯 JS 开发脚本（无类型声明）
import { startMockKimi } from "../../../scripts/lib/dev-kimi-oauth.mjs";

const TID = "ten_kimi";
const root = generateFirmRoot();
let cp: ControlPlane;
let base = "";
let kimi: { base: string; approve(code: string, idx?: number, deny?: boolean): boolean; close(): Promise<void> };
let clock = Date.now();

before(async () => {
  kimi = await startMockKimi({ interval: 2 });
  cp = createControlPlane({ keys: devControlPlaneKeys(), serviceSecret: "kimi-test-service-secret", now: () => clock, kimiAccount: { config: { oauth_host: kimi.base, client_id: "kwl-legal-test", api_base: kimi.base } } });
  await new Promise<void>((r) => cp.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(cp.server.address() as AddressInfo).port}`;
  cp.ops.createTenant({ activationRequired: false, tid: TID, edition: "team", seats: 5, plan: "pro" });
  const ts = clock;
  const proof = sign(null, enrollProofBytes(TID, root.publicKeyPem, ts), root.privateKeyPem).toString("base64url");
  const r = await fetch(`${base}/v1/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tid: TID, root_public_key_pem: root.publicKeyPem, ts, proof }) });
  assert.equal(r.status, 200);
});
after(async () => {
  cp.server.closeAllConnections();
  await new Promise<void>((r) => cp.server.close(() => r()));
  await kimi.close();
});

function makeDevice(role: DeviceRole, member: string, id: string) {
  const k = generateDeviceKeys();
  const cert: DeviceCertificate = issueDeviceCertificate(root.privateKeyPem, { certId: `cert_${id}`, memberId: member, deviceId: id, role, signPublicKeyPem: k.signPublicKeyPem, encPublicKeyPem: k.encPublicKeyPem, issuedAt: new Date(clock - 60_000).toISOString(), expiresAt: new Date(clock + 365 * 86400_000).toISOString() });
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const h = signDeviceRequest({ method, path, body: raw, tid: TID, deviceId: id, signPrivateKeyPem: k.signPrivateKeyPem, now: clock });
    const r = await fetch(`${base}${path}`, { method, headers: { ...h, ...(raw ? { "content-type": "application/json" } : {}) }, ...(raw ? { body: raw } : {}) });
    return { status: r.status, json: await r.json() };
  };
  return { cert, call, register: () => call("POST", "/v1/devices/register", { tid: TID, cert }) };
}
/** 走一遍设备授权：发起 → 在模拟授权页上选第 idx 个账号 → 过轮询间隔 → 轮询。 */
async function login(d: ReturnType<typeof makeDevice>, idx: number, deny = false) {
  const s = await d.call("POST", "/v1/account/kimi/start", {});
  assert.equal(s.status, 200, JSON.stringify(s.json));
  assert.match(s.json.user_code, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
  assert.ok(s.json.verification_uri_complete.startsWith(`${kimi.base}/device?user_code=`));
  assert.equal("device_code" in s.json, false, "设备码只在控制面");
  const early = await d.call("POST", "/v1/account/kimi/poll", { flow_id: s.json.flow_id });
  assert.equal(early.json.status, "pending", "未到间隔不打上游");
  assert.ok(kimi.approve(s.json.user_code, idx, deny));
  clock += 2_100;
  return d.call("POST", "/v1/account/kimi/poll", { flow_id: s.json.flow_id });
}

let admin: ReturnType<typeof makeDevice>;
let law: ReturnType<typeof makeDevice>;
let law2: ReturnType<typeof makeDevice>;

test("律师用 Kimi 账号登录：绑定本人席位，只存账号引用与打码信息；同一账号不能绑本所第二个席位；拒绝与别的设备的流程如实回报", async () => {
  admin = makeDevice("admin", "usr_admin", "dev_kadmin");
  law = makeDevice("lawyer", "usr_law", "dev_klaw");
  law2 = makeDevice("lawyer", "usr_law2", "dev_klaw2");
  for (const d of [admin, law, law2]) assert.equal((await d.register()).status, 200);
  assert.deepEqual((await law.call("GET", "/v1/account/kimi")).json, { enabled: true, required: false, account: null });

  const r = await login(law, 0);
  assert.equal(r.json.status, "bound", JSON.stringify(r.json));
  assert.deepEqual({ ...r.json.account, bound_at: "x" }, { nickname: "张**", phone_tail: "0001", level: "Allegro", bound_at: "x" });
  const stored = JSON.stringify([...cp.ops.tenant(TID)!.kimiAccounts]);
  assert.ok(!stored.includes("u_demo_zhang") && !stored.includes("张明远") && !stored.includes("mock_at_"), "不存 Kimi 用户编号、完整昵称与令牌");
  assert.match(stored, /"ref":"kimi_[0-9a-f]{20}"/);

  // 同一账号绑第二个成员：拒绝
  const dup = await login(law2, 0);
  assert.deepEqual([dup.status, dup.json.error.code], [409, "kimi_account_in_use"]);
  // 在授权页上拒绝
  assert.equal((await login(law2, 1, true)).json.status, "denied");
  // 别的设备拿不到这个流程
  const s = await law2.call("POST", "/v1/account/kimi/start", {});
  clock += 2_100;
  assert.equal((await law.call("POST", "/v1/account/kimi/poll", { flow_id: s.json.flow_id })).json.status, "expired");
  // 换一个账号绑定成功
  assert.equal((await login(law2, 1)).json.status, "bound");
});

test("律所要求 Kimi 登录：未绑定的成员领不到席位令牌；用量视图与运营明细带打码账号；运营解绑；绑定、解绑与开关都进律所流水", async () => {
  cp.ops.setKimiRequired(TID, true);
  const seatOk = await law.call("POST", "/v1/seat-token", {});
  assert.equal(seatOk.status, 200, JSON.stringify(seatOk.json));
  const seatNo = await admin.call("POST", "/v1/seat-token", {});
  assert.deepEqual([seatNo.status, seatNo.json.error.code], [403, "kimi_account_required"]);

  const v = openEnvelope<any>((await admin.call("GET", "/v1/quota")).json, "kwl-quota-view", publicKeyMap(cp.publicKeys.envelope));
  assert.ok(v.ok);
  if (!v.ok) return;
  assert.deepEqual(v.body.kimi.members.usr_law, { nickname: "张**", phone_tail: "0001" });
  assert.equal(v.body.kimi.required, true);
  assert.equal(v.body.kimi.own, null, "管理员本人没绑定");
  const lv = openEnvelope<any>((await law.call("GET", "/v1/quota")).json, "kwl-quota-view", publicKeyMap(cp.publicKeys.envelope));
  assert.ok(lv.ok && !("members" in lv.body.kimi), "律师看不到别人的账号");

  // 运营解绑（按账号引用）；解绑后该成员领不到席位令牌
  const t = cp.ops.tenant(TID)!;
  const ref = t.kimiAccounts.get("usr_law")!.ref;
  cp.ops.unbindKimi(TID, ref);
  assert.equal((await law.call("POST", "/v1/seat-token", {})).json.error.code, "kimi_account_required");
  // 本人解绑
  assert.equal((await law2.call("DELETE", "/v1/account/kimi")).status, 200);
  assert.equal(t.kimiAccounts.size, 0);

  const page = openEnvelope<CpAuditPage>((await admin.call("GET", "/v1/audit?after=0&limit=500")).json, "kwl-cp-audit-page", publicKeyMap(cp.publicKeys.envelope));
  assert.ok(page.ok);
  const acts = page.ok ? page.body.records.map((r) => `${r.actor.kind}:${r.action}:${r.result}`) : [];
  for (const a of ["device:kimi.bind:ok", "ops:kimi.policy:ok", "ops:kimi.unbind:ok", "device:kimi.unbind:ok"]) assert.ok(acts.includes(a), `${a} 在流水里：${acts.join(" ")}`);
  assert.ok(!JSON.stringify(page.ok ? page.body.records : []).includes("usr_"), "流水里没有成员编号");
});

test("配置校验拒绝 Kimi Code 的 client_id 与非 https 地址；昵称打码", () => {
  assert.throws(() => validateKimiConfig({ oauth_host: "https://auth.kimi.com", client_id: "17e5f671-d194-4dfb-9706-5516cb48c098", api_base: "https://api.kimi.com/coding/v1" }), /Kimi Code 的客户端编号/);
  assert.throws(() => validateKimiConfig({ oauth_host: "http://auth.kimi.com", client_id: "kwl-legal", api_base: "https://api.kimi.com/coding/v1" }), /https/);
  assert.deepEqual(validateKimiConfig({ oauth_host: "https://auth.kimi.com/", client_id: "kwl-legal", api_base: "https://api.kimi.com/coding/v1" }), { oauth_host: "https://auth.kimi.com", client_id: "kwl-legal", api_base: "https://api.kimi.com/coding/v1", userinfo_path: "/me", timeout_ms: 8000 });
  assert.equal(validateKimiConfig(undefined), null);
  assert.equal(maskNickname("张明远"), "张**");
  assert.equal(maskNickname("Al"), "A*");
  assert.equal(maskNickname("李"), "*");
  assert.equal(maskNickname("  "), "Kimi 用户");
});

test("套餐目录与账单：目录校验；席位费 + 加量费（按系数）；成本按单位；没配价格的项为 null", () => {
  assert.throws(() => validateBilling({ plans: [] }), /1–20/);
  assert.throws(() => validateBilling({ plans: [{ id: "A", label: "x", seat_monthly_units: 1 }] }), /小写/);
  assert.throws(() => validateBilling({ plans: [{ id: "a", label: "x", seat_monthly_units: 1 }], default_plan: "b" }), /不在目录/);
  const cfg = validateBilling({ plans: [{ id: "pro", label: "专业", seat_monthly_units: 500_000, seat_price_cny: 799 }], unit_cost_cny: 0.001, boost_price_factor: 0.8 });
  assert.deepEqual(monthBill(cfg, { plan: planOf(cfg, "pro"), seats: 10, boost_pct: 50, used_units: 1_000_000 }), { seat_fee_cny: 7990, boost_fee_cny: 3196, revenue_cny: 11186, cost_cny: 1000, margin_cny: 10186 });
  assert.deepEqual(monthBill(DEFAULT_BILLING, { plan: planOf(DEFAULT_BILLING, "standard"), seats: 3, boost_pct: 0, used_units: 5 }), { seat_fee_cny: null, boost_fee_cny: null, revenue_cny: null, cost_cny: null, margin_cny: null });
  assert.equal(planOf(DEFAULT_BILLING, "nope").id, "standard", "不在目录的套餐按缺省套餐");
});
