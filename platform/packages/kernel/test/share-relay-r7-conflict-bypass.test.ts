const FIRM = "r7a-byp";
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
 * 复核 A 第七轮 · S11A-54：纪元冲突的“暂停发出”只要本机持有更高纪元就自动解除，不看更高纪元是谁给的。
 * S11A-43 残余（签名不带新鲜度）里的被移出共同负责人 bob，本机仍以为自己是负责人；他再轮换一次（未改过的客户端，
 * 甚至正是照着界面“请联系事项负责人……重新轮换密钥（例如移出后再加回任一成员）”去做），滞后设备 dave 上：
 * bob 仍是负责人（A 的移出段解不开、从未应用），bob 的纪元 3 包裹落库，纪元 2 的冲突视为解决，dave 恢复发出，
 * 用 bob 选的纪元 3 加密——被移出的 bob 读到 dave 之后写的内容。缓解被同一个人、用同一条路径解除。
 * 变体 R7A_BOB_SEES=0：bob 没收过 A 的移出段（他本机没有告警），直接再轮换一次。
 */
const BOB_SEES = process.env.R7A_BOB_SEES !== "0";
let kB: any, kD: any, kE: any;
before(async () => {
  kA = await makeKernel({ ZR_MODEL_PROVIDER: "upstream" }, FIRM);
  kB = await second("bob");
  kD = await second("dave");
  kE = await second("erin");
  const all = [kA, kB, kD, kE];
  for (const [k, s] of [[kA, "test-lawyer"], [kB, "bob"], [kD, "dave"], [kE, "erin"]] as const) copyDev(k, dev(s), all.filter((x) => x !== k));
});
after(async () => {
  for (const k of others) await k.kernel.close().catch(() => {});
  await kA.kernel.close();
});

test(`S11A-54：被移出的共同负责人再轮换一次，解除不了滞后设备的暂停发出，读不到它之后写的内容${BOB_SEES ? "（bob 也见过 A 的移出段、本机有告警）" : "（bob 没见过 A 的移出段）"}`, { timeout: 120_000 }, async () => {
  const { matter } = await kA.inv("matters.create", { title: "冲突绕过", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  const mid = matter.matter_id;
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("dave") });
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("erin") });
  await importText(kA, mid, "甲.txt", "甲（A 写）");
  const s0 = fresh("s0");
  await kA.inv("sync.export", { share_dir: s0, matter_id: mid });
  await kD.inv("sync.import", { share_dir: s0 });
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("bob"), matter_role: "owner" });
  const s1 = fresh("s1");
  await kA.inv("sync.export", { share_dir: s1, matter_id: mid });
  await kB.inv("sync.import", { share_dir: s0 });
  await kB.inv("sync.import", { share_dir: s1 });
  // A 移出 bob（先降为编辑），纪元 2
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("bob"), matter_role: "editor" });
  await kA.inv("matters.members.remove", { matter_id: mid, user_id: usr("bob") });
  const s2 = fresh("s2");
  await kA.inv("sync.export", { share_dir: s2, matter_id: mid });
  // bob 本机仍是负责人：移出 erin，同号纪元 2
  await kB.inv("matters.members.remove", { matter_id: mid, user_id: usr("erin") });
  const s3 = fresh("s3");
  await kB.inv("sync.export", { share_dir: s3, matter_id: mid });
  // dave 先收 bob 的段、再收 A 的移出段：第六轮缓解生效（告警 + 暂停）
  await kD.inv("sync.import", { share_dir: s3 });
  await kD.inv("sync.import", { share_dir: s2 });
  const dAlerts1 = await alerts(kD);
  await importText(kD, mid, "丁-暂停中.txt", "dave 暂停期间写的内容");
  const ex1 = await kD.inv("sync.export", { share_dir: fresh("d1"), matter_id: mid });
  LOG("① dave 告警：", JSON.stringify(dAlerts1.map((a) => [a.kind, a.epoch])), "｜dave 导出：段数", ex1.segments.length, "暂停", JSON.stringify(ex1.pausedConflict));
  assert.ok(dAlerts1.some((a) => a.matter_id === mid && a.kind === "epoch_conflict"), "前提：dave 上有纪元冲突告警");
  assert.deepEqual(ex1.pausedConflict, [mid], "前提：dave 暂停发出");
  if (BOB_SEES) {
    await kB.inv("sync.import", { share_dir: s2 });
    LOG("② bob 收到 A 的移出段后本机告警：", JSON.stringify((await alerts(kB)).map((a) => [a.kind, a.epoch])), "｜bob 成员表：", JSON.stringify(members(kB, mid)));
  }
  // bob 照着提示“移出后再加回任一成员”：加一位没登记设备的 frank、再移出 → 纪元 3（包裹给 bob 本机名单里的 A、bob、dave）
  await kB.inv("matters.members.add", { matter_id: mid, user_id: usr("frank") });
  const r3 = await kB.inv("matters.members.remove", { matter_id: mid, user_id: usr("frank") });
  LOG("③ bob 再轮换：新纪元", r3.new_epoch, "包裹设备数", r3.devices_wrapped, "｜bob 告警：", JSON.stringify((await alerts(kB)).map((a) => [a.kind, a.epoch])));
  const s5 = fresh("s5");
  const bx = await kB.inv("sync.export", { share_dir: s5, matter_id: mid });
  LOG("   bob 导出：段数", bx.segments.length, "暂停", JSON.stringify(bx.pausedConflict));
  const di = await kD.inv("sync.import", { share_dir: s5 });
  const dAlerts2 = await alerts(kD);
  LOG("④ dave 摄取 bob 的段：", JSON.stringify(di.dispositions.map((x: any) => x.outcome)), "｜dave 纪元：", JSON.stringify(epochs(kD, mid, dev("dave"))), "｜dave 告警：", JSON.stringify(dAlerts2.map((a) => [a.kind, a.epoch])));
  LOG("   dave 成员表：", JSON.stringify(members(kD, mid)));
  await importText(kD, mid, "戊-解除后.txt", "dave 在告警被解除之后写的保密内容");
  const s6 = fresh("s6");
  const ex2 = await kD.inv("sync.export", { share_dir: s6, matter_id: mid });
  LOG("⑤ dave 导出：段数", ex2.segments.length, "暂停", JSON.stringify(ex2.pausedConflict));
  await kB.inv("sync.import", { share_dir: s6 });
  const leaked = textOf(kB, "戊-解除后.txt");
  const leakedPaused = textOf(kB, "丁-暂停中.txt");
  await kA.inv("sync.import", { share_dir: s6 });
  LOG("⑥ 被移出的 bob 读到：", leaked, "｜暂停期间写的：", leakedPaused, "｜真负责人 A 读到：", textOf(kA, "戊-解除后.txt"));
  assert.equal(leaked, null, "被移出的共同负责人不应凭再轮换一次解除滞后设备的暂停、读到它之后写的内容");
});
