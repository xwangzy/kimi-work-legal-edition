// 第 11 批第四轮复核 A 的复现转入（S11A-39）：修正前为失败，修正后为回归用例
/**
 * 律所关闭共享中继开关（share_relay 不再允许）之后，经中继同步过的事项仍按“中继上的控制成员”锁定成员调整（第三轮 S11B-33e）；
 * 收件不再运行，控制成员状态永远不会刷新、运营重置也到不了本机。控制成员之外的负责人永远不能移出成员（伦理墙），
 * 界面却让他“联系中软客服”——而律所已经不用中继了。
 * 第四轮处置：律所策略不再允许中继时放行本机成员调整（重新开启前须办理重置，D-94）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { makeKernel } = await import("./helpers.ts");
const { startCloudCp } = await import("./cloud-cp.ts");

const FIRM = "r4c-firm";
const TID = `ten_${FIRM}`;
const usr = (s: string) => `usr_${FIRM}_${s}`;
const LOG = process.env.R4A_LOG ? console.log : (..._a: unknown[]) => {};
let cloud: any;
let kA: any;
const others: any[] = [];
let kB: any;
let kC: any;

async function second(slug: string) {
  const ws = mkdtempSync(join(tmpdir(), `kwl-r4c-${slug}-`));
  mkdirSync(join(ws, FIRM, "keys"), { recursive: true });
  copyFileSync(join(kA.dir, FIRM, "keys", "firm-root.json"), join(ws, FIRM, "keys", "firm-root.json"));
  const { createKernel } = await import("../src/index.ts");
  const kernel = await createKernel({ dataDir: ws, firmSlug: FIRM, userSlug: slug, env: { ...process.env, ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_RELAY_SYNC_MS: "off" } });
  const k = { kernel, dir: ws, inv: (m: string, p?: any) => kernel.invoke(m, p) };
  others.push(k);
  return k;
}
const publish = async (body: Record<string, unknown>) => {
  const { draft } = await kA.inv("firm_policy.create_draft", { kind: "policy", body });
  await kA.inv("firm_policy.sign", { draft_id: draft.draft_id, expected_digest: draft.digest });
  await kA.inv("firm_policy.publish", { draft_id: draft.draft_id });
  await cloud.feed.refresh();
  for (const k of [kA, kB, kC]) await k.inv("control_plane.sync");
};
const base = { max_mode: "default", auto_preauthorizations: [], fetch_allowlist_extra: [], l3a_standard_model: "deny" };

before(async () => {
  cloud = await startCloudCp({ tenant: TID });
  kA = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_RELAY_SYNC_MS: "off" }, FIRM);
  await kA.inv("control_plane.sync");
  kB = await second("bob");
  kC = await second("carol");
  for (const k of [kB, kC, kA, kB, kC]) await k.inv("control_plane.sync");
  await publish({ ...base, share_relay: "allow" });
});
after(async () => {
  for (const k of others) await k.kernel.close().catch(() => {});
  await kA.kernel.close();
  await cloud.close();
});

test("S11A-39：关闭中继开关后，非控制成员的负责人能在本机移出成员", { timeout: 240_000 }, async () => {
  const { matter } = await kA.inv("matters.create", { title: "关开关后伦理墙", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  const mid = matter.matter_id;
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("carol"), matter_role: "owner" });
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("bob") });
  await kA.inv("relay.sync");
  await kC.inv("relay.sync");
  await kB.inv("relay.sync");
  // 律所关闭共享中继（改回共享文件夹或不再团队同步）
  await publish({ ...base });
  const st = await kC.inv("relay.status");
  LOG("carol 中继状态：", st.blocked);
  const r = await kC.inv("matters.members.remove", { matter_id: mid, user_id: usr("bob") }).then((x: any) => `ok 新纪元 ${x.new_epoch}`).catch((e: any) => e.message);
  LOG("关闭开关后 carol 移出 bob：", r);
  assert.equal(st.blocked, "not_allowed");
  assert.match(r, /^ok/, "律所已关闭中继时，负责人应能在本机执行伦理墙（移出即轮换）");
});
