/**
 * 第 11 批第五轮复核 B 的复现转入（S11B-41、S11B-42）：
 * - S11B-41：升级前同步过、没有作者签名的成员行，作者升级后发来同一内容的签名版本时补上签名；之后共同负责人先登记中继、由他加的成员能引导；
 * - S11B-42：非负责人的段在上传期间本机发现重置（代数变了），登记仍按开始处理时的代数、被中继拒收，不抢先成为控制成员。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeKernel, type TestKernel } from "./helpers.ts";
import { startCloudCp, type CloudCp } from "./cloud-cp.ts";
import { createKernel } from "../src/index.ts";

const FIRM = "r5-firm";
const TID = `ten_${FIRM}`;
const usr = (s: string) => `usr_${FIRM}_${s}`;
type K = { kernel: Awaited<ReturnType<typeof createKernel>>; dir: string; inv: (m: string, p?: any) => Promise<any> };
let cloud: CloudCp;
let kA: TestKernel;
let kB: K;
let kC: K;

before(async () => {
  cloud = await startCloudCp({ tenant: TID });
  kA = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_RELAY_SYNC_MS: "off" }, FIRM);
  await kA.inv("control_plane.sync");
  const second = async (slug: string): Promise<K> => {
    const ws = mkdtempSync(join(tmpdir(), `kwl-r5-${slug}-`));
    mkdirSync(join(ws, FIRM, "keys"), { recursive: true });
    copyFileSync(join(kA.dir, FIRM, "keys", "firm-root.json"), join(ws, FIRM, "keys", "firm-root.json"));
    const kernel = await createKernel({ dataDir: ws, firmSlug: FIRM, userSlug: slug, env: { ...process.env, ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_RELAY_SYNC_MS: "off" } });
    return { kernel, dir: ws, inv: (m, p) => kernel.invoke(m, p) };
  };
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
  for (const k of [kB, kC]) await k.kernel.close().catch(() => {});
  await kA.kernel.close();
  await cloud.close();
});

const imp = (k: K | TestKernel, mid: string, fn: string, t: string) =>
  k.inv("materials.import", { matter_id: mid, filename: fn, data_base64: Buffer.from(t, "utf8").toString("base64"), mime: "text/plain" });
const docs = async (k: K | TestKernel, mid: string): Promise<string[]> =>
  ((await k.inv("matters.get", { matter_id: mid }).catch(() => ({ documents: [] }))).documents as any[]).map((d) => d.filename).sort();
const newMatter = async (title: string) => (await kA.inv("matters.create", { title, stance: "受让方", consent_status: "not_required", collab_scope: "team" })).matter.matter_id as string;

test("S11B-41：升级前同步过的成员行（没有作者签名）在作者升级后发来同一内容时补上签名；共同负责人先登记中继、由他加的成员能引导", { timeout: 180_000 }, async () => {
  const m = await newMatter("升级前的成员行");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "owner" });
  await imp(kA, m, "A的材料.txt", "A 的材料");
  const share = mkdtempSync(join(tmpdir(), "kwl-r5-up-"));
  await kA.inv("sync.export", { share_dir: share, matter_id: m });
  await kB.inv("sync.import", { share_dir: share });
  // 模拟这次同步发生在升级之前（0039 新列为空）
  for (const k of [kA, kB]) k.kernel.db.run(`UPDATE matter_members SET author_sig = NULL, author_cert = NULL WHERE matter_id = ?`, [m]);
  await imp(kA, m, "升级后A又写的.txt", "x");
  await kA.inv("sync.export", { share_dir: share, matter_id: m });
  await kB.inv("sync.import", { share_dir: share });
  const unsigned = kB.kernel.db.all(`SELECT user_id FROM matter_members WHERE matter_id = ? AND author_sig IS NULL`, [m]);
  assert.deepEqual(unsigned, [], "B 本机的成员行都补上了作者签名");
  await kB.inv("relay.sync");
  await kA.inv("relay.sync");
  assert.equal(cloud.relay.server.tenant(TID)!.controller(m), usr("bob"));
  await kB.inv("matters.members.add", { matter_id: m, user_id: usr("carol") });
  await kB.inv("relay.sync");
  await kA.inv("relay.sync");
  await kC.inv("relay.sync");
  await kC.inv("relay.sync");
  assert.ok(kC.kernel.db.get(`SELECT 1 AS x FROM matter_keys WHERE matter_id = ? AND wrapped_for = ?`, [m, `dev_${FIRM}_carol`]));
  assert.deepEqual(await docs(kC, m), ["A的材料.txt", "升级后A又写的.txt"]);
});

test("S11B-42：非负责人的段上传期间本机发现重置，登记仍按开始处理时的代数、被中继拒收，不抢先成为控制成员", { timeout: 180_000 }, async () => {
  const m = await newMatter("上传期间发现重置");
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("carol") });
  await imp(kA, m, "A.txt", "A");
  await kA.inv("relay.sync");
  await kC.inv("relay.sync");
  const r = await fetch(`${cloud.relay.base}/v1/relay/ops/tenants/${TID}/matters/${m}`, { method: "DELETE", headers: { authorization: `Bearer ${cloud.relay.opsSecret}`, "x-kwl-operator": "ops.test" } });
  assert.equal(r.status, 200);
  await imp(kC, m, "C写的.txt", "C");
  // C 上传块期间（登记之前），模拟后台收件在这期间发现了重置、把本机代数改成新值
  const gate = kC.kernel.gate as any;
  const orig = gate.relay.bind(gate);
  gate.relay = async (req: any) => {
    if (req.step === "have" && req.matter_id === m) kC.kernel.db.run(`UPDATE relay_matters SET gen = 1 WHERE matter_id = ?`, [m]);
    return orig(req);
  };
  try {
    await kC.inv("relay.sync");
  } finally {
    gate.relay = orig;
  }
  assert.equal(cloud.relay.server.tenant(TID)!.controller(m), null, "非负责人的段没有在中继上把事项重新建起来");
  await kA.inv("relay.sync");
  assert.equal(cloud.relay.server.tenant(TID)!.controller(m), usr("test-lawyer"));
  assert.equal(await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob") }).then(() => "ok"), "ok", "负责人照常加人");
});
