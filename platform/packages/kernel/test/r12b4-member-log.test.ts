// 第 12 批第四轮复核 B 的复现转入（原断言 61a4a57 上的错误表现，处置后改为回归用例），见 docs/review/第12批-复核B-内核与界面.md 第九节与其处置。共享文件夹介质。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson, signSyncWith, unwrapMatterKey, wrapMatterKey, generateMatterKey } from "@zr-legal/keys";
import { sealSegment, writeSegment, parseSegment } from "@zr-legal/sync";
import { makeKernel, type TestKernel } from "./helpers.ts";

const FIRM = "r12b4";
const TID = `ten_${FIRM}`;
const usr = (s: string) => `usr_${FIRM}_${s}`;
const dev = (s: string) => `dev_${FIRM}_${s}`;
let kA: TestKernel;
let kB: TestKernel;
let kC: TestKernel;
let kD: TestKernel;
const others: TestKernel[] = [];

async function open(slug: string, env: Record<string, string> = {}): Promise<TestKernel> {
  const d = mkdtempSync(join(tmpdir(), `kwl-r12b4-${slug}-`));
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
const dir = (tag: string) => mkdtempSync(join(tmpdir(), `kwl-r12b4-${tag}-`));
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

const forgeMark = async (k: TestKernel, slug: string, mid: string, target: string) => {
  const { chainView, exportEventRows } = await import("../src/member-log.ts");
  const deps = { db: k.kernel.db, keyctx: undefined as any, tenantId: TID };
  const v = chainView(deps, mid, { liveBefore: new Map() });
  const d = await deviceOf(k, slug);
  const lam = Math.max(...v.heads.map((h) => v.events.get(h)!.p.lamport)) + 1;
  const mark = forgeEvent(d, mid, "mark", v.heads, lam, { device: target });
  return { d, rows: [...exportEventRows(deps, mid), mark], markId: mark.event_id };
};

test("S12B-43：负责人（含正被移出者）给在用同事设备写的标记不算吊销依据——移出照常成立，对方照常操作", { timeout: 180_000 }, async () => {
  const m = await newMatter(kA, "伪造标记");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "owner" });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("carol"), matter_role: "editor" });
  await pass(kA, [kB, kC], m);
  // A 把 bob 降为编辑并移出（纪元 2）
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "editor" });
  await kA.inv("matters.members.remove", { matter_id: m, user_id: usr("bob") });
  await pass(kA, [kC], m);
  assert.equal(role(kC, m, usr("bob"))?.live, 0, "carol 先收到 A 的段：bob 已被移出");
  // bob（尚未收到）签一条“给 A 的设备的吊销标记”——A 的设备并没有被吊销；随他的链经纪元 1 的段送到 carol 与 A
  const { d: bob, rows } = await forgeMark(kB, "bob", m, dev("test-lawyer"));
  const k1 = unwrapMatterKey(rawKey(kB, m, 1, bob.id)!, bob.keys.encPrivateKeyPem);
  const sb = dir("fmark");
  forgeSegment(sb, bob, m, 1, k1, rows.map((e) => ({ t: "member_events", pk: e.event_id, row: e as any })));
  await kC.inv("sync.import", { share_dir: sb });
  await kA.inv("sync.import", { share_dir: sb });
  // 链上的标记本身不算吊销依据（第四轮处置）：A 的设备没有被吊销，A 的降级与移出照常成立
  const st = await uncached(kC, m);
  assert.ok(st.includes(`member:${usr("bob")}:editor:valid:`), String(st));
  assert.equal(role(kC, m, usr("bob"))?.live, 0, "bob 仍被移出");
  assert.ok(!alerts(kC, m).includes("revoked_change"), String(alerts(kC, m)));
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("dave") });
  assert.equal(role(kA, m, usr("dave"))?.live, 1, "A 照常能做成员操作");
});

test("S12B-44：并发轮换落选后换成胜者密钥——落选那把留在历史里可解，发出前按段的纪元重封，收方读得到、缓存不过期", { timeout: 180_000 }, async () => {
  const { createBlobCipher } = await import("../src/blob-cipher.ts");
  const { BlobStore } = await import("../src/blobs.ts");
  const m = await newMatter(kA, "落选密钥的块");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "owner" });
  for (const u of ["carol", "dave", "erin"]) await kA.inv("matters.members.add", { matter_id: m, user_id: usr(u), matter_role: "editor" });
  await pass(kA, [kB, kC, kD], m);
  // bob 先加一人（lamport 更高），再移出 erin（他那边的纪元 2）；A 移出 dave（纪元 2，lamport 更低，胜出）
  await kB.inv("matters.members.add", { matter_id: m, user_id: usr("frank"), matter_role: "editor" });
  await kB.inv("matters.members.remove", { matter_id: m, user_id: usr("erin") });
  await kA.inv("matters.members.remove", { matter_id: m, user_id: usr("dave") });
  await imp(kB, m, "乙-落选期间.txt", "bob 在收到胜者密钥之前写的");
  await pass(kA, [kB], m); // bob 收到胜者的包裹，本机纪元 2 换成 A 的那把
  assert.equal(await encEpoch(kB, m), 2);
  await imp(kB, m, "乙-换钥之后.txt", "bob 在换成胜者密钥之后写的");
  const s = await pass(kB, [kC], m);
  // 发出前按段的纪元重封（落选那把封的块也重封），carol 都读得到
  for (const fn of ["乙-落选期间.txt", "乙-换钥之后.txt"]) {
    const uri = blobOf(kB, m, fn)!;
    assert.ok(readFileSync(join(s, TID, "blobs", ...uri.slice("blob://".length).split("/"))).length > 0);
    assert.equal(kC.kernel.blobs.read(uri).toString("utf8").length > 0, true, `carol 读得到 ${fn}`);
  }
  // carol 用胜者纪元写的材料，bob 本进程收得下（缓存键带包裹）
  await imp(kC, m, "丙-之后.txt", "carol 写的");
  const s2 = dir("c2b");
  await kC.inv("sync.export", { share_dir: s2, matter_id: m });
  const r = await kB.inv("sync.import", { share_dir: s2 });
  assert.ok(!JSON.stringify(r.originConflicts).includes("blob_mismatch"), JSON.stringify(r.originConflicts));
  assert.equal(kB.kernel.blobs.read(blobOf(kB, m, "丙-之后.txt")!).toString("utf8"), "carol 写的");
  // bob 重启（新建块加密器）：自己写的材料都读得出（落选那把留在密钥历史里）
  const bobDev = await deviceOf(kB, "bob");
  const fresh = new BlobStore(kB.kernel.blobs.dir, createBlobCipher({ db: kB.kernel.db, deviceId: bobDev.id, encPrivateKeyPem: bobDev.keys.encPrivateKeyPem }));
  assert.equal(fresh.read(blobOf(kB, m, "乙-落选期间.txt")!).toString("utf8"), "bob 在收到胜者密钥之前写的");
});

test("S12B-46：两步报复时有第三位负责人——不自动轮换，记互相降级告警并暂停，第三位负责人人工调整后解除", { timeout: 180_000 }, async () => {
  const m = await newMatter(kA, "两步报复-第三位");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "owner" });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("carol"), matter_role: "owner" });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("dave"), matter_role: "editor" });
  await pass(kA, [kB, kC, kD], m);
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "editor" });
  await kA.inv("matters.members.remove", { matter_id: m, user_id: usr("bob") });
  await kB.inv("matters.members.add", { matter_id: m, user_id: usr("test-lawyer"), matter_role: "editor" });
  await kB.inv("matters.members.remove", { matter_id: m, user_id: usr("test-lawyer") });
  await pass(kA, [kC], m);
  await pass(kB, [kC], m);
  await pass(kA, [kC], m);
  // 互相降级或移出未解除时第三位负责人的电脑不自动轮换：记 member_conflict、暂停发出，交他人工调整
  const lg = await log(kC, m);
  assert.ok(!lg.some((e) => e.kind === "rekey"), "不自动轮换");
  assert.ok(alerts(kC, m).includes("member_conflict"), String(alerts(kC, m)));
  assert.deepEqual((await kC.inv("sync.export", { share_dir: dir("c3"), matter_id: m })).pausedConflict, [m]);
  // carol 人工处置（移出其中一人之外的任何成员操作都算，这里给 dave 改角色）后解除
  await kC.inv("matters.members.add", { matter_id: m, user_id: usr("dave"), matter_role: "reviewer" });
  await kC.inv("sync.export", { share_dir: dir("c4"), matter_id: m });
  assert.ok(!alerts(kC, m).includes("member_conflict"), String(alerts(kC, m)));
});

test("S12B-45：暂停期间写入的材料块在发出前按段的纪元重封，被移出者解不开", { timeout: 180_000 }, async () => {
  const { blobHeaderOf, openBlob } = await import("../src/blobs.ts");
  const m = await newMatter(kA, "暂停期间的块");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "owner" });
  for (const u of ["carol", "dave"]) await kA.inv("matters.members.add", { matter_id: m, user_id: usr(u), matter_role: "editor" });
  await pass(kA, [kB, kC, kD], m);
  // bob 先加一人（lamport 更高），再移出 carol（纪元 2，包给 dave）；A 移出 dave（纪元 2，包给 carol；lamport 更低，胜出）
  await kB.inv("matters.members.add", { matter_id: m, user_id: usr("frank"), matter_role: "editor" });
  await kB.inv("matters.members.remove", { matter_id: m, user_id: usr("carol") });
  await kA.inv("matters.members.remove", { matter_id: m, user_id: usr("dave") });
  await pass(kA, [kC], m); // carol 收下 A 的纪元 2
  await pass(kA, [kB], m); // bob：自己那把落选，换成 A 的纪元 2；A 的纪元 2 仍包给 carol（已被 bob 移出）→ rekey_needed，等处置者 A
  assert.ok(alerts(kB, m).includes("rekey_needed"), String(alerts(kB, m)));
  await imp(kB, m, "乙-暂停期间.txt", "bob 在等轮换期间写的");
  // A 收到 bob 的链，自动轮换到纪元 3（不包给 carol、dave）；bob 收到后恢复发出
  await pass(kB, [kA], m);
  await pass(kA, [kB], m);
  assert.deepEqual(alerts(kB, m), []);
  assert.equal(await encEpoch(kB, m), 3);
  assert.equal(role(kB, m, usr("carol"))?.live, 0, "carol 已被移出");
  const s = dir("pause-blob");
  await kB.inv("sync.export", { share_dir: s, matter_id: m });
  const uri = blobOf(kB, m, "乙-暂停期间.txt")!;
  const env = readFileSync(join(s, TID, "blobs", ...uri.slice("blob://".length).split("/")));
  assert.equal(blobHeaderOf(env)!.epoch, 3, "发出前按段的纪元 3 重封");
  const carol = await deviceOf(kC, "carol");
  const k2 = unwrapMatterKey(rawKey(kC, m, 2, carol.id)!, carol.keys.encPrivateKeyPem);
  assert.throws(() => openBlob(k2, env), "被移出的 carol 解不开");
});
