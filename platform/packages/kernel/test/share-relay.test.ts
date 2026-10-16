/**
 * 第 11 批 S11：团队事项经中软共享中继同步（端到端加密；含两路复核处置）——四台律所设备 + 本机云端 v0（控制面、中继服务）。
 * A = 负责人（test-lawyer），B = bob，C = carol（非成员），D = bob_2（设备编号与 B 前缀相同）。A 的段体按小上限拆成多段。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDeviceKeys, generateMatterKey, SoftwareSigner, unwrapMatterKey, wrapMatterKey } from "@zr-legal/keys";
import { checkSealed, sealSegment } from "@zr-legal/sync";
import type { Kernel } from "../src/index.ts";
import { makeKernel, type TestKernel } from "./helpers.ts";
import { startCloudCp, type CloudCp } from "./cloud-cp.ts";
import { getDeviceKeys, keysDirOf } from "../src/devices.ts";
import { relayChunks } from "../src/sync-engine.ts";

const FIRM = "relay-firm";
const TID = `ten_${FIRM}`;
const usr = (s: string) => `usr_${FIRM}_${s}`;
const dev = (s: string) => `dev_${FIRM}_${s}`;
const TITLE = "华东某某并购案金丝雀";
const CLIENT = "甲方当事人金丝雀";
const TEXT = "第一条 保密义务金丝雀条款：双方对本协议内容负有保密义务。";
const FILE = "股权转让协议金丝雀.txt";
let cloud: CloudCp;
let kA: TestKernel;
type K = { kernel: Kernel; dir: string; inv: (m: string, p?: any) => Promise<any> };
const others: K[] = [];
let kB: K;
let kC: K;
let kD: K;
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

async function second(slug: string): Promise<K> {
  const ws = mkdtempSync(join(tmpdir(), `kwl-ws-${slug}-`));
  mkdirSync(join(ws, FIRM, "keys"), { recursive: true });
  copyFileSync(join(kA.dir, FIRM, "keys", "firm-root.json"), join(ws, FIRM, "keys", "firm-root.json"));
  const { createKernel } = await import("../src/index.ts");
  const kernel = await createKernel({ dataDir: ws, firmSlug: FIRM, userSlug: slug, env: { ...process.env, ...cloud.env, ZR_MODEL_PROVIDER: "upstream" } });
  const k = { kernel, dir: ws, inv: (m: string, p?: any) => kernel.invoke(m, p) };
  others.push(k);
  return k;
}
const importText = (k: { inv: K["inv"] }, mid: string, filename: string, text: string) =>
  k.inv("materials.import", { matter_id: mid, filename, data_base64: Buffer.from(text, "utf8").toString("base64"), mime: "text/plain" });
const docs = async (k: { inv: K["inv"] }, mid: string): Promise<string[]> => ((await k.inv("matters.get", { matter_id: mid }).catch(() => ({ documents: [] }))).documents as any[]).map((d) => d.filename);
const entries = () => cloud.relay.server.tenant(TID)?.entries ?? [];

/** 中继存储目录里所有文件的字节（含登记日志）。 */
function relayBytes(): Buffer {
  const out: Buffer[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(readFileSync(p));
    }
  };
  walk(cloud.relay.dir);
  return Buffer.concat(out);
}

before(async () => {
  cloud = await startCloudCp({ tenant: TID });
  kA = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_RELAY_PART_BYTES: "6000", ZR_RELAY_PART_BLOB_BYTES: "2500" }, FIRM);
  assert.equal((await kA.inv("control_plane.sync")).report.ok, true);
  kB = await second("bob");
  kC = await second("carol");
  kD = await second("bob_2");
  for (const k of [kB, kC, kD]) assert.equal((await k.inv("control_plane.sync")).report.ok, true);
  for (const k of [kA, kB, kC, kD]) assert.equal((await k.inv("control_plane.sync")).report.ok, true);
  assert.ok(kA.kernel.db.get(`SELECT 1 AS x FROM devices WHERE member_id = ? AND status = 'active'`, [usr("bob")]), "A 已从设备目录取得 B 的设备");
});
after(async () => {
  for (const k of others) await k.kernel.close().catch(() => {});
  await kA.kernel.close();
  await cloud.close();
});

let mid = "";

test("律所策略未允许：不收发，中继上什么也没有", { timeout: 60_000 }, async () => {
  const st = await kA.inv("kernel.status");
  assert.equal(st.egress_gate.relay_configured, true);
  assert.equal(st.egress_gate.share_relay_allowed, false);
  const { matter } = await kA.inv("matters.create", { title: TITLE, client_name: CLIENT, stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  mid = matter.matter_id;
  const r = await kA.inv("relay.sync");
  assert.equal(r.push.reason, "not_allowed");
  assert.equal(cloud.relay.server.tenant(TID), null, "中继上没有该律所的任何数据");
  assert.equal((await kA.inv("relay.status")).blocked, "not_allowed");
});

test("开启后：A 发出（大段按顺序拆分）、B 取回并摄取；中继上只有密文；B 摄取后不回传；B 的改动送达 A；非成员取不到", { timeout: 180_000 }, async () => {
  const body = { max_mode: "default", auto_preauthorizations: [], fetch_allowlist_extra: [], l3a_standard_model: "deny", share_relay: "allow" };
  const { draft } = await kA.inv("firm_policy.create_draft", { kind: "policy", body });
  assert.deepEqual(draft.relaxations, ["share_relay:allow"]);
  await kA.inv("firm_policy.sign", { draft_id: draft.draft_id, expected_digest: draft.digest });
  await kA.inv("firm_policy.publish", { draft_id: draft.draft_id });
  await cloud.feed.refresh();
  for (const k of [kB, kC, kD]) await k.inv("control_plane.sync");
  assert.equal((await kA.inv("kernel.status")).egress_gate.share_relay_allowed, true);

  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("bob") });
  const doc = await importText(kA, mid, FILE, TEXT);
  const a1 = await kA.inv("relay.sync");
  assert.deepEqual(a1.push.errors, [], JSON.stringify(a1.push));
  assert.ok(a1.push.uploaded >= 2, `段体超过上限时按顺序拆成多段：${a1.push.uploaded}`);
  assert.equal(cloud.relay.server.tenant(TID)!.controller(mid), usr("test-lawyer"), "负责人成为中继上的控制成员");

  const stored = relayBytes();
  const uri = kA.kernel.db.get<{ storage_uri: string }>(`SELECT storage_uri FROM document_versions WHERE document_version_id = ?`, [doc.document_version_id])!.storage_uri;
  for (const s of [TITLE, CLIENT, "保密义务金丝雀", FILE, sha(TEXT), uri.split("/").pop()!]) assert.equal(stored.includes(Buffer.from(s, "utf8")), false, `中继上找不到：${s.slice(0, 20)}`);
  assert.ok(entries().every((e) => e.readers.includes(dev("bob")) && !e.readers.includes(dev("carol")) && !e.readers.includes("recovery")));

  const b1 = await kB.inv("relay.sync");
  assert.deepEqual(b1.pull.errors, [], JSON.stringify(b1.pull));
  assert.equal(b1.pull.applied, a1.push.uploaded, "拆开的各段都按顺序摄取");
  assert.equal((await kB.inv("matters.get", { matter_id: mid })).matter.title, TITLE);
  const bUri = kB.kernel.db.get<{ storage_uri: string }>(`SELECT storage_uri FROM document_versions WHERE matter_id = ?`, [mid])!.storage_uri;
  assert.equal(kB.kernel.blobs.read(bUri).toString("utf8"), TEXT, "B 能解开取回的材料块（明文摘要 = 块名）");

  // 复核 S11B-03：B 摄取后没有改动，不回传；A 也不再出段
  const n0 = entries().length;
  assert.equal((await kB.inv("relay.sync")).push.exported, 0, "B 摄取后不回传");
  assert.equal((await kA.inv("relay.sync")).push.exported, 0, "A 无新内容不出段");
  assert.equal(entries().length, n0);

  const beforeB = new Date(Date.now() - 1).toISOString();
  await importText(kB, mid, "补充材料.txt", "补充说明");
  const b2 = await kB.inv("relay.sync");
  assert.equal(b2.push.uploaded, 1, JSON.stringify(b2.push));
  assert.ok((await kA.inv("relay.sync")).pull.applied >= 1);
  assert.deepEqual((await docs(kA, mid)).sort(), [FILE, "补充材料.txt"].sort());
  // 后台巡检里收件可能落在两次发件之间：把 A 的导出水位拨回 B 改动之前，模拟“上次发件早于 B 的改动、收件先到”
  kA.kernel.db.run(`UPDATE relay_export_state SET last_export_at = ? WHERE matter_id = ?`, [beforeB, mid]);
  assert.equal((await kA.inv("relay.sync")).push.exported, 0, "A 收到 B 的改动后也不回传");

  const c1 = await kC.inv("relay.sync");
  assert.equal(c1.pull.downloaded, 0);
  await assert.rejects(kC.inv("matters.get", { matter_id: mid }));
});

test("复核 S11A-04、S11B-03/04：非负责人的设备等负责人先登记；律所开启时非负责人不上传全量历史；发件失败原因不被收件成功冲掉", { timeout: 180_000 }, async () => {
  const { matter } = await kA.inv("matters.create", { title: "先经共享文件夹的事项", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  const m2 = matter.matter_id;
  await kA.inv("matters.members.add", { matter_id: m2, user_id: usr("bob") });
  await importText(kA, m2, "旧材料.txt", "开启中继之前的材料");
  // 事项先经共享文件夹到了 B（A 尚未经中继发出）
  const share = mkdtempSync(join(tmpdir(), "kwl-share-"));
  await kA.inv("sync.export", { share_dir: share, matter_id: m2 });
  await kB.inv("sync.import", { share_dir: share });
  assert.deepEqual(await docs(kB, m2), ["旧材料.txt"]);
  // B 第一次中继导出：非负责人，只从此刻起导出
  kB.kernel.db.run(`DELETE FROM relay_export_state WHERE matter_id = ?`, [m2]);
  await kB.inv("relay.sync");
  assert.equal(entries().filter((e) => e.mid === m2).length, 0, "非负责人不上传全量历史");
  await importText(kB, m2, "B新材料.txt", "B 在开启后写入");
  const b = await kB.inv("relay.sync");
  assert.ok(b.push.errors.includes("waiting_for_owner"), JSON.stringify(b.push));
  const st = await kB.inv("relay.status");
  assert.equal(st.push_last_error, "waiting_for_owner", "发件失败原因保留（收件成功没有冲掉）");
  assert.equal(st.pending_upload, 1);
  assert.equal(entries().filter((e) => e.mid === m2).length, 0);
  // 负责人登记后，B 退避到期即发出
  const a = await kA.inv("relay.sync");
  assert.deepEqual(a.push.errors, []);
  assert.equal(cloud.relay.server.tenant(TID)!.controller(m2), usr("test-lawyer"));
  kB.kernel.db.run(`UPDATE relay_outbox SET next_at = ?`, [new Date(Date.now() - 1000).toISOString()]);
  const b2 = await kB.inv("relay.sync");
  assert.equal(b2.push.uploaded, 1, JSON.stringify(b2.push));
  assert.equal((await kB.inv("relay.status")).push_last_error, null);
  await kA.inv("relay.sync");
  assert.ok((await docs(kA, m2)).includes("B新材料.txt"));
});

test("第二轮 S11A-18：中继或共享文件夹已在用之后才加入的成员（迟到成员）能读、能写、改动能送达", { timeout: 180_000 }, async () => {
  const { matter } = await kA.inv("matters.create", { title: "迟到成员事项", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  const m5 = matter.matter_id;
  await kA.inv("matters.members.add", { matter_id: m5, user_id: usr("bob") });
  await importText(kA, m5, "甲.txt", "甲的内容");
  await kA.inv("relay.sync");
  await kA.inv("matters.members.add", { matter_id: m5, user_id: usr("bob_2") });
  const d2 = await importText(kA, m5, "乙.txt", "乙的内容");
  await kA.inv("relay.sync");
  await kD.inv("relay.sync");
  await kD.inv("relay.sync");
  assert.ok(kD.kernel.db.get(`SELECT 1 AS x FROM matter_keys WHERE matter_id = ? AND wrapped_for = ?`, [m5, dev("bob_2")]), "迟到成员本机持有面向自己的包裹");
  const uri = kD.kernel.db.get<{ storage_uri: string }>(`SELECT storage_uri FROM document_versions WHERE document_version_id = ?`, [d2.document_version_id])!.storage_uri;
  assert.equal(kD.kernel.blobs.read(uri).toString("utf8"), "乙的内容");
  await importText(kD, m5, "丙.txt", "迟到成员写入");
  assert.ok((await kD.inv("relay.sync")).push.uploaded >= 1);
  await kA.inv("relay.sync");
  assert.ok((await docs(kA, m5)).includes("丙.txt"));
  // 第二轮 S11A-24：段体的纪元字段不在签名范围内，改了即判不合格（不能借它让段被当作“加入前的旧纪元”静默丢弃）
  const probe = mkdtempSync(join(tmpdir(), "kwl-share-epoch-"));
  await importText(kA, m5, "丁.txt", "丁");
  await kA.inv("sync.export", { share_dir: probe, matter_id: m5 });
  const segDir = join(probe, TID, "segments", dev("test-lawyer"));
  for (const f of readdirSync(segDir)) {
    const j = JSON.parse(readFileSync(join(segDir, f), "utf8"));
    j.body.epoch = 0;
    writeFileSync(join(segDir, f), JSON.stringify(j));
  }
  const tampered = await kD.inv("sync.import", { share_dir: probe });
  assert.ok(tampered.dispositions.length > 0 && tampered.dispositions.every((x: any) => x.outcome === "invalid"), JSON.stringify(tampered.dispositions));
  // 共享文件夹介质：同样
  const { matter: mf } = await kA.inv("matters.create", { title: "文件夹迟到成员", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  await kA.inv("matters.members.add", { matter_id: mf.matter_id, user_id: usr("bob") });
  await importText(kA, mf.matter_id, "甲.txt", "甲");
  const share = mkdtempSync(join(tmpdir(), "kwl-share-late-"));
  await kA.inv("sync.export", { share_dir: share, matter_id: mf.matter_id });
  await kA.inv("matters.members.add", { matter_id: mf.matter_id, user_id: usr("carol") });
  await importText(kA, mf.matter_id, "乙.txt", "乙");
  await kA.inv("sync.export", { share_dir: share, matter_id: mf.matter_id });
  await kC.inv("sync.import", { share_dir: share });
  assert.ok(kC.kernel.db.get(`SELECT 1 AS x FROM matter_keys WHERE matter_id = ? AND wrapped_for = ?`, [mf.matter_id, dev("carol")]), "文件夹介质的迟到成员同样持有包裹");
  // 第二轮 S11A-20：非负责人不能“恢复即轮换”（新纪元只认负责人签发的包裹）
  const shares = [1, 2, 3].map((x) => join(kA.dir, FIRM, "keys", "recovery-shares", `share-${x}.json`));
  await assert.rejects(kD.inv("recovery.restore_matter", { matter_id: m5, share_files: shares, rotate: true }), /负责人/);
  // 只经共享文件夹的事项（不涉中继控制成员）：非负责人同样不能轮换
  await assert.rejects(kC.inv("recovery.restore_matter", { matter_id: mf.matter_id, share_files: shares, rotate: true }), /需要事项负责人角色/);
});

test("第二轮 S11B-19/20/21/22/25：共同负责人不能在中继事项上调整成员；收到后本机改过的行照常发出；按引用材料字节拆段；先经文件夹的改动不漏；轮换后加入不反复重下", { timeout: 240_000 }, async () => {
  // S11B-19：A 是控制成员；B 被加为共同负责人，在中继事项上移人被拒（如实说明须由谁操作）
  const { matter } = await kA.inv("matters.create", { title: "共同负责人事项", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  const m6 = matter.matter_id;
  await kA.inv("matters.members.add", { matter_id: m6, user_id: usr("bob"), matter_role: "owner" });
  await kA.inv("matters.members.add", { matter_id: m6, user_id: usr("bob_2") });
  await kA.inv("relay.sync");
  await kB.inv("relay.sync");
  await assert.rejects(kB.inv("matters.members.remove", { matter_id: m6, user_id: usr("bob_2") }), /最先同步该事项的负责人/);
  await assert.rejects(kB.inv("matters.members.add", { matter_id: m6, user_id: usr("carol") }), /最先同步该事项的负责人/);
  // S11B-20（第三轮改写，复核 S11B-33f）：成员行每段都带——控制成员改角色，其他成员电脑上随之改变
  await kA.inv("matters.members.add", { matter_id: m6, user_id: usr("bob_2"), matter_role: "viewer" });
  await kA.inv("relay.sync");
  await kD.inv("relay.sync");
  await kB.inv("relay.sync");
  const roleAt = (k: K | TestKernel) => k.kernel.db.get<{ matter_role: string }>(`SELECT matter_role FROM matter_members WHERE matter_id = ? AND user_id = ?`, [m6, usr("bob_2")])?.matter_role;
  assert.equal(roleAt(kB), "viewer");
  assert.equal(roleAt(kD), "viewer");
  // S11B-21：A 一次导入三份材料，每段引用的材料不超过上限（测试设 2500 字节）→ 拆成多段，B 全部收到
  for (const i of [1, 2, 3]) await importText(kA, m6, `证据${i}.txt`, `证据${i}`.repeat(400));
  const a = await kA.inv("relay.sync");
  assert.ok(a.push.uploaded >= 3, `按引用材料字节拆段：${a.push.uploaded}`);
  await kB.inv("relay.sync");
  for (const i of [1, 2, 3]) assert.ok((await docs(kB, m6)).includes(`证据${i}.txt`));
  // S11B-22：事项先经共享文件夹到 B，B 在第一次经中继导出之前写入 → 经中继照常送到 A
  const { matter: m7 } = await kA.inv("matters.create", { title: "先文件夹后中继", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  await kA.inv("matters.members.add", { matter_id: m7.matter_id, user_id: usr("bob") });
  const share = mkdtempSync(join(tmpdir(), "kwl-share-pre-"));
  await kA.inv("sync.export", { share_dir: share, matter_id: m7.matter_id });
  await kB.inv("sync.import", { share_dir: share });
  await importText(kB, m7.matter_id, "B开启前.txt", "B 在经中继同步之前写入");
  await kA.inv("relay.sync");
  kB.kernel.db.run(`UPDATE relay_outbox SET next_at = ?`, [new Date(Date.now() - 1000).toISOString()]);
  await kB.inv("relay.sync");
  await kB.inv("relay.sync");
  await kA.inv("relay.sync");
  assert.ok((await docs(kA, m7.matter_id)).includes("B开启前.txt"), "开启前写入、尚未送到负责人的改动经中继送达");
  // S11B-25 / R5′：轮换之后才加入的成员——加入前纪元的段即时丢弃、记为本机不可读、不再重下
  const { matter: m8 } = await kA.inv("matters.create", { title: "轮换后加入", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  await kA.inv("matters.members.add", { matter_id: m8.matter_id, user_id: usr("bob") });
  await importText(kA, m8.matter_id, "轮换前.txt", "轮换前");
  await kA.inv("relay.sync");
  await kA.inv("matters.members.remove", { matter_id: m8.matter_id, user_id: usr("bob") });
  await importText(kA, m8.matter_id, "轮换后.txt", "轮换后");
  await kA.inv("matters.members.add", { matter_id: m8.matter_id, user_id: usr("carol") });
  await kA.inv("relay.sync");
  await kC.inv("relay.sync");
  await kC.inv("relay.sync");
  const cst = await kC.inv("relay.status");
  assert.equal(cst.waiting_key, 0, JSON.stringify(cst));
  assert.ok((await docs(kC, m8.matter_id)).includes("轮换后.txt"));
  assert.ok(!(await docs(kC, m8.matter_id)).includes("轮换前.txt"), "加入前纪元的内容这台电脑看不到");
  assert.ok((kC.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM relay_unreadable WHERE matter_id = ?`, [m8.matter_id])?.n ?? 0) >= 1);
  kC.kernel.db.run(`UPDATE relay_matters SET history_state = 'pending', history_cursor = 0 WHERE matter_id = ?`, [m8.matter_id]);
  assert.equal((await kC.inv("relay.sync")).pull.downloaded, 0, "记为不可读的段不再重下");
});

test("第三轮 S11B-28/29/30：编辑成员改过标题、或事项先经共享文件夹，之后加入的成员照样拿到事项；负责人改标题后先收件再发件不丢；非负责人首次中继导出不带经文件夹收到的行", { timeout: 240_000 }, async () => {
  // S11B-28①：编辑成员 B 改过一次标题后，A 再加 D：D 拿到事项、包裹与材料
  const { matter } = await kA.inv("matters.create", { title: "原题", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  const mx = matter.matter_id;
  await kA.inv("matters.members.add", { matter_id: mx, user_id: usr("bob") });
  await kA.inv("matters.members.add", { matter_id: mx, user_id: usr("carol") });
  await importText(kA, mx, "甲.txt", "甲");
  await kA.inv("relay.sync");
  await kB.inv("relay.sync");
  await kB.inv("matters.update", { matter_id: mx, patch: { title: "B改的题" } });
  await importText(kB, mx, "B写.txt", "B");
  await kB.inv("relay.sync");
  await kA.inv("relay.sync");
  // A 摄取过 B 带事项行的段之后移出 C（纪元上升）：D 只读得到新纪元的段，事项行只能来自这些段（反向对照 R26）
  await kA.inv("matters.members.remove", { matter_id: mx, user_id: usr("carol") });
  await kA.inv("matters.members.add", { matter_id: mx, user_id: usr("bob_2") });
  await importText(kA, mx, "乙.txt", "乙");
  await kA.inv("relay.sync");
  await kD.inv("relay.sync");
  await kD.inv("relay.sync");
  assert.ok(kD.kernel.db.get(`SELECT 1 AS x FROM matters WHERE matter_id = ?`, [mx]), "之后加入的成员拿到事项");
  assert.ok(kD.kernel.db.get(`SELECT 1 AS x FROM matter_keys WHERE matter_id = ? AND wrapped_for = ?`, [mx, dev("bob_2")]));
  assert.ok((await docs(kD, mx)).includes("乙.txt"));
  // S11B-29：A 改标题，发件之前先收到 B 的段（B 的段带着 B 的事项行）→ A 的改动照常发出
  await kA.inv("matters.update", { matter_id: mx, patch: { title: "A新题" } });
  await importText(kB, mx, "B再写.txt", "B");
  await kB.inv("relay.sync");
  await kA.inv("relay.sync");
  await kD.inv("relay.sync");
  assert.equal(kD.kernel.db.get<{ title: string }>(`SELECT title FROM matters WHERE matter_id = ?`, [mx])!.title, "A新题");
  // S11B-28② + S11B-30：事项先经共享文件夹到 B（含约 300 KB 材料），开启中继后 B 第一次经中继导出不带经文件夹收到的行；之后加入的 C 照样拿到
  const { matter: mf } = await kA.inv("matters.create", { title: "文件夹时代事项", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  await kA.inv("matters.members.add", { matter_id: mf.matter_id, user_id: usr("bob") });
  await importText(kA, mf.matter_id, "大材料.txt", "证据".repeat(50_000));
  const share = mkdtempSync(join(tmpdir(), "kwl-share-era-"));
  await kA.inv("sync.export", { share_dir: share, matter_id: mf.matter_id });
  await kB.inv("sync.import", { share_dir: share });
  // B 第一次收到之后 A 又经共享文件夹送来一份材料：B 开启中继后也不转发（反向对照 R27）
  await importText(kA, mf.matter_id, "后续材料.txt", "后续".repeat(20_000));
  await kA.inv("sync.export", { share_dir: share, matter_id: mf.matter_id });
  await kB.inv("sync.import", { share_dir: share });
  await kA.inv("relay.sync");
  kB.kernel.db.run(`DELETE FROM relay_export_state WHERE matter_id = ?`, [mf.matter_id]);
  await importText(kB, mf.matter_id, "B小改动.txt", "小");
  kB.kernel.db.run(`UPDATE relay_outbox SET next_at = ?`, [new Date(Date.now() - 1000).toISOString()]);
  await kB.inv("relay.sync");
  const bSegs = entries().filter((e) => e.mid === mf.matter_id && e.dev === dev("bob"));
  assert.ok(bSegs.length >= 1 && bSegs.every((e) => e.size < 60_000), `B 首次中继导出只带本机写入的行：${JSON.stringify(bSegs.map((e) => e.size))}`);
  // B 只引用本机新写的那份小材料，不转发经共享文件夹收到的大材料（反向对照 R27）
  assert.equal(bSegs.reduce((n, e) => n + e.blobs.length, 0), 1, "B 不转发经共享文件夹收到的材料");
  await kA.inv("matters.members.add", { matter_id: mf.matter_id, user_id: usr("carol") });
  await kA.inv("relay.sync");
  await kC.inv("relay.sync");
  await kC.inv("relay.sync");
  assert.ok((await docs(kC, mf.matter_id)).includes("大材料.txt"), "文件夹时代的事项，之后加入的成员照样拿到");
  assert.ok((await docs(kC, mf.matter_id)).includes("后续材料.txt"));
});

test("复核 S11A-02：包裹未被签名覆盖即判不合格；非负责人段里的包裹不落库（不能改别人设备的加密纪元）", { timeout: 120_000 }, async () => {
  // ① 段格式：签名后改动包裹 → 封口核验不通过
  const k = generateDeviceKeys();
  const sealed = JSON.parse(
    sealSegment({
      header: { segment_id: "seg_x_lk_abcdef12", device_id: "x", matter_id: mid, from_lamport: 1, to_lamport: 1, key_epoch: 1, event_count: 0, created_at: new Date().toISOString(), device_cert_json: "{}" },
      keyRows: [{ matter_id: mid, epoch: 1, wrapped_for: "x", wrapped_key: "w", created_at: "t" }],
      rows: [],
      matterKey: generateMatterKey(),
      signer: new SoftwareSigner(k.signPrivateKeyPem),
    }),
  );
  assert.equal(checkSealed(sealed, k.signPublicKeyPem).ok, true);
  sealed.key_rows.push({ matter_id: mid, epoch: 9, wrapped_for: dev("test-lawyer"), wrapped_key: "forged", created_at: "t" });
  assert.equal(checkSealed(sealed, k.signPublicKeyPem).ok, false, "包裹被增删即不符");
  // ② B（非负责人）往自己库里塞一个更高纪元的包裹（面向 A 的设备，用 B 知道的密钥）→ 经 B 签名的段送到 A → A 不落库、纪元不变
  const aEnc = kA.kernel.db.get<{ enc_pub_pem: string }>(`SELECT enc_pub_pem FROM devices WHERE device_id = ?`, [dev("test-lawyer")])!.enc_pub_pem;
  kB.kernel.db.run(`INSERT INTO matter_keys (matter_id, epoch, wrapped_for, wrapped_key) VALUES (?,?,?,?)`, [mid, 7, dev("test-lawyer"), wrapMatterKey(generateMatterKey(), aEnc)]);
  await importText(kB, mid, "带伪包裹的改动.txt", "x");
  assert.ok((await kB.inv("relay.sync")).push.uploaded >= 1);
  await kA.inv("relay.sync");
  assert.ok((await docs(kA, mid)).includes("带伪包裹的改动.txt"), "段本身照常摄取");
  assert.equal(kA.kernel.db.get<{ e: number }>(`SELECT MAX(epoch) AS e FROM matter_keys WHERE matter_id = ?`, [mid])!.e, 1, "A 的纪元没有被抬高");
  kB.kernel.db.run(`DELETE FROM matter_keys WHERE matter_id = ? AND epoch = 7`, [mid]);
});

test("复核 S11A-01：签名无效的段不在本机留下任何块（不能借未核验的段替换同事的材料）", { timeout: 120_000 }, async () => {
  // 用 B 的证书、随机签名密钥，段体用事项密钥加密，块清单把一份伪造内容指向明文摘要 X
  const bKeys = getDeviceKeys(keysDirOf(kB.kernel.config.workspaceDir));
  const wrapped = kB.kernel.db.get<{ wrapped_key: string }>(`SELECT wrapped_key FROM matter_keys WHERE matter_id = ? AND epoch = 1 AND wrapped_for = ?`, [mid, dev("bob")])!.wrapped_key;
  const matterKey = unwrapMatterKey(wrapped, bKeys.encPrivateKeyPem);
  const X = sha("将来某份材料的明文");
  const fake = Buffer.concat([Buffer.from("KWB1"), Buffer.alloc(4), Buffer.from([Buffer.byteLength(mid), 0]), Buffer.from(mid), randomBytes(64)]);
  const fakeChunks = relayChunks(fake);
  const certJson = kB.kernel.db.get<{ cert_json: string }>(`SELECT cert_json FROM devices WHERE device_id = ?`, [dev("bob")])!.cert_json;
  const sid = `seg_${dev("bob")}_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
  const seg = sealSegment({
    header: { segment_id: sid, device_id: dev("bob"), matter_id: mid, from_lamport: 1, to_lamport: 1, key_epoch: 1, event_count: 1, created_at: new Date().toISOString(), device_cert_json: certJson },
    keyRows: [],
    rows: [{ t: "_relay_blob", pk: `${mid}/${X}`, src_device: dev("bob"), src_lamport: 1, row: { sha256: sha(fake), size: fake.length, chunks: fakeChunks.map((c) => c.cid) } }],
    matterKey,
    signer: new SoftwareSigner(generateDeviceKeys().signPrivateKeyPem),
  });
  const segBytes = Buffer.from(seg, "utf8");
  const token = cloud.seatFor({ tid: TID, uid: usr("bob"), sid: "s-forge", dev: dev("bob"), aud: ["relay"] });
  const relayCall = (method: string, path: string, body: Buffer | string, ct: string) => fetch(`${cloud.relay.base}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": ct }, body });
  for (const c of [...relayChunks(segBytes), ...fakeChunks]) assert.equal((await relayCall("PUT", `/v1/relay/matters/${mid}/chunks/${c.cid}`, c.bytes, "application/octet-stream")).status, 200);
  const commit = await relayCall("POST", `/v1/relay/matters/${mid}/segments`, JSON.stringify({ segment_id: sid, sha256: sha(segBytes), size: segBytes.length, chunks: relayChunks(segBytes).map((c) => c.cid), blob_chunks: fakeChunks.map((c) => c.cid), epoch: 1, readers: [dev("bob"), dev("test-lawyer")] }), "application/json");
  assert.equal(commit.status, 200, await commit.text());
  const before = Number((await kA.inv("relay.status")).dropped_total);
  await kA.inv("relay.sync");
  assert.ok(Number((await kA.inv("relay.status")).dropped_total) > before, "签名无效的段被丢弃并计数");
  assert.equal(existsSync(join(kA.kernel.blobs.dir, mid, X)), false, "本机块库里没有被写入");
  const relayRoot = join(kA.kernel.config.workspaceDir, "relay");
  const all: string[] = [];
  const walk = (d: string) => existsSync(d) && readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : all.push(f)));
  walk(relayRoot);
  assert.equal(all.some((f) => f.includes(X) || f.includes(sid)), false, "收件与暂存区里也没有");
});

test("复核 S11B-02：设备编号前缀相同（bob 与 bob_2），bob 照常收到 bob_2 发出的段", { timeout: 120_000 }, async () => {
  const { matter } = await kD.inv("matters.create", { title: "bob_2 的事项", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  await kD.inv("matters.members.add", { matter_id: matter.matter_id, user_id: usr("bob") });
  await importText(kD, matter.matter_id, "bob_2 材料.txt", "来自 bob_2");
  assert.ok((await kD.inv("relay.sync")).push.uploaded >= 1);
  // B 只做收件（不先发件），收到后立刻写入：第一次发件时这条改动照常发出（非负责人从“第一次见到该事项”起导出）
  const b = await kB.inv("relay.sync");
  assert.ok(b.pull.applied >= 1, JSON.stringify(b.pull));
  assert.deepEqual(await docs(kB, matter.matter_id), ["bob_2 材料.txt"]);
  kB.kernel.db.run(`DELETE FROM relay_export_state WHERE matter_id = ?`, [matter.matter_id]);
  await importText(kB, matter.matter_id, "bob 收到后立刻写入.txt", "bob 写入");
  assert.ok((await kB.inv("relay.sync")).push.uploaded >= 1);
  await kD.inv("relay.sync");
  assert.ok((await docs(kD, matter.matter_id)).includes("bob 收到后立刻写入.txt"), "收到后、第一次发件前写入的改动也发出");
});

test("中继换了段的块：闸门按摘要拒收、不堵后面的段；恢复后重试取回", { timeout: 120_000 }, async () => {
  await importText(kA, mid, "第三份.txt", "第三份材料");
  await kA.inv("relay.sync");
  const last = [...entries()].reverse().find((e) => e.mid === mid && e.dev === dev("test-lawyer"))!;
  const p = join(cloud.relay.dir, "t", TID, "m", mid, last.chunks[0]!);
  const orig = readFileSync(p);
  writeFileSync(p, Buffer.concat([orig.subarray(0, orig.length - 1), Buffer.from([orig[orig.length - 1]! ^ 1])]));
  const b = await kB.inv("relay.sync");
  assert.ok(b.pull.errors.includes("relay_chunk_digest_mismatch"), JSON.stringify(b.pull));
  assert.equal((await kB.inv("relay.status")).retrying, 1);
  assert.ok(!(await docs(kB, mid)).includes("第三份.txt"));
  await importText(kA, mid, "第四份.txt", "第四份材料");
  await kA.inv("relay.sync");
  await kB.inv("relay.sync");
  assert.ok((await docs(kB, mid)).includes("第四份.txt"), "被换的那一段不堵住后面的段");
  writeFileSync(p, orig);
  kB.kernel.db.run(`UPDATE relay_retry SET next_at = ?`, [new Date(Date.now() - 1000).toISOString()]);
  await kB.inv("relay.sync");
  assert.ok((await docs(kB, mid)).includes("第三份.txt"));
  assert.equal((await kB.inv("relay.status")).retrying, 0);
});

test("复核 S11B-06：中继换了材料块：该段退避等块、不拖住后面的段；恢复后取回", { timeout: 120_000 }, async () => {
  await importText(kA, mid, "被换块的材料.txt", "这份材料的块会被换掉");
  await kA.inv("relay.sync");
  const withBlob = [...entries()].reverse().find((e) => e.mid === mid && e.dev === dev("test-lawyer") && e.blobs.length > 0)!;
  const p = join(cloud.relay.dir, "t", TID, "m", mid, withBlob.blobs[0]!);
  const orig = readFileSync(p);
  writeFileSync(p, randomBytes(orig.length));
  const b = await kB.inv("relay.sync");
  assert.ok(b.pull.errors.some((e: string) => /digest_mismatch|blob_mismatch/.test(e)), JSON.stringify(b.pull));
  const st = await kB.inv("relay.status");
  assert.equal(st.waiting_blob, 1, JSON.stringify(st));
  assert.equal(st.waiting_key, 0, "等块与等密钥分开计数");
  await importText(kA, mid, "之后的材料.txt", "之后");
  await kA.inv("relay.sync");
  await kB.inv("relay.sync");
  assert.ok((await docs(kB, mid)).includes("之后的材料.txt"), "后面的段照常摄取");
  assert.ok(!(await docs(kB, mid)).includes("被换块的材料.txt"));
  writeFileSync(p, orig);
  kB.kernel.db.run(`UPDATE relay_blob_wait SET next_at = ?`, [new Date(Date.now() - 1000).toISOString()]);
  await kB.inv("relay.sync");
  assert.ok((await docs(kB, mid)).includes("被换块的材料.txt"));
  assert.equal((await kB.inv("relay.status")).waiting_blob, 0);
});

test("复核 S11B-01/05：负责人离线时连移两人（纪元跳级）照常发出；被移出的 B 取不到；加回后补齐移出期间的段", { timeout: 180_000 }, async () => {
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("carol") });
  await kA.inv("relay.sync");
  await kA.inv("matters.members.remove", { matter_id: mid, user_id: usr("bob") });
  await kA.inv("matters.members.remove", { matter_id: mid, user_id: usr("carol") });
  await importText(kA, mid, "移出期间.txt", "移出期间的材料");
  const a = await kA.inv("relay.sync");
  assert.deepEqual(a.push.errors, [], JSON.stringify(a.push));
  const last = [...entries()].reverse().find((e) => e.mid === mid && e.dev === dev("test-lawyer"))!;
  assert.ok(last.epoch >= 3, `纪元跳级：${last.epoch}`);
  assert.ok(!last.readers.includes(dev("bob")) && !last.readers.includes(dev("carol")));
  await kB.inv("relay.sync");
  // 中继上 B 已不是读者：取历史、取块都被拒
  const bTok = cloud.seatFor({ tid: TID, uid: usr("bob"), sid: "s-b", dev: dev("bob"), aud: ["relay"] });
  assert.equal((await fetch(`${cloud.relay.base}/v1/relay/matters/${mid}/segments/0`, { headers: { authorization: `Bearer ${bTok}` } })).status, 403);
  assert.equal((await fetch(`${cloud.relay.base}/v1/relay/matters/${mid}/chunks/${last.chunks[0]}`, { headers: { authorization: `Bearer ${bTok}` } })).status, 403);
  assert.ok(!(await docs(kB, mid)).includes("移出期间.txt"));
  // 加回 B
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("bob") });
  await importText(kA, mid, "加回后.txt", "加回后的材料");
  await kA.inv("relay.sync");
  await kB.inv("relay.sync");
  await kB.inv("relay.sync");
  const bd = await docs(kB, mid);
  assert.ok(bd.includes("加回后.txt"), JSON.stringify(bd));
  assert.ok(bd.includes("移出期间.txt"), `加回后补齐移出期间的段：${JSON.stringify(bd)}`);
});

test("复核 S11A-01（两种介质都适用）：介质上被换成同事项另一份材料的块不复制进本机；本机读取时核对块名", { timeout: 120_000 }, async () => {
  const share = mkdtempSync(join(tmpdir(), "kwl-share-swap-"));
  const d1 = await importText(kB, mid, "原件甲.txt", "原件甲的内容");
  const d2 = await importText(kB, mid, "原件乙.txt", "原件乙的内容");
  await kB.inv("sync.export", { share_dir: share, matter_id: mid });
  const relOf = (id: string) => kB.kernel.db.get<{ storage_uri: string }>(`SELECT storage_uri FROM document_versions WHERE document_version_id = ?`, [id])!.storage_uri.slice("blob://".length);
  const [rel1, rel2] = [relOf(d1.document_version_id), relOf(d2.document_version_id)];
  // 两份都是该事项密钥加密的合法密文：把甲的块换成乙的
  copyFileSync(join(share, TID, "blobs", ...rel2.split("/")), join(share, TID, "blobs", ...rel1.split("/")));
  await kA.inv("sync.import", { share_dir: share });
  assert.ok((await docs(kA, mid)).includes("原件甲.txt"), "材料行照常摄取");
  assert.equal(existsSync(join(kA.kernel.blobs.dir, ...rel1.split("/"))), false, "被换的块没有复制进本机");
  assert.ok(existsSync(join(kA.kernel.blobs.dir, ...rel2.split("/"))), "没被换的照常复制");
  // 读取时核对：本机块库里同名文件内容不符即拒绝读取
  copyFileSync(join(kA.kernel.blobs.dir, ...rel2.split("/")), join(kA.kernel.blobs.dir, ...rel1.split("/")));
  assert.throws(() => kA.kernel.blobs.read(`blob://${rel1}`), /块内容与名称不符/);
});

test("第三轮 S11A-30：运营按事项重置后，负责人的电脑发现中继上没有了即重新全量；之后加入的成员仍能拿到重置前的材料", { timeout: 180_000 }, async () => {
  const { matter } = await kA.inv("matters.create", { title: "被重置的事项", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  const m9 = matter.matter_id;
  await importText(kA, m9, "重置前.txt", "重置前的材料");
  await kA.inv("relay.sync");
  assert.ok(entries().some((e) => e.mid === m9));
  const r = await fetch(`${cloud.relay.base}/v1/relay/ops/tenants/${TID}/matters/${m9}`, { method: "DELETE", headers: { authorization: `Bearer ${cloud.relay.opsSecret}`, "x-kwl-operator": "ops.test" } });
  assert.equal(r.status, 200);
  // 到了定期核对时刻：负责人发现中继上没有了，清掉导出水位，下一次发件重新全量
  kA.kernel.db.run(`DELETE FROM relay_kv WHERE k = 'history_recheck_at'`);
  await kA.inv("relay.sync");
  await kA.inv("relay.sync");
  assert.equal(cloud.relay.server.tenant(TID)!.controller(m9), usr("test-lawyer"));
  await kA.inv("matters.members.add", { matter_id: m9, user_id: usr("bob") });
  await kA.inv("relay.sync");
  await kB.inv("relay.sync");
  await kB.inv("relay.sync");
  assert.ok((await docs(kB, m9)).includes("重置前.txt"), "重置后加入的成员拿得到重置前的材料");
});

test("删除事项：回执写明中继上有密文副本；之后 B 再发的段 A 不取回、本机不留任何东西", { timeout: 120_000 }, async () => {
  await kA.inv("matters.close", { matter_id: mid, retention_years: 1 });
  const r = await kA.inv("matters.purge", { matter_id: mid, confirm_title: TITLE, early: true, reason: "客户书面要求删除" });
  const row = r.receipt.receipt.copies.find((c: any) => c.where.startsWith("中软共享中继"));
  assert.equal(row.status, "pending");
  assert.match(row.note, /中软没有事项密钥/);
  // B（仍是成员）继续写入并发出
  await importText(kB, mid, "删除后B写入.txt", "删除后");
  assert.equal((await kB.inv("relay.sync")).push.uploaded, 1);
  const again = await kA.inv("relay.sync");
  assert.equal(again.pull.downloaded, 0, "已删除的事项不再取回");
  const st = await kA.inv("relay.status");
  assert.equal(st.waiting_key + st.waiting_blob + st.deferred, 0);
  assert.equal(existsSync(join(kA.kernel.blobs.dir, mid)), false, "本机没有该事项的块");
});
