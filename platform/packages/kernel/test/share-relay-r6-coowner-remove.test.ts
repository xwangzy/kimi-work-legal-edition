// 第 11 批第六轮复核 A 的复现转入（修正前为失败，修正后为回归用例；残余项改为断言告警可见、不外泄）。原注：复核 A 第六轮 · 复现 S11A-49（共享文件夹介质，未改过的客户端，没有攻击者；既有问题，非第五轮引入）
/**
 * 成员行“较新者胜”比的是 row_lamport，而 row_lamport 取自本机 signed_events 的最大 lamport + 1（api nextLocalLamport），
 * 各设备的 signed_events 只有本机签的事件，摄取不合并对端的序号——这不是 Lamport 时钟，跨设备不可比。
 * 共同负责人 carol 本机事件少，她“移出 erin”那一行的 row_lamport 比创建者 A 当初“加入 erin”那一行还小，
 * 在 A 与其他成员设备上一律“不比本机新”被静默跳过（第四轮起连告警都没有）。只有她的新纪元包裹传了出去。
 * 此后 A 任何一次正常轮换（移出另一人、恢复即轮换）都按 A 本机名单把新纪元包给 erin：被移出的 erin 读到之后的新内容。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { makeKernel } = await import("./helpers.ts");

const FIRM = "r6b-firm";
const usr = (s: string) => `usr_${FIRM}_${s}`;
const dev = (s: string) => `dev_${FIRM}_${s}`;
const LOG = process.env.R6A_LOG ? console.log : (..._a: unknown[]) => {};
let kA: any;
let kC: any;
let kD: any;
let kE: any;
const others: any[] = [];

async function second(slug: string) {
  const ws = mkdtempSync(join(tmpdir(), `kwl-r6b-${slug}-`));
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
const rowsOf = (k: any, mid: string) =>
  k.kernel.db.all(`SELECT replace(user_id, 'usr_${FIRM}_', '') AS u, matter_role AS r, removed_at IS NOT NULL AS gone, replace(author_device, 'dev_${FIRM}_', '') AS a, row_lamport AS l FROM matter_members WHERE matter_id = ? ORDER BY user_id`, [mid]);
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

test("S11A-49：成员行序号是按事项合并的逻辑时钟，共同负责人的移出在其他设备上生效，创建者下次轮换不再包给被移出者", { timeout: 120_000 }, async () => {
  const { matter } = await kA.inv("matters.create", { title: "共同负责人移出丢失", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  const mid = matter.matter_id;
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("carol"), matter_role: "owner" });
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("dave") });
  await importText(kA, mid, "甲.txt", "甲（A 写）");
  await importText(kA, mid, "甲2.txt", "甲2（A 写）");
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("erin") });
  const share = mkdtempSync(join(tmpdir(), "kwl-r6b-share-"));
  await kA.inv("sync.export", { share_dir: share, matter_id: mid });
  for (const k of [kC, kD, kE]) await k.inv("sync.import", { share_dir: share });
  // 共同负责人 carol 对 erin 做伦理墙
  const rm = await kC.inv("matters.members.remove", { matter_id: mid, user_id: usr("erin") });
  LOG("carol 移出 erin：新纪元", rm.new_epoch);
  LOG("carol 本机成员行：", JSON.stringify(rowsOf(kC, mid)));
  await kC.inv("sync.export", { share_dir: share, matter_id: mid });
  const ra = await kA.inv("sync.import", { share_dir: share });
  const rd = await kD.inv("sync.import", { share_dir: share });
  LOG("A 摄取：", JSON.stringify(ra.dispositions?.map((x: any) => x.outcome)), "告警：", JSON.stringify(ra.originConflicts ?? []).slice(0, 300));
  LOG("A 本机成员行：", JSON.stringify(rowsOf(kA, mid)));
  LOG("dave 本机成员行：", JSON.stringify(rowsOf(kD, mid)));
  // A 之后正常地移出 dave（或恢复即轮换）：按本机名单轮换
  const rm2 = await kA.inv("matters.members.remove", { matter_id: mid, user_id: usr("dave") });
  LOG("A 移出 dave：新纪元", rm2.new_epoch, "包裹设备数", rm2.devices_wrapped);
  await importText(kA, mid, "乙.txt", "A 在 erin 被 carol 移出之后写的保密内容");
  await kA.inv("sync.export", { share_dir: share, matter_id: mid });
  const re = await kE.inv("sync.import", { share_dir: share });
  LOG("erin 摄取：", JSON.stringify(re.dispositions?.map((x: any) => x.outcome)));
  const leaked = textOf(kE, "乙.txt");
  LOG("被移出的 erin 读到：", leaked);
  assert.equal(rowsOf(kA, mid).find((m: any) => m.u === "erin")?.gone, 1, "A 本机应已知 erin 被移出");
  assert.equal(leaked, null, "被移出的成员不应读到移出之后写的内容");
});
