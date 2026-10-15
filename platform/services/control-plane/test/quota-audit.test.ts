/**
 * 第 9 批：额度账本 v0（S3：额度池、月度上限硬停、网关租约与累计回报）与运营审计流水 v0（S14：每租户哈希链、律所侧可取与验链）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sign } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDeviceKeys, generateFirmRoot, issueDeviceCertificate, type DeviceCertificate, type DeviceRole } from "@zr-legal/keys";
import { AUDIT_GENESIS, enrollProofBytes, openEnvelope, publicKeyMap, signDeviceRequest, verifyAuditChain, type CpAuditPage } from "@zr-legal/firm-trust";
import {
  available,
  createAuditLog,
  createControlPlane,
  devControlPlaneKeys,
  emptyQuota,
  grantPoints,
  LEASE_GRACE_MS,
  leaseQuota,
  periodOf,
  QuotaError,
  setCap,
  settleLease,
  sweepLeases,
  type ControlPlane,
} from "../src/index.ts";

const keys = devControlPlaneKeys();
let cp: ControlPlane;
let base = "";
const SECRET = "quota-test-service-secret";
const root = generateFirmRoot();

before(async () => {
  cp = createControlPlane({ keys, serviceSecret: SECRET });
  await new Promise<void>((r) => cp.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(cp.server.address() as AddressInfo).port}`;
});
after(async () => {
  cp.server.closeAllConnections();
  await new Promise<void>((r) => cp.server.close(() => r()));
});

function makeDevice(tid: string, role: DeviceRole, member: string, id: string) {
  const k = generateDeviceKeys();
  const cert: DeviceCertificate = issueDeviceCertificate(root.privateKeyPem, {
    certId: `cert_${id}`,
    memberId: member,
    deviceId: id,
    role,
    signPublicKeyPem: k.signPublicKeyPem,
    encPublicKeyPem: k.encPublicKeyPem,
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 365 * 86400_000).toISOString(),
  });
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const h = signDeviceRequest({ method, path, body: raw, tid, deviceId: id, signPrivateKeyPem: k.signPrivateKeyPem });
    const r = await fetch(`${base}${path}`, { method, headers: { ...h, ...(raw ? { "content-type": "application/json" } : {}) }, ...(raw ? { body: raw } : {}) });
    return { status: r.status, json: await r.json() };
  };
  return { cert, call, register: () => call("POST", "/v1/devices/register", { tid, cert }) };
}

async function enroll(tid: string): Promise<void> {
  const ts = Date.now();
  const proof = sign(null, enrollProofBytes(tid, root.publicKeyPem, ts), root.privateKeyPem).toString("base64url");
  const r = await fetch(`${base}/v1/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tid, root_public_key_pem: root.publicKeyPem, ts, proof }) });
  assert.equal(r.status, 200);
}

const service = async (path: string, body: unknown, secret = SECRET) => {
  const r = await fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as any };
};

test("额度账本（纯函数）：租约受池余额与月度上限双重约束；回报为累计值（重发不重复计费）；上限与池用完分开报", () => {
  const t0 = Date.parse("2026-10-15T02:00:00Z");
  const q = emptyQuota(t0);
  grantPoints(q, 10_000);
  setCap(q, 3_000, t0, "dev_admin");
  const a = leaseQuota(q, { want: 2_000, need: 2_000, holder: "gw-1" }, t0);
  assert.equal(a.points, 2_000);
  assert.equal(a.limited_by, null);
  // 每次至多发剩余的 1/4（不少于 need）：一个网关不会一次领走全部剩余额度
  const small = leaseQuota(q, { want: 2_000, holder: "gw-2" }, t0);
  assert.equal(small.points, 250, "剩余 1000 的 1/4");
  const b = leaseQuota(q, { want: 2_000, need: 2_000, holder: "gw-2" }, t0);
  assert.equal(b.points, 750, "上限 3000 − 在途 2250：只能发 750（并发网关不能成倍突破上限）");
  assert.equal(b.limited_by, "cap", "发得比本次所需少：注明是上限所限");
  assert.throws(() => leaseQuota(q, { want: 1, holder: "gw-1" }, t0), (e: unknown) => e instanceof QuotaError && e.code === "cap_reached");

  // 回报累计值：同一份回报重发不重复计费；累计变小忽略
  assert.equal(settleLease(q, { lease_id: a.lease_id, holder: "gw-1", usage: [{ sid: "s1", points: 500, requests: 2 }] }, t0).charged, 500);
  assert.equal(settleLease(q, { lease_id: a.lease_id, holder: "gw-1", usage: [{ sid: "s1", points: 500, requests: 2 }] }, t0).charged, 0);
  assert.equal(settleLease(q, { lease_id: a.lease_id, holder: "gw-1", usage: [{ sid: "s1", points: 400, requests: 1 }] }, t0).charged, 0);
  assert.equal(q.period_used, 500);
  assert.equal(q.pool, 9_500);
  assert.throws(() => settleLease(q, { lease_id: a.lease_id, holder: "gw-2", usage: [] }, t0), (e: unknown) => e instanceof QuotaError && e.code === "lease_holder_mismatch");
  // 不合法的回报整体不入账（不留半截）
  assert.throws(() => settleLease(q, { lease_id: a.lease_id, holder: "gw-1", usage: [{ sid: "s2", points: 100, requests: 1 }, { sid: "s3", points: -1, requests: 1 }] }, t0));
  assert.equal(q.period_by_seat.s2, undefined);

  // 最终回报结案：未用部分回到可发放
  settleLease(q, { lease_id: a.lease_id, holder: "gw-1", usage: [{ sid: "s1", points: 800, requests: 3 }], final: true }, t0);
  assert.equal(available(q, t0), 3_000 - 800 - 250 - 750);

  // 池用完（不设上限）
  const p = emptyQuota(t0);
  grantPoints(p, 10);
  leaseQuota(p, { want: 10, need: 10, holder: "gw-1" }, t0);
  assert.throws(() => leaseQuota(p, { want: 1, holder: "gw-1" }, t0), (e: unknown) => e instanceof QuotaError && e.code === "pool_exhausted");
});

test("额度账本（纯函数）：到期 + 宽限未回报的租约按已报用量结案并标“待对账”，迟到的最终回报补记；跨月清零入历史", () => {
  const t0 = Date.parse("2026-10-31T15:40:00Z"); // 北京时间 10-31 23:40
  const q = emptyQuota(t0);
  grantPoints(q, 100_000);
  const l = leaseQuota(q, { want: 5_000, holder: "gw-1", ttl_ms: 60_000 }, t0);
  settleLease(q, { lease_id: l.lease_id, holder: "gw-1", usage: [{ sid: "s1", points: 100, requests: 1 }] }, t0);
  const late = t0 + 60_000 + LEASE_GRACE_MS + 1;
  sweepLeases(q, late);
  assert.equal(q.leases[l.lease_id]!.unreconciled, true);
  assert.equal(q.period_used, 100, "不按整段租约推定扣费：只记已报用量");
  assert.equal(periodOf(t0), "2026-10");
  assert.equal(periodOf(late), "2026-11", "北京时间跨月");
  // 迟到的最终回报：补记到当时所在的月份，并消掉待对账
  const r = settleLease(q, { lease_id: l.lease_id, holder: "gw-1", usage: [{ sid: "s1", points: 300, requests: 2 }], final: true }, late);
  assert.equal(r.charged, 200);
  assert.equal(q.leases[l.lease_id]!.unreconciled, false);
  assert.deepEqual(q.history, [{ period: "2026-10", used: 100 }]);
  assert.equal(q.period, "2026-11");
  assert.equal(q.period_used, 200);
});

test("额度 HTTP：租约与回报只认服务凭据；成员只看本所与自己的用量，管理员看按成员明细；只有管理员能设上限；上限到达后网关领不到租约", async () => {
  const tid = "ten_quota_http";
  cp.ops.createTenant({ tid, edition: "team", seats: 5, points: 50_000 });
  await enroll(tid);
  const admin = makeDevice(tid, "admin", "usr_admin", "dev_qadmin");
  const lawyer = makeDevice(tid, "lawyer", "usr_law", "dev_qlaw");
  assert.equal((await admin.register()).status, 200);
  assert.equal((await lawyer.register()).status, 200);
  const lawSeat = cp.ops.tenant(tid)!.seatsByUser.get("usr_law")!.sid;

  assert.equal((await service("/v1/quota/lease", { tid, want: 1000, holder: "gw-1" }, "wrong-secret")).status, 401);
  const l = await service("/v1/quota/lease", { tid, want: 1000, holder: "gw-1" });
  assert.equal(l.status, 200);
  assert.equal(l.json.points, 1000);
  assert.equal((await service("/v1/quota/settle", { tid, lease_id: l.json.lease_id, holder: "gw-1", usage: [{ sid: lawSeat, points: 120, requests: 3 }] })).json.charged, 120);

  const lv = await lawyer.call("GET", "/v1/quota");
  const lb = openEnvelope<any>(lv.json, "kwl-quota-view", publicKeyMap(cp.publicKeys.envelope));
  assert.ok(lb.ok);
  assert.equal(lb.ok && lb.body.period_used, 120);
  assert.deepEqual(lb.ok && lb.body.own, { points: 120, requests: 3 });
  assert.equal(lb.ok && "by_member" in lb.body, false, "律师看不到按成员明细与池余额");
  assert.equal(lb.ok && "pool_remaining" in lb.body, false);
  const av = openEnvelope<any>((await admin.call("GET", "/v1/quota")).json, "kwl-quota-view", publicKeyMap(cp.publicKeys.envelope));
  assert.ok(av.ok);
  assert.deepEqual(av.ok && av.body.by_member, [{ member_id: "usr_law", points: 120, requests: 3 }]);
  assert.equal(av.ok && av.body.pool_remaining, 50_000 - 120);

  assert.equal((await lawyer.call("PUT", "/v1/quota/cap", { monthly_cap: 1 })).json.error.code, "admin_required");
  assert.equal((await admin.call("PUT", "/v1/quota/cap", { monthly_cap: -5 })).json.error.code, "cap_invalid");
  assert.equal((await admin.call("PUT", "/v1/quota/cap", {})).json.error.code, "cap_invalid");
  // 上限 1500：已用 120 + 在途 880（1000 − 120）→ 还能发 500
  assert.equal((await admin.call("PUT", "/v1/quota/cap", { monthly_cap: 1500 })).status, 200);
  const l2 = await service("/v1/quota/lease", { tid, want: 2000, need: 2000, holder: "gw-2" });
  assert.equal(l2.json.points, 500);
  assert.equal(l2.json.limited_by, "cap");
  const l3 = await service("/v1/quota/lease", { tid, want: 1, holder: "gw-2" });
  assert.equal(l3.status, 402);
  assert.equal(l3.json.error.code, "cap_reached");
  // 不设上限
  assert.equal((await admin.call("PUT", "/v1/quota/cap", { monthly_cap: null })).status, 200);
  assert.equal((await service("/v1/quota/lease", { tid, want: 1, holder: "gw-2" })).status, 200);

  // 许可终止：不再发放
  cp.ops.terminateLicense(tid);
  assert.equal((await service("/v1/quota/lease", { tid, want: 1, holder: "gw-2" })).json.error.code, "license_expired");
});

test("运营审计流水：运营与设备的写操作逐条入链（吊销只记一次、重复登记不记、拒绝也记）；管理员与合伙人可取、律师不可；控制面签名 + 律所侧验链", async () => {
  const tid = "ten_audit_http";
  cp.ops.createTenant({ tid, edition: "team", seats: 5 });
  await enroll(tid);
  const admin = makeDevice(tid, "admin", "usr_a", "dev_aadmin");
  const partner = makeDevice(tid, "partner", "usr_p", "dev_apartner");
  const lawyer = makeDevice(tid, "lawyer", "usr_l", "dev_alaw");
  for (const d of [admin, partner, lawyer]) assert.equal((await d.register()).status, 200);
  assert.equal((await admin.register()).status, 200, "重复登记（证书未变）不记");
  cp.ops.grantPoints(tid, 1000);
  assert.equal((await lawyer.call("PUT", "/v1/quota/cap", { monthly_cap: 1 })).status, 403);
  assert.equal((await partner.call("POST", "/v1/devices/dev_alaw/revoke", {})).status, 200);

  assert.equal((await partner.call("GET", "/v1/audit?after=0&limit=500")).status, 200);
  assert.equal((await lawyer.call("GET", "/v1/audit?after=0&limit=500")).status, 403, "已吊销设备的请求得到吊销通知，不是流水");
  const page = openEnvelope<CpAuditPage>((await admin.call("GET", "/v1/audit?after=0&limit=500")).json, "kwl-cp-audit-page", publicKeyMap(cp.publicKeys.envelope));
  assert.ok(page.ok);
  if (!page.ok) return;
  const recs = page.body.records;
  assert.deepEqual(
    recs.map((r) => `${r.actor.kind}:${r.action}:${r.target ?? "-"}:${r.result}`),
    [
      "ops:tenant.create:-:ok",
      "root:tenant.enroll_root:-:ok",
      "device:device.register:dev_aadmin:ok",
      "device:device.register:dev_apartner:ok",
      "device:device.register:dev_alaw:ok",
      "ops:quota.grant:-:ok",
      "device:quota.cap_set:-:rejected:admin_required",
      "device:device.revoke:dev_alaw:ok",
    ],
  );
  assert.equal(recs.find((r) => r.action === "device.revoke")!.actor.id, "dev_apartner");
  assert.ok(recs.every((r) => r.tid === tid));
  assert.deepEqual(verifyAuditChain(recs, tid, { seq: 0, hash: AUDIT_GENESIS }), { ok: true });
  assert.deepEqual(page.body.head, { seq: recs.at(-1)!.seq, hash: recs.at(-1)!.hash });
  // 篡改任一条即验链失败
  const forged = recs.map((r, i) => (i === 3 ? { ...r, result: "rejected:x" } : r));
  assert.equal(verifyAuditChain(forged, tid, { seq: 0, hash: AUDIT_GENESIS }).ok, false);
  // 分页：after 之后的部分以前一条为锚
  const tail = openEnvelope<CpAuditPage>((await admin.call("GET", "/v1/audit?after=5&limit=2")).json, "kwl-cp-audit-page", publicKeyMap(cp.publicKeys.envelope));
  assert.ok(tail.ok && tail.body.records.length === 2 && tail.body.records[0]!.seq === 6);
  assert.deepEqual(tail.ok && verifyAuditChain(tail.body.records, tid, { seq: 5, hash: recs[4]!.hash }), { ok: true });
  assert.equal((await admin.call("GET", "/v1/audit?after=0&limit=501")).status, 400);
});

test("审计流水落盘：重启读回并验链；最后半行（掉电）丢弃；中间被改即拒绝启动", () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-cp-audit-"));
  const file = join(dir, "audit.jsonl");
  const a = createAuditLog({ file });
  a.append({ tid: "t1", actor: { kind: "ops", id: "ops" }, action: "tenant.create", target: null, result: "ok" }, new Date().toISOString());
  a.append({ tid: "t2", actor: { kind: "ops", id: "ops" }, action: "tenant.create", target: null, result: "ok" }, new Date().toISOString());
  a.append({ tid: "t1", actor: { kind: "device", id: "dev_1", fp: "abcdefghijklmnop" }, action: "device.revoke", target: "dev_2", result: "ok" }, new Date().toISOString());
  a.close();
  appendFileSync(file, '{"tid":"t1","seq":3,"at"'); // 掉电留下的半行
  const b = createAuditLog({ file });
  assert.equal(b.head("t1").seq, 2);
  assert.equal(b.head("t2").seq, 1);
  b.close();
  const lines = readFileSync(file, "utf8").split("\n");
  writeFileSync(file, [lines[0], lines[1]!.replace('"tenant.create"', '"tenant.renamed"'), lines[2], ""].join("\n"));
  assert.throws(() => createAuditLog({ file }), /未通过验链/);
});
