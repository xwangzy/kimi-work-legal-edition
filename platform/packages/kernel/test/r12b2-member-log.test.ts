// 第 12 批第二轮复核 B 的复现转入（原断言 ec533f3 上的错误表现，处置后改为回归用例），见 docs/review/第12批-复核B-内核与界面.md 第七节与其处置。共享文件夹介质。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson, signSyncWith, unwrapMatterKey, wrapMatterKey, generateMatterKey } from "@zr-legal/keys";
import { sealSegment, writeSegment, parseSegment } from "@zr-legal/sync";
import { makeKernel, type TestKernel } from "./helpers.ts";

const FIRM = "r12b2";
const TID = `ten_${FIRM}`;
const usr = (s: string) => `usr_${FIRM}_${s}`;
const dev = (s: string) => `dev_${FIRM}_${s}`;
let kA: TestKernel;
let kB: TestKernel;
let kC: TestKernel;
let kD: TestKernel;
const others: TestKernel[] = [];

async function open(slug: string, env: Record<string, string> = {}): Promise<TestKernel> {
  const d = mkdtempSync(join(tmpdir(), `kwl-r12b2-${slug}-`));
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
const dir = (tag: string) => mkdtempSync(join(tmpdir(), `kwl-r12b2-${tag}-`));
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

test("S12B-19：三位负责人循环互降不收敛时取保守结果——降级都成立、被降级者并发的加人不成立", { timeout: 180_000 }, async () => {
  const m = await newMatter(kA, "三角降级");
  for (const u of ["bob", "carol", "dave"]) await kA.inv("matters.members.add", { matter_id: m, user_id: usr(u), matter_role: "owner" });
  await pass(kA, [kB, kC, kD], m);
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "editor" });
  await kB.inv("matters.members.add", { matter_id: m, user_id: usr("carol"), matter_role: "editor" });
  await kB.inv("matters.members.add", { matter_id: m, user_id: usr("mallory"), matter_role: "owner" });
  await kC.inv("matters.members.add", { matter_id: m, user_id: usr("test-lawyer"), matter_role: "editor" });
  await pass(kA, [kD], m);
  await pass(kB, [kD], m);
  await pass(kC, [kD], m);
  // 循环降级没有不动点：取保守结果——三条降级都成立，被降级者与之并发的其他事件（bob 加 mallory 为负责人）拒收
  for (const u of ["test-lawyer", "bob", "carol"]) assert.equal(role(kD, m, usr(u))?.matter_role, "editor");
  assert.notEqual(role(kD, m, usr("mallory"))?.matter_role, "owner", "被降级者并发的加人不成立");
  assert.equal(role(kD, m, usr("dave"))?.matter_role, "owner", "未卷入的负责人不受影响");
});

test("S12B-20：本机的轮换先不成立、合并更多事件后又成立——密钥没删，重新用新纪元加密，被移出者读不到", { timeout: 180_000 }, async () => {
  const m = await newMatter(kA, "收回后又成立");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "owner" });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("dave"), matter_role: "owner" });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("carol") });
  await pass(kA, [kB, kC, kD], m);
  // A 移出 carol（轮换到纪元 2）；同时 bob 把 A 降为编辑；同时 dave 把 bob 降为编辑
  await kA.inv("matters.members.remove", { matter_id: m, user_id: usr("carol") });
  assert.equal(ownEpoch(kA, m, dev("test-lawyer")), 2);
  await kB.inv("matters.members.add", { matter_id: m, user_id: usr("test-lawyer"), matter_role: "editor" });
  await kD.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "editor" });
  await pass(kB, [kA], m);
  await pass(kD, [kA], m);
  const st = await statusOf(kA, m);
  assert.ok(st.some((x) => x.startsWith(`member:${usr("carol")}::valid`)), `bob 的降级被 dave 的降级拒收，A 的移出重新成立 ${st}`);
  assert.equal((await kA.inv("matters.member_log", { matter_id: m })).encrypt_epoch, 2, "密钥没有被删，A 重新用纪元 2 加密");
  await imp(kA, m, "移出之后.txt", "carol 已被移出之后写的");
  const ex = await kA.inv("sync.export", { share_dir: dir("after"), matter_id: m });
  const seg = parseSegment(readFileSync(ex.segments[ex.segments.length - 1], "utf8"))!;
  assert.equal(seg.header.key_epoch, 2);
  const { openSegmentBody } = await import("@zr-legal/sync");
  const carol = await deviceOf(kC, "carol");
  const k1 = unwrapMatterKey(rawKey(kC, m, 1, carol.id)!, carol.keys.encPrivateKeyPem);
  assert.throws(() => openSegmentBody(seg, k1), "被移出的 carol 用纪元 1 解不开");
});

test("S12B-21：成员伪造的缺前序事件不冻结成员行：负责人加的人在册、移得掉；移出的人按链移出", { timeout: 180_000 }, async () => {
  const m = await newMatter(kA, "冻结成员行");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob") });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("carol") });
  await pass(kA, [kB, kC], m);
  const bob = await deviceOf(kB, "bob");
  const k1 = unwrapMatterKey(rawKey(kB, m, 1, bob.id)!, bob.keys.encPrivateKeyPem);
  const junk = [usr("erin"), usr("carol")].map((u, i) => forgeEvent(bob, m, "member", ["e".repeat(63) + i], 9, { user: u, role: "viewer" }));
  const share = dir("freeze");
  forgeSegment(share, bob, m, 1, k1, junk.map((e) => ({ t: "member_events", pk: e.event_id, row: e as any })));
  for (const k of [kA, kC]) await k.inv("sync.import", { share_dir: share });
  assert.deepEqual(alerts(kA, m), [], "只计不停");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("erin") });
  assert.equal(role(kA, m, usr("erin"))?.live, 1, "负责人加的人在本机在册（成员伪造的缺前序事件不冻结）");
  await kA.inv("matters.members.remove", { matter_id: m, user_id: usr("erin") });
  assert.equal(role(kA, m, usr("erin"))?.live, 0, "也移得掉");
  await kA.inv("matters.members.remove", { matter_id: m, user_id: usr("carol") });
  assert.equal(role(kA, m, usr("carol"))?.live, 0);
  // 被移出者解不开移出他的那一段（新纪元不包给他），本机看不到自己被移出——与第 11 批相同；要紧的是读不到之后的内容
  await imp(kA, m, "移出后.txt", "carol 移出之后写的");
  await pass(kA, [kC], m);
  assert.ok(!hasDoc(kC, m, "移出后.txt"), "carol 读不到移出之后的内容");
});

test("S12B-22：恢复轮换排除的设备，改角色与之后的轮换都不再包给它", { timeout: 180_000 }, async () => {
  const m = await newMatter(kA, "排除被改角色抵消");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob") });
  await pass(kA, [kB], m);
  const shareDir = join(kA.dir, FIRM, "keys", "recovery-shares");
  await kA.inv("recovery.restore_matter", { matter_id: m, share_files: [1, 2, 3].map((x) => join(shareDir, `share-${x}.json`)), rotate: true, revoke_device_ids: [dev("bob")] });
  assert.equal(rawKey(kA, m, 2, dev("bob")), undefined);
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "reviewer" });
  assert.equal(rawKey(kA, m, 2, dev("bob")), undefined, "改角色也不包给被排除的设备");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("carol") });
  await kA.inv("matters.members.remove", { matter_id: m, user_id: usr("carol") });
  assert.equal(rawKey(kA, m, 3, dev("bob")), undefined, "之后的轮换也不包给它");
  await imp(kA, m, "排除之后.txt", "x");
  await pass(kA, [kB], m);
  assert.ok(!hasDoc(kB, m, "排除之后.txt"), "被排除的设备读不到");
});

test("S12B-23：被移出者在旧链头上“移出移出他的人 + 轮换”拒收，他的密钥不被采用", { timeout: 180_000 }, async () => {
  const { chainView } = await import("../src/member-log.ts");
  const m = await newMatter(kA, "报复带轮换");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "owner" });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("carol") });
  await pass(kA, [kB, kC], m);
  // A 把 bob 降为编辑并移出（轮换到纪元 2，不含 bob）
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "editor" });
  await kA.inv("matters.members.remove", { matter_id: m, user_id: usr("bob") });
  // bob（改过的客户端）在旧链头上写：移出 A，并声明纪元 2——包裹只给 carol（不给自己，避开 rekey_needed），密钥他自己知道
  const bob = await deviceOf(kB, "bob");
  const vb = chainView({ db: kB.kernel.db, keyctx: undefined as any, tenantId: TID }, m);
  const lam = Math.max(...vb.heads.map((h) => vb.events.get(h)!.p.lamport)) + 1;
  const evil = generateMatterKey();
  const carolEnc = kA.kernel.db.get<{ enc_pub_pem: string }>(`SELECT enc_pub_pem FROM devices WHERE device_id = ?`, [dev("carol")])!.enc_pub_pem;
  const wC = wrapMatterKey(evil, carolEnc);
  const ev = forgeEvent(bob, m, "member", vb.heads, lam, { user: usr("test-lawyer"), role: null, key: { epoch: 2, fp: fpOf(evil), wraps: { [dev("carol")]: digestOf(wC) } } });
  const k1 = unwrapMatterKey(rawKey(kB, m, 1, bob.id)!, bob.keys.encPrivateKeyPem);
  const sb = dir("evil");
  const chainRows = (await import("../src/member-log.ts")).exportEventRows({ db: kB.kernel.db, keyctx: undefined as any, tenantId: TID }, m);
  forgeSegment(sb, bob, m, 1, k1, [...chainRows, ev].map((e) => ({ t: "member_events", pk: e.event_id, row: e as any })), [
    { matter_id: m, epoch: 2, wrapped_for: dev("carol"), wrapped_key: wC, created_at: new Date().toISOString() },
  ]);
  await pass(kA, [kC], m);
  await kC.inv("sync.import", { share_dir: sb });
  const st = await statusOf(kC, m);
  assert.ok(st.some((x) => x === `member:${usr("test-lawyer")}::rejected:author_demoted_concurrently`), `被移出者移出移出者（不是降级）不算报复，拒收 ${st}`);
  assert.equal(role(kC, m, usr("test-lawyer"))?.matter_role, "owner");
  assert.equal(role(kC, m, usr("bob"))?.live, 0, "bob 已被移出");
  await imp(kC, m, "丙-之后.txt", "carol 之后写的");
  const ex = await kC.inv("sync.export", { share_dir: dir("cout"), matter_id: m });
  const seg = parseSegment(readFileSync(ex.segments[ex.segments.length - 1], "utf8"))!;
  const { openSegmentBody } = await import("@zr-legal/sync");
  assert.throws(() => openSegmentBody(seg, evil), "bob 的密钥解不开 carol 之后的内容");
});

test("核对 S12B-10：rekey_needed 超过 24 小时，非处置者的负责人接手轮换（正向核对）", { timeout: 180_000 }, async () => {
  const m = await newMatter(kA, "接手");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "owner" });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("carol") });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("dave") });
  await pass(kA, [kB], m);
  await kA.inv("matters.members.remove", { matter_id: m, user_id: usr("carol") });
  await kB.inv("matters.members.remove", { matter_id: m, user_id: usr("dave") });
  const sa = dir("ta");
  await kA.inv("sync.export", { share_dir: sa, matter_id: m });
  const sb = dir("tb");
  await kB.inv("sync.export", { share_dir: sb, matter_id: m });
  // 两边各收对方的段：处置者（纪元 2 胜者的作者）当场轮换到 3；另一位等待
  await kA.inv("sync.import", { share_dir: sb });
  await kB.inv("sync.import", { share_dir: sa });
  const ep = async (k: TestKernel) => (await k.inv("matters.member_log", { matter_id: m })).epoch;
  const [rot, wait] = (await ep(kA)) === 3 ? [kA, kB] : [kB, kA];
  assert.equal(await ep(rot), 3);
  assert.equal(await ep(wait), 2);
  assert.ok(alerts(wait, m).includes("rekey_needed"), String(alerts(wait, m)));
  // 未超时：等待方不轮换
  await wait.inv("sync.export", { share_dir: dir("tc0"), matter_id: m });
  assert.equal(await ep(wait), 2);
  wait.kernel.db.run(`UPDATE sync_alerts SET first_at = ? WHERE matter_id = ? AND kind = 'rekey_needed'`, [new Date(Date.now() - 25 * 3600_000).toISOString(), m]);
  await wait.inv("sync.export", { share_dir: dir("tc"), matter_id: m });
  assert.equal(await ep(wait), 3, "超时后接手轮换");
});

test("S12B-23 变体：被移出者在旧链头上“降级移出者 + 轮换”——降级作为报复成立，但其中的纪元声明不算，在册成员不用他的密钥", { timeout: 180_000 }, async () => {
  const { chainView, exportEventRows } = await import("../src/member-log.ts");
  const m = await newMatter(kA, "报复降级带轮换");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "owner" });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("carol") });
  await pass(kA, [kB, kC], m);
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "editor" });
  await kA.inv("matters.members.remove", { matter_id: m, user_id: usr("bob") });
  const bob = await deviceOf(kB, "bob");
  const vb = chainView({ db: kB.kernel.db, keyctx: undefined as any, tenantId: TID }, m);
  const lam = Math.max(...vb.heads.map((h) => vb.events.get(h)!.p.lamport)) + 1;
  const evil = generateMatterKey();
  const carolEnc = kA.kernel.db.get<{ enc_pub_pem: string }>(`SELECT enc_pub_pem FROM devices WHERE device_id = ?`, [dev("carol")])!.enc_pub_pem;
  const wC = wrapMatterKey(evil, carolEnc);
  const ev = forgeEvent(bob, m, "member", vb.heads, lam, { user: usr("test-lawyer"), role: "editor", key: { epoch: 2, fp: fpOf(evil), wraps: { [dev("carol")]: digestOf(wC) } } });
  const k1 = unwrapMatterKey(rawKey(kB, m, 1, bob.id)!, bob.keys.encPrivateKeyPem);
  const sb = dir("evil2");
  const chainRows = exportEventRows({ db: kB.kernel.db, keyctx: undefined as any, tenantId: TID }, m);
  forgeSegment(sb, bob, m, 1, k1, [...chainRows, ev].map((e) => ({ t: "member_events", pk: e.event_id, row: e as any })), [
    { matter_id: m, epoch: 2, wrapped_for: dev("carol"), wrapped_key: wC, created_at: new Date().toISOString() },
  ]);
  await pass(kA, [kC], m);
  await kC.inv("sync.import", { share_dir: sb });
  const st = await statusOf(kC, m);
  assert.ok(st.some((x) => x === `member:${usr("test-lawyer")}:editor:valid:`), `报复的降级成立 ${st}`);
  assert.equal(role(kC, m, usr("bob"))?.live, 0, "bob 仍被移出");
  // 纪元 2 只认 A 那份声明（A 的移出与 bob 的降级并发，A 的声明同样不算时，纪元 2 无人声明——carol 等补轮换）
  const kc = unwrapMatterKey(rawKey(kC, m, 2, dev("carol")) ?? wC, (await deviceOf(kC, "carol")).keys.encPrivateKeyPem);
  assert.notEqual(Buffer.from(kc).toString("hex"), Buffer.from(evil).toString("hex"), "carol 没有换成 bob 的密钥");
  await imp(kC, m, "丙-之后2.txt", "carol 之后写的");
  const ex = await kC.inv("sync.export", { share_dir: dir("cout2"), matter_id: m });
  const { openSegmentBody } = await import("@zr-legal/sync");
  for (const f of ex.segments) {
    const seg = parseSegment(readFileSync(f, "utf8"))!;
    assert.throws(() => openSegmentBody(seg, evil), "bob 的密钥解不开 carol 之后发出的任何段");
  }
});


// 放在最后：本用例在 bob、carol 的库里吊销了 A 的设备
test("S12B-18：重新引导保留事件与收下时刻，缓存与真实视图一致，唯一负责人吊销后重新引导的成员不被永久暂停", { timeout: 180_000 }, async () => {
  const m = await newMatter(kA, "缓存键-重新引导");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob") });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("carol") });
  await pass(kA, [kB, kC], m);
  const revoke = (k: TestKernel) => {
    k.kernel.db.run(`INSERT OR IGNORE INTO cp_revoked_devices (tenant_id, device_id, revoked_at, source) VALUES (?,?,?,?)`, [TID, dev("test-lawyer"), new Date(Date.now() + 5).toISOString(), "test"]);
    k.kernel.db.run(`UPDATE devices SET status = 'revoked', revoked_at = ? WHERE device_id = ?`, [new Date(Date.now() + 5).toISOString(), dev("test-lawyer")]);
  };
  await new Promise((r) => setTimeout(r, 10));
  revoke(kB);
  revoke(kC);
  await new Promise((r) => setTimeout(r, 20));
  // 与 r12b S12B-06/08 相同：carol 先导出一次（视图入缓存），再重新引导、从 bob 收回链
  await kC.inv("sync.export", { share_dir: dir("c0"), matter_id: m });
  await kC.inv("matters.sync_rebootstrap", { matter_id: m });
  const sb = dir("rbb");
  await kB.inv("sync.export", { share_dir: sb, matter_id: m });
  await kC.inv("sync.import", { share_dir: sb });
  // 重新引导不删事件、保留收下时刻（吊销之前收下的照收）：缓存与不走缓存的视图一致，全部有效、没有告警，缓存失效后也一样
  const cached = await statusOf(kC, m);
  const fresh = await uncached(kC, m);
  assert.ok(cached.every((x) => x.includes(":valid:")), String(cached));
  assert.ok(fresh.every((x) => x.includes(":valid:")), String(fresh));
  kC.kernel.db.run(`INSERT OR IGNORE INTO cp_revoked_devices (tenant_id, device_id, revoked_at, source) VALUES (?,?,?,?)`, [TID, "dev_r12b2_nobody", new Date().toISOString(), "test"]);
  const ex = await kC.inv("sync.export", { share_dir: dir("c1"), matter_id: m });
  assert.deepEqual(alerts(kC, m), []);
  assert.deepEqual(ex.pausedConflict, []);
});
