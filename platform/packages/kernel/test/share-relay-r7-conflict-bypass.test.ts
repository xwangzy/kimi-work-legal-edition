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

test(`S11A-54（第 12 批）：被移出的共同负责人不知道自己被移出时再做的成员变更与轮换在链上拒收，读不到滞后设备之后写的内容${BOB_SEES ? "（bob 去收 A 的移出段，解不开）" : "（bob 不去收 A 的移出段）"}`, { timeout: 120_000 }, async () => {
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
  // dave 先收 bob 的段、再收 A 的移出段。第 12 批（成员链）：bob 并发的“移出 erin + 纪元 2”在链上拒收（移出优先于被移出者的并发操作），
  // 没有分叉、不暂停
  await kD.inv("sync.import", { share_dir: s3 });
  await kD.inv("sync.import", { share_dir: s2 });
  const dAlerts1 = await alerts(kD);
  await importText(kD, mid, "丁-暂停中.txt", "dave 暂停期间写的内容");
  const ex1 = await kD.inv("sync.export", { share_dir: fresh("d1"), matter_id: mid });
  LOG("① dave 告警：", JSON.stringify(dAlerts1.map((a) => [a.kind, a.epoch])), "｜dave 导出：段数", ex1.segments.length, "暂停", JSON.stringify(ex1.pausedConflict));
  assert.deepEqual(dAlerts1.filter((a) => a.matter_id === mid), [], "没有分叉告警");
  assert.deepEqual(ex1.pausedConflict, [], "不暂停");
  if (BOB_SEES) {
    // bob 去收 A 的移出段：段用纪元 2 加密、没有给 bob 的包裹，bob 解不开——本机仍以为自己是负责人（与不去收相同）
    const rb = await kB.inv("sync.import", { share_dir: s2 });
    LOG("② bob 收 A 的移出段：", JSON.stringify(rb.dispositions.map((x: any) => x.outcome)));
  }
  // bob 本机仍以为自己是负责人：加 frank、再移出 → 纪元 3；这些事件与他被降级并发，在 dave 上同样拒收
  await kB.inv("matters.members.add", { matter_id: mid, user_id: usr("frank") });
  const r3 = await kB.inv("matters.members.remove", { matter_id: mid, user_id: usr("frank") });
  LOG("③ bob 再轮换：新纪元", r3.new_epoch);
  const s5 = fresh("s5");
  await kB.inv("sync.export", { share_dir: s5, matter_id: mid });
  const di = await kD.inv("sync.import", { share_dir: s5 });
  LOG("④ dave 摄取 bob 的段：", JSON.stringify(di.dispositions.map((x: any) => x.outcome)), "｜dave 纪元：", JSON.stringify(epochs(kD, mid, dev("dave"))));
  assert.ok(!epochs(kD, mid, dev("dave")).some((e: number) => e >= 3), "dave 不收 bob 声明的纪元 3");
  assert.ok(!members(kD, mid).some((m: any) => m.user_id === usr("frank") && !m.gone), "bob 加的 frank 不是成员");
  assert.deepEqual((await alerts(kD)).filter((a) => a.matter_id === mid), [], "仍没有告警");
  await importText(kD, mid, "戊-解除后.txt", "dave 在告警被解除之后写的保密内容");
  const s6 = fresh("s6");
  await kD.inv("sync.export", { share_dir: s6, matter_id: mid });
  await kB.inv("sync.import", { share_dir: s6 });
  const leaked = textOf(kB, "戊-解除后.txt");
  const leakedPaused = textOf(kB, "丁-暂停中.txt");
  await kA.inv("sync.import", { share_dir: s6 });
  LOG("⑥ 被移出的 bob 读到：", leaked, "｜之前写的：", leakedPaused, "｜真负责人 A 读到：", textOf(kA, "戊-解除后.txt"));
  assert.equal(leaked, null, "被移出的共同负责人读不到滞后设备之后写的内容");
  assert.equal(leakedPaused, null);
  assert.equal(textOf(kA, "戊-解除后.txt"), "dave 在告警被解除之后写的保密内容", "负责人读到");
});
