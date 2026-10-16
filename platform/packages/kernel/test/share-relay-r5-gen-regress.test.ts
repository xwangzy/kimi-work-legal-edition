// 第 11 批第五轮复核 A 的复现转入（S11A-45）：修正前为失败，修正后为回归用例。第五轮处置：重置代数“变了”（变大或变小）都按重置处理
/**
 * 重置代数只增不减地记在客户端（noteGen 只接受“变大”），而中继上的代数在租户整体删除后从 0 重新算（实例编号不变）。
 * 曾被按事项重置过的事项（本机 gen ≥ 1），在租户整体删除、律所继续使用（例如退约撤回、运营误删后恢复服务）之后：
 * 本机登记一律带 gen=1，中继回 409 matter_reset（gen 0），客户端 noteGen(0) 不变大 → 直接 continue：段留在发件目录、
 * 不记错误、不提示，永远登记不上。中继备份回滚（重置记录少于客户端所知）同理。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { makeKernel } = await import("./helpers.ts");
const { startCloudCp } = await import("./cloud-cp.ts");
const { scanSegments } = await import("@zr-legal/sync");

const FIRM = "r5c-firm";
const TID = `ten_${FIRM}`;
const usr = (s: string) => `usr_${FIRM}_${s}`;
const LOG = process.env.R5A_LOG ? console.log : (..._a: unknown[]) => {};
let cloud: any;
let kA: any;
let kB: any;
const others: any[] = [];

async function second(slug: string) {
  const ws = mkdtempSync(join(tmpdir(), `kwl-r5c-${slug}-`));
  mkdirSync(join(ws, FIRM, "keys"), { recursive: true });
  copyFileSync(join(kA.dir, FIRM, "keys", "firm-root.json"), join(ws, FIRM, "keys", "firm-root.json"));
  const { createKernel } = await import("../src/index.ts");
  const kernel = await createKernel({ dataDir: ws, firmSlug: FIRM, userSlug: slug, env: { ...process.env, ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_RELAY_SYNC_MS: "off" } });
  const k = { kernel, dir: ws, inv: (m: string, p?: any) => kernel.invoke(m, p) };
  others.push(k);
  return k;
}
const importText = (k: any, mid: string, filename: string, text: string) =>
  k.inv("materials.import", { matter_id: mid, filename, data_base64: Buffer.from(text, "utf8").toString("base64"), mime: "text/plain" });
const entries = () => cloud.relay.server.tenant(TID)?.entries ?? [];
const ops = (path: string) =>
  fetch(`${cloud.relay.base}/v1/relay/ops/tenants/${TID}${path}`, { method: "DELETE", headers: { authorization: `Bearer ${cloud.relay.opsSecret}`, "x-kwl-operator": "ops.r5a" } });
const outboxOf = (k: any, mid: string) => scanSegments(join(k.kernel.config.workspaceDir, "relay", "outbox"), TID).candidates.filter((c: any) => c.content.includes(mid)).length;

before(async () => {
  cloud = await startCloudCp({ tenant: TID });
  kA = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_RELAY_SYNC_MS: "off" }, FIRM);
  await kA.inv("control_plane.sync");
  kB = await second("bob");
  for (const k of [kB, kA, kB]) await k.inv("control_plane.sync");
  const body = { max_mode: "default", auto_preauthorizations: [], fetch_allowlist_extra: [], l3a_standard_model: "deny", share_relay: "allow" };
  const { draft } = await kA.inv("firm_policy.create_draft", { kind: "policy", body });
  await kA.inv("firm_policy.sign", { draft_id: draft.draft_id, expected_digest: draft.digest });
  await kA.inv("firm_policy.publish", { draft_id: draft.draft_id });
  await cloud.feed.refresh();
  await kB.inv("control_plane.sync");
});
after(async () => {
  for (const k of others) await k.kernel.close().catch(() => {});
  await kA.kernel.close();
  await cloud.close();
});

test("S11A-45：按事项重置过的事项，在租户整体删除后重新登记上", { timeout: 240_000 }, async () => {
  const { matter } = await kA.inv("matters.create", { title: "重置后再整体删除", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  const mid = matter.matter_id;
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("bob") });
  await importText(kA, mid, "甲.txt", "甲");
  await kA.inv("relay.sync");
  await kB.inv("relay.sync");
  // 运营按事项重置一次；负责人手动“立即同步”即发现并全量重发
  assert.equal((await ops(`/matters/${mid}`)).status, 200);
  await kA.inv("relay.sync");
  const genA = kA.kernel.db.get(`SELECT gen FROM relay_matters WHERE matter_id = ?`, [mid])?.gen;
  LOG("重置后 A 记下的代数：", genA, "｜中继上该事项登记数：", entries().filter((e: any) => e.mid === mid).length);
  // 租户整体删除（中继实例不变），律所此后继续使用
  assert.equal((await ops(``)).status, 200);
  await importText(kA, mid, "乙.txt", "乙（整体删除之后写）");
  const r1 = await kA.inv("relay.sync");
  const r2 = await kA.inv("relay.sync");
  LOG("A 两次发件报告：", JSON.stringify(r1.push), JSON.stringify(r2.push));
  LOG("A 状态：", JSON.stringify(await kA.inv("relay.status")).slice(0, 600));
  LOG("A 发件目录里该事项的段数：", outboxOf(kA, mid), "｜中继上该事项登记数：", entries().filter((e: any) => e.mid === mid).length);
  // 另起一个从没被重置过的新事项作对照
  const { matter: m2 } = await kA.inv("matters.create", { title: "对照", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  await importText(kA, m2.matter_id, "对照.txt", "对照");
  await kA.inv("relay.sync");
  LOG("对照事项登记数：", entries().filter((e: any) => e.mid === m2.matter_id).length);
  const errs = [...(r1.push?.errors ?? []), ...(r2.push?.errors ?? [])];
  assert.ok(entries().some((e: any) => e.mid === mid) || errs.length > 0, "要么重新登记上，要么如实报错；不应静默卡住");
});
