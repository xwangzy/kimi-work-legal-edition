const FIRM = "r7a-stk";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
const { makeKernel } = await import("./helpers.ts");

const LOG = process.env.R7A_LOG ? console.log : (..._a: unknown[]) => {};
const others: any[] = [];
let kA: any;
const usr = (s: string) => `usr_${FIRM}_${s}`;
const dev = (s: string) => `dev_${FIRM}_${s}`;
async function second(slug: string) {
  const ws = mkdtempSync(join(tmpdir(), `kwl-r7a-${slug}-`));
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
const fresh = (p: string) => mkdtempSync(join(tmpdir(), `kwl-r7a-${p}-`));
const alerts = async (k: any) => ((await k.inv("relay.status")).alerts ?? []) as any[];
const learnRevoked = (k: any, d: string) => {
  const tid = k.kernel.db.get(`SELECT tenant_id FROM devices WHERE device_id = ?`, [d])?.tenant_id;
  k.kernel.db.run(`INSERT OR IGNORE INTO cp_revoked_devices (tenant_id, device_id, revoked_at, source) VALUES (?,?,?,?)`, [tid, d, new Date().toISOString(), "r7a-directory"]);
  k.kernel.db.run(`UPDATE devices SET status = 'revoked', revoked_at = ? WHERE device_id = ?`, [new Date().toISOString(), d]);
};
void randomBytes; void learnRevoked; void epochs; void members;
/**
 * 复核 A 第七轮 · S11A-55：owner_unverifiable 的触发条件比登记的“交接时离线”宽，而且永不解除。
 * 没有交接：carol 早就是共同负责人、dave 也早就认得她。A 加了 frank，随后 A 的电脑被吊销（离所或换机）。
 * dave 那天没开机；回来后先收到编辑 erin 的段（每段都附带全部成员行，转发了 A 写的“frank 加入”），
 * 转发者 erin 不是负责人 → 记 owner_unverifiable、dave 暂停发出该事项。之后负责人 carol 的段把同一行送到、dave 收下，
 * dave 的成员表与 carol 完全一致——但告警仍在、暂停永久（只在事项删除后清除），界面说“交接负责人时这台电脑离线……认不出新负责人”。
 */
let kC: any, kD: any, kE: any;
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

test("S11A-55：没有交接、负责人可确认时，非负责人先转发不触发“负责人无法确认”，不暂停发出", { timeout: 120_000 }, async () => {
  const { matter } = await kA.inv("matters.create", { title: "换机不交接", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  const mid = matter.matter_id;
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("carol"), matter_role: "owner" });
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("dave") });
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("erin") });
  await importText(kA, mid, "甲.txt", "甲（A 写）");
  const s0 = fresh("s0");
  await kA.inv("sync.export", { share_dir: s0, matter_id: mid });
  for (const k of [kC, kD, kE]) await k.inv("sync.import", { share_dir: s0 });
  LOG("① dave 成员表（已认得 carol 是负责人）：", JSON.stringify(members(kD, mid)));
  // A 加 frank（dave 这天没开机）；carol、erin 收到
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("frank") });
  const s1 = fresh("s1");
  await kA.inv("sync.export", { share_dir: s1, matter_id: mid });
  await kC.inv("sync.import", { share_dir: s1 });
  await kE.inv("sync.import", { share_dir: s1 });
  // A 的电脑被吊销（离所或换机），各设备得知
  for (const k of [kC, kD, kE]) learnRevoked(k, dev("test-lawyer"));
  // erin 正常工作，定时导出（附带全部成员行）
  await importText(kE, mid, "乙.txt", "erin 写的");
  const sE = fresh("sE");
  await kE.inv("sync.export", { share_dir: sE, matter_id: mid });
  // carol 也正常导出
  await importText(kC, mid, "丙.txt", "carol 写的");
  const sC = fresh("sC");
  await kC.inv("sync.export", { share_dir: sC, matter_id: mid });
  // dave 开机：先同步到 erin 的段，再到 carol 的段
  const r1 = await kD.inv("sync.import", { share_dir: sE });
  LOG("② dave 摄取 erin 的段：", JSON.stringify(r1.dispositions.map((x: any) => x.outcome)), JSON.stringify(r1.originConflicts).slice(0, 300));
  LOG("   dave 告警：", JSON.stringify((await alerts(kD)).map((a) => [a.kind, a.epoch, a.hits])));
  const r2 = await kD.inv("sync.import", { share_dir: sC });
  LOG("③ dave 摄取 carol 的段：", JSON.stringify(r2.dispositions.map((x: any) => x.outcome)), JSON.stringify(r2.originConflicts).slice(0, 300));
  const mD = members(kD, mid);
  const mC = members(kC, mid);
  LOG("   dave 成员表：", JSON.stringify(mD));
  LOG("   carol 成员表：", JSON.stringify(mC));
  LOG("   dave 读到 carol 的丙：", textOf(kD, "丙.txt"));
  assert.deepEqual(mD, mC, "前提：dave 已从负责人 carol 处收下同一行，与负责人一致");
  // 再过几轮
  for (let i = 0; i < 3; i++) {
    await kD.inv("sync.import", { share_dir: sC });
    await kD.inv("sync.import", { share_dir: sE });
  }
  // carol 之后正常移出 erin（纪元 2），dave 收到
  await kC.inv("matters.members.remove", { matter_id: mid, user_id: usr("erin") });
  const sC2 = fresh("sC2");
  await kC.inv("sync.export", { share_dir: sC2, matter_id: mid });
  await kD.inv("sync.import", { share_dir: sC2 });
  LOG("④ carol 移出 erin 后 dave 纪元：", JSON.stringify(epochs(kD, mid, dev("dave"))));
  const st = await kD.inv("relay.status");
  await importText(kD, mid, "丁.txt", "dave 写的");
  const ex = await kD.inv("sync.export", { share_dir: fresh("sD"), matter_id: mid });
  LOG("⑤ dave 告警：", JSON.stringify((st.alerts ?? []).map((a: any) => [a.kind, a.epoch, a.hits, a.title])), "｜dave 导出段数", ex.segments.length, "暂停", JSON.stringify(ex.pausedConflict));
  assert.equal(ex.segments.length, 1, "负责人可确认、成员表与负责人一致时，不应永久暂停该设备发出");
});
