/**
 * 通知通道（第 10 批 S9）：只有登记、撤销、取到时提醒、确认收到四种固定请求；请求体由闸门按固定字段重新拼出（内核交来的对象里
 * 多出的任何内容都不会发出）；凭据须为通知专用（受众 notify）；地址固定、不跟随跳转；响应有上限；未配置即不发。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { notifyRelayAllowed, relayNotify } from "../src/index.ts";

const credOf = (aud: string[] | undefined) =>
  `zst1.${Buffer.from(JSON.stringify({ tid: "t", uid: "u", sid: "s", dev: "d", kid: "k", iat: 1, exp: 2, ...(aud ? { aud } : {}) })).toString("base64url")}.${"s".repeat(86)}`;
const credential = credOf(["notify"]);
const RID = `rmd_${"c".repeat(24)}`;
const put = { step: "put" as const, credential, reminder_id: RID, fire_at: "2026-11-27T01:00:00.000Z", version: 2, targets: [{ dev: "dev_a", ct: "Q".repeat(120) }] };

test("请求形状：四种之外、多余字段、坏编号、坏时刻、坏密文、通用或支持凭据一律拒绝", () => {
  assert.equal(notifyRelayAllowed(put), null);
  assert.equal(notifyRelayAllowed({ step: "due", credential }), null);
  assert.equal(notifyRelayAllowed({ step: "delete", credential, reminder_id: RID }), null);
  assert.equal(notifyRelayAllowed({ step: "ack", credential, items: [{ id: RID, version: 1 }] }), null);
  assert.equal(notifyRelayAllowed({ step: "due", credential: credOf(undefined) }), "notify_credential_audience", "通用席位令牌不发往通知服务");
  assert.equal(notifyRelayAllowed({ step: "due", credential: credOf(["support"]) }), "notify_credential_audience");
  assert.equal(notifyRelayAllowed({ step: "due", credential: "x\r\nevil: 1" }), "notify_credential_invalid");
  assert.equal(notifyRelayAllowed({ ...put, note: "开庭" }), "notify_request_invalid", "明文字段不收");
  assert.equal(notifyRelayAllowed({ ...put, targets: [{ dev: "dev_a", ct: "Q".repeat(120), kind: "hearing" }] }), "notify_targets_invalid");
  assert.equal(notifyRelayAllowed({ ...put, reminder_id: "rmd_../../x" }), "notify_reminder_invalid");
  assert.equal(notifyRelayAllowed({ ...put, fire_at: "2026-11-27T01:00:30.000Z" }), "notify_fire_at_invalid", "只到分钟");
  assert.equal(notifyRelayAllowed({ ...put, version: 0 }), "notify_version_invalid");
  assert.equal(notifyRelayAllowed({ ...put, targets: [{ dev: "dev_a", ct: "开庭".repeat(30) }] }), "notify_ciphertext_invalid");
  assert.equal(notifyRelayAllowed({ ...put, targets: [{ dev: "dev a", ct: "Q".repeat(120) }] }), "notify_targets_invalid");
  assert.equal(notifyRelayAllowed({ ...put, targets: Array.from({ length: 51 }, (_, i) => ({ dev: `d${i}`, ct: "Q".repeat(120) })) }), "notify_targets_invalid");
  assert.equal(notifyRelayAllowed({ step: "ack", credential, items: [] }), "notify_items_invalid");
  assert.equal(notifyRelayAllowed({ step: "list", credential }), "notify_request_invalid");
});

test("固定路径与方法；请求体由闸门重拼（只含触发时刻、版本、设备与密文）；附凭据；不跟随跳转；带前缀的地址只发往该前缀下", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response('{"ok":true}', { status: 200 });
  }) as unknown as typeof fetch;
  const o = { baseUrl: "https://notify.example-zr.cn/api/", fetchImpl };
  // 内核交来的对象（形状检查通过后）即便带有原型上的额外属性，也不会进请求体
  const sneaky = Object.assign(Object.create({ note: "开庭" }), put);
  assert.equal((await relayNotify(sneaky, o)).ok, true);
  assert.equal(seen[0]!.url, `https://notify.example-zr.cn/api/v1/reminders/${RID}`);
  assert.equal(seen[0]!.init.method, "PUT");
  assert.equal(seen[0]!.init.redirect, "error");
  assert.equal((seen[0]!.init.headers as Record<string, string>).authorization, `Bearer ${credential}`);
  assert.deepEqual(JSON.parse(String(seen[0]!.init.body)), { fire_at: put.fire_at, version: 2, targets: [{ dev: "dev_a", ct: "Q".repeat(120) }] });
  await relayNotify({ step: "delete", credential, reminder_id: RID }, o);
  await relayNotify({ step: "due", credential }, o);
  await relayNotify({ step: "ack", credential, items: [{ id: RID, version: 2 }] }, o);
  assert.deepEqual(
    seen.slice(1).map((x) => [x.init.method, x.url.replace("https://notify.example-zr.cn/api", "")]),
    [
      ["DELETE", `/v1/reminders/${RID}`],
      ["GET", "/v1/notify/due"],
      ["POST", "/v1/notify/ack"],
    ],
  );
  assert.deepEqual(JSON.parse(String(seen[3]!.init.body)), { items: [{ id: RID, version: 2 }] });
});

test("未配置不发；形状不合格不发；响应超过 1 MiB 截断报错；连接被拒报“确定没有送出”", async () => {
  let called = 0;
  const fetchImpl = (async () => {
    called++;
    return new Response("x".repeat(1024 * 1024 + 10), { status: 200 });
  }) as unknown as typeof fetch;
  assert.deepEqual(await relayNotify(put, { baseUrl: null, fetchImpl }), { ok: false, reason: "notify_not_configured" });
  assert.deepEqual(await relayNotify({ ...put, version: -1 }, { baseUrl: "https://n.example.cn", fetchImpl }), { ok: false, reason: "notify_version_invalid" });
  assert.equal(called, 0);
  assert.deepEqual(await relayNotify({ step: "due", credential }, { baseUrl: "https://n.example.cn", fetchImpl }), { ok: false, reason: "notify_response_too_large" });
  const refused = (async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  }) as unknown as typeof fetch;
  assert.deepEqual(await relayNotify({ step: "due", credential }, { baseUrl: "https://n.example.cn", fetchImpl: refused }), { ok: false, reason: "notify_connect_failed" });
});
