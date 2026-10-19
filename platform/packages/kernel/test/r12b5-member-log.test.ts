// 第 12 批第五轮复核 B 的复现（对象 51ccf5f），处置后改为回归：断言修正后的表现。共享文件夹介质。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unwrapMatterKey } from "@zr-legal/keys";
import { makeKernel, type TestKernel } from "./helpers.ts";

const FIRM = "r12b5";
const usr = (s: string) => `usr_${FIRM}_${s}`;
const dev = (s: string) => `dev_${FIRM}_${s}`;
const TID = `ten_${FIRM}`;
let kA: TestKernel;
let kB: TestKernel;
let kC: TestKernel;
let kD: TestKernel;
const others: TestKernel[] = [];

async function open(slug: string): Promise<TestKernel> {
  const d = mkdtempSync(join(tmpdir(), `kwl-r12b5-${slug}-`));
  mkdirSync(join(d, FIRM, "keys"), { recursive: true });
  copyFileSync(join(kA.dir, FIRM, "keys", "firm-root.json"), join(d, FIRM, "keys", "firm-root.json"));
  const { createKernel } = await import("../src/index.ts");
  const kernel = await createKernel({ dataDir: d, firmSlug: FIRM, userSlug: slug, env: { ...process.env, ZR_MODEL_PROVIDER: "mock" } });
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
const dir = (tag: string) => mkdtempSync(join(tmpdir(), `kwl-r12b5-${tag}-`));
const newMatter = async (k: TestKernel, title: string) => (await k.inv("matters.create", { title, stance: "受让方", consent_status: "not_required", collab_scope: "team" })).matter.matter_id as string;
const role = (k: TestKernel, mid: string, u: string) =>
  k.kernel.db.get<{ matter_role: string; live: number }>(`SELECT matter_role, removed_at IS NULL AS live FROM matter_members WHERE matter_id = ? AND user_id = ?`, [mid, u]);
const alerts = (k: TestKernel, mid: string) => k.kernel.db.all<{ kind: string }>(`SELECT kind FROM sync_alerts WHERE matter_id = ? ORDER BY kind`, [mid]).map((a) => a.kind);
const rawKey = (k: TestKernel, mid: string, epoch: number, d: string) => k.kernel.db.get<{ w: string }>(`SELECT wrapped_key AS w FROM matter_keys WHERE matter_id = ? AND epoch = ? AND wrapped_for = ?`, [mid, epoch, d])?.w;
async function pass(from: TestKernel, to: TestKernel[], mid: string, s = dir("p")): Promise<string> {
  await from.inv("sync.export", { share_dir: s, matter_id: mid });
  for (const k of to) await k.inv("sync.import", { share_dir: s });
  return s;
}
async function keysOf(k: TestKernel) {
  const { getDeviceKeys, keysDirOf } = await import("../src/index.ts");
  return getDeviceKeys(keysDirOf(join(k.dir, FIRM)));
}
const blobOf = (k: TestKernel, mid: string, fn: string) => k.kernel.db.get<{ u: string }>(`SELECT storage_uri AS u FROM document_versions WHERE matter_id = ? AND filename = ?`, [mid, fn])?.u;
const encEpoch = async (k: TestKernel, mid: string) => (await k.inv("matters.member_log", { matter_id: mid })).encrypt_epoch as number | null;
const shareBlob = (s: string, uri: string) => join(s, TID, "blobs", ...uri.slice("blob://".length).split("/"));

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

// S12B-54：发出前重封失败时“原样发出”（失败即放行）——S12B-45 的泄露在重封失败时原样回来
test("S12B-54：发出前重封失败（块目录不可写、文件被占用、磁盘满）——本轮跳过该事项并报错，不按旧纪元发出；恢复后按新纪元发出，被移出的 carol 解不开", { timeout: 180_000 }, async () => {
  const { blobHeaderOf, openBlob } = await import("../src/blobs.ts");
  const m = await newMatter(kA, "重封失败");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "owner" });
  for (const u of ["carol", "dave"]) await kA.inv("matters.members.add", { matter_id: m, user_id: usr(u), matter_role: "editor" });
  await pass(kA, [kB, kC, kD], m);
  // 同 r12b4 S12B-45：bob 落选、rekey_needed 暂停期间写材料；A 轮换到纪元 3 后 bob 恢复
  await kB.inv("matters.members.add", { matter_id: m, user_id: usr("frank"), matter_role: "editor" });
  await kB.inv("matters.members.remove", { matter_id: m, user_id: usr("carol") });
  await kA.inv("matters.members.remove", { matter_id: m, user_id: usr("dave") });
  await pass(kA, [kC], m);
  await pass(kA, [kB], m);
  assert.ok(alerts(kB, m).includes("rekey_needed"), String(alerts(kB, m)));
  await imp(kB, m, "乙-暂停期间.txt", "bob 在等轮换期间写的（重封失败）");
  await pass(kB, [kA], m);
  await pass(kA, [kB], m);
  assert.deepEqual(alerts(kB, m), []);
  assert.equal(await encEpoch(kB, m), 3);
  assert.equal(role(kB, m, usr("carol"))?.live, 0, "carol 已被移出");
  const uri = blobOf(kB, m, "乙-暂停期间.txt")!;
  // 重封的临时文件写不进块目录：失败即关闭——本轮跳过这个事项、导出结果带错误，共享目录里没有这个块
  const blobDir = join(kB.kernel.blobs.dir, m);
  chmodSync(blobDir, 0o555);
  const s = dir("reseal-fail");
  let r: any;
  try {
    r = await kB.inv("sync.export", { share_dir: s, matter_id: m });
  } finally {
    chmodSync(blobDir, 0o755);
  }
  assert.ok(r.chainErrors.some((e: any) => JSON.stringify(e).includes(m)), JSON.stringify(r.chainErrors));
  assert.ok(!existsSync(shareBlob(s, uri)), "重封失败：块不按旧纪元发出");
  // 恢复后照常发出，块按纪元 3
  const s2 = dir("again");
  const r2 = await kB.inv("sync.export", { share_dir: s2, matter_id: m });
  assert.deepEqual(r2.chainErrors, []);
  const env = readFileSync(shareBlob(s2, uri));
  assert.equal(blobHeaderOf(env)!.epoch, 3);
  const carolKeys = await keysOf(kC);
  const k2 = unwrapMatterKey(rawKey(kC, m, 2, dev("carol"))!, carolKeys.encPrivateKeyPem);
  assert.throws(() => openBlob(k2, env), "被移出的 carol 解不开");
});

// S12B-56：只重封本机写的、或按链上未声明纪元加密的块——别人按已声明纪元写的块不动
test("S12B-56：carol 的包裹被换成胜者（全量重发）后，A 在纪元 1 写的块不被她重封、共享目录里的副本不被覆盖", { timeout: 180_000 }, async () => {
  const { blobHeaderOf } = await import("../src/blobs.ts");
  const m = await newMatter(kA, "重封放大");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "owner" });
  for (const u of ["carol", "dave", "erin"]) await kA.inv("matters.members.add", { matter_id: m, user_id: usr(u), matter_role: "editor" });
  const S = dir("shared");
  const docs = ["甲-1.txt", "甲-2.txt", "甲-3.txt"];
  for (const fn of docs) await imp(kA, m, fn, `A 在纪元 1 写的 ${fn}`);
  await pass(kA, [kB, kC, kD], m, S);
  const before = new Map(docs.map((fn) => [fn, readFileSync(shareBlob(S, blobOf(kA, m, fn)!))]));
  for (const b of before.values()) assert.equal(blobHeaderOf(b)!.epoch, 1);
  // bob 与 A 并发轮换（同 r12b4 S12B-44）：carol 先收到 bob 的纪元 2，再收到 A 的（胜出）→ 本机包裹被替换、没有本机的声明 → 全量重发
  await kB.inv("matters.members.add", { matter_id: m, user_id: usr("frank"), matter_role: "editor" });
  await kB.inv("matters.members.remove", { matter_id: m, user_id: usr("erin") });
  await kA.inv("matters.members.remove", { matter_id: m, user_id: usr("dave") });
  await pass(kB, [kC], m);
  await pass(kA, [kC], m);
  assert.ok(kC.kernel.db.get(`SELECT 1 AS x FROM matter_key_history WHERE matter_id = ? AND wrapped_for = ?`, [m, dev("carol")]), "carol 的包裹被替换过");
  assert.equal(await encEpoch(kC, m), 2);
  const r = await kC.inv("sync.export", { share_dir: S, matter_id: m });
  assert.deepEqual(r.pausedConflict, [], String(alerts(kC, m)));
  assert.deepEqual(r.chainErrors, []);
  for (const fn of docs) {
    const now = readFileSync(shareBlob(S, blobOf(kA, m, fn)!));
    assert.equal(blobHeaderOf(now)!.epoch, 1, `${fn} 仍是 A 写的纪元 1`);
    assert.ok(now.equals(before.get(fn)!), `${fn} 共享目录里的副本未被覆盖`);
  }
  const local = readdirSync(join(kC.kernel.blobs.dir, m)).filter((f) => /^[0-9a-f]{64}$/.test(f));
  assert.ok(local.length > 0 && local.every((f) => blobHeaderOf(readFileSync(join(kC.kernel.blobs.dir, m, f)))!.epoch === 1), "carol 本机的块未被改写");
  assert.ok(statSync(S).isDirectory());
});
