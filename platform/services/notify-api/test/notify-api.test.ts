/**
 * 通知与提醒服务 v0（第 10 批 S9）：只收受众 notify 的凭据；云端只保存触发时刻、接收设备与密文（请求体多一个字段即拒绝）；
 * 只有到时的、发给本设备的才取得到；确认按版本；同一成员才能改与撤销；版本只升不降、同版本只对应一份内容；
 * 被吊销设备取不到、密文随清扫删除；触发 7 天后删除；状态落盘、重启读回。
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devSeatKeyPair, issueSeatToken } from "@zr-legal/seat-token";
import { createNotifyApi, NOTIFY_RETENTION_MS } from "../src/index.ts";

const { privateKey, publicKey } = devSeatKeyPair();
const keys = new Map([["k1", publicKey]]);
const revoked = new Set<string>();
const feed = { revokedDevice: (_t: string, d: string) => revoked.has(d), revokedSeat: () => false };
let clock = Date.parse("2026-10-16T02:00:00.000Z");
const servers: ReturnType<typeof createNotifyApi>[] = [];

async function start(dir: string) {
  const s = createNotifyApi({ dir, keys, feed, now: () => clock });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return { s, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
}
after(async () => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
});

const cred = (o: { tid?: string; uid?: string; dev?: string; aud?: string[] | undefined } = {}) =>
  issueSeatToken(
    { tid: o.tid ?? "t1", uid: o.uid ?? "u1", sid: `s-${o.uid ?? "u1"}`, dev: o.dev ?? "devA", kid: "k1", ...(o.aud === undefined && "aud" in o ? {} : { aud: o.aud ?? ["notify"] }) },
    privateKey,
    6 * 3600,
    clock,
  );
const CT = (c: string) => c.repeat(64);
const iso = (t: number) => new Date(t).toISOString();
const minute = (t: number) => iso(Math.floor(t / 60_000) * 60_000);

async function call(base: string, method: string, path: string, token: string | null, body?: unknown) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, json: (await r.json()) as any };
}
const RID = "rmd_" + "a".repeat(24);
const RID2 = "rmd_" + "b".repeat(24);

test("NA-01 凭据：只收受众 notify；通用席位令牌、支持凭据、没有凭据都拒绝", async () => {
  const { base } = await start(mkdtempSync(join(tmpdir(), "kwl-na-")));
  assert.equal((await call(base, "GET", "/v1/notify/due", null)).status, 401);
  const general = issueSeatToken({ tid: "t1", uid: "u1", sid: "s1", dev: "devA", kid: "k1" }, privateKey, 3600, clock);
  assert.equal((await call(base, "GET", "/v1/notify/due", general)).json.error, "credential_audience");
  assert.equal((await call(base, "GET", "/v1/notify/due", cred({ aud: ["support"] }))).json.error, "credential_audience");
  assert.equal((await call(base, "GET", "/v1/notify/due", cred())).status, 200);
  // 请求行原样匹配：编码、查询串、点段一律 404
  // 用 http.request 原样发请求行（fetch 会在客户端把 .. 归一化掉）
  const raw = (path: string) =>
    new Promise<number>((resolve, reject) => {
      const u = new URL(base);
      const req = request({ host: u.hostname, port: u.port, path, method: "GET", headers: { authorization: `Bearer ${cred()}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
  for (const p of ["/v1/notify/due?x=1", "/v1/notify/%64ue", "/v1/notify/../notify/due"]) assert.equal(await raw(p), 404, p);
});

test("NA-02 登记 → 到时才取得到 → 只给目标设备 → 按版本确认；云端只存触发时刻、设备编号与密文", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-na-"));
  const { base } = await start(dir);
  const fire = minute(clock + 10 * 60_000);
  const put = await call(base, "PUT", `/v1/reminders/${RID}`, cred(), { fire_at: fire, version: 1, targets: [{ dev: "devA", ct: CT("A") }, { dev: "devB", ct: CT("B") }] });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  assert.deepEqual((await call(base, "GET", "/v1/notify/due", cred({ dev: "devB" }))).json.items, [], "未到时");
  clock += 11 * 60_000;
  const due = await call(base, "GET", "/v1/notify/due", cred({ dev: "devB" }));
  assert.deepEqual(due.json.items, [{ id: RID, version: 1, fire_at: fire, ct: CT("B") }], "只给本设备的那一份");
  assert.deepEqual((await call(base, "GET", "/v1/notify/due", cred({ dev: "devC" }))).json.items, [], "不是目标设备取不到");
  assert.deepEqual((await call(base, "GET", "/v1/notify/due", cred({ tid: "t2", dev: "devB" }))).json.items, [], "别的律所同名设备取不到");
  // 旧版本的确认不算数
  assert.equal((await call(base, "POST", "/v1/notify/ack", cred({ dev: "devB" }), { items: [{ id: RID, version: 0 }] })).json.acked, 0);
  assert.equal((await call(base, "POST", "/v1/notify/ack", cred({ dev: "devB" }), { items: [{ id: RID, version: 1 }] })).json.acked, 1);
  assert.deepEqual((await call(base, "GET", "/v1/notify/due", cred({ dev: "devB" }))).json.items, [], "确认后不再给");
  assert.equal((await call(base, "GET", "/v1/notify/due", cred({ dev: "devA" }))).json.items.length, 1, "另一台设备的仍在");
  // 落盘内容只有触发时刻、设备编号、密文与投递状态
  const saved = JSON.parse(readFileSync(join(dir, "reminders.json"), "utf8"));
  assert.deepEqual(Object.keys(saved.reminders[0]).sort(), ["fire_at", "id", "owner", "targets", "tid", "updated_at", "version"]);
  assert.deepEqual(Object.keys(saved.reminders[0].targets.devB).sort(), ["ct", "delivered_at"]);
});

test("NA-03 请求体只收三个字段；触发时刻须到分钟且在范围内；目标与密文形态", async () => {
  const { base } = await start(mkdtempSync(join(tmpdir(), "kwl-na-")));
  const fire = minute(clock + 3600_000);
  const ok = { fire_at: fire, version: 1, targets: [{ dev: "devA", ct: CT("A") }] };
  const bad = async (body: unknown, code: string) => assert.equal((await call(base, "PUT", `/v1/reminders/${RID}`, cred(), body)).json.error, code, JSON.stringify(body).slice(0, 80));
  await bad({ ...ok, note: "开庭" }, "body_invalid");
  await bad({ ...ok, targets: [{ dev: "devA", ct: CT("A"), kind: "hearing" }] }, "targets_invalid");
  await bad({ ...ok, fire_at: iso(clock + 3600_000 + 1234) }, "fire_at_invalid");
  await bad({ ...ok, fire_at: minute(clock - 2 * 86_400_000) }, "fire_at_out_of_range");
  await bad({ ...ok, fire_at: minute(clock + 4 * 366 * 86_400_000) }, "fire_at_out_of_range");
  await bad({ ...ok, targets: [{ dev: "devA", ct: "短" }] }, "ciphertext_invalid");
  await bad({ ...ok, targets: [{ dev: "devA", ct: CT("A") }, { dev: "devA", ct: CT("B") }] }, "targets_invalid");
  await bad({ ...ok, targets: [] }, "targets_invalid");
  await bad({ ...ok, version: 0 }, "version_invalid");
  assert.equal((await call(base, "PUT", `/v1/reminders/rmd_xyz`, cred(), ok)).status, 404);
});

test("NA-04 只有同一成员能改与撤销；版本只升不降；同版本重发相同内容幂等、不同内容拒绝；撤销后取不到", async () => {
  const { base } = await start(mkdtempSync(join(tmpdir(), "kwl-na-")));
  const fire = minute(clock + 3600_000);
  const v1 = { fire_at: fire, version: 1, targets: [{ dev: "devA", ct: CT("A") }] };
  assert.equal((await call(base, "PUT", `/v1/reminders/${RID2}`, cred(), v1)).status, 200);
  assert.equal((await call(base, "PUT", `/v1/reminders/${RID2}`, cred(), v1)).json.unchanged, true);
  assert.equal((await call(base, "PUT", `/v1/reminders/${RID2}`, cred(), { ...v1, targets: [{ dev: "devA", ct: CT("Z") }] })).json.error, "version_conflict");
  assert.equal((await call(base, "PUT", `/v1/reminders/${RID2}`, cred({ uid: "u2", dev: "devX" }), { ...v1, version: 2 })).json.error, "not_owner");
  assert.equal((await call(base, "DELETE", `/v1/reminders/${RID2}`, cred({ uid: "u2", dev: "devX" }), { version: 3 })).json.error, "not_owner");
  assert.equal((await call(base, "PUT", `/v1/reminders/${RID2}`, cred({ dev: "devA2" }), { ...v1, version: 3 })).status, 200, "同一成员的另一台设备可以改");
  assert.equal((await call(base, "PUT", `/v1/reminders/${RID2}`, cred(), { ...v1, version: 2 })).json.error, "version_stale");
  assert.deepEqual(await call(base, "DELETE", `/v1/reminders/${RID2}`, cred(), { version: 3 }).then((r) => r.json), { ok: true, existed: true });
  assert.deepEqual(await call(base, "DELETE", `/v1/reminders/${RID2}`, cred(), { version: 3 }).then((r) => r.json), { ok: true, existed: false });
  clock += 2 * 3600_000;
  assert.deepEqual((await call(base, "GET", "/v1/notify/due", cred())).json.items, []);
});

test("NA-05 被吊销设备：凭据拒收、登记为目标拒绝、清扫删除其密文；触发 7 天后删除；状态重启读回、坏文件拒绝启动", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-na-"));
  const a = await start(dir);
  const fire = minute(clock + 60_000);
  assert.equal((await call(a.base, "PUT", `/v1/reminders/${RID}`, cred(), { fire_at: fire, version: 1, targets: [{ dev: "devA", ct: CT("A") }, { dev: "devR", ct: CT("R") }] })).status, 200);
  revoked.add("devR");
  try {
    assert.equal((await call(a.base, "GET", "/v1/notify/due", cred({ dev: "devR" }))).json.error, "credential_revoked");
    assert.equal((await call(a.base, "PUT", `/v1/reminders/${RID2}`, cred(), { fire_at: fire, version: 1, targets: [{ dev: "devR", ct: CT("R") }] })).json.error, "target_revoked");
    a.s.sweep();
    assert.deepEqual(Object.keys(a.s.snapshot()[0]!.targets), ["devA"], "被吊销设备的密文已删除");
  } finally {
    revoked.delete("devR");
  }
  // 重启读回
  const b = await start(dir);
  clock += 2 * 60_000;
  assert.equal((await call(b.base, "GET", "/v1/notify/due", cred())).json.items.length, 1);
  // 触发 7 天后删除
  clock += NOTIFY_RETENTION_MS;
  assert.equal(b.s.sweep(), 1);
  assert.deepEqual(b.s.snapshot(), []);
  // 坏状态文件：拒绝启动（不静默丢掉律所的提醒）
  const bad = mkdtempSync(join(tmpdir(), "kwl-na-"));
  writeFileSync(join(bad, "reminders.json"), "{not json");
  assert.throws(() => createNotifyApi({ dir: bad, keys, now: () => clock }));
});

test("NA-06 撤销留墓碑：迟到或被重放的旧版本登记拒收，更高版本可以重新登记（复核 S10A-10）；撤销须带版本", async () => {
  const { base, s: svc } = await start(mkdtempSync(join(tmpdir(), "kwl-na-")));
  const RID3 = "rmd_" + "d".repeat(24);
  const fire = minute(clock + 3600_000);
  const v = (version: number, c = "A") => ({ fire_at: fire, version, targets: [{ dev: "devA", ct: CT(c) }] });
  assert.equal((await call(base, "PUT", `/v1/reminders/${RID3}`, cred(), v(2))).status, 200);
  assert.equal((await call(base, "DELETE", `/v1/reminders/${RID3}`, cred(), {})).json.error, "body_invalid");
  assert.equal((await call(base, "DELETE", `/v1/reminders/${RID3}`, cred(), { version: 2 })).json.existed, true);
  assert.deepEqual(svc.tombstones().map((t) => [t.id, t.version]), [[RID3, 2]]);
  assert.equal((await call(base, "PUT", `/v1/reminders/${RID3}`, cred(), v(2, "Z"))).json.error, "version_stale", "被重放的旧版本");
  assert.equal((await call(base, "PUT", `/v1/reminders/${RID3}`, cred(), v(1))).json.error, "version_stale");
  assert.equal((await call(base, "PUT", `/v1/reminders/${RID3}`, cred({ uid: "u9", dev: "devQ" }), v(9))).json.error, "not_owner", "别人不能借墓碑编号登记");
  assert.equal((await call(base, "PUT", `/v1/reminders/${RID3}`, cred(), v(3))).status, 200, "更高版本可以重新登记");
  assert.deepEqual(svc.tombstones(), []);
  // 墓碑到期删除
  assert.equal((await call(base, "DELETE", `/v1/reminders/${RID3}`, cred(), { version: 3 })).status, 200);
  clock += 3600_000 + NOTIFY_RETENTION_MS + 1;
  svc.sweep();
  assert.deepEqual(svc.tombstones(), []);
});

test("NA-07 暂缓：本设备暂时不能判断的条目暂缓后不再堵在队头，到时再给；暂缓最长 24 小时；只影响本设备（复核 S10A-03）", async () => {
  const { base } = await start(mkdtempSync(join(tmpdir(), "kwl-na-")));
  const ids = Array.from({ length: 51 }, (_, i) => `rmd_${i.toString(16).padStart(24, "0")}`);
  const fire = minute(clock - 60_000);
  for (const id of ids) assert.equal((await call(base, "PUT", `/v1/reminders/${id}`, cred(), { fire_at: fire, version: 1, targets: [{ dev: "devA", ct: CT("A") }, { dev: "devB", ct: CT("B") }] })).status, 200);
  const first = await call(base, "GET", "/v1/notify/due", cred());
  assert.equal(first.json.items.length, 50);
  assert.equal(first.json.more, true);
  const until = new Date(clock + 30 * 86_400_000).toISOString();
  assert.equal((await call(base, "POST", "/v1/notify/defer", cred(), { items: first.json.items.map((x: any) => ({ id: x.id, version: 1, until })) })).json.deferred, 50);
  const next = await call(base, "GET", "/v1/notify/due", cred());
  assert.deepEqual(next.json.items.map((x: any) => x.id), [ids[50]], "暂缓的不再堵住后面的");
  assert.equal((await call(base, "GET", "/v1/notify/due", cred({ dev: "devB" }))).json.items.length, 50, "别的设备不受影响");
  assert.equal((await call(base, "POST", "/v1/notify/defer", cred(), { items: [{ id: ids[0], version: 1 }] })).json.error, "body_invalid");
  clock += 24 * 3600_000 + 1;
  assert.equal((await call(base, "GET", "/v1/notify/due", cred())).json.items.length, 50, "暂缓最长 24 小时");
});

test("NA-08 落盘：启动时删掉崩溃残留的临时状态文件；状态里有坏记录拒绝启动；写盘失败时内存回滚（复核 S10A-12）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-na-"));
  writeFileSync(join(dir, "reminders.json.tmp-abcd1234"), "{\"v\":1,\"reminders\":[]}");
  const a = await start(dir);
  assert.equal(existsSync(join(dir, "reminders.json.tmp-abcd1234")), false);
  const fire = minute(clock + 3600_000);
  assert.equal((await call(a.base, "PUT", `/v1/reminders/${RID}`, cred(), { fire_at: fire, version: 1, targets: [{ dev: "devA", ct: CT("A") }] })).status, 200);
  if (process.platform !== "win32") {
    chmodSync(dir, 0o500);
    try {
      const r = await call(a.base, "PUT", `/v1/reminders/${RID}`, cred(), { fire_at: fire, version: 2, targets: [{ dev: "devA", ct: CT("B") }] });
      assert.equal(r.status, 500);
    } finally {
      chmodSync(dir, 0o700);
    }
    assert.equal(a.s.snapshot()[0]!.version, 1, "写盘失败：内存回到改动之前");
    assert.deepEqual(readdirSync(dir).filter((f) => f.includes(".tmp-")), []);
  }
  const bad = mkdtempSync(join(tmpdir(), "kwl-na-"));
  writeFileSync(join(bad, "reminders.json"), JSON.stringify({ v: 1, reminders: [{ tid: "t1", id: "rmd_x", owner: "u", version: 1, fire_at: fire, updated_at: fire, targets: {} }], writes: {} }));
  assert.throws(() => createNotifyApi({ dir: bad, keys, now: () => clock }), /不合格/);
});

test("NA-09 生产形态必须接吊销订阅；运营按租户整体删除（先记访问审计；凭据与操作人缺一不可；复核 S10A-13/15）", async () => {
  assert.throws(() => createNotifyApi({ dir: mkdtempSync(join(tmpdir(), "kwl-na-")), keys, production: true }), /吊销订阅/);
  const access: any[] = [];
  const s = createNotifyApi({ dir: mkdtempSync(join(tmpdir(), "kwl-na-")), keys, feed, now: () => clock, opsSecret: "ops-secret-0123456789", accessLog: (r) => void access.push(r) });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const fire = minute(clock + 3600_000);
  await call(base, "PUT", `/v1/reminders/${RID}`, cred(), { fire_at: fire, version: 1, targets: [{ dev: "devA", ct: CT("A") }] });
  await call(base, "PUT", `/v1/reminders/${RID}`, cred({ tid: "t2" }), { fire_at: fire, version: 1, targets: [{ dev: "devA", ct: CT("A") }] });
  const ops = (h: Record<string, string>) => fetch(`${base}/v1/notify/ops/tenants/t1`, { method: "DELETE", headers: h });
  assert.equal((await ops({ authorization: "Bearer wrong-secret-000000000" , "x-kwl-operator": "op.a" })).status, 401);
  assert.equal((await ops({ authorization: "Bearer ops-secret-0123456789" })).status, 400);
  const r = await ops({ authorization: "Bearer ops-secret-0123456789", "x-kwl-operator": "op.a" });
  assert.deepEqual(await r.json(), { ok: true, removed: 1 });
  assert.deepEqual(s.snapshot().map((x) => x.tid), ["t2"], "只删该租户");
  assert.deepEqual(access.map((a) => [a.action, a.operator, a.tid, a.removed]), [["tenant_purge", "op.a", "t1", 1]]);
});

test("NA-10 撤销也计入每日写入次数；为不存在的编号建墓碑计入租户上限（复核 S10A-21）", async () => {
  const { base, s: svc } = await start(mkdtempSync(join(tmpdir(), "kwl-na-")));
  const u = cred({ uid: "u-del", dev: "devD" });
  let last = 0;
  for (let i = 0; i < 501; i++) {
    const r = await call(base, "DELETE", `/v1/reminders/rmd_${i.toString(16).padStart(24, "0")}`, u, { version: 1 });
    last = r.status;
    if (r.status !== 200) break;
  }
  assert.equal(last, 429, "第 501 次撤销被拒");
  assert.equal(svc.tombstones().filter((t) => t.tid === "t1" && t.owner === "u-del").length, 500);
});

test("NA-11 撤销已有的提醒不计写入次数：额度用完也能撤销（复核 S10A-27）", async () => {
  const { base } = await start(mkdtempSync(join(tmpdir(), "kwl-na-")));
  const u = cred({ uid: "u-full", dev: "devF" });
  const fire = minute(clock + 3600_000);
  const ids = Array.from({ length: 500 }, (_, i) => `rmd_${(i + 0x1000).toString(16).padStart(24, "0")}`);
  for (const id of ids) assert.equal((await call(base, "PUT", `/v1/reminders/${id}`, u, { fire_at: fire, version: 1, targets: [{ dev: "devF", ct: CT("F") }] })).status, 200);
  assert.equal((await call(base, "PUT", `/v1/reminders/rmd_${"e".repeat(24)}`, u, { fire_at: fire, version: 1, targets: [{ dev: "devF", ct: CT("F") }] })).json.error, "too_many_writes");
  assert.equal((await call(base, "DELETE", `/v1/reminders/${ids[0]}`, u, { version: 1 })).status, 200, "额度用完仍能撤销已有的");
  assert.equal((await call(base, "DELETE", `/v1/reminders/rmd_${"f".repeat(24)}`, u, { version: 1 })).json.error, "too_many_writes", "为不存在的编号建墓碑仍计");
});
