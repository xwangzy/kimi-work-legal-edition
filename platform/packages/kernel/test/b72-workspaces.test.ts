/**
 * 第 72 批（V46，D-305，契约 02 §7）端到端：一个人、多个工作空间。真实控制面（带账号设备签发钥）+ 两个内核数据根（甲、乙各一台电脑），全程经内核方法。
 * - 旧云端（/v1/meta 没有 workspaces 等能力）：workspaces.list / teams.join / account.onboarding 一律 { supported: false }，不抛错；
 * - 乙在自己电脑上把个人工作室升级为团队（workspace.upgrade）、发团队邀请（team.invites.create）；
 * - 甲在自己电脑上接受邀请（teams.join）→ 与第 68 批换账号同形：switched + enrolling，交接给待激活内核 → 这台电脑为甲的团队身份开通新档案；
 * - 甲在团队空间 workspaces.list：个人空间 local_profile = true → workspaces.switch 切回（已有档案：会话随交接直接进，事项都在）→ 再切到团队（已有档案）。
 *
 * 出站闸门的控制面白名单（packages/egress-gate/src/cp-relay.ts）第 72 批已放行这些路径并在 docs/privacy/egress-paths.json 登记：
 * 全程经真实闸门、真实控制面（不再在用例内转发）；白名单未放行时的降级分支保留（gatePathOpen 为假时核 supported:false）。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "b72-workspaces-secret-0123456789ab";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cpRelayAllowed } from "@zr-legal/egress-gate";
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

/** 在一个新数据根上自助注册开通（第一个档案），重启后同步一次；返回已开通的内核。 */
async function registerOn(dir: string, email: string, name: string): Promise<Kernel> {
  let k = await boot(dir);
  const ra = nextBroadcast(k, "kernel.restart_for_identity");
  await k.invoke("account.register", { email, password: PW, name });
  await ra;
  await close(k);
  k = await boot(dir);
  assert.equal(((await k.invoke("control_plane.sync")) as any).report.steps.seat, "accepted");
  return k;
}

test("旧云端：工作空间、团队与上手状态一律 { supported: false }，不抛错；当前一项取自 /v1/auth/me", { timeout: 240_000 }, async () => {
  cloud = await startCloudCp({ tenant: "b72seed", accountCa: true });
  const dir = mkdtempSync(join(tmpdir(), "kwl-b72-legacy-"));
  const k = await registerOn(dir, "legacy-b72@example.cn", "丙律师");
  cloud.setLegacyCloud(true);
  try {
    // signedLogin 的 /v1/meta 缓存 60 秒：新内核里第一次取就是旧云端
    const ws = (await k.invoke("workspaces.list")) as any;
    assert.equal(ws.supported, false, JSON.stringify(ws));
    assert.ok(Array.isArray(ws.workspaces));
    assert.deepEqual((await k.invoke("teams.join", { code: "ABCD-EFGH-2345-6789" })) as any, { supported: false });
    assert.equal(((await k.invoke("account.onboarding")) as any).supported, false);
    assert.equal(((await k.invoke("team.invites.list")) as any).supported, false);
    await assert.rejects(k.invoke("teams.join", { code: "abc" }), /邀请码是 16 位/);
    await assert.rejects(k.invoke("workspace.upgrade", { name: "x" }), /2～40/);
  } finally {
    cloud.setLegacyCloud(false);
  }
  await close(k);
});

test("一个人多个工作空间：乙升级为团队并发邀请 → 甲接受（新档案开通）→ 列表里个人空间已在这台电脑 → 切回个人（直接进、事项都在）→ 再切到团队", { timeout: 420_000 }, async () => {
  cloud ??= await startCloudCp({ tenant: "b72seed", accountCa: true });
  const meta = await fetch(`${cloud.base}/v1/meta`).then((r) => r.json() as Promise<any>);
  if (!meta.features?.includes("workspaces") || !meta.features?.includes("team_invites")) {
    // 云端还没实现：只核降级
    return;
  }

  // ── 乙：在自己电脑上开通，升级为团队，发邀请 ──
  const dirB = mkdtempSync(join(tmpdir(), "kwl-b72-b-"));
  const kb = await registerOn(dirB, "b-b72@example.cn", "乙律师");
  // 闸门白名单还没放行时：如实降级
  const gatePathOpen = cpRelayAllowed({ method: "POST", path: "/v1/workspace/upgrade", headers: {}, body: "" }) === null;
  if (!gatePathOpen) assert.deepEqual(await kb.invoke("workspace.upgrade", { name: "乙律师事务所" }), { supported: false, reason: "gate_path_not_allowed" });
  const up = (await kb.invoke("workspace.upgrade", { name: "乙律师事务所" })) as any;
  assert.equal(up.ok, true, JSON.stringify(up));
  assert.equal(((await kb.invoke("kernel.status")) as any).workspace_kind, "team", "升级后本机状态即为团队");
  const inv = (await kb.invoke("team.invites.create", { name: "甲律师", role: "lawyer" })) as any;
  assert.match(String(inv.code), /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/, JSON.stringify(inv));
  assert.ok(((await kb.invoke("team.invites.list")) as any).invites.length >= 1);
  await close(kb);

  // ── 甲：在自己电脑上开通个人工作室，有一件事项 ──
  const dir = mkdtempSync(join(tmpdir(), "kwl-b72-a-"));
  let k = await registerOn(dir, "a-b72@example.cn", "甲律师");
  const stA = (await k.invoke("kernel.status")) as any;
  const m = (await k.invoke("matters.create", { title: "甲的个人事项", stance: "原告", consent_status: "not_required" })) as any;
  assert.ok(m.matter.matter_id);
  const ws0 = (await k.invoke("workspaces.list")) as any;
  assert.equal(ws0.supported, true, JSON.stringify(ws0));
  assert.deepEqual(ws0.workspaces.map((w: any) => [w.kind, w.current, w.local_profile]), [["personal", true, true]]);
  assert.equal(((await k.invoke("kernel.status")) as any).workspace_kind, "personal");
  const personalAid = ws0.current.aid as string;

  // ── 甲接受邀请：与第 68 批换账号同形（新档案开通）──
  const sw = nextBroadcast(k, "kernel.switch_profile");
  const j = (await k.invoke("teams.join", { code: inv.code })) as any;
  assert.deepEqual([j.switched, j.enrolling], [true, true], JSON.stringify(j));
  const h1 = (await sw).handoff as ProfileHandoff;
  assert.equal(h1.kind, "auth");
  // 切走前本档案的会话已删（安全复核 P-2：切回来要用那个档案自己的会话）
  await assert.rejects(k.invoke("teams.join", { code: inv.code }), /登录已失效/);
  await close(k);
  k = await boot(dir, { keySlot: "pending", handoff: h1 });
  const rb = nextBroadcast(k, "kernel.restart_for_identity");
  await rb;
  await close(k);
  k = await boot(dir, { keySlot: "profile" });
  const stT = (await k.invoke("kernel.status")) as any;
  assert.equal(stT.account.logged_in, true, JSON.stringify(stT.account));
  assert.notEqual(stT.tenant_id, stA.tenant_id, "团队空间是另一个租户");
  assert.notEqual(stT.profile.id, stA.profile.id, "另一个档案");
  assert.equal(stT.device_issuer, "account_ca", "团队成员新电脑由账号签发钥直接登记（D-304）");
  assert.ok(!JSON.stringify(await k.invoke("matters.list")).includes("甲的个人事项"), "团队空间看不到个人事项");
  const ws1 = (await k.invoke("workspaces.list")) as any;
  assert.deepEqual(ws1.workspaces.map((w: any) => [w.kind, w.current, w.local_profile]), [["personal", false, true], ["team", true, true]], JSON.stringify(ws1));
  assert.equal(((await k.invoke("kernel.status")) as any).workspace_kind, "team");

  // ── 切回个人空间：这台电脑上已有档案 → 会话随交接直接进 ──
  const sw2 = nextBroadcast(k, "kernel.switch_profile");
  const r2 = (await k.invoke("workspaces.switch", { aid: personalAid })) as any;
  assert.equal(r2.switched, true, JSON.stringify(r2));
  assert.equal(r2.enrolling, undefined);
  const h2 = (await sw2).handoff as ProfileHandoff;
  assert.equal(h2.kind, "session");
  assert.equal(readJson(join(dir, "activation.json")).tid, stA.tenant_id);
  await close(k);
  k = await boot(dir, { handoff: h2 });
  const stA2 = (await k.invoke("kernel.status")) as any;
  assert.equal(stA2.profile.id, stA.profile.id);
  assert.equal(stA2.account.logged_in, true);
  assert.ok(JSON.stringify(await k.invoke("matters.list")).includes("甲的个人事项"), "个人事项都在");
  assert.deepEqual(await k.invoke("workspaces.switch", { aid: personalAid }), { ok: true, switched: false, same: true }, "切到当前这个：不动");

  // 不是自己的工作空间：云端不区分“不存在”与“不是你的”
  await assert.rejects(k.invoke("workspaces.switch", { aid: "acc_not_mine_0001" }), /没有找到这个工作空间|没有这个工作空间/);
  // ── 再切到团队空间：已有档案 ──
  const teamAid = ws1.current.aid as string;
  const sw3 = nextBroadcast(k, "kernel.switch_profile");
  const r3 = (await k.invoke("workspaces.switch", { aid: teamAid })) as any;
  assert.equal(r3.switched, true, JSON.stringify(r3));
  assert.equal(((await sw3).handoff as ProfileHandoff).kind, "session");
  await close(k);
  assert.ok(existsSync(join(dir, "activation.json")));
});

// ─── A1 H2：首次同步没成按退避重试（不再等 10 分钟） ───
test("首次同步：启动时控制面不可达 → 按退避重试，恢复后几秒内取得席位令牌；SyncReport 带各段用时", { timeout: 240_000 }, async () => {
  cloud ??= await startCloudCp({ tenant: "b72seed", accountCa: true });
  const dir = mkdtempSync(join(tmpdir(), "kwl-b72-h2-"));
  const k0 = await registerOn(dir, "h2-b72@example.cn", "丁律师");
  await close(k0);
  cloud.setControlPlaneAvailable(false);
  const { createKernel } = await import("../src/index.ts");
  const env: Record<string, string | undefined> = { ...process.env, ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_KERNEL_TCP: "off", ZR_ONBOARDING: "1", ZR_CONTROL_PLANE_SYNC_MS: "600000", ZR_CP_FIRST_RETRY_MS: "300,600,1200,2400", ZR_SESSION_CHECK_MS: "off", ZR_MODEL_CATALOG_MS: "off", ZR_BACKUP_TIMER: "off" };
  delete env.ZR_SEAT_TOKEN;
  const k = await createKernel({ dataDir: dir, env: env as NodeJS.ProcessEnv });
  open.push(k);
  try {
    await new Promise((r) => setTimeout(r, 400));
    const st0 = (await k.invoke("control_plane.status")) as any;
    assert.notEqual(st0.last_sync?.steps?.register, "ok", "第一次同步没成");
    cloud.setControlPlaneAvailable(true);
    const until = Date.now() + 15_000;
    let st: any = null;
    while (Date.now() < until) {
      st = (await k.invoke("control_plane.status")) as any;
      // 席位令牌在上一次启动时已取得并留在本机：以“这次启动后的同步登记上了、席位这一步成了”为准
      if (st.last_sync?.steps?.register === "ok" && ["accepted", "valid", "unchanged"].includes(st.last_sync?.steps?.seat)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(st.last_sync?.steps?.register, "ok", JSON.stringify(st.last_sync));
    assert.ok(["accepted", "valid", "unchanged"].includes(st.last_sync.steps.seat), JSON.stringify(st.last_sync));
    assert.equal(st.seat?.has_token, true);
    assert.equal(typeof st.last_sync.ms?.total, "number");
    assert.equal(typeof st.last_sync.ms?.seat, "number");
  } finally {
    cloud.setControlPlaneAvailable(true);
    await close(k);
  }
});

// ─── A1 H1：残留的失败记录不再误报 ───
test("待激活内核：登录开始即删掉上一轮留下的失败记录（不再一进页面就报“没有完成”）", { timeout: 120_000 }, async () => {
  cloud ??= await startCloudCp({ tenant: "b72seed", accountCa: true });
  const dir = mkdtempSync(join(tmpdir(), "kwl-b72-h1-"));
  const { writeJoinFailure } = await import("../src/services/onboarding.ts");
  writeJoinFailure(dir, "missing");
  const k = await boot(dir);
  assert.equal(((await k.invoke("kernel.status")) as any).onboarding.last_failure?.code, "missing", "登录前照旧显示上一次的原因");
  await assert.rejects(k.invoke("account.login", { email: "nobody-b72@example.cn", password: PW }));
  assert.equal(((await k.invoke("kernel.status")) as any).onboarding.last_failure, undefined, "这一轮登录开始后不再报上一轮的失败");
  assert.equal(existsSync(join(dir, "onboarding-failed.json")), false);
  await close(k);
});
