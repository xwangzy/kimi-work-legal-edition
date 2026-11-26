/**
 * 第 63 批：手机号验证码登录、绑定 / 更换手机号、短信服务集中配置（契约 docs/contract-b63-phone-login.md）。
 *
 * - /v1/meta 能力字段 phone_login / phone_bind；登录开关 login_enabled（缺省开，关掉只影响验证码登录）；模板不填沿用注册模板；
 * - 登录发码：没注册的手机号不发（404 phone_not_registered）、停用账号不发；验证码登录与密码登录同一套会话与 onboarding；
 *   一次性、输错计次、跨用途不认（注册码不能登录、登录码不能绑定）；密码锁定不挡验证码登录且成功后清零；
 * - 老账号（只有邮箱）登录后绑定手机号（要会话）；换绑要当前密码（错了不耗验证码）；被占用 / 同号；平台人员不能绑定；
 * - 来源每小时查询上限（防批量探测）；每日统计（发送成败、失败原因、被拦下、核对成败），重启读回；
 * - 旧快照（第 62 批）读回：登录开关为开。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createControlPlane, devControlPlaneKeys, type ControlPlane, type StateStore } from "../src/index.ts";
import { submailSignature } from "../src/sms.ts";
import { call, devStaffOf, staffEmail, staffToken } from "./staff-fixture.ts";

const SECRET = "b63-test-service-secret-0123456789abcdef";
const PW = "Lawyer2026secure";
const APP_KEY = "b63testappkey0123456789abcdefABCD";
const keys = devControlPlaneKeys();

// ─── 假的赛邮云：核对签名，记下发出的短信 ───
let failNext: string | null = null;
const sent: { to: string; project: string; vars: Record<string, string> }[] = [];
let submail: Server;
let submailBase = "";
const formOf = async (req: IncomingMessage) => {
  let raw = "";
  for await (const c of req) raw += c;
  return Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>;
};

let T = Date.parse("2026-11-25T02:00:00.000Z");
const now = () => T;
const saved: string[] = [];
const store: StateStore = { load: () => saved.at(-1) ?? null, save: (j) => void saved.push(j) };
let cp: ControlPlane;
let base = "";
const tokens = new Map<string, { token: string; at: number }>();

before(async () => {
  submail = createServer(async (req, res) => {
    const reply = (j: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(j));
    };
    const f = await formOf(req);
    const { signature, ...params } = f;
    if (signature !== submailSignature(f.appid!, APP_KEY, params)) return reply({ status: "error", code: "108" });
    if (failNext) {
      const c = failNext;
      failNext = null;
      return reply({ status: "error", code: c });
    }
    if (req.url === "/sms/xsend") {
      sent.push({ to: f.to!, project: f.project!, vars: JSON.parse(f.vars!) });
      return reply({ status: "success", send_id: "s1", fee: 1 });
    }
    reply({ status: "success", balance: "100", transactional_balance: "100" });
  });
  await new Promise<void>((r) => submail.listen(0, "127.0.0.1", () => r()));
  submailBase = `http://127.0.0.1:${(submail.address() as AddressInfo).port}`;
  cp = createControlPlane({ keys, serviceSecret: SECRET, now, stateStore: store, devStaff: devStaffOf({ op_6301: ["sysadmin"], op_6302: ["operator"], op_6303: ["support"] }), sms: { allowDryRun: false, base: submailBase, timeoutMs: 800 } });
  await new Promise<void>((r) => cp.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(cp.server.address() as AddressInfo).port}`;
});
after(async () => {
  for (const s of [cp.server, submail]) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

const tokenOf = async (who: string, at = base) => {
  const k = `${at}|${who}`;
  const c = tokens.get(k);
  if (c && T - c.at < 5 * 60_000) return c.token;
  const token = await staffToken(at, staffEmail(who));
  tokens.set(k, { token, at: T });
  return token;
};
const ops = async (who: string, method: string, path: string, body?: unknown, at = base) => call(at, method, path, body, { authorization: `Bearer ${await tokenOf(who, at)}` });
const pub = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => call(base, method, path, body, headers);
/** 越过每分钟的入口限速窗口与 60 秒重发间隔。 */
const tick = (ms = 61_000) => void (T += ms);
const nextHour = () => void (T = Math.ceil((T + 1) / 3600_000) * 3600_000 + 1000);
const smsPut = (body: unknown) => ops("op_6301", "PUT", "/v1/ops/registration/sms", body);
const send = async (phone: string, purpose: string, headers: Record<string, string> = {}) => {
  tick();
  return pub("POST", "/v1/auth/sms/send", { phone, purpose }, headers);
};
const lastCode = () => sent.at(-1)!.vars.code!;
const desktop = { platform: "darwin", version: "0.4.0" };
const loginPhone = (phone: string, sms_code: string) => pub("POST", "/v1/auth/login", { phone, sms_code, client: desktop });
const loginPw = (email: string, password = PW) => pub("POST", "/v1/auth/login", { email, password, client: desktop });
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

/** 用手机号注册一个账号（走第 62 批的注册流程），返回会话令牌。 */
async function registerWithPhone(email: string, phone: string): Promise<string> {
  const r = await send(phone, "register");
  assert.equal(r.status, 200, r.text);
  tick();
  const a = await pub("POST", "/v1/auth/register", { email, password: PW, name: "验证码律师", phone, sms_code: lastCode(), client: { platform: "web" } });
  assert.equal(a.status, 200, a.text);
  return a.json.session_token as string;
}

test("短信配置：登录开关缺省开、模板不填沿用注册模板；/v1/meta 公布 phone_login、phone_bind；关掉登录开关只影响验证码登录", async () => {
  let m = (await pub("GET", "/v1/meta")).json;
  assert.deepEqual([m.registration_policy.phone_login, m.registration_policy.phone_bind], [false, false], "短信未配置");
  assert.ok(m.features.includes("phone_login") && m.features.includes("phone_bind"));
  const put = await smsPut({ enabled: true, app_id: "100063", app_key: APP_KEY, sign_name: "测试签名", projects: { register: "ProjReg63" } });
  assert.equal(put.status, 200, put.text);
  const v = put.json.sms;
  assert.equal(v.login_enabled, true);
  assert.equal(v.login_available, true);
  assert.deepEqual(v.projects_effective, { register: "ProjReg63", reset: "ProjReg63", login: "ProjReg63", bind: "ProjReg63" });
  assert.deepEqual(v.missing_by_purpose, { register: [], reset: [], login: [], bind: [] });
  m = (await pub("GET", "/v1/meta")).json.registration_policy;
  assert.deepEqual([m.sms_available, m.phone_reset, m.phone_login, m.phone_bind], [true, true, true, true]);
  // 关掉登录开关：只影响验证码登录
  const off = await smsPut({ login_enabled: false });
  assert.deepEqual([off.json.changed, off.json.sms.login_available], [["login_enabled"], false]);
  m = (await pub("GET", "/v1/meta")).json.registration_policy;
  assert.deepEqual([m.sms_available, m.phone_login, m.phone_bind], [true, false, true]);
  const d1 = await send("13900139001", "login");
  assert.deepEqual([d1.status, d1.json.error.code], [503, "sms_login_disabled"]);
  const d2 = await loginPhone("13900139001", "123456");
  assert.deepEqual([d2.status, d2.json.error.code], [503, "sms_login_disabled"]);
  assert.equal((await send("13900139001", "register")).status, 200, "注册发码照常");
  assert.equal((await smsPut({ login_enabled: "yes" })).json.error.code, "sms_settings_invalid");
  // 单独的登录模板
  const lp = await smsPut({ login_enabled: true, projects: { login: "ProjLogin63" } });
  assert.deepEqual([lp.json.sms.projects_effective.login, lp.json.sms.projects_effective.bind], ["ProjLogin63", "ProjReg63"]);
  const ov = (await ops("op_6303", "GET", "/v1/ops/registration")).json;
  assert.deepEqual([ov.sms.login_enabled, ov.sms.login_available, ov.meta.phone_login], [true, true, true]);
});

test("验证码登录：没注册的手机号不发码；登录码用登录模板；登录成功与密码登录同一套会话与账号视图；一次性、输错计次、跨用途不认", async () => {
  const before0 = sent.length;
  const nr = await send("13900139002", "login");
  assert.deepEqual([nr.status, nr.json.error.code], [404, "phone_not_registered"]);
  assert.match(nr.json.error.message, /还没有注册/);
  assert.equal(sent.length, before0, "没注册的号不花短信费");
  await registerWithPhone("smslogin1@example.cn", "13900139003");
  const regCode = lastCode();
  // 注册用过的码不能拿来登录（码绑定用途）
  tick();
  const cross = await loginPhone("13900139003", regCode);
  assert.deepEqual([cross.status, cross.json.error.code], [400, "sms_code_expired"]);
  const s = await send("139 0013 9003", "login");
  assert.deepEqual([s.status, s.json.phone, s.json.code_length], [200, "139****9003", 6], s.text);
  assert.equal(sent.at(-1)!.project, "ProjLogin63");
  const code = lastCode();
  tick();
  const bad = await loginPhone("13900139003", code === "000000" ? "000001" : "000000");
  assert.deepEqual([bad.status, bad.json.error.code, bad.json.error.attempts_left], [400, "sms_code_invalid", 4]);
  tick();
  const miss = await loginPhone("13900139003", "");
  assert.deepEqual([miss.status, miss.json.error.code], [400, "sms_code_required"], "没填验证码不耗次数");
  tick();
  const ok = await loginPhone("+86 139-0013-9003", code);
  assert.equal(ok.status, 200, ok.text);
  assert.match(ok.json.session_token, /^kws1\./);
  assert.deepEqual([ok.json.account.email, ok.json.account.phone, ok.json.onboarding.state], ["smslogin1@example.cn", "139****9003", "needs_founder_setup"]);
  const me = await pub("GET", "/v1/auth/me", undefined, bearer(ok.json.session_token));
  assert.equal(me.json.account.phone, "139****9003");
  tick();
  const reuse = await loginPhone("13900139003", code);
  assert.deepEqual([reuse.status, reuse.json.error.code], [400, "sms_code_expired"], "一次性");
  // 原来的邮箱 + 密码登录照常
  tick();
  assert.equal((await loginPw("smslogin1@example.cn")).status, 200);
  // 输错 5 次作废
  await send("13900139003", "login");
  const c5 = lastCode();
  const wrong = c5 === "999999" ? "999998" : "999999";
  for (let i = 0; i < 4; i++) {
    tick();
    assert.equal((await loginPhone("13900139003", wrong)).json.error.code, "sms_code_invalid");
  }
  tick();
  assert.equal((await loginPhone("13900139003", wrong)).json.error.code, "sms_code_attempts");
  tick();
  assert.equal((await loginPhone("13900139003", c5)).json.error.code, "sms_code_attempts", "次数用完后对的码也不认");
  // 重新获取 → 新码可用；旧码作废
  await send("13900139003", "login");
  tick();
  assert.equal((await loginPhone("13900139003", lastCode())).status, 200);
});

test("密码锁定不挡验证码登录且成功后清零；停用账号不发登录码", async () => {
  await registerWithPhone("smslogin2@example.cn", "13900139004");
  for (let i = 0; i < 10; i++) {
    tick(1000);
    await loginPw("smslogin2@example.cn", "Wrongpass2026x");
  }
  tick(1000);
  assert.equal((await loginPw("smslogin2@example.cn")).json.error.code, "account_locked");
  await send("13900139004", "login");
  const lc = lastCode();
  tick();
  assert.equal((await loginPhone("13900139004", lc)).status, 200, "持有手机即本人");
  tick();
  assert.equal((await loginPw("smslogin2@example.cn")).status, 200, "失败计数已清零");
  // 停用账号：不发登录码
  const acc = (await ops("op_6301", "GET", "/v1/ops/accounts?q=smslogin2%40example.cn")).json;
  const aid = (acc.accounts ?? acc.rows ?? acc.items)[0].aid as string;
  const dis = await ops("op_6302", "POST", `/v1/ops/accounts/${aid}/disable`, { reason: "用例" });
  assert.equal(dis.status, 200, dis.text);
  const n0 = sent.length;
  const d = await send("13900139004", "login");
  assert.deepEqual([d.status, d.json.error.code, sent.length], [403, "account_disabled", n0]);
});

test("绑定手机号：老账号（只有邮箱）登录后绑定；要会话；绑定与换绑都要当前密码（错了不耗验证码）；被占用只在核码后说；同号；换绑后旧号不能登录", async () => {
  tick();
  const r = await pub("POST", "/v1/auth/register", { email: "oldmail@example.cn", password: PW, name: "老用户", client: { platform: "web" } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.account.phone, null);
  const tok = r.json.session_token as string;
  // 没登录不能发绑定码
  const anon = await send("13900139005", "bind");
  assert.deepEqual([anon.status, anon.json.error.code], [401, "session_required"]);
  // 已被别的账号占用
  const taken = await send("13900139003", "bind", bearer(tok));
  assert.deepEqual([taken.status, taken.json.error.code], [409, "phone_taken"]);
  const s = await send("13900139005", "bind", bearer(tok));
  assert.equal(s.status, 200, s.text);
  assert.equal(sent.at(-1)!.project, "ProjReg63", "绑定模板不填沿用注册模板");
  const bc = lastCode();
  // 绑定码不能拿来登录；手机号没有账号时登录接口与“没有有效验证码”同样回答（是否注册只在发码时说）
  tick();
  assert.equal((await loginPhone("13900139005", bc)).json.error.code, "sms_code_expired");
  // 安全审查：首次绑定也要当前密码（偷到会话不能给账号加上可登录的手机号）；密码错不耗验证码
  tick();
  const nb = await pub("POST", "/v1/auth/phone", { phone: "13900139005", sms_code: bc }, bearer(tok));
  assert.deepEqual([nb.status, nb.json.error.code, nb.json.error.message], [401, "auth_invalid", "当前密码不正确"]);
  // 拿别人的号：没有那台手机上的绑定码，只看到“验证码已过期”，探不出是否被占用
  tick();
  const probe = await pub("POST", "/v1/auth/phone", { phone: "13900139003", sms_code: "123456", password: PW }, bearer(tok));
  assert.deepEqual([probe.status, probe.json.error.code], [400, "sms_code_expired"]);
  tick();
  const b = await pub("POST", "/v1/auth/phone", { phone: "13900139005", sms_code: bc, password: PW }, bearer(tok));
  assert.equal(b.status, 200, b.text);
  assert.equal(b.json.account.phone, "139****9005");
  // 同号再绑
  const same = await send("13900139005", "bind", bearer(tok));
  assert.deepEqual([same.status, same.json.error.code], [409, "phone_same"]);
  // 现在可以用验证码登录
  await send("13900139005", "login");
  tick();
  const lg = await loginPhone("13900139005", lastCode());
  assert.deepEqual([lg.status, lg.json.account.email], [200, "oldmail@example.cn"]);
  // 换绑：要当前密码；密码错不耗验证码
  await send("13900139006", "bind", bearer(tok));
  const nc = lastCode();
  tick();
  const noPw = await pub("POST", "/v1/auth/phone", { phone: "13900139006", sms_code: nc }, bearer(tok));
  assert.deepEqual([noPw.status, noPw.json.error.code], [401, "auth_invalid"]);
  tick();
  const ch = await pub("POST", "/v1/auth/phone", { phone: "13900139006", sms_code: nc, password: PW }, bearer(tok));
  assert.equal(ch.status, 200, ch.text);
  assert.equal(ch.json.account.phone, "139****9006");
  const old = await send("13900139005", "login");
  assert.equal(old.json.error.code, "phone_not_registered", "旧号已解除");
  assert.equal((await send("13900139005", "register")).status, 200, "旧号可以给别人注册");
  // 平台人员不能绑定
  const st = await call(base, "POST", "/v1/auth/phone", { phone: "13900139007", sms_code: "123456", password: PW }, { authorization: `Bearer ${await tokenOf("op_6303")}` });
  assert.deepEqual([st.status, st.json.error.code], [403, "member_only"]);
  const stSend = await send("13900139007", "bind", { authorization: `Bearer ${await tokenOf("op_6303")}` });
  assert.deepEqual([stSend.status, stSend.json.error.code], [403, "member_only"]);
});

test("来源每小时查询上限（防批量探测手机号是否注册）；每日统计：发送成败、失败原因、被拦下、核对成败（只有数字）", async () => {
  nextHour();
  let last = 0;
  for (let i = 0; i < 31; i++) {
    const r = await send(`1370000${String(1000 + i)}`, "login");
    last = r.status;
    if (i < 30) assert.equal(r.json.error.code, "phone_not_registered", `第 ${i + 1} 次`);
    else assert.equal(r.json.error.code, "sms_probe_limit");
  }
  assert.equal(last, 429);
  // 安全审查：上限只挡“会泄露是否注册”的应答——同一出口下已注册的手机号照常收到登录码（不再整栋楼一小时收不到验证码）
  const legit = await send("13900139006", "login");
  assert.equal(legit.status, 200, legit.text);
  // 发送失败计入失败原因
  nextHour();
  failNext = "420";
  const f = await send("13900139008", "register");
  assert.equal(f.json.error.code, "sms_template_invalid");
  const lg = (await ops("op_6303", "GET", "/v1/ops/registration/sms/logs?purpose=login")).json;
  assert.ok(lg.logs.length >= 3 && lg.logs.every((x: { purpose: string }) => x.purpose === "login"));
  const day = lg.stats[0];
  assert.equal(day.day, "2026-11-25");
  assert.ok(day.sent >= 8, JSON.stringify(day));
  assert.equal(day.failed, 1);
  assert.deepEqual(day.fail_codes, { sms_template_invalid: 1 });
  assert.equal(day.blocked.sms_probe_limit, 1);
  assert.ok(day.by_purpose.login >= 4 && day.by_purpose.bind >= 2 && day.by_purpose.register >= 4, JSON.stringify(day.by_purpose));
  assert.ok(day.verify_ok >= 6 && day.verify_failed >= 7 && day.attempts_exhausted >= 1, JSON.stringify(day));
  assert.equal(JSON.stringify(lg).includes("1390013900"), false, "统计与记录里没有完整手机号");
  // 重发间隔被拦下计入 blocked
  await send("13900139009", "register");
  tick(5_000);
  const fast = await pub("POST", "/v1/auth/sms/send", { phone: "13900139009", purpose: "register" });
  assert.equal(fast.json.error.code, "sms_too_frequent");
  const st2 = (await ops("op_6303", "GET", "/v1/ops/registration/sms/logs")).json.stats[0];
  assert.equal(st2.blocked.sms_too_frequent, 1);
});

test("重启读回：登录开关与模板、绑定的手机号、每日统计；第 62 批快照（没有 login_enabled）读回为开", async () => {
  tick(31_000); // 让 30 秒定时写盘把统计落盘（被拦下的请求不触发整份写盘）
  await smsPut({ ip_hourly_limit: 999 });
  const snap = saved.at(-1)!;
  const c2 = createControlPlane({ keys, serviceSecret: SECRET, now, stateStore: { load: () => snap, save: () => {} }, devStaff: devStaffOf({ op_6301: ["sysadmin"] }), sms: { allowDryRun: false, base: submailBase } });
  await new Promise<void>((r) => c2.server.listen(0, "127.0.0.1", () => r()));
  const b2 = `http://127.0.0.1:${(c2.server.address() as AddressInfo).port}`;
  try {
    const v = (await ops("op_6301", "GET", "/v1/ops/registration/sms", undefined, b2)).json.sms;
    assert.deepEqual([v.login_enabled, v.projects.login, v.login_available], [true, "ProjLogin63", true]);
    const lg = (await ops("op_6301", "GET", "/v1/ops/registration/sms/logs", undefined, b2)).json;
    assert.equal(lg.stats[0].blocked.sms_probe_limit, 1, "每日统计随快照读回");
    tick();
    const s = await call(b2, "POST", "/v1/auth/sms/send", { phone: "13900139006", purpose: "login" });
    assert.equal(s.status, 200, `换绑后的手机号索引随账号读回：${s.text}`);
  } finally {
    c2.server.closeAllConnections();
    await new Promise<void>((r) => c2.server.close(() => r()));
  }
  const old = JSON.parse(snap);
  delete old.sms.login_enabled;
  delete old.sms.projects.bind;
  delete old.sms_stats;
  const c3 = createControlPlane({ keys, serviceSecret: SECRET, now, stateStore: { load: () => JSON.stringify(old), save: () => {} }, sms: { allowDryRun: false, base: submailBase } });
  await new Promise<void>((r) => c3.server.listen(0, "127.0.0.1", () => r()));
  const b3 = `http://127.0.0.1:${(c3.server.address() as AddressInfo).port}`;
  try {
    const m = (await call(b3, "GET", "/v1/meta")).json.registration_policy;
    assert.deepEqual([m.phone_login, m.phone_bind], [true, true]);
  } finally {
    c3.server.closeAllConnections();
    await new Promise<void>((r) => c3.server.close(() => r()));
  }
});

test("安全审查：开着验证码登录时验证码强度不能调弱；dry-run 只回注册验证码（登录、找回、绑定视为不可用）", async () => {
  // 强度：开着验证码登录时不能 4 位码 / 单码 10 次；关掉验证码登录才可以
  const weak = await smsPut({ code_length: 4 });
  assert.deepEqual([weak.status, weak.json.error.code], [400, "sms_login_too_weak"]);
  assert.equal((await smsPut({ max_attempts: 10 })).json.error.code, "sms_login_too_weak");
  const offWeak = await smsPut({ login_enabled: false, code_length: 4 });
  assert.equal(offWeak.status, 200, offWeak.text);
  assert.equal((await smsPut({ login_enabled: true })).json.error.code, "sms_login_too_weak", "调弱后不能再打开验证码登录");
  assert.equal((await smsPut({ code_length: 6, login_enabled: true })).status, 200);
  // dry-run（允许 dry-run 的部署，但没有放开全部回码）：注册码照常回，登录 / 找回 / 绑定不可用
  const dev = createControlPlane({ keys: devControlPlaneKeys(), serviceSecret: SECRET, now, devStaff: devStaffOf({ op_6399: ["sysadmin"] }), sms: { allowDryRun: true, base: submailBase } });
  await new Promise<void>((r) => dev.server.listen(0, "127.0.0.1", () => r()));
  const db = `http://127.0.0.1:${(dev.server.address() as AddressInfo).port}`;
  try {
    const tk = await staffToken(db, staffEmail("op_6399"));
    const put = await call(db, "PUT", "/v1/ops/registration/sms", { enabled: true, dry_run: true }, { authorization: `Bearer ${tk}` });
    assert.equal(put.status, 200, put.text);
    const m = (await call(db, "GET", "/v1/meta")).json.registration_policy;
    assert.deepEqual([m.sms_available, m.phone_login, m.phone_reset, m.phone_bind], [true, false, false, false]);
    const r1 = await call(db, "POST", "/v1/auth/sms/send", { phone: "13900139100", purpose: "register" });
    assert.deepEqual([r1.status, r1.json.dry_run, /^\d{6}$/.test(r1.json.debug_code)], [200, true, true]);
    tick();
    const reg1 = await call(db, "POST", "/v1/auth/register", { email: "dry@example.cn", password: PW, name: "测试", phone: "13900139100", sms_code: r1.json.debug_code, client: { platform: "web" } });
    assert.equal(reg1.status, 200, reg1.text);
    tick();
    for (const purpose of ["login", "reset"]) {
      const r = await call(db, "POST", "/v1/auth/sms/send", { phone: "13900139100", purpose });
      assert.equal(r.json.debug_code, undefined, `${purpose} 不回码`);
      assert.equal(r.status === 503 || (purpose === "reset" && r.status === 200 && r.json.debug_code === undefined), true, `${purpose}：${r.text}`);
      tick();
    }
    const lg = await call(db, "POST", "/v1/auth/login", { phone: "13900139100", sms_code: "123456", client: { platform: "web" } });
    assert.deepEqual([lg.status, lg.json.error.code], [503, "sms_login_disabled"]);
  } finally {
    dev.server.closeAllConnections();
    await new Promise<void>((r) => dev.server.close(() => r()));
  }
});

// 第 69 批（V43）：密码登录也认验证过的手机号——“邮箱”一栏填 11 位手机号时按手机号找账号；锁定、失败计数与邮箱相同；
// 找不到与密码错同样回答（不泄露手机号是否注册）；/v1/meta 公布 password_by_phone
test("第 69 批：手机号 + 密码登录；找不到与密码错同一回答；与邮箱共用锁定计数", async () => {
  await smsPut({ enabled: true, app_id: "100063", app_key: APP_KEY, sign_name: "测试签名", projects: { register: "ProjReg63" } });
  nextHour();
  await registerWithPhone("pwphone69@example.cn", "13900139269");
  const m = (await pub("GET", "/v1/meta")).json;
  assert.equal(m.registration_policy.password_by_phone, true);
  tick();
  const ok = await loginPw("13900139269");
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.account.email, "pwphone69@example.cn");
  tick();
  const bad = await loginPw("13900139269", "wrong-password-1");
  assert.deepEqual([bad.status, bad.json.error.code, bad.json.error.message], [401, "auth_invalid", "手机号或密码不正确"]);
  tick();
  const none = await loginPw("13900139999", PW);
  assert.deepEqual([none.status, none.json.error.code, none.json.error.message], [401, "auth_invalid", "手机号或密码不正确"], "没注册的手机号与密码错同样回答");
  tick();
  const junk = await loginPw("not-a-phone", PW);
  assert.equal(junk.status, 401, "既不是邮箱也不是手机号：同样回答，不报格式");
});
