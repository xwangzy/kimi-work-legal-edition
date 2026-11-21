/**
 * 登录页（契约 §2、§3.1）：一个页面、三种视图——
 *   login     邮箱 + 密码（律师、律所管理员、中软平台人员同一入口；密码正确即进入，D-218 起平台人员不再有第二步）
 *   register  注册：开通码 / 邀请码（注册方式 code 时必填）；成功后若 onboarding 要在客户端完成开通或入组，给出下一步
 *   reset     设置或重置密码：邮箱验证码、管理员给的重置码、平台人员的设置码（首次设置也走这里）
 * 本模块只管登录卡片；拿到会话后交给 app.js 的 onAuthed。
 */
import * as api from "./api.js";
import { $, btn, clear, errText, h } from "./ui.js";

const st = { meta: null, email: "", onAuthed: null };

export function initAuth({ onAuthed, meta }) {
  st.onAuthed = onAuthed;
  st.meta = meta ?? null;
}
export const setMeta = (m) => (st.meta = m);

/** 密码本页预检（与控制面同一规则：≥10 位、字母与数字、不含邮箱前缀；以控制面结果为准） */
export function passwordHint(next, again, email) {
  if (String(next).length < 10) return "密码至少 10 位";
  if (!/[A-Za-z]/.test(next) || !/[0-9]/.test(next)) return "密码须同时包含字母和数字";
  const local = String(email ?? "").split("@")[0].toLowerCase();
  if (local.length >= 3 && String(next).toLowerCase().includes(local)) return "密码不要包含邮箱前缀";
  if (again !== undefined && next !== again) return "两次输入的密码不一致";
  return null;
}
const PW_RULE = "至少 10 位，同时包含字母和数字，不含邮箱前缀。";

function shell(title, sub, ...body) {
  const cfg = api.config();
  const card = $("#auth-card");
  clear(
    card,
    h("div", { class: "auth-brand" }, h("span", { class: "brand-mark", "aria-hidden": "true" }, "K"), h("div", {}, h("b", {}, "Kimi Work 法律版"), h("small", {}, cfg ? `云端控制台 · ${cfg.label || cfg.deployment}` : "云端控制台"))),
    h("div", { class: "auth-titles" }, h("h1", {}, title), sub ? h("p", {}, sub) : null),
    ...body,
  );
  $("#boot").hidden = true;
  $("#app").hidden = true;
  $("#auth").hidden = false;
  return card;
}
const fieldEl = (label, input, hint) => h("div", { class: "field" }, h("label", { for: input.id }, label), input, hint ? h("small", { class: "hint" }, hint) : null);
const input = (id, attrs) => h("input", { id, spellcheck: "false", autocapitalize: "off", ...attrs });
const submitting = async (button, label, fn) => {
  const keep = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.textContent = keep;
  }
};
const links = (...items) => h("div", { class: "auth-links" }, items.filter(Boolean));
const linkTo = (label, fn) => h("button", { type: "button", class: "link", onclick: fn }, label);
const registration = () => st.meta?.registration ?? null;

// ─── 登录 ──────────────────────────────────────────────────────────
export function showLogin(message, tone = "error") {
  const email = input("lg-email", { type: "email", name: "email", autocomplete: "username", value: st.email, placeholder: "name@example.com" });
  const pw = input("lg-pw", { type: "password", name: "password", autocomplete: "current-password" });
  const err = h("p", { class: tone === "error" ? "form-error" : "form-note", role: tone === "error" ? "alert" : "status" }, message ?? "");
  const submit = h("button", { type: "submit", class: "btn primary block" }, "登录");
  const form = h("form", { class: "auth-form", novalidate: true }, fieldEl("邮箱", email), h("div", { class: "field" }, h("div", { class: "label-row" }, h("label", { for: "lg-pw" }, "密码"), linkTo("忘记密码？", () => showReset({ email: email.value.trim() }))), pw), err, submit);
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    err.className = "form-error";
    err.textContent = "";
    const e = email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return void ((err.textContent = "请输入邮箱"), email.focus());
    if (!pw.value) return void ((err.textContent = "请输入密码"), pw.focus());
    st.email = e;
    await submitting(submit, "正在登录…", async () => {
      try {
        const r = await api.auth.login(e, pw.value);
        pw.value = "";
        await st.onAuthed(r);
      } catch (x) {
        err.textContent = errText(x);
        pw.select();
      }
    });
  });
  const reg = registration();
  shell(
    "登录",
    "律师、律所管理员与中软平台人员用同一个账号登录。",
    form,
    links(reg === "closed" ? null : linkTo("注册账号", () => showRegister()), linkTo("首次设置密码 / 我有设置码", () => showReset({ email: email.value.trim(), setup: true }))),
    h("p", { class: "auth-foot" }, "关闭标签页即退出；平台人员闲置 30 分钟或登录满 12 小时需重新登录。"),
  );
  (email.value ? pw : email).focus();
}

// ─── 注册 ──────────────────────────────────────────────────────────
export function showRegister() {
  const reg = registration();
  const email = input("rg-email", { type: "email", autocomplete: "username", value: st.email });
  const name = input("rg-name", { type: "text", autocomplete: "name", maxlength: 40 });
  const code = input("rg-code", { type: "text", autocomplete: "off", placeholder: reg === "code" ? "必填" : "选填：律所发的开通码或邀请码" });
  const org = input("rg-org", { type: "text", maxlength: 40, placeholder: "选填：不填则为“你的姓名的工作室”" });
  const pw = input("rg-pw", { type: "password", autocomplete: "new-password" });
  const again = input("rg-again", { type: "password", autocomplete: "new-password" });
  const err = h("p", { class: "form-error", role: "alert" });
  const submit = h("button", { type: "submit", class: "btn primary block" }, "注册");
  const orgField = fieldEl("律所或团队名称", org, "不带码注册会新建一个试用团队（你是管理员）");
  const syncOrg = () => (orgField.hidden = reg === "code" || code.value.trim() !== "");
  code.addEventListener("input", syncOrg);
  const form = h(
    "form",
    { class: "auth-form", novalidate: true },
    fieldEl("邮箱", email),
    fieldEl("姓名", name),
    fieldEl("开通码或邀请码", code, reg === "code" ? "向中软客户经理（开通码）或律所管理员（邀请码）索取" : "律所发的码会把你加入该所；不填即自建试用团队"),
    orgField,
    fieldEl("密码", pw, PW_RULE),
    fieldEl("再输入一次密码", again),
    err,
    submit,
  );
  syncOrg();
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    err.textContent = "";
    const e = email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return void ((err.textContent = "请输入邮箱"), email.focus());
    if (!name.value.trim()) return void ((err.textContent = "请填写姓名"), name.focus());
    if (reg === "code" && !code.value.trim()) return void ((err.textContent = "请输入开通码或邀请码"), code.focus());
    const bad = passwordHint(pw.value, again.value, e);
    if (bad) return void ((err.textContent = bad), pw.focus());
    st.email = e;
    await submitting(submit, "正在注册…", async () => {
      try {
        const body = { email: e, name: name.value.trim(), password: pw.value };
        if (code.value.trim()) body.code = code.value.trim();
        else if (org.value.trim()) body.org_name = org.value.trim();
        const r = await api.auth.register(body);
        pw.value = again.value = "";
        const state = r.onboarding?.state;
        if (state === "needs_founder_setup" || state === "needs_device_join") return showNextStep(r);
        await st.onAuthed(r);
      } catch (x) {
        err.textContent = errText(x);
      }
    });
  });
  shell("注册账号", reg === "code" ? "凭律所或中软发的码注册。" : "注册后可在网页查看用量；律师工作在 Windows 客户端里完成。", form, links(linkTo("已有账号，去登录", () => showLogin())));
  (email.value ? name : email).focus();
}

/** 注册成功但还要在客户端完成开通 / 入组：讲清下一步 */
function showNextStep(r) {
  const founder = r.onboarding.state === "needs_founder_setup";
  const firm = r.onboarding.firm?.name ?? r.account?.org?.name ?? "";
  shell(
    "账号已注册",
    `${r.account?.email ?? st.email}${firm ? ` · ${firm}` : ""}`,
    h(
      "div",
      { class: "next-step" },
      h("b", {}, founder ? "下一步：在 Windows 客户端完成律所开通" : "下一步：在 Windows 客户端完成入组"),
      h(
        "ol",
        {},
        h("li", {}, "在你的办公电脑上安装并打开 Kimi Work 法律版客户端；"),
        h("li", {}, "用刚注册的邮箱和密码登录；"),
        founder
          ? h("li", {}, "按提示生成本所密钥并完成开通（律所密钥只在这台管理员电脑上生成与保管）。")
          : h("li", {}, "客户端会提交入组申请，请律所管理员在其电脑上批准；批准后即可使用。"),
      ),
      h("p", { class: "muted small" }, "网页控制台可以查看你的用量、管理登录与电脑；律师工作在客户端里完成。"),
    ),
    h("div", { class: "btn-row" }, btn("进入控制台", (ev) => submitting(ev.currentTarget, "正在进入…", () => st.onAuthed(r)), { kind: "primary" }), btn("退出", async () => (api.saveSession(r.session_token), await api.logout(), showLogin("已退出", "note")))),
  );
}

// ─── 设置 / 重置密码 ────────────────────────────────────────────────
export function showReset(o = {}) {
  const email = input("rs-email", { type: "email", autocomplete: "username", value: o.email ?? st.email });
  const code = input("rs-code", { type: "text", autocomplete: "one-time-code", placeholder: o.setup ? "设置码" : "验证码或重置码", value: o.code ?? "" });
  const pw = input("rs-pw", { type: "password", autocomplete: "new-password" });
  const again = input("rs-again", { type: "password", autocomplete: "new-password" });
  const err = h("p", { class: "form-error", role: "alert" });
  const note = h("p", { class: "form-note", role: "status" });
  const submit = h("button", { type: "submit", class: "btn primary block" }, "保存密码");
  const sendBtn = btn("发送验证码到邮箱", async (ev) => {
    err.textContent = note.textContent = "";
    const e = email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return void ((err.textContent = "请先输入邮箱"), email.focus());
    await submitting(ev.currentTarget, "正在发送…", async () => {
      try {
        const r = await api.auth.resetRequest(e);
        note.textContent = r.message ?? (r.channel === "email" ? "如果这个邮箱已注册，验证码已发到邮箱（15 分钟内有效）" : "请联系律所管理员或中软客服获取重置码");
        code.focus();
      } catch (x) {
        err.textContent = errText(x);
      }
    });
  }, { size: "sm" });
  const form = h(
    "form",
    { class: "auth-form", novalidate: true },
    fieldEl("邮箱", email),
    h("div", { class: "field" }, h("div", { class: "label-row" }, h("label", { for: "rs-code" }, o.setup ? "设置码" : "验证码 / 重置码 / 设置码"), o.setup ? null : sendBtn), code, h("small", { class: "hint" }, o.setup ? "系统管理员新建人员或律所管理员重置后给你的一次性码；平台首位系统管理员的设置码在服务器的 bootstrap-admin.txt 里。" : "邮箱收到的 6 位验证码，或管理员给你的一次性重置码。")),
    fieldEl("新密码", pw, PW_RULE),
    fieldEl("再输入一次新密码", again),
    note,
    err,
    submit,
  );
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    err.textContent = "";
    const e = email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return void ((err.textContent = "请输入邮箱"), email.focus());
    if (!code.value.trim()) return void ((err.textContent = "请输入码"), code.focus());
    const bad = passwordHint(pw.value, again.value, e);
    if (bad) return void ((err.textContent = bad), pw.focus());
    await submitting(submit, "正在保存…", async () => {
      try {
        await api.auth.resetConfirm(e, code.value.trim(), pw.value);
        st.email = e;
        pw.value = again.value = "";
        showLogin("密码已设置：请用新密码登录。该账号在其他地方的登录已全部退出。", "note");
      } catch (x) {
        err.textContent = errText(x);
      }
    });
  });
  shell(o.setup ? "首次设置密码" : "设置或重置密码", o.setup ? "用一次性设置码为你的账号设置密码。" : "用邮箱验证码或管理员给的重置码设置新密码。", form, links(o.setup ? linkTo("忘记密码？用邮箱验证码", () => showReset({ email: email.value.trim() })) : linkTo("我有设置码", () => showReset({ email: email.value.trim(), setup: true })), linkTo("返回登录", () => showLogin())));
  (email.value ? code : email).focus();
}
