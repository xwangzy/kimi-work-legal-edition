// 第 11 批第五轮复核 A 的复现转入（S11A-42）：修正前为失败，修正后为回归用例。第五轮处置：被吊销设备吊销前写的成员行，转发者可信（本段之前本机认得的负责人、或首同步的签发者）时凭签名收下
/**
 * 成员行逐行带作者签名后，转发的行要求“作者设备未被吊销”。创建者 A 的设备被吊销（离所、换机）以后，
 * A 写过的全部成员行（包括 A 自己的负责人行、A 加入 carol 为负责人的那一行）在任何新设备上都被拒收：
 * carol 是负责人这件事无从核验，carol 签发的段在首同步闸门处整段延后——此后加入的成员、carol 自己的新设备都永远引导不了。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { makeKernel } = await import("./helpers.ts");

const FIRM = "r5a-firm";
const usr = (s: string) => `usr_${FIRM}_${s}`;
const dev = (s: string) => `dev_${FIRM}_${s}`;
const LOG = process.env.R5A_LOG ? console.log : (..._a: unknown[]) => {};
let kA: any;
let kB: any;
let kC: any;
let kD: any;
let kE: any;
const others: any[] = [];

async function second(slug: string) {
  const ws = mkdtempSync(join(tmpdir(), `kwl-r5a-${slug}-`));
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
const members = (k: any, mid: string) => k.kernel.db.all(`SELECT user_id, matter_role, author_device FROM matter_members WHERE matter_id = ? ORDER BY user_id`, [mid]);
const docs = async (k: any, mid: string): Promise<string[] | string> =>
  k.inv("matters.get", { matter_id: mid }).then((x: any) => x.documents.map((d: any) => d.filename).sort()).catch((e: any) => `打不开：${e.message}`);
/** 控制面设备目录把该设备列为吊销后，各设备记下的吊销墓碑与设备状态（与 governance.tombstone + 目录应用的结果相同）。 */
const learnRevoked = (k: any, d: string) => {
  const tid = k.kernel.db.get(`SELECT tenant_id FROM devices WHERE device_id = ?`, [d])?.tenant_id;
  k.kernel.db.run(`INSERT OR IGNORE INTO cp_revoked_devices (tenant_id, device_id, revoked_at, source) VALUES (?,?,?,?)`, [tid, d, new Date().toISOString(), "r5a-directory"]);
  k.kernel.db.run(`UPDATE devices SET status = 'revoked', revoked_at = ? WHERE device_id = ?`, [new Date().toISOString(), d]);
};

before(async () => {
  kA = await makeKernel({ ZR_MODEL_PROVIDER: "upstream" }, FIRM);
  kB = await second("bob");
  kC = await second("carol");
  kD = await second("dave");
  kE = await second("erin");
  const all = [kA, kB, kC, kD, kE];
  for (const [k, s] of [[kA, "test-lawyer"], [kB, "bob"], [kC, "carol"], [kD, "dave"], [kE, "erin"]] as const) copyDev(k, dev(s), all.filter((x) => x !== k));
});
after(async () => {
  for (const k of others) await k.kernel.close().catch(() => {});
  await kA.kernel.close();
});

test("S11A-42：创建者设备被吊销（离所交接）后，接手的负责人加入的成员能引导", { timeout: 120_000 }, async () => {
  const { matter } = await kA.inv("matters.create", { title: "创建者离所", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  const mid = matter.matter_id;
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("carol"), matter_role: "owner" });
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("bob") });
  await importText(kA, mid, "甲.txt", "甲（创建者写）");
  const share = mkdtempSync(join(tmpdir(), "kwl-r5a-share-"));
  await kA.inv("sync.export", { share_dir: share, matter_id: mid });
  await kC.inv("sync.import", { share_dir: share });
  // 对照：吊销之前，carol 加入的 erin 能引导
  await kC.inv("matters.members.add", { matter_id: mid, user_id: usr("erin") });
  await kC.inv("sync.export", { share_dir: share, matter_id: mid });
  await kE.inv("sync.import", { share_dir: share });
  const erinBefore = await docs(kE, mid);
  LOG("成员行签名与证书的长度（字节）：", JSON.stringify(kC.kernel.db.all(`SELECT user_id, length(author_sig) AS sig, length(author_cert) AS cert FROM matter_members WHERE matter_id = ?`, [mid])));
  LOG("对照（吊销前加入的 erin）：", JSON.stringify(erinBefore));

  // 创建者 A 离所：管理员吊销 A 的设备，各设备从控制面目录得知
  for (const k of [kB, kC, kD, kE]) learnRevoked(k, dev("test-lawyer"));
  // 接手的负责人 carol 移出离所的 A? 不能移出负责人；carol 照常加入新成员 dave、写材料、发出
  await kC.inv("matters.members.add", { matter_id: mid, user_id: usr("dave") });
  await importText(kC, mid, "乙.txt", "乙（carol 写）");
  const share2 = mkdtempSync(join(tmpdir(), "kwl-r5a-share2-"));
  await kC.inv("sync.export", { share_dir: share2, matter_id: mid });
  // 中继/共享文件夹上 carol 最新一段带着全部成员行（A 写的那几行带 A 的签名与证书）
  const r1 = await kD.inv("sync.import", { share_dir: share2 });
  const r2 = await kD.inv("sync.import", { share_dir: share2 });
  LOG("dave 摄取：", JSON.stringify(r1.dispositions.map((x: any) => x.outcome)), JSON.stringify(r2.dispositions.map((x: any) => x.outcome)));
  LOG("dave 告警：", JSON.stringify(r1.origin_conflicts ?? r1.originConflicts ?? []).slice(0, 900));
  LOG("dave 成员表：", JSON.stringify(members(kD, mid)));
  const daveDocs = await docs(kD, mid);
  LOG("dave 打开事项：", JSON.stringify(daveDocs));
  assert.ok(Array.isArray(erinBefore), "对照：吊销前加入的成员能引导");
  assert.ok(Array.isArray(daveDocs), "接手负责人加入的新成员应能打开事项");
});
