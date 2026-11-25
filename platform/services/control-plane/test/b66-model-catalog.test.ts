/**
 * 第 66 批（V40）：云端模型目录——控制台给模型别名加说明、排序、思考方式、档位、能力、入口与客户端可见；
 * 控制面 GET /v1/models（设备签名，签名信封 kwl-model-catalog）按本所套餐与路由、价目算出可用性与原因，
 * 只下发展示字段：目标、上游、地址、密钥与上游型号一律不下发。网关订阅（kwl-routing-feed）不带新字段。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import { devStaffOf, staffClient } from "./staff-fixture.ts";
import { generateDeviceKeys, generateFirmRoot, issueDeviceCertificate } from "@zr-legal/keys";
import { enrollProofBytes, openEnvelope, publicKeyMap, signDeviceRequest } from "@zr-legal/firm-trust";
import { accountDeviceId, createAuditLog, createControlPlane, devControlPlaneKeys, type ControlPlane } from "../src/index.ts";
import { bootstrapRouting, modelCatalogBody, routingFeedBody, routingView, RoutingError, upsertModel } from "../src/routing.ts";
import { checkEnvelopeBody } from "../../cp-signer/src/index.ts";

const T0 = Date.parse("2026-11-26T08:00:00Z");
const UPSTREAM_SECRETS = ["targets", "base_url", "provider", "key_sealed", "key_hint", "upstream_model", "kimi-k3.1-pro", "maas.example.test"];

function routing() {
  const r = bootstrapRouting(T0, { provider: { base_url: "https://maas.example.test/v1" } });
  upsertModel(r, "legal/k3-fast", { label: "K3 高速", targets: [{ provider: "maas", model: "kimi-k3.1-pro-highspeed" }], description: "更快出结果", sort: 15, thinking: "effort", efforts: ["low", "high"], capabilities: ["tool_use", "thinking"], scopes: ["qa", "task"] }, T0, "op");
  upsertModel(r, "legal/internal", { label: "内部复核", targets: [{ provider: "maas", model: "kimi-k3.1-pro" }], client_visible: false }, T0, "op");
  upsertModel(r, "legal/off", { label: "已下线", enabled: false, targets: [] }, T0, "op");
  return r;
}

test("目录（纯函数）：只列客户端可见的；按排序；停用标 disabled；内置别名补缺省（K3 问答 + 任务、K2.6 只问答）；不含任何上游信息", () => {
  const r = routing();
  const doc = modelCatalogBody(r, { models: null, quota_unit: "tokens" }, T0, { tid: "ten_x", uid: "usr_x" });
  assert.deepEqual(doc.models.map((m) => m.id), ["legal/k3", "legal/k3-fast", "legal/k2.6", "legal/off"], "按 sort：10、15、20、100；client_visible=false 的不下发");
  const by = Object.fromEntries(doc.models.map((m) => [m.id, m]));
  assert.equal(by["legal/k3"]!.label, "K3", "首次部署的占位名“主任务模型”给律师看时换成 K3");
  assert.deepEqual(by["legal/k3"]!.scopes, ["qa", "task"]);
  assert.deepEqual(by["legal/k2.6"]!.scopes, ["qa"], "K2.6 是子 Agent 的模型：主任务入口不列");
  assert.equal(by["legal/k2.6"]!.thinking, "toggle");
  assert.deepEqual([by["legal/k3-fast"]!.available, by["legal/k3-fast"]!.description, by["legal/k3-fast"]!.thinking, by["legal/k3-fast"]!.efforts.join(",")], [true, "更快出结果", "effort", "low,high"]);
  assert.deepEqual([by["legal/off"]!.available, by["legal/off"]!.reason], [false, "disabled"]);
  assert.equal(doc.default, "legal/k3");
  assert.equal(doc.version, r.version);
  const json = JSON.stringify(doc);
  for (const s of UPSTREAM_SECRETS) assert.equal(json.includes(s), false, `目录里不得出现 ${s}`);
  for (const m of doc.models) assert.deepEqual(Object.keys(m).sort(), ["available", "capabilities", "default", "description", "efforts", "id", "label", "max_context", "reason", "scopes", "sort", "thinking"]);
});

test("目录（纯函数）：套餐不含 → not_in_plan；金额套餐未定价 → unpriced；上游停用 → no_route", () => {
  const r = routing();
  const plan = modelCatalogBody(r, { models: ["legal/k3", "legal/k2.6"], quota_unit: "tokens" }, T0, { tid: "ten_x", uid: null });
  assert.deepEqual(plan.models.filter((m) => !m.available).map((m) => [m.id, m.reason]), [["legal/k3-fast", "not_in_plan"], ["legal/off", "disabled"]]);
  // 首次部署的价目为空：金额套餐下每个启用的别名都未定价
  const cny = modelCatalogBody(r, { models: null, quota_unit: "cny" }, T0, { tid: "ten_x", uid: null });
  assert.equal(cny.models.find((m) => m.id === "legal/k3")!.reason, "unpriced");
  r.providers[0]!.enabled = false;
  const down = modelCatalogBody(r, { models: null, quota_unit: "tokens" }, T0, { tid: "ten_x", uid: null });
  assert.deepEqual(down.models.filter((m) => m.id !== "legal/off").map((m) => m.reason), ["no_route", "no_route", "no_route"]);
});

test("运营改模型：新字段逐项校验；运营视图带出（缺省补齐）；网关订阅不带新字段", () => {
  const r = routing();
  const bad = (b: Record<string, unknown>, code: string) =>
    assert.throws(() => upsertModel(r, "legal/k3-fast", b, T0, "op"), (e: unknown) => e instanceof RoutingError && e.code === code, code);
  bad({ thinking: "auto" }, "model_thinking_invalid");
  bad({ scopes: ["task", "chat"] }, "model_scopes_invalid");
  bad({ scopes: ["task"], capabilities: ["thinking"] }, "model_scopes_invalid");
  bad({ thinking: "toggle", efforts: ["high"] }, "model_efforts_invalid");
  bad({ description: "长".repeat(61) }, "model_description_invalid");
  bad({ sort: -1 }, "model_sort_invalid");
  bad({ max_context: 100 }, "model_max_context_invalid");
  bad({ client_visible: "no" }, "model_flag_invalid");
  assert.throws(() => upsertModel(r, "legal/qa-only", { label: "只问答", targets: [{ provider: "maas", model: "kimi-k3" }], scopes: ["qa"], is_default: true }, T0, "op"), (e: unknown) => e instanceof RoutingError && e.code === "model_default_invalid", "缺省模型须能在任务入口选");
  // 只改其中一项：其余沿用
  upsertModel(r, "legal/k3-fast", { sort: 5 }, T0, "op");
  const v = routingView(r, null).models.find((m) => m.alias === "legal/k3-fast")!;
  assert.deepEqual([v.sort, v.description, v.thinking, v.scopes.join(",")], [5, "更快出结果", "effort", "qa,task"]);
  const k26 = routingView(r, null).models.find((m) => m.alias === "legal/k2.6")!;
  assert.deepEqual([k26.scopes.join(","), k26.thinking, k26.client_visible], ["qa", "toggle", true], "旧记录没有新字段：内置别名按缺省补齐");
  const feed = routingFeedBody(r, T0);
  for (const m of feed.models) assert.deepEqual(Object.keys(m).sort(), ["alias", "allow_cross_vendor", "default_max_tokens", "enabled", "is_default", "label", "targets"], "网关订阅只给网关要的字段");
});

test("签名服务只签不夹带上游信息的目录", () => {
  const r = routing();
  const doc = modelCatalogBody(r, { models: null, quota_unit: "tokens" }, T0, { tid: "ten_x", uid: "usr_x" });
  assert.equal(checkEnvelopeBody("kwl-model-catalog", doc, T0), null);
  const leaky = { ...doc, models: doc.models.map((m, i) => (i === 0 ? { ...m, targets: [{ provider: "maas", model: "kimi-k3.1-pro" }] } : m)) };
  assert.equal(checkEnvelopeBody("kwl-model-catalog", leaky, T0), "model_catalog_entry_invalid");
  assert.equal(checkEnvelopeBody("kwl-model-catalog", { ...doc, issued_at: new Date(T0 - 60_000).toISOString() }, T0), "issued_at_not_now");
});

// ─── 经 HTTP：运营改路由与套餐 → 设备取目录（签名信封） ───

const PEOPLE = { op_1001: ["operator", "sysadmin"] } as const;
const SECRET = "b66-model-catalog-service-secret-0123";
let cp: ControlPlane;
let base = "";
before(async () => {
  cp = createControlPlane({ keys: devControlPlaneKeys(), serviceSecret: SECRET, auditLog: createAuditLog(), devStaff: devStaffOf({ op_1001: [...PEOPLE.op_1001] }), routing: { bootstrap: { provider: { base_url: "https://maas.example.test/v1" } }, key_id: "a1b2c3d4e5f60718" } });
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

async function firm(tid: string, email: string) {
  assert.equal((await ops("op_1001", "POST", "/v1/ops/tenants", { tid, name: `${tid} 律所`, edition: "team", seats: 3 })).status, 200);
  const code = cp.ops.issueActivationCode(tid, { member: { slug: "boss" } });
  const reg = await post("/v1/auth/register", { email, password: "Lawyer2026secure", name: "王主任", code: code.code });
  assert.equal(reg.status, 200, JSON.stringify(reg.json));
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
  const get = async (path: string) => {
    const hh = signDeviceRequest({ method: "GET", path, body: "", tid, deviceId, signPrivateKeyPem: k.signPrivateKeyPem });
    const r = await fetch(`${base}${path}`, { headers: { ...hh, "x-kwl-session": reg.json.session_token } });
    return { status: r.status, json: (await r.json()) as any };
  };
  return { tid, memberId, get };
}

test("GET /v1/models：设备签名取目录；运营新增别名、改套餐后客户端按版本与签发时刻取到新目录；信封验签、篡改即失败；未签名请求拒绝", async () => {
  const f = await firm("ten_b66cat", "boss@b66cat.cn");
  const keys = publicKeyMap(cp.publicKeys.envelope);
  const r0 = await f.get("/v1/models");
  assert.equal(r0.status, 200, JSON.stringify(r0.json));
  const o0 = openEnvelope<any>(r0.json, "kwl-model-catalog", keys);
  assert.ok(o0.ok);
  assert.deepEqual([o0.body.tid, o0.body.uid], [f.tid, f.memberId]);
  assert.deepEqual(o0.body.models.map((m: any) => m.id), ["legal/k3", "legal/k2.6"]);

  const enc = encodeURIComponent("legal/k3-fast");
  const put = await ops("op_1001", "PUT", `/v1/ops/routing/models/${enc}`, { label: "K3 高速", targets: [{ provider: "maas", model: "kimi-k3.1-pro-highspeed", priority: 1 }], description: "更快出结果", sort: 15, thinking: "effort", efforts: ["low", "high"], capabilities: ["tool_use", "thinking"], scopes: ["qa", "task"], client_visible: true });
  assert.equal(put.status, 200, put.text);
  assert.equal(put.json.routing.models.find((m: any) => m.alias === "legal/k3-fast").description, "更快出结果", "运营视图带出新字段");
  const r1 = await f.get("/v1/models");
  const o1 = openEnvelope<any>(r1.json, "kwl-model-catalog", keys);
  assert.ok(o1.ok);
  assert.ok(o1.body.version > o0.body.version, "运营改路由：版本升");
  const fast = o1.body.models.find((m: any) => m.id === "legal/k3-fast");
  assert.deepEqual([fast.available, fast.label, fast.sort], [true, "K3 高速", 15]);
  for (const s of UPSTREAM_SECRETS) assert.equal(JSON.stringify(r1.json).includes(s), false, `下发的信封里不得出现 ${s}`);

  // 套餐撤掉这个别名：同一路由版本，签发时刻更晚；客户端据此置灰
  const plan = await ops("op_1001", "PUT", "/v1/ops/plans/b66-limited", { label: "只含 K3", quota_unit: "tokens", seat_quota: 1_000_000, period: "month", models: ["legal/k3", "legal/k2.6"] });
  assert.equal(plan.status, 200, plan.text);
  cp.ops.setPlan(f.tid, { plan: "b66-limited" });
  await new Promise((r) => setTimeout(r, 5));
  const r2 = await f.get("/v1/models");
  const o2 = openEnvelope<any>(r2.json, "kwl-model-catalog", keys);
  assert.ok(o2.ok);
  assert.equal(o2.body.version, o1.body.version);
  assert.ok(Date.parse(o2.body.issued_at) > Date.parse(o1.body.issued_at));
  assert.deepEqual(o2.body.models.find((m: any) => m.id === "legal/k3-fast").reason, "not_in_plan");

  // 篡改（把不可用改成可用）→ 验签失败
  const forged = JSON.parse(JSON.stringify(r2.json));
  forged.body.models.find((m: any) => m.id === "legal/k3-fast").available = true;
  assert.equal(openEnvelope(forged, "kwl-model-catalog", keys).ok, false);
  // 不带设备签名：拒绝
  assert.equal((await fetch(`${base}/v1/models`)).status >= 400, true);
});
