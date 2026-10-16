// 第三轮复核 S11A-27/28 回归用例（复核人复现转入）
/**
 * 复核 A 第三轮 · 复现：
 * ① S11A-27：“本机认定的事项行来源设备”这条包裹授权不看该设备的成员现状——创建者 A 移交负责人并被移出（伦理墙）之后，
 *    A 仍是其他成员电脑上的“事项行来源设备”，A 签发的新纪元包裹照样落库，成员此后用 A 自选的密钥加密。
 * ② S11A-28：迟到成员本机只有自己的成员行；负责人此后的成员变更（移交给他、移出他人、移出他本人）在他电脑上一律被拒。
 * 介质：共享文件夹（授权判定两种介质共用 keyRowsAcceptable / applyRow）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
/** 复现时的观察输出（转入回归用例后不打印）。 */
const log = (..._a: unknown[]): void => {};
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { makeKernel } = await import("./helpers.ts");
const { getDeviceKeys, keysDirOf } = await import("../src/devices.ts");
const { sealSegment, writeSegment } = await import("@zr-legal/sync");
const { generateMatterKey, wrapMatterKey, SoftwareSigner } = await import("@zr-legal/keys");
const { openBlob, blobHeaderOf } = await import("../src/blobs.ts");

const FIRM = "orig-firm";
const TID = `ten_${FIRM}`;
const usr = (s: string) => `usr_${FIRM}_${s}`;
const dev = (s: string) => `dev_${FIRM}_${s}`;
let kA: any;
const others: any[] = [];
let kB: any;
let kC: any;
let kD: any;

async function second(slug: string) {
  const ws = mkdtempSync(join(tmpdir(), `kwl-r3a-orig-${slug}-`));
  mkdirSync(join(ws, FIRM, "keys"), { recursive: true });
  copyFileSync(join(kA.dir, FIRM, "keys", "firm-root.json"), join(ws, FIRM, "keys", "firm-root.json"));
  const { createKernel } = await import("../src/index.ts");
  const kernel = await createKernel({ dataDir: ws, firmSlug: FIRM, userSlug: slug, env: { ...process.env, ZR_MODEL_PROVIDER: "upstream" } });
  const k = { kernel, dir: ws, inv: (m: string, p?: any) => kernel.invoke(m, p) };
  others.push(k);
  return k;
}
const importText = (k: any, mid: string, filename: string, text: string) =>
  k.inv("materials.import", { matter_id: mid, filename, data_base64: Buffer.from(text, "utf8").toString("base64"), mime: "text/plain" });
const copyDev = (from: any, id: string, to: any[]) => {
  const row = from.kernel.db.get(`SELECT * FROM devices WHERE device_id = ?`, [id]);
  for (const k of to) {
    const cols = Object.keys(row);
    k.kernel.db.run(`INSERT OR IGNORE INTO devices (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, cols.map((c) => row[c]));
  }
};
const members = (k: any, mid: string) => k.kernel.db.all(`SELECT user_id, matter_role, removed_at IS NOT NULL AS removed FROM matter_members WHERE matter_id = ? ORDER BY user_id`, [mid]);

before(async () => {
  kA = await makeKernel({ ZR_MODEL_PROVIDER: "upstream" }, FIRM);
  kB = await second("bob");
  kC = await second("carol");
  kD = await second("dave");
  const all = [kA, kB, kC, kD];
  for (const [k, s] of [[kA, "test-lawyer"], [kB, "bob"], [kC, "carol"], [kD, "dave"]] as const) copyDev(k, dev(s), all.filter((x) => x !== k));
});
after(async () => {
  for (const k of others) await k.kernel.close().catch(() => {});
  await kA.kernel.close();
});

test("① 创建者移交并被移出后，仍能给成员下发新纪元包裹；成员此后用它自选的密钥加密", { timeout: 120_000 }, async () => {
  const { matter } = await kA.inv("matters.create", { title: "伦理墙事项", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  const mid = matter.matter_id;
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("carol"), matter_role: "owner" });
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("bob") });
  await importText(kA, mid, "甲.txt", "甲");
  const share = mkdtempSync(join(tmpdir(), "kwl-r3a-orig-share-"));
  await kA.inv("sync.export", { share_dir: share, matter_id: mid });
  await kB.inv("sync.import", { share_dir: share });
  await kC.inv("sync.import", { share_dir: share });
  // 共同负责人 carol：把 A 改为普通成员，再移出 A（伦理墙；移出即轮换）
  await kC.inv("matters.members.add", { matter_id: mid, user_id: usr("test-lawyer"), matter_role: "editor" });
  const rm = await kC.inv("matters.members.remove", { matter_id: mid, user_id: usr("test-lawyer") });
  log("carol 移出 A，新纪元", rm.new_epoch);
  await kC.inv("sync.export", { share_dir: share, matter_id: mid });
  await kB.inv("sync.import", { share_dir: share });
  log("B 的成员表：", JSON.stringify(members(kB, mid)));
  log("B 的包裹纪元：", JSON.stringify(kB.kernel.db.all(`SELECT epoch FROM matter_keys WHERE matter_id = ? AND wrapped_for = ?`, [mid, dev("bob")])));

  // A（已被移出）：自选密钥 KX，签一段只带包裹的段（纪元 99）放进共享文件夹
  const aKeys = getDeviceKeys(keysDirOf(kA.kernel.config.workspaceDir));
  const aCert = kA.kernel.db.get(`SELECT cert_json FROM devices WHERE device_id = ?`, [dev("test-lawyer")]).cert_json;
  const KX = generateMatterKey();
  const now = new Date().toISOString();
  const keyRows = [dev("bob"), dev("carol")].map((d) => ({
    matter_id: mid,
    epoch: 99,
    wrapped_for: d,
    wrapped_key: wrapMatterKey(KX, kA.kernel.db.get(`SELECT enc_pub_pem FROM devices WHERE device_id = ?`, [d]).enc_pub_pem),
    created_at: now,
  }));
  const sid = `seg_${dev("test-lawyer")}_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
  const sealed = sealSegment({
    header: { segment_id: sid, device_id: dev("test-lawyer"), matter_id: mid, from_lamport: 9999, to_lamport: 9999, key_epoch: 99, event_count: 0, created_at: now, device_cert_json: aCert },
    keyRows,
    rows: [],
    matterKey: KX,
    signer: new SoftwareSigner(aKeys.signPrivateKeyPem),
  });
  writeSegment(share, TID, dev("test-lawyer"), sid, sealed);
  const rb = await kB.inv("sync.import", { share_dir: share });
  const rc = await kC.inv("sync.import", { share_dir: share });
  log("B 摄取：", JSON.stringify(rb.dispositions.map((x: any) => [x.segment_id.slice(0, 30), x.outcome])));
  log("carol 摄取：", JSON.stringify(rc.dispositions.map((x: any) => [x.segment_id.slice(0, 30), x.outcome])));
  const origin = kB.kernel.db.get(`SELECT origin_device FROM sync_row_origin WHERE table_name = 'matters' AND row_pk = ?`, [mid]);
  log("B 认定的事项行来源设备：", origin?.origin_device);
  const leak = async (k: any, me: string, text: string) => {
    const d = await importText(k, mid, `${me} 移出后写.txt`, text);
    const uri = k.kernel.db.get(`SELECT storage_uri FROM document_versions WHERE document_version_id = ?`, [d.document_version_id]).storage_uri as string;
    const env = readFileSync(join(k.kernel.blobs.dir, ...uri.slice("blob://".length).split("/")));
    let plain = "";
    try {
      plain = openBlob(Buffer.from(KX), env).toString("utf8");
    } catch (e) {
      plain = `解不开：${(e as Error).message.slice(0, 40)}`;
    }
    log(`${me} 新材料块头纪元：`, blobHeaderOf(env)?.epoch, "｜被移出的 A 用自选密钥解：", plain);
    return plain;
  };
  const pb = await leak(kB, "bob", "B 在伦理墙之后写的保密意见");
  const pc = await leak(kC, "carol", "carol 在伦理墙之后写的保密意见");
  assert.notEqual(pb, "B 在伦理墙之后写的保密意见", "被移出的创建者不应能解开 B 此后写入的材料");
  assert.notEqual(pc, "carol 在伦理墙之后写的保密意见", "被移出的创建者不应能解开新负责人此后写入的材料");
});

test("② 迟到成员只有自己的成员行；负责人此后的成员变更在他电脑上被拒", { timeout: 120_000 }, async () => {
  const { matter } = await kA.inv("matters.create", { title: "迟到成员成员表", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  const mid = matter.matter_id;
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("bob") });
  await importText(kA, mid, "甲.txt", "甲");
  const share = mkdtempSync(join(tmpdir(), "kwl-r3a-late-share-"));
  await kA.inv("sync.export", { share_dir: share, matter_id: mid });
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("dave") });
  await importText(kA, mid, "乙.txt", "乙");
  await kA.inv("sync.export", { share_dir: share, matter_id: mid });
  await kD.inv("sync.import", { share_dir: share });
  log("D 加入后的成员表：", JSON.stringify(members(kD, mid)));
  // A 移出 bob（轮换）并把负责人移交给 D
  await kA.inv("matters.members.remove", { matter_id: mid, user_id: usr("bob") });
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("dave"), matter_role: "owner" });
  await kA.inv("sync.export", { share_dir: share, matter_id: mid });
  const r = await kD.inv("sync.import", { share_dir: share });
  log("D 摄取告警：", JSON.stringify(r.origin_conflicts ?? r.originConflicts ?? r).slice(0, 600));
  log("D 之后的成员表：", JSON.stringify(members(kD, mid)));
  const dRole = kD.kernel.db.get(`SELECT matter_role FROM matter_members WHERE matter_id = ? AND user_id = ?`, [mid, usr("dave")])?.matter_role;
  assert.equal(dRole, "owner", "负责人移交给迟到成员后，他本机应当是负责人");
});

test("③ 共享文件夹：迟到成员先摄取到在册非负责人成员的段（序号区间更靠前）——无需任何恶意", { timeout: 120_000 }, async () => {
  const { matter } = await kA.inv("matters.create", { title: "迟到成员先见同事段", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  const mid = matter.matter_id;
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("bob") });
  await importText(kA, mid, "甲.txt", "甲");
  const share = mkdtempSync(join(tmpdir(), "kwl-r3a-late2-share-"));
  await kA.inv("sync.export", { share_dir: share, matter_id: mid });
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("dave") });
  await importText(kA, mid, "乙.txt", "乙");
  await kA.inv("sync.export", { share_dir: share, matter_id: mid });
  // B（在册成员）照常收件、写入、发件
  await kB.inv("sync.import", { share_dir: share });
  await importText(kB, mid, "B.txt", "B 的材料");
  await kB.inv("sync.export", { share_dir: share, matter_id: mid });
  const r = await kD.inv("sync.import", { share_dir: share });
  log("③ D 摄取：", JSON.stringify(r.dispositions.map((x: any) => [x.segment_id.slice(0, 30), x.outcome])));
  log("③ D 认定的事项行来源：", kD.kernel.db.get(`SELECT origin_device FROM sync_row_origin WHERE table_name = 'matters' AND row_pk = ?`, [mid])?.origin_device);
  log("③ D 的成员表：", JSON.stringify(members(kD, mid)));
  const got = await kD.inv("matters.get", { matter_id: mid }).then((x: any) => x.documents.map((d: any) => d.filename)).catch((e: any) => `打不开：${e.message}`);
  log("③ D 打开事项：", got);
  // A 随后移出 B（轮换）
  await kA.inv("matters.members.remove", { matter_id: mid, user_id: usr("bob") });
  await kA.inv("sync.export", { share_dir: share, matter_id: mid });
  await kD.inv("sync.import", { share_dir: share });
  log("③ D 的包裹纪元：", JSON.stringify(kD.kernel.db.all(`SELECT epoch FROM matter_keys WHERE matter_id = ? AND wrapped_for = ?`, [mid, dev("dave")])));
  assert.ok(Array.isArray(got), "迟到成员应能打开事项");
});
