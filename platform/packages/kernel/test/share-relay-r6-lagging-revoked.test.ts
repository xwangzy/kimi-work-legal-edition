// 第 11 批第六轮复核 A 的复现转入（第 11 批为残余、断言告警可见；第 12 批成员链解决，改为断言认出新负责人）。原注：复核 A 第六轮 · 复现 S11A-52（共享文件夹介质，未改过的客户端，没有攻击者）
/**
 * 第五轮 S11A-42 处置只覆盖“首同步”：已有事项的滞后设备，转发者须在“段前负责人”里才收吊销作者写的行。
 * 创建者 A 把 carol 升为负责人（交接），随即 A 的电脑被吊销（离所）。成员 dave 那几天没开机：
 * 回来后 A 的段因签发设备被吊销整段拒收；carol 的段里“carol 是负责人”由 A 写、A 已吊销、carol 不在 dave 的段前负责人里 → 拒收。
 * dave 的段前负责人只有 A（已吊销，再也发不出段），所以 carol 在 dave 上永远成不了负责人：她的成员变更与新纪元包裹永远不落库。
 * carol 移出 erin 之后，dave 写的内容仍用纪元 1，被移出的 erin 读得到；carol 的新内容 dave 永远读不了。中继介质（D-94 的交接出路：重置后由 carol 先登记）同理。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { makeKernel } = await import("./helpers.ts");

const FIRM = "r6c-firm";
const usr = (s: string) => `usr_${FIRM}_${s}`;
const dev = (s: string) => `dev_${FIRM}_${s}`;
const LOG = process.env.R6A_LOG ? console.log : (..._a: unknown[]) => {};
let kA: any;
let kC: any;
let kD: any;
let kE: any;
const others: any[] = [];

async function second(slug: string) {
  const ws = mkdtempSync(join(tmpdir(), `kwl-r6c-${slug}-`));
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
const members = (k: any, mid: string) => k.kernel.db.all(`SELECT user_id, matter_role, removed_at IS NOT NULL AS gone FROM matter_members WHERE matter_id = ? ORDER BY user_id`, [mid]);
const epochs = (k: any, mid: string, d: string) => k.kernel.db.all(`SELECT epoch FROM matter_keys WHERE matter_id = ? AND wrapped_for = ? ORDER BY epoch`, [mid, d]).map((x: any) => x.epoch);
const textOf = (k: any, filename: string) =>
  k.kernel.db.get(
    `SELECT pt.content AS c FROM document_versions dv JOIN parse_versions pv ON pv.document_version_id = dv.document_version_id JOIN parse_texts pt ON pt.parse_version_id = pv.parse_version_id WHERE dv.filename = ?`,
    [filename],
  )?.c ?? null;

before(async () => {
  kA = await makeKernel({ ZR_MODEL_PROVIDER: "upstream" }, FIRM);
  kC = await second("carol");
  kD = await second("dave");
  kE = await second("erin");
  const all = [kA, kC, kD, kE];
  for (const [k, s] of [[kA, "test-lawyer"], [kC, "carol"], [kD, "dave"], [kE, "erin"]] as const) copyDev(k, dev(s), all.filter((x) => x !== k));
});
after(async () => {
  for (const k of others) await k.kernel.close().catch(() => {});
  await kA.kernel.close();
});

const learnRevoked = (k: any, d: string) => {
  const tid = k.kernel.db.get(`SELECT tenant_id FROM devices WHERE device_id = ?`, [d])?.tenant_id;
  k.kernel.db.run(`INSERT OR IGNORE INTO cp_revoked_devices (tenant_id, device_id, revoked_at, source) VALUES (?,?,?,?)`, [tid, d, new Date().toISOString(), "r6a-directory"]);
  k.kernel.db.run(`UPDATE devices SET status = 'revoked', revoked_at = ? WHERE device_id = ?`, [new Date().toISOString(), d]);
};

test("S11A-52（第 12 批解决）：交接后创建者设备被吊销，当时离线的成员设备按成员链认出新负责人，被移出者读不到该设备之后写的内容", { timeout: 120_000 }, async () => {
  const { matter } = await kA.inv("matters.create", { title: "交接时离线", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  const mid = matter.matter_id;
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("dave") });
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("erin") });
  await importText(kA, mid, "甲.txt", "甲（A 写）");
  const share = mkdtempSync(join(tmpdir(), "kwl-r6c-share-"));
  await kA.inv("sync.export", { share_dir: share, matter_id: mid });
  await kD.inv("sync.import", { share_dir: share });
  await kE.inv("sync.import", { share_dir: share });
  // 交接：A 把 carol 升为负责人（dave 这几天没开机）
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("carol"), matter_role: "owner" });
  await kA.inv("sync.export", { share_dir: share, matter_id: mid });
  await kC.inv("sync.import", { share_dir: share });
  // A 离所，设备被吊销；各设备从控制面目录得知
  for (const k of [kC, kD, kE]) learnRevoked(k, dev("test-lawyer"));
  // carol 正常地移出 erin（轮换到纪元 2），导出两次（第二次带一份新材料，排除“只差一段”）
  const rm = await kC.inv("matters.members.remove", { matter_id: mid, user_id: usr("erin") });
  LOG("carol 移出 erin：新纪元", rm.new_epoch);
  await kC.inv("sync.export", { share_dir: share, matter_id: mid });
  await importText(kC, mid, "丙.txt", "carol 移出 erin 之后写的内容");
  await kC.inv("sync.export", { share_dir: share, matter_id: mid });
  const r = await kD.inv("sync.import", { share_dir: share });
  LOG("dave 摄取：", JSON.stringify(r.dispositions?.map((x: any) => x.outcome)));
  LOG("dave 告警：", JSON.stringify(r.originConflicts).slice(0, 500));
  const r2 = await kD.inv("sync.import", { share_dir: share });
  LOG("dave 再摄取：", JSON.stringify(r2.dispositions?.map((x: any) => x.outcome)));
  LOG("dave 成员表：", JSON.stringify(members(kD, mid)));
  LOG("dave 持有的纪元：", JSON.stringify(epochs(kD, mid, dev("dave"))), "｜dave 读到 carol 的丙：", textOf(kD, "丙.txt"));
  await importText(kD, mid, "丁-移出后.txt", "dave 在 erin 被移出之后写的保密内容");
  await kD.inv("sync.export", { share_dir: share, matter_id: mid });
  await kE.inv("sync.import", { share_dir: share });
  const leaked = textOf(kE, "丁-移出后.txt");
  LOG("被移出的 erin 读到：", leaked);
  // 第 12 批（成员链）：carol 得知 A 被吊销后先写吊销标记，把 A 在吊销之前写的事件（含“carol 是负责人”）固定在链上；
  // dave 按链认出 carol、收下纪元 2、读到 carol 的新内容，没有告警；被移出的 erin 读不到 dave 之后写的内容，carol 读得到
  const st = await kD.inv("relay.status");
  assert.deepEqual((st.alerts ?? []).filter((a: any) => a.matter_id === mid), [], "没有告警");
  assert.ok(members(kD, mid).some((m: any) => m.user_id === usr("carol") && m.matter_role === "owner" && !m.gone), "dave 认出新负责人 carol");
  assert.equal(textOf(kD, "丙.txt"), "carol 移出 erin 之后写的内容", "dave 读到 carol 移出 erin 之后写的内容");
  assert.ok(kC.kernel.db.get(`SELECT 1 AS x FROM member_events WHERE matter_id = ? AND kind = 'mark'`, [mid]), "carol 写了吊销标记");
  assert.equal(leaked, null, "被移出的成员不应读到移出之后其他成员写的内容");
  await kC.inv("sync.import", { share_dir: share });
  assert.equal(textOf(kC, "丁-移出后.txt"), "dave 在 erin 被移出之后写的保密内容", "新负责人读到 dave 之后写的内容");
});
