/**
 * 第 11 批第七轮（收口）复核处置的回归用例：
 * - S11B-55：两位共同负责人并发轮换出同号纪元后，一位负责人在本机重新轮换即清除本机的冲突；其他设备在冲突另一方发来新纪元后解除、补发暂停期间的内容；
 * - S11B-53：中继重建后，非负责人一段上传期间本机得知新实例编号，这一段仍按旧编号登记、被拒收，不抢先成为控制成员；
 * - 第六轮反向对照缺口：成员行序号跳跃过大拒收（R64）；首同步延后保留原因（R65）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicKeyMap } from "@zr-legal/firm-trust";
import { createRelayApi } from "@zr-legal/relay-api";
import { makeKernel, type TestKernel } from "./helpers.ts";
import { startCloudCp, type CloudCp } from "./cloud-cp.ts";
import { createKernel } from "../src/index.ts";

const FIRM = "r7-firm";
const TID = `ten_${FIRM}`;
const usr = (s: string) => `usr_${FIRM}_${s}`;
type K = { kernel: Awaited<ReturnType<typeof createKernel>>; dir: string; inv: (m: string, p?: any) => Promise<any> };
let cloud: CloudCp;
let kA: TestKernel;
let kB: K;
let kC: K;
let kD: K;
let fresh: ReturnType<typeof createRelayApi> | null = null;

before(async () => {
  cloud = await startCloudCp({ tenant: TID });
  kA = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_RELAY_SYNC_MS: "off" }, FIRM);
  await kA.inv("control_plane.sync");
  const second = async (slug: string): Promise<K> => {
    const ws = mkdtempSync(join(tmpdir(), `kwl-r7-${slug}-`));
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
  if (fresh) {
    fresh.closeAllConnections();
    await new Promise<void>((r) => fresh!.close(() => r()));
  }
  for (const k of [kB, kC, kD]) await k.kernel.close().catch(() => {});
  await kA.kernel.close();
  await cloud.close();
});

const imp = (k: K | TestKernel, mid: string, fn: string, t: string) =>
  k.inv("materials.import", { matter_id: mid, filename: fn, data_base64: Buffer.from(t, "utf8").toString("base64"), mime: "text/plain" });
const docs = async (k: K | TestKernel, mid: string): Promise<string[]> =>
  ((await k.inv("matters.get", { matter_id: mid }).catch(() => ({ documents: [] }))).documents as any[]).map((d) => d.filename).sort();
const alerts = (k: K | TestKernel, mid: string) => k.kernel.db.all<{ kind: string }>(`SELECT kind FROM sync_alerts WHERE matter_id = ?`, [mid]).map((a) => a.kind);
const dir = (tag: string) => mkdtempSync(join(tmpdir(), `kwl-r7-${tag}-`));
const newMatter = async (title: string) => (await kA.inv("matters.create", { title, stance: "受让方", consent_status: "not_required", collab_scope: "team" })).matter.matter_id as string;

test("S11B-55（第 12 批）：两位共同负责人并发移出不同成员、各自轮换出同号纪元——按成员链合并（两人都移出），由一位自动补轮换，另一位等新纪元后补发等待期间的内容", { timeout: 240_000 }, async () => {
  const m = await newMatter("并发轮换");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "owner" });
  for (const u of ["carol", "dave"]) await kA.inv("matters.members.add", { matter_id: m, user_id: usr(u) });
  const s0 = dir("c0");
  await kA.inv("sync.export", { share_dir: s0, matter_id: m });
  for (const k of [kB, kC, kD]) await k.inv("sync.import", { share_dir: s0 });
  // A 与 bob 各自移出一人：各得纪元 2（同号、不同密钥）
  await kA.inv("matters.members.remove", { matter_id: m, user_id: usr("carol") });
  await kB.inv("matters.members.remove", { matter_id: m, user_id: usr("dave") });
  const sa = dir("ca");
  const sb = dir("cb");
  await kA.inv("sync.export", { share_dir: sa, matter_id: m });
  await kB.inv("sync.export", { share_dir: sb, matter_id: m });
  await kA.inv("sync.import", { share_dir: sb });
  await kB.inv("sync.import", { share_dir: sa });
  // 两边的成员关系一致：carol、dave 都已移出（并发的移出都生效）
  const gone = (k: K | TestKernel) => k.kernel.db.all<{ user_id: string }>(`SELECT user_id FROM matter_members WHERE matter_id = ? AND removed_at IS NOT NULL ORDER BY user_id`, [m]).map((r) => r.user_id);
  assert.deepEqual(gone(kA), [usr("carol"), usr("dave")]);
  assert.deepEqual(gone(kB), [usr("carol"), usr("dave")]);
  assert.ok(!alerts(kA, m).includes("epoch_conflict") && !alerts(kB, m).includes("epoch_conflict"), "链模式下没有第 11 批的纪元冲突告警");
  // 恰好一位（纪元 2 胜出声明的作者）自动补轮换到纪元 3；另一位等待（rekey_needed，只发成员链）
  const top = (k: K | TestKernel) => k.kernel.db.get<{ e: number }>(`SELECT MAX(epoch) AS e FROM matter_keys WHERE matter_id = ? AND wrapped_for = ?`, [m, k === kA ? `dev_${FIRM}_test-lawyer` : `dev_${FIRM}_bob`])!.e;
  const [rot, wait, rotShare, waitName] = top(kA) === 3 ? [kA, kB, sa, "bob"] : [kB, kA, sb, "test-lawyer"];
  assert.equal(top(rot), 3, "胜出者补轮换到纪元 3");
  void rotShare;
  // 等待的一方此时写的内容暂不发出
  await imp(wait, m, "等待期间.txt", "等待新纪元期间写的");
  const cw = dir("cw");
  const pausedEx = await wait.inv("sync.export", { share_dir: cw, matter_id: m });
  assert.deepEqual(alerts(wait, m), ["rekey_needed"], "等待方有 rekey_needed");
  assert.deepEqual(pausedEx.pausedConflict, [m], "等待期间只发成员链");
  // 被移出者收到等待期间发出的段也读不到内容（复核 S12B-16）
  for (const k of [kC, kD]) {
    await k.inv("sync.import", { share_dir: cw });
    assert.equal(k.kernel.db.get(`SELECT 1 AS x FROM document_versions WHERE matter_id = ? AND filename = ?`, [m, "等待期间.txt"]), undefined);
  }
  // 补轮换的一方的新纪元送到 → 解除；等待期间的内容随后送达
  const s3 = dir("c3");
  await rot.inv("sync.export", { share_dir: s3, matter_id: m });
  await wait.inv("sync.import", { share_dir: s3 });
  assert.deepEqual(alerts(wait, m), [], `新纪元送到后解除（${waitName}）`);
  const s4 = dir("c4");
  assert.equal((await wait.inv("sync.export", { share_dir: s4, matter_id: m })).pausedConflict.length, 0);
  await rot.inv("sync.import", { share_dir: s4 });
  assert.ok((await docs(rot, m)).includes("等待期间.txt"), "等待期间写的内容随后送达");
  // 被移出的 carol、dave 都读不到
  for (const k of [kC, kD]) {
    await k.inv("sync.import", { share_dir: s4 });
    assert.equal(k.kernel.db.get(`SELECT 1 AS x FROM document_versions WHERE matter_id = ? AND filename = ?`, [m, "等待期间.txt"]), undefined, "被移出者读不到（本机库里没有）");
  }
});

test("S11B-53：中继重建后，非负责人一段上传期间本机得知新实例编号，这一段仍按旧编号登记、被拒收，不抢先成为控制成员", { timeout: 240_000 }, async () => {
  const m = await newMatter("重建期间上传");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("carol") });
  await imp(kA, m, "A.txt", "A");
  await kA.inv("relay.sync");
  await kC.inv("relay.sync");
  const port = Number(new URL(cloud.relay.base).port);
  const old = cloud.relay.server;
  old.closeAllConnections();
  await new Promise<void>((r) => old.close(() => r()));
  fresh = createRelayApi({ dir: mkdtempSync(join(tmpdir(), "kwl-relay-rebuilt7-")), keys: publicKeyMap(cloud.cp.publicKeys.seat), feed: cloud.feed, opsGuard: cloud.relay.opsGuard, accessLog: () => {} });
  await new Promise<void>((r) => fresh!.listen(port, "127.0.0.1", () => r()));
  await imp(kC, m, "C.txt", "C");
  // 上传块期间：模拟后台收件得知新实例编号（只改本机记下的编号）
  const gate = kC.kernel.gate as any;
  const orig = gate.relay.bind(gate);
  gate.relay = async (req: any) => {
    if (req.step === "have" && req.matter_id === m) kC.kernel.db.run(`INSERT OR REPLACE INTO relay_kv (k, v) VALUES ('instance', ?)`, [fresh!.instance]);
    return orig(req);
  };
  try {
    await kC.inv("relay.sync");
  } finally {
    gate.relay = orig;
  }
  assert.equal(fresh.tenant(TID)?.controller(m) ?? null, null, "非负责人没有把事项登记到新中继上");
});

// 第 12 批：有成员链的事项不采信段里的成员行（行规则下的原断言见 member-log-legacy）；迟到成员可从同事的段按链引导
test("第六轮反向对照缺口 R64/R65（第 12 批）：改大成员行序号对链模式无效；迟到成员从同事的段按链引导", { timeout: 180_000 }, async () => {
  const m = await newMatter("序号跳跃");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob") });
  const s1 = dir("j1");
  await kA.inv("sync.export", { share_dir: s1, matter_id: m });
  await kB.inv("sync.import", { share_dir: s1 });
  // A 本机把一行的序号改成极大值（被盗设备或恶意负责人）：导出时重新签名，B 按跳跃上限拒收
  kA.kernel.db.run(`UPDATE matter_members SET row_lamport = 99999999 WHERE matter_id = ? AND user_id = ?`, [m, usr("bob")]);
  await imp(kA, m, "触发导出.txt", "x");
  const s2 = dir("j2");
  await kA.inv("sync.export", { share_dir: s2, matter_id: m });
  await kB.inv("sync.import", { share_dir: s2 });
  assert.ok((kB.kernel.db.get<{ l: number }>(`SELECT row_lamport AS l FROM matter_members WHERE matter_id = ? AND user_id = ?`, [m, usr("bob")])!.l) < 99999999, "段里的成员行不采信");
  // 首同步延后：dave 先只收到编辑 bob 的段（bob 不是负责人）→ 延后并说明原因
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
  assert.deepEqual(rd.dispositions.map((x: any) => x.outcome), ["applied"], JSON.stringify(rd.originConflicts));
  assert.ok(kD.kernel.db.get(`SELECT 1 AS x FROM matter_keys WHERE matter_id = ? AND wrapped_for = ?`, [m2, `dev_${FIRM}_dave`]), "按链引导、持钥");
});
