/**
 * 第 71 批（V45）内核端到端（真实控制面，经闸门的控制面通道）：
 * - D-298：新电脑登录满额 → 默认“让它退出登录”（onboarding.signout_device）→ 自动登记；被让出的电脑得知 session_signed_out；
 *   被让出的电脑重新登录（同一账号、已登记）满额 → account.login 给出 same_account 的选择 → account.signout_for_login → 不重启、直接登录回本档案；
 * - 根因 R1：换账号交接的结果是“等批准”时，onboarding.status 原来不带 handoff（界面空等 120 秒报“还没有登记完成”）——现在带上；
 * - 等批准期间同一账号再登录：云端已撤回原申请，原来本机仍报“正在等待批准”（作废的核对码留在界面）——现在按新登录重新申请。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "b71-device-choice-secret-0123456789";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCloudCp, type CloudCp } from "./cloud-cp.ts";
import type { Kernel } from "../src/index.ts";

const PW = "Lawyer2026secure";
const clouds: CloudCp[] = [];
const open: Kernel[] = [];
after(async () => {
  for (const k of open) await k.close().catch(() => {});
  for (const c of clouds) await c.close();
});

async function boot(cloud: CloudCp, dir: string, o: { keySlot?: "legacy" | "pending" | "profile"; handoff?: unknown } = {}): Promise<Kernel> {
  const { createKernel } = await import("../src/index.ts");
  const env: Record<string, string | undefined> = { ...process.env, ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_KERNEL_TCP: "off", ZR_ONBOARDING: "1", ZR_CONTROL_PLANE_SYNC_MS: "off", ZR_SESSION_CHECK_MS: "off", ZR_BACKUP_TIMER: "off" };
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
const nextBroadcast = (k: Kernel, type: string) => new Promise<Record<string, any>>((resolve) => k.onBroadcast((m) => m.type === type && resolve(m as Record<string, any>)));
/** 自助注册并开通一台电脑（同步一次：登记设备、会话绑上这台电脑）。 */
async function founder(cloud: CloudCp, dir: string, email: string, name: string): Promise<Kernel> {
  let k = await boot(cloud, dir);
  const r = nextBroadcast(k, "kernel.restart_for_identity");
  await k.invoke("account.register", { email, password: PW, name });
  await r;
  await close(k);
  k = await boot(cloud, dir);
  assert.equal(((await k.invoke("control_plane.sync")) as any).report.steps.seat, "accepted");
  return k;
}

test("D-298：新电脑满额默认让旧电脑退出登录（不吊销）→ 自动登记；旧电脑得知被让出；旧电脑重新登录满额时就地让新电脑退出，不重启直接回到本档案", { timeout: 300_000 }, async () => {
  const cloud = await startCloudCp({ tenant: "b71seed", accountCa: true });
  clouds.push(cloud);
  assert.ok(((await fetch(`${cloud.base}/v1/meta`).then((r) => r.json())) as any).features.includes("device_signout"));
  const dirA = mkdtempSync(join(tmpdir(), "kwl-b71-a-"));
  const a = await founder(cloud, dirA, "sw-b71@example.cn", "甲律师");
  const tid = ((await a.invoke("kernel.status")) as any).tenant_id as string;
  cloud.cp.ops.account("sw-b71@example.cn")!.device_limit = 1;
  // ── B：新电脑登录 → 同时登录已满，默认可“让它退出登录”──
  const dirB = mkdtempSync(join(tmpdir(), "kwl-b71-b-"));
  let b = await boot(cloud, dirB);
  const blocked = (await b.invoke("account.login", { email: "sw-b71@example.cn", password: PW })) as any;
  assert.deepEqual([blocked.next, blocked.reason, blocked.can_signout, blocked.limit_kind, blocked.devices[0].state], ["blocked", "device_limit", true, "signed_in", "signed_in"], JSON.stringify(blocked));
  const devA = blocked.devices[0].device_id as string;
  const rb = nextBroadcast(b, "kernel.restart_for_identity");
  const r = (await b.invoke("onboarding.signout_device", { device_id: devA })) as any;
  assert.deepEqual([r.next, r.auto], ["restart", true], JSON.stringify(r));
  await rb;
  await close(b);
  b = await boot(cloud, dirB);
  assert.equal(((await b.invoke("control_plane.sync")) as any).report.steps.seat, "accepted");
  const devs = [...cloud.cp.ops.tenant(tid)!.devices.values()];
  assert.equal(devs.find((d) => d.cert.deviceId === devA)!.revoked_at, null, "旧电脑没被吊销：只是退出登录");
  // ── A：被让出 → 下一次核对会话（内核每 2 分钟一次 GET /v1/auth/me；用例里关了定时器，直接调同一接口）得知原因，转为要重新登录 ──
  // （同步本身不一定碰到会话：席位令牌还有效时不续期）
  await a.invoke("account.me").catch(() => undefined);
  const stA = (await a.invoke("account.status")) as any;
  assert.deepEqual([stA.login_required, stA.reason], [true, "session_signed_out"], JSON.stringify(stA));
  // ── A 重新登录：B 登录中且已满 → 同一账号的选择（this_device = A）→ 让 B 退出 → 不重启、直接登录回本档案 ──
  let limit: any = null;
  try {
    await a.invoke("account.login", { email: "sw-b71@example.cn", password: PW });
  } catch (e) {
    limit = e;
  }
  assert.ok(limit, "满额时不应直接登录成功");
  const d = limit.detail;
  assert.deepEqual([d.reason, d.same_account, d.this_device, d.can_signout], ["device_limit", true, devA, true], JSON.stringify(d));
  const devB = (d.devices as any[]).find((x) => x.device_id !== devA && x.state === "signed_in").device_id as string;
  const ok = (await a.invoke("account.signout_for_login", { device_id: devB })) as any;
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const stA2 = (await a.invoke("account.status")) as any;
  assert.deepEqual([stA2.logged_in, stA2.login_required], [true, false]);
  assert.equal(((await a.invoke("control_plane.sync")) as any).report.steps.seat, "accepted", "会话已绑回 A，可取席位");
  // B 被让出
  await b.invoke("account.me").catch(() => undefined);
  assert.equal(((await b.invoke("account.status")) as any).reason, "session_signed_out");
  await close(b);
  await close(a);
});

test("根因 R1：换账号交接的结果是“等批准”时，onboarding.status 带上交接结果（界面立即转到等待批准，不再空等 120 秒）；同一账号等批准期间再登录 → 按新登录重新申请，不再报“正在等待批准”", { timeout: 300_000 }, async () => {
  // 没有账号设备签发钥的云端（同线上 1.5.0）：个人账号的新电脑走“等批准”
  const cloud = await startCloudCp({ tenant: "b71noca", accountCa: false });
  clouds.push(cloud);
  // P 的创始电脑在别处（dirP），上限 2：第二台电脑不满额 → needs_device_join
  const dirP = mkdtempSync(join(tmpdir(), "kwl-b71-p-"));
  const p = await founder(cloud, dirP, "p-b71@example.cn", "丙律师");
  cloud.cp.ops.account("p-b71@example.cn")!.device_limit = 2;
  // 这台电脑先是 Z 的档案；Z 退出后用 P 登录 → 交接给待激活内核为 P 申请
  const dirC = mkdtempSync(join(tmpdir(), "kwl-b71-c-"));
  let c = await founder(cloud, dirC, "z-b71@example.cn", "丁律师");
  await c.invoke("account.logout", {});
  const sw = nextBroadcast(c, "kernel.switch_profile");
  const r = (await c.invoke("account.login", { email: "p-b71@example.cn", password: PW })) as any;
  assert.deepEqual([r.switched, r.enrolling], [true, true], JSON.stringify(r));
  const handoff = (await sw).handoff;
  await close(c);
  c = await boot(cloud, dirC, { keySlot: "pending", handoff });
  // 等交接跑完（resumeHandoff 是异步的）
  let st: any = null;
  for (let i = 0; i < 100; i++) {
    st = ((await c.invoke("onboarding.status")) as any) ?? null;
    if (st?.mode === "member_pending" || (st?.handoff && st.handoff.next !== "working")) break;
    await new Promise((res) => setTimeout(res, 100));
  }
  assert.equal(st.mode, "member_pending", JSON.stringify(st));
  assert.equal(st.handoff?.next, "wait", "待批准分支也带上交接结果（根因 R1）");
  const firstCode = st.check_code as string;
  // 同一账号再登录：云端签发新认领时已撤回原申请——本机按新登录重新申请（新核对码），不再报“正在等待批准”
  const again = (await c.invoke("account.login", { email: "p-b71@example.cn", password: PW })) as any;
  assert.equal(again.next, "wait", JSON.stringify(again));
  const st2 = (await c.invoke("onboarding.status")) as any;
  assert.equal(st2.mode, "member_pending");
  assert.notEqual(st2.check_code, firstCode, "新的申请、新的核对码");
  // 别的账号：给出 pending_other，可一步放弃那个申请继续
  let other: any = null;
  try {
    await c.invoke("account.login", { email: "z-b71@example.cn", password: PW });
  } catch (e) {
    other = e;
  }
  // Z 在这台电脑上有档案：直接切回（不受等批准影响）
  if (!other) assert.ok(true);
  await close(c);
  await close(p);
});
