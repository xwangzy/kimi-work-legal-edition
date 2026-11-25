/**
 * 第 63 批：手机号验证码登录与绑定手机号（律师端界面；Windows 与 macOS 同一份界面代码）。
 * - 云端没开验证码登录（旧云端、legacy、phone_login 不是 true）→ 只有邮箱 + 密码登录，与第 62 批完全相同；
 * - 开了 → “验证码登录 | 密码登录”，先显示上次用过的（本机记住，读写失败按没有记录），没有记录先显示验证码登录；
 * - 手机号没注册：开通页给“用这个手机号注册”（手机号带过去）与“改用密码登录”；已激活电脑的重新登录框只给“改用密码登录”；
 * - 账号卡显示打码手机号或“未绑定”；绑定不要密码，更换要当前密码。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { errorReason, initialLoginMethod, LOGIN_METHOD_KEY, loginMethods, notRegisteredActions, phoneBindForm, phoneLabel, phoneNotRegistered, rememberedLoginMethod, saveLoginMethod, type RegistrationMeta } from "../src/lib/account.ts";

const read = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");
const activate = read("../src/pages/Activate.tsx");
const panel = read("../src/components/AccountPanel.tsx");
const sms = read("../src/components/SmsCodeFields.tsx");
const api = read("../src/api.ts");
const css = read("../src/styles.css");

const base: RegistrationMeta = { legacy: false, mode: "open", invite_required: false, require_phone: false, sms_available: true, phone_reset: true, sms: { code_length: 6, resend_seconds: 60, ttl_minutes: 10 } };

function memStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), map: m };
}
const broken = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

test("云端有无验证码登录：没有（旧云端、legacy、缺这一项、false）只显示密码登录；有才显示两种", () => {
  for (const m of [null, undefined, { legacy: true }, { legacy: true, phone_login: true }, base, { ...base, phone_login: false }]) {
    assert.deepEqual(loginMethods(m as RegistrationMeta | null | undefined), { phone: false, password: true }, JSON.stringify(m));
    assert.equal(initialLoginMethod(loginMethods(m as RegistrationMeta | null | undefined), "phone"), "password", "没开验证码登录时即使上次用过验证码，也只显示密码登录");
  }
  assert.deepEqual(loginMethods({ ...base, phone_login: true }), { phone: true, password: true });
  // 界面：只有云端开了才渲染“验证码登录 | 密码登录”；密码登录的原文案保留（旧云端与第 62 批完全相同）
  // 第 64 批：两种方式都有时页签就是卡片标题行；只有密码登录时换成一个标题（不再空着）
  assert.match(activate, /\{lm\.methods\.phone \? <LoginMethodTabs value=\{lm\.method\} onChange=\{switchTo\} \/> : <h1 className="auth-method-single">账号密码登录<\/h1>\}/);
  assert.match(panel, /\{lm\.methods\.phone \? <LoginMethodTabs value=\{lm\.method\} onChange=\{switchTo\} \/> : page \?/);
  // 第 64 批：登录卡片不再放一行说明（参照 Kimi 登录框），“第一次使用请先注册”由表单下方“还没有账号？注册”承担
  assert.ok(activate.includes("还没有账号？"));
  assert.match(sms, /const method: LoginMethod = methods\.phone \? \(chosen \?\? initialLoginMethod\(methods, remembered\)\) : "password";/);
});

test("记住上次用过的方式：没有记录先显示验证码登录；读写失败按没有记录；只记方式、不记号码", () => {
  const on = loginMethods({ ...base, phone_login: true });
  assert.equal(initialLoginMethod(on, null), "phone", "没有记录 → 验证码登录");
  assert.equal(initialLoginMethod(on, "password"), "password");
  assert.equal(initialLoginMethod(on, "phone"), "phone");
  assert.equal(LOGIN_METHOD_KEY, "kwl.login.method");
  const s = memStore();
  assert.equal(rememberedLoginMethod(s), null);
  saveLoginMethod("password", s);
  assert.equal(rememberedLoginMethod(s), "password");
  saveLoginMethod("phone", s);
  assert.deepEqual([...s.map.entries()], [["kwl.login.method", "phone"]], "只记方式");
  assert.equal(rememberedLoginMethod(memStore({ "kwl.login.method": "sms" })), null, "不认识的记录按没有");
  assert.equal(rememberedLoginMethod(broken), null, "读不了按没有记录");
  assert.doesNotThrow(() => saveLoginMethod("phone", broken), "存不下不影响登录");
  // 登录成功后才记（云端开了验证码登录时）；两处登录框都一样
  for (const src of [activate, panel]) assert.match(src, /if \(lm\.methods\.phone\) saveLoginMethod\(lm\.method\);/);
  // 策略还没取到、律师已经在填邮箱或密码：取到后不再切走
  assert.match(sms, /if \(meta === null && chosen === null\) setChosen\("password"\);/);
});

test("手机号没注册：开通页给“用这个手机号注册”与“改用密码登录”，手机号带到注册；重新登录框只给“改用密码登录”", () => {
  const e = Object.assign(new Error("这个手机号还没有注册账号。"), { code: "not_found", detail: { reason: "phone_not_registered" } });
  assert.equal(phoneNotRegistered(e), true);
  assert.equal(errorReason(e), "phone_not_registered");
  for (const x of [new Error("x"), null, undefined, { detail: { reason: "phone_taken" } }, { detail: { reason: 404 } }]) assert.equal(phoneNotRegistered(x), false);
  assert.deepEqual(notRegisteredActions("activate"), ["register", "password"]);
  assert.deepEqual(notRegisteredActions("relogin"), ["password"]);
  // 开通页：发码与登录两处都认这个原因；注册视图接过同一个手机号
  assert.match(activate, /onSendError=\{\(e\) => setUnreg\(phoneNotRegistered\(e\)\)\}/);
  assert.match(activate, /setUnreg\(byPhone && phoneNotRegistered\(e\)\)/);
  assert.match(activate, /notRegisteredActions\("activate"\)/);
  assert.ok(activate.includes("用这个手机号注册") && activate.includes("改用密码登录"));
  assert.match(activate, /onRegisterWithPhone=\{\(\) => \{\s*go\("register"\);/);
  assert.match(activate, /<RegisterForm meta=\{meta\} email=\{email\} setEmail=\{setEmail\} phone=\{phone\} setPhone=\{setPhone\}/);
  assert.match(activate, /const \{ phone, setPhone \} = p;/);
  // 已激活电脑：只能登这台电脑已登记的成员，不在这里注册
  assert.match(panel, /notRegisteredActions\("relogin"\)/);
  assert.ok(!panel.includes("用这个手机号注册"));
});

test("绑定 / 更换手机号：账号卡显示打码号码或“未绑定”；绑定不要密码，更换要当前密码", () => {
  assert.equal(phoneLabel("138****8000"), "138****8000");
  for (const v of [null, undefined, "", "  "]) assert.equal(phoneLabel(v), "未绑定");
  const bind = phoneBindForm(null, true);
  // 第 63 批安全审查：首次绑定也要当前密码
  assert.deepEqual([bind.change, bind.title, bind.needPassword, bind.phoneField], [false, "绑定手机号", true, "手机号"]);
  assert.equal(bind.done, "已绑定，之后可以用手机号验证码登录。");
  const change = phoneBindForm("138****8000", true);
  assert.deepEqual([change.change, change.title, change.needPassword, change.phoneField], [true, "更换手机号", true, "新手机号"]);
  assert.match(change.lead, /138\*\*\*\*8000/);
  // 云端没开验证码登录：不说“可以用手机号验证码登录”
  for (const f of [phoneBindForm(null), phoneBindForm("139****0000")]) assert.doesNotMatch(f.done + f.lead, /验证码登录/);
  // 界面：只有云端允许绑定才有按钮；更换时才出现“当前密码”；用自绘对话框
  assert.match(panel, /const bindable = !!meta && !meta\.legacy && meta\.phone_bind === true;/);
  assert.match(panel, /\{form\.needPassword && <PasswordField label="当前密码" value=\{pw\} onChange=\{setPw\} \/>\}/);
  assert.match(panel, /account\.bindPhone\(\{ phone: phone\.trim\(\), sms_code: code\.trim\(\), \.\.\.\(form\.needPassword \? \{ password: pw \} : \{\}\) \}\)/);
  assert.match(panel, /<Modal title=\{form\.title\}/);
  assert.match(panel, /purpose="bind"/);
  assert.match(panel, /phone=\{me\.account\.phone \?\? null\}/);
});

test("内核方法与验证码输入：四种用途、验证码登录同一个方法、发出后光标到验证码框、填满才回车提交、频控按云端秒数", () => {
  assert.match(api, /loginByPhone: \(phone: string, smsCode: string\) => invoke<any>\("account\.login", \{ phone, sms_code: smsCode \}\)/);
  assert.match(api, /login: \(email: string, password: string\) => invoke<any>\("account\.login", \{ email, password \}\)/, "密码登录保留");
  assert.match(api, /smsSend: \(phone: string, purpose: SmsPurpose\)/);
  assert.match(api, /bindPhone: \(o: \{ phone: string; sms_code: string; password\?: string \}\) => invoke<\{ ok: true; phone: string \| null \}>\("account\.bind_phone", o\)/);
  assert.match(read("../src/lib/account.ts"), /export type SmsPurpose = "register" \| "reset" \| "login" \| "bind";/);
  assert.match(sms, /codeRef\.current\?\.focus\(\);/);
  assert.match(sms, /if \(e\.key === "Enter" && p\.code\.length < p\.codeLength\) e\.preventDefault\(\);/, "没填满按回车不提交");
  assert.ok(!/requestSubmit|\.submit\(\)/.test(sms), "不自动提交");
  assert.ok(sms.includes("retry_after_s") && sms.includes("秒后重新获取"));
  // 两处登录框都用同一个组件、purpose=login；开通页不再自带一份
  for (const src of [activate, panel]) assert.match(src, /purpose="login"/);
  assert.ok(!/function SmsCodeFields\(/.test(activate) && !/function useRegistrationMeta\(/.test(activate));
});

test("无障碍与样式：外层“登录或注册”与内层“登录方式”都是 tablist / tab + aria-selected；内层轻一档；错误 role=alert", () => {
  // 第 64 批：参照 Kimi 登录框，“注册”从外层页签改为表单下方的入口（还没有账号？注册），注册页有“已有账号？登录”；
  // 页面以 data-auth-page 标明是开通页还是重新登录页（验收脚本据此识别）
  assert.doesNotMatch(activate, /aria-label="登录或注册"/);
  assert.match(activate, /还没有账号？\s*<button type="button" className="btn-link" onClick=\{p\.onRegister\}>\s*注册\s*<\/button>/);
  assert.match(activate, /已有账号？\s*<button type="button" className="btn-link" onClick=\{p\.onLogin\}>\s*登录\s*<\/button>/);
  assert.match(read("../src/components/AuthShell.tsx"), /data-auth-page=\{kind\}/);
  assert.match(sms, /className="auth-method" role="tablist" aria-label="登录方式"/);
  assert.equal((sms.match(/role="tab" aria-selected=\{value === "(phone|password)"\}/g) ?? []).length, 2);
  assert.match(css, /\.auth-method button\.on \{[^}]*border-bottom-color: var\(--text-primary\);/);
  assert.doesNotMatch(css.match(/\.auth-method \{[^}]*\}/)?.[0] ?? "", /background/, "内层不套底色");
  for (const src of [activate, panel]) assert.match(src, /className="activate-error" role="alert"/);
});

test("律师层用语：短信相关可见文字不出现“令牌、HMAC、dry-run、purpose”；开通页页脚涵盖手机号与验证码", () => {
  const visible = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
  for (const [name, src] of [["SmsCodeFields", sms], ["AccountPanel", panel], ["Activate", activate]] as const) {
    const texts = visible(src).match(/[^"'`<>{}\n]*[一-鿿][^"'`<>{}\n]*/g) ?? [];
    assert.deepEqual(texts.filter((t) => /令牌|HMAC|dry-run|dry_run|purpose|用途/i.test(t)), [], name);
  }
  for (const f of [phoneBindForm(null, true), phoneBindForm("138****8000", true)]) assert.doesNotMatch(Object.values(f).join(" "), /令牌|HMAC|dry-run|purpose/);
  assert.ok(activate.includes("登录与开通只把邮箱或手机号、密码或短信验证码、开通码或邀请码发给 Kimi Work 服务核对；你的案卷不会上传。"));
  assert.ok(sms.includes("测试环境：验证码是"), "测试环境照第 62 批写明");
});
