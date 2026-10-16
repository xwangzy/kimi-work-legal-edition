// 第三轮复核 S11A-29 回归用例（复核人复现转入）
/**
 * 复核 A 第三轮 · 复现 S11A-29：中继介质上，在册的非负责人成员 B（是读者）可以给迟到成员 C 送“伪造首段”——
 * 持平纪元、序号区间从 0 起、事项行来源写成自己、成员行“B 是负责人”、外加一个面向 C 的高纪元自选密钥包裹。
 * 中继照收（B 是读者、纪元持平），C 先摄取这一段（首次引导），此后：B 成为 C 本机的负责人与事项行来源，
 * A 的成员变更与包裹在 C 这里一律被拒；C 用 B 的密钥加密、在中继上登记不了（纪元高于中继、C 不是控制成员）。
 * 与驻留清单、S11A-19 处置“中继通道已堵（只剩非成员抢先登记）”的说法不符。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
/** 复现时的观察输出（转入回归用例后不打印）。 */
const log = (..._a: unknown[]): void => {};
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { makeKernel } = await import("./helpers.ts");
const { startCloudCp } = await import("./cloud-cp.ts");
const { getDeviceKeys, keysDirOf } = await import("../src/devices.ts");
const { sealSegment, writeSegment } = await import("@zr-legal/sync");
const { generateMatterKey, wrapMatterKey, unwrapMatterKey, SoftwareSigner } = await import("@zr-legal/keys");

const FIRM = "rmb-firm";
const TID = `ten_${FIRM}`;
const usr = (s: string) => `usr_${FIRM}_${s}`;
const dev = (s: string) => `dev_${FIRM}_${s}`;
let cloud: any;
let kA: any;
const others: any[] = [];
let kB: any;
let kC: any;

async function second(slug: string) {
  const ws = mkdtempSync(join(tmpdir(), `kwl-r3a-rmb-${slug}-`));
  mkdirSync(join(ws, FIRM, "keys"), { recursive: true });
  copyFileSync(join(kA.dir, FIRM, "keys", "firm-root.json"), join(ws, FIRM, "keys", "firm-root.json"));
  const { createKernel } = await import("../src/index.ts");
  const kernel = await createKernel({ dataDir: ws, firmSlug: FIRM, userSlug: slug, env: { ...process.env, ...cloud.env, ZR_MODEL_PROVIDER: "upstream" } });
  const k = { kernel, dir: ws, inv: (m: string, p?: any) => kernel.invoke(m, p) };
  others.push(k);
  return k;
}
const importText = (k: any, mid: string, filename: string, text: string) =>
  k.inv("materials.import", { matter_id: mid, filename, data_base64: Buffer.from(text, "utf8").toString("base64"), mime: "text/plain" });
const members = (k: any, mid: string) => k.kernel.db.all(`SELECT user_id, matter_role, removed_at IS NOT NULL AS removed FROM matter_members WHERE matter_id = ? ORDER BY user_id`, [mid]);

before(async () => {
  cloud = await startCloudCp({ tenant: TID });
  kA = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_RELAY_SYNC_MS: "off" }, FIRM);
  await kA.inv("control_plane.sync");
  kB = await second("bob");
  kC = await second("carol");
  for (const k of [kB, kC, kA, kB, kC]) await k.inv("control_plane.sync");
  const body = { max_mode: "default", auto_preauthorizations: [], fetch_allowlist_extra: [], l3a_standard_model: "deny", share_relay: "allow" };
  const { draft } = await kA.inv("firm_policy.create_draft", { kind: "policy", body });
  await kA.inv("firm_policy.sign", { draft_id: draft.draft_id, expected_digest: draft.digest });
  await kA.inv("firm_policy.publish", { draft_id: draft.draft_id });
  await cloud.feed.refresh();
  for (const k of [kB, kC]) await k.inv("control_plane.sync");
});
after(async () => {
  for (const k of others) await k.kernel.close().catch(() => {});
  await kA.kernel.close();
  await cloud.close();
});

test("在册非负责人成员经中继给迟到成员送伪造首段", { timeout: 180_000 }, async () => {
  const { matter } = await kA.inv("matters.create", { title: "中继迟到成员", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  const mid = matter.matter_id;
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("bob") });
  await importText(kA, mid, "甲.txt", "甲");
  await kA.inv("relay.sync");
  await kB.inv("relay.sync");
  // A 加入迟到成员 carol 并发出
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("carol") });
  await importText(kA, mid, "乙.txt", "乙");
  await kA.inv("relay.sync");
  await kB.inv("relay.sync");
  // B：持平纪元 1（中继照收），段体用真实纪元 1 的事项密钥加密（B 自己的发件流程能解开），
  // 包裹：面向 C 的纪元 1 真实包裹 + 面向 C 的纪元 7 自选密钥；段体：事项行来源写 B、成员行“B 是负责人、C 是成员”
  const bKeys = getDeviceKeys(keysDirOf(kB.kernel.config.workspaceDir));
  const db = kB.kernel.db;
  const K1 = unwrapMatterKey(db.get(`SELECT wrapped_key FROM matter_keys WHERE matter_id = ? AND epoch = 1 AND wrapped_for = ?`, [mid, dev("bob")]).wrapped_key, bKeys.encPrivateKeyPem);
  const KB = generateMatterKey();
  const cPub = db.get(`SELECT enc_pub_pem FROM devices WHERE device_id = ?`, [dev("carol")]).enc_pub_pem;
  const now = new Date().toISOString();
  const keyRows = [
    { matter_id: mid, epoch: 1, wrapped_for: dev("carol"), wrapped_key: wrapMatterKey(K1, cPub), created_at: now },
    { matter_id: mid, epoch: 1, wrapped_for: dev("bob"), wrapped_key: wrapMatterKey(K1, db.get(`SELECT enc_pub_pem FROM devices WHERE device_id = ?`, [dev("bob")]).enc_pub_pem), created_at: now },
    { matter_id: mid, epoch: 7, wrapped_for: dev("carol"), wrapped_key: wrapMatterKey(KB, cPub), created_at: now },
  ];
  const rows = [
    ...db.all(`SELECT * FROM users WHERE tenant_id = ?`, [TID]).map((u: any) => ({ t: "users", pk: u.user_id, src_device: dev("bob"), src_lamport: 1, row: u })),
    { t: "matters", pk: mid, src_device: dev("bob"), src_lamport: 1, row: db.get(`SELECT * FROM matters WHERE matter_id = ?`, [mid]) },
    { t: "matter_members", pk: `${mid}|${usr("bob")}`, src_device: dev("bob"), src_lamport: 1, row: { matter_id: mid, user_id: usr("bob"), matter_role: "owner", added_by: usr("bob"), removed_at: null, removed_lamport: null, author_device: dev("bob"), row_lamport: 1 } },
    { t: "matter_members", pk: `${mid}|${usr("carol")}`, src_device: dev("bob"), src_lamport: 1, row: { matter_id: mid, user_id: usr("carol"), matter_role: "editor", added_by: usr("bob"), removed_at: null, removed_lamport: null, author_device: dev("bob"), row_lamport: 1 } },
  ];
  const sid = `seg_${dev("bob")}_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
  const sealed = sealSegment({
    header: { segment_id: sid, device_id: dev("bob"), matter_id: mid, from_lamport: 0, to_lamport: 0, key_epoch: 1, event_count: rows.length, created_at: now, device_cert_json: db.get(`SELECT cert_json FROM devices WHERE device_id = ?`, [dev("bob")]).cert_json },
    keyRows,
    rows,
    matterKey: K1,
    signer: new SoftwareSigner(bKeys.signPrivateKeyPem),
  });
  // 放进 B 自己的发件目录，由 B 的正常发件流程上传、登记
  writeSegment(join(kB.kernel.config.workspaceDir, "relay", "outbox"), TID, dev("bob"), sid, sealed);
  const bp = await kB.inv("relay.sync");
  log("B 发件：", JSON.stringify(bp.push));
  const entry = cloud.relay.server.tenant(TID)!.entries.find((e: any) => e.sid === sid);
  log("中继登记了 B 的伪造段：", !!entry);

  // 调试：只把 B 的伪造段经共享文件夹给 C 的副本看摄取结果
  {
    const probe = mkdtempSync(join(tmpdir(), "kwl-r3a-probe-"));
    writeSegment(probe, TID, dev("bob"), sid, sealed);
    if (process.env.PROBE) {
      const r = await kC.inv("sync.import", { share_dir: probe });
      log("probe", JSON.stringify(r).slice(0, 2000));
      return;
    }
  }
  // C 第一次收件
  const c1 = await kC.inv("relay.sync");
  const c2 = await kC.inv("relay.sync");
  log("C 收件：", JSON.stringify(c1.pull), JSON.stringify(c2.pull));
  const cdb = kC.kernel.db;
  log("C 的成员表：", JSON.stringify(members(kC, mid)));
  log("C 认定的事项行来源：", cdb.get(`SELECT origin_device FROM sync_row_origin WHERE table_name = 'matters' AND row_pk = ?`, [mid])?.origin_device);
  log("C 的包裹纪元：", JSON.stringify(cdb.all(`SELECT epoch FROM matter_keys WHERE matter_id = ? AND wrapped_for = ?`, [mid, dev("carol")])));
  // C 写入并发出
  await importText(kC, mid, "丙.txt", "C 的意见");
  const c3 = await kC.inv("relay.sync");
  log("C 发件：", JSON.stringify(c3.push));
  // A 移出 B（轮换到纪元 2）并发出；C 收件
  await kA.inv("matters.members.remove", { matter_id: mid, user_id: usr("bob") });
  await importText(kA, mid, "丁.txt", "移出 B 之后");
  await kA.inv("relay.sync");
  const c4 = await kC.inv("relay.sync");
  log("C 收件（A 移出 B 之后）：", JSON.stringify(c4.pull));
  log("C 的成员表：", JSON.stringify(members(kC, mid)));
  log("C 的包裹纪元：", JSON.stringify(cdb.all(`SELECT epoch FROM matter_keys WHERE matter_id = ? AND wrapped_for = ?`, [mid, dev("carol")])));
  const aDocs = ((await kA.inv("matters.get", { matter_id: mid })).documents as any[]).map((d) => d.filename);
  log("A 的材料：", aDocs);
  assert.ok(aDocs.includes("丙.txt"), "C 的改动应能送达负责人");
  assert.ok(cdb.get(`SELECT 1 AS x FROM matter_keys WHERE matter_id = ? AND epoch = 2 AND wrapped_for = ?`, [mid, dev("carol")]), "C 应收到负责人移出 B 之后的新纪元");
});
