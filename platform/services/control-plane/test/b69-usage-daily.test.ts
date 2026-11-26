/**
 * 第 69 批（V43）：“设置 · 套餐与用量”重设计的云端口径——/v1/quota 的 personal 追加按日（daily）与按用途（by_kind），own_models 追加 used_ratio。
 * - 与 personal.used_ratio 同一分母（personalDenom）、同一计费口径（usedIn，账本同一批行）：各日 ratio 之和 = used_ratio；任务 + 问答 = used_ratio；各模型之和 = used_ratio；
 * - 只含本期、只含本人、只含有调用的日子（升序）；问答次数单列；
 * - splitRatios：逐份累加取差，份数再多舍入误差也不累积（逐日各自四舍五入会差出去）。
 * 时钟拨到本月（北京时间）15 日中午，让本期有多天的用量；设备请求签名、证书签发用同一时钟。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDeviceKeys, generateFirmRoot, issueDeviceCertificate, type DeviceRole } from "@zr-legal/keys";
import { enrollProofBytes, firmBundleBytes, openEnvelope, publicKeyMap, signDeviceRequest } from "@zr-legal/firm-trust";
import { accountDeviceId, createAuditLog, createControlPlane, devControlPlaneKeys, splitRatios, UsageBook, type ControlPlane } from "../src/index.ts";

const BJ = 8 * 3600_000;
const DAY = 86_400_000;
// 本月 15 日北京时间 12:00
const bjNow = new Date(Date.now() + BJ);
const target = Date.UTC(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), 15, 12) - BJ;
const shift = target - Date.now();
const clock = () => Date.now() + shift;

const keys = devControlPlaneKeys({ accountCa: true });
const SECRET = "b69-test-service-secret-0123456789abcdef";
const PW = "Lawyer2026secure";
let cp: ControlPlane;
let base = "";
const dir = mkdtempSync(join(tmpdir(), "kwl-b69-"));

before(async () => {
  cp = createControlPlane({ keys, auditLog: createAuditLog(), serviceSecret: SECRET, now: clock, usageBook: new UsageBook({ dir: join(dir, "usage"), now: clock }), routing: { bootstrap: { provider: { base_url: "https://maas.example.test/v1" } }, key_id: "0123456789abcdef" } });
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
const service = (path: string, body: unknown) => post(path, body, { authorization: `Bearer ${SECRET}` });

async function founder(email: string) {
  const reg = await post("/v1/auth/register", { email, password: PW, name: "钱律师", org_name: "钱律师工作室", client: { version: "0.5.1", platform: "darwin" } });
  assert.equal(reg.status, 200, JSON.stringify(reg.json));
  const onb = reg.json.onboarding;
  const tid = onb.claim.tid as string;
  const root = generateFirmRoot();
  const recovery = generateFirmRoot();
  const ts = clock();
  const proof = sign(null, enrollProofBytes(tid, root.publicKeyPem, ts), root.privateKeyPem).toString("base64url");
  const firm_bundle = { recovery_public_key_pem: recovery.publicKeyPem, sig: sign(null, firmBundleBytes(tid, root.publicKeyPem, recovery.publicKeyPem), root.privateKeyPem).toString("base64url") };
  const en = await post("/v1/enroll", { tid, root_public_key_pem: root.publicKeyPem, ts, proof, activation_id: onb.claim.activation_id, claim_secret: onb.claim.claim_secret, firm_bundle });
  assert.equal(en.status, 200, JSON.stringify(en.json));
  const memberId = `usr_${tid.slice(4)}_${onb.member.slug}`;
  const k = generateDeviceKeys();
  const deviceId = accountDeviceId(tid.slice(4), onb.member.slug, 1);
  const cert = issueDeviceCertificate(root.privateKeyPem, { certId: `cert_${deviceId}`, memberId, deviceId, role: "admin" as DeviceRole, signPublicKeyPem: k.signPublicKeyPem, encPublicKeyPem: k.encPublicKeyPem, issuedAt: new Date(clock() - 60_000).toISOString(), expiresAt: new Date(clock() + 365 * DAY).toISOString() });
  const session = reg.json.session_token as string;
  const call = async (method: string, path: string, body?: unknown) => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const h = signDeviceRequest({ method, path, body: raw, tid, deviceId, signPrivateKeyPem: k.signPrivateKeyPem, now: clock() });
    const r = await fetch(`${base}${path}`, { method, headers: { ...h, ...(raw ? { "content-type": "application/json" } : {}), "x-kwl-session": session }, ...(raw ? { body: raw } : {}) });
    return { status: r.status, json: (await r.json()) as any };
  };
  assert.equal((await call("POST", "/v1/devices/register", { tid, cert })).status, 200);
  return { tid, memberId, deviceId, call };
}

test("splitRatios：各份之和恰好等于总量折出的比例（逐份各自四舍五入会累积误差）；offset 作起点", () => {
  const parts = Array.from({ length: 30 }, () => 149); // 每份 0.0149‰ → 各自四舍五入为 0（30 份合计 0.0004 却显示 0）
  const r = splitRatios(parts, 100_000);
  assert.equal(Math.round(r.reduce((s, x) => s + x, 0) * 10_000), Math.round((4470 / 100_000) * 10_000));
  assert.ok(r.every((x) => x >= 0));
  const naive = parts.reduce((s, u) => s + Math.round((u / 100_000) * 10_000) / 10_000, 0);
  assert.notEqual(Math.round(naive * 10_000), 447, "反向样本：逐份各自舍入确实对不上");
  // offset：各份之和 = ratio(offset + Σ) − ratio(offset)
  const o = splitRatios([2500, 2500], 10_000, 1234);
  assert.equal(Math.round((o[0]! + o[1]!) * 10_000), Math.round(((1234 + 5000) / 10_000) * 10_000) - Math.round((1234 / 10_000) * 10_000));
  assert.deepEqual(splitRatios([], 100), []);
});

test("/v1/quota personal.daily / by_kind 与 own_models.used_ratio：与 used_ratio 同一分母与口径，各日之和 = 任务 + 问答 = 各模型之和 = used_ratio；只含本人、本期、有调用的日子", async () => {
  const f = await founder("b69-daily@example.cn");
  const other = `usr_${f.tid.slice(4)}_other`;
  const t = cp.ops.tenant(f.tid)!;
  const sid = t.seatsByUser.get(f.memberId)!.sid;
  const l = await service("/v1/quota/lease", { tid: f.tid, sid, holder: "gw-test", need_estimate: { alias: "legal/k3", input: 200_000, output: 8192 } });
  assert.equal(l.status, 200, JSON.stringify(l.json));
  // 本月 2、5、5、9、14、15 日（北京时间）各若干条，金额零散；15 日有两条问答；另有别人的一条与上个月的一条
  const bjDay = (d: number, h = 10) => new Date(Date.UTC(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), d, h) - BJ).toISOString();
  const lastMonth = new Date(Date.UTC(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), 0, 10) - BJ).toISOString();
  const rec = (id: string, uid: string, at: string, input: number, qa = false, alias = "legal/k3") => ({ request_id: id, client_request_id: `c_${id}`, upstream_request_id: `chatcmpl-${id}`, at, sid, uid, dev: f.deviceId, alias, provider: "maas", upstream_model: "kimi-k3.1-pro", stream: true, status: 200, outcome: "ok", qa, usage: { input, cached: 0, output: 1333, reasoning: 0 }, usage_source: "upstream", latency_ms: 1000, attempts: [{ provider: "maas", status: 200, error: null, ms: 1000 }], lease_id: l.json.lease_id });
  const records = [
    rec("kwlgw_d1", f.memberId, bjDay(2), 12_345),
    rec("kwlgw_d2", f.memberId, bjDay(5, 9), 7_777),
    rec("kwlgw_d3", f.memberId, bjDay(5, 16), 9_101, false, "legal/k3-fast"),
    rec("kwlgw_d4", f.memberId, bjDay(9), 3_333),
    rec("kwlgw_d5", f.memberId, bjDay(14), 15_151),
    rec("kwlgw_d6", f.memberId, bjDay(15, 9), 2_222, true),
    rec("kwlgw_d7", f.memberId, bjDay(15, 11), 4_444, true, "legal/k3-fast"),
    rec("kwlgw_x1", other, bjDay(9), 50_000),
    rec("kwlgw_x2", f.memberId, lastMonth, 40_000),
  ];
  const s = await service("/v1/quota/settle", { tid: f.tid, lease_id: l.json.lease_id, holder: "gw-test", records, final: true });
  assert.equal(s.status, 200, JSON.stringify(s.json));

  const q = await f.call("GET", "/v1/quota");
  const v = openEnvelope<any>(q.json, "kwl-quota-view", publicKeyMap(cp.publicKeys.envelope));
  assert.ok(v.ok, JSON.stringify(q.json).slice(0, 300));
  const p = v.ok ? v.body.personal : null;
  const ym = `${bjNow.getUTCFullYear()}-${String(bjNow.getUTCMonth() + 1).padStart(2, "0")}`;
  assert.deepEqual(p.daily.map((d: any) => [d.day, d.requests, d.qa_requests]), [[`${ym}-02`, 1, 0], [`${ym}-05`, 2, 0], [`${ym}-09`, 1, 0], [`${ym}-14`, 1, 0], [`${ym}-15`, 2, 2]], "只含本人、本期、有调用的日子，升序；别人的与上个月的不计");
  const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 10_000);
  const used = Math.round(p.used_ratio * 10_000);
  assert.ok(used > 0);
  assert.equal(sum(p.daily.map((d: any) => d.ratio)), used, "各日之和 = used_ratio");
  assert.equal(sum([p.by_kind.task.ratio, p.by_kind.qa.ratio]), used, "任务 + 问答 = used_ratio");
  assert.deepEqual([p.by_kind.task.requests, p.by_kind.qa.requests], [5, 2]);
  assert.equal(sum(v.ok ? v.body.own_models.map((m: any) => m.used_ratio) : []), used, "各模型之和 = used_ratio");
  // 同一分母：某一天的 ratio 与明细行 charge_ratio（同为 personalDenom）一致
  const d15 = p.daily.find((d: any) => d.day === `${ym}-15`);
  assert.ok(d15.ratio > 0);
  const charge15 = (v.ok ? v.body.own_recent : []).filter((r: any) => r.kind === "qa").reduce((n: number, r: any) => n + r.charge_ratio, 0);
  assert.ok(Math.abs(charge15 - d15.ratio) <= 0.0002, `15 日两条问答：明细 ${charge15} 对 每日 ${d15.ratio}`);
  // 不含金额与内部单位
  for (const d of p.daily) assert.deepEqual(Object.keys(d).sort(), ["day", "qa_requests", "ratio", "requests"]);
  assert.ok(!("used" in p.by_kind.task) && !("value_cny" in p.by_kind.task));
});
