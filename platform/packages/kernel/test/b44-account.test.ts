/**
 * 第 44 批我方账号（主文 §2）端到端：真实控制面 + 内核实例（两个数据根），全程经闸门的控制面通道。
 * - 自助注册：待激活模式 account.register → 创始开通（律所根在本机生成、凭账号认领登记）→ 按新身份重启 → 已登录；
 *   会话令牌只在封装的 keys/account-session.json，渲染层看不到；
 * - 账号闸：退出登录 → 本机席位令牌清掉、控制面拒签（要重新登录）→ account.login（带设备签名、会话绑本机）→ 席位令牌恢复；
 * - 同一账号的第二台电脑：设备上限按套餐（试用 1 台）→ 运营调到 2 台 → 新电脑 account.login 凭账号入组（_D2、无邀请码本机段）→
 *   第一台（管理员）列出申请、核对码一致、标明“账号新设备”→ 批准 → 第二台取回证书、重启、取得同一席位的令牌。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "b44-account-test-secret-0123456789ab";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCloudCp, type CloudCp } from "./cloud-cp.ts";
import type { Kernel } from "../src/index.ts";

const PW = "Lawyer2026secure";
let cloud: CloudCp | null = null;
const open: Kernel[] = [];
after(async () => {
  for (const k of open) await k.close().catch(() => {});
  await cloud?.close();
});

async function boot(dir: string): Promise<Kernel> {
  const { createKernel } = await import("../src/index.ts");
  const env: Record<string, string | undefined> = { ...process.env, ...cloud!.env, ZR_MODEL_PROVIDER: "upstream", ZR_KERNEL_TCP: "off", ZR_ONBOARDING: "1", ZR_CONTROL_PLANE_SYNC_MS: "off" };
  delete env.ZR_FIRM_SLUG;
  delete env.ZR_USER_SLUG;
  delete env.ZR_SEAT_TOKEN;
  const k = await createKernel({ dataDir: dir, env: env as NodeJS.ProcessEnv });
  open.push(k);
  return k;
}
const nextRestart = (k: Kernel) => new Promise<void>((resolve) => k.onBroadcast((m) => m.type === "kernel.restart_for_identity" && resolve()));
async function reboot(k: Kernel, dir: string): Promise<Kernel> {
  await k.close();
  open.splice(open.indexOf(k), 1);
  return boot(dir);
}
/** 数据根下所有文件里都不能有这个串（令牌、密码不落明文）。 */
function absentEverywhere(dir: string, needle: string): boolean {
  const walk = (d: string): boolean => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!walk(p)) return false;
      } else if (e.isFile() && readFileSync(p).includes(Buffer.from(needle))) return false;
    }
    return true;
  };
  return walk(dir);
}

test("自助注册 → 创始开通 → 重启即已登录；退出登录后控制面拒签、席位令牌清掉；本机重新登录（会话绑本机）后恢复；密码与令牌不落明文", { timeout: 240_000 }, async () => {
  cloud = await startCloudCp({ tenant: "ten_b44-unused" });
  const dirA = mkdtempSync(join(tmpdir(), "kwl-b44-a-"));
  let a = await boot(dirA);
  // 待激活模式开放账号方法；其余仍 not_activated
  await assert.rejects(a.invoke("account.me", {}), (e: any) => e.code === "not_activated");
  await assert.rejects(a.invoke("account.register", { email: "bad", password: PW, name: "王律师" }), (e: any) => e.code === "validation" && /邮箱格式/.test(e.message));
  await assert.rejects(a.invoke("account.register", { email: "wang@example.cn", password: "short1", name: "王律师" }), (e: any) => /至少 10 位/.test(e.message));
  const restartA = nextRestart(a);
  const r = (await a.invoke("account.register", { email: "Wang@Example.cn", password: PW, name: "王律师", org_name: "王律师工作室" })) as any;
  assert.equal(r.kind, "founder");
  assert.equal(r.next, "restart");
  assert.equal(r.account.email, "wang@example.cn");
  await restartA;
  a = await reboot(a, dirA);
  const st = (await a.invoke("kernel.status")) as any;
  assert.equal(st.activation.kind, "founder");
  assert.equal(st.member_role, "firm_admin");
  assert.deepEqual([st.account.logged_in, st.account.email, st.account.login_required], [true, "wang@example.cn", false]);
  assert.equal(JSON.stringify(st).includes("kws1."), false, "状态里没有会话令牌");
  const sync = (await a.invoke("control_plane.sync")) as any;
  assert.equal(sync.report.steps.register, "ok", JSON.stringify(sync.report.steps));
  assert.equal(sync.report.steps.seat, "accepted", JSON.stringify(sync.report.steps));
  const tid = st.tenant_id;
  assert.equal(cloud.cp.ops.tenant(tid)!.accounts_required, true);
  // 会话令牌只在封装文件里；密码在数据根里找不到
  assert.ok(existsSync(join(dirA, st.firm, "keys", "account-session.json")));
  // 封装与否随数据库主密钥（安装包 ZR_AT_REST=required 必有；开发与测试形态没有主密钥时明文，同其他密钥文件）
  if (process.env.ZR_DB_KEY) assert.ok(!readFileSync(join(dirA, st.firm, "keys", "account-session.json"), "utf8").includes("kws1."), "会话文件是封装的");
  assert.ok(absentEverywhere(dirA, PW), "密码不落盘");
  // 本人资料：设备与登录
  const me = (await a.invoke("account.me", {})) as any;
  assert.equal(me.devices.length, 1);
  assert.equal(me.devices[0].current, true);
  // 退出登录：本机席位令牌清掉、状态要求登录；同步时控制面拒签
  await a.invoke("account.logout", {});
  const st2 = (await a.invoke("kernel.status")) as any;
  assert.deepEqual([st2.account.logged_in, st2.account.login_required], [false, true]);
  assert.equal(st2.control_plane.seat?.has_token ?? false, false);
  const s2 = (await a.invoke("control_plane.sync")) as any;
  assert.equal(s2.report.steps.seat, "session_required");
  // 第 64 批：“要重新登录”记在本机（封装、不含令牌）——重启内核后不用等同步，启动即要求登录并记得上次的邮箱（重新登录页预填）
  const mark = join(dirA, st.firm, "keys", "account-login-required.json");
  assert.ok(existsSync(mark), "退出登录写下本机记录");
  assert.equal(readFileSync(mark, "utf8").includes("kws1."), false, "记录里没有会话令牌");
  a = await reboot(a, dirA);
  const st3 = (await a.invoke("kernel.status")) as any;
  assert.deepEqual([st3.account.logged_in, st3.account.login_required, st3.account.reason, st3.account.last_email], [false, true, "session_required", "wang@example.cn"], "重启后仍要求登录");
  assert.equal(((await a.invoke("account.status", {})) as any).last_account?.email, "wang@example.cn");
  await assert.rejects(a.invoke("account.login", { email: "wang@example.cn", password: "Wrong2026password" }), (e: any) => /邮箱或密码不正确/.test(e.message));
  assert.ok(existsSync(mark), "登录失败不删记录");
  const li = (await a.invoke("account.login", { email: "wang@example.cn", password: PW })) as any;
  assert.equal(li.ok, true);
  assert.equal(existsSync(mark), false, "重新登录成功即删本机记录");
  const s3 = (await a.invoke("control_plane.sync")) as any;
  assert.equal(s3.report.steps.seat, "accepted", JSON.stringify(s3.report.steps));
  assert.equal(((await a.invoke("account.status", {})) as any).logged_in, true);
});

test("同一账号第二台电脑：设备上限（试用 1 台）→ 调到 2 台 → 凭账号入组（_D2、无邀请码本机段）→ 第一台核对码一致后批准 → 第二台取得席位令牌", { timeout: 240_000 }, async () => {
  const dirA = mkdtempSync(join(tmpdir(), "kwl-b44-c-"));
  let a = await boot(dirA);
  const ra = nextRestart(a);
  await a.invoke("account.register", { email: "zhao@example.cn", password: PW, name: "赵律师" });
  await ra;
  a = await reboot(a, dirA);
  assert.equal(((await a.invoke("control_plane.sync")) as any).report.steps.seat, "accepted");
  // 第 72 批：试用缺省改为同时登录 2 台（产品评分 F6）——这条测“满额 → 调高”，显式设成 1 台
  cloud!.cp.ops.account("zhao@example.cn")!.device_limit = 1;
  const dirB = mkdtempSync(join(tmpdir(), "kwl-b44-d-"));
  let b = await boot(dirB);
  const blocked = (await b.invoke("account.login", { email: "zhao@example.cn", password: PW })) as any;
  assert.equal(blocked.next, "blocked");
  // 第 68 批（V42，D-295）：上限由云端设定；带上已登记的电脑（可就地移除一台）
  assert.match(blocked.message, /云端设定的上限/);
  assert.equal(blocked.reason, "device_limit");
  assert.equal(blocked.devices.length, 1);
  cloud!.cp.ops.account("zhao@example.cn")!.device_limit = 2;
  const jb = (await b.invoke("account.login", { email: "zhao@example.cn", password: PW })) as any;
  assert.deepEqual([jb.kind, jb.next, jb.via_account], ["member", "wait", true]);
  assert.match(jb.check_code, /^\d{3} \d{3} \d{3} \d{3}$/);
  const stB = (await b.invoke("onboarding.status")) as any;
  assert.equal(stB.via_account, true);
  // 第一台（管理员）列出：账号新设备、核对码一致、核对通过
  const list = (await a.invoke("members.list")) as any;
  const jr = list.join_requests.find((x: any) => x.via === "account");
  assert.ok(jr, JSON.stringify(list.join_requests));
  assert.equal(jr.check_code, jb.check_code);
  assert.equal(jr.verified, true);
  assert.equal(jr.account_email, "zhao@example.cn");
  await a.invoke("members.approve", { join_request_id: jr.id });
  const rb = nextRestart(b);
  const chk = (await b.invoke("onboarding.check")) as any;
  assert.equal(chk.last_check, "approved");
  assert.equal(chk.via_account, true);
  assert.equal(chk.firm_check_code, list.firm_check_code, "律所核对码与第一台一致（人工比对用）");
  await rb;
  b = await reboot(b, dirB);
  const st = (await b.invoke("kernel.status")) as any;
  assert.equal(st.member_role, "firm_admin", "同一成员、同一角色");
  assert.equal(st.account.logged_in, true);
  const sync = (await b.invoke("control_plane.sync")) as any;
  assert.equal(sync.report.steps.register, "ok", JSON.stringify(sync.report.steps));
  assert.equal(sync.report.steps.seat, "accepted", JSON.stringify(sync.report.steps));
  const t = cloud!.cp.ops.tenant(st.tenant_id)!;
  assert.ok([...t.devices.keys()].some((d) => d.endsWith("_D2")), "第二台的设备编号带 _D2");
  assert.ok(!existsSync(join(dirB, st.firm, "keys", "firm-root.json")), "第二台不持律所根");
  // 从第二台看：账号名下两台
  assert.equal(((await b.invoke("account.me", {})) as any).devices.filter((d: any) => !d.revoked_at).length, 2);
});

test("第 44 批真实验收的发现：网关的额度规则（402）不再说成“连不上”，按原因写清怎么办（纯函数）", async () => {
  const { agentFailureText } = await import("../src/executor/executor.ts");
  assert.match(agentFailureText(null, "402 短时间内用量过多（频率窗口已满），请稍后再试"), /频率窗口已满.*重新运行/);
  assert.match(agentFailureText(null, "402 本期 AI 额度已用完（100%），下期重置或请管理员加量"), /本期 AI 额度已用完.*加量/);
  assert.match(agentFailureText(null, "402 你的个人额度已用完，请联系律所管理员"), /个人 AI 额度已用完/);
  assert.match(agentFailureText(null, "402 已到律所设定的本期用量上限"), /律所设定的本期 AI 用量上限/);
  assert.doesNotMatch(agentFailureText(null, "402 短时间内用量过多（频率窗口已满），请稍后再试"), /连不上/);
  assert.match(agentFailureText(null, "502 upstream unreachable"), /连不上/, "真连不上的照旧");
});
