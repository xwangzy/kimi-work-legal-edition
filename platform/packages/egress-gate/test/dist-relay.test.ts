/**
 * 闸门内容分发通道（第 8 批 S6/S7，dist-relay.ts）：只许 GET 白名单路径、目的地固定、凭据由闸门附上、不跟随跳转、响应有上限。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { distRelayAllowed, relayDist, DIST_MAX_RESPONSE_BYTES } from "../src/index.ts";

const SEAT = "zst1.payload.sig";

test("路径白名单：法规库与方法模板的清单与包文件可达；其他类别、通道、上级目录、子目录、查询串一律拒绝", () => {
  for (const p of ["/dist/lawdb/stable/latest.json", "/dist/skills/beta/latest.json", "/dist/lawdb/stable/files/lawdb-g0.abc.sqlite", "/dist/skills/stable/files/skills-x.json"]) {
    assert.equal(distRelayAllowed(p), null, p);
  }
  for (const p of [
    "/dist/other/stable/latest.json",
    "/dist/lawdb/nightly/latest.json",
    "/dist/lawdb/stable/files/../latest.json",
    "/dist/lawdb/stable/files/a/b.sqlite",
    "/dist/lawdb/stable/files/.x",
    "/dist/lawdb/stable/latest.json?x=1",
    "/v1/policy",
    "https://evil.example/dist/lawdb/stable/latest.json",
    123,
  ]) {
    assert.equal(distRelayAllowed(p), "dist_path_not_allowed", String(p));
  }
});

test("目的地固定、只带闸门自己的席位令牌、不跟随跳转；未配置、无席位、响应过大、连不上都按原因失败", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await relayDist("/dist/lawdb/stable/latest.json", { baseUrl: "https://dl.example-zr.cn/base/", seatToken: SEAT, fetchImpl });
  assert.deepEqual(r, { ok: true, status: 200, body_b64: Buffer.from([1, 2, 3]).toString("base64") });
  assert.equal(seen[0]!.url, "https://dl.example-zr.cn/base/dist/lawdb/stable/latest.json");
  assert.equal(seen[0]!.init.method, "GET");
  assert.equal(seen[0]!.init.redirect, "error");
  assert.deepEqual(seen[0]!.init.headers, { authorization: `Bearer ${SEAT}` }, "只有闸门附上的席位令牌，没有任何内核给的请求头");
  assert.equal(seen[0]!.init.body, undefined);
  assert.deepEqual(await relayDist("/dist/lawdb/stable/latest.json", { baseUrl: null, seatToken: SEAT, fetchImpl }), { ok: false, reason: "dist_not_configured" });
  assert.deepEqual(await relayDist("/dist/lawdb/stable/latest.json", { baseUrl: "https://dl.example-zr.cn", seatToken: null, fetchImpl }), { ok: false, reason: "dist_seat_unavailable" });
  assert.deepEqual(await relayDist("/dist/lawdb/stable/files/../x", { baseUrl: "https://dl.example-zr.cn", seatToken: SEAT, fetchImpl }), { ok: false, reason: "dist_path_not_allowed" });
  assert.equal(seen.length, 1, "拒绝的请求一个也没发出");
  const declaredBig = (async () => new Response("x", { status: 200, headers: { "content-length": String(DIST_MAX_RESPONSE_BYTES + 1) } })) as unknown as typeof fetch;
  assert.deepEqual(await relayDist("/dist/lawdb/stable/latest.json", { baseUrl: "https://dl.example-zr.cn", seatToken: SEAT, fetchImpl: declaredBig }), { ok: false, reason: "dist_response_too_large" });
  const streamedBig = (async () =>
    new Response(
      new ReadableStream({
        pull(c) {
          c.enqueue(new Uint8Array(8 * 1024 * 1024));
        },
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
  assert.deepEqual(await relayDist("/dist/lawdb/stable/latest.json", { baseUrl: "https://dl.example-zr.cn", seatToken: SEAT, fetchImpl: streamedBig }), { ok: false, reason: "dist_response_too_large" });
  const down = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  assert.deepEqual(await relayDist("/dist/lawdb/stable/latest.json", { baseUrl: "https://dl.example-zr.cn", seatToken: SEAT, fetchImpl: down }), { ok: false, reason: "dist_unreachable" });
  assert.deepEqual(
    await relayDist("/dist/lawdb/stable/latest.json", { baseUrl: "http://dl.example-zr.cn", seatToken: SEAT, fetchImpl, transport: { state: "invalid", reason: "upstream_tls_required" } as never }),
    { ok: false, reason: "dist_upstream_tls_required" },
  );
});
