/**
 * 第 68 批（V42，D-294）端到端：同一台电脑（同一个数据根）上换账号。真实控制面（带账号设备签发钥）+ 一个内核数据根，全程经闸门的控制面通道。
 * 复现用户报告：第 67 批安装包退出登录后换另一个账号登录，提示“这台电脑已登记为本所另一位成员：请用那位成员的账号登录”。
 * - A 自助注册开通 → 有事项；A 退出登录，在同一页用 B 的账号登录 → 不再被拒：答复 switched + enrolling，内核把 A 的档案留在原工作区、
 *   交接（B 那次登录的答复，只在内存）给下一个内核 → 待激活内核按交接为 B 开通（B 是网页注册、还没开通的个人工作室）→ B 打开自己的工作区：
 *   看不到 A 的事项；A 的工作区、账本、密钥都还在原处；
 * - B 退出，再用 A 登录 → 这台电脑上已有 A 的档案：直接切回 A（会话随交接写进 A 的工作区，打开即已登录），A 的事项还在；
 * - 主进程的密钥格：已有档案时待激活用另一格（keySlot = pending），新档案的激活记录带 key_slot = 目录名；
 * - 云端：/v1/meta 公布 account_switch；带 A 的设备签名登录 B 时云端不拒、会话不绑 A 的电脑。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "b68-account-switch-secret-0123456789";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCloudCp, type CloudCp } from "./cloud-cp.ts";
import type { Kernel } from "../src/index.ts";
import type { ProfileHandoff } from "../src/profiles.ts";

const PW = "Lawyer2026secure";
let cloud: CloudCp | null = null;
const open: Kernel[] = [];
after(async () => {
  for (const k of open) await k.close().catch(() => {});
  await cloud?.close();
});

async function boot(dir: string, o: { keySlot?: "legacy" | "pending" | "profile"; handoff?: unknown } = {}): Promise<Kernel> {
  const { createKernel } = await import("../src/index.ts");
  const env: Record<string, string | undefined> = { ...process.env, ...cloud!.env, ZR_MODEL_PROVIDER: "upstream", ZR_KERNEL_TCP: "off", ZR_ONBOARDING: "1", ZR_CONTROL_PLANE_SYNC_MS: "off", ZR_BACKUP_TIMER: "off" };
  delete env.ZR_FIRM_SLUG;
  delete env.ZR_USER_SLUG;
  delete env.ZR_SEAT_TOKEN;
  const k = await createKernel({ dataDir: dir, env: env as NodeJS.ProcessEnv, ...(o.keySlot ? { keySlot: o.keySlot } : {}), ...(o.handoff ? { handoff: o.handoff } : {}) });
  open.push(k);
  return k;
}
async function close(k: Kernel): Promise<void> {
  await k.close();
  open.splice(open.indexOf(k), 1);
}
const nextBroadcast = (k: Kernel, type: string) => new Promise<Record<string, unknown>>((resolve) => k.onBroadcast((m) => m.type === type && resolve(m)));
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

test("同一台电脑换账号：A 退出后用 B 登录 → 为 B 开通独立工作区（看不到 A 的事项）；B 退出后用 A 登录 → 直接切回 A（已登录、事项都在）", { timeout: 300_000 }, async () => {
  cloud = await startCloudCp({ tenant: "b68seed", accountCa: true });
  const meta = await fetch(`${cloud.base}/v1/meta`).then((r) => r.json() as Promise<any>);
  assert.equal(meta.account_switch, true);
  assert.ok(meta.features.includes("account_switch") && meta.features.includes("device_limit_unbind"));

  const dir = mkdtempSync(join(tmpdir(), "kwl-b68-"));
  // ── A：在这台电脑上自助注册开通（第一个档案：密钥格 legacy）──
  let k = await boot(dir);
  const ra = nextBroadcast(k, "kernel.restart_for_identity");
  await k.invoke("account.register", { email: "a-b68@example.cn", password: PW, name: "甲律师" });
  await ra;
  await close(k);
  k = await boot(dir);
  // 安装包里开通后立即同步（登记设备、律所根入组）；用例里同步定时器关着，手动同步一次
  assert.equal(((await k.invoke("control_plane.sync")) as any).report.steps.seat, "accepted");
  const stA = (await k.invoke("kernel.status")) as any;
  assert.equal(stA.account.logged_in, true);
  const profA = stA.profile.id as string;
  assert.match(profA, /^[0-9a-f]{16}$/);
  const actA = readJson(join(dir, "activation.json"));
  assert.equal(actA.workspace, undefined, "第一个档案沿用律所标识作目录");
  assert.equal(actA.key_slot, undefined, "第一个档案沿用 ledger-key");
  assert.ok(existsSync(join(dir, actA.firm_slug, "profile.json")), "工作区里留一份档案记录");
  const m = (await k.invoke("matters.create", { title: "甲的保密事项", stance: "原告", client_name: "甲方客户", counterparty: "乙方", consent_status: "not_required" })) as any;
  assert.ok(m.matter.matter_id);

  // ── B：网页注册（还没有任何电脑），A 退出后在这台电脑上用 B 登录 ──
  const regB = await fetch(`${cloud.base}/v1/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "b-b68@example.cn", password: PW, name: "乙律师", client: { platform: "web" } }) });
  assert.equal(regB.status, 200);
  await k.invoke("account.logout", {});
  assert.equal(((await k.invoke("account.status")) as any).login_required, true);
  const sw = nextBroadcast(k, "kernel.switch_profile");
  const r = (await k.invoke("account.login", { email: "b-b68@example.cn", password: PW })) as any;
  assert.equal(r.switched, true, JSON.stringify(r));
  assert.equal(r.enrolling, true);
  const h1 = (await sw).handoff as ProfileHandoff;
  assert.equal(h1.kind, "auth");
  // A 的档案原样留下：激活记录移走（这台电脑换到待激活），A 的工作区与档案记录还在
  assert.ok(!existsSync(join(dir, "activation.json")));
  assert.ok(existsSync(join(dir, actA.firm_slug, "ledger.db")));
  assert.ok(existsSync(join(dir, actA.firm_slug, "profile.json")));
  await close(k);

  // ── 主进程按交接重启：待激活（这台电脑已有别的档案 → 另一格密钥）→ 内核按 B 的登录答复开通 B ──
  k = await boot(dir, { keySlot: "pending", handoff: h1 });
  const rb = nextBroadcast(k, "kernel.restart_for_identity");
  const stPending = (await k.invoke("kernel.status")) as any;
  assert.ok(stPending.onboarding, "待激活");
  // 只报个数，不列姓名（交接在启动时即开始处理：读到状态时 B 的档案可能已写下，个数为 1 或 2）
  assert.ok(stPending.onboarding.other_profiles >= 1, JSON.stringify(stPending.onboarding));
  assert.ok(!JSON.stringify(stPending.onboarding).includes("甲律师"));
  await rb;
  const actB = readJson(join(dir, "activation.json"));
  assert.notEqual(actB.firm_slug, actA.firm_slug);
  assert.equal(actB.key_slot, actB.workspace ?? actB.firm_slug, "新档案的密钥格 = 目录名（主进程据此把待激活那把归它）");
  await close(k);
  k = await boot(dir, { keySlot: "profile" });
  const stB = (await k.invoke("kernel.status")) as any;
  assert.equal(stB.account.logged_in, true, JSON.stringify(stB.account));
  assert.notEqual(stB.profile.id, profA);
  assert.notEqual(stB.tenant_id, stA.tenant_id);
  const listB = (await k.invoke("matters.list")) as any;
  assert.ok(!JSON.stringify(listB).includes("甲的保密事项"), "B 看不到 A 的事项");

  // ── B 退出，再用 A 登录：这台电脑上已有 A 的档案 → 直接切回（不重复登记设备）──
  const devicesBefore = [...cloud.cp.ops.tenant(stA.tenant_id)!.devices.values()].filter((d) => !d.revoked_at).length;
  await k.invoke("account.logout", {});
  const sw2 = nextBroadcast(k, "kernel.switch_profile");
  const r2 = (await k.invoke("account.login", { email: "a-b68@example.cn", password: PW })) as any;
  assert.equal(r2.switched, true, JSON.stringify(r2));
  assert.equal(r2.enrolling, undefined);
  const h2 = (await sw2).handoff as ProfileHandoff;
  assert.equal(h2.kind, "session");
  assert.equal(readJson(join(dir, "activation.json")).firm_slug, actA.firm_slug, "当前档案指回 A");
  await close(k);
  k = await boot(dir, { handoff: h2 });
  const stA2 = (await k.invoke("kernel.status")) as any;
  assert.equal(stA2.profile.id, profA);
  assert.equal(stA2.account.logged_in, true, "会话随交接写进 A 的工作区，打开即已登录");
  const listA = (await k.invoke("matters.list")) as any;
  assert.ok(JSON.stringify(listA).includes("甲的保密事项"), "A 的事项还在");
  const sync = (await k.invoke("control_plane.sync")) as any;
  assert.equal(sync.report.steps.seat, "accepted", JSON.stringify(sync.report.steps));
  assert.equal([...cloud.cp.ops.tenant(stA.tenant_id)!.devices.values()].filter((d) => !d.revoked_at).length, devicesBefore, "切回 A 不新登记设备");

  // ── 交接只认属于本档案的会话：拿 B 的会话交接打开 A 的档案 → 不采用 ──
  await k.invoke("account.logout", {});
  await close(k);
  k = await boot(dir, { handoff: { v: 1, kind: "session", tid: stB.tenant_id, member_slug: actB.member_slug, session: { token: "kws1.ses_AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", aid: "acc_x", email: "b-b68@example.cn", name: "乙律师", tid: stB.tenant_id, role: "admin" } } });
  const stA3 = (await k.invoke("kernel.status")) as any;
  assert.equal(stA3.account.logged_in, false, "别的账号的会话不写进本档案");
  await close(k);
});

test("电脑数已满（试用套餐 1 台）：新电脑登录给出已登记的电脑、可就地移除一台（不再输密码、不再收验证码）→ 自动登记这台电脑", { timeout: 240_000 }, async () => {
  const dirA = mkdtempSync(join(tmpdir(), "kwl-b68-la-"));
  let a = await boot(dirA);
  const ra = nextBroadcast(a, "kernel.restart_for_identity");
  await a.invoke("account.register", { email: "lim-b68@example.cn", password: PW, name: "丙律师" });
  await ra;
  await close(a);
  a = await boot(dirA);
  assert.equal(((await a.invoke("control_plane.sync")) as any).report.steps.seat, "accepted");
  const tid = ((await a.invoke("kernel.status")) as any).tenant_id as string;
  // 第 72 批：试用套餐缺省改为 2 台（产品评分 F6）——这条测“满额 → 就地移除一台”，显式把这个账号设成 1 台
  cloud!.cp.ops.account("lim-b68@example.cn")!.device_limit = 1;
  const dirB = mkdtempSync(join(tmpdir(), "kwl-b68-lb-"));
  const b = await boot(dirB);
  const blocked = (await b.invoke("account.login", { email: "lim-b68@example.cn", password: PW })) as any;
  assert.deepEqual([blocked.next, blocked.reason, blocked.can_unbind, blocked.devices.length], ["blocked", "device_limit", true, 1], JSON.stringify(blocked));
  const first = blocked.devices[0].device_id as string;
  const rb = nextBroadcast(b, "kernel.restart_for_identity");
  const r = (await b.invoke("onboarding.unbind_device", { device_id: first })) as any;
  assert.deepEqual([r.next, r.auto], ["restart", true], JSON.stringify(r));
  await rb;
  const devs = [...cloud!.cp.ops.tenant(tid)!.devices.values()];
  assert.ok(devs.find((d) => d.cert.deviceId === first)!.revoked_at, "第一台已移除");
  assert.equal(devs.filter((d) => !d.revoked_at).length, 1, "仍只有 1 台在用");
  await close(b);
  await close(a);
});

test("安全复核 U-1：这台电脑在云端已被移除时，同一账号重新登录不算成功（如实说“已被停用”）；换成别的账号照常可以", { timeout: 240_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-b68-rv-"));
  let k = await boot(dir);
  const r0 = nextBroadcast(k, "kernel.restart_for_identity");
  await k.invoke("account.register", { email: "rv-b68@example.cn", password: PW, name: "戊律师" });
  await r0;
  await close(k);
  k = await boot(dir);
  assert.equal(((await k.invoke("control_plane.sync")) as any).report.steps.seat, "accepted");
  const st = (await k.invoke("kernel.status")) as any;
  await k.invoke("account.logout", {});
  // 在云端移除这台电脑（等同本人在别处“移除”）
  const t = cloud!.cp.ops.tenant(st.tenant_id)!;
  const dev = [...t.devices.values()].find((d) => !d.revoked_at)!;
  cloud!.cp.ops.revokeDevice(st.tenant_id, dev.cert.deviceId, { by: "test" });
  // 第 69 批（V43）：说法改为“已从这个账号移除”（个人账号是本人在别处移除，不是“律所停用”），并指出可以登录其他账号
  await assert.rejects(k.invoke("account.login", { email: "rv-b68@example.cn", password: PW }), /已从这个账号移除，不能再用这个账号登录；可以登录其他账号/);
  assert.equal(((await k.invoke("account.status")) as any).logged_in, false, "没有算登录成功");
  // 换成别的账号：照常（不签名重登 → 为新账号开通）
  const regX = await fetch(`${cloud!.base}/v1/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "rv2-b68@example.cn", password: PW, name: "己律师", client: { platform: "web" } }) });
  assert.equal(regX.status, 200);
  const r = (await k.invoke("account.login", { email: "rv2-b68@example.cn", password: PW })) as any;
  assert.equal(r.switched, true, JSON.stringify(r));
  await close(k);
});
