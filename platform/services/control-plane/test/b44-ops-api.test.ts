/**
 * 第 44 批运营接口（第 46 批起：平台人员会话 + 角色权限）：账号代建 / 停用 / 重置码 / 个人上限、API 路由与价目、金额套餐计费、
 * 逐请求明细查询与导出（CSV 防公式注入）、账单、注册设置、告警确认、总览、系统。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createECDH, sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import { devStaffOf, staffClient } from "./staff-fixture.ts";
import { generateDeviceKeys, generateFirmRoot, issueDeviceCertificate } from "@zr-legal/keys";
import { enrollProofBytes, signDeviceRequest } from "@zr-legal/firm-trust";
import { accountDeviceId, createAuditLog, createControlPlane, devControlPlaneKeys, type ControlPlane } from "../src/index.ts";

// op_1001：客户运营 + 系统管理员（路由、系统设置）；op_1002：只读
const PEOPLE = { op_1001: ["operator", "sysadmin"], op_1002: ["viewer"] } as const;
const SECRET = "b44-ops-test-service-secret-0123456789";
const PW = "Lawyer2026secure";
const KEY_ID = "a1b2c3d4e5f60718";
let cp: ControlPlane;
let base = "";

before(async () => {
  cp = createControlPlane({ keys: devControlPlaneKeys(), serviceSecret: SECRET, auditLog: createAuditLog(), devStaff: devStaffOf({ op_1001: [...PEOPLE.op_1001], op_1002: [...PEOPLE.op_1002] }), routing: { bootstrap: { provider: { base_url: "https://maas.example.test/v1" } }, key_id: KEY_ID } });
  await new Promise<void>((r) => cp.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(cp.server.address() as AddressInfo).port}`;
});
after(async () => {
  cp.server.closeAllConnections();
  await new Promise<void>((r) => cp.server.close(() => r()));
});

const ops = staffClient(() => base);
const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as any };
};
const service = (path: string, body: unknown) => post(path, body, { authorization: `Bearer ${SECRET}` });
const sealed = () => {
  const e = createECDH("prime256v1");
  e.generateKeys();
  return { alg: "ECDH-P256+HKDF-SHA256+A256GCM", kid: KEY_ID, epk: e.getPublicKey().toString("base64url"), iv: Buffer.alloc(12, 7).toString("base64url"), ct: Buffer.alloc(40, 9).toString("base64url") };
};

/** 运营开通律所 → 发开通码 → 负责人凭码注册 → 创始开通 → 登记设备。 */
async function opsFirm(tid: string, email: string, plan?: string) {
  assert.equal((await ops("op_1001", "POST", "/v1/ops/tenants", { tid, name: `${tid} 律所`, edition: "team", seats: 3, ...(plan ? { plan } : {}) })).status, 200);
  // 开通码由另一位运营发（职责分离）：这里用进程内能力（运营 HTTP 发码的鉴权另有 ops-routes 用例）
  const code = cp.ops.issueActivationCode(tid, { member: { slug: "boss" } });
  const reg = await post("/v1/auth/register", { email, password: PW, name: "王主任", code: code.code });
  assert.equal(reg.status, 200, JSON.stringify(reg.json));
  assert.equal(reg.json.onboarding.state, "needs_founder_setup");
  const root = generateFirmRoot();
  const ts = Date.now();
  const proof = sign(null, enrollProofBytes(tid, root.publicKeyPem, ts), root.privateKeyPem).toString("base64url");
  assert.equal((await post("/v1/enroll", { tid, root_public_key_pem: root.publicKeyPem, ts, proof, activation_id: reg.json.onboarding.claim.activation_id, claim_secret: reg.json.onboarding.claim.claim_secret })).status, 200);
  const k = generateDeviceKeys();
  const memberId = `usr_${tid.slice(4)}_boss`;
  const deviceId = accountDeviceId(tid.slice(4), "boss", 1);
  const cert = issueDeviceCertificate(root.privateKeyPem, { certId: `c_${tid}`, memberId, deviceId, role: "admin", signPublicKeyPem: k.signPublicKeyPem, encPublicKeyPem: k.encPublicKeyPem, issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 86400_000 * 365).toISOString() });
  const raw = JSON.stringify({ tid, cert });
  const h = signDeviceRequest({ method: "POST", path: "/v1/devices/register", body: raw, tid, deviceId, signPrivateKeyPem: k.signPrivateKeyPem });
  assert.equal((await fetch(`${base}/v1/devices/register`, { method: "POST", headers: { ...h, "content-type": "application/json", "x-kwl-session": reg.json.session_token }, body: raw })).status, 200);
  const sid = cp.ops.tenant(tid)!.seatsByUser.get(memberId)!.sid;
  return { tid, memberId, deviceId, sid, session: reg.json.session_token as string, aid: reg.json.account.aid as string };
}

const record = (id: string, f: { sid: string; memberId: string; deviceId: string }, lease: string, u: { input: number; cached: number; output: number }, extra: Record<string, unknown> = {}) => ({ request_id: id, client_request_id: `=cmd|${id}`, upstream_request_id: null, at: new Date().toISOString(), sid: f.sid, uid: f.memberId, dev: f.deviceId, alias: "legal/k3", provider: "maas", upstream_model: "kimi-k3.1-pro", stream: true, status: 200, outcome: "ok", usage: { ...u, reasoning: 0 }, usage_source: "upstream", latency_ms: 1500, attempts: [], lease_id: lease, ...extra });

test("账号：运营代建（设置码只显示一次）→ 本人设密码登录；停用 / 启用；重置码吊销全部会话；个人上限与设备数；只读运营不能改", async () => {
  const f = await opsFirm("ten_accfirm", "boss@accfirm.cn");
  const created = await ops("op_1001", "POST", "/v1/ops/accounts", { tid: f.tid, email: "Lawyer.Li@AccFirm.cn", name: "李律师", role: "lawyer" });
  assert.equal(created.status, 200, created.text);
  assert.match(created.json.setup_code, /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  const aid = created.json.account.aid;
  assert.equal(created.json.account.email, "lawyer.li@accfirm.cn");
  assert.equal(created.json.account.has_password, false);
  // 没设密码前登录给出提示
  assert.match((await post("/v1/auth/login", { email: "lawyer.li@accfirm.cn", password: PW })).json.error.message, /设置码/);
  assert.equal((await post("/v1/auth/password-reset/confirm", { email: "lawyer.li@accfirm.cn", code: created.json.setup_code, password: PW })).status, 200);
  const li = await post("/v1/auth/login", { email: "lawyer.li@accfirm.cn", password: PW, client: { platform: "win32" } });
  assert.equal(li.status, 200);
  assert.equal(li.json.onboarding.state, "needs_device_join", "成员新电脑：等本所管理员设备批准");
  // 设置码只能用一次
  assert.equal((await post("/v1/auth/password-reset/confirm", { email: "lawyer.li@accfirm.cn", code: created.json.setup_code, password: "Another2026pass" })).json.error.code, "code_invalid");
  // 列表与详情
  const list = await ops("op_1002", "GET", `/v1/ops/accounts?${new URLSearchParams({ q: "accfirm" })}`);
  assert.equal(list.status, 200);
  assert.equal(list.json.accounts.length, 2);
  const detail = await ops("op_1002", "GET", `/v1/ops/accounts/${aid}`);
  assert.equal(detail.json.sessions.length, 1);
  // 只读运营不能停用
  assert.equal((await ops("op_1002", "POST", `/v1/ops/accounts/${aid}/disable`, { reason: "x" })).json.error.code, "perm_denied");
  const dis = await ops("op_1001", "POST", `/v1/ops/accounts/${aid}/disable`, { reason: "离职" });
  assert.deepEqual([dis.status, dis.json.sessions_revoked], [200, 1]);
  assert.equal((await post("/v1/auth/login", { email: "lawyer.li@accfirm.cn", password: PW })).json.error.code, "account_disabled");
  assert.equal((await ops("op_1001", "POST", `/v1/ops/accounts/${aid}/enable`)).status, 200);
  const li2 = await post("/v1/auth/login", { email: "lawyer.li@accfirm.cn", password: PW });
  assert.equal(li2.status, 200);
  const rc = await ops("op_1001", "POST", `/v1/ops/accounts/${aid}/reset-code`);
  assert.equal(rc.json.purpose, "reset");
  assert.equal((await post("/v1/auth/password-reset/confirm", { email: "lawyer.li@accfirm.cn", code: rc.json.reset_code, password: "Reset2026Password" })).status, 200);
  assert.equal((await fetch(`${base}/v1/auth/me`, { headers: { "x-kwl-session": li2.json.session_token } })).status, 401, "重置密码吊销全部会话");
  // 个人上限（tokens 套餐须为整数）与设备数
  assert.equal((await ops("op_1001", "POST", `/v1/ops/accounts/${aid}/limits`, { quota_limit: 1.5 })).json.error.code, "quota_limit_invalid");
  const lim = await ops("op_1001", "POST", `/v1/ops/accounts/${aid}/limits`, { quota_limit: 2_000_000, device_limit: 3 });
  assert.deepEqual([lim.json.account.quota_limit, lim.json.account.device_limit], [2_000_000, 3]);
  // 律所可见流水里账号操作的执行者是运营编号、目标是账号编号（不记邮箱）
  const devs = await ops("op_1002", "GET", `/v1/ops/devices?${new URLSearchParams({ tid: f.tid })}`);
  assert.equal(devs.json.devices.length, 1);
  assert.equal(devs.json.devices[0].email, "boss@accfirm.cn");
});

test("API 路由：上游密钥只收控制台加密的密文（公钥编号须相符）；跨厂商切换须显式打开；内置别名不可删；被引用的上游不可删；价目版本递增；只读运营只能看", async () => {
  const v0 = await ops("op_1002", "GET", "/v1/ops/routing");
  assert.equal(v0.status, 200);
  assert.equal(v0.json.routing_key_id, KEY_ID);
  assert.equal(v0.json.providers[0].use_local_key, true);
  assert.equal(JSON.stringify(v0.json).includes("key_sealed"), false, "运营视图不回密文");
  assert.equal((await ops("op_1002", "PUT", "/v1/ops/routing/providers/maas-b", { label: "备用", vendor: "csi-maas", base_url: "https://maas-b.example.test/v1" })).json.error.code, "perm_denied");
  assert.equal((await ops("op_1001", "PUT", "/v1/ops/routing/providers/maas-b", { label: "备用", vendor: "csi-maas", base_url: "http://maas-b.example.test/v1" })).json.error.code, "provider_base_url_invalid");
  assert.equal((await ops("op_1001", "PUT", "/v1/ops/routing/providers/maas-b", { label: "备用", vendor: "csi-maas", base_url: "https://maas-b.example.test/v1", key_sealed: { ...sealed(), kid: "ffffffffffffffff" }, key_hint: "…abcd" })).json.error.code, "provider_key_kid_mismatch");
  const up = await ops("op_1001", "PUT", "/v1/ops/routing/providers/maas-b", { label: "备用", vendor: "csi-maas", base_url: "https://maas-b.example.test/v1", key_sealed: sealed(), key_hint: "…abcd", max_concurrency: 32 });
  assert.equal(up.status, 200, up.text);
  assert.equal(up.json.created, true);
  const pb = up.json.routing.providers.find((x: any) => x.id === "maas-b");
  assert.deepEqual([pb.key_set, pb.key_hint, pb.max_concurrency], [true, "…abcd", 32]);
  // 同厂商两目标：可以；第三个目标属另一厂商、没开跨厂商：拒绝
  assert.equal((await ops("op_1001", "PUT", "/v1/ops/routing/providers/other", { label: "别家", vendor: "other-ai", base_url: "https://api.other.test/v1", use_local_key: false })).status, 200);
  const enc = encodeURIComponent("legal/k3");
  const m1 = await ops("op_1001", "PUT", `/v1/ops/routing/models/${enc}`, { targets: [{ provider: "maas", model: "kimi-k3.1-pro", priority: 1 }, { provider: "maas-b", model: "kimi-k3.1-pro-highspeed", priority: 2 }] });
  assert.equal(m1.status, 200, m1.text);
  assert.equal((await ops("op_1001", "PUT", `/v1/ops/routing/models/${enc}`, { targets: [{ provider: "maas", model: "kimi-k3.1-pro" }, { provider: "other", model: "x-1" }] })).json.error.code, "cross_vendor_not_allowed");
  assert.equal((await ops("op_1001", "DELETE", `/v1/ops/routing/models/${enc}`)).json.error.code, "builtin_alias");
  assert.equal((await ops("op_1001", "DELETE", "/v1/ops/routing/providers/maas-b")).json.error.code, "provider_in_use");
  assert.equal((await ops("op_1001", "DELETE", "/v1/ops/routing/providers/other")).status, 200);
  const pr = await ops("op_1001", "PUT", "/v1/ops/routing/prices", { items: { "legal/k3": { input: 4, cached_input: 1, output: 16, cost_input: 2, cost_cached_input: 0.5, cost_output: 8 } } });
  assert.equal(pr.status, 200, pr.text);
  assert.equal(pr.json.version, 2);
  assert.equal((await ops("op_1001", "PUT", "/v1/ops/routing/prices", { items: { "legal/k3": { input: -1 } } })).json.error.code, "prices_invalid");
  const probe = await ops("op_1001", "POST", "/v1/ops/routing/providers/maas/probe");
  assert.equal(probe.status, 200);
});

test("金额套餐：未定价 → 领租约 503；定价后按“未缓存输入 / 缓存输入 / 输出”三档计售价与成本；明细、汇总、账单、CSV（防公式注入）都从同一份账本出", async () => {
  // 先把价目清掉再建金额套餐
  assert.equal((await ops("op_1001", "PUT", "/v1/ops/routing/prices", { items: {} })).status, 200);
  const plan = await ops("op_1001", "PUT", "/v1/ops/plans/cny-std", { label: "金额标准", quota_unit: "cny", seat_quota: 200, period: "month", seat_price_cny: 399, alert_thresholds: [50, 80, 100] });
  assert.equal(plan.status, 200, plan.text);
  const f = await opsFirm("ten_cnyfirm", "boss@cnyfirm.cn", "cny-std");
  const lease = () => service("/v1/quota/lease", { tid: f.tid, sid: f.sid, holder: "gw-cny", need_estimate: { alias: "legal/k3", input: 100_000, output: 8192 } });
  const l0 = await lease();
  assert.deepEqual([l0.status, l0.json.error.code], [503, "price_unconfigured"]);
  assert.equal((await ops("op_1001", "PUT", "/v1/ops/routing/prices", { items: { "legal/k3": { input: 4, cached_input: 1, output: 16, cost_input: 2, cost_cached_input: 0.5, cost_output: 8 } } })).status, 200);
  const l1 = await lease();
  assert.equal(l1.status, 200, JSON.stringify(l1.json));
  assert.equal(l1.json.unit, "cny");
  // 50 万输入（其中 20 万缓存）+ 2 万输出：售价 = 30万×4 + 20万×1 + 2万×16 = 1.2 + 0.2 + 0.32 = 1.72 元；成本 0.86 元
  const s = await service("/v1/quota/settle", { tid: f.tid, lease_id: l1.json.lease_id, holder: "gw-cny", records: [record("kwlgw_cny1", f, l1.json.lease_id, { input: 500_000, cached: 200_000, output: 20_000 })], final: true });
  assert.equal(s.json.accepted, 1);
  const recs = await ops("op_1002", "GET", `/v1/ops/usage/records?${new URLSearchParams({ tid: f.tid })}`);
  assert.equal(recs.json.records.length, 1);
  const r = recs.json.records[0];
  assert.deepEqual([r.value_cny, r.cost_cny, r.unit, r.charge, r.price_version], [1.72, 0.86, "cny", 1_720_000, recs.json.records[0].price_version]);
  assert.equal(r.email, "boss@cnyfirm.cn");
  const t = await ops("op_1002", "GET", "/v1/ops/tenants/ten_cnyfirm");
  assert.equal(t.json.tenant.unit, "cny");
  assert.equal(t.json.tenant.used, 1.72);
  assert.equal(t.json.tenant.total, 600, "3 席 × 200 元");
  assert.equal(t.json.tenant.used_ratio, Math.round((1.72 / 600) * 10_000) / 10_000);
  const bill = await ops("op_1002", "GET", "/v1/ops/billing");
  const row = bill.json.rows.find((x: any) => x.tid === f.tid);
  assert.deepEqual([row.seat_fee_cny, row.revenue_cny, row.value_cny, row.cost_cny, row.margin_cny], [1197, 1197, 1.72, 0.86, 1196.14]);
  const sum = await ops("op_1002", "GET", `/v1/ops/usage/summary?${new URLSearchParams({ group: "model" })}`);
  assert.ok(sum.json.rows.some((x: any) => x.key === "legal/k3" && x.tokens_in >= 500_000));
  const csvPath = `/v1/ops/usage/records.csv?${new URLSearchParams({ tid: f.tid })}`;
  const rawCsv = await fetch(`${base}${csvPath}`, { headers: { authorization: `Bearer ${await ops.tokenOf("op_1002")}` } });
  assert.match(rawCsv.headers.get("content-type") ?? "", /text\/csv/);
  const bytes = Buffer.from(await rawCsv.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "带 BOM（Excel 认 UTF-8）");
  assert.ok(bytes.toString("utf8").includes("kwlgw_cny1"));
  // 律所名称以 = 开头：导出时加单引号（防 CSV 公式注入）
  assert.equal((await ops("op_1001", "POST", "/v1/ops/tenants", { tid: "ten_evil", name: "=HYPERLINK(1)", edition: "team", seats: 1 })).status, 200);
  const bcsv = await ops("op_1002", "GET", "/v1/ops/billing.csv");
  assert.ok(bcsv.text.includes("ten_cnyfirm"));
  assert.ok(bcsv.text.includes("'=HYPERLINK(1)"), bcsv.text.slice(0, 400));
  // 用到 50%：告警；确认
  const big = await service("/v1/quota/lease", { tid: f.tid, sid: f.sid, holder: "gw-cny", need_estimate: { alias: "legal/k3", input: 10_000, output: 1000 } });
  assert.equal(big.status, 200);
  await service("/v1/quota/settle", { tid: f.tid, lease_id: big.json.lease_id, holder: "gw-cny", records: [record("kwlgw_cny2", f, big.json.lease_id, { input: 60_000_000, cached: 0, output: 5_000_000 })], final: true });
  const al = await ops("op_1002", "GET", "/v1/ops/alerts");
  const hit = al.json.alerts.find((x: any) => x.tid === f.tid && x.kind === "threshold" && x.pct === 50);
  assert.ok(hit, JSON.stringify(al.json.alerts.map((x: any) => [x.kind, x.pct, x.tid])));
  assert.ok(al.json.alerts.some((x: any) => x.tid === f.tid && x.kind === "anomaly"), "1 小时内用掉本期 5% 以上且远超均值：异常告警");
  assert.equal((await ops("op_1002", "POST", `/v1/ops/alerts/${hit.id}/ack`)).status, 200);
  const ov = await ops("op_1002", "GET", "/v1/ops/overview?days=7");
  assert.equal(ov.status, 200);
  assert.equal(ov.json.daily.length, 7);
  assert.ok(ov.json.totals.requests >= 2);
  assert.ok(ov.json.by_model.some((x: any) => x.alias === "legal/k3"));
});

test("注册设置：关闭自助注册后只能凭码注册；改试用套餐；系统页可读", async () => {
  const st = await ops("op_1002", "GET", "/v1/ops/settings");
  assert.equal(st.json.registration, "open");
  assert.equal(st.json.mail.configured, false);
  assert.equal((await ops("op_1001", "PUT", "/v1/ops/settings", { registration: "code" })).status, 200);
  assert.equal((await post("/v1/auth/register", { email: "self@x.cn", password: PW, name: "自助" })).json.error.code, "code_required");
  assert.equal((await ops("op_1001", "PUT", "/v1/ops/settings", { registration: "closed" })).status, 200);
  assert.equal((await post("/v1/auth/register", { email: "self@x.cn", password: PW, name: "自助" })).json.error.code, "registration_closed");
  assert.equal((await ops("op_1001", "PUT", "/v1/ops/settings", { registration: "open", trial_plan: "nope" })).json.error.code, "trial_plan_unknown");
  assert.equal((await ops("op_1001", "PUT", "/v1/ops/settings", { registration: "open" })).status, 200);
  const sys = await ops("op_1002", "GET", "/v1/ops/system");
  assert.equal(sys.status, 200);
  assert.ok(typeof sys.json.usage_book.rows_loaded === "number");
});

test("历史用量补录：升级前网关预写日志的 settle 行（真实 token 数）按请求编号补进账本、重复跑无害；交齐后清掉旧口径冻结比例；新格式行与别家律所的行跳过", async () => {
  const f = await opsFirm("ten_backfill", "boss@backfill.cn");
  const t = cp.ops.tenant(f.tid)!;
  const month = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);
  t.quota.legacy = { period_key: t.quota.period_key, used_ratio: 0.3 };
  const before = (await ops("op_1002", "GET", `/v1/ops/tenants/${f.tid}`)).json.tenant;
  assert.equal(before.legacy_used_ratio, 0.3);
  const at = new Date().toISOString();
  const old = [
    { at, kind: "settle", requestId: "kwlgw_old1", tid: f.tid, sid: f.sid, model: "legal/k3", status: 200, reserved: 40, inputTokens: 90_000, outputTokens: 10_000, cachedTokens: 20_000, latencyMs: 9000, reason: null },
    { at, kind: "settle", requestId: "kwlgw_old2", tid: f.tid, sid: f.sid, model: "legal/k3", status: 504, reserved: 40, inputTokens: null, outputTokens: null, cachedTokens: null, reason: "upstream_header_timeout" },
    { at, kind: "settle", requestId: "kwlgw_new", tid: f.tid, sid: f.sid, record: { request_id: "kwlgw_new" } },
    { at, kind: "settle", requestId: "kwlgw_other", tid: "ten_someone_else", sid: "x", model: "legal/k3", status: 200, inputTokens: 1, outputTokens: 1 },
    { at, kind: "reserve", requestId: "kwlgw_old1", tid: f.tid, sid: f.sid },
  ];
  const r1 = await ops("op_1001", "POST", "/v1/ops/usage/backfill", { tid: f.tid, rows: old });
  assert.equal(r1.status, 200, r1.text);
  assert.deepEqual([r1.json.accepted, r1.json.duplicates, r1.json.skipped, r1.json.legacy_cleared], [2, 0, 3, false]);
  const r2 = await ops("op_1001", "POST", "/v1/ops/usage/backfill", { tid: f.tid, rows: old, clear_legacy: true });
  assert.deepEqual([r2.json.accepted, r2.json.duplicates, r2.json.legacy_cleared], [0, 2, true], "重复跑不重复计；交齐后清掉旧口径比例");
  assert.equal(r2.json.tenant.legacy_used_ratio, null);
  assert.equal(r2.json.tenant.used, 100_000, "按补录的真实 token 计（超时那条没有 usage，不计）");
  const recs = await ops("op_1002", "GET", `/v1/ops/usage/records?${new URLSearchParams({ tid: f.tid })}`);
  const b1 = recs.json.records.find((x: any) => x.request_id === "kwlgw_old1");
  assert.deepEqual([b1.backfill, b1.uid, b1.usage.cached, b1.outcome], [true, f.memberId, 20_000, "ok"]);
  assert.equal(recs.json.records.find((x: any) => x.request_id === "kwlgw_old2").outcome, "timeout");
  assert.equal((await ops("op_1002", "POST", "/v1/ops/usage/backfill", { tid: f.tid, rows: [] })).json.error.code, "perm_denied", "补录须 plan.manage");
  void month;
});
