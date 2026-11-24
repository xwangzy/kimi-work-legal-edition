/**
 * 第 62 批：律师端注册按云端能力字段做特性检测（真实控制面 + 内核待激活模式，全程经闸门的控制面通道）。
 * - 旧云端（/v1/meta 没有 registration_policy、没有 /v1/auth/sms/send）：account.registration_meta 回 legacy，注册照旧流程（不要手机号）可用；
 * - 新云端（运营打开短信 dry-run 与“注册必须验证手机号”、仅凭码注册）：registration_meta 给出策略；不填手机号注册说清原因；
 *   account.sms_send（dry-run 带回验证码）→ 手机号 + 验证码 + 12 位注册邀请码注册 → 创始开通；手机号格式本机先拦。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "b62-account-test-secret-0123456789ab";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCloudCp, type CloudCp } from "./cloud-cp.ts";
import { registrationInviteInput } from "../src/services/onboarding.ts";
import type { Kernel } from "../src/index.ts";

const PW = "Lawyer2026secure";
const STAFF = { email: "sysadmin62@csi.example.cn", name: "系统管理员", roles: ["sysadmin" as const], password: "Staff2026secure" };
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

test("12 位注册邀请码的本机归一（与开通码同一规则：忽略大小写与连字符，I/L 读作 1、O 读作 0）", () => {
  assert.deepEqual(registrationInviteInput("abcd-efgh-jklo"), { code: "ABCDEFGHJK10", secret: null });
  assert.equal(registrationInviteInput("ABCD-EFGH-JKMU"), null);
  assert.equal(registrationInviteInput("ABCD-EFGH-JKM"), null);
});

test("旧云端：registration_meta 回 legacy、发验证码不可用；注册照旧流程（不要手机号）完成创始开通", { timeout: 180_000 }, async () => {
  cloud = await startCloudCp({ tenant: "ten_b62-unused", cp: { devStaff: [STAFF] } });
  cloud.setLegacyCloud(true);
  const k = await boot(mkdtempSync(join(tmpdir(), "kwl-b62-old-")));
  const m = (await k.invoke("account.registration_meta", {})) as any;
  assert.deepEqual(m, { legacy: true, mode: "open" });
  await assert.rejects(k.invoke("account.sms_send", { phone: "13800138000", purpose: "register" }), (e: any) => e.code === "validation" && !/手机号格式/.test(e.message));
  const restart = nextRestart(k);
  const r = (await k.invoke("account.register", { email: "old-cloud@example.cn", password: PW, name: "旧云端律师" })) as any;
  assert.deepEqual([r.kind, r.next], ["founder", "restart"]);
  await restart;
  // 取不到策略（控制面不可达）也按旧流程，不报错
  const k2 = await boot(mkdtempSync(join(tmpdir(), "kwl-b62-down-")));
  cloud.setControlPlaneAvailable(false);
  assert.deepEqual(((await k2.invoke("account.registration_meta", {})) as any).legacy, true);
  cloud.setControlPlaneAvailable(true);
  cloud.setLegacyCloud(false);
});

test("新云端：策略要求手机号且仅凭码——不填手机号注册说清原因；发验证码（dry-run）→ 手机号 + 验证码 + 注册邀请码注册 → 创始开通", { timeout: 180_000 }, async () => {
  const ops = await staff();
  await ops("PUT", "/v1/ops/registration/sms", { enabled: true, dry_run: true });
  await ops("PUT", "/v1/ops/registration/policy", { phone_required: true, registration: "code" });
  const batch = await ops("POST", "/v1/ops/registration/invite-batches", { name: "内核用例", count: 1, max_uses: 1, trial_days: 21 });
  const invite = batch.codes[0].code as string;
  const k = await boot(mkdtempSync(join(tmpdir(), "kwl-b62-new-")));
  const m = (await k.invoke("account.registration_meta", {})) as any;
  assert.deepEqual(m, { legacy: false, mode: "code", invite_required: true, require_phone: true, sms_available: true, phone_reset: true, phone_login: true, phone_bind: true, sms: { code_length: 6, resend_seconds: 60, ttl_minutes: 10 } });
  await assert.rejects(k.invoke("account.register", { email: "new-cloud@example.cn", password: PW, name: "新云端律师", code: invite }), (e: any) => e.message === "请填写手机号并获取短信验证码");
  await assert.rejects(k.invoke("account.sms_send", { phone: "1380013800", purpose: "register" }), (e: any) => e.code === "validation" && /手机号格式不对/.test(e.message));
  const s = (await k.invoke("account.sms_send", { phone: "+86 139-0013-9000", purpose: "register" })) as any;
  assert.deepEqual([s.ok, s.phone, s.resend_after_s, s.dry_run, /^\d{6}$/.test(s.debug_code)], [true, "139****9000", 60, true, true]);
  await assert.rejects(k.invoke("account.sms_send", { phone: "13900139000", purpose: "register" }), (e: any) => e.code === "rate_limited" && /秒后再重新获取/.test(e.message) && e.detail?.retry_after_s > 0);
  const wrong = String((Number(s.debug_code) + 1) % 1_000_000).padStart(6, "0");
  await assert.rejects(k.invoke("account.register", { email: "new-cloud@example.cn", password: PW, name: "新云端律师", code: invite, phone: "13900139000", sms_code: wrong }), (e: any) => /验证码不正确（还可再试 4 次）/.test(e.message));
  await assert.rejects(k.invoke("account.register", { email: "new-cloud@example.cn", password: PW, name: "新云端律师", code: "ZZZZ-ZZZZ-ZZZZ", phone: "13900139000", sms_code: s.debug_code }), (e: any) => /邀请码、开通码或验证码不正确/.test(e.message));
  const restart = nextRestart(k);
  const r = (await k.invoke("account.register", { email: "new-cloud@example.cn", password: PW, name: "新云端律师", org_name: "新云端律所", code: invite.toLowerCase(), phone: "13900139000", sms_code: s.debug_code })) as any;
  assert.deepEqual([r.kind, r.next, r.firm.name], ["founder", "restart", "新云端律所"]);
  await restart;
  const acc = cloud!.cp.ops.account("new-cloud@example.cn")!;
  assert.deepEqual([acc.phone?.masked, typeof acc.invite_id], ["139****9000", "string"]);
  // 用完的码：人话
  const k3 = await boot(mkdtempSync(join(tmpdir(), "kwl-b62-used-")));
  await assert.rejects(k3.invoke("account.register", { email: "late@example.cn", password: PW, name: "晚到", code: invite, phone: "13700137000", sms_code: "000000" }), (e: any) => e.message === "这个邀请码已用完，请向发码人重新获取");
});
