// 第 11 批第五轮复核 A 的复现转入（S11A-44）：修正前为失败，修正后为回归用例。第五轮处置：只有律所明确关闭中继才放行，策略回退时仍锁定
/**
 * 第四轮 S11A-39 的放行条件是 allowed()=false，而 allowed() 读的是“有效策略”：策略过期、收到认不出的新版本等回退到最严模板时也为 false。
 * 律所并没有关闭中继，只是 carol 的电脑离线超过策略有效期（出差、断网），本机即放行非控制成员的负责人移出成员、轮换纪元。
 * carol 回到线上、策略续上之后：她的新纪元在中继上登记不上（非控制成员不能提升纪元），控制成员 A 收不到这次移出；
 * 被移出的 bob 仍是中继上的读者，继续收到 A 此后写的内容——这正是 D-94 设锁要防的 S11B-19 情形，而 carol 本机显示已移出。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { makeKernel } = await import("./helpers.ts");
const { startCloudCp } = await import("./cloud-cp.ts");

const FIRM = "r5d-firm";
const TID = `ten_${FIRM}`;
const usr = (s: string) => `usr_${FIRM}_${s}`;
const LOG = process.env.R5A_LOG ? console.log : (..._a: unknown[]) => {};
let cloud: any;
let kA: any;
const others: any[] = [];
let kB: any;
let kC: any;

async function second(slug: string) {
  const ws = mkdtempSync(join(tmpdir(), `kwl-r5d-${slug}-`));
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
const textOf = (k: any, filename: string) =>
  k.kernel.db.get(
    `SELECT pt.content AS c FROM document_versions dv JOIN parse_versions pv ON pv.document_version_id = dv.document_version_id JOIN parse_texts pt ON pt.parse_version_id = pv.parse_version_id WHERE dv.filename = ?`,
    [filename],
  )?.c ?? null;
const publish = async (body: Record<string, unknown>) => {
  const { draft } = await kA.inv("firm_policy.create_draft", { kind: "policy", body });
  await kA.inv("firm_policy.sign", { draft_id: draft.draft_id, expected_digest: draft.digest });
  await kA.inv("firm_policy.publish", { draft_id: draft.draft_id });
  await cloud.feed.refresh();
  for (const k of [kA, kB, kC]) await k.inv("control_plane.sync");
};
const base = { max_mode: "default", auto_preauthorizations: [], fetch_allowlist_extra: [], l3a_standard_model: "deny" };

before(async () => {
  cloud = await startCloudCp({ tenant: TID });
  kA = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_RELAY_SYNC_MS: "off" }, FIRM);
  await kA.inv("control_plane.sync");
  kB = await second("bob");
  kC = await second("carol");
  for (const k of [kB, kC, kA, kB, kC]) await k.inv("control_plane.sync");
  await publish({ ...base, share_relay: "allow" });
});
after(async () => {
  for (const k of others) await k.kernel.close().catch(() => {});
  await kA.kernel.close();
  await cloud.close();
});

test("S11A-44：策略过期回退（律所并未关中继）时不放行非控制成员移出，提示先联网更新策略", { timeout: 240_000 }, async () => {
  const { matter } = await kA.inv("matters.create", { title: "策略过期伦理墙", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  const mid = matter.matter_id;
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("carol"), matter_role: "owner" });
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("bob") });
  await kA.inv("relay.sync");
  await kC.inv("relay.sync");
  await kB.inv("relay.sync");
  // 律所没有关闭中继，只是 carol 的电脑离线超过策略有效期（等价于时间流逝：把本机最后一份策略的到期时刻改到过去）
  const row = kC.kernel.db.get(`SELECT rowid AS r, doc_json FROM firm_policies ORDER BY version DESC LIMIT 1`);
  const doc = JSON.parse(row.doc_json);
  kC.kernel.db.run(`UPDATE firm_policies SET doc_json = ? WHERE rowid = ?`, [JSON.stringify({ ...doc, expires_at: new Date(Date.now() - 60_000).toISOString() }), row.r]);
  const st = await kC.inv("relay.status");
  LOG("carol 中继状态：", st.blocked);
  const r = await kC.inv("matters.members.remove", { matter_id: mid, user_id: usr("bob") }).then((x: any) => `ok 新纪元 ${x.new_epoch}`).catch((e: any) => e.message);
  LOG("策略过期期间 carol 移出 bob：", r);
  // carol 回到线上，策略续上
  kC.kernel.db.run(`UPDATE firm_policies SET doc_json = ? WHERE rowid = ?`, [row.doc_json, row.r]);
  await kC.inv("control_plane.sync");
  const cs = await kC.inv("relay.sync");
  LOG("carol 恢复后发件：", JSON.stringify(cs.push), "｜状态：", JSON.stringify(await kC.inv("relay.status")).slice(0, 400));
  const later = await kC.inv("matters.members.add", { matter_id: mid, user_id: usr("bob") }).then(() => "ok").catch((e: any) => e.message);
  LOG("恢复后 carol 再调整成员：", later);
  // 控制成员 A 继续写；被移出的 bob 收件
  await kA.inv("relay.sync");
  await importText(kA, mid, "移出后-A写.txt", "A 在 bob 被 carol 移出之后写的内容");
  await kA.inv("relay.sync");
  await kB.inv("relay.sync");
  await kB.inv("relay.sync");
  const leaked = textOf(kB, "移出后-A写.txt");
  const aMembers = kA.kernel.db.all(`SELECT user_id, removed_at IS NOT NULL AS gone FROM matter_members WHERE matter_id = ? ORDER BY user_id`, [mid]);
  LOG("A 本机成员表：", JSON.stringify(aMembers));
  LOG("被移出的 bob 读到 A 的新内容：", leaked);
  // 第五轮处置：策略回退时仍按控制成员锁定（只有律所明确关闭中继才放行），本机与中继上的成员一致
  assert.match(r, /律所策略已过期或尚未收到/);
  assert.equal(kC.kernel.db.get(`SELECT removed_at FROM matter_members WHERE matter_id = ? AND user_id = ?`, [mid, usr("bob")]).removed_at, null);
  void leaked;
});
