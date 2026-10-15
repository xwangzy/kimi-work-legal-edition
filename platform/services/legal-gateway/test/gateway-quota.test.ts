/**
 * 第 9 批 S3：网关的额度改由控制面额度账本发放租约（LeaseQuota）——本地扣减、累计回报、律所月度上限硬停、账本不可达时用到租约到期。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { issueSeatToken } from "@zr-legal/seat-token";
import { publicKeyMap } from "@zr-legal/firm-trust";
import { createControlPlane, devControlPlaneKeys, type ControlPlane } from "@zr-legal/control-plane";
import { createLegalGateway, DEFAULT_ROUTES, httpLedger, LeaseQuota, MockProvider, type LedgerClient, type MeterRecord } from "../src/index.ts";

const SECRET = "gw-quota-secret";
const cpKeys = devControlPlaneKeys();
let cp: ControlPlane;
let cpBase = "";
const servers: Server[] = [];

before(async () => {
  cp = createControlPlane({ keys: cpKeys, serviceSecret: SECRET });
  await new Promise<void>((r) => cp.server.listen(0, "127.0.0.1", () => r()));
  cpBase = `http://127.0.0.1:${(cp.server.address() as AddressInfo).port}`;
});
after(async () => {
  for (const s of servers) s.close();
  cp.server.closeAllConnections();
  await new Promise<void>((r) => cp.server.close(() => r()));
});

async function gatewayWith(quota: LeaseQuota, meter: MeterRecord[] = []) {
  const gw = createLegalGateway({ keys: publicKeyMap(cp.publicKeys.seat), provider: new MockProvider(), routes: DEFAULT_ROUTES, meter: { append: (r) => void meter.push(r) }, quota });
  await new Promise<void>((r) => gw.listen(0, "127.0.0.1", () => r()));
  servers.push(gw);
  const base = `http://127.0.0.1:${(gw.address() as AddressInfo).port}`;
  return (tid: string, sid: string, maxTokens = 100) =>
    fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${issueSeatToken({ tid, uid: "u1", sid, dev: "d1", kid: cpKeys.seat.kid }, cpKeys.seat.privateKey)}`,
        "x-kwl-anon-matter": "anon-1",
        "x-kwl-data-level": "L2",
      },
      body: JSON.stringify({ model: "legal/k2.6", max_tokens: maxTokens, messages: [{ role: "user", content: "你好" }] }),
    });
}

test("租约：网关本地扣减，回报后账本的本月用量等于网关按实际 usage 结算的点数（按席位）；重复回报不重复计费", async () => {
  const tid = "ten_gwq_a";
  cp.ops.createTenant({ tid, edition: "team", seats: 3, points: 100_000 });
  const meter: MeterRecord[] = [];
  const quota = new LeaseQuota({ ledger: httpLedger({ baseUrl: cpBase, serviceSecret: SECRET }), holder: "gw-a", leaseSize: 1_000, flushMs: 60_000 });
  const chat = await gatewayWith(quota, meter);
  for (let i = 0; i < 3; i++) assert.equal((await chat(tid, "seat_a1")).status, 200);
  assert.equal((await chat(tid, "seat_a2")).status, 200);
  await quota.flush();
  await quota.flush();
  const settled = meter.filter((m) => m.kind === "settle");
  assert.equal(settled.length, 4);
  // 结算点数 = ceil((in+out)/1000 × 2)（legal/k2.6）
  const pts = settled.map((m) => Math.ceil(((m.inputTokens! + m.outputTokens!) / 1000) * 2));
  const q = cp.ops.tenant(tid)!.quota;
  assert.equal(q.period_used, pts.reduce((a, b) => a + b, 0));
  assert.deepEqual(q.period_by_seat.seat_a1, { points: pts[0]! + pts[1]! + pts[2]!, requests: 3 });
  assert.equal(q.period_by_seat.seat_a2!.requests, 1);
  assert.equal(Object.keys(q.leases).length, 1, "一份租约够用：没有逐请求打账本");
  await quota.close();
});

test("月度上限硬停：律所设的上限用完后网关返回 402 quota_cap_reached、不到达上游；上限调高后恢复", async () => {
  const tid = "ten_gwq_b";
  cp.ops.createTenant({ tid, edition: "team", seats: 3, points: 100_000 });
  cp.ops.setQuotaCap(tid, 450);
  const meter: MeterRecord[] = [];
  const quota = new LeaseQuota({ ledger: httpLedger({ baseUrl: cpBase, serviceSecret: SECRET }), holder: "gw-b", leaseSize: 1_000, flushMs: 60_000 });
  const chat = await gatewayWith(quota, meter);
  // 小请求（预占 1 点）照常；单次预占 500 点（max_tokens 25 万 × 2/1000）超过上限剩余 → 402，且不到达上游
  assert.equal((await chat(tid, "seat_b1")).status, 200);
  const r = await chat(tid, "seat_b1", 250_000);
  assert.equal(r.status, 402);
  assert.equal(((await r.json()) as any).error.code, "quota_cap_reached");
  const rej = meter.filter((m) => m.kind === "reject").at(-1)!;
  assert.equal(rej.reason, "quota_cap_reached");
  assert.equal(meter.filter((m) => m.kind === "reserve").length, 1, "被拒的请求没有预占、没有发往上游");
  await quota.flush();
  const q = cp.ops.tenant(tid)!.quota;
  assert.ok(q.period_used <= 450, `本月已用 ${q.period_used} 不超过上限`);
  cp.ops.setQuotaCap(tid, null);
  await new Promise((r) => setTimeout(r, 1_100)); // 刚失败过 1 秒内不再打账本
  assert.equal((await chat(tid, "seat_b1", 250_000)).status, 200);
  await quota.close();
});

test("账本不可达：已有租约照常用到到期；之后 503 quota_unavailable（不发往上游）；回报保留到账本恢复", async () => {
  const tid = "ten_gwq_c";
  cp.ops.createTenant({ tid, edition: "team", seats: 3, points: 100_000 });
  let down = false;
  let clock = Date.now();
  const real = httpLedger({ baseUrl: cpBase, serviceSecret: SECRET });
  const ledger: LedgerClient = {
    lease: (...a) => (down ? Promise.resolve({ ok: false as const, status: 0, code: "ledger_unreachable" }) : real.lease(...a)),
    settle: (...a) => (down ? Promise.resolve({ ok: false as const, status: 0, code: "ledger_unreachable" }) : real.settle(...a)),
  };
  const quota = new LeaseQuota({ ledger, holder: "gw-c", leaseSize: 5_000, flushMs: 60_000, now: () => clock });
  const chat = await gatewayWith(quota);
  assert.equal((await chat(tid, "seat_c1")).status, 200);
  down = true;
  assert.equal((await chat(tid, "seat_c1")).status, 200, "账本不可达：用已有租约");
  await quota.flush(); // 不可达：回报保留
  assert.equal(cp.ops.tenant(tid)!.quota.period_used, 0);
  clock += 10 * 60_000; // 租约（5 分钟）已到期
  const r = await chat(tid, "seat_c1");
  assert.equal(r.status, 503);
  assert.equal(((await r.json()) as any).error.code, "quota_unavailable");
  down = false;
  await quota.flush();
  const q = cp.ops.tenant(tid)!.quota;
  assert.equal(q.period_by_seat.seat_c1!.requests, 2, "恢复后补报两次请求的累计用量");
  assert.equal(quota.snapshot().length, 0, "到期且无在途请求的租约在最终回报后移除");
  await quota.close();
});

test("复核 S9A-05：两个网关实例共用账本、接近上限时，后台预取不会一次拿走全部剩余（另一实例仍领得到）", async () => {
  const tid = "ten_gwq_d";
  cp.ops.createTenant({ tid, edition: "team", seats: 3, points: 100_000 });
  cp.ops.setQuotaCap(tid, 8_000);
  const ledger = httpLedger({ baseUrl: cpBase, serviceSecret: SECRET });
  const a = new LeaseQuota({ ledger, holder: "gw-da", leaseSize: 20_000, flushMs: 60_000 });
  const b = new LeaseQuota({ ledger, holder: "gw-db", leaseSize: 20_000, flushMs: 60_000 });
  const ra = await a.reserve(tid, 10);
  assert.ok(ra.ok);
  await new Promise((r) => setTimeout(r, 50)); // 让 A 的后台预取完成
  const rb = await b.reserve(tid, 10);
  assert.ok(rb.ok, `B 仍领得到：${JSON.stringify(rb)}`);
  const total = [...a.snapshot(), ...b.snapshot()].reduce((s, l) => s + l.points, 0);
  assert.ok(total <= 8_000, "两实例合计不超过上限");
  await a.close();
  await b.close();
});

test("复核 S9A-06、S9A-08：账本 404 not_found 时保留租约下次重报，只在 lease_unknown 时放弃；许可到期报“订阅已到期”", async () => {
  let settleCode = "not_found";
  const calls: string[] = [];
  const ledger: LedgerClient = {
    lease: async () => ({ ok: true as const, lease_id: "ls_x", points: 1000, expires_at: new Date(Date.now() + 60_000).toISOString() }),
    settle: async () => {
      calls.push(settleCode);
      return { ok: false as const, status: 404, code: settleCode };
    },
  };
  const q = new LeaseQuota({ ledger, holder: "gw-e", flushMs: 60_000 });
  const r = await q.reserve("t_e", 10);
  assert.ok(r.ok);
  if (r.ok) q.settle(r.hold, "s1", 5);
  await q.flush();
  assert.equal(q.snapshot().length, 1, "not_found：保留");
  settleCode = "lease_unknown";
  await q.flush();
  assert.equal(q.snapshot().length, 0, "lease_unknown：放弃");
  await q.close();

  const expired: LedgerClient = { lease: async () => ({ ok: false as const, status: 402, code: "license_expired" }), settle: async () => ({ ok: true as const }) };
  const q2 = new LeaseQuota({ ledger: expired, holder: "gw-f" });
  const r2 = await q2.reserve("t_f", 10);
  assert.ok(!r2.ok && r2.code === "quota_license_expired" && /订阅已到期/.test(r2.message));
  await q2.close();
});

test("复核 S9A-07：等账本期间客户端断开——不发往上游、预占退还", async () => {
  const tid = "ten_gwq_g";
  cp.ops.createTenant({ tid, edition: "team", seats: 3, points: 100_000 });
  const real = httpLedger({ baseUrl: cpBase, serviceSecret: SECRET });
  const slow: LedgerClient = { lease: async (...a) => (await new Promise((r) => setTimeout(r, 300)), real.lease(...a)), settle: (...a) => real.settle(...a) };
  const quota = new LeaseQuota({ ledger: slow, holder: "gw-g", flushMs: 60_000 });
  const meter: MeterRecord[] = [];
  const provider = new MockProvider();
  const gw = createLegalGateway({ keys: publicKeyMap(cp.publicKeys.seat), provider, routes: DEFAULT_ROUTES, meter: { append: (r) => void meter.push(r) }, quota });
  await new Promise<void>((r) => gw.listen(0, "127.0.0.1", () => r()));
  servers.push(gw);
  const ac = new AbortController();
  const p = fetch(`http://127.0.0.1:${(gw.address() as AddressInfo).port}/v1/chat/completions`, {
    method: "POST",
    signal: ac.signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${issueSeatToken({ tid, uid: "u1", sid: "s_g", dev: "d1", kid: cpKeys.seat.kid }, cpKeys.seat.privateKey)}`, "x-kwl-anon-matter": "anon-1", "x-kwl-data-level": "L2" },
    body: JSON.stringify({ model: "legal/k2.6", max_tokens: 10, messages: [{ role: "user", content: "x" }] }),
  }).catch(() => null);
  await new Promise((r) => setTimeout(r, 100));
  ac.abort();
  await p;
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(provider.seen.length, 0, "没有发往上游");
  assert.ok(meter.some((m) => m.reason === "client_gone_before_upstream"));
  assert.ok(quota.snapshot().every((l) => l.holds === 0), "预占已退还");
  await quota.close();
});

test("复核 S9B-03：只限支持服务的凭据在网关被拒（受众不符）", async () => {
  const tid = "ten_gwq_h";
  cp.ops.createTenant({ tid, edition: "team", seats: 3, points: 100_000 });
  const quota = new LeaseQuota({ ledger: httpLedger({ baseUrl: cpBase, serviceSecret: SECRET }), holder: "gw-h", flushMs: 60_000 });
  const gw = createLegalGateway({ keys: publicKeyMap(cp.publicKeys.seat), provider: new MockProvider(), routes: DEFAULT_ROUTES, meter: { append() {} }, quota });
  await new Promise<void>((r) => gw.listen(0, "127.0.0.1", () => r()));
  servers.push(gw);
  const support = issueSeatToken({ tid, uid: "u1", sid: "s_h", dev: "d1", kid: cpKeys.seat.kid, aud: ["support"] }, cpKeys.seat.privateKey, 900);
  const r = await fetch(`http://127.0.0.1:${(gw.address() as AddressInfo).port}/v1/models`, { headers: { authorization: `Bearer ${support}` } });
  assert.equal(r.status, 401);
  await quota.close();
});
