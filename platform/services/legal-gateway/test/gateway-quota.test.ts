/**
 * 第 9 批 S3 → V19 第 44 批额度租约 v2（主文 §4.3）：网关**按席位**向控制面额度账本领租约、本地扣减、逐请求记录回报（按 request_id 去重）、
 * 律所上限硬停、账本不可达时用到租约到期、发件箱（meter.jsonl + meter.ack）重启重放、关闭时最终回报。
 *
 * 对端是用例里本地起的假账本 HTTP 服务（按主会话与本工作包约定的协议模拟控制面；不是产品功能）。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devSeatKeyPair, issueSeatToken } from "@zr-legal/seat-token";
import { createLegalGateway, DEFAULT_ROUTES, fileMeter, httpLedger, LeaseQuota, MockProvider, readAck, type LedgerClient, type MeterRecord, type UsageRecord } from "../src/index.ts";

const SECRET = "gw-quota-secret";
const seatKeys = devSeatKeyPair();
const keys = new Map([["k1", seatKeys.publicKey]]);
const token = (tid: string, sid: string, aud?: string[]) => issueSeatToken({ tid, uid: `u-${sid}`, sid, dev: `d-${sid}`, kid: "k1", ...(aud ? { aud } : {}) }, seatKeys.privateKey, aud ? 900 : undefined);

interface Tenant {
  unit: "tokens" | "cny";
  allowance: number;
  used: number;
  leaseUnits: number;
  ttlMs: number;
  limitedBy: "cap" | "allowance" | "burst" | "seat";
  deny?: { status: number; code: string; message: string };
  allowedAliases?: string[] | null;
}

/** 假账本：按协议发租约、收逐请求记录、按 request_id 去重。 */
class FakeLedger {
  server!: Server;
  base = "";
  tenants = new Map<string, Tenant>();
  leases = new Map<string, { tid: string; sid: string; holder: string; units: number; closed: boolean }>();
  seen = new Set<string>();
  rows: UsageRecord[] = [];
  leaseCalls: Record<string, unknown>[] = [];
  settleCalls: { lease_id: string; holder: string; final: boolean; records: UsageRecord[] }[] = [];
  down = false;
  /** 下一次 settle 照常入账，但回 500（模拟应答丢失：网关会重发）。 */
  loseNextReply = false;
  leaseDelayMs = 0;
  n = 0;
  async start() {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", async () => {
        const reply = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
        if (this.down) return void res.destroy();
        if (req.headers.authorization !== `Bearer ${SECRET}`) return reply(401, { error: { code: "unauthorized", message: "x" } });
        const b = JSON.parse(raw);
        if (req.url === "/v1/quota/lease") {
          this.leaseCalls.push(b);
          if (this.leaseDelayMs) await new Promise((r) => setTimeout(r, this.leaseDelayMs));
          const t = this.tenants.get(b.tid);
          if (!t) return reply(404, { error: { code: "tenant_unknown", message: "x" } });
          if (t.deny) return reply(t.deny.status, { error: { code: t.deny.code, message: t.deny.message } });
          const inflight = [...this.leases.values()].filter((l) => l.tid === b.tid && !l.closed).reduce((s, l) => s + l.units, 0);
          const avail = t.allowance - t.used - inflight;
          const need = b.need_estimate.input + b.need_estimate.output;
          if (avail <= 0) return reply(402, { error: { code: "quota_exhausted", message: "本所本期 AI 额度已用完" } });
          const units = Math.min(avail, Math.max(t.leaseUnits, need));
          const id = `ls_${++this.n}`;
          this.leases.set(id, { tid: b.tid, sid: b.sid, holder: b.holder, units, closed: false });
          return reply(200, { lease_id: id, unit: t.unit, units, expires_at: new Date(Date.now() + t.ttlMs).toISOString(), limited_by: units < need ? t.limitedBy : null, price_version: 1, allowed_aliases: t.allowedAliases ?? null });
        }
        if (req.url === "/v1/quota/settle") {
          this.settleCalls.push(b);
          const l = this.leases.get(b.lease_id);
          if (!l) return reply(404, { error: { code: "lease_unknown", message: "x" } });
          if (l.holder !== b.holder) return reply(409, { error: { code: "lease_holder_mismatch", message: "x" } });
          let accepted = 0;
          let duplicates = 0;
          for (const r of b.records as UsageRecord[]) {
            if (this.seen.has(r.request_id)) {
              duplicates += 1;
              continue;
            }
            this.seen.add(r.request_id);
            this.rows.push(r);
            this.tenants.get(l.tid)!.used += r.charge_units;
            accepted += 1;
          }
          if (b.final) l.closed = true;
          if (this.loseNextReply) {
            this.loseNextReply = false;
            return reply(500, { error: { code: "internal", message: "x" } });
          }
          return reply(200, { ok: true, accepted, duplicates, closed: l.closed });
        }
        reply(404, { error: { code: "not_found", message: "x" } });
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  tenant(tid: string, o: Partial<Tenant> = {}) {
    this.tenants.set(tid, { unit: "tokens", allowance: 1_000_000, used: 0, leaseUnits: 20_000, ttlMs: 5 * 60_000, limitedBy: "allowance", ...o });
  }
}

const L = new FakeLedger();
const servers: Server[] = [];
before(() => L.start());
after(async () => {
  for (const s of servers) s.close();
  L.server.closeAllConnections();
  await new Promise<void>((r) => L.server.close(() => r()));
});

async function gatewayWith(quota: LeaseQuota, meter: MeterRecord[] | ReturnType<typeof fileMeter> = [], provider = new MockProvider()) {
  const sink = Array.isArray(meter) ? { append: (r: MeterRecord) => void meter.push(r) } : meter;
  const gw = createLegalGateway({ keys, provider, routes: DEFAULT_ROUTES, meter: sink, quota });
  await new Promise<void>((r) => gw.listen(0, "127.0.0.1", () => r()));
  servers.push(gw);
  const base = `http://127.0.0.1:${(gw.address() as AddressInfo).port}`;
  return (tid: string, sid: string, o: { maxTokens?: number; model?: string; signal?: AbortSignal } = {}) =>
    fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      ...(o.signal ? { signal: o.signal } : {}),
      headers: { "content-type": "application/json", authorization: `Bearer ${token(tid, sid)}`, "x-kwl-anon-matter": "anon-1", "x-kwl-data-level": "L2" },
      body: JSON.stringify({ model: o.model ?? "legal/k2.6", max_tokens: o.maxTokens ?? 100, messages: [{ role: "user", content: "你好" }] }),
    });
}

const ledger = () => httpLedger({ baseUrl: L.base, serviceSecret: SECRET });

test("按席位领租约（键 tid|sid）、本地扣减；回报逐请求记录，账本用量 = 各条 charge_units 之和；应答丢失后重发按 request_id 去重、不重复计", async () => {
  const tid = "ten_q_a";
  L.tenant(tid);
  const meter: MeterRecord[] = [];
  const quota = new LeaseQuota({ ledger: ledger(), holder: "gw-a", flushMs: 60_000 });
  const chat = await gatewayWith(quota, meter);
  const before = L.leaseCalls.length;
  for (let i = 0; i < 3; i++) assert.equal((await chat(tid, "seat_a1")).status, 200);
  assert.equal((await chat(tid, "seat_a2")).status, 200);
  const calls = L.leaseCalls.slice(before);
  assert.deepEqual(calls.map((c) => c.sid), ["seat_a1", "seat_a2"], "每个席位一份租约，没有逐请求打账本");
  assert.deepEqual(Object.keys(calls[0]!).sort(), ["holder", "need_estimate", "sid", "tid"]);
  assert.equal((calls[0]!.need_estimate as { alias: string }).alias, "legal/k2.6");
  assert.equal((calls[0]!.need_estimate as { output: number }).output, 100);
  // 应答丢失：账本已入账但网关以为失败 → 下一轮重发同样的记录
  L.loseNextReply = true;
  await quota.flush();
  assert.ok(quota.pendingRecords > 0, "没确认的保留");
  await quota.flush();
  assert.equal(quota.pendingRecords, 0);
  const settled = meter.filter((m) => m.kind === "settle").map((m) => m.record!);
  assert.equal(settled.length, 4);
  assert.equal(L.rows.filter((r) => r.tid === tid).length, 4, "按 request_id 去重：一条只入一次");
  assert.ok(L.settleCalls.some((c) => c.records.length && c.records.every((r) => L.seen.has(r.request_id))));
  assert.equal(L.tenants.get(tid)!.used, settled.reduce((s, r) => s + r.charge_units, 0));
  for (const r of settled) {
    assert.equal(r.charge_units, r.usage!.input + r.usage!.output, "tokens：输入 + 输出");
    assert.ok(r.lease_id?.startsWith("ls_"));
    assert.equal(r.uid, `u-${r.sid}`);
  }
  await quota.close();
});

test("攒够一批即回报（不等周期）；每次至多一批", async () => {
  const tid = "ten_q_b";
  L.tenant(tid);
  const quota = new LeaseQuota({ ledger: ledger(), holder: "gw-b", flushMs: 60_000, batchSize: 3 });
  const chat = await gatewayWith(quota);
  const n = L.settleCalls.length;
  for (let i = 0; i < 3; i++) await chat(tid, "seat_b1");
  for (let i = 0; i < 40 && L.settleCalls.length === n; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(L.settleCalls.length, n + 1);
  assert.equal(L.settleCalls.at(-1)!.records.length, 3);
  await quota.close();
  assert.ok(L.settleCalls.slice(n).every((c) => c.records.length <= 3));
});

test("拒绝：控制面的 402/403 原样回客户端（状态码 402）；发得比所需少按 limited_by 报原因；套餐不含该别名 403 model_not_allowed；都不到达上游", async () => {
  const provider = new MockProvider();
  const quota = new LeaseQuota({ ledger: ledger(), holder: "gw-c", flushMs: 60_000 });
  const chat = await gatewayWith(quota, [], provider);
  const body = async (r: Response) => ((await r.json()) as { error: { type: string; code: string; message: string } }).error;
  L.tenant("ten_q_c1", { deny: { status: 403, code: "quota_seat_limit", message: "您本期的个人 AI 额度已用完" } });
  let r = await chat("ten_q_c1", "s1");
  assert.equal(r.status, 402);
  assert.deepEqual(await body(r), { type: "kwl_gateway", code: "quota_seat_limit", message: "您本期的个人 AI 额度已用完" });
  L.tenant("ten_q_c2", { deny: { status: 402, code: "license_expired", message: "本所订阅已到期" } });
  r = await chat("ten_q_c2", "s1");
  assert.equal(r.status, 402);
  assert.equal((await body(r)).code, "license_expired");
  L.tenant("ten_q_c3", { allowance: 50, leaseUnits: 10, limitedBy: "cap" });
  r = await chat("ten_q_c3", "s1", { maxTokens: 1000 });
  assert.equal(r.status, 402);
  assert.equal((await body(r)).code, "quota_cap_reached");
  L.tenant("ten_q_c4", { allowedAliases: ["legal/k2.6"] });
  assert.equal((await chat("ten_q_c4", "s1")).status, 200);
  r = await chat("ten_q_c4", "s1", { model: "legal/k3" });
  assert.equal(r.status, 403);
  assert.equal((await body(r)).code, "model_not_allowed");
  assert.equal(provider.seen.length, 1, "被拒的请求不到达上游");
  await quota.close();
});

test("账本不可达：已有租约照常用到到期；之后 503 quota_unavailable（不发往上游）；回报保留到账本恢复，过期租约随最终回报移除", async () => {
  const tid = "ten_q_d";
  L.tenant(tid);
  let clock = Date.now();
  const quota = new LeaseQuota({ ledger: ledger(), holder: "gw-d", flushMs: 60_000, now: () => clock });
  const chat = await gatewayWith(quota);
  assert.equal((await chat(tid, "s_d1")).status, 200);
  L.down = true;
  assert.equal((await chat(tid, "s_d1")).status, 200, "账本不可达：用已有租约");
  await quota.flush();
  assert.equal(L.tenants.get(tid)!.used, 0);
  clock += 10 * 60_000; // 租约（5 分钟）已到期
  const r = await chat(tid, "s_d1");
  assert.equal(r.status, 503);
  assert.equal(((await r.json()) as { error: { code: string } }).error.code, "quota_unavailable");
  L.down = false;
  await quota.flush();
  assert.equal(L.rows.filter((x) => x.tid === tid).length, 2, "恢复后补报两次请求");
  assert.equal(L.settleCalls.at(-1)!.final, true);
  assert.equal(quota.snapshot().length, 0, "到期且无在途请求的租约在最终回报后移除");
  await quota.close();
});

test("复核 S9A-06：账本 404 not_found 时保留下次重报，只在 lease_unknown 时放弃（记 dropped，记录仍在计量文件）", async () => {
  let settleCode = "not_found";
  const ledgerStub: LedgerClient = {
    lease: async () => ({ ok: true as const, lease_id: "ls_x", unit: "tokens" as const, units: 1000, expires_at: new Date(Date.now() + 60_000).toISOString(), limited_by: null, price_version: 1, allowed_aliases: null }),
    settle: async () => ({ ok: false as const, status: 404, code: settleCode }),
  };
  const q = new LeaseQuota({ ledger: ledgerStub, holder: "gw-e", flushMs: 60_000 });
  const r = await q.reserve({ tid: "t_e", sid: "s1", alias: "legal/k3", estimate: { input: 5, output: 5 } }, () => 10);
  assert.ok(r.ok);
  if (r.ok) q.settle(r.hold, { request_id: "kwlgw_e1", charge_units: 5 } as UsageRecord);
  await q.flush();
  assert.equal(q.pendingRecords, 1, "not_found：保留");
  settleCode = "lease_unknown";
  await q.flush();
  assert.equal(q.pendingRecords, 0);
  assert.equal(q.stats.dropped, 1);
  assert.equal(q.snapshot().length, 0, "lease_unknown：放弃");
  await q.close();
});

test("发件箱：settle 行带整条记录写进 meter.jsonl；检查点只在确认后前进；进程重启后从检查点重放未确认的记录（按原持有者、final），账本去重", async () => {
  const tid = "ten_q_f";
  L.tenant(tid);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kwl-gw-outbox-")));
  const meterFile = join(dir, "meter.jsonl");
  const ackFile = join(dir, "meter.ack");
  const meter = fileMeter(meterFile);
  // 第一个进程：送达一条后账本不可达，又处理了两条；随后“崩溃”（不 close）
  const q1 = new LeaseQuota({ ledger: ledger(), holder: "gw-old-1-aaaaaa", flushMs: 60_000, outbox: { meterFile, ackFile } });
  const chat = await gatewayWith(q1, meter);
  assert.equal((await chat(tid, "s_f1")).status, 200);
  await q1.flush();
  const ack1 = readAck(ackFile);
  assert.ok(ack1 > 0, "第一条确认后检查点前进");
  L.down = true;
  assert.equal((await chat(tid, "s_f1")).status, 200);
  assert.equal((await chat(tid, "s_f1")).status, 200);
  await q1.flush();
  // 第二条 settle 行（第一条未确认的）的起始字节
  const all = readFileSync(meterFile, "utf8").split("\n").filter(Boolean);
  const idx = all.map((l, i) => [JSON.parse(l).kind, i] as const).filter(([k]) => k === "settle")[1]![1];
  const firstUnacked = all.slice(0, idx).reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
  assert.equal(readAck(ackFile), firstUnacked, "检查点停在第一条未确认的 settle 行起点（其前的预占行无需重放）");
  L.down = false;
  const lines = readFileSync(meterFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const sl = lines.filter((x) => x.kind === "settle");
  assert.equal(sl.length, 3);
  assert.ok(sl.every((x) => x.record?.request_id === x.requestId && x.holder === "gw-old-1-aaaaaa" && x.unit === "tokens"));
  L.down = false;
  const rowsBefore = L.rows.filter((x) => x.tid === tid).length;
  // 第二个进程：同一文件、同一检查点
  const q2 = new LeaseQuota({ ledger: ledger(), holder: "gw-new-2-bbbbbb", flushMs: 60_000, outbox: { meterFile, ackFile } });
  assert.equal(q2.stats.replayed, 2);
  await q2.flush();
  assert.equal(L.rows.filter((x) => x.tid === tid).length, rowsBefore + 2);
  const replay = L.settleCalls.at(-1)!;
  assert.equal(replay.holder, "gw-old-1-aaaaaa", "按原持有者回报");
  assert.equal(replay.final, true, "上一进程的租约：最终回报");
  assert.equal(readAck(ackFile), readFileSync(meterFile).length, "全部确认：检查点到文件尾");
  // 第三次启动：没有可重放的；检查点损坏时从头重放也不会重复计（去重）
  const q3 = new LeaseQuota({ ledger: ledger(), holder: "gw-3", flushMs: 60_000, outbox: { meterFile, ackFile } });
  assert.equal(q3.stats.replayed, 0);
  await q3.close();
  await q2.close();
  assert.ok(existsSync(ackFile));
  // q1 的定时器停掉（模拟进程已不在）
  await q1.close(0);
});

test("关闭：等进行中的请求结算后对所有租约做最终回报（未用部分立即释放）；关闭后新的预占 503 gateway_stopping", async () => {
  const tid = "ten_q_g";
  L.tenant(tid);
  const quota = new LeaseQuota({ ledger: ledger(), holder: "gw-g", flushMs: 60_000 });
  const r = await quota.reserve({ tid, sid: "s_g", alias: "legal/k3", estimate: { input: 50, output: 50 } }, () => 100);
  assert.ok(r.ok);
  if (r.ok) quota.settle(r.hold, { request_id: "kwlgw_g1", tid, charge_units: 40 } as UsageRecord);
  const lease = [...L.leases.entries()].find(([, l]) => l.tid === tid)!;
  assert.equal(lease[1].closed, false);
  await quota.close();
  assert.equal(L.leases.get(lease[0])!.closed, true, "最终回报：账本关闭租约、释放在途");
  assert.equal(L.tenants.get(tid)!.used, 40);
  const after = await quota.reserve({ tid, sid: "s_g", alias: "legal/k3", estimate: { input: 1, output: 1 } }, () => 2);
  assert.ok(!after.ok && after.code === "gateway_stopping");
});

test("复核 S9A-07：等账本期间客户端断开——不发往上游、预占退还", async () => {
  const tid = "ten_q_h";
  L.tenant(tid);
  L.leaseDelayMs = 300;
  const quota = new LeaseQuota({ ledger: ledger(), holder: "gw-h", flushMs: 60_000 });
  const meter: MeterRecord[] = [];
  const provider = new MockProvider();
  const chat = await gatewayWith(quota, meter, provider);
  const ac = new AbortController();
  const p = chat(tid, "s_h", { signal: ac.signal }).catch(() => null);
  await new Promise((r) => setTimeout(r, 100));
  ac.abort();
  await p;
  await new Promise((r) => setTimeout(r, 500));
  L.leaseDelayMs = 0;
  assert.equal(provider.seen.length, 0, "没有发往上游");
  assert.ok(meter.some((m) => m.reason === "client_gone_before_upstream"));
  assert.ok(quota.snapshot().every((l) => l.holds === 0 && l.remaining === l.units), "预占已退还");
  await quota.close();
});

test("复核 S9B-03：只限支持服务的凭据在网关被拒（受众不符）", async () => {
  const quota = new LeaseQuota({ ledger: ledger(), holder: "gw-i", flushMs: 60_000 });
  const gw = createLegalGateway({ keys, provider: new MockProvider(), routes: DEFAULT_ROUTES, meter: { append() {} }, quota });
  await new Promise<void>((r) => gw.listen(0, "127.0.0.1", () => r()));
  servers.push(gw);
  const r = await fetch(`http://127.0.0.1:${(gw.address() as AddressInfo).port}/v1/models`, { headers: { authorization: `Bearer ${token("ten_q_i", "s_i", ["support"])}` } });
  assert.equal(r.status, 401);
  await quota.close();
});
