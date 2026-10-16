/**
 * 第 11 批第四轮复核 B 的复现转入（S11B-34～38）：
 * - S11B-34：共享文件夹回声不把作者自己的行记成“收到过”，文件夹时代事项开启中继后加入的成员拿到全部材料；
 * - S11B-35：控制成员是共同负责人（不是创建者）时，他加入的迟到成员认出负责人、持钥、能写入；
 * - S11B-36：运营重置后负责人先写一笔、非负责人核对排在负责人重新登记之后，重置前的内容都重新上传；
 * - S11B-37：首次登记持续失败期间定期核对，发件目录不累积重复段；
 * - S11B-38：稳态下非负责人的段不产生“成员行被拒”。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeKernel, type TestKernel } from "./helpers.ts";
import { startCloudCp, type CloudCp } from "./cloud-cp.ts";
import { createKernel } from "../src/index.ts";

const FIRM = "r4-firm";
const TID = `ten_${FIRM}`;
const usr = (s: string) => `usr_${FIRM}_${s}`;
type K = { kernel: Awaited<ReturnType<typeof createKernel>>; dir: string; inv: (m: string, p?: any) => Promise<any> };
let cloud: CloudCp;
let kA: TestKernel;
let kB: K;
let kC: K;
let kD: K;

before(async () => {
  cloud = await startCloudCp({ tenant: TID });
  kA = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_RELAY_SYNC_MS: "off" }, FIRM);
  await kA.inv("control_plane.sync");
  const second = async (slug: string): Promise<K> => {
    const ws = mkdtempSync(join(tmpdir(), `kwl-r4-${slug}-`));
    mkdirSync(join(ws, FIRM, "keys"), { recursive: true });
    copyFileSync(join(kA.dir, FIRM, "keys", "firm-root.json"), join(ws, FIRM, "keys", "firm-root.json"));
    const kernel = await createKernel({ dataDir: ws, firmSlug: FIRM, userSlug: slug, env: { ...process.env, ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_RELAY_SYNC_MS: "off" } });
    return { kernel, dir: ws, inv: (m, p) => kernel.invoke(m, p) };
  };
  kB = await second("bob");
  kC = await second("carol");
  kD = await second("dave");
  for (const k of [kB, kC, kD, kA, kB, kC, kD]) await k.inv("control_plane.sync");
  const body = { max_mode: "default", auto_preauthorizations: [], fetch_allowlist_extra: [], l3a_standard_model: "deny", share_relay: "allow" };
  const { draft } = await kA.inv("firm_policy.create_draft", { kind: "policy", body });
  await kA.inv("firm_policy.sign", { draft_id: draft.draft_id, expected_digest: draft.digest });
  await kA.inv("firm_policy.publish", { draft_id: draft.draft_id });
  await cloud.feed.refresh();
  for (const k of [kB, kC, kD]) await k.inv("control_plane.sync");
});
after(async () => {
  for (const k of [kB, kC, kD]) await k.kernel.close().catch(() => {});
  await kA.kernel.close();
  await cloud.close();
});

const imp = (k: K | TestKernel, mid: string, fn: string, t: string) =>
  k.inv("materials.import", { matter_id: mid, filename: fn, data_base64: Buffer.from(t, "utf8").toString("base64"), mime: "text/plain" });
const docs = async (k: K | TestKernel, mid: string): Promise<string[]> =>
  ((await k.inv("matters.get", { matter_id: mid }).catch(() => ({ documents: [] }))).documents as any[]).map((d) => d.filename).sort();
const entries = () => cloud.relay.server.tenant(TID)?.entries ?? [];
const recheckNow = (k: K | TestKernel) => k.kernel.db.run(`DELETE FROM relay_kv WHERE k = 'history_recheck_at'`);
const reset = async (m: string) => {
  const r = await fetch(`${cloud.relay.base}/v1/relay/ops/tenants/${TID}/matters/${m}`, { method: "DELETE", headers: { authorization: `Bearer ${cloud.relay.opsSecret}`, "x-kwl-operator": "ops.test" } });
  assert.equal(r.status, 200);
};
const newMatter = async (title: string) => (await kA.inv("matters.create", { title, stance: "受让方", consent_status: "not_required", collab_scope: "team" })).matter.matter_id as string;

test("S11B-34：成员之间经共享文件夹互相同步过一轮后开启中继，负责人全量导出带着本机写的材料，之后加入的成员拿得到", { timeout: 180_000 }, async () => {
  const m = await newMatter("文件夹回声");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob") });
  await imp(kA, m, "A自己写的.txt", "A 写的材料");
  const share = mkdtempSync(join(tmpdir(), "kwl-r4-echo-"));
  await kA.inv("sync.export", { share_dir: share, matter_id: m });
  await kB.inv("sync.import", { share_dir: share });
  await kB.inv("sync.export", { share_dir: share, matter_id: m });
  await kA.inv("sync.import", { share_dir: share });
  assert.deepEqual(kA.kernel.db.all(`SELECT t FROM relay_imported WHERE matter_id = ?`, [m]), [], "回声送回的本机自己的行不记为收到");
  await kA.inv("relay.sync");
  assert.equal(entries().filter((e) => e.mid === m).reduce((n, e) => n + e.blobs.length, 0), 1, "负责人第一次中继导出引用本机写的那份材料");
  await kB.inv("relay.sync");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("carol") });
  await kA.inv("relay.sync");
  await kC.inv("relay.sync");
  await kC.inv("relay.sync");
  assert.deepEqual(await docs(kC, m), ["A自己写的.txt"]);
});

test("S11B-35：控制成员是共同负责人（文件夹时代事项、他先在中继登记），他加入的迟到成员认出负责人、持钥、能写入", { timeout: 180_000 }, async () => {
  const m = await newMatter("共同负责人先登记");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "owner" });
  await imp(kA, m, "A的材料.txt", "A 的材料");
  const share = mkdtempSync(join(tmpdir(), "kwl-r4-co-"));
  await kA.inv("sync.export", { share_dir: share, matter_id: m });
  await kB.inv("sync.import", { share_dir: share });
  await kB.inv("relay.sync");
  await kA.inv("relay.sync");
  assert.equal(cloud.relay.server.tenant(TID)!.controller(m), usr("bob"));
  await kB.inv("matters.members.add", { matter_id: m, user_id: usr("carol") });
  await kB.inv("relay.sync");
  await kA.inv("relay.sync");
  await kC.inv("relay.sync");
  await kC.inv("relay.sync");
  const owners = kC.kernel.db.all<{ user_id: string }>(`SELECT user_id FROM matter_members WHERE matter_id = ? AND matter_role = 'owner' AND removed_at IS NULL ORDER BY user_id`, [m]).map((r) => r.user_id);
  assert.deepEqual(owners, [usr("bob"), usr("test-lawyer")], "迟到成员凭作者签名收下创建者写的成员行");
  assert.ok(kC.kernel.db.get(`SELECT 1 AS x FROM matter_keys WHERE matter_id = ? AND wrapped_for = ?`, [m, `dev_${FIRM}_carol`]));
  assert.deepEqual(await docs(kC, m), ["A的材料.txt"]);
  await imp(kC, m, "C写的.txt", "C");
  assert.equal((await kC.inv("relay.sync")).push.uploaded, 1, "迟到成员能写入并发出");
});

test("S11B-36：运营重置后负责人先写一笔（不等定期核对），重置前的材料照样重新上传；非负责人的核对排在负责人重新登记之后也重发", { timeout: 240_000 }, async () => {
  // Y2：负责人先写一笔
  const m = await newMatter("重置后先写");
  await imp(kA, m, "重置前.txt", "重置前的材料");
  await kA.inv("relay.sync");
  await kA.inv("relay.sync");
  await reset(m);
  await imp(kA, m, "重置后的日常改动.txt", "日常");
  await kA.inv("relay.sync");
  await kA.inv("relay.sync");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob") });
  await kA.inv("relay.sync");
  await kB.inv("relay.sync");
  await kB.inv("relay.sync");
  assert.deepEqual(await docs(kB, m), ["重置前.txt", "重置后的日常改动.txt"]);
  // Y3：非负责人 C 写过；重置后 A 先核对、重新登记，C 不等自己的核对（从取新段里看到重置代数）
  const m3 = await newMatter("非负责人重发");
  await kA.inv("matters.members.add", { matter_id: m3, user_id: usr("carol") });
  await imp(kA, m3, "A重置前.txt", "A");
  await kA.inv("relay.sync");
  await kC.inv("relay.sync");
  await imp(kC, m3, "C重置前写的.txt", "C 写的");
  await kC.inv("relay.sync");
  await kA.inv("relay.sync");
  await kC.inv("relay.sync");
  await reset(m3);
  recheckNow(kA);
  await kA.inv("relay.sync");
  await kA.inv("relay.sync");
  await kC.inv("relay.sync");
  await kC.inv("relay.sync");
  await kA.inv("matters.members.add", { matter_id: m3, user_id: usr("dave") });
  await kA.inv("relay.sync");
  await kD.inv("relay.sync");
  await kD.inv("relay.sync");
  assert.deepEqual(await docs(kD, m3), ["A重置前.txt", "C重置前写的.txt"]);
});

test("S11B-37：首次登记持续失败期间定期核对，不当作重置、发件目录不累积重复段", { timeout: 180_000 }, async () => {
  const gate = kA.kernel.gate as any;
  const orig = gate.relay.bind(gate);
  const m = await newMatter("登记持续失败");
  await imp(kA, m, "材料.txt", "材".repeat(30_000));
  gate.relay = async (req: any) => (req.step === "commit" && req.matter_id === m ? { ok: true, status: 507, body: JSON.stringify({ error: "tenant_storage_full" }) } : orig(req));
  try {
    const counts: number[] = [];
    for (let round = 0; round < 3; round++) {
      recheckNow(kA);
      kA.kernel.db.run(`UPDATE relay_outbox SET next_at = ?`, [new Date(Date.now() - 1000).toISOString()]);
      await kA.inv("relay.sync");
      counts.push(kA.kernel.db.all(`SELECT 1 AS x FROM relay_outbox WHERE matter_id = ?`, [m]).length);
    }
    assert.deepEqual(counts, [1, 1, 1]);
    assert.ok(kA.kernel.db.get(`SELECT 1 AS x FROM relay_export_state WHERE matter_id = ?`, [m]), "导出水位不因“事项不存在”被清掉");
  } finally {
    gate.relay = orig;
  }
  await kA.inv("relay.sync");
  assert.equal(entries().filter((e) => e.mid === m).length, 1, "存储恢复后只登记一份");
});

test("S11B-38：稳态下非负责人的段（中继与共享文件夹）不产生“成员行被拒”", { timeout: 180_000 }, async () => {
  const m = await newMatter("成员行告警");
  for (const u of ["bob", "carol", "dave"]) await kA.inv("matters.members.add", { matter_id: m, user_id: usr(u) });
  await kA.inv("relay.sync");
  await kB.inv("relay.sync");
  await kC.inv("relay.sync");
  const conf = (k: K | TestKernel) => k.kernel.db.get<{ n: number }>(`SELECT last_import_origin_conflicts AS n FROM sync_state WHERE matter_id = ?`, [m])?.n ?? 0;
  for (let i = 1; i <= 2; i++) {
    await imp(kB, m, `B第${i}笔.txt`, `B${i}`);
    await kB.inv("relay.sync");
    await kA.inv("relay.sync");
    await kC.inv("relay.sync");
    assert.deepEqual([conf(kA), conf(kC)], [0, 0]);
  }
  const share = mkdtempSync(join(tmpdir(), "kwl-r4-warn-"));
  await kA.inv("sync.export", { share_dir: share, matter_id: m });
  await kB.inv("sync.import", { share_dir: share });
  await imp(kB, m, "B经文件夹.txt", "F");
  await kB.inv("sync.export", { share_dir: share, matter_id: m });
  const r = await kA.inv("sync.import", { share_dir: share });
  assert.equal((r.originConflicts as string[]).filter((x) => x.startsWith("member_row_rejected")).length, 0);
});

test("S11B-39①：升级前经共享文件夹收到、没有“收到过”记录的行，共同负责人第一次中继全量导出也不回传（按来源设备判断）", { timeout: 180_000 }, async () => {
  const m = await newMatter("升级前收到的行");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "owner" });
  await imp(kA, m, "A写的.txt", "A 写的材料");
  const share = mkdtempSync(join(tmpdir(), "kwl-r4-old-"));
  await kA.inv("sync.export", { share_dir: share, matter_id: m });
  await kB.inv("sync.import", { share_dir: share });
  // 模拟升级前的数据目录：摄取时没有记下“收到过”
  kB.kernel.db.run(`DELETE FROM relay_imported WHERE matter_id = ?`, [m]);
  await kA.inv("relay.sync");
  await kB.inv("relay.sync");
  const bSegs = entries().filter((e) => e.mid === m && e.dev === `dev_${FIRM}_bob`);
  assert.equal(bSegs.reduce((n, e) => n + e.blobs.length, 0), 0, "B 不转发 A 写的材料");
});

test("第四轮反向对照 R32：同段里先出现“共同负责人加的人”、后出现“该共同负责人的负责人行”（行序号更大），后加入的成员也收下前者", { timeout: 180_000 }, async () => {
  const m = await newMatter("同段重试");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("carol"), matter_role: "owner" });
  const s1 = mkdtempSync(join(tmpdir(), "kwl-r4-fix1-"));
  await kA.inv("sync.export", { share_dir: s1, matter_id: m });
  await kC.inv("sync.import", { share_dir: s1 });
  await kC.inv("matters.members.add", { matter_id: m, user_id: usr("dave") });
  await kC.inv("sync.export", { share_dir: s1, matter_id: m });
  await kA.inv("sync.import", { share_dir: s1 });
  // A 重新加一次 carol（刷新）：carol 的成员行序号变得比 dave 的大
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("carol"), matter_role: "owner" });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob") });
  const lam = (u: string) => kA.kernel.db.get<{ l: number }>(`SELECT row_lamport AS l FROM matter_members WHERE matter_id = ? AND user_id = ?`, [m, usr(u)])!.l;
  assert.ok(lam("carol") > lam("dave"), "前提：carol 的行序号大于 dave 的");
  const s2 = mkdtempSync(join(tmpdir(), "kwl-r4-fix2-"));
  await kA.inv("sync.export", { share_dir: s2, matter_id: m });
  await kB.inv("sync.import", { share_dir: s2 });
  const got = kB.kernel.db.all<{ user_id: string }>(`SELECT user_id FROM matter_members WHERE matter_id = ? ORDER BY user_id`, [m]).map((r) => r.user_id);
  assert.deepEqual(got, [usr("bob"), usr("carol"), usr("dave"), usr("test-lawyer")]);
});

test("第四轮反向对照 R34：旧版客户端转发的成员行没有作者签名时，后加入的成员不从这一段半引导（延后），等负责人的段后正常持钥", { timeout: 180_000 }, async () => {
  const m = await newMatter("旧版转发");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob") });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("dave") });
  const s1 = mkdtempSync(join(tmpdir(), "kwl-r4-old1-"));
  await kA.inv("sync.export", { share_dir: s1, matter_id: m });
  await kB.inv("sync.import", { share_dir: s1 });
  // 模拟旧版客户端：转发的成员行不带作者签名
  kB.kernel.db.run(`UPDATE matter_members SET author_sig = NULL, author_cert = NULL WHERE matter_id = ? AND author_device != ?`, [m, `dev_${FIRM}_bob`]);
  await imp(kB, m, "B写.txt", "B");
  const s2 = mkdtempSync(join(tmpdir(), "kwl-r4-old2-"));
  await kB.inv("sync.export", { share_dir: s2, matter_id: m });
  await kD.inv("sync.import", { share_dir: s2 });
  assert.equal(kD.kernel.db.get(`SELECT 1 AS x FROM matters WHERE matter_id = ?`, [m]), undefined, "只有同事段时延后，不半引导");
  await kD.inv("sync.import", { share_dir: s1 });
  await kD.inv("sync.import", { share_dir: s2 });
  assert.ok(kD.kernel.db.get(`SELECT 1 AS x FROM matter_keys WHERE matter_id = ? AND wrapped_for = ?`, [m, `dev_${FIRM}_dave`]), "负责人的段到了之后持钥");
  assert.deepEqual(await docs(kD, m), ["B写.txt"]);
});

test("第四轮：运营重置后，还不知道重置的非负责人发件被中继拒收（不抢先成为控制成员）；负责人重新登记后各自重发，之后加入的成员拿到全部", { timeout: 240_000 }, async () => {
  const m = await newMatter("重置后非负责人先发");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob") });
  await imp(kA, m, "A重置前.txt", "A");
  await kA.inv("relay.sync");
  await kB.inv("relay.sync");
  await imp(kB, m, "B重置前.txt", "B");
  await kB.inv("relay.sync");
  await kA.inv("relay.sync");
  await reset(m);
  await imp(kB, m, "B重置后.txt", "B2");
  await kB.inv("relay.sync");
  assert.equal(cloud.relay.server.tenant(TID)!.controller(m), null, "非负责人没有把事项在中继上重新建起来");
  await kB.inv("relay.sync");
  assert.ok(kB.kernel.db.all(`SELECT 1 AS x FROM relay_outbox WHERE matter_id = ?`, [m]).length <= 1, "发件目录里该事项至多一份待发段");
  await kA.inv("relay.sync");
  await kA.inv("relay.sync");
  assert.equal(cloud.relay.server.tenant(TID)!.controller(m), usr("test-lawyer"));
  await kB.inv("relay.sync");
  kB.kernel.db.run(`UPDATE relay_outbox SET next_at = ?`, [new Date(Date.now() - 1000).toISOString()]);
  await kB.inv("relay.sync");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("carol") });
  await kA.inv("relay.sync");
  await kC.inv("relay.sync");
  await kC.inv("relay.sync");
  assert.deepEqual(await docs(kC, m), ["A重置前.txt", "B重置前.txt", "B重置后.txt"]);
});
