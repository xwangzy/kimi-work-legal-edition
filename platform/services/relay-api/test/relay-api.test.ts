/**
 * 共享中继服务 v0（第 11 批 S11；含两路复核处置）：只收受众 relay 的凭据、律所策略不允许即拒绝；块按密文摘要寻址（服务端重算）；
 * 段编号须为“seg_<设备>_<时间>_<8 位十六进制>”完整格式（前缀相同的设备不混淆）；块须先上传、整段摘要按块重算；同一段编号只对应一份内容；
 * 读者名单收窄可见范围；只有控制成员（第一个登记的成员）能提升纪元（可跳级），提升即整体替换读者；其他读者不能劫持或锁死；
 * 长轮询只唤醒该事项的其他读者；登记落盘、重启读回；写入失败截回原长度；某租户日志损坏只影响该租户；
 * 未登记的块 24 小时后清除、按设备设上限；存储上限；运营按租户删除、按事项重置。
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devSeatKeyPair, issueSeatToken } from "@zr-legal/seat-token";
import { createRelayApi, RELAY_CHUNK_MAX, RELAY_UNCOMMITTED_TTL_MS, segmentOwnedBy, type RelayAccessRecord } from "../src/index.ts";

const { privateKey, publicKey } = devSeatKeyPair();
const keys = new Map([["k1", publicKey]]);
const revoked = new Set<string>();
const allowed = new Set<string>(["t1", "t3"]);
const feed = { revokedDevice: (_t: string, d: string) => revoked.has(d), revokedSeat: () => false, shareRelayAllowed: (t: string) => allowed.has(t) };
const clock = Date.parse("2026-10-16T02:00:00.000Z");
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

/** 设备 devX 属于成员 u-devX（凭据里的成员编号由控制面写入，不是自报）。 */
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
const sidOf = (dev: string) => `seg_${dev}_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;

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
  return { status: r.status, json };
}
async function putChunk(base: string, mid: string, token: string, buf: Buffer, cid = sha(buf)) {
  const r = await fetch(`${base}/v1/relay/matters/${mid}/chunks/${cid}`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" }, body: buf });
  return { status: r.status, json: (await r.json()) as any };
}
async function getChunk(base: string, mid: string, token: string, cid: string) {
  const r = await fetch(`${base}/v1/relay/matters/${mid}/chunks/${cid}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, body: Buffer.from(await r.arrayBuffer()) };
}
/** 上传一段（切成两块）并登记；块上传被拒（非读者）时直接返回那次的结果。 */
async function writeSeg(base: string, mid: string, token: string, dev: string, o: { epoch?: number; readers?: string[]; blobs?: Buffer[]; sid?: string; gen?: number } = {}) {
  const seg = randomBytes(5000);
  const parts = [seg.subarray(0, 3000), seg.subarray(3000)];
  const body = {
    segment_id: o.sid ?? sidOf(dev),
    sha256: sha(seg),
    size: seg.length,
    chunks: parts.map((p) => sha(Buffer.from(p))),
    blob_chunks: (o.blobs ?? []).map(sha),
    epoch: o.epoch ?? 1,
    readers: o.readers ?? ["devA", "devB"],
    ...(o.gen !== undefined ? { gen: o.gen } : {}),
  };
  for (const p of [...parts.map((x) => Buffer.from(x)), ...(o.blobs ?? [])]) {
    const put = await putChunk(base, mid, token, p);
    if (put.status !== 200) return { r: { status: put.status, json: put.json }, body, seg };
  }
  return { r: await call(base, "POST", `/v1/relay/matters/${mid}/segments`, token, body), body, seg };
}
const newMid = () => `mat_${randomUUID()}`;

test("RA-01 凭据与律所策略：只收受众 relay；通用令牌、通知凭据、没有凭据都拒绝；律所策略不允许即拒绝", async () => {
  const { base } = await start(mkdtempSync(join(tmpdir(), "kwl-ra-")));
  assert.equal((await call(base, "GET", "/v1/relay/changes/0", null)).status, 401);
  assert.equal((await call(base, "GET", "/v1/relay/changes/0", cred({ aud: null }))).json.error, "credential_audience");
  assert.equal((await call(base, "GET", "/v1/relay/changes/0", cred({ aud: ["notify"] }))).json.error, "credential_audience");
  assert.equal((await call(base, "GET", "/v1/relay/changes/0", cred({ tid: "t2" }))).json.error, "relay_not_allowed", "律所未允许经中继同步");
  revoked.add("devR");
  assert.equal((await call(base, "GET", "/v1/relay/changes/0", cred({ dev: "devR" }))).json.error, "credential_revoked");
  revoked.delete("devR");
  const ok = await call(base, "GET", "/v1/relay/changes/0", A());
  assert.equal(ok.status, 200);
  assert.equal("head" in ok.json, false, "不回全所登记总数（复核 S11A-12）");
  assert.match(ok.json.instance, /^[0-9a-f]{24}$/, "带中继实例编号（复核 S11B-13）");
  for (const p of ["/v1/relay/changes/0?x=1", "/v1/relay/changes/%30", `/v1/relay/matters/${newMid()}/../x`]) assert.equal((await call(base, "GET", p, A())).status, 404, p);
  assert.throws(() => createRelayApi({ dir: mkdtempSync(join(tmpdir(), "kwl-ra-")), keys, production: true }));
  assert.throws(() => createRelayApi({ dir: mkdtempSync(join(tmpdir(), "kwl-ra-")), keys, feed, production: true, allowAllTenants: true }));
});

test("RA-02 块：服务端按实际字节重算摘要；超过 4 MiB 拒绝；重传幂等；have 只报缺的；未登记字节按设备设上限", async () => {
  const { base, s } = await start(mkdtempSync(join(tmpdir(), "kwl-ra-")), { devicePendingBytes: 4000 });
  const mid = newMid();
  const buf = randomBytes(1000);
  assert.equal((await putChunk(base, mid, A(), buf, sha(randomBytes(10)))).json.error, "chunk_digest_mismatch");
  assert.equal(s.tenant("t1")!.bytes, 0, "被拒的块不占用");
  assert.equal((await putChunk(base, mid, A(), buf)).json.existed, false);
  assert.equal((await putChunk(base, mid, A(), buf)).json.existed, true);
  assert.equal(s.tenant("t1")!.bytes, 1000, "重传不重复计入占用");
  // 超限：服务端不读请求体即回 413 并关闭连接——客户端可能先收到 413，也可能在写请求体时被断开（两者都是拒绝）
  const rejected = await putChunk(base, mid, A(), randomBytes(RELAY_CHUNK_MAX + 1)).then(
    (r) => r.status,
    (e: any) => String(e?.cause?.code ?? e?.code ?? "reset"),
  );
  assert.ok([413, "EPIPE", "ECONNRESET", "UND_ERR_SOCKET", "reset"].includes(rejected as never), String(rejected));
  assert.equal(s.tenant("t1")!.bytes, 1000, "超限的块没有写入");
  const other = sha(randomBytes(8));
  assert.deepEqual((await call(base, "POST", `/v1/relay/matters/${mid}/have`, A(), { cids: [sha(buf), other] })).json.missing, [other]);
  assert.equal((await call(base, "POST", `/v1/relay/matters/${mid}/have`, A(), { cids: [sha(buf)], note: "x" })).status, 400, "多一个字段即拒绝");
  assert.equal((await putChunk(base, "mat_x", A(), buf)).status, 400, "事项编号格式不符");
  // 复核 S11A-07：同一设备未登记的字节有上限（另一台设备不受影响）
  assert.equal((await putChunk(base, newMid(), A(), randomBytes(2500))).status, 200);
  assert.equal((await putChunk(base, newMid(), A(), randomBytes(2500))).json.error, "device_pending_full");
  assert.equal((await putChunk(base, newMid(), B(), randomBytes(2500))).status, 200);
});

test("RA-03 段登记：段编号完整格式、只能以自己的设备写（前缀相同的设备不混淆）；块须先上传；整段摘要按块重算；同一段编号只对应一份内容", async () => {
  const { base } = await start(mkdtempSync(join(tmpdir(), "kwl-ra-")));
  const mid = newMid();
  const ok = await writeSeg(base, mid, A(), "devA");
  assert.equal(ok.r.status, 200, JSON.stringify(ok.r.json));
  assert.equal(ok.r.json.seq, 1);
  assert.equal((await call(base, "POST", `/v1/relay/matters/${mid}/segments`, A(), ok.body)).json.existed, true);
  assert.equal((await writeSeg(base, mid, A(), "devA", { sid: ok.body.segment_id })).r.json.error, "segment_conflict");
  assert.equal((await writeSeg(base, mid, B(), "devA")).r.json.error, "segment_id_invalid", "冒用别的设备的段编号");
  // 复核 S11B-02、S11A-14：devA 不能写出看似 devA_2 的段编号；devA_2 的段编号也不算 devA 的
  assert.equal(segmentOwnedBy("seg_devA_2_lk3_abcdef12", "devA"), false);
  assert.equal(segmentOwnedBy("seg_devA_2_lk3_abcdef12", "devA_2"), true);
  assert.equal((await writeSeg(base, mid, A(), "devA", { sid: "seg_devA_2_lk3_abcdef12" })).r.json.error, "segment_id_invalid");
  assert.equal((await writeSeg(base, mid, A(), "devA", { sid: "seg_devA_x1" })).r.json.error, "segment_id_invalid", "格式不全");
  const sid = () => sidOf("devA");
  assert.equal((await call(base, "POST", `/v1/relay/matters/${mid}/segments`, A(), { ...ok.body, segment_id: sid(), chunks: [sha(randomBytes(9))] })).json.error, "chunk_missing");
  assert.equal((await call(base, "POST", `/v1/relay/matters/${mid}/segments`, A(), { ...ok.body, segment_id: sid(), sha256: sha(randomBytes(9)) })).json.error, "segment_digest_mismatch");
  assert.equal((await call(base, "POST", `/v1/relay/matters/${mid}/segments`, A(), { ...ok.body, segment_id: sid(), size: ok.body.size + 1 })).json.error, "segment_digest_mismatch");
  assert.equal((await call(base, "POST", `/v1/relay/matters/${mid}/segments`, A(), { ...ok.body, segment_id: sid(), readers: ["devB"] })).json.error, "writer_not_reader");
  assert.equal((await call(base, "POST", `/v1/relay/matters/${mid}/segments`, A(), { ...ok.body, segment_id: sid(), title: "某某案" })).json.error, "body_invalid");
});

test("RA-04 读者收窄：非读者看不到段、取不到块、写不进事项；读者取得到登记过的块，未登记的块取不到；历史：中继上没有的事项回 matter_unknown", async () => {
  const { base } = await start(mkdtempSync(join(tmpdir(), "kwl-ra-")));
  const mid = newMid();
  const blob = randomBytes(2048);
  assert.equal((await call(base, "GET", `/v1/relay/matters/${mid}/segments/0`, A())).json.error, "matter_unknown");
  const w = await writeSeg(base, mid, A(), "devA", { blobs: [blob] });
  assert.equal(w.r.status, 200);
  const fb = await call(base, "GET", "/v1/relay/changes/0", B());
  assert.equal(fb.json.items.length, 1);
  assert.deepEqual(Object.keys(fb.json.items[0]).sort(), ["chunks", "dev", "gen", "matter_id", "segment_id", "seq", "sha256", "size"], "条目带写入设备（客户端按它精确判断本机自产）与重置代数");
  assert.equal(fb.json.items[0].dev, "devA");
  const got = Buffer.concat(await Promise.all(fb.json.items[0].chunks.map(async (cid: string) => (await getChunk(base, mid, B(), cid)).body)));
  assert.equal(sha(got), w.body.sha256);
  assert.equal(sha((await getChunk(base, mid, B(), sha(blob))).body), sha(blob), "段引用的密文块可取");
  const fc = await call(base, "GET", "/v1/relay/changes/0", C());
  assert.equal(fc.json.items.length, 0);
  assert.equal((await getChunk(base, mid, C(), sha(blob))).status, 403);
  assert.equal((await call(base, "GET", `/v1/relay/matters/${mid}/segments/0`, C())).json.error, "not_reader");
  assert.equal((await putChunk(base, mid, C(), randomBytes(10))).status, 403);
  assert.equal((await writeSeg(base, mid, C(), "devC", { readers: ["devC"] })).r.status, 403);
  const loose = randomBytes(64);
  await putChunk(base, mid, A(), loose);
  assert.equal((await getChunk(base, mid, B(), sha(loose))).status, 404);
  const hb = await call(base, "GET", `/v1/relay/matters/${mid}/segments/0`, B());
  assert.equal(hb.json.items.length, 1);
  assert.equal(hb.json.controller, "u-devA", "取历史回告控制成员（复核 S11B-19）");
  assert.equal(w.r.json.controller, "u-devA", "登记回告控制成员");
});

test("RA-05 控制成员与纪元（复核 S11A-03、S11B-01）：只有控制成员能提升纪元且可跳级；其他读者声明更高纪元可恢复地拒绝；不能劫持或锁死", async () => {
  const { base, s } = await start(mkdtempSync(join(tmpdir(), "kwl-ra-")));
  const mid = newMid();
  assert.equal((await writeSeg(base, mid, A(), "devA", { readers: ["devA", "devB", "devC"] })).r.status, 200);
  assert.equal(s.tenant("t1")!.controller(mid), "u-devA", "控制成员取自凭据");
  // 将被移出的 C 抢先声明更高纪元、或任一读者把读者改成只有自己：都被拒（可恢复的 409，不改读者）
  assert.equal((await writeSeg(base, mid, C(), "devC", { epoch: 2, readers: ["devA", "devB", "devC"] })).r.json.error, "epoch_not_established");
  assert.equal((await writeSeg(base, mid, B(), "devB", { epoch: 5, readers: ["devB"] })).r.json.error, "epoch_not_established");
  // 持平纪元：其他读者照常登记，但不能加读者（第二轮复核 S11A-25）；控制成员能加
  const D = () => cred({ dev: "devD" });
  assert.equal((await writeSeg(base, mid, B(), "devB", { epoch: 1, readers: ["devB", "devA", "devD"] })).r.status, 200);
  assert.equal((await call(base, "GET", "/v1/relay/changes/0", C())).json.items.length, 2);
  assert.equal((await call(base, "GET", "/v1/relay/changes/0", D())).json.items.length, 0, "非控制成员加不进读者");
  assert.equal((await writeSeg(base, mid, A(), "devA", { epoch: 1, readers: ["devA", "devD"] })).r.status, 200);
  assert.equal((await call(base, "GET", "/v1/relay/changes/0", D())).json.items.length, 3, "控制成员加人后可见");
  // 负责人离线期间连续移出两人（纪元 1 → 3）：跳级照常登记
  const rot = await writeSeg(base, mid, A(), "devA", { epoch: 3, readers: ["devA", "devB"] });
  assert.equal(rot.r.status, 200, JSON.stringify(rot.r.json));
  assert.equal((await call(base, "GET", "/v1/relay/changes/0", C())).json.items.length, 0, "被移出的设备看不到任何段（含旧段）");
  assert.equal((await call(base, "GET", "/v1/relay/changes/0", D())).json.items.length, 0);
  assert.equal((await getChunk(base, mid, C(), rot.body.chunks[0]!)).status, 403);
  assert.equal((await writeSeg(base, mid, C(), "devC", { epoch: 3, readers: ["devC"] })).r.status, 403);
  // 旧纪元的迟到段不改读者
  assert.equal((await writeSeg(base, mid, B(), "devB", { epoch: 1, readers: ["devB", "devC"] })).r.status, 200);
  assert.equal((await call(base, "GET", "/v1/relay/changes/0", C())).json.items.length, 0);
  // 新纪元下其他读者持平登记照常
  assert.equal((await writeSeg(base, mid, B(), "devB", { epoch: 3, readers: ["devB", "devA"] })).r.status, 200);
});

test("RA-06 长轮询：只唤醒该事项的其他读者；有新登记立即返回；超时返回空；挂起数有上限", async () => {
  const { base } = await start(mkdtempSync(join(tmpdir(), "kwl-ra-")));
  const mid = newMid();
  const t0 = Date.now();
  const idle = await call(base, "GET", "/v1/relay/changes/0/wait", B());
  assert.equal(idle.json.items.length, 0);
  assert.ok(Date.now() - t0 >= 1_000, "等到超时");
  const waitingB = call(base, "GET", "/v1/relay/changes/0/wait", B());
  const tC = Date.now();
  const waitingC = call(base, "GET", "/v1/relay/changes/0/wait", C());
  await new Promise((r) => setTimeout(r, 200));
  const t1 = Date.now();
  await writeSeg(base, mid, A(), "devA", { readers: ["devA", "devB"] });
  const got = await waitingB;
  assert.equal(got.json.items.length, 1);
  assert.ok(Date.now() - t1 < 1_000, "有新段即返回");
  await waitingC;
  assert.ok(Date.now() - tC >= 1_400, "不是读者的设备不被唤醒");
  // 每台设备至多 4 个挂起的长轮询：第 5 个立即返回
  const hold = [1, 2, 3, 4].map(() => call(base, "GET", "/v1/relay/changes/1/wait", B()));
  await new Promise((r) => setTimeout(r, 100));
  const t2 = Date.now();
  await call(base, "GET", "/v1/relay/changes/1/wait", B());
  assert.ok(Date.now() - t2 < 800, "超出上限立即返回");
  await Promise.all(hold);
});

test("RA-07 落盘与读回：重启后段、读者与控制成员照旧；写了一半的末行截掉；坏行只让该租户不可用；未登记的块 24 小时后清除；残留临时文件删除", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-ra-"));
  const { base, s } = await start(dir);
  const mid = newMid();
  const w = await writeSeg(base, mid, A(), "devA");
  const loose = randomBytes(77);
  await putChunk(base, mid, A(), loose);
  await writeSeg(base, newMid(), cred({ tid: "t3", dev: "devZ" }), "devZ", { readers: ["devZ"] });
  const inst = s.instance;
  s.closeAllConnections();
  await new Promise<void>((r) => s.close(() => r()));
  const jp = join(dir, "t", "t1", "journal.jsonl");
  appendFileSync(jp, '{"seq":2,"mid":"half');
  writeFileSync(join(dir, "t", "t1", "m", mid, ".tmp-abc"), "x");
  const again = await start(dir);
  assert.equal(again.s.instance, inst, "实例编号不随重启变化");
  assert.equal(again.s.tenant("t1")!.entries.length, 1);
  assert.equal(again.s.tenant("t1")!.controller(mid), "u-devA");
  assert.ok(readFileSync(jp, "utf8").endsWith("\n"), "末行已截掉");
  assert.ok(!existsSync(join(dir, "t", "t1", "m", mid, ".tmp-abc")));
  assert.equal((await call(again.base, "GET", "/v1/relay/changes/0", B())).json.items[0].segment_id, w.body.segment_id);
  utimesSync(join(dir, "t", "t1", "m", mid, sha(loose)), new Date(clock - RELAY_UNCOMMITTED_TTL_MS - 60_000), new Date(clock - RELAY_UNCOMMITTED_TTL_MS - 60_000));
  const third = await start(dir);
  assert.ok(!third.s.tenant("t1")!.chunkFiles.includes(`${mid}/${sha(loose)}`), "残留块已删");
  assert.ok(third.s.tenant("t1")!.chunkFiles.includes(`${mid}/${w.body.chunks[0]}`), "登记过的块保留");
  // 坏行：只让 t1 不可用（复核 S11A-08），t3 照常
  appendFileSync(jp, '{"seq":9}\n');
  const fourth = await start(dir);
  assert.equal((await call(fourth.base, "GET", "/v1/relay/changes/0", A())).json.error, "tenant_unavailable");
  assert.equal((await call(fourth.base, "GET", "/v1/relay/changes/0", cred({ tid: "t3", dev: "devZ" }))).json.items.length, 1);
});

test("RA-08 存储上限：超出租户上限即拒绝", async () => {
  const { base } = await start(mkdtempSync(join(tmpdir(), "kwl-ra-")), { tenantMaxBytes: 4096 });
  const mid = newMid();
  assert.equal((await putChunk(base, mid, A(), randomBytes(3000))).status, 200);
  assert.equal((await putChunk(base, mid, A(), randomBytes(3000))).json.error, "tenant_storage_full");
});

test("RA-09 运营：按租户整体删除、按事项重置（须运营凭据与操作人，先记访问审计）；重置后事项可由合法成员重新登记", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-ra-"));
  const log: RelayAccessRecord[] = [];
  const opsSecret = "ops-secret-0123456789";
  const { base, s } = await start(dir, { opsSecret, accessLog: (r) => void log.push(r) });
  const ops = (path: string, h: Record<string, string>) => fetch(`${base}${path}`, { method: "DELETE", headers: h }).then(async (r) => ({ status: r.status, json: (await r.json()) as any }));
  const auth = { authorization: `Bearer ${opsSecret}`, "x-kwl-operator": "ops.zhang" };
  // 复核 S11A-04：非成员 C 抢先登记事项（只有自己是读者）→ 运营按事项重置 → 合法负责人 A 重新登记
  const mid = newMid();
  assert.equal((await writeSeg(base, mid, C(), "devC", { readers: ["devC"] })).r.status, 200);
  assert.equal((await writeSeg(base, mid, A(), "devA")).r.json.error, "not_reader");
  assert.equal((await ops(`/v1/relay/ops/tenants/t1/matters/${mid}`, auth)).status, 200);
  assert.equal(log.at(-1)!.action, "matter_reset");
  assert.equal((await call(base, "GET", "/v1/relay/changes/0", C())).json.items.length, 0, "重置后旧段不再可见");
  assert.equal((await writeSeg(base, mid, A(), "devA")).r.status, 200);
  assert.equal(s.tenant("t1")!.controller(mid), "u-devA");
  // 重置记录随登记日志读回
  s.closeAllConnections();
  await new Promise<void>((r) => s.close(() => r()));
  const again = await start(dir, { opsSecret, accessLog: (r) => void log.push(r) });
  assert.equal(again.s.tenant("t1")!.controller(mid), "u-devA");
  assert.equal((await call(again.base, "GET", "/v1/relay/changes/0", B())).json.items.length, 1);
  const del = (h: Record<string, string>) => fetch(`${again.base}/v1/relay/ops/tenants/t1`, { method: "DELETE", headers: h }).then(async (r) => ({ status: r.status, json: (await r.json()) as any }));
  assert.equal((await del({ authorization: "Bearer wrong-secret-0123456" })).status, 401);
  assert.equal((await del({ authorization: `Bearer ${opsSecret}` })).json.error, "operator_required");
  assert.equal((await del(auth)).status, 200);
  assert.equal(log.at(-1)!.action, "tenant_purge");
  assert.ok(!existsSync(join(dir, "t", "t1")));
  assert.equal((await call(again.base, "GET", "/v1/relay/changes/0", B())).json.items.length, 0);
});

test("RA-10 登记日志写入失败（复核 S11A-08）：截回写入前的长度、回 500；之后的登记与重启读回都正常", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-ra-"));
  let fail = false;
  const { base, s } = await start(dir, {
    journalWrite: (fd, buf) => {
      if (fail) {
        writeSync(fd, buf, 0, Math.floor(buf.length / 2));
        throw Object.assign(new Error("no space"), { code: "ENOSPC" });
      }
      writeSync(fd, buf);
    },
  });
  const mid = newMid();
  assert.equal((await writeSeg(base, mid, A(), "devA")).r.status, 200);
  fail = true;
  assert.equal((await writeSeg(base, mid, A(), "devA")).r.status, 500);
  fail = false;
  assert.equal((await writeSeg(base, mid, A(), "devA")).r.json.seq, 2, "序号连续，半行没有留下");
  s.closeAllConnections();
  await new Promise<void>((r) => s.close(() => r()));
  const again = await start(dir);
  assert.equal(again.s.tenant("t1")!.entries.length, 2);
});

test("RA-11 重置代数（第四轮复核 S11B-36/37）：重置后取历史回 404 并带代数；带旧代数的登记回 409 matter_reset；取新段与历史都带代数；重启读回照旧", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-ra-"));
  const opsSecret = "ops-secret-0123456789";
  const { base, s } = await start(dir, { opsSecret, accessLog: () => {} });
  const mid = newMid();
  const first = await writeSeg(base, mid, A(), "devA", { gen: 0 });
  assert.equal(first.r.status, 200);
  assert.equal(first.r.json.gen, undefined, "登记成功的回复不带代数（第六轮复核 S11A-50）");
  assert.equal((await call(base, "GET", "/v1/relay/changes/0", B())).json.items[0].gen, 0);
  const r = await fetch(`${base}/v1/relay/ops/tenants/t1/matters/${mid}`, { method: "DELETE", headers: { authorization: `Bearer ${opsSecret}`, "x-kwl-operator": "ops.zhang" } });
  assert.equal(r.status, 200);
  assert.deepEqual((await call(base, "GET", `/v1/relay/matters/${mid}/segments/0`, A())).json, { error: "matter_unknown", gen: 1 });
  assert.deepEqual((await call(base, "GET", `/v1/relay/matters/${mid}/segments/0`, C())).json, { error: "matter_unknown" }, "重置前不是读者的同所设备探测不到重置（第五轮复核 S11A-46）");
  // 还不知道重置的设备（例如非负责人）带旧代数登记：拒收，事项不会被它重新建起来
  const stale = await writeSeg(base, mid, B(), "devB", { gen: 0 });
  assert.equal(stale.r.status, 409);
  assert.deepEqual(stale.r.json, { error: "matter_reset", gen: 1 });
  assert.equal(s.tenant("t1")!.controller(mid), null);
  const fresh = await writeSeg(base, mid, A(), "devA", { gen: 1 });
  assert.equal(fresh.r.status, 200);
  const hist = await call(base, "GET", `/v1/relay/matters/${mid}/segments/0`, B());
  assert.equal(hist.json.gen, 1);
  assert.deepEqual(hist.json.items.map((x: any) => x.gen), [1]);
  // 不带代数的旧客户端不核对（部署顺序：中继先于客户端升级）
  assert.equal((await writeSeg(base, mid, A(), "devA")).r.status, 200);
  s.closeAllConnections();
  await new Promise<void>((done) => s.close(() => done()));
  const again = await start(dir, { opsSecret, accessLog: () => {} });
  assert.equal((await call(again.base, "GET", `/v1/relay/matters/${mid}/segments/0`, A())).json.gen, 1, "重置记录随登记日志读回");
});

test("RA-12 第六轮复核 S11A-50/S11B-50：非读者经登记接口也探测不到重置代数；客户端带的实例编号与本中继不同即回 409 relay_rebuilt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-ra-"));
  const opsSecret = "ops-secret-0123456789";
  const { base, s } = await start(dir, { opsSecret, accessLog: () => {} });
  const mid = newMid();
  assert.equal((await writeSeg(base, mid, A(), "devA", { gen: 0 })).r.status, 200);
  const r = await fetch(`${base}/v1/relay/ops/tenants/t1/matters/${mid}`, { method: "DELETE", headers: { authorization: `Bearer ${opsSecret}`, "x-kwl-operator": "ops.zhang" } });
  assert.equal(r.status, 200);
  // 非读者 C 带假代数登记：不核对代数（不告知），按块缺失或新建事项处理
  const probe = await writeSeg(base, mid, C(), "devC", { gen: 7, readers: ["devC"] });
  assert.notEqual(probe.r.json?.error, "matter_reset");
  assert.equal(probe.r.json?.gen === 1, false, "非读者得不到重置代数");
  // 实例编号不同：拒收并告知本中继的实例编号
  const seg = randomBytes(100);
  await putChunk(base, newMid(), A(), seg);
  const m2 = newMid();
  await putChunk(base, m2, A(), seg);
  const wrong = await call(base, "POST", `/v1/relay/matters/${m2}/segments`, A(), { segment_id: sidOf("devA"), sha256: sha(seg), size: seg.length, chunks: [sha(seg)], blob_chunks: [], epoch: 1, readers: ["devA"], gen: 0, instance: "0".repeat(24) });
  assert.deepEqual(wrong.json, { error: "relay_rebuilt", instance: s.instance });
  const ok = await call(base, "POST", `/v1/relay/matters/${m2}/segments`, A(), { segment_id: sidOf("devA"), sha256: sha(seg), size: seg.length, chunks: [sha(seg)], blob_chunks: [], epoch: 1, readers: ["devA"], gen: 0, instance: s.instance });
  assert.equal(ok.status, 200);
});

test("RA-13 第 12 批控制成员移交：只有控制成员可移交；接收者须登记过该事项的段；移交后只有新控制成员能提升纪元；重启读回照旧", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-ra-"));
  const { base } = await start(dir);
  const mid = newMid();
  assert.equal((await writeSeg(base, mid, A(), "devA", { readers: ["devA", "devB", "devC"] })).r.status, 200);
  // 非控制成员不能移交；形状不对拒绝
  assert.equal((await call(base, "POST", `/v1/relay/matters/${mid}/control`, B(), { to: "u-devB" })).json?.error, "not_controller");
  assert.equal((await call(base, "POST", `/v1/relay/matters/${mid}/control`, A(), { to: "u-devB", extra: 1 })).status, 400);
  assert.equal((await call(base, "POST", `/v1/relay/matters/${newMid()}/control`, A(), { to: "u-devB" })).json?.error, "matter_unknown");
  // 接收者还没登记过段
  assert.equal((await call(base, "POST", `/v1/relay/matters/${mid}/control`, A(), { to: "u-devB" })).json?.error, "to_not_reader");
  assert.equal((await writeSeg(base, mid, B(), "devB", { readers: ["devA", "devB", "devC"] })).r.status, 200);
  const ok = await call(base, "POST", `/v1/relay/matters/${mid}/control`, A(), { to: "u-devB", gen: 0 });
  assert.deepEqual(ok.json, { ok: true, controller: "u-devB" });
  // 原控制成员不能再提升纪元；新控制成员可以
  assert.equal((await writeSeg(base, mid, A(), "devA", { epoch: 2, readers: ["devA", "devB"] })).r.json?.error, "epoch_not_established");
  assert.equal((await writeSeg(base, mid, B(), "devB", { epoch: 2, readers: ["devA", "devB"] })).r.status, 200);
  // 原控制成员不能再移交
  assert.equal((await call(base, "POST", `/v1/relay/matters/${mid}/control`, A(), { to: "u-devA" })).json?.error, "not_controller");
  // 重启读回：控制成员仍是 B
  const { s: s2 } = await start(dir);
  assert.equal(s2.tenant("t1")!.controller(mid), "u-devB");
});

test("RA-14 第 12 批第二轮：控制成员移交的接收者须当前仍是读者（只登记过、已被纪元提升移出读者的不收）", async () => {
  const { base } = await start(mkdtempSync(join(tmpdir(), "kwl-ra-")));
  const mid = newMid();
  assert.equal((await writeSeg(base, mid, A(), "devA", { readers: ["devA", "devB"] })).r.status, 200);
  assert.equal((await writeSeg(base, mid, B(), "devB", { readers: ["devA", "devB"] })).r.status, 200);
  // A 提升纪元、读者不再含 B（B 被移出）
  assert.equal((await writeSeg(base, mid, A(), "devA", { epoch: 2, readers: ["devA"] })).r.status, 200);
  assert.equal((await call(base, "POST", `/v1/relay/matters/${mid}/control`, A(), { to: "u-devB" })).json?.error, "to_not_reader");
});
