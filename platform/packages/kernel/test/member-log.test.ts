// 第 12 批：带因果链的成员日志（共享文件夹介质）。设计见 docs/第12批-成员日志设计.md。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson, signSyncWith, unwrapMatterKey, wrapMatterKey, generateMatterKey } from "@zr-legal/keys";
import { sealSegment, writeSegment } from "@zr-legal/sync";
import { makeKernel, type TestKernel } from "./helpers.ts";

const FIRM = "mlog";
const TID = `ten_${FIRM}`;
const usr = (s: string) => `usr_${FIRM}_${s}`;
const dev = (s: string) => `dev_${FIRM}_${s}`;
let kA: TestKernel;
let kB: TestKernel;
let kC: TestKernel;
let kD: TestKernel;
const others: TestKernel[] = [];

async function open(slug: string, env: Record<string, string> = {}, ws?: string): Promise<TestKernel> {
  const dir = ws ?? mkdtempSync(join(tmpdir(), `kwl-mlog-${slug}-`));
  if (!ws) {
    mkdirSync(join(dir, FIRM, "keys"), { recursive: true });
    copyFileSync(join(kA.dir, FIRM, "keys", "firm-root.json"), join(dir, FIRM, "keys", "firm-root.json"));
  }
  const { createKernel } = await import("../src/index.ts");
  const kernel = await createKernel({ dataDir: dir, firmSlug: FIRM, userSlug: slug, env: { ...process.env, ZR_MODEL_PROVIDER: "mock", ...env } });
  const k = { kernel, dir, inv: (m: string, p?: any) => kernel.invoke(m, p) } as TestKernel;
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
const dir = (tag: string) => mkdtempSync(join(tmpdir(), `kwl-mlog-${tag}-`));
const newMatter = async (k: TestKernel, title: string, scope = "team") => (await k.inv("matters.create", { title, stance: "受让方", consent_status: "not_required", collab_scope: scope })).matter.matter_id as string;
const roles = (k: TestKernel, mid: string) =>
  k.kernel.db.all<{ user_id: string; matter_role: string; live: number }>(`SELECT user_id, matter_role, removed_at IS NULL AS live FROM matter_members WHERE matter_id = ? ORDER BY user_id`, [mid]);
const alerts = (k: TestKernel, mid: string) => k.kernel.db.all<{ kind: string }>(`SELECT kind FROM sync_alerts WHERE matter_id = ? ORDER BY kind`, [mid]).map((a) => a.kind);
const hasDoc = (k: TestKernel, mid: string, fn: string) => !!k.kernel.db.get(`SELECT 1 AS x FROM document_versions WHERE matter_id = ? AND filename = ?`, [mid, fn]);
const log = async (k: TestKernel, mid: string) => (await k.inv("matters.member_log", { matter_id: mid })).events as any[];
/** 把 from 导出的该事项段交给 to 摄取（共享文件夹介质）。 */
async function pass(from: TestKernel, to: TestKernel[], mid: string): Promise<void> {
  const s = dir("p");
  await from.inv("sync.export", { share_dir: s, matter_id: mid });
  for (const k of to) await k.inv("sync.import", { share_dir: s });
}

/** 设备私钥与证书（测试里伪造事件与段用）。 */
async function deviceOf(k: TestKernel, slug: string) {
  const { getDeviceKeys, keysDirOf } = await import("../src/index.ts");
  const keys = getDeviceKeys(keysDirOf(join(k.dir, FIRM)));
  const cert = k.kernel.db.get<{ cert_json: string }>(`SELECT cert_json FROM devices WHERE device_id = ?`, [dev(slug)])!.cert_json;
  return { keys, cert, id: dev(slug) };
}
type Dev = Awaited<ReturnType<typeof deviceOf>>;
function forgeEvent(d: Dev, mid: string, kind: string, prev: string[], lamport: number, body: Record<string, unknown>, authorDevice = d.id) {
  const payload = { v: "kwl-member-event/1", tenant: TID, matter_id: mid, kind, prev: [...prev].sort(), lamport, author_device: authorDevice, at: new Date().toISOString(), body };
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
function keyOf(k: TestKernel, d: Dev, mid: string, epoch: number): Uint8Array {
  const w = k.kernel.db.get<{ wrapped_key: string }>(`SELECT wrapped_key FROM matter_keys WHERE matter_id = ? AND epoch = ? AND wrapped_for = ?`, [mid, epoch, d.id])!.wrapped_key;
  return unwrapMatterKey(w, d.keys.encPrivateKeyPem);
}
function heads(k: TestKernel, mid: string): { heads: string[]; lamport: number } {
  const rows = k.kernel.db.all<{ event_id: string; payload: string; lamport: number }>(`SELECT event_id, payload, lamport FROM member_events WHERE matter_id = ?`, [mid]);
  const covered = new Set(rows.flatMap((r) => JSON.parse(r.payload).prev as string[]));
  const hs = rows.filter((r) => !covered.has(r.event_id));
  return { heads: hs.map((r) => r.event_id).sort(), lamport: Math.max(...hs.map((r) => r.lamport)) };
}

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

test("新建团队事项写创世、个人事项不写链；成员操作都记入成员链", async () => {
  const m = await newMatter(kA, "创世");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob") });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("carol"), matter_role: "reviewer" });
  await kA.inv("matters.members.remove", { matter_id: m, user_id: usr("carol") });
  const ev = await log(kA, m);
  assert.deepEqual(ev.map((e) => [e.kind, e.user ? e.user.slice(-5) : null, e.status]), [
    ["genesis", null, "valid"],
    ["member", "g_bob", "valid"],
    ["member", "carol", "valid"],
    ["member", "carol", "valid"],
  ]);
  assert.equal(ev[3].epoch, 2, "移出与轮换在同一事件里");
  const p = await newMatter(kA, "个人", "personal");
  assert.equal((await kA.inv("matters.member_log", { matter_id: p })).anchored, false);
  // 接收方按链得到同样的成员关系
  await pass(kA, [kB], m);
  assert.deepEqual(roles(kB, m), roles(kA, m));
  assert.deepEqual(alerts(kB, m), []);
});

test("包裹只认链上声明：成员塞来的别的密钥（新纪元、同纪元）都不落库", async () => {
  const m = await newMatter(kA, "包裹声明");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob") });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("dave") });
  await pass(kA, [kB, kD], m);
  const bob = await deviceOf(kB, "bob");
  const daveEnc = kA.kernel.db.get<{ enc_pub_pem: string }>(`SELECT enc_pub_pem FROM devices WHERE device_id = ?`, [dev("dave")])!.enc_pub_pem;
  const fake = generateMatterKey();
  const share = dir("fake");
  const k1 = keyOf(kB, bob, m, 1);
  forgeSegment(share, bob, m, 1, k1, [], [
    { matter_id: m, epoch: 2, wrapped_for: dev("dave"), wrapped_key: wrapMatterKey(fake, daveEnc), created_at: new Date().toISOString() },
  ]);
  await kD.inv("sync.import", { share_dir: share });
  assert.equal(kD.kernel.db.get(`SELECT 1 AS x FROM matter_keys WHERE matter_id = ? AND epoch = 2`, [m]), undefined, "未声明的纪元 2 包裹不落库");
  // 用别的密钥加密的段（段里面向 dave 的包裹没有链上声明）：整段延后，内容不收
  const share2 = dir("fake2");
  forgeSegment(share2, bob, m, 3, fake, [], [
    { matter_id: m, epoch: 3, wrapped_for: dev("dave"), wrapped_key: wrapMatterKey(fake, daveEnc), created_at: new Date().toISOString() },
  ]);
  const r = await kD.inv("sync.import", { share_dir: share2 });
  assert.deepEqual(r.dispositions.map((x: any) => x.outcome), ["deferred"]);
  assert.ok(r.originConflicts.some((w: string) => w.includes("没有链上声明")), JSON.stringify(r.originConflicts));
});

test("成员伪造：非负责人的成员事件、借名事件、缺前序事件与伪造的起点都不生效，也不让别人停发", async () => {
  const m = await newMatter(kA, "伪造");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob") });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("dave") });
  await pass(kA, [kB, kD], m);
  const bob = await deviceOf(kB, "bob");
  const { heads: hs, lamport } = heads(kD, m);
  const k1 = keyOf(kB, bob, m, 1);
  const selfPromote = forgeEvent(bob, m, "member", hs, lamport + 1, { user: usr("bob"), role: "owner" });
  const missing = forgeEvent(bob, m, "member", ["f".repeat(64)], lamport + 5, { user: usr("dave"), role: null });
  const borrowed = forgeEvent(bob, m, "member", hs, lamport + 1, { user: usr("dave"), role: null }, dev("test-lawyer"));
  const root = forgeEvent(bob, m, "genesis", [], 1, { creator: usr("bob"), members: [{ user: usr("bob"), role: "owner" }], key: { epoch: 1, fp: "0".repeat(32), wraps: {} } });
  const share = dir("forge");
  forgeSegment(share, bob, m, 1, k1, [selfPromote, missing, borrowed, root].map((e) => ({ t: "member_events", pk: e.event_id, row: e as any })));
  const r = await kD.inv("sync.import", { share_dir: share });
  assert.ok(r.originConflicts.some((w: string) => w.startsWith("member_event_rejected:")), "借名事件核验不通过");
  const ev = await log(kD, m);
  const st = (id: string) => ev.find((e) => e.event_id === id);
  assert.equal(st(selfPromote.event_id)?.reason, "author_not_owner");
  assert.equal(st(missing.event_id)?.reason, "missing_parents");
  assert.equal(st(borrowed.event_id), undefined);
  assert.equal(st(root.event_id)?.reason, "foreign_root");
  assert.ok(roles(kD, m).some((x) => x.user_id === usr("bob") && x.matter_role === "editor"), "bob 仍是编辑");
  assert.deepEqual(alerts(kD, m), [], "成员伪造的缺前序事件与起点不暂停发出");
});

test("并发：移出优先于并发的改角色；互相降级的两位负责人都维持原状；不同到达顺序得到同一结果", async () => {
  const m = await newMatter(kA, "并发");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "owner" });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("carol") });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("dave") });
  await pass(kA, [kB, kC, kD], m);
  // A 移出 carol；bob 同时把 carol 改为审阅人
  await kA.inv("matters.members.remove", { matter_id: m, user_id: usr("carol") });
  await kB.inv("matters.members.add", { matter_id: m, user_id: usr("carol"), matter_role: "reviewer" });
  const sa = dir("ca");
  const sb = dir("cb");
  await kA.inv("sync.export", { share_dir: sa, matter_id: m });
  await kB.inv("sync.export", { share_dir: sb, matter_id: m });
  // dave 先 A 后 bob；A 收 bob；bob 收 A
  await kD.inv("sync.import", { share_dir: sa });
  await kD.inv("sync.import", { share_dir: sb });
  await kA.inv("sync.import", { share_dir: sb });
  await kB.inv("sync.import", { share_dir: sa });
  for (const k of [kA, kB, kD]) assert.ok(roles(k, m).some((x) => x.user_id === usr("carol") && !x.live), "carol 被移出（移出优先）");
  assert.deepEqual(roles(kD, m), roles(kA, m));
  assert.deepEqual(roles(kB, m), roles(kA, m));
  // 互相降级：A 把 bob 降为编辑，bob 同时把 A 降为编辑 → 两条都不成立
  const m2 = await newMatter(kA, "互相降级");
  await kA.inv("matters.members.add", { matter_id: m2, user_id: usr("bob"), matter_role: "owner" });
  await kA.inv("matters.members.add", { matter_id: m2, user_id: usr("dave") });
  await pass(kA, [kB, kD], m2);
  await kA.inv("matters.members.add", { matter_id: m2, user_id: usr("bob"), matter_role: "editor" });
  await kB.inv("matters.members.add", { matter_id: m2, user_id: usr("test-lawyer"), matter_role: "editor" });
  const s1 = dir("m1");
  const s2 = dir("m2");
  await kA.inv("sync.export", { share_dir: s1, matter_id: m2 });
  await kB.inv("sync.export", { share_dir: s2, matter_id: m2 });
  await kD.inv("sync.import", { share_dir: s2 });
  await kD.inv("sync.import", { share_dir: s1 });
  const owners = roles(kD, m2).filter((x) => x.matter_role === "owner" && x.live).map((x) => x.user_id);
  assert.deepEqual(owners, [usr("bob"), usr("test-lawyer")].sort(), "互相降级都不成立，维持原状");
  assert.ok((await log(kD, m2)).filter((e) => e.reason === "author_demoted_concurrently").length === 2);
});

test("成员后登记的设备：负责人下一次同步自动补当前纪元的包裹（wrap 事件）", async () => {
  const m = await newMatter(kA, "后登记设备");
  // erin 加入时还没有登记设备
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("erin") });
  await imp(kA, m, "甲.txt", "甲");
  const kE = await open("erin");
  copyDev(kE, dev("erin"), [kA, kB, kC, kD]);
  for (const s of ["test-lawyer", "bob", "carol", "dave"]) copyDev(kA, dev(s), [kE]);
  await pass(kA, [kE], m);
  const ev = await log(kA, m);
  assert.ok(ev.some((e) => e.kind === "wrap"), "负责人写了补包裹事件");
  assert.ok(kE.kernel.db.get(`SELECT 1 AS x FROM matter_keys WHERE matter_id = ? AND wrapped_for = ?`, [m, dev("erin")]), "erin 持钥");
  assert.ok(hasDoc(kE, m, "甲.txt"));
});

test("吊销标记之后，被吊销设备再写的事件拒收；标记之前收下的照收", async () => {
  const m = await newMatter(kA, "吊销标记");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "owner" });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("dave") });
  await pass(kA, [kB, kD], m);
  // bob 加 carol（A、dave 收到），之后 bob 的设备被吊销
  await kB.inv("matters.members.add", { matter_id: m, user_id: usr("carol") });
  await pass(kB, [kA, kD], m);
  const bob = await deviceOf(kB, "bob");
  const revoke = (k: TestKernel) => {
    k.kernel.db.run(`INSERT OR IGNORE INTO cp_revoked_devices (tenant_id, device_id, revoked_at, source) VALUES (?,?,?,?)`, [TID, dev("bob"), new Date().toISOString(), "test"]);
    k.kernel.db.run(`UPDATE devices SET status = 'revoked', revoked_at = ? WHERE device_id = ?`, [new Date().toISOString(), dev("bob")]);
  };
  revoke(kA);
  revoke(kD);
  // A 下一次同步写吊销标记；dave 收到
  await pass(kA, [kD], m);
  assert.ok((await log(kA, m)).some((e) => e.kind === "mark"));
  assert.ok(roles(kD, m).some((x) => x.user_id === usr("carol") && x.live), "标记之前 bob 加的 carol 仍在");
  // 被盗的 bob 设备之后再写“移出 dave”，经同事转发到 dave：拒收
  const { heads: hs, lamport } = heads(kD, m);
  const late = forgeEvent(bob, m, "member", hs, lamport + 1, { user: usr("dave"), role: null });
  const carolLike = await deviceOf(kA, "test-lawyer");
  const share = dir("late");
  const ep = kA.kernel.db.get<{ e: number }>(`SELECT MAX(epoch) AS e FROM matter_keys WHERE matter_id = ? AND wrapped_for = ?`, [m, dev("test-lawyer")])!.e;
  forgeSegment(share, carolLike, m, ep, keyOf(kA, carolLike, m, ep), [{ t: "member_events", pk: late.event_id, row: late as any }]);
  await kD.inv("sync.import", { share_dir: share });
  assert.equal((await log(kD, m)).find((e) => e.event_id === late.event_id)?.reason, "revoked_after_mark");
  assert.ok(roles(kD, m).some((x) => x.user_id === usr("dave") && x.live), "dave 仍在");
  assert.deepEqual(alerts(kD, m), []);
});

test("节点授权与撤销都记入成员链：撤销即移出节点并轮换", async () => {
  const m = await newMatter(kA, "节点");
  const auth = await kA.inv("matters.node_authorize", { matter_id: m });
  const node = auth.node_device_id as string;
  const rv = await kA.inv("matters.node_revoke", { matter_id: m });
  assert.equal(rv.new_epoch, 2);
  assert.equal(kA.kernel.db.get(`SELECT 1 AS x FROM matter_keys WHERE matter_id = ? AND epoch = 2 AND wrapped_for = ?`, [m, node]), undefined, "新纪元不包给节点");
  const kinds = (await log(kA, m)).map((e) => e.kind);
  assert.deepEqual(kinds, ["genesis", "member", "member"]);
});

test("存量事项锚定：升级前建的事项由创建者锚定，成员按旧成员行认出锚定者后转为链；成员伪造的锚定不采用", { timeout: 120_000 }, async () => {
  // 升级前的两台设备（模拟旧客户端）
  const legacy = { ZR_MEMBER_LOG: "off" };
  const oA = await open("olda", legacy);
  const oB = await open("oldb", legacy);
  copyDev(oA, dev("olda"), [oB]);
  copyDev(oB, dev("oldb"), [oA]);
  const m = await newMatter(oA, "存量");
  await oA.inv("matters.members.add", { matter_id: m, user_id: usr("oldb") });
  await imp(oA, m, "旧.txt", "升级前写的");
  await pass(oA, [oB], m);
  const m2 = await newMatter(oA, "存量2");
  await oA.inv("matters.members.add", { matter_id: m2, user_id: usr("oldb") });
  await pass(oA, [oB], m2);
  // 两台都升级（重启，不带 ZR_MEMBER_LOG）
  const [dA, dB] = [oA.dir, oB.dir];
  await oA.kernel.close();
  await oB.kernel.close();
  const nA = await open("olda", {}, dA);
  const nB = await open("oldb", {}, dB);
  // 成员 oldb 不是锚定者：先导出也不锚定
  await nB.inv("sync.export", { share_dir: dir("nb"), matter_id: m });
  assert.equal((await nB.inv("matters.member_log", { matter_id: m })).anchored, false);
  // 成员伪造一份把自己列为负责人的锚定：oldb 自己的旧成员行里不是负责人 → nA 不采用
  const fb = await deviceOf(nB, "oldb");
  const fakeAnchor = forgeEvent(fb, m2, "anchor", [], 1, { members: [{ user: usr("oldb"), role: "owner", removed: false }], key: { epoch: 1, fp: "0".repeat(32), wraps: {} } });
  const sf = dir("fa");
  forgeSegment(sf, fb, m2, 1, keyOf(nB, fb, m2, 1), [{ t: "member_events", pk: fakeAnchor.event_id, row: fakeAnchor as any }]);
  await nA.inv("sync.import", { share_dir: sf });
  assert.equal((await nA.inv("matters.member_log", { matter_id: m2 })).anchored, false, "成员伪造的锚定不采用");
  // 创建者导出时锚定；成员收到后转为链
  await pass(nA, [nB], m);
  const la = await nA.inv("matters.member_log", { matter_id: m });
  assert.equal(la.anchored, true);
  assert.equal(la.events[0].kind, "anchor");
  assert.equal((await nB.inv("matters.member_log", { matter_id: m })).anchored, true);
  assert.deepEqual(roles(nB, m), roles(nA, m));
  // 之后的成员变更按链
  await nA.inv("matters.members.add", { matter_id: m, user_id: usr("oldb"), matter_role: "reviewer" });
  await pass(nA, [nB], m);
  assert.ok(roles(nB, m).some((x) => x.user_id === usr("oldb") && x.matter_role === "reviewer"));
});

test("起点冲突：两位负责人各自锚定 → 后来者暂停并提示；本机重新引导后按首同步规则采用", { timeout: 120_000 }, async () => {
  const legacy = { ZR_MEMBER_LOG: "off" };
  const oA = await open("cfa", legacy);
  const oB = await open("cfb", legacy);
  copyDev(oA, dev("cfa"), [oB]);
  copyDev(oB, dev("cfb"), [oA]);
  const m = await newMatter(oA, "两份锚定");
  await oA.inv("matters.members.add", { matter_id: m, user_id: usr("cfb"), matter_role: "owner" });
  await pass(oA, [oB], m);
  const [dA, dB] = [oA.dir, oB.dir];
  await oA.kernel.close();
  await oB.kernel.close();
  const nA = await open("cfa", {}, dA);
  const nB = await open("cfb", {}, dB);
  // nA 锚定（创建者）；nB 在收到之前自己也锚定了一份（看法不一致的罕见情形，用伪造的方式模拟它自己签的锚定）
  await nA.inv("sync.export", { share_dir: dir("cfa0"), matter_id: m });
  const fb = await deviceOf(nB, "cfb");
  const bAnchor = forgeEvent(fb, m, "anchor", [], 1, {
    members: [
      { user: usr("cfa"), role: "owner", removed: false },
      { user: usr("cfb"), role: "owner", removed: false },
    ],
    key: { epoch: 1, fp: createHash("sha256").update("kwl-matter-key-fp/1").update(keyOf(nB, fb, m, 1)).digest("hex").slice(0, 32), wraps: {} },
  });
  const sb = dir("cfb1");
  forgeSegment(sb, fb, m, 1, keyOf(nB, fb, m, 1), [{ t: "member_events", pk: bAnchor.event_id, row: bAnchor as any }]);
  await nA.inv("sync.import", { share_dir: sb });
  assert.deepEqual(alerts(nA, m), ["root_conflict"], "另一位负责人的锚定：起点冲突");
  assert.ok((await nA.inv("sync.export", { share_dir: dir("cfa2"), matter_id: m })).pausedConflict.includes(m));
  // 本机重新引导：清链，重新按首同步规则采用（共享文件夹介质：首个合格起点，按编号）
  await nA.inv("matters.sync_rebootstrap", { matter_id: m });
  assert.equal((await nA.inv("matters.member_log", { matter_id: m })).rebootstrap, true);
  await nA.inv("sync.import", { share_dir: sb });
  const after = await nA.inv("matters.member_log", { matter_id: m });
  assert.equal(after.anchored, true);
  assert.deepEqual(alerts(nA, m), []);
});
