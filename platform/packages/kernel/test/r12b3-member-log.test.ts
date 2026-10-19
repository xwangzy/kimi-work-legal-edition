// 第 12 批第三轮复核 B 的复现转入（原断言 358decc 上的错误表现，处置后改为回归用例），见 docs/review/第12批-复核B-内核与界面.md 第八节与其处置。共享文件夹介质。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson, signSyncWith, unwrapMatterKey, wrapMatterKey, generateMatterKey } from "@zr-legal/keys";
import { sealSegment, writeSegment, parseSegment } from "@zr-legal/sync";
import { makeKernel, type TestKernel } from "./helpers.ts";

const FIRM = "r12b3";
const TID = `ten_${FIRM}`;
const usr = (s: string) => `usr_${FIRM}_${s}`;
const dev = (s: string) => `dev_${FIRM}_${s}`;
let kA: TestKernel;
let kB: TestKernel;
let kC: TestKernel;
let kD: TestKernel;
const others: TestKernel[] = [];

async function open(slug: string, env: Record<string, string> = {}): Promise<TestKernel> {
  const d = mkdtempSync(join(tmpdir(), `kwl-r12b3-${slug}-`));
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
const dir = (tag: string) => mkdtempSync(join(tmpdir(), `kwl-r12b3-${tag}-`));
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
const statusOf = async (k: TestKernel, mid: string) => (await log(k, mid)).map((e) => `${e.kind}:${e.user ?? ""}:${e.role ?? ""}:${e.status}:${e.reason ?? ""}`);

const uncached = async (k: TestKernel, mid: string) => {
  const { chainView } = await import("../src/member-log.ts");
  // 带 liveBefore（空表）的视图不走缓存，吊销时刻仍按 revokedAtOf 取：与缓存视图应完全一致
  const v = chainView({ db: k.kernel.db, keyctx: undefined as any, tenantId: TID }, mid, { liveBefore: new Map() });
  return [...v.events.values()].sort((a, b) => a.p.lamport - b.p.lamport || (a.id < b.id ? -1 : 1)).map((e) => `${e.p.kind}:${String(e.p.body.user ?? "")}:${String(e.p.body.role ?? "")}:${v.status.get(e.id)!.s}:${(v.status.get(e.id) as any).why ?? ""}`);
};
const blobOf = (k: TestKernel, mid: string, fn: string) => k.kernel.db.get<{ u: string }>(`SELECT storage_uri AS u FROM document_versions WHERE matter_id = ? AND filename = ?`, [mid, fn])?.u;
const encEpoch = async (k: TestKernel, mid: string) => (await k.inv("matters.member_log", { matter_id: mid })).encrypt_epoch as number | null;

test("S12B-31：材料块按链上已声明的纪元加密——在册成员本机留着的、被移出者生成的纪元不再被用，被移出者解不开共享目录里的新材料", { timeout: 180_000 }, async () => {
  const { blobHeaderOf, openBlob } = await import("../src/blobs.ts");
  const m = await newMatter(kA, "块纪元-泄露");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "owner" });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("carol"), matter_role: "editor" });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("dave") });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("erin") });
  await pass(kA, [kB, kC, kD], m);
  // A 把 bob 降为编辑并移出（纪元 2）；同时 bob（正常客户端，尚未收到）先后移出 dave、erin（他那边的纪元 2、3）
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "editor" });
  await kA.inv("matters.members.remove", { matter_id: m, user_id: usr("bob") });
  await kB.inv("matters.members.remove", { matter_id: m, user_id: usr("dave") });
  await kB.inv("matters.members.remove", { matter_id: m, user_id: usr("erin") });
  assert.equal(ownEpoch(kB, m, dev("bob")), 3);
  // carol 先收到 bob 的段（那时 bob 的轮换有效，收下纪元 2、3 的包裹），再收到 A 的段
  await pass(kB, [kC], m);
  await pass(kA, [kC], m);
  const st = await statusOf(kC, m);
  assert.ok(st.filter((x) => x.includes("rejected:author_demoted_concurrently")).length === 2, `bob 的两次移出拒收 ${st}`);
  assert.equal(role(kC, m, usr("bob"))?.live, 0, "bob 已被移出");
  assert.equal(await encEpoch(kC, m), 2, "段按链上纪元 2（A 的）加密");
  assert.equal(ownEpoch(kC, m, dev("carol")), 3, "本机仍留着 bob 生成、链上不成立的纪元 3");
  assert.deepEqual(alerts(kC, m), [], "不暂停");
  await imp(kC, m, "丙-机密.txt", "carol 在 bob 被移出之后写的机密");
  const uri = blobOf(kC, m, "丙-机密.txt")!;
  const s = dir("leak");
  await kC.inv("sync.export", { share_dir: s, matter_id: m });
  const rel = uri.slice("blob://".length).split("/");
  const env = readFileSync(join(s, TID, "blobs", ...rel));
  assert.equal(blobHeaderOf(env)!.epoch, 2, "材料块按链上纪元 2 加密（不按本机留着的、链上不成立的纪元 3）");
  const bob = await deviceOf(kB, "bob");
  const k3 = unwrapMatterKey(rawKey(kB, m, 3, bob.id)!, bob.keys.encPrivateKeyPem);
  assert.throws(() => openBlob(k3, env), "被移出的 bob 用他的纪元 3 解不开");
});

test("S12B-32：本机的轮换不成立后，新材料块按链上纪元加密，其他成员读得到", { timeout: 180_000 }, async () => {
  const { blobHeaderOf } = await import("../src/blobs.ts");
  const m = await newMatter(kA, "块纪元-漏发");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "owner" });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("carol"), matter_role: "editor" });
  await pass(kA, [kB, kC], m);
  await kA.inv("matters.members.remove", { matter_id: m, user_id: usr("carol") });
  await kB.inv("matters.members.add", { matter_id: m, user_id: usr("test-lawyer"), matter_role: "editor" });
  await pass(kB, [kA], m);
  assert.equal(await encEpoch(kA, m), 1, "A 的轮换不成立，段改按纪元 1");
  assert.deepEqual(alerts(kA, m), []);
  await imp(kA, m, "甲-之后.txt", "A 的轮换不成立之后写的");
  const uri = blobOf(kA, m, "甲-之后.txt")!;
  const s = dir("lost");
  await kA.inv("sync.export", { share_dir: s, matter_id: m });
  const env = readFileSync(join(s, TID, "blobs", ...uri.slice("blob://".length).split("/")));
  assert.equal(blobHeaderOf(env)!.epoch, 1, "材料块按链上纪元 1 加密");
  await kB.inv("sync.import", { share_dir: s });
  assert.equal(kB.kernel.blobs.read(uri).toString("utf8"), "A 的轮换不成立之后写的", "bob 读得到");
});

test("S12B-33：两步报复——两条都成立，记互相降级告警并暂停，不据此擦除移出者本机", { timeout: 180_000 }, async () => {
  const { exportEventRows } = await import("../src/member-log.ts");
  const m = await newMatter(kA, "两步报复");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "owner" });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("carol"), matter_role: "editor" });
  await pass(kA, [kB, kC], m);
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "editor" });
  await kA.inv("matters.members.remove", { matter_id: m, user_id: usr("bob") });
  // bob 用正常客户端（尚未收到 A 的段）：先把 A 降为编辑，再移出 A（接口要求先降级）
  await kB.inv("matters.members.add", { matter_id: m, user_id: usr("test-lawyer"), matter_role: "editor" });
  await kB.inv("matters.members.remove", { matter_id: m, user_id: usr("test-lawyer") });
  await pass(kA, [kC], m);
  // bob 的链送到 carol（这里用 bob 手里的纪元 1 封段；正常段用 bob 的纪元 2 封，见 S12B-36）
  const bob = await deviceOf(kB, "bob");
  const k1 = unwrapMatterKey(rawKey(kB, m, 1, bob.id)!, bob.keys.encPrivateKeyPem);
  const sb = dir("two");
  const rows = exportEventRows({ db: kB.kernel.db, keyctx: undefined as any, tenantId: TID }, m);
  forgeSegment(sb, bob, m, 1, k1, rows.map((e) => ({ t: "member_events", pk: e.event_id, row: e as any })));
  await kC.inv("sync.import", { share_dir: sb });
  // 两步报复：两条都成立（失败即关闭），记互相降级告警、暂停发出；在第三位负责人处置之前不据此移出本机成员行（A 不被擦除）
  assert.ok(alerts(kC, m).includes("member_conflict"), String(alerts(kC, m)));
  assert.deepEqual((await kC.inv("sync.export", { share_dir: dir("two2"), matter_id: m })).pausedConflict, [m]);
  assert.equal(role(kA, m, usr("test-lawyer"))?.live, 1, "A 本机不被移出");
});

test("S12B-36：两步报复 + 正常段——先收到不同一方的成员也收齐双方的链、结果一致，互相降级告警、暂停，被移出者读不到", { timeout: 180_000 }, async () => {
  const m = await newMatter(kA, "两步报复-分裂");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "owner" });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("carol"), matter_role: "editor" });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("dave"), matter_role: "editor" });
  await pass(kA, [kB, kC, kD], m);
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "editor" });
  await kA.inv("matters.members.remove", { matter_id: m, user_id: usr("bob") });
  await kB.inv("matters.members.add", { matter_id: m, user_id: usr("test-lawyer"), matter_role: "editor" });
  await kB.inv("matters.members.remove", { matter_id: m, user_id: usr("test-lawyer") });
  // dave 先收到 bob 的段，carol 先收到 A 的段；之后两人都反复收到双方的段
  await pass(kB, [kD], m);
  await pass(kA, [kC], m);
  for (let i = 0; i < 2; i++) {
    await pass(kA, [kD, kC], m);
    await pass(kB, [kC, kD], m);
  }
  // 延后段的链按“曾是成员”另存：两边收齐双方的链、结果一致——互相降级告警、暂停发出，被移出的 bob 读不到之后的内容
  assert.deepEqual(await statusOf(kD, m), await statusOf(kC, m), "dave 与 carol 的成员链一致");
  for (const k of [kC, kD]) assert.ok(alerts(k, m).includes("member_conflict"), String(alerts(k, m)));
  await imp(kD, m, "丁-之后.txt", "dave 之后写的");
  const ex = await kD.inv("sync.export", { share_dir: dir("dout"), matter_id: m });
  assert.deepEqual(ex.pausedConflict, [m], "dave 暂停发出内容");
  const { openSegmentBody } = await import("@zr-legal/sync");
  const bob = await deviceOf(kB, "bob");
  const k2 = unwrapMatterKey(rawKey(kB, m, 2, bob.id)!, bob.keys.encPrivateKeyPem);
  for (const f of ex.segments) {
    const sg = parseSegment(readFileSync(f, "utf8"))!;
    let rows: unknown = null;
    try {
      rows = openSegmentBody(sg, k2);
    } catch {
      rows = null;
    }
    assert.ok(!JSON.stringify(rows ?? "").includes("丁-之后.txt"), "bob 读不到 dave 之后的内容");
  }
});

test("S12B-34：不收敛时的保守结果只豁免真正的降级——被降级者并发的“加人为编辑”不成立", { timeout: 180_000 }, async () => {
  const m = await newMatter(kA, "三角降级-加编辑");
  for (const u of ["bob", "carol", "dave"]) await kA.inv("matters.members.add", { matter_id: m, user_id: usr(u), matter_role: "owner" });
  await pass(kA, [kB, kC, kD], m);
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "editor" });
  await kB.inv("matters.members.add", { matter_id: m, user_id: usr("carol"), matter_role: "editor" });
  await kB.inv("matters.members.add", { matter_id: m, user_id: usr("mallory"), matter_role: "editor" });
  await kC.inv("matters.members.add", { matter_id: m, user_id: usr("test-lawyer"), matter_role: "editor" });
  await pass(kA, [kD], m);
  await pass(kB, [kD], m);
  await pass(kC, [kD], m);
  for (const u of ["test-lawyer", "bob", "carol"]) assert.equal(role(kD, m, usr(u))?.matter_role, "editor");
  const st = await statusOf(kD, m);
  assert.ok(st.includes(`member:${usr("mallory")}:editor:rejected:author_demoted_concurrently`), `与降级 bob 并发、bob 写的加人不成立 ${st}`);
  assert.notEqual(role(kD, m, usr("mallory"))?.live, 1, "mallory 不在册");
});

test("S12B-37：本机轮换“不成立→成立→再不成立”——每次转为不成立都重发，成立期间的内容送到", { timeout: 180_000 }, async () => {
  const kE = await open("eve");
  const all = [kA, kB, kC, kD, kE];
  copyDev(kE, dev("eve"), all.filter((x) => x !== kE));
  for (const [k, s] of [[kA, "test-lawyer"], [kB, "bob"], [kC, "carol"], [kD, "dave"]] as const) copyDev(k, dev(s), [kE]);
  const m = await newMatter(kA, "反复翻转");
  for (const u of ["bob", "dave", "eve"]) await kA.inv("matters.members.add", { matter_id: m, user_id: usr(u), matter_role: "owner" });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("carol") });
  await pass(kA, [kB, kD, kE], m);
  // A 移出 carol（纪元 2）；bob 降级 A；dave 降级 bob；eve 降级 dave——四条两两并发
  await kA.inv("matters.members.remove", { matter_id: m, user_id: usr("carol") });
  await kB.inv("matters.members.add", { matter_id: m, user_id: usr("test-lawyer"), matter_role: "editor" });
  await kD.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "editor" });
  await kE.inv("matters.members.add", { matter_id: m, user_id: usr("dave"), matter_role: "editor" });
  const sB = await pass(kB, [kA], m); // A 的移出不成立（第一次重发）
  assert.equal(await encEpoch(kA, m), 1);
  await pass(kD, [kA], m); // bob 的降级被 dave 的降级拒收，A 的移出重新成立
  assert.equal(await encEpoch(kA, m), 2);
  await imp(kA, m, "成立期间.txt", "A 的移出重新成立期间写的");
  const sX = dir("x");
  await kA.inv("sync.export", { share_dir: sX, matter_id: m });
  await pass(kE, [kA], m); // dave 的降级被 eve 的降级拒收，bob 的降级重新成立，A 的移出再次不成立
  assert.equal(await encEpoch(kA, m), 1);
  // bob 收齐各方的链后再收 A 此后的段：每次“成立→不成立”都重发一次，成立期间的内容按链上纪元重发送到
  await pass(kD, [kB], m);
  await pass(kE, [kB], m);
  await kB.inv("sync.import", { share_dir: sX });
  await pass(kA, [kB], m);
  await pass(kA, [kB], m);
  assert.ok(hasDoc(kB, m, "成立期间.txt"), "成立期间写的内容送到");
});

test("S12B-38：按种类的体积上限按解析后的规范形态量，缩进与多余字段绕不过", { timeout: 180_000 }, async () => {
  const m = await newMatter(kA, "体积上限");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob") });
  await pass(kA, [kB], m);
  const bob = await deviceOf(kB, "bob");
  const payload = { v: "kwl-member-event/1", tenant: TID, matter_id: m, kind: "member", prev: ["f".repeat(64)], lamport: 9, author_device: bob.id, at: new Date().toISOString(), body: { user: usr("x"), role: "viewer", junk: "x".repeat(200 * 1024) } };
  const event_id = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  const row = { event_id, payload: JSON.stringify(payload, null, 1), sig: signSyncWith(bob.keys.signPrivateKeyPem, new TextEncoder().encode(`kwl-member-event/1\n${event_id}`)), author_cert: bob.cert };
  const k1 = unwrapMatterKey(rawKey(kB, m, 1, bob.id)!, bob.keys.encPrivateKeyPem);
  const sh = dir("big");
  forgeSegment(sh, bob, m, 1, k1, [{ t: "member_events", pk: event_id, row: row as any }]);
  await kA.inv("sync.import", { share_dir: sh });
  assert.equal(kA.kernel.db.get(`SELECT 1 AS x FROM member_events WHERE event_id = ?`, [event_id]), undefined, "超过 64 KiB 的成员事件不存（按解析后的规范形态量）");
});

// 放在最后：本用例在 bob、carol 的库里吊销了 A 与 bob 的设备
test("S12B-35：认可与在用标记同一判据——两位负责人的设备先后吊销后，成员的加入事件待定而非拒收，成员不被移出", { timeout: 180_000 }, async () => {
  const m = await newMatter(kA, "先后吊销");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "owner" });
  await pass(kA, [kB], m);
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("carol"), matter_role: "editor" });
  await pass(kA, [kB], m);
  const revoke = (k: TestKernel, d: string) => {
    const t = new Date(Date.now() + 5).toISOString();
    k.kernel.db.run(`INSERT OR IGNORE INTO cp_revoked_devices (tenant_id, device_id, revoked_at, source) VALUES (?,?,?,?)`, [TID, d, t, "test"]);
    k.kernel.db.run(`UPDATE devices SET status = 'revoked', revoked_at = ? WHERE device_id = ?`, [t, d]);
  };
  await new Promise((r) => setTimeout(r, 10));
  revoke(kB, dev("test-lawyer"));
  revoke(kC, dev("test-lawyer"));
  await new Promise((r) => setTimeout(r, 20));
  // bob 写吊销标记（固定 A 在吊销前写的事件），carol 此后第一次收到这条链
  await pass(kB, [kC], m);
  const st0 = await statusOf(kC, m);
  assert.ok(st0.some((x) => x.startsWith("mark:")) && st0.every((x) => x.includes(":valid:")), `bob 的标记认可了 A 的事件 ${st0}`);
  assert.equal(role(kC, m, usr("carol"))?.live, 1);
  // 之后 bob 换电脑（旧设备吊销）
  await new Promise((r) => setTimeout(r, 10));
  revoke(kC, dev("bob"));
  await new Promise((r) => setTimeout(r, 20));
  await kC.inv("sync.export", { share_dir: dir("rv"), matter_id: m });
  // 认可与“在用标记”同一判据（未吊销设备写的）：bob 的标记既不再认可、也不再算标记——A 加 carol 的事件待定，carol 不被移出、本机暂停
  const st = await uncached(kC, m);
  assert.ok(st.includes(`member:${usr("carol")}:editor:pending:revoked_unvouched`), String(st));
  assert.equal(role(kC, m, usr("carol"))?.live, 1, "carol 不被移出（不擦除）");
  assert.ok(alerts(kC, m).includes("chain_pending"), String(alerts(kC, m)));
});
