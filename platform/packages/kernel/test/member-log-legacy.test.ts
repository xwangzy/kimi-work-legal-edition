// 第 12 批：第 11 批的成员行规则仍对未锚定的事项（升级前的客户端、混合版本）生效——这里的内核模拟升级前的客户端（ZR_MEMBER_LOG=off：
// 不写成员链、不锚定、不认段里的成员事件），保留原先在 sync.test、share-relay-round4/round7 里对行规则的断言（那几处已改为链模式的断言）。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeKernel, type TestKernel } from "./helpers.ts";

const FIRM = "legacy-rows";
const LEGACY = { ZR_MEMBER_LOG: "off" };
const usr = (s: string) => `usr_${FIRM}_${s}`;
const dev = (s: string) => `dev_${FIRM}_${s}`;
let kA: TestKernel;
let kB: TestKernel;
let kD: TestKernel;
const others: TestKernel[] = [];

async function second(slug: string): Promise<TestKernel> {
  const ws = mkdtempSync(join(tmpdir(), `kwl-legacy-${slug}-`));
  mkdirSync(join(ws, FIRM, "keys"), { recursive: true });
  copyFileSync(join(kA.dir, FIRM, "keys", "firm-root.json"), join(ws, FIRM, "keys", "firm-root.json"));
  const { createKernel } = await import("../src/index.ts");
  const kernel = await createKernel({ dataDir: ws, firmSlug: FIRM, userSlug: slug, env: { ...process.env, ZR_MODEL_PROVIDER: "mock", ...LEGACY } });
  const k = { kernel, dir: ws, inv: (m: string, p?: any) => kernel.invoke(m, p) } as TestKernel;
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
const docs = async (k: TestKernel, mid: string): Promise<string[]> => ((await k.inv("matters.get", { matter_id: mid }).catch(() => ({ documents: [] }))).documents as any[]).map((d) => d.filename).sort();
const dir = (tag: string) => mkdtempSync(join(tmpdir(), `kwl-legacy-${tag}-`));
const newMatter = async (title: string) => (await kA.inv("matters.create", { title, stance: "受让方", consent_status: "not_required", collab_scope: "team" })).matter.matter_id as string;

before(async () => {
  kA = await makeKernel(LEGACY, FIRM);
  kB = await second("bob");
  kD = await second("dave");
  const all = [kA, kB, kD];
  for (const [k, s] of [[kA, "test-lawyer"], [kB, "bob"], [kD, "dave"]] as const) copyDev(k, dev(s), all.filter((x) => x !== k));
});
after(async () => {
  for (const k of others) await k.kernel.close().catch(() => {});
  await kA.kernel.close();
});

test("模拟升级前的客户端：不写成员链、不锚定", async () => {
  const m = await newMatter("不写链");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob") });
  await kA.inv("sync.export", { share_dir: dir("nochain"), matter_id: m });
  assert.equal(kA.kernel.db.get(`SELECT 1 AS x FROM member_events WHERE matter_id = ?`, [m]), undefined);
  assert.equal(kA.kernel.db.get(`SELECT 1 AS x FROM member_chain WHERE matter_id = ?`, [m]), undefined);
});

test("阻断-C 复刻（行规则，恶意内部人）：伪造大 lamport 成员行翻墓碑 → 拒收；借名变体同样拒收", { timeout: 180_000 }, async () => {
  const shareDir = dir("c");
  const m = await newMatter("实验C事项");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob") });
  await kA.inv("sync.export", { share_dir: shareDir });
  await kB.inv("sync.import", { share_dir: shareDir });
  await kA.inv("matters.members.remove", { matter_id: m, user_id: usr("bob") });
  await kA.inv("sync.export", { share_dir: shareDir });
  const { sealSegment, writeSegment } = await import("@zr-legal/sync");
  const { unwrapMatterKey } = await import("@zr-legal/keys");
  const { getDeviceKeys, keysDirOf } = await import("../src/index.ts");
  const bKeys = getDeviceKeys(keysDirOf(join(kB.dir, FIRM)));
  const bWrap = kB.kernel.db.get<any>(`SELECT wrapped_key FROM matter_keys WHERE matter_id = ? AND epoch = 1 AND wrapped_for = ?`, [m, dev("bob")]);
  const k1 = unwrapMatterKey(bWrap.wrapped_key, bKeys.encPrivateKeyPem);
  const bCert = kB.kernel.db.get<any>(`SELECT cert_json FROM devices WHERE device_id = ?`, [dev("bob")]);
  const forge = (tag: string, author: string) => {
    const sid = `seg_${tag}_${Date.now().toString(36)}`;
    const sealed = sealSegment({
      header: { segment_id: sid, device_id: dev("bob"), matter_id: m, from_lamport: 1, to_lamport: 99999, key_epoch: 1, event_count: 1, created_at: new Date().toISOString(), device_cert_json: bCert.cert_json },
      keyRows: [],
      rows: [
        {
          t: "matter_members",
          pk: `${m}|${usr("bob")}`,
          src_device: author,
          src_lamport: 99999,
          row: { matter_id: m, user_id: usr("bob"), matter_role: "editor", added_by: usr("bob"), removed_at: null, removed_lamport: null, author_device: author, row_lamport: 99999 },
        },
      ],
      matterKey: k1,
      signer: bKeys.signPrivateKeyPem,
    });
    writeSegment(shareDir, kA.kernel.identity.tenantId, dev("bob"), sid, sealed);
  };
  forge("forged", dev("bob"));
  const im = await kA.inv("sync.import", { share_dir: shareDir });
  assert.ok(im.originConflicts.some((w: string) => w.startsWith("member_row_rejected:")), JSON.stringify(im.originConflicts));
  assert.ok(kA.kernel.db.get<any>(`SELECT removed_at FROM matter_members WHERE matter_id = ? AND user_id = ?`, [m, usr("bob")]).removed_at, "墓碑不被伪造行翻掉");
  forge("forged2", dev("test-lawyer"));
  const im2 = await kA.inv("sync.import", { share_dir: shareDir });
  assert.ok(im2.originConflicts.some((w: string) => w.includes("借名伪造拒收")), "借名变体同样拒收");
  assert.ok(kA.kernel.db.get<any>(`SELECT removed_at FROM matter_members WHERE matter_id = ? AND user_id = ?`, [m, usr("bob")]).removed_at, "墓碑仍不翻");
});

test("第四轮反向对照 R34（行规则）：旧版客户端转发的成员行没有作者签名时，后加入的成员不从这一段半引导（延后），等负责人的段后正常持钥", { timeout: 180_000 }, async () => {
  const m = await newMatter("旧版转发");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob") });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("dave") });
  const s1 = dir("old1");
  await kA.inv("sync.export", { share_dir: s1, matter_id: m });
  await kB.inv("sync.import", { share_dir: s1 });
  kB.kernel.db.run(`UPDATE matter_members SET author_sig = NULL, author_cert = NULL WHERE matter_id = ? AND author_device != ?`, [m, dev("bob")]);
  await imp(kB, m, "B写.txt", "B");
  const s2 = dir("old2");
  await kB.inv("sync.export", { share_dir: s2, matter_id: m });
  await kD.inv("sync.import", { share_dir: s2 });
  assert.equal(kD.kernel.db.get(`SELECT 1 AS x FROM matters WHERE matter_id = ?`, [m]), undefined, "只有同事段时延后，不半引导");
  await kD.inv("sync.import", { share_dir: s1 });
  await kD.inv("sync.import", { share_dir: s2 });
  assert.ok(kD.kernel.db.get(`SELECT 1 AS x FROM matter_keys WHERE matter_id = ? AND wrapped_for = ?`, [m, dev("dave")]), "负责人的段到了之后持钥");
  assert.deepEqual(await docs(kD, m), ["B写.txt"]);
});

test("第六轮反向对照 R64/R65（行规则）：成员行序号比本机见过的最大值跳出上限即拒收；首同步延后在摄取结果里保留原因", { timeout: 180_000 }, async () => {
  const m = await newMatter("序号跳跃");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob") });
  const s1 = dir("j1");
  await kA.inv("sync.export", { share_dir: s1, matter_id: m });
  await kB.inv("sync.import", { share_dir: s1 });
  kA.kernel.db.run(`UPDATE matter_members SET row_lamport = 99999999 WHERE matter_id = ? AND user_id = ?`, [m, usr("bob")]);
  await imp(kA, m, "触发导出.txt", "x");
  const s2 = dir("j2");
  await kA.inv("sync.export", { share_dir: s2, matter_id: m });
  const r = await kB.inv("sync.import", { share_dir: s2 });
  assert.ok((r.originConflicts as string[]).some((w) => w.includes("行序号跳跃过大")));
  assert.ok(kB.kernel.db.get<{ l: number }>(`SELECT row_lamport AS l FROM matter_members WHERE matter_id = ? AND user_id = ?`, [m, usr("bob")])!.l < 99999999);
  const m2 = await newMatter("首同步延后");
  await kA.inv("matters.members.add", { matter_id: m2, user_id: usr("bob") });
  await kA.inv("matters.members.add", { matter_id: m2, user_id: usr("dave") });
  const sa = dir("d1");
  await kA.inv("sync.export", { share_dir: sa, matter_id: m2 });
  await kB.inv("sync.import", { share_dir: sa });
  await imp(kB, m2, "B写.txt", "B");
  const sb = dir("d2");
  await kB.inv("sync.export", { share_dir: sb, matter_id: m2 });
  const rd = await kD.inv("sync.import", { share_dir: sb });
  assert.ok((rd.originConflicts as string[]).some((w) => w.startsWith("bootstrap_deferred:")), JSON.stringify(rd.originConflicts));
});

test("S11B-41（行规则）：升级前同步过的成员行（没有作者签名）在作者升级后发来同一内容时补上签名", { timeout: 180_000 }, async () => {
  const m = await newMatter("升级前的成员行");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "owner" });
  await imp(kA, m, "A的材料.txt", "A 的材料");
  const share = dir("up");
  await kA.inv("sync.export", { share_dir: share, matter_id: m });
  await kB.inv("sync.import", { share_dir: share });
  for (const k of [kA, kB]) k.kernel.db.run(`UPDATE matter_members SET author_sig = NULL, author_cert = NULL WHERE matter_id = ?`, [m]);
  await imp(kA, m, "升级后A又写的.txt", "x");
  await kA.inv("sync.export", { share_dir: share, matter_id: m });
  await kB.inv("sync.import", { share_dir: share });
  assert.deepEqual(kB.kernel.db.all(`SELECT user_id FROM matter_members WHERE matter_id = ? AND author_sig IS NULL`, [m]), [], "B 本机的成员行都补上了作者签名");
});

test("混合版本：升级后的设备收到旧客户端的事项（没有链）按行规则收下，不是锚定者不锚定", { timeout: 180_000 }, async () => {
  // 旧客户端 A 建事项、加 bob；新客户端（另起一台不带 ZR_MEMBER_LOG 的 bob2）收下——按行规则
  const ws = mkdtempSync(join(tmpdir(), "kwl-legacy-new-"));
  mkdirSync(join(ws, FIRM, "keys"), { recursive: true });
  copyFileSync(join(kA.dir, FIRM, "keys", "firm-root.json"), join(ws, FIRM, "keys", "firm-root.json"));
  const { createKernel } = await import("../src/index.ts");
  const kernel = await createKernel({ dataDir: ws, firmSlug: FIRM, userSlug: "erin", env: { ...process.env, ZR_MODEL_PROVIDER: "mock" } });
  const kN = { kernel, dir: ws, inv: (mm: string, p?: any) => kernel.invoke(mm, p) } as TestKernel;
  others.push(kN);
  copyDev(kN, dev("erin"), [kA, kB, kD]);
  for (const s of ["test-lawyer", "bob", "dave"]) copyDev(kA, dev(s), [kN]);
  const m = await newMatter("混合版本");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("erin") });
  await imp(kA, m, "旧客户端写的.txt", "旧");
  const s1 = dir("mix1");
  await kA.inv("sync.export", { share_dir: s1, matter_id: m });
  await kN.inv("sync.import", { share_dir: s1 });
  assert.deepEqual(await docs(kN, m), ["旧客户端写的.txt"], "新客户端按行规则收下旧客户端的事项");
  assert.equal(kN.kernel.db.get(`SELECT 1 AS x FROM member_chain WHERE matter_id = ?`, [m]), undefined, "erin 不是锚定者，不锚定");
  await imp(kN, m, "新客户端写的.txt", "新");
  const s2 = dir("mix2");
  await kN.inv("sync.export", { share_dir: s2, matter_id: m });
  await kA.inv("sync.import", { share_dir: s2 });
  assert.deepEqual(await docs(kA, m), ["新客户端写的.txt", "旧客户端写的.txt"].sort(), "旧客户端收下新客户端的内容");
});
