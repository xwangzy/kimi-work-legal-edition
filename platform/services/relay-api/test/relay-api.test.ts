/**
 * 共享中继服务 v0（第 11 批 S11）：只收受众 relay 的凭据、律所策略不允许即拒绝；块按密文摘要寻址（服务端重算）；
 * 段只能以自己的设备写、块必须先上传、整段摘要按块重算；同一段编号只对应一份内容；
 * 读者名单收窄可见范围（非读者看不到段、取不到块、写不进事项）；纪元加一整体替换读者（被移出的设备从此取不到）；
 * 长轮询有新段即返回；登记落盘、重启读回（写了一半的末行截掉、坏行拒绝启动）；未登记的块 24 小时后清除；存储上限；运营按租户删除。
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devSeatKeyPair, issueSeatToken } from "@zr-legal/seat-token";
import { createRelayApi, RELAY_CHUNK_MAX, RELAY_UNCOMMITTED_TTL_MS, type RelayAccessRecord } from "../src/index.ts";

const { privateKey, publicKey } = devSeatKeyPair();
const keys = new Map([["k1", publicKey]]);
const revoked = new Set<string>();
const allowed = new Set<string>(["t1"]);
const feed = { revokedDevice: (_t: string, d: string) => revoked.has(d), revokedSeat: () => false, shareRelayAllowed: (t: string) => allowed.has(t) };
let clock = Date.parse("2026-10-16T02:00:00.000Z");
const servers: ReturnType<typeof createRelayApi>[] = [];

async function start(dir: string, extra: Partial<Parameters<typeof createRelayApi>[0]> = {}) {
  const s = createRelayApi({ dir, keys, feed, now: () => clock, waitMs: 1_500, ...extra });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return { s, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
}
after(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

const cred = (o: { tid?: string; dev?: string; aud?: string[] | null } = {}) =>
  issueSeatToken(
    { tid: o.tid ?? "t1", uid: `u-${o.dev ?? "devA"}`, sid: `s-${o.dev ?? "devA"}`, dev: o.dev ?? "devA", kid: "k1", ...(o.aud === null ? {} : { aud: o.aud ?? ["relay"] }) },
    privateKey,
    6 * 3600,
    clock,
  );
const A = () => cred({ dev: "devA" });
const B = () => cred({ dev: "devB" });
const C = () => cred({ dev: "devC" });
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const MID = `mat_${randomUUID()}`;

async function call(base: string, method: string, path: string, token: string | null, body?: unknown) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: r.status, json, bytes: Buffer.from(text, "latin1") };
}
async function putChunk(base: string, mid: string, token: string, buf: Buffer, cid = sha(buf)) {
  const r = await fetch(`${base}/v1/relay/matters/${mid}/chunks/${cid}`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" }, body: buf });
  return { status: r.status, json: (await r.json()) as any };
}
async function getChunk(base: string, mid: string, token: string, cid: string) {
  const r = await fetch(`${base}/v1/relay/matters/${mid}/chunks/${cid}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, body: Buffer.from(await r.arrayBuffer()) };
}
/** 上传一段（切成两块）并登记。 */
async function writeSeg(base: string, mid: string, token: string, dev: string, o: { epoch?: number; readers?: string[]; blobs?: Buffer[]; sid?: string } = {}) {
  const seg = randomBytes(5000);
  const parts = [seg.subarray(0, 3000), seg.subarray(3000)];
  const body = {
    segment_id: o.sid ?? `seg_${dev}_${randomBytes(4).toString("hex")}`,
    sha256: sha(seg),
    size: seg.length,
    chunks: parts.map((p) => sha(Buffer.from(p))),
    blob_chunks: (o.blobs ?? []).map(sha),
    epoch: o.epoch ?? 1,
    readers: o.readers ?? ["devA", "devB"],
  };
  // 块上传被拒（非读者）时直接返回那次的结果
  for (const p of [...parts.map((x) => Buffer.from(x)), ...(o.blobs ?? [])]) {
    const put = await putChunk(base, mid, token, p);
    if (put.status !== 200) return { r: { status: put.status, json: put.json, bytes: Buffer.alloc(0) }, body, seg };
  }
  return { r: await call(base, "POST", `/v1/relay/matters/${mid}/segments`, token, body), body, seg };
}

test("RA-01 凭据与律所策略：只收受众 relay；通用令牌、通知凭据、没有凭据都拒绝；律所策略不允许即拒绝", async () => {
  const { base } = await start(mkdtempSync(join(tmpdir(), "kwl-ra-")));
  assert.equal((await call(base, "GET", "/v1/relay/changes/0", null)).status, 401);
  assert.equal((await call(base, "GET", "/v1/relay/changes/0", cred({ aud: null }))).json.error, "credential_audience");
  assert.equal((await call(base, "GET", "/v1/relay/changes/0", cred({ aud: ["notify"] }))).json.error, "credential_audience");
  assert.equal((await call(base, "GET", "/v1/relay/changes/0", cred({ tid: "t2" }))).json.error, "relay_not_allowed", "律所未允许经中继同步");
  revoked.add("devR");
  assert.equal((await call(base, "GET", "/v1/relay/changes/0", cred({ dev: "devR" }))).json.error, "credential_revoked");
  revoked.delete("devR");
  assert.equal((await call(base, "GET", "/v1/relay/changes/0", A())).status, 200);
  // 请求行原样匹配：查询串、编码、.. 一律不认
  for (const p of ["/v1/relay/changes/0?x=1", "/v1/relay/changes/%30", `/v1/relay/matters/${MID}/../x`]) assert.equal((await call(base, "GET", p, A())).status, 404, p);
  // 生产形态不得跳过律所策略核对
  assert.throws(() => createRelayApi({ dir: mkdtempSync(join(tmpdir(), "kwl-ra-")), keys, production: true }));
  assert.throws(() => createRelayApi({ dir: mkdtempSync(join(tmpdir(), "kwl-ra-")), keys, feed, production: true, allowAllTenants: true }));
});

test("RA-02 块：服务端按实际字节重算摘要；超过 4 MiB 拒绝；重传幂等；have 只报缺的", async () => {
  const { base, s } = await start(mkdtempSync(join(tmpdir(), "kwl-ra-")));
  const mid = `mat_${randomUUID()}`;
  const buf = randomBytes(1000);
  assert.equal((await putChunk(base, mid, A(), buf, sha(randomBytes(10)))).json.error, "chunk_digest_mismatch");
  assert.equal((await putChunk(base, mid, A(), buf)).json.existed, false);
  assert.equal((await putChunk(base, mid, A(), buf)).json.existed, true);
  assert.equal(s.tenant("t1")!.bytes, 1000, "重传不重复计入占用");
  // 超限：服务端不读请求体即回 413 并关闭连接——客户端可能先收到 413，也可能在写请求体时被断开（两者都是拒绝）
  const big = randomBytes(RELAY_CHUNK_MAX + 1);
  const rejected = await putChunk(base, mid, A(), big).then(
    (r) => r.status,
    (e: any) => String(e?.cause?.code ?? e?.code ?? "reset"),
  );
  assert.ok([413, "EPIPE", "ECONNRESET", "UND_ERR_SOCKET", "reset"].includes(rejected as never), String(rejected));
  assert.equal(s.tenant("t1")!.bytes, 1000, "超限的块没有写入");
  const other = sha(randomBytes(8));
  assert.deepEqual((await call(base, "POST", `/v1/relay/matters/${mid}/have`, A(), { cids: [sha(buf), other] })).json.missing, [other]);
  assert.equal((await call(base, "POST", `/v1/relay/matters/${mid}/have`, A(), { cids: [sha(buf)], note: "x" })).status, 400, "多一个字段即拒绝");
  assert.equal((await putChunk(base, "mat_x", A(), buf)).status, 400, "事项编号格式不符");
});

test("RA-03 段登记：只能以自己的设备写；块须先上传；整段摘要按块重算；同一段编号只对应一份内容；写入者须在读者里", async () => {
  const { base } = await start(mkdtempSync(join(tmpdir(), "kwl-ra-")));
  const mid = `mat_${randomUUID()}`;
  const ok = await writeSeg(base, mid, A(), "devA");
  assert.equal(ok.r.status, 200, JSON.stringify(ok.r.json));
  assert.equal(ok.r.json.seq, 1);
  // 原样重发幂等；同编号不同内容拒绝
  assert.equal((await call(base, "POST", `/v1/relay/matters/${mid}/segments`, A(), ok.body)).json.existed, true);
  const seg2 = await writeSeg(base, mid, A(), "devA", { sid: ok.body.segment_id });
  assert.equal(seg2.r.json.error, "segment_conflict");
  // 冒用别的设备的段编号
  const forged = await writeSeg(base, mid, B(), "devA");
  assert.equal(forged.r.json.error, "segment_id_invalid");
  // 块没上传
  assert.equal((await call(base, "POST", `/v1/relay/matters/${mid}/segments`, A(), { ...ok.body, segment_id: "seg_devA_x1", chunks: [sha(randomBytes(9))] })).json.error, "chunk_missing");
  // 摘要与块对不上
  assert.equal((await call(base, "POST", `/v1/relay/matters/${mid}/segments`, A(), { ...ok.body, segment_id: "seg_devA_x2", sha256: sha(randomBytes(9)) })).json.error, "segment_digest_mismatch");
  assert.equal((await call(base, "POST", `/v1/relay/matters/${mid}/segments`, A(), { ...ok.body, segment_id: "seg_devA_x3", size: ok.body.size + 1 })).json.error, "segment_digest_mismatch");
  // 写入者不在自己声明的读者里
  assert.equal((await call(base, "POST", `/v1/relay/matters/${mid}/segments`, A(), { ...ok.body, segment_id: "seg_devA_x4", readers: ["devB"] })).json.error, "writer_not_reader");
  // 明文字段不收
  assert.equal((await call(base, "POST", `/v1/relay/matters/${mid}/segments`, A(), { ...ok.body, segment_id: "seg_devA_x5", title: "某某案" })).json.error, "body_invalid");
});

test("RA-04 读者收窄：非读者看不到段、取不到块、写不进事项；读者取得到登记过的块，未登记的块取不到；按事项取历史", async () => {
  const { base } = await start(mkdtempSync(join(tmpdir(), "kwl-ra-")));
  const mid = `mat_${randomUUID()}`;
  const blob = randomBytes(2048);
  const w = await writeSeg(base, mid, A(), "devA", { blobs: [blob] });
  assert.equal(w.r.status, 200);
  const fb = await call(base, "GET", "/v1/relay/changes/0", B());
  assert.equal(fb.json.items.length, 1);
  assert.equal(fb.json.items[0].matter_id, mid);
  assert.deepEqual(Object.keys(fb.json.items[0]).sort(), ["chunks", "matter_id", "segment_id", "seq", "sha256", "size"], "条目里没有读者名单与块清单以外的内容");
  const got = Buffer.concat(await Promise.all(fb.json.items[0].chunks.map(async (cid: string) => (await getChunk(base, mid, B(), cid)).body)));
  assert.equal(sha(got), w.body.sha256);
  assert.equal(sha((await getChunk(base, mid, B(), sha(blob))).body), sha(blob), "段引用的密文块可取");
  // 非读者
  const fc = await call(base, "GET", "/v1/relay/changes/0", C());
  assert.equal(fc.json.items.length, 0);
  assert.equal(fc.json.next, 1, "游标照常前进");
  assert.equal((await getChunk(base, mid, C(), sha(blob))).status, 403);
  assert.equal((await call(base, "GET", `/v1/relay/matters/${mid}/segments/0`, C())).status, 403);
  assert.equal((await putChunk(base, mid, C(), randomBytes(10))).status, 403);
  assert.equal((await writeSeg(base, mid, C(), "devC", { readers: ["devC"] })).r.status, 403);
  // 未被登记段引用的块：读者也取不到
  const loose = randomBytes(64);
  await putChunk(base, mid, A(), loose);
  assert.equal((await getChunk(base, mid, B(), sha(loose))).status, 404);
  // 新成员取历史
  const h = await call(base, "GET", `/v1/relay/matters/${mid}/segments/0`, B());
  assert.equal(h.json.items.length, 1);
});

test("RA-05 纪元：加一整体替换读者（被移出的设备从此取不到）；持平取并集；跳号拒绝", async () => {
  const { base } = await start(mkdtempSync(join(tmpdir(), "kwl-ra-")));
  const mid = `mat_${randomUUID()}`;
  const first = await writeSeg(base, mid, A(), "devA", { readers: ["devA", "devB"] });
  assert.equal(first.r.status, 200);
  assert.equal((await writeSeg(base, mid, B(), "devB", { epoch: 1, readers: ["devB", "devC"] })).r.status, 200, "持平取并集");
  assert.equal((await call(base, "GET", "/v1/relay/changes/0", C())).json.items.length, 2);
  assert.equal((await writeSeg(base, mid, A(), "devA", { epoch: 3, readers: ["devA"] })).r.json.error, "epoch_jump");
  const rot = await writeSeg(base, mid, A(), "devA", { epoch: 2, readers: ["devA", "devB"] });
  assert.equal(rot.r.status, 200);
  assert.equal((await call(base, "GET", "/v1/relay/changes/0", C())).json.items.length, 0, "被移出的设备看不到任何段（含旧段）");
  assert.equal((await getChunk(base, mid, C(), first.body.chunks[0]!)).status, 403);
  assert.equal((await writeSeg(base, mid, C(), "devC", { epoch: 2, readers: ["devC"] })).r.json.error, "not_reader");
  // 旧纪元的迟到段不改读者
  assert.equal((await writeSeg(base, mid, B(), "devB", { epoch: 1, readers: ["devB", "devC"] })).r.status, 200);
  assert.equal((await call(base, "GET", "/v1/relay/changes/0", C())).json.items.length, 0);
});

test("RA-06 长轮询：没有新段时等待，有新登记立即返回；超时返回空", async () => {
  const { base } = await start(mkdtempSync(join(tmpdir(), "kwl-ra-")));
  const mid = `mat_${randomUUID()}`;
  const t0 = Date.now();
  const idle = await call(base, "GET", "/v1/relay/changes/0/wait", B());
  assert.equal(idle.json.items.length, 0);
  assert.ok(Date.now() - t0 >= 1_000, "等到超时");
  const waiting = call(base, "GET", "/v1/relay/changes/0/wait", B());
  await new Promise((r) => setTimeout(r, 200));
  const t1 = Date.now();
  await writeSeg(base, mid, A(), "devA");
  const got = await waiting;
  assert.equal(got.json.items.length, 1);
  assert.ok(Date.now() - t1 < 1_000, "有新段即返回");
});

test("RA-07 落盘与读回：重启后段与读者照旧；写了一半的末行截掉；坏行拒绝启动；未登记的块 24 小时后清除；残留临时文件删除", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-ra-"));
  const { base, s } = await start(dir);
  const mid = `mat_${randomUUID()}`;
  const w = await writeSeg(base, mid, A(), "devA");
  const loose = randomBytes(77);
  await putChunk(base, mid, A(), loose);
  s.closeAllConnections();
  await new Promise<void>((r) => s.close(() => r()));
  const jp = join(dir, "t", "t1", "journal.jsonl");
  appendFileSync(jp, '{"seq":2,"mid":"half');
  writeFileSync(join(dir, "t", "t1", "m", mid, ".tmp-abc"), "x");
  const again = await start(dir);
  assert.equal(again.s.tenant("t1")!.entries.length, 1);
  assert.ok(readFileSync(jp, "utf8").endsWith("\n"), "末行已截掉");
  assert.ok(!existsSync(join(dir, "t", "t1", "m", mid, ".tmp-abc")));
  assert.equal((await call(again.base, "GET", "/v1/relay/changes/0", B())).json.items[0].segment_id, w.body.segment_id);
  // 未登记的块：24 小时后清扫
  utimesSync(join(dir, "t", "t1", "m", mid, sha(loose)), new Date(clock - RELAY_UNCOMMITTED_TTL_MS - 60_000), new Date(clock - RELAY_UNCOMMITTED_TTL_MS - 60_000));
  const third = await start(dir);
  assert.ok(!third.s.tenant("t1")!.chunkFiles.includes(`${mid}/${sha(loose)}`), "残留块已删");
  assert.ok(third.s.tenant("t1")!.chunkFiles.includes(`${mid}/${w.body.chunks[0]}`), "登记过的块保留");
  // 坏行：拒绝启动
  appendFileSync(jp, '{"seq":9}\n');
  assert.throws(() => createRelayApi({ dir, keys, feed }), /不合格/);
});

test("RA-08 存储上限：超出租户上限即拒绝", async () => {
  const { base } = await start(mkdtempSync(join(tmpdir(), "kwl-ra-")), { tenantMaxBytes: 4096 });
  const mid = `mat_${randomUUID()}`;
  assert.equal((await putChunk(base, mid, A(), randomBytes(3000))).status, 200);
  assert.equal((await putChunk(base, mid, A(), randomBytes(3000))).json.error, "tenant_storage_full");
});

test("RA-09 运营按租户整体删除：须运营凭据与操作人，先记访问审计", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-ra-"));
  const log: RelayAccessRecord[] = [];
  const opsSecret = "ops-secret-0123456789";
  const { base } = await start(dir, { opsSecret, accessLog: (r) => void log.push(r) });
  const mid = `mat_${randomUUID()}`;
  await writeSeg(base, mid, A(), "devA");
  const del = (h: Record<string, string>) => fetch(`${base}/v1/relay/ops/tenants/t1`, { method: "DELETE", headers: h }).then(async (r) => ({ status: r.status, json: (await r.json()) as any }));
  assert.equal((await del({ authorization: "Bearer wrong-secret-0123456" })).status, 401);
  assert.equal((await del({ authorization: `Bearer ${opsSecret}` })).json.error, "operator_required");
  assert.equal((await del({ authorization: `Bearer ${opsSecret}`, "x-kwl-operator": "ops.zhang" })).status, 200);
  assert.equal(log.length, 1);
  assert.equal(log[0]!.operator, "ops.zhang");
  assert.ok(!existsSync(join(dir, "t", "t1")));
  assert.equal((await call(base, "GET", "/v1/relay/changes/0", B())).json.items.length, 0);
  void readdirSync;
  void request;
});
