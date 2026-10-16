const FIRM = "r7a-dos";
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
 * 复核 A 第七轮 · S11A-56：任何在册成员（含只读成员）用自己的设备密钥签一段“当前纪元、段体用随机密钥加密”的段放进共享文件夹，
 * 持有该纪元的全部成员设备（含负责人）都记 epoch_conflict、暂停发出该事项；段不记为见过，每次摄取计数加一。
 * 界面只显示事项与种类，看不出是谁签的段，负责人无从判断该移出谁；在册成员可在每次轮换后重复。
 */
const { sealSegment, writeSegment } = await import("@zr-legal/sync");
const { SoftwareSigner } = await import("@zr-legal/keys");
const { getDeviceKeys, keysDirOf } = await import("../src/devices.ts");
let kD: any, kE: any;
before(async () => {
  kA = await makeKernel({ ZR_MODEL_PROVIDER: "upstream" }, FIRM);
  kD = await second("dave");
  kE = await second("erin");
  const all = [kA, kD, kE];
  for (const [k, s] of [[kA, "test-lawyer"], [kD, "dave"], [kE, "erin"]] as const) copyDev(k, dev(s), all.filter((x) => x !== k));
});
after(async () => {
  for (const k of others) await k.kernel.close().catch(() => {});
  await kA.kernel.close();
});

test("S11A-56：在册只读成员伪造一段解不开的段，不会让负责人与其他成员设备暂停发出", { timeout: 120_000 }, async () => {
  const { matter } = await kA.inv("matters.create", { title: "伪造冲突", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  const mid = matter.matter_id;
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("dave") });
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("erin"), matter_role: "viewer" });
  await importText(kA, mid, "甲.txt", "甲（A 写）");
  const share = fresh("share");
  await kA.inv("sync.export", { share_dir: share, matter_id: mid });
  await kD.inv("sync.import", { share_dir: share });
  await kE.inv("sync.import", { share_dir: share });
  const tid = kA.kernel.db.get(`SELECT tenant_id FROM matters WHERE matter_id = ?`, [mid]).tenant_id;
  // erin（只读成员）伪造：自己的设备签名、当前纪元 1、段体用随机密钥加密
  const eKeys = getDeviceKeys(keysDirOf(kE.kernel.config.workspaceDir));
  const sid = `seg_${dev("erin")}_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
  const sealed = sealSegment({
    header: { segment_id: sid, device_id: dev("erin"), matter_id: mid, from_lamport: 1, to_lamport: 1, key_epoch: 1, event_count: 0, created_at: new Date().toISOString(), device_cert_json: kE.kernel.db.get(`SELECT cert_json FROM devices WHERE device_id = ?`, [dev("erin")]).cert_json },
    keyRows: [],
    rows: [],
    matterKey: randomBytes(32),
    signer: new SoftwareSigner(eKeys.signPrivateKeyPem),
  });
  writeSegment(share, tid, dev("erin"), sid, sealed);
  for (const k of [kA, kD]) {
    await k.inv("sync.import", { share_dir: share });
    await k.inv("sync.import", { share_dir: share });
  }
  const aA = await alerts(kA);
  const aD = await alerts(kD);
  LOG("① A（负责人）告警：", JSON.stringify(aA), "｜dave 告警：", JSON.stringify(aD.map((a) => [a.kind, a.epoch, a.hits])));
  LOG("   A 本机库里的明细（界面不显示）：", JSON.stringify(kA.kernel.db.all(`SELECT kind, epoch, detail, hits FROM sync_alerts`, [])));
  await importText(kA, mid, "乙.txt", "A 写的新材料");
  const exA = await kA.inv("sync.export", { share_dir: fresh("a1"), matter_id: mid });
  const exD = await kD.inv("sync.export", { share_dir: fresh("d1"), matter_id: mid });
  LOG("② A 导出段数", exA.segments.length, "暂停", JSON.stringify(exA.pausedConflict), "｜dave 导出段数", exD.segments.length, "暂停", JSON.stringify(exD.pausedConflict));
  assert.equal(exA.segments.length, 1, "在册非负责人伪造的段不应让负责人的电脑暂停发出");
});
