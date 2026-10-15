/**
 * 控制面通道（阶段 6；第 04 篇 §5.1“控制面、更新、中继：目的地固定，只出元数据或密文”）：
 * 只经内核 IPC；目的地为固定地址；路径、方法、请求头白名单；请求与响应大小有上限；不跟随跳转。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpRelayAllowed, relayControlPlane, CP_MAX_REQUEST_BYTES, CP_MAX_RESPONSE_BYTES } from "../src/index.ts";

const H = { "x-kwl-tenant": "ten_a", "x-kwl-device": "dev_a", "x-kwl-ts": "1", "x-kwl-nonce": "n", "x-kwl-sig": "s" };

test("路径与方法白名单：控制面已知接口可达；网关订阅、未知路径、路径穿越、额外请求头一律拒绝", () => {
  for (const [m, p] of [
    ["GET", "/v1/directory"],
    ["GET", "/v1/policy"],
    ["POST", "/v1/seat-token"],
    ["POST", "/v1/drafts"],
    ["POST", "/v1/drafts/drf_0123456789abcdef/signatures"],
    ["PUT", "/v1/anon-matters/AAAAAAAAAAAAAAAAAAAAAA"],
    ["DELETE", "/v1/connectors/firm-dms"],
  ] as const) {
    assert.equal(cpRelayAllowed({ method: m, path: p, headers: H, body: "" }), null, `${m} ${p}`);
  }
  assert.equal(cpRelayAllowed({ method: "GET", path: "/v1/feed/gateway", headers: H, body: "" }), "cp_path_not_allowed");
  assert.equal(cpRelayAllowed({ method: "GET", path: "/v1/../admin", headers: H, body: "" }), "cp_path_not_allowed");
  assert.equal(cpRelayAllowed({ method: "GET", path: "https://elsewhere.example/v1/policy", headers: H, body: "" }), "cp_path_not_allowed");
  assert.equal(cpRelayAllowed({ method: "PATCH", path: "/v1/policy", headers: H, body: "" }), "cp_method_not_allowed");
  assert.equal(cpRelayAllowed({ method: "GET", path: "/v1/policy", headers: { ...H, authorization: "Bearer x" }, body: "" }), "cp_header_not_allowed");
  assert.equal(cpRelayAllowed({ method: "GET", path: "/v1/policy", headers: { ...H, "x-kwl-sig": "a\r\nb" }, body: "" }), "cp_header_not_allowed");
  assert.equal(cpRelayAllowed({ method: "POST", path: "/v1/drafts", headers: H, body: "x".repeat(CP_MAX_REQUEST_BYTES + 1) }), "cp_body_too_large");
  // 变量段只允许字母数字、下划线与连字符（复核 S6-B16：编码的点段会被 URL 解析成上一级目录）
  assert.equal(cpRelayAllowed({ method: "POST", path: "/v1/devices/%2e%2e/revoke", headers: H, body: "" }), "cp_path_not_allowed");
  assert.equal(cpRelayAllowed({ method: "POST", path: "/v1/devices/dev.a/revoke", headers: H, body: "" }), "cp_path_not_allowed");
  assert.equal(cpRelayAllowed({ method: "POST", path: "/v1/devices/dev_a-1/revoke", headers: H, body: "" }), null);
  // 第 9 批：用量与上限、中软侧操作记录（只许 after/limit 这一种查询串）
  assert.equal(cpRelayAllowed({ method: "GET", path: "/v1/quota", headers: H, body: "" }), null);
  assert.equal(cpRelayAllowed({ method: "PUT", path: "/v1/quota/cap", headers: H, body: "" }), null);
  assert.equal(cpRelayAllowed({ method: "GET", path: "/v1/audit?after=0&limit=500", headers: H, body: "" }), null);
  assert.equal(cpRelayAllowed({ method: "GET", path: "/v1/audit?after=0&limit=500&x=1", headers: H, body: "" }), "cp_path_not_allowed");
  assert.equal(cpRelayAllowed({ method: "GET", path: "/v1/audit", headers: H, body: "" }), "cp_path_not_allowed");
  assert.equal(cpRelayAllowed({ method: "GET", path: "/v1/policy?x=1", headers: H, body: "" }), "cp_path_not_allowed");
});

test("带查询串的白名单路径原样发出（归一化核对含查询串）", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (url: string) => {
    seen.push(url);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const r = await relayControlPlane({ method: "GET", path: "/v1/audit?after=12&limit=500", headers: H, body: "" }, { baseUrl: "https://cp.example-zr.cn/api", fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(seen[0], "https://cp.example-zr.cn/api/v1/audit?after=12&limit=500");
});

test("以 URL 归一化之后的路径为准：控制面地址带前缀时同样只发往该前缀下的白名单路径", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (url: string) => {
    seen.push(url);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const r = await relayControlPlane({ method: "GET", path: "/v1/policy", headers: H, body: "" }, { baseUrl: "https://cp.example-zr.cn/api/", fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(seen[0], "https://cp.example-zr.cn/api/v1/policy");
});

test("目的地固定：请求只发往配置的控制面地址；未配置即拒绝；不跟随跳转；响应过大拒收", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await relayControlPlane({ method: "GET", path: "/v1/policy", headers: H, body: "" }, { baseUrl: "https://cp.example-zr.cn/", fetchImpl });
  assert.deepEqual(r, { ok: true, status: 200, body: '{"ok":true}' });
  assert.equal(seen[0]!.url, "https://cp.example-zr.cn/v1/policy");
  assert.equal(seen[0]!.init.redirect, "error");
  assert.deepEqual(await relayControlPlane({ method: "GET", path: "/v1/policy", headers: H, body: "" }, { baseUrl: null, fetchImpl }), { ok: false, reason: "cp_not_configured" });
  const big = (async () => new Response("x".repeat(CP_MAX_RESPONSE_BYTES + 1), { status: 200 })) as unknown as typeof fetch;
  assert.deepEqual(await relayControlPlane({ method: "GET", path: "/v1/policy", headers: H, body: "" }, { baseUrl: "https://cp.example-zr.cn", fetchImpl: big }), { ok: false, reason: "cp_response_too_large" });
  const down = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  assert.deepEqual(await relayControlPlane({ method: "GET", path: "/v1/policy", headers: H, body: "" }, { baseUrl: "https://cp.example-zr.cn", fetchImpl: down }), { ok: false, reason: "cp_unreachable" });
});
