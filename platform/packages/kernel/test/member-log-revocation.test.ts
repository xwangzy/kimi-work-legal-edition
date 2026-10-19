// 第 12 批第三轮复核 A 的处置回归（S12A-09/10）：吊销标记的链上位置、每台负责人设备补标记。共享文件夹介质，独立内核（吊销状态不串到别的用例）。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeKernel, type TestKernel } from "./helpers.ts";

const FIRM = "mlrev";
const TID = `ten_${FIRM}`;
const usr = (s: string) => `usr_${FIRM}_${s}`;
const dev = (s: string) => `dev_${FIRM}_${s}`;
const others: TestKernel[] = [];
let kA: TestKernel;

async function open(slug: string): Promise<TestKernel> {
  const d = mkdtempSync(join(tmpdir(), `kwl-mlrev-${slug}-`));
  mkdirSync(join(d, FIRM, "keys"), { recursive: true });
  copyFileSync(join(kA.dir, FIRM, "keys", "firm-root.json"), join(d, FIRM, "keys", "firm-root.json"));
  const { createKernel } = await import("../src/index.ts");
  const kernel = await createKernel({ dataDir: d, firmSlug: FIRM, userSlug: slug, env: { ...process.env, ZR_MODEL_PROVIDER: "mock" } });
  const k = { kernel, dir: d, inv: (m: string, p?: any) => kernel.invoke(m, p) } as TestKernel;
  others.push(k);
  return k;
}
const copyDev = (from: TestKernel, id: string, to: TestKernel[]) => {
  const row = from.kernel.db.get<Record<string, unknown>>(`SELECT * FROM devices WHERE device_id = ?`, [id])!;
  for (const k of to) {
    const cols = Object.keys(row);
    k.kernel.db.run(`INSERT OR IGNORE INTO devices (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, cols.map((c) => row[c]));
  }
};
const dir = (tag: string) => mkdtempSync(join(tmpdir(), `kwl-mlrev-${tag}-`));
async function pass(from: TestKernel, to: TestKernel[], mid: string): Promise<void> {
  const s = dir("p");
  await from.inv("sync.export", { share_dir: s, matter_id: mid });
  for (const k of to) await k.inv("sync.import", { share_dir: s });
}
const role = (k: TestKernel, mid: string, u: string) =>
  k.kernel.db.get<{ matter_role: string; live: number }>(`SELECT matter_role, removed_at IS NULL AS live FROM matter_members WHERE matter_id = ? AND user_id = ?`, [mid, u]);
const alerts = (k: TestKernel, mid: string) => k.kernel.db.all<{ kind: string }>(`SELECT kind FROM sync_alerts WHERE matter_id = ? ORDER BY kind`, [mid]).map((a) => a.kind);
const log = async (k: TestKernel, mid: string) => (await k.inv("matters.member_log", { matter_id: mid })).events as any[];
const revoke = (k: TestKernel, d: string, at?: string) => {
  const t = at ?? new Date().toISOString();
  k.kernel.db.run(`INSERT OR IGNORE INTO cp_revoked_devices (tenant_id, device_id, revoked_at, source) VALUES (?,?,?,?)`, [TID, d, t, "test"]);
  k.kernel.db.run(`UPDATE devices SET status = 'revoked', revoked_at = ? WHERE device_id = ?`, [t, d]);
};
const tick = () => new Promise((r) => setTimeout(r, 15));

let kB: TestKernel;
let kC: TestKernel;
let kD: TestKernel;
before(async () => {
  kA = await makeKernel({}, FIRM);
  kB = await open("bob");
  kC = await open("carol");
  kD = await open("dave");
  const all = [kA, kB, kC, kD];
  for (const [k, s] of [[kA, "test-lawyer"], [kB, "bob"], [kC, "carol"], [kD, "dave"]] as const) copyDev(k, dev(s), all.filter((x) => x !== k));
});
after(async () => {
  for (const k of others) await k.kernel.close().catch(() => {});
  await kA.kernel.close();
});

test("S12A-10：被吊销设备在吊销前做的移出——收下它的负责人设备各自补标记，吊销后才收到的设备也采信，移出生效、没有告警", { timeout: 180_000 }, async () => {
  const m = (await kA.inv("matters.create", { title: "多标记", stance: "受让方", consent_status: "not_required", collab_scope: "team" })).matter.matter_id as string;
  for (const u of ["bob", "carol"]) await kA.inv("matters.members.add", { matter_id: m, user_id: usr(u), matter_role: "owner" });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("dave") });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("erin") });
  await pass(kA, [kB, kC, kD], m);
  // carol 先加 grace（各设备在吊销之前都收到），再移出 erin（带轮换）——后者只有 bob 在 carol 的设备被吊销之前收到
  await kC.inv("matters.members.add", { matter_id: m, user_id: usr("grace") });
  await pass(kC, [kA, kB, kD], m);
  await kC.inv("matters.members.remove", { matter_id: m, user_id: usr("erin") });
  await pass(kC, [kB], m);
  await tick();
  // carol 的设备被吊销，各设备得知；A 写标记时还没收到 carol 的移出
  for (const k of [kA, kB, kD]) revoke(k, dev("carol"));
  await tick();
  await pass(kA, [kB, kD], m);
  assert.ok((await log(kA, m)).some((e) => e.kind === "mark"), "A 写了标记");
  // bob 收下过 carol 的移出（吊销之前），A 的标记没有固定它：bob 也补一条标记
  await pass(kB, [kA, kD], m);
  const marks = (await log(kD, m)).filter((e) => e.kind === "mark" && e.status === "valid");
  assert.equal(marks.length, 2, "两台负责人设备各写一条标记");
  const rm = (await log(kD, m)).find((e) => e.user === usr("erin") && e.role === null);
  assert.equal(rm?.status, "valid", "dave 在吊销之后才收到 carol 的移出，也采信（bob 的标记固定了它）");
  assert.equal(role(kD, m, usr("erin"))?.live, 0);
  assert.deepEqual(alerts(kD, m), []);
});

test("S12A-09：标记之后，尚不知道吊销的负责人设备不能替被吊销设备吊销后写的事件担保（链上的标记本身不算吊销依据）", { timeout: 180_000 }, async () => {
  const m = (await kA.inv("matters.create", { title: "标记位置", stance: "受让方", consent_status: "not_required", collab_scope: "team" })).matter.matter_id as string;
  // 第一个用例里 carol 的设备已在 A、bob、dave 上吊销；这里用 dave 作被盗设备的负责人
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: "owner" });
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("dave"), matter_role: "owner" });
  await pass(kA, [kB, kD], m);
  await kD.inv("matters.members.add", { matter_id: m, user_id: usr("henry") });
  await pass(kD, [kA, kB], m);
  await tick();
  // dave 的设备被盗、被吊销：只有 A 得知，写了标记；bob 不知道
  const daveRevokedAt = new Date().toISOString();
  revoke(kA, dev("dave"), daveRevokedAt);
  await tick();
  await kA.inv("matters.members.add", { matter_id: m, user_id: usr("frank") }); // A 写一条事件，带出标记
  await pass(kA, [kB], m);
  assert.ok((await log(kB, m)).some((e) => e.kind === "mark" && e.status === "valid"), "bob 收到 A 的标记");
  // 被盗的 dave 设备此后加 mallory 为编辑，经共享文件夹送到 bob（bob 本机不知道 dave 已吊销）
  await kD.inv("matters.members.add", { matter_id: m, user_id: usr("mallory") });
  await pass(kD, [kB], m);
  // 链上的标记本身不算吊销依据（第四轮复核 S12A-19/S12B-43：否则负责人能借标记撤销同事的移出）——bob 本机还不知道吊销，
  // 在得知之前本机采信这条事件（登记残余）；但 bob 之后写的事件因果上在 A 的标记之后，不能替它担保：知道吊销的 A 不采信
  await kB.inv("matters.members.add", { matter_id: m, user_id: usr("erin") });
  await pass(kB, [kA], m);
  assert.notEqual(role(kA, m, usr("mallory"))?.live, 1, "A 不采信 mallory（标记之后、由不知情的 bob 带来）");
  // 代价（登记残余）：bob 不知情期间写的、引用了那条事件的事件，在知情的设备上同样不成立
  assert.notEqual(role(kA, m, usr("erin"))?.live, 1, "bob 引用了它的加人在 A 上不成立");
  // bob 得知吊销后不再采信，重做即有效
  revoke(kB, dev("dave"), daveRevokedAt); // 控制面墓碑带的是真正的吊销时刻
  await pass(kA, [kB], m);
  assert.notEqual(role(kB, m, usr("mallory"))?.live, 1, "bob 得知吊销后不采信");
  await kB.inv("matters.members.add", { matter_id: m, user_id: usr("erin") });
  await pass(kB, [kA], m);
  assert.equal(role(kA, m, usr("erin"))?.live, 1, "重做后有效");
});
