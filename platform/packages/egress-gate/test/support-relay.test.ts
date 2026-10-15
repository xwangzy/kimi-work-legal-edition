/**
 * 支持通道（第 9 批 S13）：只有“申请工单”与“上传诊断包”两种固定请求；摘要由闸门按实际字节重算；
 * 凭据是内核交来的“只限支持服务”短期凭据（复核 S9B-03：通用席位令牌不发给支持服务），闸门只核对形态；
 * 地址固定、不跟随跳转；未配置即不发。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { relaySupport, supportRelayAllowed, SUPPORT_MAX_UPLOAD_BYTES } from "../src/index.ts";

const body = Buffer.from('{"format":"kwl-diagnostics/1"}');
const sha = createHash("sha256").update(body).digest("hex");
const credential = `zst1.${"e".repeat(60)}.${"s".repeat(86)}`;
const ticketReq = { step: "ticket" as const, credential };
const up = { step: "upload" as const, credential, ticket: "SUP-AB12-CD34", upload_token: "t".repeat(43), content_sha256: sha, body_b64: body.toString("base64") };

test("请求形状：只认两种；缺凭据、多余字段、坏工单号、坏令牌、坏摘要、超大正文一律拒绝", () => {
  assert.equal(supportRelayAllowed(ticketReq), null);
  assert.equal(supportRelayAllowed(up), null);
  assert.equal(supportRelayAllowed({ step: "ticket" }), "support_request_invalid", "没有凭据不发");
  assert.equal(supportRelayAllowed({ step: "ticket", credential: "Bearer x" }), "support_credential_invalid");
  assert.equal(supportRelayAllowed({ ...ticketReq, path: "/v1/x" }), "support_request_invalid");
  assert.equal(supportRelayAllowed({ ...up, extra: 1 }), "support_request_invalid");
  assert.equal(supportRelayAllowed({ ...up, credential: "x\r\nevil: 1" }), "support_credential_invalid");
  assert.equal(supportRelayAllowed({ ...up, ticket: "SUP-../../x" }), "support_ticket_invalid");
  assert.equal(supportRelayAllowed({ ...up, ticket: "SUP-AB1I-CD34" }), "support_ticket_invalid", "Crockford 字母表不含 I");
  assert.equal(supportRelayAllowed({ ...up, upload_token: "a b" }), "support_token_invalid");
  assert.equal(supportRelayAllowed({ ...up, content_sha256: "x" }), "support_digest_invalid");
  assert.equal(supportRelayAllowed({ ...up, body_b64: "A".repeat(Math.ceil((SUPPORT_MAX_UPLOAD_BYTES * 4) / 3) + 8) }), "support_body_too_large");
  assert.equal(supportRelayAllowed({ step: "download", credential }), "support_request_invalid");
});

test("固定路径与请求头：附内核交来的支持凭据、上传带单次令牌与摘要；不跟随跳转；地址带前缀同样只发往该前缀下", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response('{"ok":true}', { status: 200 });
  }) as unknown as typeof fetch;
  const o = { baseUrl: "https://support.example-zr.cn/api/", fetchImpl };
  assert.deepEqual(await relaySupport(ticketReq, o), { ok: true, status: 200, body: '{"ok":true}' });
  assert.equal(seen[0]!.url, "https://support.example-zr.cn/api/v1/support/tickets");
  assert.equal(seen[0]!.init.method, "POST");
  assert.equal((seen[0]!.init.headers as Record<string, string>).authorization, `Bearer ${credential}`);
  assert.equal(seen[0]!.init.redirect, "error");
  assert.equal((await relaySupport(up, o)).ok, true);
  assert.equal(seen[1]!.url, "https://support.example-zr.cn/api/v1/support/packages/SUP-AB12-CD34");
  assert.equal(seen[1]!.init.method, "PUT");
  const h = seen[1]!.init.headers as Record<string, string>;
  assert.equal(h.authorization, `Bearer ${credential}`);
  assert.equal(h["x-kwl-upload-token"], up.upload_token);
  assert.equal(h["x-kwl-content-sha256"], sha);
  assert.ok(Buffer.from(seen[1]!.init.body as Uint8Array).equals(body));
});

test("摘要由闸门重算：与内核声明不符、非规范 base64 不发；未配置、传输策略不合格不发；响应过大拒收", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const o = { baseUrl: "https://support.example-zr.cn", fetchImpl };
  assert.deepEqual(await relaySupport({ ...up, content_sha256: "0".repeat(64) }, o), { ok: false, reason: "support_digest_mismatch" });
  assert.deepEqual(await relaySupport({ ...up, body_b64: `${up.body_b64}\n` }, o), { ok: false, reason: "support_body_invalid" });
  assert.deepEqual(await relaySupport(ticketReq, { ...o, baseUrl: null }), { ok: false, reason: "support_not_configured" });
  assert.deepEqual(await relaySupport(ticketReq, { ...o, transport: { state: "invalid", reason: "upstream_pins_required" } as any }), { ok: false, reason: "support_upstream_pins_required" });
  assert.equal(calls, 0);
  const big = (async () => new Response("x".repeat(70 * 1024), { status: 200 })) as unknown as typeof fetch;
  assert.deepEqual(await relaySupport(ticketReq, { ...o, fetchImpl: big }), { ok: false, reason: "support_response_too_large" });
});
