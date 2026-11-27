/**
 * 第 66 批（V40，D-292）：个人账号取消设备绑定与数量限制 + 个人用量接口。
 * - 个人租户（自助注册、1 名成员且为管理员）的新电脑：登录即 needs_device_auto → POST /v1/auth/devices/enroll（会话 + 新设备公钥 + 持有证明）
 *   → 控制面用账号设备签发钥签 365 天证书（issuer = account_ca）、直接登记，应答是签名信封 kwl-device-enroll（证书 + 律所根公钥 + 律所公钥包）；
 * - account_ca 证书不能做团队管理动作（发邀请、批准成员、发布策略）；发了成员邀请即转回团队租户、恢复“另一台电脑批准”；
 * - 第 68 批（V42，D-295）起：电脑数上限一律按云端配置（账号 > 套餐 > 缺省），满了拒绝并给出已登记的电脑（不再自动吊销最久未用的一台）；
 *   刚登录的新电脑会话可就地移除一台再继续；24 小时内第 4 台或短时多网段 → 暂停、要短信确认；
 * - /v1/quota 追加 personal / own_models / plan.{note,period,burst,models}，按 uid；/v1/quota/usage 翻页（签名信封 kwl-usage-page，只含本人的行）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDeviceKeys, generateFirmRoot, issueDeviceCertificate, verifyDeviceCertificate, type DeviceCertificate, type DeviceRole } from "@zr-legal/keys";
import { deviceEnrollProofBytes, enrollProofBytes, firmBundleBytes, openEnvelope, publicKeyMap, signDeviceRequest, verifyDeviceCertificateAny } from "@zr-legal/firm-trust";
import { cpRelayAllowed } from "@zr-legal/egress-gate";
import { accountDeviceCertProblem, accountDeviceId, accountDeviceIndex, coarseNet, createAuditLog, createControlPlane, devControlPlaneKeys, localSigner, UsageBook, type ControlPlane } from "../src/index.ts";

const auditLog = createAuditLog();

const keys = devControlPlaneKeys({ accountCa: true });
const SECRET = "b66-test-service-secret-0123456789abcdef";
const PW = "Lawyer2026secure";
let cp: ControlPlane;
let base = "";
const dir = mkdtempSync(join(tmpdir(), "kwl-b66-"));

before(async () => {
  cp = createControlPlane({ keys, auditLog, serviceSecret: SECRET, usageBook: new UsageBook({ dir: join(dir, "usage") }), routing: { bootstrap: { provider: { base_url: "https://maas.example.test/v1" } }, key_id: "0123456789abcdef" } });
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
const envKeys = () => publicKeyMap(cp.publicKeys.envelope);

/** 律所侧设备：设备密钥 + 证书；请求一律设备签名，可带会话头。 */
function deviceOf(tid: string, cert: DeviceCertificate, k: ReturnType<typeof generateDeviceKeys>) {
  const call = async (method: string, path: string, body?: unknown, session?: string) => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const h = signDeviceRequest({ method, path, body: raw, tid, deviceId: cert.deviceId, signPrivateKeyPem: k.signPrivateKeyPem });
    const r = await fetch(`${base}${path}`, { method, headers: { ...h, ...(raw ? { "content-type": "application/json" } : {}), ...(session ? { "x-kwl-session": session } : {}) }, ...(raw ? { body: raw } : {}) });
    return { status: r.status, json: (await r.json()) as any };
  };
  return { k, cert, call, register: (session?: string) => call("POST", "/v1/devices/register", { tid, cert }, session) };
}

/** 自助注册 → 创始开通（同时上传律所公钥包）→ 登记创始设备。 */
async function signupFounder(email: string, org: string) {
  const reg = await post("/v1/auth/register", { email, password: PW, name: "钱律师", org_name: org, client: { version: "0.5.1", platform: "win32" } });
  assert.equal(reg.status, 200, JSON.stringify(reg.json));
  const onb = reg.json.onboarding;
  assert.equal(onb.state, "needs_founder_setup");
  const tid = onb.claim.tid as string;
  const root = generateFirmRoot();
  const recovery = generateFirmRoot(); // 只用它的公钥当恢复托管公钥（格式同为 Ed25519 SPKI）
  const ts = Date.now();
  const proof = sign(null, enrollProofBytes(tid, root.publicKeyPem, ts), root.privateKeyPem).toString("base64url");
  const firm_bundle = { recovery_public_key_pem: recovery.publicKeyPem, sig: sign(null, firmBundleBytes(tid, root.publicKeyPem, recovery.publicKeyPem), root.privateKeyPem).toString("base64url") };
  const en = await post("/v1/enroll", { tid, root_public_key_pem: root.publicKeyPem, ts, proof, activation_id: onb.claim.activation_id, claim_secret: onb.claim.claim_secret, firm_bundle });
  assert.equal(en.status, 200, JSON.stringify(en.json));
  const memberId = `usr_${tid.slice(4)}_${onb.member.slug}`;
  const k = generateDeviceKeys();
  const deviceId = accountDeviceId(tid.slice(4), onb.member.slug, 1);
  const cert = issueDeviceCertificate(root.privateKeyPem, { certId: `cert_${deviceId}`, memberId, deviceId, role: "admin" as DeviceRole, signPublicKeyPem: k.signPublicKeyPem, encPublicKeyPem: k.encPublicKeyPem, issuedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 365 * 86400_000).toISOString() });
  const dev = deviceOf(tid, cert, k);
  assert.equal((await dev.register(reg.json.session_token)).status, 200);
  return { tid, root, memberId, slug: onb.member.slug as string, dev, session: reg.json.session_token as string };
}

/** 新电脑：登录（不带设备签名）→ 生成设备密钥与持有证明 → 自动登记。 */
async function newComputer(email: string, o: { platform?: string; extra?: Record<string, unknown> } = {}) {
  const li = await post("/v1/auth/login", { email, password: PW, client: { version: "0.5.1", platform: o.platform ?? "darwin" } });
  assert.equal(li.status, 200, JSON.stringify(li.json));
  const onb = li.json.onboarding;
  const k = generateDeviceKeys();
  const enroll = (deviceId = String(onb.device_id), extra: Record<string, unknown> = o.extra ?? {}) => {
    const proof = sign(null, deviceEnrollProofBytes({ tid: onb.tid, aid: li.json.account.aid, sid: li.json.session.sid, deviceId, signPublicKeyPem: k.signPublicKeyPem, encPublicKeyPem: k.encPublicKeyPem }), k.signPrivateKeyPem).toString("base64url");
    return post("/v1/auth/devices/enroll", { device_id: deviceId, sign_pub: k.signPublicKeyPem, enc_pub: k.encPublicKeyPem, proof, client: { version: "0.5.1", platform: o.platform ?? "darwin" }, ...extra }, { "x-kwl-session": li.json.session_token });
  };
  return { li, onb, k, enroll, session: li.json.session_token as string };
}

test("个人租户：新电脑登录即 needs_device_auto → 控制面签 account_ca 证书、直接登记（无需另一台批准；台数按云端配置）；应答签名信封含证书、律所根公钥与律所公钥包；/v1/meta 公布签发钥编号", async () => {
  const meta = await get("/v1/meta");
  assert.ok(meta.json.features.includes("device_auto_enroll"));
  assert.equal(meta.json.account_device_ca.kid, "acct-ca-dev1");
  const f = await signupFounder("p1@example.cn", "钱律师工作室");
  const t = cp.ops.tenant(f.tid)!;
  assert.equal(t.personal, true);
  assert.ok(t.firm_bundle, "开通时存下律所公钥包");
  assert.equal(t.account_device_ca?.kid, "acct-ca-dev1");
  // 第 68 批（D-295）：试用套餐每账号 1 台，个人账号同样受此限——云端把这个账号调到 3 台
  assert.equal((await newComputer("p1@example.cn")).onb.state, "device_limit", "按套餐 1 台：第二台满了");
  cp.ops.account("p1@example.cn")!.device_limit = 3;
  const nc = await newComputer("p1@example.cn");
  assert.equal(nc.onb.state, "needs_device_auto", JSON.stringify(nc.onb));
  assert.equal(nc.onb.device_id, `${f.dev.cert.deviceId}_D2`);
  assert.equal(nc.onb.claim, undefined, "不生成入组认领");
  // 持有证明不对 / 编号不对 → 拒绝
  assert.equal((await nc.enroll(`${f.dev.cert.deviceId}_D3`)).json.error.code, "device_id_mismatch");
  const r = await nc.enroll();
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const o = openEnvelope<any>(r.json, "kwl-device-enroll", envKeys());
  assert.ok(o.ok);
  const b = o.ok ? o.body : null;
  assert.equal(b.cert.issuer, "account_ca");
  assert.equal(b.cert.memberId, f.memberId);
  assert.equal(b.cert.role, "admin");
  assert.ok(Date.parse(b.cert.expiresAt) - Date.parse(b.cert.issuedAt) <= 366 * 86400_000);
  assert.ok(verifyDeviceCertificateAny(b.cert, { root: f.root.publicKeyPem, accountCa: b.ca.public_key_pem }).ok);
  assert.equal(verifyDeviceCertificate(b.cert, f.root.publicKeyPem).ok, false, "不是律所根签的");
  assert.equal(verifyDeviceCertificateAny(b.cert, { root: f.root.publicKeyPem }).ok, false, "团队路径（没给 account_ca 锚）不认");
  assert.equal(b.root_public_key_pem, f.root.publicKeyPem);
  assert.ok(sign !== undefined && b.firm_bundle.sig.length > 0);
  assert.ok(!JSON.stringify(b).includes("PRIVATE"));
  // 新电脑：已登记、可用同一会话登记（幂等）与取额度视图；会话已绑定这台
  const nd = deviceOf(f.tid, b.cert, nc.k);
  assert.equal((await nd.register(nc.session)).status, 200);
  const q = await nd.call("GET", "/v1/quota", undefined, nc.session);
  assert.equal(q.status, 200, JSON.stringify(q.json));
  // 同一会话不能再登记第二台
  assert.equal((await nc.enroll()).json.error.code, "session_not_enrollable");
  // 本人资料：个人账号、最近登录（含新电脑登记）、设备签发者
  const me = await get("/v1/auth/me", { "x-kwl-session": nc.session });
  assert.equal(me.json.personal, true);
  assert.equal(me.json.recent_logins[0].kind, "enroll");
  assert.equal(me.json.recent_logins[0].platform, "darwin");
  assert.equal(me.json.recent_logins[0].net, "127.0.x.x");
  assert.deepEqual(me.json.devices.map((d: any) => d.issuer).sort(), ["account_ca", "firm_root"]);
  // 新电脑登录提醒（本所告警 new_device）
  const web = await post("/v1/auth/login", { email: "p1@example.cn", password: PW, client: { platform: "web" } });
  const ov = await get("/v1/firm/overview", { authorization: `Bearer ${web.json.session_token}` });
  assert.ok(ov.json.alerts.some((a: any) => a.kind === "new_device" && /新电脑/.test(a.message)), JSON.stringify(ov.json.alerts));
  // account_ca 证书不能做团队管理动作
  const inv = await nd.call("POST", "/v1/invitations", { member_slug: "x1", role: "lawyer" }, nc.session);
  assert.equal(inv.json.error.code, "firm_root_device_required");
  // 移除这台电脑（= 吊销 + 撤会话）即时生效
  assert.equal((await post(`/v1/auth/devices/${b.cert.deviceId}/unbind`, { password: PW }, { "x-kwl-session": f.session })).status, 200);
  assert.equal((await nd.call("GET", "/v1/quota", undefined, nc.session)).json.error.code, "device_revoked");
});

// 第 72 批（D-305）：原“发了成员邀请即悄悄转回团队租户”取消——个人工作室发邀请回 409 upgrade_required，类型不变；
// 显式就地升级后才是团队；团队把成员电脑策略设为 approve（D-304 缺省 auto）时，新电脑仍回到 needs_device_join、自动登记接口拒绝
test("团队租户仍须批准：个人工作室发邀请 409 upgrade_required（不再悄悄转团队）；升级为团队且策略 approve 后新电脑回到 needs_device_join，自动登记接口拒绝", async () => {
  const f = await signupFounder("p2@example.cn", "孙律师团队");
  const inv0 = await f.dev.call("POST", "/v1/invitations", { member_slug: "zhou", name: "周律师", role: "lawyer" }, f.session);
  assert.deepEqual([inv0.status, inv0.json.error.code], [409, "upgrade_required"]);
  assert.equal(cp.ops.tenant(f.tid)!.kind, "personal", "发邀请不再改类型");
  assert.equal((await post("/v1/workspace/upgrade", { name: "孙律师团队" }, { "x-kwl-session": f.session })).status, 200);
  const pol = await fetch(`${base}/v1/firm/policy/member-device`, { method: "PUT", headers: { "content-type": "application/json", "x-kwl-session": f.session }, body: JSON.stringify({ policy: "approve" }) });
  assert.equal(pol.status, 200);
  const inv = await f.dev.call("POST", "/v1/invitations", { member_slug: "zhou", name: "周律师", role: "lawyer" }, f.session);
  assert.equal(inv.status, 200, JSON.stringify(inv.json));
  cp.ops.account("p2@example.cn")!.device_limit = 2;
  const nc = await newComputer("p2@example.cn");
  assert.equal(nc.onb.state, "needs_device_join");
  assert.equal(cp.ops.tenant(f.tid)!.personal, false);
  const r = await nc.enroll(`${f.dev.cert.deviceId}_D2`);
  assert.equal(r.json.error.code, "device_auto_unavailable");
});

test("第 68 批（D-295）电脑数上限按云端配置：满了 device_limit（带已登记的电脑）、登记接口同样拒绝；刚登录的新电脑会话可不输密码就地移除一台，再经 /v1/auth/onboarding 继续登记", async () => {
  const f = await signupFounder("p3@example.cn", "李律师工作室");
  const t = cp.ops.tenant(f.tid)!;
  cp.ops.account("p3@example.cn")!.device_limit = 2;
  // 第二台：登记成功
  const n2 = await newComputer("p3@example.cn");
  assert.equal(n2.onb.state, "needs_device_auto");
  assert.equal((await n2.enroll()).status, 200);
  // 第三台：登录即“已满”，列出两台已登记的电脑；没有 device_id、不能登记
  const n3 = await newComputer("p3@example.cn");
  assert.equal(n3.onb.state, "device_limit", JSON.stringify(n3.onb));
  assert.equal(n3.onb.device_limit, 2);
  assert.deepEqual(n3.onb.devices.map((d: any) => d.device_id).sort(), [f.dev.cert.deviceId, `${f.dev.cert.deviceId}_D2`].sort());
  // 绕过登录应答直接登记：同样拒绝（不再自动吊销最久未用的一台）
  const forced = await n3.enroll(`${f.dev.cert.deviceId}_D3`);
  assert.equal(forced.status, 409);
  assert.equal(forced.json.error.code, "device_limit");
  assert.equal(forced.json.error.devices.length, 2);
  assert.equal([...t.devices.values()].filter((d) => !d.revoked_at).length, 2, "没有自动移除任何一台");
  // 就地移除：这次登录的会话（10 分钟内、还没绑电脑）不输密码即可移除本账号的一台
  const un = await post(`/v1/auth/devices/${f.dev.cert.deviceId}_D2/unbind`, {}, { "x-kwl-session": n3.session });
  assert.equal(un.status, 200, JSON.stringify(un.json));
  assert.ok(t.devices.get(`${f.dev.cert.deviceId}_D2`)!.revoked_at);
  // 再取一次“这台电脑该做什么”：可登记了（编号不复用吊销过的）
  const ob = await post("/v1/auth/onboarding", {}, { "x-kwl-session": n3.session });
  assert.equal(ob.status, 200, JSON.stringify(ob.json));
  assert.equal(ob.json.onboarding.state, "needs_device_auto");
  assert.equal(ob.json.onboarding.device_id, `${f.dev.cert.deviceId}_D3`);
  assert.equal(ob.json.account.member_slug, f.slug);
  const proof = sign(null, deviceEnrollProofBytes({ tid: f.tid, aid: n3.li.json.account.aid, sid: n3.li.json.session.sid, deviceId: ob.json.onboarding.device_id, signPublicKeyPem: n3.k.signPublicKeyPem, encPublicKeyPem: n3.k.encPublicKeyPem }), n3.k.signPrivateKeyPem).toString("base64url");
  const en = await post("/v1/auth/devices/enroll", { device_id: ob.json.onboarding.device_id, sign_pub: n3.k.signPublicKeyPem, enc_pub: n3.k.encPublicKeyPem, proof }, { "x-kwl-session": n3.session });
  assert.equal(en.status, 200, JSON.stringify(en.json));
  // 已绑电脑的会话：移除别的电脑要密码（不计密码错误次数）；/v1/auth/onboarding 也不再给
  assert.equal((await post(`/v1/auth/devices/${f.dev.cert.deviceId}/unbind`, {}, { "x-kwl-session": n3.session })).json.error.code, "password_required");
  assert.equal(cp.ops.account("p3@example.cn")!.failed.count, 0);
  assert.equal((await post("/v1/auth/onboarding", {}, { "x-kwl-session": n3.session })).json.error.code, "session_not_enrollable");
  // 网页登录的会话也不能免密移除
  const web = await post("/v1/auth/login", { email: "p3@example.cn", password: PW, client: { platform: "web" } });
  assert.equal((await post(`/v1/auth/devices/${f.dev.cert.deviceId}/unbind`, {}, { "x-kwl-session": web.json.session_token })).json.error.code, "password_required");
  // 安全复核 C-2：免密移除只凭“电脑数已满”那次登录的一次性票据——没满时的新电脑登录不能免密移除；票据用过即没有
  cp.ops.account("p3@example.cn")!.device_limit = 5;
  const n4 = await newComputer("p3@example.cn");
  assert.equal(n4.onb.state, "needs_device_auto");
  assert.equal((await post(`/v1/auth/devices/${f.dev.cert.deviceId}/unbind`, {}, { "x-kwl-session": n4.session })).json.error.code, "password_required");
  cp.ops.account("p3@example.cn")!.device_limit = 2;
  const n5 = await newComputer("p3@example.cn");
  assert.equal(n5.onb.state, "device_limit");
  const live = n5.onb.devices.map((d: any) => d.device_id) as string[];
  assert.equal((await post(`/v1/auth/devices/${live[0]}/unbind`, {}, { "x-kwl-session": n5.session })).status, 200, "一张票据移一台");
  assert.equal((await post(`/v1/auth/devices/${live[1]}/unbind`, {}, { "x-kwl-session": n5.session })).json.error.code, "password_required", "票据用过即没有");
  // 关口放行新路径
  assert.equal(cpRelayAllowed({ method: "POST", path: "/v1/auth/onboarding", headers: {}, body: "{}" }), null);
});

test("可疑时暂停：24 小时内已自动登记 3 台 → 第 4 台暂停（device_enroll_hold，没绑手机号时 sms_available=false）；1 小时内 3 个以上网段同样暂停", async () => {
  const f = await signupFounder("p4@example.cn", "吴律师工作室");
  cp.ops.account("p4@example.cn")!.device_limit = 9;
  for (let i = 0; i < 3; i++) assert.equal((await (await newComputer("p4@example.cn")).enroll()).status, 200);
  const r = await (await newComputer("p4@example.cn")).enroll();
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, "device_enroll_hold");
  assert.equal(r.json.error.reason, "burst");
  assert.equal(r.json.error.sms_available, false);
  // 短信码但手机号对不上（账号没绑手机号）→ 不放行
  const r2 = await (await newComputer("p4@example.cn", { extra: { phone: "13800138000", sms_code: "123456" } })).enroll();
  assert.equal(r2.json.error.code, "sms_phone_mismatch");
  // 多网段：另一个个人账号，最近 1 小时从两个别的网段登录过
  await signupFounder("p5@example.cn", "郑律师工作室");
  const a5 = cp.ops.account("p5@example.cn")!;
  a5.device_limit = 9;
  const nc = await newComputer("p5@example.cn");
  a5.logins = [...(a5.logins ?? []), { at: new Date().toISOString(), kind: "login", device_id: null, platform: "win32", version: null, net: "10.1.x.x" }, { at: new Date().toISOString(), kind: "login", device_id: null, platform: "win32", version: null, net: "172.16.x.x" }];
  const r3 = await nc.enroll();
  assert.equal(r3.json.error.code, "device_enroll_hold");
  assert.equal(r3.json.error.reason, "multi_region");
  assert.equal(coarseNet("::ffff:203.0.113.9"), "203.0.x.x");
});

test("/v1/quota 追加 personal / own_models / plan 权益（按 uid，不含金额）；/v1/quota/usage 翻页：签名信封 kwl-usage-page、只含本人的行、before 游标、查询串在设备签名之内", async () => {
  const f = await signupFounder("p6@example.cn", "王律师工作室");
  const t = cp.ops.tenant(f.tid)!;
  const sid = t.seatsByUser.get(f.memberId)!.sid;
  const l = await service("/v1/quota/lease", { tid: f.tid, sid, holder: "gw-test", need_estimate: { alias: "legal/k3", input: 20_000, output: 8192 } });
  assert.equal(l.status, 200, JSON.stringify(l.json));
  const at = (ms: number) => new Date(Date.now() - ms).toISOString();
  const rec = (id: string, uid: string, ago: number, input: number) => ({ request_id: id, client_request_id: `c_${id}`, upstream_request_id: `chatcmpl-${id}`, at: at(ago), sid, uid, dev: f.dev.cert.deviceId, alias: "legal/k3", provider: "maas", upstream_model: "kimi-k3.1-pro", stream: true, status: 200, outcome: "ok", usage: { input, cached: 0, output: 1000, reasoning: 0 }, usage_source: "upstream", latency_ms: 1000, attempts: [{ provider: "maas", status: 200, error: null, ms: 1000 }], lease_id: l.json.lease_id });
  const s = await service("/v1/quota/settle", { tid: f.tid, lease_id: l.json.lease_id, holder: "gw-test", records: [rec("kwlgw_b1", f.memberId, 3000, 4000), rec("kwlgw_b2", f.memberId, 2000, 5000), rec("kwlgw_b3", f.memberId, 1000, 6000), rec("kwlgw_b4", `usr_${f.tid.slice(4)}_other`, 500, 9000)], final: true });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const q = await f.dev.call("GET", "/v1/quota", undefined, f.session);
  const v = openEnvelope<any>(q.json, "kwl-quota-view", envKeys());
  assert.ok(v.ok);
  const body = v.ok ? v.body : null;
  // 已有字段不变；追加字段
  for (const k of ["firm", "own", "models", "own_recent", "period", "burst"]) assert.ok(k in body, k);
  assert.ok(body.personal && typeof body.personal.used_ratio === "number");
  assert.equal(body.personal.paused, null);
  assert.ok(body.personal.used_ratio > 0 && body.personal.used_ratio < 1);
  assert.ok(Math.abs(body.personal.used_ratio + body.personal.remaining_ratio - 1) < 0.01 || body.personal.limited_by !== null, JSON.stringify(body.personal));
  assert.deepEqual(body.own_models.map((m: any) => [m.alias, m.requests, m.share]), [["legal/k3", 3, 1]], "按 uid：别人的请求不计入本人按模型");
  assert.ok(!("used" in body.own_models[0]) && !("value_cny" in body.own_models[0]), "不含金额");
  assert.equal(body.plan.period, "month");
  assert.ok(Array.isArray(body.plan.models) && body.plan.models.every((x: unknown) => typeof x === "string"));
  assert.ok("note" in body.plan && "burst" in body.plan);
  // 翻页：每页 2 条，新的在前；只含本人
  const p1 = await f.dev.call("GET", "/v1/quota/usage?limit=2", undefined, f.session);
  const o1 = openEnvelope<any>(p1.json, "kwl-usage-page", envKeys());
  assert.ok(o1.ok, JSON.stringify(p1.json));
  const b1 = o1.ok ? o1.body : null;
  assert.equal(b1.uid, f.memberId);
  assert.deepEqual(b1.rows.map((r: any) => r.tokens_in), [6000, 5000]);
  assert.ok(b1.next_before);
  assert.ok(cpRelayAllowed({ method: "GET", path: `/v1/quota/usage?before=${b1.next_before}&limit=2`, headers: {}, body: "" }) === null, "闸门白名单认内核拼的查询串");
  assert.equal(cpRelayAllowed({ method: "GET", path: "/v1/quota/usage?uid=usr_x&limit=2", headers: {}, body: "" }), "cp_path_not_allowed");
  const p2 = await f.dev.call("GET", `/v1/quota/usage?before=${b1.next_before}&limit=2`, undefined, f.session);
  const o2 = openEnvelope<any>(p2.json, "kwl-usage-page", envKeys());
  assert.ok(o2.ok);
  assert.deepEqual(o2.ok && o2.body.rows.map((r: any) => r.tokens_in), [4000]);
  assert.equal(o2.ok && o2.body.next_before, null);
  assert.ok(o2.ok && !("value_cny" in o2.body.rows[0]) && !("charge" in o2.body.rows[0]), "不含金额");
  // 查询串在设备签名之内：签 limit=2、发 limit=50 → 拒绝
  const raw = signDeviceRequest({ method: "GET", path: "/v1/quota/usage?limit=2", body: "", tid: f.tid, deviceId: f.dev.cert.deviceId, signPrivateKeyPem: f.dev.k.signPrivateKeyPem });
  const forged = await get("/v1/quota/usage?limit=50", { ...raw, "x-kwl-session": f.session });
  assert.equal(forged.status, 401);
});

test("签名者：账号设备证书只签 issuer = account_ca、非 node、≤366 天、签发时刻贴近请求时刻；没有签发钥的签名者没有这项能力", async () => {
  const k = generateDeviceKeys();
  const now = Date.now();
  const req = { certId: "cert_x", memberId: "usr_f_m", deviceId: "dev_f_m_D2", role: "admin" as const, signPublicKeyPem: k.signPublicKeyPem, encPublicKeyPem: k.encPublicKeyPem, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 365 * 86400_000).toISOString(), issuer: "account_ca" as const };
  assert.equal(accountDeviceCertProblem(req, now), null);
  assert.equal(accountDeviceCertProblem({ ...req, role: "node" }, now), "cert_role_not_allowed");
  assert.equal(accountDeviceCertProblem({ ...req, issuer: "firm_root" }, now), "cert_issuer_invalid");
  assert.equal(accountDeviceCertProblem({ ...req, expiresAt: new Date(now + 400 * 86400_000).toISOString() }, now), "cert_validity_out_of_range");
  assert.equal(accountDeviceCertProblem({ ...req, issuedAt: new Date(now - 3600_000).toISOString() }, now), "cert_issued_at_skew");
  assert.equal(accountDeviceCertProblem({ ...req, signature: "x" }, now), "cert_field_not_allowed");
  const s = localSigner(keys);
  const cert = await s.issueAccountDeviceCert!(req, now);
  assert.ok(verifyDeviceCertificate(cert, s.publicKeys().account_device_ca!.public_key_pem).ok);
  assert.equal(localSigner(devControlPlaneKeys()).issueAccountDeviceCert, undefined);
  assert.equal(localSigner(devControlPlaneKeys()).publicKeys().account_device_ca, null);
});
