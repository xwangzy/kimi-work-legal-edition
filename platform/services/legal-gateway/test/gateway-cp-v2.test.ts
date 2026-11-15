/**
 * V19 第 44 批联调：网关 ↔ 真实控制面（services/control-plane）。
 * 路由订阅（kwl-routing-feed，初始路由 use_local_key）→ 按席位租约 v2 → 逐请求记录 settle（控制面按 request_id 入账）→ 健康回报 →
 * 退出登录后订阅的暂停设备 → 网关 401 seat_session_inactive。
 * 上游是用例里的假 MaaS（控制面只收 https 地址，用例经 providerFetch 把该地址转到本机端口；白名单按控制面登记的主机名）。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDeviceKeys, generateFirmRoot, issueDeviceCertificate } from "@zr-legal/keys";
import { enrollProofBytes, publicKeyMap, signDeviceRequest } from "@zr-legal/firm-trust";
import { issueSeatToken } from "@zr-legal/seat-token";
import { accountDeviceId, createControlPlane, devControlPlaneKeys, GatewayFeedSubscriber, UsageBook, type ControlPlane } from "@zr-legal/control-plane";
import { createLegalGateway, httpLedger, LeaseQuota, memoryMeter, RoutingFeedSubscriber, UpstreamHealth, type MeterRecord } from "../src/index.ts";

const keys = devControlPlaneKeys();
const SECRET = "b44-gw-it-service-secret-0123456789abcdef";
const LOCAL_KEY = "sk-KWLIT-local-9d8c7b6a-NOLEAK";
const MAAS = "https://maas.example.test/v1";
let cp: ControlPlane;
let base = "";
let up: Server;
let upBase = "";
const upAuth: string[] = [];
const servers: Server[] = [];

before(async () => {
  up = createServer((req, res) => {
    upAuth.push(String(req.headers.authorization ?? ""));
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const b = JSON.parse(raw || "{}") as { model?: string };
      res.writeHead(200, { "content-type": "application/json", "x-oneapi-request-id": "oneapi-it-1" });
      res.end(JSON.stringify({ id: "chatcmpl-it", model: b.model, choices: [{ index: 0, message: { role: "assistant", content: "好" }, finish_reason: "stop" }], usage: { prompt_tokens: 1200, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 200 } } }));
    });
  });
  await new Promise<void>((r) => up.listen(0, "127.0.0.1", () => r()));
  upBase = `http://127.0.0.1:${(up.address() as AddressInfo).port}/v1`;
  cp = createControlPlane({ keys, serviceSecret: SECRET, usageBook: new UsageBook({ dir: join(mkdtempSync(join(tmpdir(), "kwl-gw-it-")), "usage") }), routing: { bootstrap: { provider: { base_url: MAAS } } } });
  await new Promise<void>((r) => cp.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(cp.server.address() as AddressInfo).port}`;
});
after(async () => {
  for (const s of servers) s.close();
  up.close();
  cp.server.closeAllConnections();
  await new Promise<void>((r) => cp.server.close(() => r()));
});

const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as any };
};

/** 自助注册 → 创始开通 → 本机设备登记（与控制面用例同一流程）。 */
async function founder(email: string) {
  const reg = await post("/v1/auth/register", { email, password: "Lawyer2026secure", name: "张律师", org_name: "联调律所", client: { version: "0.3.0", platform: "win32" } });
  assert.equal(reg.status, 200, JSON.stringify(reg.json));
  const onb = reg.json.onboarding;
  const tid = onb.claim.tid as string;
  const root = generateFirmRoot();
  const ts = Date.now();
  const proof = sign(null, enrollProofBytes(tid, root.publicKeyPem, ts), root.privateKeyPem).toString("base64url");
  assert.equal((await post("/v1/enroll", { tid, root_public_key_pem: root.publicKeyPem, ts, proof, activation_id: onb.claim.activation_id, claim_secret: onb.claim.claim_secret })).status, 200);
  const memberId = `usr_${tid.slice(4)}_${onb.member.slug}`;
  const deviceId = accountDeviceId(tid.slice(4), onb.member.slug, 1);
  const k = generateDeviceKeys();
  const cert = issueDeviceCertificate(root.privateKeyPem, { certId: `cert_${deviceId}`, memberId, deviceId, role: "admin", signPublicKeyPem: k.signPublicKeyPem, encPublicKeyPem: k.encPublicKeyPem, issuedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 365 * 86400_000).toISOString() });
  const call = async (method: string, path: string, body: unknown, session: string) => {
    const raw = JSON.stringify(body);
    const h = signDeviceRequest({ method, path, body: raw, tid, deviceId, signPrivateKeyPem: k.signPrivateKeyPem });
    const r = await fetch(`${base}${path}`, { method, headers: { ...h, "content-type": "application/json", "x-kwl-session": session }, body: raw });
    return { status: r.status, json: (await r.json()) as any };
  };
  const session = reg.json.session_token as string;
  assert.equal((await call("POST", "/v1/devices/register", { tid, cert }, session)).status, 200);
  return { tid, memberId, deviceId, session, call };
}

test("联调：路由订阅（use_local_key）→ 按席位租约 → 逐请求记录入控制面账本（去重）→ 健康回报 → 退出登录后网关 401 seat_session_inactive", { timeout: 60_000 }, async () => {
  const f = await founder("gw-it@example.cn");
  const sid = cp.ops.tenant(f.tid)!.seatsByUser.get(f.memberId)!.sid;
  const envKeys = publicKeyMap(cp.publicKeys.envelope);
  // 控制面只收 https：用例把登记的地址转到本机假上游（产品里不存在这个改写）
  const providerFetch: typeof fetch = (input, init) => fetch(String(input).replace(MAAS, upBase), init);
  const routing = new RoutingFeedSubscriber({ url: `${base}/v1/feed/routing`, serviceSecret: SECRET, keys: envKeys, routingKey: null, allowHosts: ["maas.example.test"], localKey: LOCAL_KEY, providerFetch, minRefreshMs: 0 });
  await routing.refresh();
  const snap = routing.current();
  assert.equal(snap.source, "feed", JSON.stringify(routing.stats));
  assert.equal(snap.providers.get("maas")?.state, "ok", "初始路由：use_local_key 用本机密钥");
  assert.equal(snap.models.get("legal/k3")?.targets[0]?.model, "kimi-k3.1-pro");
  const feed = new GatewayFeedSubscriber({ url: `${base}/v1/feed/gateway`, serviceSecret: SECRET, keys: envKeys, minRefreshMs: 0 });
  await feed.refresh();
  assert.ok(feed.ready());
  const holder = "gw-it-1-abcdef";
  const quota = new LeaseQuota({ ledger: httpLedger({ baseUrl: base, serviceSecret: SECRET }), holder, flushMs: 60_000 });
  const health = new UpstreamHealth();
  const meter = memoryMeter();
  const gw = createLegalGateway({ keys: publicKeyMap(cp.publicKeys.seat), routing, health, feed, quota, meter, holder });
  await new Promise<void>((r) => gw.listen(0, "127.0.0.1", () => r()));
  servers.push(gw);
  const gwBase = `http://127.0.0.1:${(gw.address() as AddressInfo).port}`;
  const token = issueSeatToken({ tid: f.tid, uid: f.memberId, sid, dev: f.deviceId, kid: keys.seat.kid }, keys.seat.privateKey);
  const chat = () =>
    fetch(`${gwBase}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-kwl-anon-matter": "anon-it", "x-kwl-data-level": "L2" },
      body: JSON.stringify({ model: "legal/k3", max_tokens: 2000, messages: [{ role: "user", content: "联调" }] }),
    });
  const r = await chat();
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal(upAuth.at(-1), `Bearer ${LOCAL_KEY}`);
  const rec = (meter as unknown as { records: MeterRecord[] }).records.filter((m) => m.kind === "settle").at(-1)!.record!;
  assert.equal(rec.provider, "maas");
  assert.equal(rec.upstream_model, "kimi-k3.1-pro");
  assert.equal(rec.upstream_request_id, "oneapi-it-1");
  assert.match(String(rec.lease_id), /^ls_[0-9a-f]{24}$/, "控制面发的租约编号");
  assert.equal(rec.charge_units, 1500, "tokens：输入 + 输出");
  await quota.flush();
  assert.equal(quota.pendingRecords, 0, "控制面已确认");
  assert.ok(cp.usageBook.has(rec.request_id), "逐请求记录进了控制面用量账本");
  const size = cp.usageBook.size;
  // 重发同一批：控制面按 request_id 去重
  const again = await httpLedger({ baseUrl: base, serviceSecret: SECRET }).settle({ tid: f.tid, lease_id: rec.lease_id!, holder, records: [rec], final: false });
  assert.ok(again.ok && again.duplicates === 1 && again.accepted === 0, JSON.stringify(again));
  assert.equal(cp.usageBook.size, size);
  // 健康回报
  assert.equal(await health.reportOnce({ url: `${base}/v1/feed/routing-health`, serviceSecret: SECRET, holder, view: routing }), true);
  // 退出登录：本设备进暂停设备，订阅刷新后网关拒绝
  const out = await f.call("POST", "/v1/auth/logout", {}, f.session);
  assert.equal(out.status, 200, JSON.stringify(out.json));
  await feed.refresh();
  const denied = await chat();
  assert.equal(denied.status, 401);
  assert.equal(((await denied.json()) as { error: { code: string } }).error.code, "seat_session_inactive");
  await quota.close();
  routing.stop();
  feed.stop();
});
