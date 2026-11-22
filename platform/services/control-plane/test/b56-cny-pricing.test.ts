/**
 * 第 56 批（D-222）：按金额计费的配置闭环与计量口径。
 *
 * 缺陷（改前）：①系统管理员没有 plan.manage、客户运营没有改价目的权限——一个人配不完一个按金额计费的套餐（控制台“保存套餐”点不动）；
 * ②金额套餐可以在模型没有售价时保存，用它的律所每次调用都被 503 price_unconfigured 拒绝；③价目可以撤到让在用的金额套餐失去售价；
 * ④b44-accounts-routing-ledger 里那条标题写着“金额套餐未定价 503，定价后按价目版本计费”的用例，正文并没有走金额套餐（把套餐设回了
 *   standard）；金额计量此前只有 b44-ops-api 一条用例、一种价目版本、没有“旧请求按旧版本”“缓存价留空”的对账。
 *
 * 这里走完整链路：定价 → 建金额套餐 → 律所换套餐 → 领租约 → 逐请求结算 → 额度视图 / 账单，逐项与手算对账：
 * 金额（微元）= (输入 − 缓存命中) × 未命中价 + 缓存命中 × 缓存价 + 输出 × 输出价；缓存价不填按未命中价；旧请求按当时的价目版本。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDeviceKeys, generateFirmRoot, issueDeviceCertificate } from "@zr-legal/keys";
import { enrollProofBytes, openEnvelope, publicKeyMap, signDeviceRequest } from "@zr-legal/firm-trust";
import { accountDeviceId, createControlPlane, devControlPlaneKeys, fileStateStore, UsageBook, type ControlPlane } from "../src/index.ts";
import { permsOf, DANGER_PERMISSIONS } from "../src/rbac.ts";
import { unpricedAliases } from "../src/routing.ts";
import { call, devStaffOf, staffClient, staffEmail, staffToken } from "./staff-fixture.ts";

const SECRET = "b56-pricing-service-secret-0123456789ab";
const PW = "Lawyer2026secure";
let cp: ControlPlane;
let base = "";
const ops = staffClient(() => base);

before(async () => {
  cp = createControlPlane({
    keys: devControlPlaneKeys(),
    serviceSecret: SECRET,
    usageBook: new UsageBook({ dir: join(mkdtempSync(join(tmpdir(), "kwl-b56-")), "usage") }),
    // 带状态落盘（与生产同）：出错的请求会把内存回滚到上次写成的状态——“最近被拒”要能留下来，见最后一条用例
    stateStore: fileStateStore(join(mkdtempSync(join(tmpdir(), "kwl-b56-state-")), "state")),
    devStaff: devStaffOf({ sys_1: ["sysadmin"], op_1: ["operator"], fin_1: ["finance"] }),
    routing: { bootstrap: { provider: { base_url: "https://maas.example.test/v1" } }, key_id: "0123456789abcdef" },
  });
  await new Promise<void>((r) => cp.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(cp.server.address() as AddressInfo).port}`;
});
after(async () => {
  cp.server.closeAllConnections();
  await new Promise<void>((r) => cp.server.close(() => r()));
});

const service = (path: string, body: unknown) => call(base, "POST", path, body, { authorization: `Bearer ${SECRET}` });

/** 自助注册一个律所并登记创始设备（与 b44 用例同一流程）。 */
async function founder(email: string, org: string) {
  const reg = await call(base, "POST", "/v1/auth/register", { email, password: PW, name: "张律师", org_name: org, client: { version: "0.3.0", platform: "win32" } });
  assert.equal(reg.status, 200, reg.text);
  const onb = reg.json.onboarding;
  const tid = onb.claim.tid as string;
  const root = generateFirmRoot();
  const ts = Date.now();
  const proof = sign(null, enrollProofBytes(tid, root.publicKeyPem, ts), root.privateKeyPem).toString("base64url");
  assert.equal((await call(base, "POST", "/v1/enroll", { tid, root_public_key_pem: root.publicKeyPem, ts, proof, activation_id: onb.claim.activation_id, claim_secret: onb.claim.claim_secret })).status, 200);
  const memberId = `usr_${tid.slice(4)}_${onb.member.slug}`;
  const deviceId = accountDeviceId(tid.slice(4), onb.member.slug, 1);
  const k = generateDeviceKeys();
  const cert = issueDeviceCertificate(root.privateKeyPem, { certId: `cert_${deviceId}`, memberId, deviceId, role: "admin", signPublicKeyPem: k.signPublicKeyPem, encPublicKeyPem: k.encPublicKeyPem, issuedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 365 * 86400_000).toISOString() });
  const dev = async (method: string, path: string, body?: unknown) => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const h = signDeviceRequest({ method, path, body: raw, tid, deviceId, signPrivateKeyPem: k.signPrivateKeyPem });
    return call(base, method, path, body, { ...h, "x-kwl-session": reg.json.session_token });
  };
  assert.equal((await dev("POST", "/v1/devices/register", { tid, cert })).status, 200);
  const sid = cp.ops.tenant(tid)!.seatsByUser.get(memberId)!.sid;
  const quota = async () => {
    const v = openEnvelope<any>((await dev("GET", "/v1/quota")).json, "kwl-quota-view", publicKeyMap(cp.publicKeys.envelope));
    assert.ok(v.ok);
    return v.ok ? v.body : null;
  };
  return { tid, memberId, deviceId, sid, quota };
}

test("权限：系统管理员能存套餐、系统管理员与客户运营都能改价目（须复核），财务都不能；改价目是敏感操作", async () => {
  assert.ok(permsOf(["sysadmin"]).includes("plan.manage") && permsOf(["sysadmin"]).includes("price.manage"));
  assert.ok(permsOf(["operator"]).includes("plan.manage") && permsOf(["operator"]).includes("price.manage"));
  assert.ok(!permsOf(["finance"]).includes("price.manage") && !permsOf(["issuer"]).includes("price.manage"));
  assert.ok(DANGER_PERMISSIONS.has("price.manage"));
  // 系统管理员存一个 token 套餐：改前 403
  const p = await ops("sys_1", "PUT", "/v1/ops/plans/b56-tokens", { label: "按量", quota_unit: "tokens", seat_quota: 1_000_000 });
  assert.equal(p.status, 200, p.text);
  assert.equal((await ops("fin_1", "PUT", "/v1/ops/plans/b56-x", { label: "财务不能建", quota_unit: "tokens", seat_quota: 1 })).status, 403);
  assert.equal((await ops("fin_1", "PUT", "/v1/ops/routing/prices", { items: {} })).status, 403);
  // 没复核过的会话改价目：401 reauth_required
  const fresh = await staffToken(base, staffEmail("op_1"), { reauth: false });
  const r = await call(base, "PUT", "/v1/ops/routing/prices", { items: {} }, { authorization: `Bearer ${fresh}` });
  assert.deepEqual([r.status, r.json?.error?.code], [401, "reauth_required"]);
});

test("金额套餐必须先定价：缺未命中输入价或输出价 409，列出缺价的模型；缓存命中价可不填；撤价会让在用的金额套餐失价也 409", async () => {
  const gold = { label: "金额版", quota_unit: "cny", seat_quota: 100, models: ["legal/k3"] };
  const no = await ops("sys_1", "PUT", "/v1/ops/plans/b56-gold", gold);
  assert.deepEqual([no.status, no.json?.error?.code, no.json?.error?.aliases ?? no.json?.aliases], [409, "plan_models_unpriced", ["legal/k3"]], no.text);
  // 只有输入价、没有输出价：仍不行
  assert.equal((await ops("op_1", "PUT", "/v1/ops/routing/prices", { items: { "legal/k3": { input: 4 } } })).status, 200);
  assert.equal((await ops("sys_1", "PUT", "/v1/ops/plans/b56-gold", gold)).json?.error?.code, "plan_models_unpriced");
  // 客户运营定三项售价（元 / 百万 token）：改前 403（要 route.manage）
  const pr = await ops("op_1", "PUT", "/v1/ops/routing/prices", { items: { "legal/k3": { input: 4, cached_input: 1, output: 16, cost_input: 2, cost_cached_input: 0.5, cost_output: 8 } } });
  assert.equal(pr.status, 200, pr.text);
  const ok = await ops("sys_1", "PUT", "/v1/ops/plans/b56-gold", gold);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.plan.quota_unit, "cny");
  // 不限模型（全部启用的别名）的金额套餐：legal/k2.6 还没定价 → 409，列出它
  const all = await ops("sys_1", "PUT", "/v1/ops/plans/b56-all", { label: "金额全模型", quota_unit: "cny", seat_quota: 50 });
  assert.equal(all.status, 409);
  assert.match(all.text, /legal\/k2\.6/);
  assert.doesNotMatch(all.text, /legal\/k3[^.]/, "已定价的不列");
  // 撤掉在用金额套餐的输出价：409，价目版本不变
  const before = (await ops("sys_1", "GET", "/v1/ops/routing")).json.prices.version;
  const drop = await ops("op_1", "PUT", "/v1/ops/routing/prices", { items: { "legal/k3": { input: 4, cached_input: 1 } } });
  assert.deepEqual([drop.status, drop.json?.error?.code], [409, "prices_required_by_plan"], drop.text);
  assert.equal((await ops("sys_1", "GET", "/v1/ops/routing")).json.prices.version, before, "被拒的改价不产生新版本");
  // 缓存命中价留空是允许的
  assert.deepEqual(unpricedAliases({ models: [{ alias: "a/b", enabled: true } as any, { alias: "c/d", enabled: false } as any] }, { "a/b": { input: 1, cached_input: null, output: 2, cost_input: null, cost_cached_input: null, cost_output: null } }, null), []);
});

test("金额计量与手算一致：未命中输入、缓存命中、输出三项分开算；旧请求按当时的价目版本；缓存价不填按未命中价；额度视图与账单同一个数", async () => {
  const f = await founder("b56-founder@example.cn", "五十六号律所");
  const chg = await ops("op_1", "POST", `/v1/ops/tenants/${f.tid}/plan`, { plan: "b56-gold" });
  assert.equal(chg.status, 200, chg.text);
  const v2 = (await ops("sys_1", "GET", "/v1/ops/routing")).json.prices.version as number;
  // 领租约：单位是金额（微元）
  const lease = await service("/v1/quota/lease", { tid: f.tid, sid: f.sid, holder: "gw-b56", need_estimate: { alias: "legal/k3", input: 20_000, output: 8_192 } });
  assert.equal(lease.status, 200, lease.text);
  assert.equal(lease.json.unit, "cny");
  assert.ok(lease.json.units >= 20_000 * 4 + 8_192 * 16, "预占至少覆盖这次请求按未命中价的估算");
  const rec = (id: string, usage: { input: number; cached: number; output: number }, price_version: number) => ({ request_id: id, client_request_id: `c_${id}`, upstream_request_id: `chatcmpl-${id}`, at: new Date().toISOString(), sid: f.sid, uid: f.memberId, dev: f.deviceId, alias: "legal/k3", provider: "maas", upstream_model: "kimi-k3.1-pro", stream: true, status: 200, outcome: "ok", usage: { ...usage, reasoning: 0 }, usage_source: "upstream", latency_ms: 900, attempts: [{ provider: "maas", status: 200, error: null, ms: 900 }], lease_id: lease.json.lease_id, price_version });
  // 第 1 笔（价目 v2：4 / 1 / 16）：(12000−5000)×4 + 5000×1 + 3000×16 = 28000 + 5000 + 48000 = 81,000 微元 = 0.081 元
  const s1 = await service("/v1/quota/settle", { tid: f.tid, lease_id: lease.json.lease_id, holder: "gw-b56", records: [rec("kwlgw_b56_1", { input: 12_000, cached: 5_000, output: 3_000 }, v2)] });
  assert.deepEqual([s1.status, s1.json.accepted], [200, 1], s1.text);
  let q = await f.quota();
  assert.equal(q.unit, "cny");
  assert.equal(q.firm.total, 100, "1 席 × 100 元");
  assert.equal(q.firm.used, 0.081);
  assert.equal(q.own_recent[0].charge, 81_000);
  assert.deepEqual([q.own_recent[0].tokens_in, q.own_recent[0].tokens_cached, q.own_recent[0].tokens_out, q.own_recent[0].value_cny], [12_000, 5_000, 3_000, 0.081]);
  // 涨价（v3：8 / 2 / 20）；缓存价留空的 v4（8 / 空 / 20）
  const v3 = (await ops("op_1", "PUT", "/v1/ops/routing/prices", { items: { "legal/k3": { input: 8, cached_input: 2, output: 20 } } })).json.version as number;
  const v4 = (await ops("op_1", "PUT", "/v1/ops/routing/prices", { items: { "legal/k3": { input: 8, output: 20 } } })).json.version as number;
  assert.deepEqual([v3, v4], [v2 + 1, v2 + 2]);
  // 第 2 笔按 v3：7000×8 + 5000×2 + 3000×20 = 56000 + 10000 + 60000 = 126,000
  // 第 3 笔仍报 v2（涨价前发出的请求晚到）：按 v2 计 81,000，不按新价
  // 第 4 笔按 v4（缓存价留空 → 按未命中价）：7000×8 + 5000×8 + 3000×20 = 156,000
  // 第 5 笔全未命中、无输出（v4）：1000×8 = 8,000；第 6 笔失败请求（无 usage）：不计
  const s2 = await service("/v1/quota/settle", {
    tid: f.tid,
    lease_id: lease.json.lease_id,
    holder: "gw-b56",
    records: [
      rec("kwlgw_b56_2", { input: 12_000, cached: 5_000, output: 3_000 }, v3),
      rec("kwlgw_b56_3", { input: 12_000, cached: 5_000, output: 3_000 }, v2),
      rec("kwlgw_b56_4", { input: 12_000, cached: 5_000, output: 3_000 }, v4),
      rec("kwlgw_b56_5", { input: 1_000, cached: 0, output: 0 }, v4),
      { ...rec("kwlgw_b56_6", { input: 0, cached: 0, output: 0 }, v4), status: 502, outcome: "upstream_error", usage: null },
      rec("kwlgw_b56_1", { input: 12_000, cached: 5_000, output: 3_000 }, v2), // 重发：不重复计
    ],
    final: true,
  });
  assert.deepEqual([s2.status, s2.json.accepted, s2.json.duplicates], [200, 5, 1], s2.text);
  const expectMicro = 81_000 + 126_000 + 81_000 + 156_000 + 8_000;
  q = await f.quota();
  assert.equal(q.firm.used, expectMicro / 1e6, "额度已用 = 五笔手算之和（元）");
  assert.equal(q.firm.used_ratio, Math.round((expectMicro / 1e6 / 100) * 10_000) / 10_000);
  const recs = await ops("fin_1", "GET", `/v1/ops/usage/records?tid=${f.tid}&limit=50`);
  assert.equal(recs.status, 200, recs.text);
  const byId = new Map<string, any>((recs.json.records ?? recs.json.rows ?? []).map((r: any) => [r.request_id, r]));
  assert.deepEqual(["kwlgw_b56_2", "kwlgw_b56_3", "kwlgw_b56_4", "kwlgw_b56_5"].map((k) => byId.get(k)?.value_cny), [0.126, 0.081, 0.156, 0.008], recs.text.slice(0, 400));
  assert.deepEqual(["kwlgw_b56_2", "kwlgw_b56_3", "kwlgw_b56_4"].map((k) => byId.get(k)?.price_version), [v3, v2, v4], "每行记着它用的价目版本");
  // 账单（财务视角）：用量价值与额度视图是同一个数；成本只有 v2 两笔有成本价（2 / 0.5 / 8）：(7000×2 + 5000×0.5 + 3000×8)×2 = 81,000 微元
  const month = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);
  const bill = await ops("fin_1", "GET", `/v1/ops/billing?period=${month}`);
  assert.equal(bill.status, 200, bill.text);
  const row = (bill.json.rows ?? []).find((x: any) => x.tid === f.tid);
  assert.ok(row, bill.text);
  assert.equal(row.value_cny, expectMicro / 1e6);
});

test("暂停状态如实：余量已不够最近被拒的那次请求时视图写“已暂停”（改前要等已用 ≥ 上限才写，律师看到“未暂停”却一直取不到回答）；放宽后自动消失", async () => {
  const f = await founder("b56-paused@example.cn", "五十六号暂停律所");
  const lease = (input: number, output: number) => service("/v1/quota/lease", { tid: f.tid, sid: f.sid, holder: "gw-b56p", need_estimate: { alias: "legal/k3", input, output } });
  // 试用套餐 2,000 万 token；上限 1% = 20 万。一次要 21 万：还没用任何额度，但这次请求发不出
  cp.ops.setQuotaCap(f.tid, 1);
  assert.equal((await f.quota()).firm.paused, null, "没有被拒过：不写暂停");
  const big = await lease(150_000, 60_000);
  assert.deepEqual([big.status, big.json.error.code], [402, "quota_cap_reached"]);
  let q = await f.quota();
  assert.equal(q.firm.paused, "cap", "这次请求发不出：视图如实写暂停（原因：律所上限）");
  assert.equal(q.firm.used_ratio, 0);
  // 管理员取消上限：余量够那次请求了，暂停消失（不需要再发一次请求来“解除”）
  cp.ops.setQuotaCap(f.tid, null);
  assert.equal((await f.quota()).firm.paused, null);
  // 再设回 1%：又不够那次请求 → 仍如实显示；之后一次小请求领到租约 → 清除
  cp.ops.setQuotaCap(f.tid, 1);
  assert.equal((await f.quota()).firm.paused, "cap");
  const small = await lease(10_000, 1_000);
  assert.equal(small.status, 200, small.text);
  assert.equal((await f.quota()).firm.paused, null, "能发出请求了：不再写暂停");
});

test("收紧额度即收回在途租约：调低上限、换套餐后，已发出去的租约不能再用；回报时告诉网关已收回；取消或调高上限不收回", async () => {
  const f = await founder("b56-revoke@example.cn", "五十六号收回律所");
  const lease = (input: number, output: number, holder = "gw-b56r") => service("/v1/quota/lease", { tid: f.tid, sid: f.sid, holder, need_estimate: { alias: "legal/k3", input, output } });
  const l1 = await lease(100_000, 8_192);
  assert.equal(l1.status, 200, l1.text);
  const open = () => Object.values(cp.ops.tenant(f.tid)!.quota.leases).filter((l) => !l.closed_at).length;
  assert.equal(open(), 1);
  // 管理员新设上限 1%（20 万 token）：在途租约立即收回，未用部分释放
  cp.ops.setQuotaCap(f.tid, 1);
  assert.equal(open(), 0, "调低上限：在途租约收回");
  assert.equal((await f.quota()).firm.in_flight_ratio, 0);
  // 网关回报这份租约（那一次已在途的请求照常入账），应答带 revoked
  const rec = { request_id: "kwlgw_b56_rv1", client_request_id: "c_rv1", upstream_request_id: "chatcmpl-rv1", at: new Date().toISOString(), sid: f.sid, uid: f.memberId, dev: f.deviceId, alias: "legal/k3", provider: "maas", upstream_model: "kimi-k3.1-pro", stream: true, status: 200, outcome: "ok", usage: { input: 50_000, cached: 0, output: 2_000, reasoning: 0 }, usage_source: "upstream", latency_ms: 900, attempts: [{ provider: "maas", status: 200, error: null, ms: 900 }], lease_id: l1.json.lease_id };
  const s = await service("/v1/quota/settle", { tid: f.tid, lease_id: l1.json.lease_id, holder: "gw-b56r", records: [rec] });
  assert.deepEqual([s.status, s.json.accepted, s.json.revoked], [200, 1, true], s.text);
  assert.equal((await f.quota()).firm.used, 52_000, "在途的那一次照常入账");
  // 新约束下：已用 5.2 万，上限 20 万，再要 16 万 → 拒绝（改前：旧租约还能继续用）
  const l2 = await lease(150_000, 8_192);
  assert.deepEqual([l2.status, l2.json.error.code], [402, "quota_cap_reached"]);
  // 小请求领得到；随后调高上限（放宽）不收回
  const l3 = await lease(10_000, 1_000);
  assert.equal(l3.status, 200);
  cp.ops.setQuotaCap(f.tid, 50);
  assert.equal(open(), 1, "调高上限不收回");
  cp.ops.setQuotaCap(f.tid, null);
  assert.equal(open(), 1, "取消上限不收回");
  // 运营给这家律所换套餐：收回
  const chg = await ops("op_1", "POST", `/v1/ops/tenants/${f.tid}/plan`, { plan: "b56-tokens" });
  assert.equal(chg.status, 200, chg.text);
  assert.equal(open(), 0, "换套餐：在途租约收回");
  // 没被收回的普通租约，回报应答不带 revoked
  const l4 = await lease(10_000, 1_000);
  const s4 = await service("/v1/quota/settle", { tid: f.tid, lease_id: l4.json.lease_id, holder: "gw-b56r", records: [] });
  assert.equal(s4.json.revoked, undefined);
});

test("调低个人上限：收回这位成员的在途租约，别人的不动（云端审计 4-A）", async () => {
  const f = await founder("b56-limit@example.cn", "五十六号个人上限律所");
  const aid = cp.ops.account("b56-limit@example.cn")!.aid;
  const l1 = await service("/v1/quota/lease", { tid: f.tid, sid: f.sid, holder: "gw-b56l", need_estimate: { alias: "legal/k3", input: 10_000, output: 1_000 } });
  assert.equal(l1.status, 200, l1.text);
  const mine = () => Object.values(cp.ops.tenant(f.tid)!.quota.leases).filter((l) => !l.closed_at && l.uid === f.memberId).length;
  assert.equal(mine(), 1);
  const set = await ops("op_1", "POST", `/v1/ops/accounts/${aid}/limits`, { quota_limit: 50_000 });
  assert.equal(set.status, 200, set.text);
  assert.equal(mine(), 0, "新设个人上限：这位成员的在途租约收回");
  const l2 = await service("/v1/quota/lease", { tid: f.tid, sid: f.sid, holder: "gw-b56l", need_estimate: { alias: "legal/k3", input: 10_000, output: 1_000 } });
  assert.equal(l2.status, 200);
  // 调高（放宽）不收回
  assert.equal((await ops("op_1", "POST", `/v1/ops/accounts/${aid}/limits`, { quota_limit: 80_000 })).status, 200);
  assert.equal(mine(), 1, "调高个人上限不收回");
  // 调低：收回；超过新上限的请求被拒
  assert.equal((await ops("op_1", "POST", `/v1/ops/accounts/${aid}/limits`, { quota_limit: 5_000 })).status, 200);
  assert.equal(mine(), 0);
  const l3 = await service("/v1/quota/lease", { tid: f.tid, sid: f.sid, holder: "gw-b56l", need_estimate: { alias: "legal/k3", input: 10_000, output: 1_000 } });
  assert.deepEqual([l3.status, l3.json.error.code], [402, "quota_seat_limit"]);
});
