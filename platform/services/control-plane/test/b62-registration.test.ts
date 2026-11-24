/**
 * 第 62 批：手机号验证码注册、注册管理与注册邀请码（契约 docs/contract-b62-registration.md）。
 *
 * - 赛邮云签名（固定输入与独立算出的 md5 对照，思路同 MaaS 用例）、错误代码映射、时间戳被拒时取服务器时间重试；
 * - 短信设置：settings.manage + 复核；AppKey 只写不回显、状态快照里只有密文；生产部署（allowDryRun=false）拒绝 dry-run；
 * - 验证码：有效期、同号重发间隔、同号每日上限、来源每小时上限、单码校验次数、一次性；发送失败的可排查代码与发送记录；
 * - 注册策略：开放 / 仅凭码 / 关闭、必须验证手机号（短信不可用时打不开、开着时不能停用短信）；/v1/meta 能力字段；
 * - 手机号与账号一对一、存储与视图打码；用手机号找回密码；
 * - 注册邀请码：批量生成、列表筛选、详情与使用记录、CSV 导出、单个与批量停用、已用完 / 已过期 / 已停用；并发注册原子占用；
 * - 权限（registration.read / registration.manage / settings.manage）、操作记录与内部访问审计（手机号打码）；重启读回。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createControlPlane, devControlPlaneKeys, type ControlPlane, type CpOpsAccessRecord, type StateStore } from "../src/index.ts";
import { maskPhone, normalizePhone, submailFailCode, submailSignature } from "../src/sms.ts";
import { normalizeInviteCode } from "../src/registration.ts";
import { call, devStaffOf, staffEmail, staffToken } from "./staff-fixture.ts";

const SECRET = "b62-test-service-secret-0123456789abcdef";
const PW = "Lawyer2026secure";
const APP_KEY = "b62testappkey0123456789abcdefABCD";
const keys = devControlPlaneKeys();
const access: CpOpsAccessRecord[] = [];

// ─── 假的赛邮云：核对签名，按用例设定的行为回复 ───
type Behaviour = { kind: "ok" } | { kind: "error"; code: string } | { kind: "hang" } | { kind: "stale_ts_once" };
let behaviour: Behaviour = { kind: "ok" };
const sent: { to: string; project: string; vars: Record<string, string> }[] = [];
let submail: Server;
let submailBase = "";
let staleServed = false;
const formOf = async (req: IncomingMessage) => {
  let raw = "";
  for await (const c of req) raw += c;
  return Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>;
};

// ─── 控制面（可调时钟）与快照 ───
let T = Date.parse("2026-11-24T02:00:00.000Z");
const now = () => T;
const saved: string[] = [];
const store: StateStore = { load: () => saved.at(-1) ?? null, save: (j) => void saved.push(j) };
let cp: ControlPlane;
let base = "";
let prod: ControlPlane;
let prodBase = "";
const tokens = new Map<string, { token: string; at: number }>();

before(async () => {
  submail = createServer(async (req, res) => {
    const reply = (j: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(j));
    };
    if (req.method === "GET" && req.url === "/service/timestamp") return reply({ timestamp: Math.floor(T / 1000) });
    const f = await formOf(req);
    const { signature, ...params } = f;
    if (signature !== submailSignature(f.appid!, APP_KEY, params)) return reply({ status: "error", code: "108", msg: "signature invalid" });
    if (behaviour.kind === "hang") return; // 不回复：等对方超时
    if (behaviour.kind === "error") return reply({ status: "error", code: behaviour.code, msg: "x" });
    if (behaviour.kind === "stale_ts_once" && !staleServed) {
      staleServed = true;
      return reply({ status: "error", code: "152", msg: "timestamp expired" });
    }
    if (req.url === "/balance/sms") return reply({ status: "success", balance: "9410", transactional_balance: "9775" });
    if (req.url === "/sms/xsend") {
      sent.push({ to: f.to!, project: f.project!, vars: JSON.parse(f.vars!) });
      return reply({ status: "success", send_id: "s1", fee: 1 });
    }
    reply({ status: "error", code: "404" });
  });
  await new Promise<void>((r) => submail.listen(0, "127.0.0.1", () => r()));
  submailBase = `http://127.0.0.1:${(submail.address() as AddressInfo).port}`;
  cp = createControlPlane({ keys, serviceSecret: SECRET, now, stateStore: store, devStaff: devStaffOf({ op_6201: ["sysadmin"], op_6202: ["operator"], op_6203: ["support"], op_6204: ["finance"] }), opsAccessLog: (r) => void access.push(r), sms: { base: submailBase, timeoutMs: 800 } });
  prod = createControlPlane({ keys: devControlPlaneKeys(), serviceSecret: SECRET, devStaff: devStaffOf({ op_6299: ["sysadmin"] }), sms: { allowDryRun: false, base: submailBase } });
  for (const c of [cp, prod]) await new Promise<void>((r) => c.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(cp.server.address() as AddressInfo).port}`;
  prodBase = `http://127.0.0.1:${(prod.server.address() as AddressInfo).port}`;
});
after(async () => {
  for (const s of [cp.server, prod.server, submail]) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

/** 人员会话（登录即复核）：用例里时钟会往后拨，复核 10 分钟、会话闲置 30 分钟——超过 5 分钟就重新登录。 */
const tokenOf = async (who: string, at = base) => {
  const k = `${at}|${who}`;
  const c = tokens.get(k);
  if (c && T - c.at < 5 * 60_000) return c.token;
  const token = await staffToken(at, staffEmail(who));
  tokens.set(k, { token, at: T });
  return token;
};
/** 拨到下一个整点之后（来源每小时上限按整点窗口）。 */
const nextHour = () => void (T = Math.ceil((T + 1) / 3600_000) * 3600_000 + 1000);
const ops = async (who: string, method: string, path: string, body?: unknown, at = base) => call(at, method, path, body, { authorization: `Bearer ${await tokenOf(who, at)}` });
const pub = (method: string, path: string, body?: unknown) => call(base, method, path, body);
/** 时钟往后拨（越过每分钟的入口限速窗口）。 */
const tick = (ms = 61_000) => void (T += ms);
const reg = (o: Record<string, unknown>) => pub("POST", "/v1/auth/register", { password: PW, name: "测试律师", client: { platform: "win32", version: "0.9.0" }, ...o });
const sendCode = async (phone: string, purpose = "register") => {
  tick();
  return pub("POST", "/v1/auth/sms/send", { phone, purpose });
};
const smsPut = (body: unknown) => ops("op_6201", "PUT", "/v1/ops/registration/sms", body);
const policy = (body: unknown) => ops("op_6201", "PUT", "/v1/ops/registration/policy", body);

test("赛邮云签名：固定输入与独立算出的 md5 一致（sign_version=2 时 vars 不参与，否则参与）；错误代码映射；手机号归一与打码", () => {
  const base0 = { appid: "appid", to: "13800138000", project: "register_project", timestamp: "1600000000", sign_type: "md5" };
  assert.equal(submailSignature("appid", "appkey", { ...base0, sign_version: "2", vars: '{"code":"123456"}' }), "4512fa65afedd2b9663021e04d97e4aa");
  assert.equal(submailSignature("appid", "appkey", { ...base0, vars: '{"code":"123456"}' }), "2543213192fb93b519bd110187dba74b");
  assert.equal(submailSignature("appid", "appkey", { appid: "appid", sign_type: "md5", timestamp: "1600000000" }), "c84dfdcbac02cde2d1983dc64d4542e9");
  // 与手拼的串对照（signature 与 tag 不参与）
  const manual = createHash("md5").update("appidappkeyappid=appid&sign_type=md5&timestamp=1600000000appidappkey").digest("hex");
  assert.equal(submailSignature("appid", "appkey", { appid: "appid", sign_type: "md5", timestamp: "1600000000", signature: "x", tag: "t" }), manual);
  assert.deepEqual(["903", "905", "113", "108", "152", "126", "420", "252", "115", "999"].map(submailFailCode), ["sms_balance_insufficient", "sms_balance_insufficient", "sms_ip_blocked", "sms_auth_failed", "sms_auth_failed", "sms_sign_invalid", "sms_template_invalid", "sms_phone_rejected", "sms_provider_throttled", "sms_provider_error"]);
  assert.deepEqual(["+86 138-0013-8000", "008613800138000", "8613800138000", "12800138000", "1380013800", "abc"].map(normalizePhone), ["13800138000", "13800138000", "13800138000", null, null, null]);
  assert.equal(maskPhone("13800138000"), "138****8000");
  assert.equal(normalizeInviteCode("abcd-efgh-jk1o"), "ABCDEFGHJK10");
  assert.equal(normalizeInviteCode("ABCD-EFGH-JKMU"), null, "U 不在字母表里");
});

test("/v1/meta 能力字段：缺省开放注册、短信未开、不要求手机号；旧字段 registration 保留", async () => {
  const m = (await pub("GET", "/v1/meta")).json;
  assert.equal(m.registration, "open");
  assert.deepEqual(m.registration_policy, { mode: "open", invite_required: false, require_phone: false, sms_available: false, phone_reset: false, phone_login: false, phone_bind: false, sms: { code_length: 6, resend_seconds: 60, ttl_minutes: 10 } });
  assert.equal(m.sms_available, false);
  assert.ok(m.features.includes("sms_send") && m.features.includes("registration_invites"));
  // 短信没开：发码给人话与可排查代码
  const r = await sendCode("13800138000");
  assert.deepEqual([r.status, r.json.error.code], [503, "sms_disabled"]);
});

test("短信设置：要 settings.manage 且复核；AppKey 只写不回显（尾号提示）、快照里只有密文；不完整不能启用；生产部署拒绝 dry-run", async () => {
  assert.equal((await ops("op_6202", "GET", "/v1/ops/registration/sms")).status, 403, "客户运营没有 settings.manage");
  // 未复核的会话 → reauth_required
  const raw = await staffToken(base, staffEmail("op_6201"), { reauth: false });
  const nr = await call(base, "PUT", "/v1/ops/registration/sms", { sign_name: "测试签名" }, { authorization: `Bearer ${raw}` });
  assert.deepEqual([nr.status, nr.json.error.code], [401, "reauth_required"]);
  const inc = await smsPut({ enabled: true, app_id: "100001" });
  assert.deepEqual([inc.status, inc.json.error.code], [400, "sms_incomplete"]);
  assert.deepEqual(inc.json.error.missing, ["app_key", "sign_name", "projects.register"]);
  assert.equal((await smsPut({ sign_name: "【带括号】" })).json.error.code, "sms_sign_name_invalid");
  const ok = await smsPut({ app_id: "100001", app_key: APP_KEY, sign_name: "测试签名", projects: { register: "ProjReg1", reset: "ProjRst1" } });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.json.sms.app_key, { set: true, hint: APP_KEY.slice(-4) });
  assert.equal(JSON.stringify(ok.json).includes(APP_KEY), false, "应答里没有 AppKey");
  assert.equal(saved.at(-1)!.includes(APP_KEY), false, "快照里没有 AppKey 明文");
  assert.match(JSON.parse(saved.at(-1)!).sms.app_key_sealed, /^s1\./);
  assert.equal((await ops("op_6201", "GET", "/v1/ops/registration/sms")).json.sms.available, false, "还没启用");
  // 内部访问审计：只记改了哪些字段
  const rec = access.filter((x) => x.action === "sms.settings_update" && x.result === "ok").at(-1)!;
  assert.match(rec.target!, /^fields:app_id,app_key,projects,sign_name$/);
  // 生产部署：dry-run 打不开
  const pd = await ops("op_6299", "PUT", "/v1/ops/registration/sms", { enabled: true, dry_run: true }, prodBase);
  assert.deepEqual([pd.status, pd.json.error.code], [409, "sms_dry_run_forbidden"]);
});

test("测试连接（查余额，不发短信、不要求复核）与发送测试短信（要复核，手机号打码记审计）；赛邮云时间戳被拒时取服务器时间重试", async () => {
  const before0 = sent.length;
  const tc = await ops("op_6201", "POST", "/v1/ops/registration/sms/test-connection", {});
  assert.deepEqual([tc.status, tc.json.balance, tc.json.transactional_balance], [200, 9410, 9775], tc.text);
  behaviour = { kind: "stale_ts_once" };
  staleServed = false;
  const tc2 = await ops("op_6201", "POST", "/v1/ops/registration/sms/test-connection", {});
  assert.equal(tc2.status, 200, "151/152 后用服务器时间重试成功");
  behaviour = { kind: "error", code: "903" };
  const tc3 = await ops("op_6201", "POST", "/v1/ops/registration/sms/test-connection", {});
  assert.deepEqual([tc3.json.error.code, tc3.json.error.provider_code], ["sms_balance_insufficient", "903"]);
  behaviour = { kind: "ok" };
  assert.equal(sent.length, before0, "测试连接不发短信");
  const ts = await ops("op_6201", "POST", "/v1/ops/registration/sms/test-send", { phone: "13900139000" });
  assert.deepEqual([ts.status, ts.json.phone], [200, "139****9000"], ts.text);
  assert.deepEqual([sent.at(-1)!.to, sent.at(-1)!.project, sent.at(-1)!.vars.sign_name, sent.at(-1)!.vars.time], ["13900139000", "ProjReg1", "测试签名", "10分钟"]);
  assert.match(sent.at(-1)!.vars.code!, /^\d{6}$/);
  const audit = (await ops("op_6203", "GET", "/v1/ops/registration/audit")).json.entries;
  assert.ok(audit.some((e: any) => e.action === "sms.test_send" && e.target === "139****9000" && e.detail.result === "sent"));
  assert.ok(access.some((x) => x.action === "sms.test_send" && x.target === "139****9000" && x.result === "ok"));
  assert.equal(JSON.stringify(access).includes("13900139000"), false, "访问审计里没有完整手机号");
  const logs = (await ops("op_6203", "GET", "/v1/ops/registration/sms/logs")).json.logs;
  assert.deepEqual([logs[0].purpose, logs[0].phone, logs[0].result, logs[0].by], ["test", "139****9000", "sent", cp.ops.staff(staffEmail("op_6201"))!.aid]);
  // 测试短信也占同号重发间隔
  const again = await ops("op_6201", "POST", "/v1/ops/registration/sms/test-send", { phone: "13900139000" });
  assert.equal(again.json.error.code, "sms_too_frequent");
});

test("真实发送（假的赛邮云）：手机号注册 → 登录；验证码只能用一次；发送失败的可排查代码、记录作废可立刻重发；超时", async () => {
  assert.equal((await smsPut({ enabled: true })).status, 200);
  let m = (await pub("GET", "/v1/meta")).json.registration_policy;
  assert.deepEqual([m.sms_available, m.phone_reset, m.require_phone], [true, true, false]);
  const r = await sendCode("13700137000");
  assert.deepEqual([r.status, r.json.phone, r.json.resend_after_s, r.json.expires_in_s, "debug_code" in r.json], [200, "137****7000", 60, 600, false], r.text);
  const code = sent.at(-1)!.vars.code!;
  const a = await reg({ email: "phone1@example.cn", phone: "137 0013 7000", sms_code: code });
  assert.equal(a.status, 200, a.text);
  assert.equal(a.json.account.phone, "137****7000");
  const snap = saved.at(-1)!;
  assert.equal(snap.includes("13700137000"), false, "快照里没有完整手机号（只有摘要、打码与密文）");
  tick();
  assert.equal((await pub("POST", "/v1/auth/login", { email: "phone1@example.cn", password: PW, client: { platform: "web" } })).status, 200);
  // 同一个码不能再用；手机号已注册
  tick();
  const again = await reg({ email: "phone1b@example.cn", phone: "13700137000", sms_code: code });
  assert.deepEqual([again.status, again.json.error.code], [409, "phone_taken"]);
  assert.equal((await sendCode("13700137000")).json.error.code, "phone_taken");
  // 发送失败：余额不足 → 可排查代码，记录作废（不占重发间隔），发送记录写明
  behaviour = { kind: "error", code: "904" };
  const f1 = await sendCode("13600136000");
  assert.deepEqual([f1.status, f1.json.error.code], [503, "sms_balance_insufficient"]);
  behaviour = { kind: "error", code: "420" };
  assert.equal((await sendCode("13600136000")).json.error.code, "sms_template_invalid", "失败不占重发间隔");
  const logs = (await ops("op_6203", "GET", "/v1/ops/registration/sms/logs?result=failed")).json.logs;
  assert.deepEqual([logs[0].code, logs[0].provider_code, logs[0].phone], ["sms_template_invalid", "420", "136****6000"]);
  behaviour = { kind: "hang" };
  const to = await sendCode("13600136000");
  assert.deepEqual([to.status, to.json.error.code], [504, "sms_timeout"]);
  behaviour = { kind: "ok" };
  // 一次性：用过的码再注册（换邮箱换号也不行——码绑定手机号）
  const r2 = await sendCode("13600136000");
  assert.equal(r2.status, 200, r2.text);
  const c2 = sent.at(-1)!.vars.code!;
  tick();
  assert.equal((await reg({ email: "phone2@example.cn", phone: "13500135000", sms_code: c2 })).json.error.code, "sms_code_expired", "码绑定手机号：别的号没有有效码");
  tick();
  assert.equal((await reg({ email: "phone2@example.cn", phone: "13600136000", sms_code: c2 })).status, 200);
  tick();
  m = (await pub("GET", "/v1/meta")).json.registration_policy;
  assert.equal(m.sms_available, true);
});

test("dry-run（非生产部署）：验证码随应答返回、不发短信；有效期、校验次数、同号间隔、每日上限、来源每小时上限", async () => {
  assert.equal((await smsPut({ dry_run: true, max_attempts: 3, daily_limit_per_phone: 3, ip_hourly_limit: 50 })).status, 200);
  const n0 = sent.length;
  const r = await sendCode("13811138111");
  assert.deepEqual([r.status, r.json.dry_run, /^\d{6}$/.test(r.json.debug_code)], [200, true, true], r.text);
  assert.equal(sent.length, n0, "dry-run 不发短信");
  // 60 秒内重发 → 429 + 剩余秒数
  const fast = await pub("POST", "/v1/auth/sms/send", { phone: "13811138111", purpose: "register" });
  assert.deepEqual([fast.status, fast.json.error.code, fast.json.error.retry_after_s > 0], [429, "sms_too_frequent", true]);
  // 输错 3 次 → 用完
  const wrong = String((Number(r.json.debug_code) + 1) % 1_000_000).padStart(6, "0");
  tick();
  const w1 = await reg({ email: "dry1@example.cn", phone: "13811138111", sms_code: wrong });
  assert.deepEqual([w1.json.error.code, w1.json.error.attempts_left], ["sms_code_invalid", 2]);
  tick();
  await reg({ email: "dry1@example.cn", phone: "13811138111", sms_code: wrong });
  tick();
  assert.equal((await reg({ email: "dry1@example.cn", phone: "13811138111", sms_code: wrong })).json.error.code, "sms_code_attempts");
  tick();
  assert.equal((await reg({ email: "dry1@example.cn", phone: "13811138111", sms_code: r.json.debug_code })).json.error.code, "sms_code_attempts", "次数用完后对的码也不收");
  // 过期：10 分钟后
  const r2 = await sendCode("13811138111");
  T += 10 * 60_000 + 1;
  assert.equal((await reg({ email: "dry1@example.cn", phone: "13811138111", sms_code: r2.json.debug_code })).json.error.code, "sms_code_expired");
  // 每日上限 3：今天已发 2 条，第 3 条可以，第 4 条拒
  assert.equal((await sendCode("13811138111")).status, 200);
  const d4 = await sendCode("13811138111");
  assert.deepEqual([d4.status, d4.json.error.code], [429, "sms_daily_limit"]);
  // 来源每小时上限
  assert.equal((await smsPut({ ip_hourly_limit: 1 })).status, 200);
  nextHour();
  assert.equal((await sendCode("13822238222")).status, 200);
  assert.equal((await sendCode("13833338333")).json.error.code, "sms_ip_limit");
  assert.equal((await smsPut({ ip_hourly_limit: 50 })).status, 200);
  nextHour();
  // 发码前校验手机号格式与用途
  assert.equal((await sendCode("12345")).json.error.code, "phone_invalid");
  assert.equal((await pub("POST", "/v1/auth/sms/send", { phone: "13844438444", purpose: "notify" })).json.error.code, "sms_purpose_invalid");
});

test("用手机号找回密码：未注册的号照样回“已发送”但不给码；已注册的改密后旧会话退出；密码不合格不耗验证码", async () => {
  const none = await sendCode("13855538555", "reset");
  assert.deepEqual([none.status, "debug_code" in none.json], [200, false]);
  const r = await sendCode("13700137000", "reset");
  assert.equal(r.status, 200, r.text);
  tick();
  const weak = await pub("POST", "/v1/auth/password-reset/confirm", { phone: "13700137000", code: r.json.debug_code, password: "short" });
  assert.equal(weak.json.error.code, "password_weak");
  tick();
  const ok = await pub("POST", "/v1/auth/password-reset/confirm", { phone: "13700137000", code: r.json.debug_code, password: "Brandnew2026pass" });
  assert.equal(ok.status, 200, ok.text);
  tick();
  assert.equal((await pub("POST", "/v1/auth/login", { email: "phone1@example.cn", password: "Brandnew2026pass", client: { platform: "web" } })).status, 200);
  tick();
  assert.equal((await pub("POST", "/v1/auth/password-reset/confirm", { phone: "13700137000", code: r.json.debug_code, password: "Another2026pass" })).json.error.code, "sms_code_expired", "一次性");
  // 运营按手机号查账号（账号里只有打码与摘要）
  const q = await ops("op_6203", "GET", "/v1/ops/accounts?q=13700137000");
  assert.deepEqual(q.json.accounts.map((x: any) => [x.email, x.phone]), [["phone1@example.cn", "137****7000"]]);
});

test("注册策略：必须验证手机号（短信可用才能打开；开着时不能停用短信）；仅凭码；关闭；改策略要 registration.manage 与复核", async () => {
  assert.equal((await ops("op_6204", "GET", "/v1/ops/registration")).status, 403, "财务没有 registration.read");
  assert.equal((await ops("op_6203", "PUT", "/v1/ops/registration/policy", { phone_required: true })).status, 403, "客服只读");
  assert.equal((await ops("op_6299", "PUT", "/v1/ops/registration/policy", { phone_required: true }, prodBase)).json.error.code, "sms_required_for_policy", "短信不可用时打不开");
  const on = await policy({ phone_required: true });
  assert.equal(on.status, 200, on.text);
  assert.equal(on.json.meta.require_phone, true);
  assert.equal((await smsPut({ enabled: false })).json.error.code, "sms_required_by_policy");
  tick();
  const noPhone = await reg({ email: "nophone@example.cn" });
  assert.deepEqual([noPhone.status, noPhone.json.error.code], [400, "phone_required"]);
  tick();
  assert.equal((await reg({ email: "nophone@example.cn", phone: "13866638666" })).json.error.code, "sms_code_required");
  assert.equal((await policy({ phone_required: false, registration: "code" })).status, 200);
  tick();
  assert.deepEqual([(await reg({ email: "nocode@example.cn" })).json.error.code], ["code_required"]);
  assert.equal((await policy({ registration: "closed" })).status, 200);
  tick();
  assert.equal((await reg({ email: "closed@example.cn" })).json.error.code, "registration_closed");
  assert.equal((await sendCode("13866638666")).json.error.code, "registration_closed");
  assert.equal((await policy({ registration: "code" })).status, 200);
  const ov = await ops("op_6203", "GET", "/v1/ops/registration");
  assert.deepEqual([ov.json.policy.registration, ov.json.meta.invite_required, ov.json.sms.available], ["code", true, true]);
  assert.ok((await ops("op_6203", "GET", "/v1/ops/registration/audit")).json.entries.some((e: any) => e.action === "registration.policy_update" && e.detail.registration === "closed"));
  assert.equal((await policy({ bogus: 1 })).json.error.code, "policy_invalid");
});

let firstCodes: { id: string; code: string }[] = [];

test("注册邀请码：批量生成（数量、有效期、次数、批次名、绑定套餐与试用规格）；只读只看打码；凭码注册开试用律所并留使用记录；已用完 / 已过期 / 已停用", async () => {
  assert.equal((await ops("op_6203", "POST", "/v1/ops/registration/invite-batches", { name: "x", count: 1 })).status, 403, "客服不能生成");
  assert.equal((await ops("op_6202", "POST", "/v1/ops/registration/invite-batches", { name: "坏的", count: 0 })).json.error.code, "batch_count_invalid");
  assert.equal((await ops("op_6202", "POST", "/v1/ops/registration/invite-batches", { name: "坏的", count: 1, plan: "nope" })).json.error.code, "plan_unknown");
  const b = await ops("op_6202", "POST", "/v1/ops/registration/invite-batches", { name: "律协活动", count: 3, max_uses: 1, ttl_days: 7, plan: "standard", trial_days: 30, trial_seats: 3, note: "11 月沙龙" });
  assert.equal(b.status, 200, b.text);
  assert.deepEqual([b.json.batch.count, b.json.batch.by_status.available, b.json.codes.length], [3, 3, 3]);
  firstCodes = b.json.codes.map((x: any) => ({ id: x.id, code: x.code }));
  for (const c of firstCodes) assert.match(c.code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(saved.at(-1)!.includes(firstCodes[0]!.code.replace(/-/g, "")), false, "快照里码只有摘要与密文");
  // 只读（客服）看打码；运营（manage）看完整的
  const ro = (await ops("op_6203", "GET", `/v1/ops/registration/invites?batch_id=${b.json.batch.id}`)).json;
  assert.deepEqual([ro.total, ro.revealed, ro.invites[0].code, /^\w{4}-\*{4}-\w{4}$/.test(ro.invites[0].code_masked)], [3, false, null, true]);
  const rw = (await ops("op_6202", "GET", `/v1/ops/registration/invites?batch_id=${b.json.batch.id}`)).json;
  assert.ok(rw.invites.every((x: any) => firstCodes.some((c) => c.code === x.code)));
  // 凭码注册（仅凭码模式）：开一家试用律所，套餐与规格按批次
  tick();
  const u = await reg({ email: "invited1@example.cn", code: firstCodes[0]!.code.toLowerCase(), org_name: "活动律所" });
  assert.equal(u.status, 200, u.text);
  const t = cp.ops.tenant(u.json.account.tid)!;
  assert.deepEqual([t.plan, t.seats, t.created_via, t.name, u.json.onboarding.state], ["standard", 3, "self", "活动律所", "needs_founder_setup"]);
  assert.ok(Math.abs(Date.parse(t.subscription_until) - (T + 30 * 86400_000)) < 5_000, "试用 30 天");
  const det = (await ops("op_6203", "GET", `/v1/ops/registration/invites/${firstCodes[0]!.id}`)).json;
  assert.deepEqual([det.invite.status, det.invite.used, det.uses[0].email, det.uses[0].tenant_name, det.invite.code], ["exhausted", 1, "invited1@example.cn", "活动律所", null]);
  assert.equal(cp.ops.account("invited1@example.cn")!.invite_id, firstCodes[0]!.id);
  // 已用完
  tick();
  const ex = await reg({ email: "invited2@example.cn", code: firstCodes[0]!.code });
  assert.deepEqual([ex.status, ex.json.error.code], [409, "invite_exhausted"]);
  // 停用（单个）→ 已停用；再启用
  assert.equal((await ops("op_6202", "POST", `/v1/ops/registration/invites/${firstCodes[1]!.id}/disable`, { reason: "发错人" })).json.invite.status, "disabled");
  tick();
  assert.equal((await reg({ email: "invited2@example.cn", code: firstCodes[1]!.code })).json.error.code, "invite_disabled");
  assert.equal((await ops("op_6202", "POST", `/v1/ops/registration/invites/${firstCodes[1]!.id}/enable`, {})).json.invite.status, "available");
  // 码不对
  tick();
  assert.equal((await reg({ email: "invited2@example.cn", code: "ZZZZ-ZZZZ-ZZZZ" })).json.error.code, "code_invalid");
  // 搜索：完整的码、使用人邮箱、末 4 位、批次名
  const byCode = (await ops("op_6203", "GET", `/v1/ops/registration/invites?q=${firstCodes[2]!.code}`)).json.invites;
  assert.deepEqual(byCode.map((x: any) => x.id), [firstCodes[2]!.id]);
  assert.deepEqual((await ops("op_6203", "GET", "/v1/ops/registration/invites?q=invited1@example.cn")).json.invites.map((x: any) => x.id), [firstCodes[0]!.id]);
  assert.ok((await ops("op_6203", "GET", `/v1/ops/registration/invites?q=${firstCodes[2]!.code.slice(-4)}`)).json.invites.some((x: any) => x.id === firstCodes[2]!.id));
  assert.equal((await ops("op_6203", "GET", "/v1/ops/registration/invites?q=律协&status=exhausted")).json.total, 1);
  assert.equal((await ops("op_6203", "GET", "/v1/ops/registration/invites?status=bogus")).json.error.code, "status_invalid");
  // 过期：8 天后
  T += 8 * 86400_000;
  tick();
  const old = await reg({ email: "invited3@example.cn", code: firstCodes[2]!.code });
  assert.deepEqual([old.status, old.json.error.code], [410, "invite_expired"]);
  assert.deepEqual((await ops("op_6203", "GET", "/v1/ops/registration/invite-batches")).json.batches[0].by_status, { available: 0, exhausted: 1, expired: 2, disabled: 0 });
});

test("导出 CSV（要 registration.manage，含完整的码与使用人，防公式注入）；批量停用（编号列表、整个批次）", async () => {
  assert.equal((await ops("op_6203", "GET", "/v1/ops/registration/invites.csv")).status, 403);
  const csv = await ops("op_6202", "GET", "/v1/ops/registration/invites.csv");
  assert.equal(csv.status, 200);
  assert.match(csv.type!, /text\/csv/);
  assert.ok(csv.text.replace(/^﻿/, "").startsWith("邀请码,批次,状态"));
  assert.ok(csv.text.includes(firstCodes[0]!.code) && csv.text.includes("invited1@example.cn") && csv.text.includes("已用完"));
  const b = await ops("op_6202", "POST", "/v1/ops/registration/invite-batches", { name: "=HYPERLINK(1)", count: 4, max_uses: 2 });
  const ids = b.json.codes.map((x: any) => x.id);
  const csv2 = await ops("op_6202", "GET", `/v1/ops/registration/invites.csv?batch_id=${b.json.batch.id}`);
  assert.ok(csv2.text.includes("'=HYPERLINK(1)"), "以 = 开头的单元格加单引号");
  assert.equal(csv2.text.trim().split("\r\n").length, 5);
  assert.equal((await ops("op_6202", "POST", "/v1/ops/registration/invites/disable", { ids: ids.slice(0, 2), reason: "回收" })).json.disabled, 2);
  assert.equal((await ops("op_6202", "POST", "/v1/ops/registration/invites/disable", { ids: ["inv_AAAAAAAAAAAAAAAA"] })).json.error.code, "invite_unknown");
  const bd = await ops("op_6202", "POST", `/v1/ops/registration/invite-batches/${b.json.batch.id}/disable`, {});
  assert.deepEqual([bd.json.disabled, bd.json.batch.by_status.disabled], [2, 4]);
  const audit = (await ops("op_6203", "GET", "/v1/ops/registration/audit")).json.entries.map((e: any) => e.action);
  for (const a of ["invite.batch_create", "invite.export", "invite.disable_many", "invite.batch_disable", "invite.disable", "invite.enable"]) assert.ok(audit.includes(a), a);
});

test("并发注册原子占用：同一个只能用 1 次的码 6 人同时注册只成功 1 个；能用 2 次的 5 人同时注册成功 2 个", async () => {
  tick();
  const one = (await ops("op_6202", "POST", "/v1/ops/registration/invite-batches", { name: "并发一", count: 1, max_uses: 1 })).json.codes[0].code;
  const two = (await ops("op_6202", "POST", "/v1/ops/registration/invite-batches", { name: "并发二", count: 1, max_uses: 2 })).json.codes[0].code;
  const race = async (code: string, n: number, tag: string) => {
    tick();
    const rs = await Promise.all(Array.from({ length: n }, (_, i) => reg({ email: `race-${tag}-${i}@example.cn`, code })));
    return rs.map((r) => (r.status === 200 ? "ok" : r.json.error.code)).sort();
  };
  assert.deepEqual(await race(one, 6, "a"), ["invite_exhausted", "invite_exhausted", "invite_exhausted", "invite_exhausted", "invite_exhausted", "ok"]);
  assert.deepEqual(await race(two, 5, "b"), ["invite_exhausted", "invite_exhausted", "invite_exhausted", "ok", "ok"]);
  const list = (await ops("op_6202", "GET", `/v1/ops/registration/invites?q=${two}`)).json.invites[0];
  assert.deepEqual([list.used, list.status], [2, "exhausted"]);
});

test("重启读回：短信设置（AppKey 密文仍能解开、测试连接照常）、注册邀请码与使用记录、手机号索引；第 62 批之前的快照读回为短信关闭、不要求手机号", async () => {
  const c2 = createControlPlane({ keys, serviceSecret: SECRET, now, stateStore: { load: () => saved.at(-1)!, save: () => {} }, devStaff: devStaffOf({ op_6201: ["sysadmin"] }), sms: { base: submailBase } });
  await new Promise<void>((r) => c2.server.listen(0, "127.0.0.1", () => r()));
  const b2 = `http://127.0.0.1:${(c2.server.address() as AddressInfo).port}`;
  try {
    const tc = await ops("op_6201", "POST", "/v1/ops/registration/sms/test-connection", {}, b2);
    assert.equal(tc.json.balance, 9410, tc.text);
    assert.equal((await ops("op_6201", "GET", `/v1/ops/registration/invites/${firstCodes[0]!.id}`, undefined, b2)).json.uses[0].email, "invited1@example.cn");
    const tk = await call(b2, "POST", "/v1/auth/sms/send", { phone: "13700137000", purpose: "register" });
    assert.equal(tk.json.error.code, "phone_taken", "手机号索引随账号读回");
  } finally {
    c2.server.closeAllConnections();
    await new Promise<void>((r) => c2.server.close(() => r()));
  }
  // 旧快照：去掉 sms、registration 与 phone_required
  const old = JSON.parse(saved.at(-1)!);
  delete old.sms;
  delete old.registration;
  delete old.catalog.settings.phone_required;
  for (const a of old.accounts) delete a.phone;
  const c3 = createControlPlane({ keys, serviceSecret: SECRET, now, stateStore: { load: () => JSON.stringify(old), save: () => {} } });
  await new Promise<void>((r) => c3.server.listen(0, "127.0.0.1", () => r()));
  const b3 = `http://127.0.0.1:${(c3.server.address() as AddressInfo).port}`;
  try {
    const m = (await call(b3, "GET", "/v1/meta")).json.registration_policy;
    assert.deepEqual([m.require_phone, m.sms_available], [false, false]);
    assert.equal((await call(b3, "POST", "/v1/auth/login", { email: "phone1@example.cn", password: "Brandnew2026pass", client: { platform: "web" } })).status, 200, "没有手机号的账号照常登录");
  } finally {
    c3.server.closeAllConnections();
    await new Promise<void>((r) => c3.server.close(() => r()));
  }
});
