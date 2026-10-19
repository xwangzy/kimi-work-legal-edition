// 第 12 批：成员链经中软共享中继——控制成员移交（D-94 在链上表达）、经中继的存量事项由控制成员锚定。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeKernel, type TestKernel } from "./helpers.ts";
import { startCloudCp, type CloudCp } from "./cloud-cp.ts";
import { createKernel } from "../src/index.ts";

const FIRM = "mlr-firm";
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
    const ws = mkdtempSync(join(tmpdir(), `kwl-mlr-${slug}-`));
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
const hasDoc = (k: K | TestKernel, mid: string, fn: string) => !!k.kernel.db.get(`SELECT 1 AS x FROM document_versions WHERE matter_id = ? AND filename = ?`, [mid, fn]);
const syncAll = async () => {
  for (let i = 0; i < 2; i++) for (const k of [kA, kB, kC]) await k.inv("relay.sync");
};

test("控制成员移交：对方须是在册负责人且经中继同步过；移交后成员调整与轮换改由对方操作，原控制成员降级不再被拦", { timeout: 240_000 }, async () => {
  const m = (await kA.inv("matters.create", { title: "移交控制成员", stance: "受让方", consent_status: "not_required", collab_scope: "team" })).matter.matter_id as string;
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("carol") });
  await imp(kA, m, "甲.txt", "甲");
  await syncAll();
  assert.equal(cloud.relay.server.tenant(TID)!.controller(m), usr("test-lawyer"));
  // 对方不是负责人：拒绝
  await assert.rejects(kA.inv("matters.relay_handoff", { matter_id: m, to_user: usr("carol") }), /在册的负责人/);
  // bob 被加为负责人，但还没经中继同步过：中继拒绝（to_not_reader）
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "owner" });
  await kA.inv("relay.sync");
  await assert.rejects(kA.inv("matters.relay_handoff", { matter_id: m, to_user: usr("bob") }), /先打开并同步一次/);
  // 控制成员降为编辑之前须先移交
  await kB.inv("relay.sync");
  await kB.inv("relay.sync");
  await imp(kB, m, "乙.txt", "乙");
  await kB.inv("relay.sync");
  await assert.rejects(kB.inv("matters.members.add", { matter_id: m, user_id: usr("test-lawyer"), matter_role: "editor" }), /中软共享中继/);
  const r = await kA.inv("matters.relay_handoff", { matter_id: m, to_user: usr("bob") });
  assert.equal(r.controller, usr("bob"));
  assert.equal(cloud.relay.server.tenant(TID)!.controller(m), usr("bob"));
  assert.ok((await kA.inv("matters.member_log", { matter_id: m })).events.some((e: any) => e.kind === "control"), "移交记入成员链");
  await syncAll();
  assert.equal((await kB.inv("matters.member_log", { matter_id: m })).control_to, usr("bob"), "bob 的设备从链上得知");
  // 原控制成员 A 不能再在中继上调整成员；bob 可以
  await assert.rejects(kA.inv("matters.members.remove", { matter_id: m, user_id: usr("carol") }), /须由最先同步该事项的负责人/);
  await kB.inv("matters.members.remove", { matter_id: m, user_id: usr("carol") });
  await imp(kB, m, "丙-移出后.txt", "carol 被移出之后写的");
  await syncAll();
  assert.ok(hasDoc(kA, m, "丙-移出后.txt"), "A 收到新纪元的内容");
  assert.ok(!hasDoc(kC, m, "丙-移出后.txt"), "被移出的 carol 读不到");
  // 移交之后，原控制成员可以被降级（bob 操作）
  await kB.inv("matters.members.add", { matter_id: m, user_id: usr("test-lawyer"), matter_role: "editor" });
  await syncAll();
  assert.ok(kA.kernel.db.get(`SELECT 1 AS x FROM matter_members WHERE matter_id = ? AND user_id = ? AND matter_role = 'editor' AND removed_at IS NULL`, [m, usr("test-lawyer")]));
});
