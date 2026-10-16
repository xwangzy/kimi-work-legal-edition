// 第 11 批第四轮复核 A 的复现转入（S11A-35②③、S11A-36、S11A-37，中继介质）：修正前为失败，修正后为回归用例
/**
 * 本机云端 v0（控制面 + 中继）+ 五台律所设备：A = test-lawyer（创建者），B = bob，C = carol，D = dave，E = erin。
 * ② S11A-35（中继）：事项先经共享文件夹、后开中继，共同负责人 carol 先经中继同步成为控制成员；carol 加入的迟到成员 dave
 *    只能从 carol 的段引导，而 carol 的负责人行是 A 写的 → 被拒、包裹不落库，dave 永久读不了。
 * ③ S11A-35（中继，移交）：A 把负责人移交给新加入的 erin 并把自己改为编辑——在 erin 第一次收件之前完成：
 *    erin 只能从控制成员 A 的段引导，而 A 的段里 A 已不是负责人 → 一律延后，新负责人永远拿不到事项。
 * ④ S11A-36：移交后运营按事项重置（界面给出的出路），创建者 A 已是普通成员：A 只重发“本机第一次收到该事项之后”写的行，
 *    新负责人 carol 不回传收到过的行 → 创建者早期写入的材料从此不在中继上。
 * ⑤ S11A-37：重置后负责人迟迟没有重新登记时，成员设备每到一次定期核对就清掉导出水位、再导出一份“本机写入的全部内容”，发件目录不断累积重复段。
 * 第四轮处置：成员行作者签名 + 首同步起点为创建者；中继告知重置代数，重置后各设备把本机写入的行全量重发、先删发件目录里该事项未登记的段。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { makeKernel } = await import("./helpers.ts");
const { startCloudCp } = await import("./cloud-cp.ts");
const { relayChunks } = await import("../src/sync-engine.ts");
const { scanSegments } = await import("@zr-legal/sync");

const FIRM = "r4b-firm";
const TID = `ten_${FIRM}`;
const usr = (s: string) => `usr_${FIRM}_${s}`;
const dev = (s: string) => `dev_${FIRM}_${s}`;
const LOG = process.env.R4A_LOG ? console.log : (..._a: unknown[]) => {};
let cloud: any;
let kA: any;
const others: any[] = [];
let kB: any;
let kC: any;
let kD: any;
let kE: any;

async function second(slug: string) {
  const ws = mkdtempSync(join(tmpdir(), `kwl-r4b-${slug}-`));
  mkdirSync(join(ws, FIRM, "keys"), { recursive: true });
  copyFileSync(join(kA.dir, FIRM, "keys", "firm-root.json"), join(ws, FIRM, "keys", "firm-root.json"));
  const { createKernel } = await import("../src/index.ts");
  const kernel = await createKernel({ dataDir: ws, firmSlug: FIRM, userSlug: slug, env: { ...process.env, ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_RELAY_SYNC_MS: "off" } });
  const k = { kernel, dir: ws, inv: (m: string, p?: any) => kernel.invoke(m, p) };
  others.push(k);
  return k;
}
const importText = (k: any, mid: string, filename: string, text: string) =>
  k.inv("materials.import", { matter_id: mid, filename, data_base64: Buffer.from(text, "utf8").toString("base64"), mime: "text/plain" });
const members = (k: any, mid: string) => k.kernel.db.all(`SELECT user_id, matter_role, author_device FROM matter_members WHERE matter_id = ? ORDER BY user_id`, [mid]);
const wraps = (k: any, mid: string, d: string) => k.kernel.db.all(`SELECT epoch FROM matter_keys WHERE matter_id = ? AND wrapped_for = ?`, [mid, d]);
const docs = async (k: any, mid: string): Promise<string[] | string> =>
  k.inv("matters.get", { matter_id: mid }).then((x: any) => x.documents.map((d: any) => d.filename).sort()).catch((e: any) => `打不开：${e.message}`);
const entries = () => cloud.relay.server.tenant(TID)?.entries ?? [];
const recheckNow = (k: any) => k.kernel.db.run(`DELETE FROM relay_kv WHERE k = 'history_recheck_at'`);
const resetMatter = (mid: string) =>
  fetch(`${cloud.relay.base}/v1/relay/ops/tenants/${TID}/matters/${mid}`, { method: "DELETE", headers: { authorization: `Bearer ${cloud.relay.opsSecret}`, "x-kwl-operator": "ops.r4a" } });

before(async () => {
  cloud = await startCloudCp({ tenant: TID });
  kA = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_RELAY_SYNC_MS: "off" }, FIRM);
  await kA.inv("control_plane.sync");
  kB = await second("bob");
  kC = await second("carol");
  kD = await second("dave");
  kE = await second("erin");
  for (const k of [kB, kC, kD, kE, kA, kB, kC, kD, kE]) await k.inv("control_plane.sync");
  const body = { max_mode: "default", auto_preauthorizations: [], fetch_allowlist_extra: [], l3a_standard_model: "deny", share_relay: "allow" };
  const { draft } = await kA.inv("firm_policy.create_draft", { kind: "policy", body });
  await kA.inv("firm_policy.sign", { draft_id: draft.draft_id, expected_digest: draft.digest });
  await kA.inv("firm_policy.publish", { draft_id: draft.draft_id });
  await cloud.feed.refresh();
  for (const k of [kB, kC, kD, kE]) await k.inv("control_plane.sync");
});
after(async () => {
  for (const k of others) await k.kernel.close().catch(() => {});
  await kA.kernel.close();
  await cloud.close();
});

test("② S11A-35（中继）：先经共享文件夹、后开中继，共同负责人成为控制成员；他加入的迟到成员持钥、能写入", { timeout: 240_000 }, async () => {
  const { matter } = await kA.inv("matters.create", { title: "先文件夹后中继", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  const mid = matter.matter_id;
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("carol"), matter_role: "owner" });
  await importText(kA, mid, "甲.txt", "甲");
  // 事项先经共享文件夹到了 carol（律所开中继之前的常态）——这里只经文件夹导出一次，模拟“开启前已在用”
  const share = mkdtempSync(join(tmpdir(), "kwl-r4b-share-"));
  await kA.inv("sync.export", { share_dir: share, matter_id: mid });
  await kC.inv("sync.import", { share_dir: share });
  // 开启中继后 carol 的电脑先同步（两位都是负责人，负责人不等待）
  await kC.inv("relay.sync");
  LOG("控制成员：", cloud.relay.server.tenant(TID)!.controller(mid));
  await kA.inv("relay.sync");
  // 控制成员 carol 加入迟到成员 dave，写一份材料，发出
  await kC.inv("matters.members.add", { matter_id: mid, user_id: usr("dave") });
  await importText(kC, mid, "乙.txt", "乙（carol 写）");
  await kC.inv("relay.sync");
  await kA.inv("relay.sync");
  await kA.inv("relay.sync");
  const d1 = await kD.inv("relay.sync");
  const d2 = await kD.inv("relay.sync");
  LOG("dave 收件：", JSON.stringify(d1.pull), JSON.stringify(d2.pull));
  LOG("dave 成员表：", JSON.stringify(members(kD, mid)));
  LOG("dave 包裹：", JSON.stringify(wraps(kD, mid, dev("dave"))));
  LOG("dave 材料：", await docs(kD, mid));
  const write = await importText(kD, mid, "丁.txt", "dave 写").then(() => "ok").catch((e: any) => `写不了：${e.message}`);
  LOG("dave 写入：", write, "｜状态：", JSON.stringify(await kD.inv("relay.status")));
  assert.equal(cloud.relay.server.tenant(TID)!.controller(mid), usr("carol"));
  assert.ok(wraps(kD, mid, dev("dave")).length > 0, "迟到成员应持有面向自己的包裹");
  assert.equal(write, "ok", "迟到成员应能写入");
});

test("③ S11A-35（中继，移交）：负责人移交给新加入的成员并把自己改为编辑——新负责人拿到事项", { timeout: 240_000 }, async () => {
  const { matter } = await kA.inv("matters.create", { title: "移交给新人", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  const mid = matter.matter_id;
  await importText(kA, mid, "甲.txt", "甲");
  await kA.inv("relay.sync");
  // 一次操作里完成移交（A 是控制成员，界面放行），然后发出
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("erin"), matter_role: "owner" });
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("test-lawyer"), matter_role: "editor" });
  await kA.inv("relay.sync");
  const e1 = await kE.inv("relay.sync");
  const e2 = await kE.inv("relay.sync");
  LOG("erin 收件：", JSON.stringify(e1.pull), JSON.stringify(e2.pull));
  LOG("erin 状态：", JSON.stringify(await kE.inv("relay.status")));
  LOG("erin 打开事项：", await docs(kE, mid));
  const adj = await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("dave") }).then(() => "ok").catch((e: any) => e.message);
  LOG("A 再加人：", adj);
  assert.ok(Array.isArray(await docs(kE, mid)), "新负责人应能打开事项");
  // 包裹随“签发者本段以负责人身份做过成员变更”落库：新负责人能写入（第四轮反向对照 R33）
  assert.equal(await importText(kE, mid, "新负责人写.txt", "erin").then(() => "ok").catch((e: any) => e.message), "ok");
});

test("④⑤ S11A-36/37：移交后按事项重置——创建者早期写入的材料重新回到中继；负责人迟迟不登记时成员发件目录不累积重复段", { timeout: 300_000 }, async () => {
  const { matter } = await kA.inv("matters.create", { title: "移交后重置", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  const mid = matter.matter_id;
  const early = await importText(kA, mid, "创建者早期材料.txt", "创建者在第一次收到同事改动之前写的材料");
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("carol"), matter_role: "owner" });
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("bob") });
  await kA.inv("relay.sync");
  await kC.inv("relay.sync");
  await kB.inv("relay.sync");
  await importText(kB, mid, "B.txt", "B 的材料");
  await kB.inv("relay.sync");
  await kA.inv("relay.sync");
  await kC.inv("relay.sync");
  // 移交：A 把自己改为编辑（carol 已是负责人）；此后 carol 调整成员被告知“请联系中软客服办理负责人交接”
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("test-lawyer"), matter_role: "editor" });
  await kA.inv("relay.sync");
  await kC.inv("relay.sync");
  await kB.inv("relay.sync");
  const msg = await kC.inv("matters.members.add", { matter_id: mid, user_id: usr("dave") }).then(() => "ok").catch((e: any) => e.message);
  LOG("carol 加人：", msg);
  // 运营按事项重置
  const seqAtReset = Math.max(0, ...entries().map((e: any) => e.seq));
  assert.equal((await resetMatter(mid)).status, 200);
  // ⑤ 负责人 carol 暂未上线：bob 的电脑经过三次定期核对
  const outboxOf = (k: any) => scanSegments(join(k.kernel.config.workspaceDir, "relay", "outbox"), TID).candidates.filter((c: any) => c.content.includes(mid)).length;
  const counts: number[] = [];
  for (let i = 0; i < 3; i++) {
    recheckNow(kB);
    await kB.inv("relay.sync");
    counts.push(outboxOf(kB));
  }
  LOG("⑤ bob 发件目录里该事项的段数（三次核对后）：", counts);
  // ④ 负责人 carol 上线、登记；A、bob 随后重发本机写入的内容
  recheckNow(kC);
  await kC.inv("relay.sync");
  await kC.inv("relay.sync");
  LOG("重置后控制成员：", cloud.relay.server.tenant(TID)!.controller(mid));
  for (const k of [kA, kB]) {
    recheckNow(k);
    await k.inv("relay.sync");
    k.kernel.db.run(`UPDATE relay_outbox SET next_at = ?`, [new Date(Date.now() - 1000).toISOString()]);
    await k.inv("relay.sync");
    await k.inv("relay.sync");
  }
  const uri = kA.kernel.db.get(`SELECT storage_uri FROM document_versions WHERE document_version_id = ?`, [early.document_version_id]).storage_uri as string;
  const env = readFileSync(join(kA.kernel.blobs.dir, ...uri.slice("blob://".length).split("/")));
  const cids = relayChunks(env).map((c: any) => c.cid);
  const live = entries().filter((e: any) => e.mid === mid && e.seq > seqAtReset);
  const onRelay = live.some((e: any) => e.blobs.some((c: string) => cids.includes(c)));
  LOG("④ 重置后中继上该事项的登记：", live.length, "｜引用创建者早期材料的块：", onRelay);
  LOG("④ bob 发件目录剩余：", outboxOf(kB));
  LOG("④ 重置后各登记的写入设备与引用块数：", JSON.stringify(live.map((e: any) => [e.dev, e.blobs.length, e.size])));
  // 第一次核对发现重置即清掉发件目录、下一轮全量重发一份，此后不再增加
  assert.ok(Math.max(...counts) <= 1 && counts[2]! <= counts[1]!, `等待负责人期间，成员发件目录不应每次核对都多出一份重复段：${JSON.stringify(counts)}`);
  assert.ok(onRelay, "重置后创建者早期写入的材料应重新回到中继（否则之后加入的成员拿不到）");
});
