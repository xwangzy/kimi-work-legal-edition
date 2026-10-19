// 第 12 批复核 B 的复现转入（原断言 e446567 上的错误表现，处置后改为回归用例：断言修正后的行为）。共享文件夹介质。
// 见 docs/review/第12批-复核B-内核与界面.md 与其末节处置。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson, signSyncWith, unwrapMatterKey, wrapMatterKey, generateMatterKey } from "@zr-legal/keys";
import { sealSegment, writeSegment, parseSegment } from "@zr-legal/sync";
import { makeKernel, type TestKernel } from "./helpers.ts";

const FIRM = "r12b";
const TID = `ten_${FIRM}`;
const usr = (s: string) => `usr_${FIRM}_${s}`;
const dev = (s: string) => `dev_${FIRM}_${s}`;
let kA: TestKernel;
let kB: TestKernel;
let kC: TestKernel;
let kD: TestKernel;
const others: TestKernel[] = [];

async function open(slug: string, env: Record<string, string> = {}): Promise<TestKernel> {
  const d = mkdtempSync(join(tmpdir(), `kwl-r12b-${slug}-`));
  mkdirSync(join(d, FIRM, "keys"), { recursive: true });
  copyFileSync(join(kA.dir, FIRM, "keys", "firm-root.json"), join(d, FIRM, "keys", "firm-root.json"));
  const { createKernel } = await import("../src/index.ts");
  const kernel = await createKernel({ dataDir: d, firmSlug: FIRM, userSlug: slug, env: { ...process.env, ZR_MODEL_PROVIDER: "mock", ...env } });
  const k = { kernel, dir: d, inv: (m: string, p?: any) => kernel.invoke(m, p) } as TestKernel;
  others.push(k);
  return k;
}
const copyDev = (from: TestKernel, id: string, to: TestKernel[]) => {
  const row = from.kernel.db.get<Record<string, unknown>>(`SELECT * FROM devices WHERE device_id = ?`, [id])!;
  for (const k of to) {
    const cols = Object.keys(row);
    k.kernel.db.run(`INSERT OR IGNORE INTO devices (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, cols.map((c) => row[c]));
  }
};
const imp = (k: TestKernel, mid: string, fn: string, t: string) => k.inv("materials.import", { matter_id: mid, filename: fn, data_base64: Buffer.from(t, "utf8").toString("base64"), mime: "text/plain" });
const dir = (tag: string) => mkdtempSync(join(tmpdir(), `kwl-r12b-${tag}-`));
const newMatter = async (k: TestKernel, title: string) => (await k.inv("matters.create", { title, stance: "受让方", consent_status: "not_required", collab_scope: "team" })).matter.matter_id as string;
const role = (k: TestKernel, mid: string, u: string) =>
  k.kernel.db.get<{ matter_role: string; live: number }>(`SELECT matter_role, removed_at IS NULL AS live FROM matter_members WHERE matter_id = ? AND user_id = ?`, [mid, u]);
const alerts = (k: TestKernel, mid: string) => k.kernel.db.all<{ kind: string }>(`SELECT kind FROM sync_alerts WHERE matter_id = ? ORDER BY kind`, [mid]).map((a) => a.kind);
const hasDoc = (k: TestKernel, mid: string, fn: string) => !!k.kernel.db.get(`SELECT 1 AS x FROM document_versions WHERE matter_id = ? AND filename = ?`, [mid, fn]);
const log = async (k: TestKernel, mid: string) => (await k.inv("matters.member_log", { matter_id: mid })).events as any[];
const ownEpoch = (k: TestKernel, mid: string, d: string) => k.kernel.db.get<{ e: number }>(`SELECT MAX(epoch) AS e FROM matter_keys WHERE matter_id = ? AND wrapped_for = ?`, [mid, d])!.e;
const rawKey = (k: TestKernel, mid: string, epoch: number, d: string) => k.kernel.db.get<{ w: string }>(`SELECT wrapped_key AS w FROM matter_keys WHERE matter_id = ? AND epoch = ? AND wrapped_for = ?`, [mid, epoch, d])?.w;
async function pass(from: TestKernel, to: TestKernel[], mid: string): Promise<string> {
  const s = dir("p");
  await from.inv("sync.export", { share_dir: s, matter_id: mid });
  for (const k of to) await k.inv("sync.import", { share_dir: s });
  return s;
}
async function deviceOf(k: TestKernel, slug: string) {
  const { getDeviceKeys, keysDirOf } = await import("../src/index.ts");
  const keys = getDeviceKeys(keysDirOf(join(k.dir, FIRM)));
  const cert = k.kernel.db.get<{ cert_json: string }>(`SELECT cert_json FROM devices WHERE device_id = ?`, [dev(slug)])!.cert_json;
  return { keys, cert, id: dev(slug) };
}
type Dev = Awaited<ReturnType<typeof deviceOf>>;
function forgeEvent(d: Dev, mid: string, kind: string, prev: string[], lamport: number, body: Record<string, unknown>, at = new Date().toISOString()) {
  const payload = { v: "kwl-member-event/1", tenant: TID, matter_id: mid, kind, prev: [...prev].sort(), lamport, author_device: d.id, at, body };
  const event_id = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  return { event_id, payload: canonicalJson(payload), sig: signSyncWith(d.keys.signPrivateKeyPem, new TextEncoder().encode(`kwl-member-event/1\n${event_id}`)), author_cert: d.cert };
}
function forgeSegment(share: string, d: Dev, mid: string, epoch: number, matterKey: Uint8Array, rows: { t: string; pk: string; row: Record<string, unknown> }[], keyRows: any[] = []) {
  const sid = `seg_${d.id}_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10).padEnd(8, "0")}`;
  const sealed = sealSegment({
    header: { segment_id: sid, device_id: d.id, matter_id: mid, from_lamport: 1, to_lamport: 1, key_epoch: epoch, event_count: rows.length, created_at: new Date().toISOString(), device_cert_json: d.cert },
    keyRows,
    rows: rows.map((r) => ({ ...r, src_device: d.id, src_lamport: 1 })),
    matterKey,
    signer: d.keys.signPrivateKeyPem,
  });
  writeSegment(share, TID, d.id, sid, sealed);
}
const fpOf = (key: Uint8Array) => createHash("sha256").update("kwl-matter-key-fp/1").update(key).digest("hex").slice(0, 32);
const digestOf = (wrapped: string) => createHash("sha256").update(`kwl-matter-wrap/1\n${wrapped}`).digest("hex");

before(async () => {
  kA = await makeKernel({}, FIRM);
  kB = await open("bob");
  kC = await open("carol");
  kD = await open("dave");
  const all = [kA, kB, kC, kD];
  for (const [k, s] of [[kA, "test-lawyer"], [kB, "bob"], [kC, "carol"], [kD, "dave"]] as const) copyDev(k, dev(s), all.filter((x) => x !== k));
});
after(async () => {
  for (const k of others) await k.kernel.close().catch(() => {});
  await kA.kernel.close();
});

test("S12B-01：互相降级两条都成立（失败即关闭），两人都不能再做成员操作、也不会每次导出重写被拒收的事件；第三位负责人不受被拒收的降级牵连", { timeout: 180_000 }, async () => {
  const m = await newMatter(kA, "互相降级");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "owner" });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("erin") });
  await pass(kA, [kB], m);
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "editor" });
  await kB.inv("matters.members.add", { matter_id: m, user_id: usr("test-lawyer"), matter_role: "editor" });
  await pass(kA, [kB], m);
  await pass(kB, [kA], m);
  for (const k of [kA, kB]) {
    assert.equal(role(k, m, usr("test-lawyer"))?.matter_role, "editor");
    assert.equal(role(k, m, usr("bob"))?.matter_role, "editor");
  }
  // 两人都不再是负责人：成员操作如实拒绝（不再“返回成功、链上拒收”）
  await assert.rejects(kA.inv("matters.members.add", { matter_id: m, user_id: usr("carol") }), /负责人/);
  await assert.rejects(kB.inv("matters.members.add", { matter_id: m, user_id: usr("dave") }), /负责人/);
  // erin 后登记设备：没有负责人可处置，三次导出不写任何事件
  const kE = await open("erin");
  copyDev(kE, dev("erin"), [kA]);
  const before = (await log(kA, m)).length;
  for (let i = 0; i < 3; i++) await kA.inv("sync.export", { share_dir: dir("loop"), matter_id: m });
  assert.equal((await log(kA, m)).length, before, "不再无限写事件");
  // 第三位负责人：A 降级 bob；bob 并发把共同负责人 carol 降为编辑（不是报复，拒收）；carol 此后的操作照常有效
  const m2 = await newMatter(kA, "第三位负责人");
  await kA.inv("matters.members.add", { matter_id: m2, user_id: usr("bob"), matter_role: "owner" });
  await kA.inv("matters.members.add", { matter_id: m2, user_id: usr("carol"), matter_role: "owner" });
  await pass(kA, [kB, kC], m2);
  await kA.inv("matters.members.add", { matter_id: m2, user_id: usr("bob"), matter_role: "editor" });
  await kB.inv("matters.members.add", { matter_id: m2, user_id: usr("carol"), matter_role: "editor" });
  await pass(kA, [kC], m2);
  await kC.inv("matters.members.add", { matter_id: m2, user_id: usr("dave") });
  await pass(kB, [kC], m2);
  assert.equal(role(kC, m2, usr("carol"))?.matter_role, "owner", "bob 并发的降级拒收，carol 仍是负责人");
  assert.ok(role(kC, m2, usr("dave"))?.live, "carol 加的 dave 仍有效（不被那条被拒收的降级牵连）");
});

test("S12B-02：本机的轮换合并后在链上不成立——收回那一纪元、改用链上声明的纪元，之后写的内容别人收得到", { timeout: 180_000 }, async () => {
  const m = await newMatter(kA, "被拒收的轮换");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "owner" });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("carol") });
  await pass(kA, [kB, kC], m);
  await kA.inv("matters.members.remove", { matter_id: m, user_id: usr("carol") });
  await kB.inv("matters.members.add", { matter_id: m, user_id: usr("test-lawyer"), matter_role: "editor" });
  await pass(kB, [kA], m);
  assert.equal(role(kA, m, usr("test-lawyer"))?.matter_role, "editor");
  assert.ok(role(kA, m, usr("carol"))?.live, "A 的移出被拒收，carol 仍在");
  assert.equal(ownEpoch(kA, m, dev("test-lawyer")), 1, "A 收回了链上没有声明的纪元 2");
  await imp(kA, m, "甲-降级后.txt", "A 降为编辑之后写的");
  await pass(kA, [kB, kC], m);
  assert.ok(hasDoc(kB, m, "甲-降级后.txt"), "负责人 bob 收到");
  assert.ok(hasDoc(kC, m, "甲-降级后.txt"), "成员 carol 收到");
  // 直接写一次被降级者的轮换：链上不成立，接口如实拒绝（不再返回成功）
  await assert.rejects(kA.inv("matters.members.remove", { matter_id: m, user_id: usr("carol") }), /负责人|不成立/);
});

test("S12B-03：纪元胜者只按全序定，胜者作者之后被正常降级不翻转，双方都没有告警、内容照常往来", { timeout: 180_000 }, async () => {
  const m = await newMatter(kA, "胜者不翻转");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "owner" });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("carol") });
  await pass(kA, [kB], m);
  await kA.inv("matters.members.remove", { matter_id: m, user_id: usr("carol") });
  await kB.inv("matters.members.remove", { matter_id: m, user_id: usr("carol") });
  const before = { a: rawKey(kA, m, 2, dev("test-lawyer"))!, b: rawKey(kB, m, 2, dev("bob"))! };
  await pass(kA, [kB], m);
  await pass(kB, [kA], m);
  const aKept = rawKey(kA, m, 2, dev("test-lawyer")) === before.a;
  const [W, L, wUser] = aKept ? [kA, kB, usr("test-lawyer")] : [kB, kA, usr("bob")];
  await L.inv("matters.members.add", { matter_id: m, user_id: wUser, matter_role: "editor" });
  await imp(L, m, "降级之后.txt", "L 降级 W 之后写的");
  const lx = dir("lx");
  const ex = await L.inv("sync.export", { share_dir: lx, matter_id: m });
  assert.deepEqual(alerts(L, m), []);
  assert.deepEqual(ex.pausedConflict, []);
  await W.inv("sync.import", { share_dir: lx });
  assert.deepEqual(alerts(W, m), []);
  assert.ok(hasDoc(W, m, "降级之后.txt"), "W 读到 L 之后写的内容");
});

test("S12B-04：链视图缓存在事务回滚之后再写入另一条事件时不返回过期视图", async () => {
  const { chainView } = await import("../src/member-log.ts");
  const m = await newMatter(kA, "缓存键");
  const a = await deviceOf(kA, "test-lawyer");
  const db = kA.kernel.db;
  const deps = { db, keyctx: undefined as any, tenantId: TID };
  const root = db.get<{ event_id: string }>(`SELECT event_id FROM member_events WHERE matter_id = ?`, [m])!.event_id;
  const e1 = forgeEvent(a, m, "member", [root], 2, { user: usr("x1"), role: "viewer" });
  const e2 = forgeEvent(a, m, "member", [root], 2, { user: usr("x2"), role: "viewer" });
  const ins = (e: ReturnType<typeof forgeEvent>) =>
    db.run(`INSERT INTO member_events (event_id, matter_id, lamport, kind, author_device, author_member, payload, sig, author_cert, via_member, received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
      e.event_id, m, 2, "member", a.id, usr("test-lawyer"), e.payload, e.sig, e.author_cert, null, "2000-01-01T00:00:00.000Z",
    ]);
  chainView(deps, m);
  try {
    db.tx(() => {
      ins(e1);
      assert.ok(chainView(deps, m).events.has(e1.event_id));
      throw new Error("rollback");
    });
  } catch {}
  ins(e2);
  const v = chainView(deps, m);
  assert.ok(!v.events.has(e1.event_id), "已回滚的 e1 不在视图里");
  assert.ok(v.events.has(e2.event_id), "已落库的 e2 在视图里");
});

test("S12B-05：本机重新引导后，非成员伪造的起点不被采用，本机不收它的密钥、重新引导期间暂停发出", { timeout: 180_000 }, async () => {
  const m = await newMatter(kA, "重新引导不被抢占");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob") });
  await pass(kA, [kB], m);
  await kB.inv("matters.sync_rebootstrap", { matter_id: m });
  const d = await deviceOf(kD, "dave");
  const bobEnc = kA.kernel.db.get<{ enc_pub_pem: string }>(`SELECT enc_pub_pem FROM devices WHERE device_id = ?`, [dev("bob")])!.enc_pub_pem;
  const fake = generateMatterKey();
  const wForBob = wrapMatterKey(fake, bobEnc);
  const anchor = forgeEvent(d, m, "anchor", [], 1, {
    members: [
      { user: usr("dave"), role: "owner", removed: false },
      { user: usr("bob"), role: "editor", removed: false },
    ],
    key: { epoch: 9, fp: fpOf(fake), wraps: { [dev("bob")]: digestOf(wForBob) } },
  });
  const share = dir("takeover");
  forgeSegment(share, d, m, 9, fake, [{ t: "member_events", pk: anchor.event_id, row: anchor as any }], [
    { matter_id: m, epoch: 9, wrapped_for: dev("bob"), wrapped_key: wForBob, created_at: new Date().toISOString() },
  ]);
  const r = await kB.inv("sync.import", { share_dir: share });
  assert.deepEqual(r.dispositions.map((x: any) => x.outcome), ["deferred"]);
  assert.equal((await kB.inv("matters.member_log", { matter_id: m })).anchored, false, "不采用非成员的起点");
  assert.notEqual(ownEpoch(kB, m, dev("bob")), 9, "不收它的密钥");
  await imp(kB, m, "乙-之后.txt", "bob 重新引导期间写的");
  const ex = await kB.inv("sync.export", { share_dir: dir("bout"), matter_id: m });
  assert.deepEqual(ex.pausedConflict, [m], "重新引导期间暂停发出");
  // 负责人的链到了即恢复
  await pass(kA, [kB], m);
  assert.equal((await kB.inv("matters.member_log", { matter_id: m })).anchored, true);
  assert.deepEqual(alerts(kB, m), []);
});

test("S12B-07：成员签发的缺前序事件不转发，负责人那边不会存下", { timeout: 180_000 }, async () => {
  const m = await newMatter(kA, "垃圾事件");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob") });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("dave") });
  await pass(kA, [kB, kD], m);
  const bob = await deviceOf(kB, "bob");
  const k1 = unwrapMatterKey(rawKey(kB, m, 1, bob.id)!, bob.keys.encPrivateKeyPem);
  const junk = Array.from({ length: 40 }, (_, i) => forgeEvent(bob, m, "member", ["f".repeat(63) + (i % 10)], 2 + i, { user: `${usr("j")}${i}`, role: "viewer" }));
  const share = dir("junk");
  forgeSegment(share, bob, m, 1, k1, junk.map((e) => ({ t: "member_events", pk: e.event_id, row: e as any })));
  await kD.inv("sync.import", { share_dir: share });
  assert.deepEqual(alerts(kD, m), [], "不暂停");
  await imp(kD, m, "丁.txt", "丁");
  const out = dir("dout");
  const ex = await kD.inv("sync.export", { share_dir: out, matter_id: m });
  const { openSegmentBody } = await import("@zr-legal/sync");
  const daveDev = await deviceOf(kD, "dave");
  const seg = parseSegment(readFileSync(ex.segments[0], "utf8"))!;
  const dk = unwrapMatterKey(rawKey(kD, m, seg.header.key_epoch, daveDev.id)!, daveDev.keys.encPrivateKeyPem);
  const rows = openSegmentBody(seg, dk) as any[];
  const junkIds = new Set(junk.map((e) => e.event_id));
  assert.ok(!rows.some((r) => r.t === "member_events" && junkIds.has(r.pk)), "不转发");
  const aBefore = kA.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM member_events WHERE matter_id = ?`, [m])!.n;
  await kA.inv("sync.import", { share_dir: out });
  assert.equal(kA.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM member_events WHERE matter_id = ?`, [m])!.n, aBefore, "负责人不会经转发存下");
});

test("S12B-09：恢复轮换排除的设备不被自动补包裹，读不到轮换后的内容", { timeout: 180_000 }, async () => {
  const m = await newMatter(kA, "恢复轮换排除");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob") });
  await pass(kA, [kB], m);
  const shareDir = join(kA.dir, FIRM, "keys", "recovery-shares");
  const r = await kA.inv("recovery.restore_matter", { matter_id: m, share_files: [1, 2, 3].map((x) => join(shareDir, `share-${x}.json`)), rotate: true, revoke_device_ids: [dev("bob")] });
  assert.equal(r.rotated, true);
  await imp(kA, m, "轮换后.txt", "排除 bob 设备之后写的");
  await pass(kA, [kB], m);
  await pass(kA, [kB], m);
  assert.ok(!(await log(kA, m)).some((e) => e.kind === "wrap"), "不补包裹");
  assert.equal(rawKey(kA, m, 2, dev("bob")), undefined);
  assert.ok(!hasDoc(kB, m, "轮换后.txt"), "被排除的设备读不到");
});

test("S12B-06/08：唯一负责人的设备被吊销——成员本机不被移出、不暂停（吊销之前收下的照收）；重新引导期间暂停，收到链后恢复", { timeout: 180_000 }, async () => {
  const m = await newMatter(kA, "唯一负责人吊销");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob") });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("carol") });
  await imp(kA, m, "甲.txt", "甲");
  await pass(kA, [kB, kC], m);
  const revoke = (k: TestKernel) => {
    k.kernel.db.run(`INSERT OR IGNORE INTO cp_revoked_devices (tenant_id, device_id, revoked_at, source) VALUES (?,?,?,?)`, [TID, dev("test-lawyer"), new Date(Date.now() + 5).toISOString(), "test"]);
    k.kernel.db.run(`UPDATE devices SET status = 'revoked', revoked_at = ? WHERE device_id = ?`, [new Date(Date.now() + 5).toISOString(), dev("test-lawyer")]);
  };
  await new Promise((r) => setTimeout(r, 10));
  revoke(kB);
  revoke(kC);
  const s = dir("rv");
  const ex = await kC.inv("sync.export", { share_dir: s, matter_id: m });
  assert.deepEqual(ex.pausedConflict, []);
  assert.deepEqual(alerts(kC, m), []);
  await kB.inv("sync.import", { share_dir: s });
  assert.equal(role(kB, m, usr("bob"))?.live, 1, "bob 仍在");
  assert.equal(role(kB, m, usr("carol"))?.live, 1);
  assert.ok((await kB.inv("matters.member_log", { matter_id: m })).anchored);
  // S12B-08：重新引导期间暂停，收到链后恢复
  await kC.inv("matters.sync_rebootstrap", { matter_id: m });
  await imp(kC, m, "丙-重新引导后.txt", "x");
  const ex2 = await kC.inv("sync.export", { share_dir: dir("rb"), matter_id: m });
  assert.deepEqual(ex2.pausedConflict, [m]);
  const sb = dir("rbb");
  await kB.inv("sync.export", { share_dir: sb, matter_id: m });
  await kC.inv("sync.import", { share_dir: sb });
  assert.deepEqual(alerts(kC, m), []);
});
