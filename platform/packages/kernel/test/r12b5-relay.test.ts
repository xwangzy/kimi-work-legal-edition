// 第 12 批第五轮复核 B 的复现（对象 51ccf5f），处置后改为回归。中继介质：出件箱里的段因引用的块被重封而作废时，
// 水位退到段里最早一行的时刻（而不是段的生成时刻），段里的行重新导出、照常送达。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeKernel, type TestKernel } from "./helpers.ts";
import { startCloudCp, type CloudCp } from "./cloud-cp.ts";
import { createKernel } from "../src/index.ts";

const FIRM = "r12b5r";
const TID = `ten_${FIRM}`;
const usr = (s: string) => `usr_${FIRM}_${s}`;
type K = { kernel: Awaited<ReturnType<typeof createKernel>>; dir: string; inv: (m: string, p?: any) => Promise<any> };
let cloud: CloudCp;
let kA: TestKernel;
let kC: K;
let kD: K;

before(async () => {
  cloud = await startCloudCp({ tenant: TID });
  kA = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_RELAY_SYNC_MS: "off" }, FIRM);
  await kA.inv("control_plane.sync");
  const second = async (slug: string): Promise<K> => {
    const ws = mkdtempSync(join(tmpdir(), `kwl-r12b5r-${slug}-`));
    mkdirSync(join(ws, FIRM, "keys"), { recursive: true });
    copyFileSync(join(kA.dir, FIRM, "keys", "firm-root.json"), join(ws, FIRM, "keys", "firm-root.json"));
    const kernel = await createKernel({ dataDir: ws, firmSlug: FIRM, userSlug: slug, env: { ...process.env, ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_RELAY_SYNC_MS: "off" } });
    return { kernel, dir: ws, inv: (m, p) => kernel.invoke(m, p) };
  };
  kC = await second("carol");
  kD = await second("dave");
  for (const k of [kC, kD, kA, kC, kD]) await k.inv("control_plane.sync");
  const body = { max_mode: "default", auto_preauthorizations: [], fetch_allowlist_extra: [], l3a_standard_model: "deny", share_relay: "allow" };
  const { draft } = await kA.inv("firm_policy.create_draft", { kind: "policy", body });
  await kA.inv("firm_policy.sign", { draft_id: draft.draft_id, expected_digest: draft.digest });
  await kA.inv("firm_policy.publish", { draft_id: draft.draft_id });
  await cloud.feed.refresh();
  for (const k of [kC, kD]) await k.inv("control_plane.sync");
});
after(async () => {
  for (const k of [kC, kD]) await k.kernel.close().catch(() => {});
  await kA.kernel.close();
  await cloud.close();
});

const imp = (k: K | TestKernel, mid: string, fn: string, t: string) =>
  k.inv("materials.import", { matter_id: mid, filename: fn, data_base64: Buffer.from(t, "utf8").toString("base64"), mime: "text/plain" });
const hasDoc = (k: K | TestKernel, mid: string, fn: string) => !!k.kernel.db.get(`SELECT 1 AS x FROM document_versions WHERE matter_id = ? AND filename = ?`, [mid, fn]);
const syncAll = async () => {
  for (let i = 0; i < 2; i++) for (const k of [kA, kC, kD]) await k.inv("relay.sync");
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("S12B-55：出件箱里的段因引用的块被重封而作废（local_blob_changed），水位退到段里最早一行：段里的行重新导出、照常送达", { timeout: 240_000 }, async () => {
  const m = (await kA.inv("matters.create", { title: "作废段丢行", stance: "受让方", consent_status: "not_required", collab_scope: "team" })).matter.matter_id as string;
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("carol") });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("dave") });
  await imp(kA, m, "甲-起始.txt", "起始");
  await syncAll();
  assert.ok(hasDoc(kC, m, "甲-起始.txt"));
  // A 暂时连不上中继：导入一份材料（纪元 1 封），这次同步导出的段 S1 留在出件箱
  const gate = (kA.kernel as any).gate;
  const real = gate.relay;
  gate.relay = async () => ({ ok: false, reason: "relay_unreachable" });
  await imp(kA, m, "甲-离线期间.txt", "同一份证据");
  await imp(kA, m, "甲-离线期间-另一份.txt", "只在 S1 里的另一份材料");
  await sleep(30);
  await kA.inv("relay.sync").catch(() => {});
  const outbox = join(kA.dir, FIRM, "workspace", "relay");
  gate.relay = real;
  // 恢复连接之前 A 移出 dave（纪元 2），又把同一份证据导入到另一处（内容寻址：同一个块）
  await kA.inv("matters.members.remove", { matter_id: m, user_id: usr("dave") });
  await sleep(30);
  await imp(kA, m, "甲-同一证据-副本.txt", "同一份证据");
  // 这一次同步：导出的段 S2 引用同一个块 → 发出前按纪元 2 重封 → S1 上传时 local_blob_changed → 作废、水位退到 S1 的生成时刻
  const r = await kA.inv("relay.sync");
  assert.ok(r.push.uploaded >= 1, JSON.stringify(r.push));
  await syncAll();
  await syncAll();
  assert.ok(hasDoc(kC, m, "甲-同一证据-副本.txt"), "S2 的行到了");
  assert.ok(hasDoc(kC, m, "甲-离线期间.txt"), "S1 的行重新导出后送达");
  assert.ok(hasDoc(kC, m, "甲-离线期间-另一份.txt"), "S1 里与重封无关的行同样送达");
  assert.ok(!hasDoc(kD, m, "甲-同一证据-副本.txt"), "被移出的 dave 读不到纪元 2 之后的内容");
  const st = await kA.inv("relay.status");
  assert.equal(kA.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM relay_outbox WHERE matter_id = ?`, [m])!.n, 0);
  assert.ok(!st.push_last_error, JSON.stringify(st.push_last_error ?? null));
  void outbox;
  void readdirSync;
});

test("S12B-55 对照：同样离线、同样移出 dave，只是之后导入的不是同一份证据（不触发重封）——S1 照常送达", { timeout: 240_000 }, async () => {
  const m = (await kA.inv("matters.create", { title: "作废段对照", stance: "受让方", consent_status: "not_required", collab_scope: "team" })).matter.matter_id as string;
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("carol") });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("dave") });
  await imp(kA, m, "甲-起始.txt", "起始");
  await syncAll();
  const gate = (kA.kernel as any).gate;
  const real = gate.relay;
  gate.relay = async () => ({ ok: false, reason: "relay_unreachable" });
  await imp(kA, m, "甲-离线期间.txt", "对照：同一份证据");
  await sleep(30);
  await kA.inv("relay.sync").catch(() => {});
  gate.relay = real;
  await kA.inv("matters.members.remove", { matter_id: m, user_id: usr("dave") });
  await sleep(30);
  await imp(kA, m, "甲-另一份.txt", "对照：不同的内容");
  await kA.inv("relay.sync");
  await syncAll();
  await syncAll();
  assert.ok(hasDoc(kC, m, "甲-另一份.txt"));
  assert.ok(hasDoc(kC, m, "甲-离线期间.txt"), "不触发重封时 S1 照常送达");
});
