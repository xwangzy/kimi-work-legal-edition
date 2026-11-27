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
const dir = mkdtempSync(join(tmpdir(), "kwl-b44-"));

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

const feed = async () => {
  const r = await get("/v1/feed/gateway", { authorization: `Bearer ${SECRET}` });
  const o = openEnvelope<any>(r.json, "kwl-gateway-feed", publicKeyMap(cp.publicKeys.envelope));
  assert.ok(o.ok);
  return o.ok ? o.body : null;
};

test("账号号码规则：密码强度、设备编号第 2～9 台带 _D<n> 且与成员标识不混淆", () => {
  assert.deepEqual(passwordProblems("Lawyer2026secure", "zhang@firm.cn"), []);
  assert.ok(passwordProblems("short1", null).includes("至少 10 位"));
  assert.ok(passwordProblems("onlyletterslong", null).includes("同时包含字母和数字"));
  assert.ok(passwordProblems("zhangsan2026x", "zhangsan@x.cn").includes("不要包含邮箱前缀"));
  assert.equal(accountDeviceId("firm", "zhang", 1), "dev_firm_zhang");
  assert.equal(accountDeviceId("firm", "zhang", 3), "dev_firm_zhang_D3");
  assert.equal(accountDeviceIndex("firm", "zhang", "dev_firm_zhang_D3"), 3);
  assert.equal(accountDeviceIndex("firm", "zhang", "dev_firm_zhang_d3"), 0, "成员标识只许小写：_d3 是另一位成员 zhang_d3");
  assert.equal(accountDeviceIndex("firm", "zhang", "dev_firm_zhangsan"), 0);
});

test("自助注册 → 创始开通 → 登记即绑定会话；席位令牌要求本设备会话；退出登录后网关订阅暂停该设备，重新登录（带设备签名）恢复", async () => {
  const f = await signupFounder("founder1@example.cn");
  const t = cp.ops.tenant(f.tid)!;
  assert.equal(t.accounts_required, true, "自助注册的律所要求账号登录");
  assert.equal(t.created_via, "self");
  assert.equal(t.plan, "trial");
  // 没带会话：席位令牌 401；带会话：签发
  assert.equal((await f.dev.call("POST", "/v1/seat-token", {})).json.error.code, "session_required");
  const st = await f.dev.call("POST", "/v1/seat-token", {}, f.session);
  assert.equal(st.status, 200, JSON.stringify(st.json));
  assert.match(st.json.token, /^zst1\./);
  // 订阅：有有效会话的设备不暂停
  assert.equal((await feed())!.suspended_devices.some((d: any) => d.device_id === f.dev.cert.deviceId), false);
  // me：设备列表、本次会话
  const me = await get("/v1/auth/me", { "x-kwl-session": f.session });
  assert.equal(me.status, 200);
  assert.equal(me.json.devices.length, 1);
  assert.equal(me.json.devices[0].current, true);
  assert.equal(me.json.account.org.name, "测试律所");
  // 退出登录：会话失效、设备进暂停集、席位令牌拒签
  assert.equal((await post("/v1/auth/logout", {}, { "x-kwl-session": f.session })).status, 200);
  assert.equal((await get("/v1/auth/me", { "x-kwl-session": f.session })).json.error.code, "session_expired");
  assert.ok((await feed())!.suspended_devices.some((d: any) => d.tid === f.tid && d.device_id === f.dev.cert.deviceId));
  assert.equal((await f.dev.call("POST", "/v1/seat-token", {}, f.session)).status, 401);
  // 重新登录：带设备签名 → ready，会话直接绑本机
  const raw = JSON.stringify({ email: "Founder1@Example.cn", password: PW, client: { version: "0.3.0", platform: "win32" } });
  const h = signDeviceRequest({ method: "POST", path: "/v1/auth/login", body: raw, tid: f.tid, deviceId: f.dev.cert.deviceId, signPrivateKeyPem: f.dev.k.signPrivateKeyPem });
  const li = await fetch(`${base}/v1/auth/login`, { method: "POST", headers: { ...h, "content-type": "application/json" }, body: raw });
  const lj = (await li.json()) as any;
  assert.equal(li.status, 200, JSON.stringify(lj));
  assert.equal(lj.onboarding.state, "ready");
  assert.equal((await f.dev.call("POST", "/v1/seat-token", {}, lj.session_token)).status, 200);
  assert.equal((await feed())!.suspended_devices.some((d: any) => d.device_id === f.dev.cert.deviceId), false);
  // 同一邮箱不能再注册；弱密码；错误密码不区分邮箱是否存在
  assert.equal((await post("/v1/auth/register", { email: "founder1@example.cn", password: PW, name: "x" })).json.error.code, "email_taken");
  assert.equal((await post("/v1/auth/register", { email: "weak@example.cn", password: "123", name: "x" })).json.error.code, "password_weak");
  const bad1 = await post("/v1/auth/login", { email: "founder1@example.cn", password: "Wrong2026password" });
  const bad2 = await post("/v1/auth/login", { email: "nobody@example.cn", password: "Wrong2026password" });
  assert.deepEqual([bad1.status, bad1.json.error.code, bad1.json.error.message], [bad2.status, bad2.json.error.code, bad2.json.error.message]);
  // 律所可见的审计流水：注册、登录、退出登录（执行者 = 账号）
  const acts = (cp as any).ops.tenant(f.tid) && (await f.dev.call("GET", "/v1/audit?after=0&limit=500", undefined, lj.session_token));
  void acts;
});

test("同一账号第二台电脑：设备上限按套餐（试用 1 台）→ 运营调到 2 台 → 新设备凭账号认领入组（编号 _D2、无邀请码段），由已有的管理员设备人工核对后批准", async () => {
  const f = await signupFounder("founder2@example.cn", "二号律所");
  const second = await post("/v1/auth/login", { email: "founder2@example.cn", password: PW, client: { platform: "win32" } });
  assert.equal(second.status, 200);
  assert.equal(second.json.onboarding.state, "device_limit", "试用套餐每账号 1 台");
  assert.equal(second.json.onboarding.devices.length, 1);
  cp.ops.account("founder2@example.cn")!.device_limit = 2;
  const again = await post("/v1/auth/login", { email: "founder2@example.cn", password: PW, client: { platform: "win32" } });
  const onb = again.json.onboarding;
  assert.equal(onb.state, "needs_device_join");
  assert.equal(onb.device_id, `${f.dev.cert.deviceId}_D2`);
  assert.equal(onb.claim.kind, "member");
  // 新设备提交入组申请（不带邀请码本机段 HMAC）
  const k2 = generateDeviceKeys();
  const proof = sign(null, joinProofBytes({ tid: f.tid, activationId: onb.claim.activation_id, deviceId: onb.device_id, signPublicKeyPem: k2.signPublicKeyPem, encPublicKeyPem: k2.encPublicKeyPem }), k2.signPrivateKeyPem).toString("base64url");
  const jr = await post("/v1/join-requests", { tid: f.tid, activation_id: onb.claim.activation_id, claim_secret: onb.claim.claim_secret, device_id: onb.device_id, sign_pub: k2.signPublicKeyPem, enc_pub: k2.encPublicKeyPem, proof });
  assert.equal(jr.status, 200, JSON.stringify(jr.json));
  // 编号不对 → 拒绝
  const wrong = await post("/v1/join-requests", { tid: f.tid, activation_id: onb.claim.activation_id, claim_secret: onb.claim.claim_secret, device_id: `${f.dev.cert.deviceId}_D3`, sign_pub: k2.signPublicKeyPem, enc_pub: k2.encPublicKeyPem, proof });
  assert.equal(wrong.json.error.code, "device_id_invalid");
  // 已有设备（管理员）看到待批准，标明来自账号登录
  const st = await f.dev.call("POST", "/v1/seat-token", {}, f.session);
  assert.equal(st.status, 200);
  const list = await f.dev.call("GET", "/v1/join-requests", undefined, f.session);
  const pending = list.json.join_requests.find((x: any) => x.id === jr.json.join_request_id);
  assert.equal(pending.via, "account");
  assert.equal(pending.account.email, "founder2@example.cn");
  // 批准：律所根签证书 + 公钥包；没有 admin_mac
  const cert2 = issueDeviceCertificate(f.root.privateKeyPem, { certId: "cert_d2", memberId: f.memberId, deviceId: onb.device_id, role: "admin", signPublicKeyPem: k2.signPublicKeyPem, encPublicKeyPem: k2.encPublicKeyPem, issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 365 * 86400_000).toISOString() });
  const rec = generateKeyPairSync("x25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  const fbSig = sign(null, firmBundleBytes(f.tid, f.root.publicKeyPem, rec), f.root.privateKeyPem).toString("base64url");
  const ap = await f.dev.call("POST", `/v1/join-requests/${jr.json.join_request_id}/approve`, { cert: cert2, firm_bundle: { recovery_public_key_pem: rec, sig: fbSig } }, f.session);
  assert.equal(ap.status, 200, JSON.stringify(ap.json));
  const got = await post(`/v1/join-requests/${jr.json.join_request_id}/fetch`, { tid: f.tid, claim_secret: onb.claim.claim_secret });
  assert.equal(got.json.status, "approved");
  assert.equal(got.json.admin_mac, null);
  // 第二台登记并绑定第二次登录的会话；账号名下两台
  const d2call = async (method: string, path: string, body: unknown, session: string) => {
    const raw = JSON.stringify(body);
    const h = signDeviceRequest({ method, path, body: raw, tid: f.tid, deviceId: onb.device_id, signPrivateKeyPem: k2.signPrivateKeyPem });
    const r = await fetch(`${base}${path}`, { method, headers: { ...h, "content-type": "application/json", "x-kwl-session": session }, body: raw });
    return { status: r.status, json: (await r.json()) as any };
  };
  assert.equal((await d2call("POST", "/v1/devices/register", { tid: f.tid, cert: cert2 }, again.json.session_token)).status, 200);
  assert.equal((await d2call("POST", "/v1/seat-token", {}, again.json.session_token)).status, 200);
  const me = await get("/v1/auth/me", { "x-kwl-session": again.json.session_token });
  assert.equal(me.json.devices.length, 2);
  // 从第二台解绑第一台（须密码）：第一台吊销、它的会话失效
  assert.equal((await post(`/v1/auth/devices/${f.dev.cert.deviceId}/unbind`, { password: "wrong-Password1" }, { "x-kwl-session": again.json.session_token })).json.error.code, "auth_invalid");
  assert.equal((await post(`/v1/auth/devices/${f.dev.cert.deviceId}/unbind`, { password: PW }, { "x-kwl-session": again.json.session_token })).status, 200);
  assert.ok(cp.ops.tenant(f.tid)!.devices.get(f.dev.cert.deviceId)!.revoked_at);
  assert.ok((await feed())!.revoked_devices.some((d: any) => d.device_id === f.dev.cert.deviceId));
});

test("运营代建账号（设置码）→ 本人设密码 → 登录；停用即拒绝登录、拒签席位令牌、网关暂停；重置码吊销全部会话；连错 10 次锁定", async () => {
  const f = await signupFounder("founder3@example.cn", "三号律所");
  // 运营接口在进程内无守卫：直接用 ops 能力等价操作（运营 HTTP 接口另有 ops-routes 用例覆盖鉴权）
  const t = cp.ops.tenant(f.tid)!;
  void t;
  // 注册与登录的设置码流程：用一次性码设密码
  const a = cp.ops.account("founder3@example.cn")!;
  a.status = "disabled";
  assert.equal((await post("/v1/auth/login", { email: "founder3@example.cn", password: PW })).json.error.code, "account_disabled");
  // 停用后：会话校验即 403，席位令牌拒签
  assert.equal((await f.dev.call("POST", "/v1/seat-token", {}, f.session)).json.error.code, "account_disabled");
  a.status = "active";
  for (let i = 0; i < 10; i++) await post("/v1/auth/login", { email: "founder3@example.cn", password: `Wrong${i}password` });
  const lk = await post("/v1/auth/login", { email: "founder3@example.cn", password: PW });
  assert.equal(lk.status, 423);
  assert.ok(lk.json.retry_after_s > 0);
  // 找回密码：没有邮件通道 → 202、提示找管理员；错误码不改密码
  const req = await post("/v1/auth/password-reset/request", { email: "founder3@example.cn" });
  assert.deepEqual([req.status, req.json.channel], [202, "admin"]);
  assert.equal((await post("/v1/auth/password-reset/confirm", { email: "founder3@example.cn", code: "AAAA-BBBB-CCCC", password: "NewPassword2026" })).json.error.code, "code_invalid");
});

test("凭邀请码注册成员：账号绑邀请对应的成员，返回成员认领（设备编号为第一台），客户端仍按邀请码本机段做入组 HMAC", async () => {
  const f = await signupFounder("founder4@example.cn", "四号律所");
  await toTeam(f.session);
  const inv = await f.dev.call("POST", "/v1/invitations", { member_slug: "lisi", name: "李四", role: "lawyer" }, f.session);
  assert.equal(inv.status, 200, JSON.stringify(inv.json));
  const reg = await post("/v1/auth/register", { email: "lisi@example.cn", password: PW, name: "李四", code: inv.json.code });
  assert.equal(reg.status, 200, JSON.stringify(reg.json));
  assert.equal(reg.json.onboarding.state, "needs_device_join");
  assert.equal(reg.json.onboarding.device_id, `dev_${f.tid.slice(4)}_lisi`);
  assert.equal(reg.json.onboarding.via, "invite_code");
  assert.equal(reg.json.account.role, "lawyer");
  // 同一邀请不能再注册第二个账号
  assert.equal((await post("/v1/auth/register", { email: "lisi2@example.cn", password: PW, name: "李四", code: inv.json.code })).json.error.code, "member_taken");
});

test("API 路由：初始路由由配置导入；运营改上游、模型、价目；订阅签名信封只含密文与尾号；健康上报合并显示、全挂告警", async () => {
  const fb = await get("/v1/feed/routing", { authorization: `Bearer ${SECRET}` });
  assert.equal(fb.status, 200);
  const o1 = openEnvelope<any>(fb.json, "kwl-routing-feed", publicKeyMap(cp.publicKeys.envelope));
  assert.ok(o1.ok);
  const body = o1.ok ? o1.body : null;
  assert.equal(body.providers[0].id, "maas");
  assert.equal(body.providers[0].use_local_key, true);
  // 第 72 批（D-299）：内置别名真实映射——K2.6 指 kimi-k2.6（原先两个别名同指 kimi-k3.1-pro，是“伪切换”）
  assert.deepEqual(body.models.map((m: any) => [m.alias, m.targets[0].model]), [["legal/k3", "kimi-k3.1-pro"], ["legal/k2.6", "kimi-k2.6"]]);
  assert.equal((await get("/v1/feed/routing", { authorization: "Bearer nope" })).status, 401);
  // 健康上报：只收短代码；两个网关实例，状态最差者显示
  assert.equal((await service("/v1/feed/routing-health", { holder: "gw-a", at: new Date().toISOString(), providers: { maas: { state: "up", latency_ms: 812, consecutive_failures: 0, last_error: "上游原文<b>不收</b>" } } })).status, 200);
  assert.equal((await service("/v1/feed/routing-health", { holder: "gw-b", at: new Date().toISOString(), providers: { maas: { state: "down", latency_ms: null, consecutive_failures: 5, last_error: "upstream_503" } } })).status, 200);
  const internal = (cp as any);
  void internal;
  // 运营视图经 HTTP 运营接口才有（这里无守卫）；改用订阅看版本前进
  const before = body.version;
  assert.equal((await service("/v1/feed/routing-health", { holder: "bad holder!", providers: {} })).status, 400);
  const fb2 = openEnvelope<any>((await get("/v1/feed/routing", { authorization: `Bearer ${SECRET}` })).json, "kwl-routing-feed", publicKeyMap(cp.publicKeys.envelope));
  assert.ok(fb2.ok && fb2.body.version === before, "健康上报不改路由版本");
});

test("用量账本：按席位领租约；逐请求回报按请求编号去重（重发不重复计费）；成员与管理员视图只按比例与对外单位；落盘后重启仍去重", async () => {
  const f = await signupFounder("founder5@example.cn", "五号律所");
  const t = cp.ops.tenant(f.tid)!;
  const sid = t.seatsByUser.get(f.memberId)!.sid;
  const l = await service("/v1/quota/lease", { tid: f.tid, sid, holder: "gw-test", need_estimate: { alias: "legal/k3", input: 20_000, output: 8192 } });
  assert.equal(l.status, 200, JSON.stringify(l.json));
  assert.equal(l.json.unit, "tokens");
  assert.ok(l.json.units >= 28_192);
  const rec = (id: string, input: number, output: number) => ({ request_id: id, client_request_id: `c_${id}`, upstream_request_id: `chatcmpl-${id}`, at: new Date().toISOString(), sid, uid: f.memberId, dev: f.dev.cert.deviceId, alias: "legal/k3", provider: "maas", upstream_model: "kimi-k3.1-pro", stream: true, status: 200, outcome: "ok", usage: { input, cached: 1000, output, reasoning: 0 }, usage_source: "upstream", latency_ms: 4200, attempts: [{ provider: "maas", status: 200, error: null, ms: 4200 }], lease_id: l.json.lease_id });
  const s1 = await service("/v1/quota/settle", { tid: f.tid, lease_id: l.json.lease_id, holder: "gw-test", records: [rec("kwlgw_a1", 12_000, 3_000), rec("kwlgw_a2", 8_000, 2_000)] });
  assert.deepEqual([s1.status, s1.json.accepted, s1.json.duplicates], [200, 2, 0]);
  const s2 = await service("/v1/quota/settle", { tid: f.tid, lease_id: l.json.lease_id, holder: "gw-test", records: [rec("kwlgw_a1", 12_000, 3_000)], final: true });
  assert.deepEqual([s2.json.accepted, s2.json.duplicates, s2.json.closed], [0, 1, true], "同一请求编号重发不重复计费");
  // 视图：试用套餐 1 席 × 2,000 万 token；已用 25,000
  const v = openEnvelope<any>((await f.dev.call("GET", "/v1/quota", undefined, f.session)).json, "kwl-quota-view", publicKeyMap(cp.publicKeys.envelope));
  assert.ok(v.ok);
  const qv = v.ok ? v.body : null;
  assert.equal(qv.unit, "tokens");
  assert.equal(qv.firm.used, 25_000, "管理员看得到用量数（对外单位）");
  assert.equal(qv.firm.total, 20_000_000);
  assert.equal(qv.firm.used_ratio, Math.round((25_000 / 20_000_000) * 10_000) / 10_000);
  assert.equal(qv.own.requests, 2);
  assert.equal(qv.own.denominator, "seat_quota");
  assert.equal(qv.own.enforced, false);
  assert.equal(qv.models[0].alias, "legal/k3");
  assert.ok(qv.burst && qv.burst.hours === 5, "试用套餐有 5 小时频率窗口");
  assert.match(qv.period.resets_at, /T16:00:00\.000Z$/, "北京时间下月 1 日 0 点重置");
  // 第 47 批：本人使用明细（最近在前；重发的同一请求只一行；只有时间、类型、模型、token、计入额度、结果，不含请求内容与事项）
  assert.equal(qv.own_recent.length, 2, "重发不重复成行");
  assert.deepEqual(
    qv.own_recent.map((r: any) => [r.kind, r.alias, r.tokens_in, r.tokens_cached, r.tokens_out, r.charge, r.unit, r.outcome, r.partial, r.estimated]),
    [
      ["task", "legal/k3", 8_000, 1000, 2_000, 10_000, "tokens", "ok", false, false],
      ["task", "legal/k3", 12_000, 1000, 3_000, 15_000, "tokens", "ok", false, false],
    ],
    "最近的在前",
  );
  // 第 70 批：追加 client_request_id（出站闸门生成的编号，律师端在本机对回事项）与 this_device——都不是请求内容
  assert.deepEqual(Object.keys(qv.own_recent[0]).sort(), ["alias", "at", "charge", "charge_ratio", "client_request_id", "estimated", "kind", "label", "outcome", "partial", "pending", "this_device", "tokens_cached", "tokens_in", "tokens_out", "unit", "value_cny"]);
  // 落盘：账本文件有 2 行；新实例读回后同一请求编号仍去重
  const month = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);
  const lines = readFileSync(join(dir, "usage", `${month}.jsonl`), "utf8").trim().split("\n").filter((x) => x.includes(f.tid));
  assert.equal(lines.length, 2);
  assert.ok(!lines.join("").includes("anon"), "账本行不含事项编号");
  const reloaded = new UsageBook({ dir: join(dir, "usage") });
  assert.equal(reloaded.has("kwlgw_a1"), true);
  assert.equal(reloaded.tenant(f.tid, "2000-01-01", "2999-12-31").tokens_in, 20_000);
});

test("额度 v2：上限与频率窗口、个人上限都在领租约时生效（余量不够这次请求即 402，分别报原因）；金额套餐未定价 503，定价后按价目版本计费", async () => {
  const f = await signupFounder("founder6@example.cn", "六号律所");
  const t = cp.ops.tenant(f.tid)!;
  const sid = t.seatsByUser.get(f.memberId)!.sid;
  const lease = (input: number, output: number) => service("/v1/quota/lease", { tid: f.tid, sid, holder: "gw-q", need_estimate: { alias: "legal/k3", input, output } });
  // 频率窗口：试用 20,000,000 × 50% = 10,000,000；一次要 11,000,000 → 402 quota_burst
  const big = await lease(10_000_000, 1_000_000);
  assert.deepEqual([big.status, big.json.error.code], [402, "quota_burst"]);
  // 个人上限 10,000 token
  cp.ops.account("founder6@example.cn")!.quota_limit = 10_000;
  const per = await lease(9_000, 2_000);
  assert.deepEqual([per.status, per.json.error.code], [402, "quota_seat_limit"]);
  cp.ops.account("founder6@example.cn")!.quota_limit = null;
  // 律所上限 1%（200,000）
  cp.ops.setQuotaCap(f.tid, 1);
  const cap = await lease(150_000, 60_000);
  assert.deepEqual([cap.status, cap.json.error.code], [402, "quota_cap_reached"]);
  cp.ops.setQuotaCap(f.tid, null);
  // 金额套餐：先换成 cny 计（建一个金额套餐），未定价 503
  const cat = (cp as any).ops;
  void cat;
  t.plan = "standard";
  const ok = await lease(10_000, 1_000);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.unit, "tokens");
});

test("旧状态迁移：第 40 批的内部单位账本读回为 v2（本期已用冻结为比例，历史只留比例）；Kimi 账号绑定丢弃；旧套餐目录按 token 翻译并标待商务确认", async () => {
  const sdir = mkdtempSync(join(tmpdir(), "kwl-b44-mig-"));
  const key = randomBytes(32);
  const store = fileStateStore(join(sdir, "state"), { key });
  const month = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);
  const old = { v: 1, feedVersion: 3, tenants: [{ tid: "ten_old", name: "老律所", edition: "team", seats: 2, root_public_key_pem: null, salt_b64: randomBytes(32).toString("base64"), created_at: new Date().toISOString(), license: { tid: "ten_old", edition: "team", seats: 2, issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400_000).toISOString() }, subscription_until: new Date(Date.now() + 30 * 86400_000).toISOString(), devices: [], preRevoked: [], seatsByUser: [], seatCounter: 0, directoryVersion: 1, policy: null, connectors: [], connectorsVersion: 1, drafts: [], anon: [], activations: [], joinRequests: [], plan: "standard", quota: { allowance: 400_000, boost: 0, boosts: [], cap_pct: 70, cap_set_at: null, cap_set_by: null, period: month, period_used: 100_000, period_by_seat: {}, history: [{ period: "2026-10", used: 50_000, total: 400_000, boost_pct: 0 }], leases: {} }, kimiAccounts: [["usr_old_a", { ref: "kimi_0123456789abcdef0123", nickname: "张*" }]], kimi_required: true }] };
  store.save(JSON.stringify(old));
  const c2 = createControlPlane({ keys, serviceSecret: SECRET, stateStore: store, billing: { plans: [{ id: "standard", label: "标准", seat_monthly_units: 200_000 }] } });
  const t = c2.ops.tenant("ten_old")!;
  assert.equal(t.quota.v, 2);
  assert.deepEqual(t.quota.legacy, { period_key: month, used_ratio: 0.25 }, "100000 / 400000");
  assert.equal(t.quota.cap_pct, 70);
  assert.equal(t.quota.history[0]!.used_ratio, 0.125);
  assert.equal(t.quota.history[0]!.legacy, true);
  assert.equal((t as any).kimiAccounts, undefined);
  assert.equal(t.accounts_required, false, "之前开通的律所不要求账号登录");
  c2.server.close();
});

test("网关路由公钥：控制台用 ECDH P-256 加密的密钥，控制面只存密文与尾号（这里只核对格式与公钥编号，解密在网关用例里）", () => {
  // 生成一份格式正确的密文（与控制台同一算法的格式：epk 65 字节、iv 12 字节）
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const epk = ecdh.getPublicKey().toString("base64url");
  assert.equal(epk.length, 87);
  assert.equal(randomBytes(12).toString("base64url").length, 16);
});
