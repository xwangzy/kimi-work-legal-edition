// 第 11 批第五轮复核 A 的复现转入（S11A-43）。第六轮起“段前负责人”规则撤回（复核 S11A-48/S11B-47），S11A-43 登记为残余；
// 第 12 批（带因果链的成员日志）解决：移出优先于被移出者的并发操作——bob 不知道自己被移出时做的成员变更与轮换在链上拒收，
// 纪元 2 只认 A 的声明；滞后设备之后写的内容被移出者读不到、负责人与仍在的成员读得到
/**
 * 作者签名不带“新鲜度”：任何持有某行旧版本签名的设备都能转发它，接收方只按“比本机新”判断。
 * 被移出的共同负责人 bob 用**未改过的客户端**、只是不去收（或收不到）移出他的那一段，就能：
 *   ① 在本机照常以负责人身份移出一位成员（触发轮换）——得到与真负责人同号的纪元 2，包裹给他本机名单里的设备（含 dave、含他自己）；
 *   ② 发出的段里转发 A 当初把他加为负责人的那一行（带 A 的签名）。
 * 对一台还没见过“bob 被加为负责人”的滞后设备 dave（例如那几天没开机）：bob 的段先被摄取时，A 签名的“bob 是负责人”一行被收下，
 * 闸门 signerOwner 成立，bob 选的纪元 2 包裹落库；A 真正的纪元 2 包裹随后到达时 INSERT OR IGNORE 被忽略。
 * 结果：dave 此后写的内容用 bob 的纪元 2 密钥加密，已被移出的 bob 能读，真负责人 A 读不了（伦理墙失效 + 可用性）。
 * 变体 R5A_VARIANT=saw：dave 先见过“bob 被加为负责人”（第四轮之前就存在的滞后窗口），用于在 a4a17d5 上对照。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { makeKernel } = await import("./helpers.ts");

const FIRM = "r5b-firm";
const usr = (s: string) => `usr_${FIRM}_${s}`;
const dev = (s: string) => `dev_${FIRM}_${s}`;
const LOG = process.env.R5A_LOG ? console.log : (..._a: unknown[]) => {};
const SAW = process.env.R5A_VARIANT === "saw";
/** R5A_VARIANT=onedir：A 的移出段与 bob 的段在同一个共享文件夹里，dave 一次摄取（按段头 lamport 排序）。 */
const ONEDIR = process.env.R5A_VARIANT === "onedir";
let kA: any;
let kB: any;
let kD: any;
let kE: any;
const others: any[] = [];

async function second(slug: string) {
  const ws = mkdtempSync(join(tmpdir(), `kwl-r5b-${slug}-`));
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
const members = (k: any, mid: string) => k.kernel.db.all(`SELECT user_id, matter_role, removed_at IS NOT NULL AS gone, author_device FROM matter_members WHERE matter_id = ? ORDER BY user_id`, [mid]);
const wrapsOf = (k: any, mid: string, d: string) => k.kernel.db.all(`SELECT epoch, substr(wrapped_key, 1, 16) AS w FROM matter_keys WHERE matter_id = ? AND wrapped_for = ? ORDER BY epoch`, [mid, d]);
const textOf = (k: any, filename: string) =>
  k.kernel.db.get(
    `SELECT pt.content AS c FROM document_versions dv JOIN parse_versions pv ON pv.document_version_id = dv.document_version_id JOIN parse_texts pt ON pt.parse_version_id = pv.parse_version_id WHERE dv.filename = ?`,
    [filename],
  )?.c ?? null;
const fresh = (p: string) => mkdtempSync(join(tmpdir(), `kwl-r5b-${p}-`));

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

test(`S11A-43（第 12 批解决）：被移出的共同负责人借转发的旧签名行与同号轮换塞进滞后设备的纪元密钥，不会让他读到滞后设备之后写的内容${SAW ? "（变体：dave 先见过 bob 是负责人）" : ""}`, { timeout: 120_000 }, async () => {
  const { matter } = await kA.inv("matters.create", { title: "移出共同负责人", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  const mid = matter.matter_id;
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("dave") });
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("erin") });
  await importText(kA, mid, "甲.txt", "甲（A 写）");
  const s0 = fresh("s0");
  await kA.inv("sync.export", { share_dir: s0, matter_id: mid });
  await kD.inv("sync.import", { share_dir: s0 });
  // A 把 bob 加为共同负责人；bob 收到
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("bob"), matter_role: "owner" });
  const s1 = fresh("s1");
  await kA.inv("sync.export", { share_dir: s1, matter_id: mid });
  await kB.inv("sync.import", { share_dir: s0 });
  await kB.inv("sync.import", { share_dir: s1 });
  if (SAW) await kD.inv("sync.import", { share_dir: s1 });
  // 伦理墙：A 移出 bob（须先把 bob 降为编辑，再移出），轮换到纪元 2；这一段 dave 暂未收到（未开机），bob 也不去收
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("bob"), matter_role: "editor" });
  const rm = await kA.inv("matters.members.remove", { matter_id: mid, user_id: usr("bob") });
  LOG("A 移出 bob：新纪元", rm.new_epoch);
  const s2 = fresh("s2");
  await kA.inv("sync.export", { share_dir: s2, matter_id: mid });
  // bob（未改过的客户端，本机仍以为自己是负责人）：移出 erin → 本机轮换到纪元 2，包裹给本机名单里的 A、dave、bob
  // bob 先在本机写几笔：他的成员变更行序号排在 A 加入 erin 那一行之后（较新者胜时才会覆盖，第五轮反向对照 R49）
  for (const i of [1, 2, 3, 4, 5]) await importText(kB, mid, `bob写${i}.txt`, `bob ${i}`);
  const brm = await kB.inv("matters.members.remove", { matter_id: mid, user_id: usr("erin") });
  LOG("bob 移出 erin：新纪元", brm.new_epoch, "包裹设备数", brm.devices_wrapped);
  const s3 = ONEDIR ? s2 : fresh("s3");
  await kB.inv("sync.export", { share_dir: s3, matter_id: mid });
  // dave 开机：共享文件夹先同步到 bob 的那一段（文件逐个到达，顺序不定），再到 A 的移出段
  const r3 = await kD.inv("sync.import", { share_dir: s3 });
  LOG("dave 摄取 bob 的段：", JSON.stringify(r3.dispositions.map((x: any) => x.outcome)), JSON.stringify(r3.origin_conflicts ?? r3.originConflicts ?? []).slice(0, 400));
  const r2 = ONEDIR ? r3 : await kD.inv("sync.import", { share_dir: s2 });
  LOG("dave 摄取 A 的移出段：", JSON.stringify(r2.dispositions.map((x: any) => x.outcome)));
  LOG("dave 成员表：", JSON.stringify(members(kD, mid)));
  LOG("dave 的纪元包裹（前 16 字符）：", JSON.stringify(wrapsOf(kD, mid, dev("dave"))));
  LOG("A 本机给 dave 的纪元 2 包裹：", JSON.stringify(wrapsOf(kA, mid, dev("dave"))));
  LOG("bob 本机给 dave 的纪元 2 包裹：", JSON.stringify(wrapsOf(kB, mid, dev("dave"))));
  // dave 此后写的内容
  await importText(kD, mid, "丁-移出后.txt", "dave 在 bob 被移出之后写的保密内容");
  // 第 12 批（成员链）：A 的“bob 降为编辑、移出 bob”与 bob 的“移出 erin + 纪元 2”是并发的——移出优先于被移出者的并发操作，
  // bob 的事件拒收（author_demoted_concurrently），erin 仍在；纪元 2 只有 A 的声明，dave 先收下的 bob 的那把被 A 的替换；没有告警
  const log = await kD.inv("matters.member_log", { matter_id: mid });
  LOG("dave 的成员链：", JSON.stringify(log.events.map((e: any) => [e.kind, e.author_member.slice(-4), e.user?.slice(-4), e.status, e.reason])));
  assert.ok(log.events.some((e: any) => e.author_member === usr("bob") && e.status === "rejected" && e.reason === "author_demoted_concurrently"), "bob 并发的移出拒收");
  assert.deepEqual((await kD.inv("relay.status")).alerts.filter((a: any) => a.matter_id === mid), [], "没有告警");
  assert.ok(members(kD, mid).some((m: any) => m.user_id === usr("erin") && !m.gone), "erin 仍是成员");
  const s4 = fresh("s4");
  await kD.inv("sync.export", { share_dir: s4, matter_id: mid });
  // 被移出的 bob 读不到；负责人 A 与仍是成员的 erin 读到
  const rb = await kB.inv("sync.import", { share_dir: s4 });
  LOG("bob 摄取 dave 的段：", JSON.stringify(rb.dispositions.map((x: any) => x.outcome)));
  assert.equal(textOf(kB, "丁-移出后.txt"), null, "被移出的成员不应读到移出之后其他成员写的内容");
  await kA.inv("sync.import", { share_dir: s4 });
  assert.equal(textOf(kA, "丁-移出后.txt"), "dave 在 bob 被移出之后写的保密内容", "负责人读到");
  await kE.inv("sync.import", { share_dir: s0 });
  await kE.inv("sync.import", { share_dir: s2 });
  await kE.inv("sync.import", { share_dir: s4 });
  assert.equal(textOf(kE, "丁-移出后.txt"), "dave 在 bob 被移出之后写的保密内容", "仍是成员的 erin 读到");
});
