/**
 * 第 11 批 S11：团队事项经中软共享中继同步（端到端加密）——两台律所设备 + 本机云端 v0（控制面、中继服务）。
 * - 律所策略未允许：不收发，中继上什么也没有；
 * - 允许后：A 建团队事项、加 B、导入材料 → A 发出 → B 取回并摄取（事项、材料行与可解密的材料块）；B 的改动反向送达 A；
 *   没有新内容时不再出段；
 * - 中继上只有密文：存储里找不到事项名、当事人、材料原文、文件名，也找不到材料明文的摘要（块按密文摘要寻址）；
 * - 中继换了块内容：闸门按摘要拒收，B 不摄取；恢复后照常；
 * - 不是成员的同事（C）取不到任何段；移出 B（轮换密钥）后，B 取不到之后的段与块；
 * - 删除事项：回执写明中继上有密文副本（待团队删除指令），本机收发件目录清空，之后不再取回。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kernel } from "../src/index.ts";
import { makeKernel, type TestKernel } from "./helpers.ts";
import { startCloudCp, type CloudCp } from "./cloud-cp.ts";

const FIRM = "relay-firm";
const TID = `ten_${FIRM}`;
const BOB = `usr_${FIRM}_bob`;
const CAROL = `usr_${FIRM}_carol`;
const TITLE = "华东某某并购案金丝雀";
const CLIENT = "甲方当事人金丝雀";
const TEXT = "第一条 保密义务金丝雀条款：双方对本协议内容负有保密义务。";
const FILE = "股权转让协议金丝雀.txt";
let cloud: CloudCp;
let kA: TestKernel;
const others: { kernel: Kernel; inv: (m: string, p?: any) => Promise<any> }[] = [];
let kB: (typeof others)[number];
let kC: (typeof others)[number];

async function second(slug: string) {
  const ws = mkdtempSync(join(tmpdir(), `kwl-ws-${slug}-`));
  mkdirSync(join(ws, FIRM, "keys"), { recursive: true });
  copyFileSync(join(kA.dir, FIRM, "keys", "firm-root.json"), join(ws, FIRM, "keys", "firm-root.json"));
  const { createKernel } = await import("../src/index.ts");
  const kernel = await createKernel({ dataDir: ws, firmSlug: FIRM, userSlug: slug, env: { ...process.env, ...cloud.env, ZR_MODEL_PROVIDER: "upstream" } });
  const k = { kernel, inv: (m: string, p?: any) => kernel.invoke(m, p) };
  others.push(k);
  return k;
}

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
  kA = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream" }, FIRM);
  assert.equal((await kA.inv("control_plane.sync")).report.ok, true);
  kB = await second("bob");
  kC = await second("carol");
  for (const k of [kB, kC]) assert.equal((await k.inv("control_plane.sync")).report.ok, true);
  // A 从目录里取得 B、C 的设备
  assert.equal((await kA.inv("control_plane.sync")).report.ok, true);
  assert.ok(kA.kernel.db.get(`SELECT 1 AS x FROM devices WHERE member_id = ? AND status = 'active'`, [BOB]), "A 已从设备目录取得 B 的设备");
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

test("管理员允许后：A 发出、B 取回并摄取；中继上只有密文（无名称、原文、文件名与明文摘要）；B 的改动送达 A；无新内容不出段", { timeout: 120_000 }, async () => {
  const body = { max_mode: "default", auto_preauthorizations: [], fetch_allowlist_extra: [], l3a_standard_model: "deny", share_relay: "allow" };
  const { draft } = await kA.inv("firm_policy.create_draft", { kind: "policy", body });
  assert.deepEqual(draft.relaxations, ["share_relay:allow"]);
  await kA.inv("firm_policy.sign", { draft_id: draft.draft_id, expected_digest: draft.digest });
  await kA.inv("firm_policy.publish", { draft_id: draft.draft_id });
  await cloud.feed.refresh();
  for (const k of [kB, kC]) await k.inv("control_plane.sync");
  assert.equal((await kA.inv("kernel.status")).egress_gate.share_relay_allowed, true);

  await kA.inv("matters.members.add", { matter_id: mid, user_id: BOB });
  const doc = await kA.inv("materials.import", { matter_id: mid, filename: FILE, data_base64: Buffer.from(TEXT, "utf8").toString("base64"), mime: "text/plain" });
  const a1 = await kA.inv("relay.sync");
  assert.equal(a1.push.errors.length, 0, JSON.stringify(a1.push));
  assert.ok(a1.push.uploaded >= 1);
  assert.equal(a1.status.pending_upload, 0, "发件已清空");

  // 中继上只有密文
  const stored = relayBytes();
  const plainSha = createHash("sha256").update(TEXT, "utf8").digest("hex");
  const uri = kA.kernel.db.get<{ storage_uri: string }>(`SELECT storage_uri FROM document_versions WHERE document_version_id = ?`, [doc.document_version_id])!.storage_uri;
  for (const s of [TITLE, CLIENT, "保密义务金丝雀", FILE, plainSha, uri.split("/").pop()!]) assert.equal(stored.includes(Buffer.from(s, "utf8")), false, `中继上找不到：${s.slice(0, 20)}`);
  const t = cloud.relay.server.tenant(TID)!;
  assert.ok(t.entries.every((e) => e.mid === mid && e.readers.includes(`dev_${FIRM}_bob`) && !e.readers.includes(`dev_${FIRM}_carol`)), JSON.stringify(t.entries.map((e) => e.readers)));
  assert.ok(t.entries.every((e) => !e.readers.includes("recovery")), "恢复托管不是读者");

  // B 取回并摄取
  const b1 = await kB.inv("relay.sync");
  assert.equal(b1.pull.errors.length, 0, JSON.stringify(b1.pull));
  assert.ok(b1.pull.applied >= 1, JSON.stringify(b1.pull));
  const bm = await kB.inv("matters.get", { matter_id: mid });
  assert.equal(bm.matter.title, TITLE);
  assert.equal(bm.documents.length, 1);
  const bUri = kB.kernel.db.get<{ storage_uri: string }>(`SELECT storage_uri FROM document_versions WHERE matter_id = ?`, [mid])!.storage_uri;
  assert.equal(kB.kernel.blobs.read(bUri).toString("utf8"), TEXT, "B 能解开取回的材料块");
  assert.equal((await kB.inv("relay.status")).held, 0);

  // 没有新内容：不再出段
  const a2 = await kA.inv("relay.sync");
  assert.equal(a2.push.exported, 0, "无新内容不出段");

  // B 的改动送达 A
  await kB.inv("materials.import", { matter_id: mid, filename: "补充材料.txt", data_base64: Buffer.from("补充说明", "utf8").toString("base64"), mime: "text/plain" });
  const b2 = await kB.inv("relay.sync");
  assert.ok(b2.push.uploaded >= 1, JSON.stringify(b2.push));
  const a3 = await kA.inv("relay.sync");
  assert.ok(a3.pull.applied >= 1, JSON.stringify(a3.pull));
  assert.equal((await kA.inv("matters.get", { matter_id: mid })).documents.length, 2);

  // 不是成员的同事：什么也取不到
  const c1 = await kC.inv("relay.sync");
  assert.equal(c1.pull.downloaded, 0);
  await assert.rejects(kC.inv("matters.get", { matter_id: mid }));
});

test("中继换了块内容：闸门按摘要拒收、B 不摄取；恢复后照常", { timeout: 120_000 }, async () => {
  await kA.inv("materials.import", { matter_id: mid, filename: "第三份.txt", data_base64: Buffer.from("第三份材料", "utf8").toString("base64"), mime: "text/plain" });
  await kA.inv("relay.sync");
  const t = cloud.relay.server.tenant(TID)!;
  const last = t.entries.at(-1)!;
  const p = join(cloud.relay.dir, "t", TID, "m", mid, last.chunks[0]!);
  const orig = readFileSync(p);
  writeFileSync(p, Buffer.concat([orig.subarray(0, orig.length - 1), Buffer.from([orig[orig.length - 1]! ^ 1])]));
  const before = (await kB.inv("matters.get", { matter_id: mid })).documents.length;
  const b = await kB.inv("relay.sync");
  assert.ok(b.pull.errors.includes("relay_chunk_digest_mismatch"), JSON.stringify(b.pull));
  assert.equal((await kB.inv("matters.get", { matter_id: mid })).documents.length, before, "换过的段没有摄取");
  // 单条失败不堵队头：游标照常前进，那一段记进重试表
  const st = await kB.inv("relay.status");
  assert.equal(st.retrying, 1);
  assert.equal(Number(kB.kernel.db.get<{ v: string }>(`SELECT v FROM relay_kv WHERE k = 'feed_cursor'`)!.v), last.seq, "游标越过了那一段");
  // 后面的段照常收到
  await kA.inv("materials.import", { matter_id: mid, filename: "第四份.txt", data_base64: Buffer.from("第四份材料", "utf8").toString("base64"), mime: "text/plain" });
  await kA.inv("relay.sync");
  assert.ok((await kB.inv("relay.sync")).pull.applied >= 1, "被换的那一段不堵住后面的段");
  assert.equal((await kB.inv("matters.get", { matter_id: mid })).documents.length, before + 1);
  // 中继恢复后：到期重试取回
  writeFileSync(p, orig);
  kB.kernel.db.run(`UPDATE relay_retry SET next_at = ?`, [new Date(Date.now() - 1000).toISOString()]);
  const b2 = await kB.inv("relay.sync");
  assert.ok(b2.pull.applied >= 1, JSON.stringify(b2.pull));
  assert.equal((await kB.inv("matters.get", { matter_id: mid })).documents.length, before + 2);
  assert.equal((await kB.inv("relay.status")).retrying, 0);
});

test("移出 B（轮换密钥）：之后的段 B 取不到；中继按新纪元替换读者", { timeout: 120_000 }, async () => {
  await kA.inv("matters.members.remove", { matter_id: mid, user_id: BOB });
  await kA.inv("materials.import", { matter_id: mid, filename: "移出后.txt", data_base64: Buffer.from("移出后的新材料", "utf8").toString("base64"), mime: "text/plain" });
  const a = await kA.inv("relay.sync");
  assert.equal(a.push.errors.length, 0, JSON.stringify(a.push));
  const last = cloud.relay.server.tenant(TID)!.entries.at(-1)!;
  assert.equal(last.epoch, 2);
  assert.ok(!last.readers.includes(`dev_${FIRM}_bob`));
  const before = (await kB.inv("matters.get", { matter_id: mid }).catch(() => ({ documents: [] as unknown[] }))).documents.length;
  const b = await kB.inv("relay.sync");
  assert.equal(b.pull.downloaded, 0);
  const after = (await kB.inv("matters.get", { matter_id: mid }).catch(() => ({ documents: [] as unknown[] }))).documents.length;
  assert.equal(after, before, "B 收不到移出之后的材料");
});

test("删除事项：回执写明中继上有密文副本（待团队删除指令）；本机收发件清空；之后不再取回", { timeout: 120_000 }, async () => {
  await kA.inv("matters.close", { matter_id: mid, retention_years: 1 });
  const r = await kA.inv("matters.purge", { matter_id: mid, confirm_title: TITLE, early: true, reason: "客户书面要求删除" });
  const row = r.receipt.receipt.copies.find((c: any) => c.where.startsWith("中软共享中继"));
  assert.equal(row.status, "pending");
  assert.match(row.note, /中软没有事项密钥/);
  const st = await kA.inv("relay.status");
  assert.equal(st.pending_upload, 0);
  assert.equal(st.held, 0);
  const again = await kA.inv("relay.sync");
  assert.equal(again.pull.downloaded, 0, "已删除的事项不再取回");
  assert.equal(again.push.exported, 0);
});
