/**
 * 共享中继通道（第 11 批 S11）：只有六种固定请求；请求由闸门按固定字段重新拼出（多出的内容不发出）；凭据须为中继专用（受众 relay）；
 * 块摘要在上传（按实际字节）与取回（按收到的字节）两头由闸门重算；地址固定、不跟随跳转；响应有上限；未配置即不发。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { relayShare, shareRelayAllowed, type ShareRelayRequest } from "../src/index.ts";

const credOf = (aud: string[] | undefined) =>
  `zst1.${Buffer.from(JSON.stringify({ tid: "t", uid: "u", sid: "s", dev: "d", kid: "k", iat: 1, exp: 2, ...(aud ? { aud } : {}) })).toString("base64url")}.${"s".repeat(86)}`;
const credential = credOf(["relay"]);
const MID = `mat_${randomUUID()}`;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const chunk = randomBytes(1000);
const CID = sha(chunk);
const commit: ShareRelayRequest = {
  step: "commit",
  credential,
  matter_id: MID,
  segment_id: "seg_dev_a_lk3abc_abcdef12",
  sha256: CID,
  size: 1000,
  chunks: [CID],
  blob_chunks: [],
  epoch: 1,
  readers: ["dev_a", "dev_b"],
  gen: 0,
  instance: "",
};

test("形状：六种请求合格；凭据须受众 relay；多一个字段、明文字段、坏编号一律不合格", () => {
  assert.equal(shareRelayAllowed(commit), null);
  assert.equal(shareRelayAllowed({ step: "have", credential, matter_id: MID, cids: [CID] }), null);
  assert.equal(shareRelayAllowed({ step: "put_chunk", credential, matter_id: MID, cid: CID, body_b64: chunk.toString("base64") }), null);
  assert.equal(shareRelayAllowed({ step: "changes", credential, since: 0, wait: true }), null);
  assert.equal(shareRelayAllowed({ step: "history", credential, matter_id: MID, since: 3 }), null);
  assert.equal(shareRelayAllowed({ step: "get_chunk", credential, matter_id: MID, cid: CID }), null);
  assert.equal(shareRelayAllowed({ ...commit, credential: credOf(undefined) }), "relay_credential_audience", "通用席位令牌不发往中继");
  assert.equal(shareRelayAllowed({ ...commit, credential: credOf(["notify"]) }), "relay_credential_audience");
  assert.equal(shareRelayAllowed({ ...commit, title: "某某案" }), "relay_request_invalid", "明文字段不收");
  assert.equal(shareRelayAllowed({ ...commit, matter_id: "mat_../../x" }), "relay_matter_invalid");
  assert.equal(shareRelayAllowed({ ...commit, readers: ["dev a"] }), "relay_readers_invalid");
  assert.equal(shareRelayAllowed({ ...commit, readers: ["d", "d"] }), "relay_readers_invalid");
  assert.equal(shareRelayAllowed({ ...commit, chunks: [] }), "relay_cid_invalid");
  assert.equal(shareRelayAllowed({ ...commit, gen: -1 }), "relay_request_invalid", "重置代数须为非负整数");
  assert.equal(shareRelayAllowed({ ...commit, instance: "x".repeat(24) }), "relay_request_invalid", "实例编号须为 24 位十六进制或空串");
  assert.equal(shareRelayAllowed({ ...commit, blob_chunks: ["abc"] }), "relay_cid_invalid");
  assert.equal(shareRelayAllowed({ step: "changes", credential, since: -1, wait: false }), "relay_cursor_invalid");
  assert.equal(shareRelayAllowed({ step: "put_chunk", credential, matter_id: MID, cid: CID, body_b64: "不是base64" }), "relay_chunk_invalid");
});

test("固定路径与方法；请求由闸门重拼；上传块按实际字节重算摘要（不符不发）；取块按收到的字节重算（云端换内容即失败）", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  let reply: () => Response = () => new Response('{"ok":true}', { status: 200 });
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return reply();
  }) as unknown as typeof fetch;
  const o = { baseUrl: "https://relay.example-zr.cn/api/", fetchImpl };
  const sneaky = Object.assign(Object.create({ title: "某某案" }), commit);
  assert.equal((await relayShare(sneaky, o)).ok, true);
  assert.equal(seen[0]!.url, `https://relay.example-zr.cn/api/v1/relay/matters/${MID}/segments`);
  assert.equal(seen[0]!.init.redirect, "error");
  assert.equal((seen[0]!.init.headers as Record<string, string>).authorization, `Bearer ${credential}`);
  assert.deepEqual(Object.keys(JSON.parse(String(seen[0]!.init.body))).sort(), ["blob_chunks", "chunks", "epoch", "gen", "instance", "readers", "segment_id", "sha256", "size"]);
  // 上传块：摘要不符不发
  const before = seen.length;
  assert.deepEqual(await relayShare({ step: "put_chunk", credential, matter_id: MID, cid: sha(randomBytes(5)), body_b64: chunk.toString("base64") }, o), { ok: false, reason: "relay_chunk_digest_mismatch" });
  assert.equal(seen.length, before);
  assert.equal((await relayShare({ step: "put_chunk", credential, matter_id: MID, cid: CID, body_b64: chunk.toString("base64") }, o)).ok, true);
  assert.equal(seen.at(-1)!.init.method, "PUT");
  assert.ok(Buffer.from(seen.at(-1)!.init.body as Uint8Array).equals(chunk));
  await relayShare({ step: "changes", credential, since: 7, wait: true }, o);
  await relayShare({ step: "history", credential, matter_id: MID, since: 0 }, o);
  await relayShare({ step: "have", credential, matter_id: MID, cids: [CID] }, o);
  assert.deepEqual(
    seen.slice(-3).map((x) => [x.init.method, x.url.replace("https://relay.example-zr.cn/api", "")]),
    [
      ["GET", "/v1/relay/changes/7/wait"],
      ["GET", `/v1/relay/matters/${MID}/segments/0`],
      ["POST", `/v1/relay/matters/${MID}/have`],
    ],
  );
  // 取块：内容对得上才交回内核
  reply = () => new Response(new Uint8Array(chunk), { status: 200 });
  const good = await relayShare({ step: "get_chunk", credential, matter_id: MID, cid: CID }, o);
  assert.ok(good.ok && Buffer.from(good.body_b64!, "base64").equals(chunk));
  reply = () => new Response(new Uint8Array(randomBytes(1000)), { status: 200 });
  assert.deepEqual(await relayShare({ step: "get_chunk", credential, matter_id: MID, cid: CID }, o), { ok: false, reason: "relay_chunk_digest_mismatch" });
});

test("未配置不发；形状不合格不发；响应超限报错；连接被拒报“确定没有送出”", async () => {
  let called = 0;
  const fetchImpl = (async () => {
    called++;
    return new Response("x".repeat(2 * 1024 * 1024 + 10), { status: 200 });
  }) as unknown as typeof fetch;
  assert.deepEqual(await relayShare(commit, { baseUrl: null, fetchImpl }), { ok: false, reason: "relay_not_configured" });
  assert.deepEqual(await relayShare({ ...commit, epoch: 0 }, { baseUrl: "https://r.example.cn", fetchImpl }), { ok: false, reason: "relay_epoch_invalid" });
  assert.equal(called, 0);
  assert.deepEqual(await relayShare({ step: "changes", credential, since: 0, wait: false }, { baseUrl: "https://r.example.cn", fetchImpl }), { ok: false, reason: "relay_response_too_large" });
  const refused = (async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  }) as unknown as typeof fetch;
  assert.deepEqual(await relayShare({ step: "changes", credential, since: 0, wait: false }, { baseUrl: "https://r.example.cn", fetchImpl: refused }), { ok: false, reason: "relay_connect_failed" });
});
