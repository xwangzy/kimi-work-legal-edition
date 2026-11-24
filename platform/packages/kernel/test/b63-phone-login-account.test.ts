/**
 * 第 63 批：律师端手机号验证码登录与绑定手机号（真实控制面 + 内核实例，全程经闸门的控制面通道；短信为控制面 dry-run）。
 * - 纯函数：注册 / 登录策略归一（旧云端 legacy、新云端 phone_login / phone_bind）、登录请求体、失败映射（phone_not_registered → 404 + 人话）；
 * - 待激活：策略有 phone_login；没注册的手机号发登录码 → 原因代码 phone_not_registered；手机号注册 → 创始开通；
 * - 已激活：退出登录 → 验证码登录（会话绑本机、席位令牌恢复）；换绑手机号要当前密码（错了说“当前密码不正确”）；旧号不能再登录；
 * - 第二台电脑用验证码登录：与密码登录同一处理（试用 1 台设备上限 → 写明原因）。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "b63-account-test-secret-0123456789ab";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCloudCp, type CloudCp } from "./cloud-cp.ts";
import { loginBody, registrationMetaOf } from "../src/services/onboarding.ts";
import { accountFailure } from "../src/account-session.ts";
import type { Kernel } from "../src/index.ts";

const PW = "Lawyer2026secure";
const STAFF = { email: "sysadmin63@csi.example.cn", name: "系统管理员", roles: ["sysadmin" as const], password: "Staff2026secure" };
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
/** 平台人员登录并复核，返回调运营接口的函数。 */
async function staff(): Promise<(method: string, path: string, body?: unknown) => Promise<any>> {
  const post = async (path: string, body: unknown, h: Record<string, string> = {}) => (await fetch(`${cloud!.base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) })).json() as Promise<any>;
  const tok = (await post("/v1/auth/login", { email: STAFF.email, password: STAFF.password, client: { platform: "web" } })).session_token as string;
  await post("/v1/auth/reauth", { password: STAFF.password }, { authorization: `Bearer ${tok}` });
  return async (method, path, body) => {
    const r = await fetch(`${cloud!.base}${path}`, { method, headers: { authorization: `Bearer ${tok}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const j = (await r.json()) as any;
    assert.equal(r.status, 200, `${method} ${path}：${JSON.stringify(j)}`);
    return j;
  };
}
/** 控制面的每分钟入口限速与 60 秒重发间隔：用例里把同号重发拉开（dry-run 也受约束）。 */
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("纯函数：策略归一（旧云端 legacy；新云端 phone_login / phone_bind 须 features 与策略同时给出）、登录请求体、失败映射", () => {
  assert.deepEqual(registrationMetaOf(null), { legacy: true, mode: null });
  assert.deepEqual(registrationMetaOf({ registration: "open" }), { legacy: true, mode: "open" });
  const pol = { mode: "open", sms_available: true, phone_reset: true, phone_login: true, phone_bind: true, sms: { code_length: 6, resend_seconds: 60, ttl_minutes: 10 } };
  const m62 = registrationMetaOf({ registration_policy: { ...pol, phone_login: undefined, phone_bind: undefined }, features: ["sms_send"] });
  assert.deepEqual([m62.legacy, m62.phone_login, m62.phone_bind], [false, false, false], "第 62 批云端：没有验证码登录");
  const m63 = registrationMetaOf({ registration_policy: pol, features: ["sms_send", "phone_login", "phone_bind"] });
  assert.deepEqual([m63.phone_login, m63.phone_bind], [true, true]);
  assert.equal(registrationMetaOf({ registration_policy: pol, features: ["sms_send"] }).phone_login, false, "features 没有 phone_login 不认");
  assert.deepEqual(loginBody({ email: "a@b.cn", password: "x" }), { email: "a@b.cn", password: "x" });
  assert.deepEqual(loginBody({ phone: "139 0013 9000", sms_code: " 12 34 56 " }), { phone: "139 0013 9000", sms_code: "123456" });
  assert.deepEqual(loginBody({ email: "a@b.cn", password: "x", phone: "13900139000" }), { email: "a@b.cn", password: "x" }, "同时给两种按密码方式");
  assert.throws(() => loginBody({ phone: "1390013900" }), (e: any) => e.detail?.reason === "phone_invalid");
  const f = accountFailure("phone_not_registered", "x");
  assert.deepEqual([f.status, f.reason, /还没有注册账号/.test(f.text)], [404, "phone_not_registered", true]);
  assert.equal(accountFailure("auth_invalid", "当前密码不正确").text, "当前密码不正确");
  assert.equal(accountFailure("auth_invalid", "随便什么").text, "邮箱或密码不正确");
  assert.deepEqual([accountFailure("sms_probe_limit").status, accountFailure("sms_login_disabled").status, accountFailure("phone_same").status], [429, 502, 409]);
  assert.equal(accountFailure("phone_taken", "这个手机号已绑定在别的账号上：请换一个手机号").text, "这个手机号已绑定在别的账号上：请换一个手机号");
});

test("待激活：验证码登录策略；没注册的号说清原因；手机号注册开通 → 已激活：验证码登录恢复席位；换绑要当前密码；第二台电脑用验证码登录照设备上限处理", { timeout: 300_000 }, async () => {
  // 短信用控制面 dry-run；登录、绑定的码要随应答返回才能自动化（只给用例开 dryRunRevealAll，生产入口没有这一项）
  cloud = await startCloudCp({ tenant: "ten_b63-unused", cp: { devStaff: [STAFF], sms: { dryRunRevealAll: true } } });
  const ops = await staff();
  await ops("PUT", "/v1/ops/registration/sms", { enabled: true, dry_run: true });
  const dirA = mkdtempSync(join(tmpdir(), "kwl-b63-a-"));
  let a = await boot(dirA);
  const m = (await a.invoke("account.registration_meta", {})) as any;
  assert.deepEqual([m.legacy, m.phone_login, m.phone_bind], [false, true, true]);
  await assert.rejects(a.invoke("account.sms_send", { phone: "13900139631", purpose: "login" }), (e: any) => e.detail?.reason === "phone_not_registered" && /新用户请先注册/.test(e.message));
  // 手机号注册 → 创始开通
  const rs = (await a.invoke("account.sms_send", { phone: "13900139631", purpose: "register" })) as any;
  const restart = nextRestart(a);
  const r = (await a.invoke("account.register", { email: "sms-a@example.cn", password: PW, name: "验证码律师", phone: "13900139631", sms_code: rs.debug_code })) as any;
  assert.deepEqual([r.kind, r.next], ["founder", "restart"]);
  await restart;
  a = await reboot(a, dirA);
  assert.equal(((await a.invoke("control_plane.sync")) as any).report.steps.seat, "accepted");
  const me = (await a.invoke("account.me", {})) as any;
  assert.equal(me.account.phone, "139****9631");
  // 已激活：退出 → 验证码登录
  await a.invoke("account.logout", {});
  assert.equal(((await a.invoke("account.status", {})) as any).login_required, true);
  const am = (await a.invoke("account.registration_meta", {})) as any;
  assert.deepEqual([am.legacy, am.phone_login, am.phone_bind], [false, true, true], "已激活电脑上也取得到策略");
  await pause(61_000); // 同号 60 秒重发间隔（注册码刚发过）
  const ls = (await a.invoke("account.sms_send", { phone: "13900139631", purpose: "login" })) as any;
  assert.deepEqual([ls.ok, ls.phone, ls.dry_run], [true, "139****9631", true]);
  const wrong = String((Number(ls.debug_code) + 1) % 1_000_000).padStart(6, "0");
  await assert.rejects(a.invoke("account.login", { phone: "13900139631", sms_code: wrong }), (e: any) => /验证码不正确（还可再试 4 次）/.test(e.message));
  const li = (await a.invoke("account.login", { phone: "13900139631", sms_code: ls.debug_code })) as any;
  assert.equal(li.ok, true);
  assert.equal(((await a.invoke("control_plane.sync")) as any).report.steps.seat, "accepted", "验证码登录后席位令牌恢复");
  assert.equal(((await a.invoke("account.status", {})) as any).logged_in, true);
  // 换绑手机号：要当前密码
  const bs = (await a.invoke("account.sms_send", { phone: "13900139632", purpose: "bind" })) as any;
  await assert.rejects(a.invoke("account.bind_phone", { phone: "13900139632", sms_code: bs.debug_code }), (e: any) => e.message === "当前密码不正确");
  const bd = (await a.invoke("account.bind_phone", { phone: "13900139632", sms_code: bs.debug_code, password: PW })) as any;
  assert.deepEqual(bd, { ok: true, phone: "139****9632" });
  await assert.rejects(a.invoke("account.sms_send", { phone: "13900139631", purpose: "login" }), (e: any) => e.detail?.reason === "phone_not_registered", "旧号已解除");
  // 第二台电脑用验证码登录：试用 1 台设备上限 → 与密码登录同样写明原因
  const b = await boot(mkdtempSync(join(tmpdir(), "kwl-b63-b-")));
  await pause(61_000);
  const s2 = (await b.invoke("account.sms_send", { phone: "13900139632", purpose: "login" })) as any;
  const jb = (await b.invoke("account.login", { phone: "13900139632", sms_code: s2.debug_code })) as any;
  assert.equal(jb.next, "blocked", JSON.stringify(jb));
  assert.match(jb.message, /设备|电脑/);
  assert.equal(jb.account.email, "sms-a@example.cn");
});
