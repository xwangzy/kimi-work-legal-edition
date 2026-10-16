// 第 11 批第四轮复核 A 的复现转入（S11A-35①、S11A-40，共享文件夹介质）：修正前为失败，修正后为回归用例
/**
 * 首次引导闸门按段内成员行的“内容”判定签发者是负责人（ownerHere），而成员行能否落库另要求“作者设备 = 段签名设备”。
 * 签发者自己的负责人行若不是它自己写的（共同负责人由创建者加入、负责人由前任移交、负责人换了设备），
 * 闸门放行、事项行落库，但负责人一行被拒；包裹因“签发者不是本机在册负责人”不落库。迟到成员此后再也引导不了（事项已在本机），
 * 后续任何负责人的成员行、包裹也都被拒——第二轮 S11A-18 的结果在共同负责人路径上复现（c4f0225 的“来源设备”例外原本覆盖了它）。
 * 第四轮处置：成员行逐行带作者签名，转发的行可核验；按因果顺序整批处理；首同步闸门按能落库的行判。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { makeKernel } = await import("./helpers.ts");

const FIRM = "r4a-firm";
const usr = (s: string) => `usr_${FIRM}_${s}`;
const dev = (s: string) => `dev_${FIRM}_${s}`;
let kA: any;
const others: any[] = [];
let kB: any;
let kC: any;
let kD: any;
const LOG = process.env.R4A_LOG ? console.log : (..._a: unknown[]) => {};

async function second(slug: string) {
  const ws = mkdtempSync(join(tmpdir(), `kwl-r4a-${slug}-`));
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
const wraps = (k: any, mid: string, d: string) => k.kernel.db.all(`SELECT epoch FROM matter_keys WHERE matter_id = ? AND wrapped_for = ?`, [mid, d]);

before(async () => {
  kA = await makeKernel({ ZR_MODEL_PROVIDER: "upstream" }, FIRM);
  kB = await second("bob");
  kC = await second("carol");
  kD = await second("dave");
  const all = [kA, kB, kC, kD];
  for (const [k, s] of [[kA, "test-lawyer"], [kB, "bob"], [kC, "carol"], [kD, "dave"]] as const) copyDev(k, dev(s), all.filter((x) => x !== k));
});
after(async () => {
  for (const k of others) await k.kernel.close().catch(() => {});
  await kA.kernel.close();
});

test("S11A-35 ①：共同负责人加入的迟到成员认出负责人、收下包裹、能读写", { timeout: 120_000 }, async () => {
  const { matter } = await kA.inv("matters.create", { title: "共同负责人加人", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  const mid = matter.matter_id;
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("carol"), matter_role: "owner" });
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("bob") });
  await importText(kA, mid, "甲.txt", "甲");
  const share = mkdtempSync(join(tmpdir(), "kwl-r4a-share-"));
  await kA.inv("sync.export", { share_dir: share, matter_id: mid });
  await kC.inv("sync.import", { share_dir: share });
  // 共同负责人 carol 加入 dave 并写入一份材料、发出
  await kC.inv("matters.members.add", { matter_id: mid, user_id: usr("dave") });
  await importText(kC, mid, "乙.txt", "乙（carol 写）");
  await kC.inv("sync.export", { share_dir: share, matter_id: mid });
  const r1 = await kD.inv("sync.import", { share_dir: share });
  LOG("D 摄取：", JSON.stringify(r1.dispositions.map((x: any) => [x.segment_id.slice(0, 34), x.outcome])));
  LOG("D 告警：", JSON.stringify(r1.origin_conflicts ?? r1.originConflicts ?? []).slice(0, 800));
  LOG("D 成员表：", JSON.stringify(members(kD, mid)));
  LOG("D 包裹：", JSON.stringify(wraps(kD, mid, dev("dave"))));
  // A 收到 carol 的段后再发一次（A 本机已有 dave 的包裹）；D 再收
  await kA.inv("sync.import", { share_dir: share });
  await importText(kA, mid, "丙.txt", "丙（A 写）");
  await kA.inv("sync.export", { share_dir: share, matter_id: mid });
  const r2 = await kD.inv("sync.import", { share_dir: share });
  LOG("D 第二次摄取：", JSON.stringify(r2.dispositions.map((x: any) => [x.segment_id.slice(0, 34), x.outcome])));
  LOG("D 成员表：", JSON.stringify(members(kD, mid)));
  LOG("D 包裹：", JSON.stringify(wraps(kD, mid, dev("dave"))));
  const got = await kD.inv("matters.get", { matter_id: mid }).then((x: any) => x.documents.map((d: any) => d.filename)).catch((e: any) => `打不开：${e.message}`);
  LOG("D 打开事项：", got);
  const write = await importText(kD, mid, "丁.txt", "dave 写").then(() => "ok").catch((e: any) => `写不了：${e.message}`);
  LOG("D 写入：", write);
  assert.ok(wraps(kD, mid, dev("dave")).length > 0, "迟到成员应持有面向自己的包裹");
  assert.equal(write, "ok", "迟到成员应能写入");
});

test("S11A-40：非负责人成员的段转发的成员行不在接收方产生 member_row_rejected 告警", { timeout: 120_000 }, async () => {
  const { matter } = await kA.inv("matters.create", { title: "告警噪声", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  const mid = matter.matter_id;
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("bob") });
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("carol") });
  const share = mkdtempSync(join(tmpdir(), "kwl-r4a-noise-"));
  await kA.inv("sync.export", { share_dir: share, matter_id: mid });
  await kB.inv("sync.import", { share_dir: share });
  const counts: number[] = [];
  for (let i = 0; i < 2; i++) {
    await importText(kB, mid, `B${i}.txt`, `B 的第 ${i} 份`);
    await kB.inv("sync.export", { share_dir: share, matter_id: mid });
    const r = await kA.inv("sync.import", { share_dir: share });
    const w = (r.origin_conflicts ?? r.originConflicts ?? []) as string[];
    counts.push(w.filter((x) => x.startsWith("member_row_rejected")).length);
  }
  const st = kA.kernel.db.get(`SELECT last_import_origin_conflicts AS n FROM sync_state WHERE matter_id = ?`, [mid]);
  LOG("A 每次摄取 B 的普通段产生的 member_row_rejected：", counts, "｜sync_state.last_import_origin_conflicts：", st?.n);
  assert.deepEqual(counts, [0, 0], "成员 B 只是写材料，不应每段都触发“借名伪造拒收”告警");
});
