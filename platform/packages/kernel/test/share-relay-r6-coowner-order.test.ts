// 第 11 批第六轮复核 A 的复现转入（修正前为失败，修正后为回归用例；残余项改为断言告警可见、不外泄）。原注：复核 A 第六轮 · 复现 S11A-48（共享文件夹介质，未改过的客户端，没有攻击者）
/**
 * 第五轮 S11A-43 处置：已有事项按“本段之前”本机认得的负责人判断成员变更与包裹。
 * 共享文件夹按段头 from_lamport 排序摄取；from_lamport 是“签发设备上一次导出水位 + 1”，不是事件时刻。
 * 新任共同负责人 carol 第一次导出时 from_lamport = 1，排在 A 把她加为负责人的那一段（from_lamport 较大）之前。
 * 滞后设备 dave 一次摄取两段时：carol 的段在前，carol 不在“段前负责人”里——她移出 erin 的那一行被拒、她的纪元 2 包裹不落库，
 * 而这一段仍记为 applied / 已见过，之后不再重试。dave 此后写的内容仍用纪元 1 加密，被移出的 erin 能读。
 * 第五轮之前（80b3535）同段转发来的“carol 是负责人”在段内即生效，同一用例通过。
 * 80b3535：dave 持 [1,2]，erin 读不到（通过）；72090dc：dave 只持 [1]，erin 读到（失败）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { makeKernel } = await import("./helpers.ts");

const FIRM = "r6a-firm";
const usr = (s: string) => `usr_${FIRM}_${s}`;
const dev = (s: string) => `dev_${FIRM}_${s}`;
const LOG = process.env.R6A_LOG ? console.log : (..._a: unknown[]) => {};
let kA: any;
let kC: any;
let kD: any;
let kE: any;
const others: any[] = [];

async function second(slug: string) {
  const ws = mkdtempSync(join(tmpdir(), `kwl-r6a-${slug}-`));
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

test("S11A-48：新任共同负责人第一次导出的段排在“加她为负责人”的段之前，滞后设备照样收下她的移出与新纪元", { timeout: 120_000 }, async () => {
  const { matter } = await kA.inv("matters.create", { title: "共同负责人移出", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  const mid = matter.matter_id;
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("dave") });
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("erin") });
  await importText(kA, mid, "甲.txt", "甲（A 写）");
  const share = mkdtempSync(join(tmpdir(), "kwl-r6a-share-"));
  await kA.inv("sync.export", { share_dir: share, matter_id: mid });
  await kD.inv("sync.import", { share_dir: share });
  await kE.inv("sync.import", { share_dir: share });
  // A 把 carol 加为共同负责人（dave 这几天没开机）
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("carol"), matter_role: "owner" });
  await kA.inv("sync.export", { share_dir: share, matter_id: mid });
  await kC.inv("sync.import", { share_dir: share });
  // carol 正常地对 erin 做伦理墙：移出（轮换到纪元 2），第一次导出
  const rm = await kC.inv("matters.members.remove", { matter_id: mid, user_id: usr("erin") });
  LOG("carol 移出 erin：新纪元", rm.new_epoch);
  const ex = await kC.inv("sync.export", { share_dir: share, matter_id: mid });
  LOG("carol 的段 from_lamport：", JSON.stringify(ex.segments?.map?.((s: any) => s.from_lamport ?? s) ?? ex).slice(0, 300));
  // dave 开机，一次摄取
  const r = await kD.inv("sync.import", { share_dir: share });
  LOG("dave 摄取：", JSON.stringify(r.dispositions?.map((x: any) => [x.path.split("/").slice(-2).join("/").slice(0, 40), x.outcome])));
  LOG("dave 告警：", JSON.stringify(r.originConflicts).slice(0, 600));
  LOG("dave 成员表：", JSON.stringify(members(kD, mid)));
  LOG("dave 持有的纪元：", JSON.stringify(epochs(kD, mid, dev("dave"))));
  // dave 此后写入、导出；被移出的 erin 摄取
  await importText(kD, mid, "丁-移出后.txt", "dave 在 erin 被移出之后写的保密内容");
  await kD.inv("sync.export", { share_dir: share, matter_id: mid });
  const re = await kE.inv("sync.import", { share_dir: share });
  LOG("erin 摄取：", JSON.stringify(re.dispositions?.map((x: any) => x.outcome)));
  const leaked = textOf(kE, "丁-移出后.txt");
  LOG("被移出的 erin 读到：", leaked);
  // 再摄取一次也补不回来（carol 的段已记为见过）
  const r2 = await kD.inv("sync.import", { share_dir: share });
  LOG("dave 再摄取：", JSON.stringify(r2.dispositions?.map((x: any) => x.outcome)), "成员表：", JSON.stringify(members(kD, mid)));
  // 注：erin 在 dave 上是否显示为已移出另受 S11A-49（row_lamport 跨设备不可比）影响，这里不断言；只断言新纪元与机密性
  assert.deepEqual(epochs(kD, mid, dev("dave")), [1, 2], "滞后设备应收下共同负责人移出时轮换出的纪元 2");
  assert.equal(leaked, null, "被移出的成员不应读到移出之后其他成员写的内容");
});
