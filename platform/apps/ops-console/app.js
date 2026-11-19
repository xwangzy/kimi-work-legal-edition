/**
 * 运营控制台（第 44 批重做；原第 37 批运营控制台、第 40 批额度台）：中软运营管理律所、账号、设备、模型路由、用量与计费的网页。
 *
 * - 同源静态页、原生 ES 模块、外置 CSS；部署只拷 dist/（scripts/build-ops-console.mjs 拼好，含 tokens.css）；
 * - 登录（第 45 批）：账号 + 密码为主（安全管理员发的登录名与初始密码，首次登录须先改）；会话令牌只在 sessionStorage，
 *   关标签页即失效；运营私钥签名每个请求（ops-sign.js）保留为次要入口。两种方式控制面都按运营名册逐人核验、按接口授权、先记访问审计再执行；
 * - 本页没有自己的后端、不存业务状态；只有主题、上次的登录名、运营编号与密钥编号（非机密）记在 localStorage；
 * - 页面按 hash 路由（#/tenants/ten_x?tab=usage），每页一个模块（pages/*.js）。
 */
import * as api from "./api.js";
import { forgetKey, recallKey, rememberKey } from "./keystore.js";
import { importOpsKey, OPERATOR_ID_RE, OPS_KEY_ID_RE } from "./ops-sign.js";
import { ctx, go } from "./domain.js";
import { $, badge, clear, closeDrawer, fmt, h, icon, toast } from "./ui.js";
import * as overview from "./pages/overview.js";
import * as tenants from "./pages/tenants.js";
import * as accounts from "./pages/accounts.js";
import * as devices from "./pages/devices.js";
import * as routing from "./pages/routing.js";
import * as usage from "./pages/usage.js";
import * as plans from "./pages/plans.js";
import * as billing from "./pages/billing.js";
import * as system from "./pages/system.js";

const PAGES = [
  ["overview", "总览", overview],
  ["tenants", "客户", tenants],
  ["accounts", "账号", accounts],
  ["devices", "设备", devices],
  ["routing", "模型与路由", routing],
  ["usage", "用量", usage],
  ["plans", "套餐与额度", plans],
  ["billing", "计费", billing],
  ["system", "系统", system],
];
const byId = Object.fromEntries(PAGES.map(([id, label, mod]) => [id, { id, label, mod }]));

const ls = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* 隐私窗口：不记 */
    }
  },
};

// ─── 主题：跟随系统 / 浅色 / 深色（tokens.css 的 :root[data-theme="dark"]） ───
const media = matchMedia("(prefers-color-scheme: dark)");
const THEMES = { system: "跟随系统", light: "浅色", dark: "深色" };
function applyTheme() {
  const pref = ls.get("kwl-ops-theme") ?? "system";
  const dark = pref === "dark" || (pref === "system" && media.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const b = $("#btn-theme");
  if (b) {
    b.title = `主题：${THEMES[pref] ?? THEMES.system}（点击切换）`;
    clear(b, icon("theme"));
  }
}
media.addEventListener("change", applyTheme);
applyTheme();

// ─── 启动 ──────────────────────────────────────────────────────────
let cfg = null;
async function boot() {
  try {
    cfg = await api.loadConfig();
  } catch (e) {
    clear($("#boot"), h("div", { class: "state state-error" }, h("b", {}, "控制台配置有误"), h("p", {}, e.message)));
    return;
  }
  document.title = `运营控制台 · ${cfg.label || cfg.deployment}`;
  $("#login-env").textContent = `${cfg.label || "部署"} · ${cfg.deployment} · ${new URL(cfg.control_plane_base).host}`;
  api.onAuthLost((e) => {
    const op = api.operator();
    if (e.code === "password_change_required" && op?.via === "password") return showChange(null, "安全管理员重置了你的密码：请先设置新密码。");
    logout(op?.via === "key" ? `${e.message}。请重新载入私钥。` : `${e.message}，请重新登录。`);
  });
  // 本标签页的账号密码会话（刷新页面不必重新登录）
  const sess = api.recallSession();
  if (sess) {
    api.setOperator(sess);
    const me = await verifyLogin().catch(() => null);
    if (me) return me.must_change ? showChange(null) : enterApp();
    api.setOperator(null);
    api.forgetSession();
  }
  const kept = await recallKey({ deployment: cfg.deployment, base: cfg.control_plane_base });
  if (kept) {
    api.setOperator({ via: "key", id: kept.operator, kid: kept.kid, key: kept.key });
    const ok = await verifyLogin().catch(() => null);
    if (ok) return enterApp(kept.expires_at);
    api.setOperator(null);
    await forgetKey();
  }
  showLogin();
}

// ─── 登录 ──────────────────────────────────────────────────────────
const form = $("#login-form");
const keyInput = $("#keyfile");
let keyText = null;
let keyName = "";

const pwForm = $("#pw-form");
const changeForm = $("#change-form");
/** 登录页：账号密码为主；上次用私钥登录的（或带着私钥相关的提示）展开私钥一栏。 */
function showLogin(message, o = {}) {
  $("#boot").hidden = true;
  $("#app").hidden = true;
  $("#login").hidden = false;
  pwForm.hidden = false;
  changeForm.hidden = true;
  $("#key-alt").hidden = false;
  form.operator.value ||= ls.get("kwl-ops-operator") ?? "";
  form.kid.value ||= ls.get("kwl-ops-kid") ?? "k1";
  pwForm.login.value ||= ls.get("kwl-ops-login") ?? "";
  pwForm.password.value = "";
  const viaKey = o.key ?? ls.get("kwl-ops-via") === "key";
  $("#key-alt").open = viaKey;
  $("#pw-error").textContent = viaKey ? "" : (message ?? "");
  $("#login-error").textContent = viaKey ? (message ?? "") : "";
  $("#login-foot").textContent = "浏览器须支持 Ed25519（Chrome / Edge 137 以上、Firefox 129 以上、Safari 17 以上）。";
  markFile();
  if (!viaKey) (pwForm.login.value ? pwForm.password : pwForm.login).focus();
}

// ─── 账号密码登录 ───────────────────────────────────────────────────
pwForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const err = $("#pw-error");
  err.textContent = "";
  const login = pwForm.login.value.trim();
  const password = pwForm.password.value;
  if (!login) return void ((err.textContent = "请输入账号"), pwForm.login.focus());
  if (!password) return void ((err.textContent = "请输入密码"), pwForm.password.focus());
  const submit = $("#pw-submit");
  submit.disabled = true;
  submit.textContent = "正在登录…";
  try {
    const op = await api.passwordLogin(login, password);
    api.setOperator(op);
    api.saveSession(op);
    ctx.perms = new Set(op.perms);
    ls.set("kwl-ops-login", login);
    ls.set("kwl-ops-via", "password");
    pwForm.password.value = "";
    if (op.must_change) showChange(password);
    else enterApp();
  } catch (e) {
    api.setOperator(null);
    err.textContent = e.message || String(e);
    pwForm.password.select();
  } finally {
    submit.disabled = false;
    submit.textContent = "登录";
  }
});

// ─── 首次登录（或被重置后）：先改密码 ─────────────────────────────────
/** 刚登录时当前密码就是刚输入的那个（只留在这个闭包里，改完即丢）；刷新后进来的要再输一次。 */
let pendingCurrent = null;
function showChange(current, why) {
  pendingCurrent = current;
  $("#boot").hidden = true;
  $("#app").hidden = true;
  $("#login").hidden = false;
  pwForm.hidden = true;
  $("#key-alt").hidden = true;
  changeForm.hidden = false;
  changeForm.reset();
  changeForm.username.value = api.operator()?.login ?? "";
  $("#change-current-field").hidden = current !== null;
  $("#change-why").textContent = why ?? "当前是安全管理员发的初始密码，改好后才能使用控制台。";
  $("#change-error").textContent = "";
  (current !== null ? changeForm.next : changeForm.current).focus();
}
/** 新密码的本页预检（与控制面同一规则；以控制面结果为准）。 */
function passwordHint(next, again, login) {
  if (next.length < 12) return "新密码至少 12 位";
  if (!/[A-Za-z]/.test(next) || !/[0-9]/.test(next)) return "新密码须同时包含字母和数字";
  const name = String(login ?? "").split("@")[0];
  if (name.length >= 3 && next.toLowerCase().includes(name.toLowerCase())) return "新密码不要包含登录名";
  if (next !== again) return "两次输入的新密码不一致";
  return null;
}
changeForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const err = $("#change-error");
  err.textContent = "";
  const current = pendingCurrent ?? changeForm.current.value;
  const next = changeForm.next.value;
  if (!current) return void ((err.textContent = "请输入当前密码"), changeForm.current.focus());
  const bad = passwordHint(next, changeForm.again.value, api.operator()?.login);
  if (bad) return void ((err.textContent = bad), changeForm.next.focus());
  if (next === current) return void ((err.textContent = "新密码不能与当前密码相同"), changeForm.next.focus());
  const submit = $("#change-submit");
  submit.disabled = true;
  try {
    await api.post("/v1/ops/password", { current, next });
    pendingCurrent = null;
    changeForm.reset();
    const op = api.operator();
    op.must_change = false;
    await verifyLogin().catch(() => null);
    enterApp();
    toast("密码已更新");
  } catch (e) {
    err.textContent = e.message || String(e);
    if (e.code === "ops_password_current_wrong") {
      pendingCurrent = null;
      $("#change-current-field").hidden = false;
      changeForm.current.value = "";
      changeForm.current.focus();
    }
  } finally {
    submit.disabled = false;
  }
});
$("#change-cancel").addEventListener("click", () => logout());

/** 顶栏“修改密码”（账号密码登录时）：本页弹框，值原样提交（不去首尾空白）。 */
function changePasswordDialog() {
  const d = $("#modal");
  const err = h("p", { class: "form-error", role: "alert" });
  const inp = (name, label, auto, hint) => {
    const id = `cp-${name}`;
    return h("div", { class: "field" }, h("label", { for: id }, label), h("input", { id, name, type: "password", autocomplete: auto }), hint ? h("small", { class: "hint" }, hint) : null);
  };
  const ok = h("button", { type: "submit", class: "btn primary" }, "保存");
  const cancel = h("button", { type: "button", class: "btn", onclick: () => d.close() }, "取消");
  const f = h(
    "form",
    { class: "modal-form", novalidate: true },
    h("h2", { class: "modal-title" }, "修改密码"),
    h("input", { type: "text", name: "username", autocomplete: "username", value: api.operator()?.login ?? "", hidden: true }),
    inp("current", "当前密码", "current-password"),
    inp("next", "新密码", "new-password", "至少 12 位，同时包含字母和数字，不含登录名。"),
    inp("again", "再输入一次新密码", "new-password"),
    h("p", { class: "modal-note" }, "保存后，你在其他浏览器或标签页的登录会全部退出。"),
    err,
    h("div", { class: "modal-actions" }, cancel, ok),
  );
  f.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    err.textContent = "";
    const current = f.current.value;
    const next = f.next.value;
    if (!current) return void (err.textContent = "请输入当前密码");
    const bad = passwordHint(next, f.again.value, api.operator()?.login);
    if (bad) return void (err.textContent = bad);
    if (next === current) return void (err.textContent = "新密码不能与当前密码相同");
    ok.disabled = cancel.disabled = true;
    try {
      const r = await api.post("/v1/ops/password", { current, next });
      d.close();
      toast(r.other_sessions_revoked ? `密码已更新，另有 ${r.other_sessions_revoked} 处登录已退出` : "密码已更新");
    } catch (e) {
      err.textContent = e.message || String(e);
      ok.disabled = cancel.disabled = false;
    }
  });
  d.className = "modal";
  clear(d, f);
  d.onclose = null;
  d.oncancel = null;
  d.showModal();
  f.current.focus();
}
$("#btn-passwd").addEventListener("click", changePasswordDialog);
function markFile() {
  const drop = $("#drop");
  drop.classList.toggle("ready", !!keyText);
  clear($("#drop-icon"), icon(keyText ? "key" : "file"));
  $("#drop-text").textContent = keyText ? keyName : "把私钥文件拖到这里，或点击选择";
  const encrypted = !!keyText && /BEGIN ENCRYPTED PRIVATE KEY/.test(keyText);
  $("#drop-sub").textContent = keyText ? (encrypted ? "口令加密的私钥：请在下面输入口令" : "明文私钥 · 只在本页内存里使用") : "ops-cli keygen 生成的 .key.pem（PKCS#8，明文或口令加密）";
  $("#pass-field").hidden = !encrypted;
}
async function takeFile(f) {
  const err = $("#login-error");
  err.textContent = "";
  keyText = null;
  keyName = "";
  if (!f) return markFile();
  if (f.size > 16_384) {
    err.textContent = "这不像私钥文件（太大）";
    return markFile();
  }
  const text = await f.text();
  if (/BEGIN PUBLIC KEY/.test(text) && !/PRIVATE KEY/.test(text)) {
    err.textContent = "这是公钥文件：请选本人的私钥文件";
    return markFile();
  }
  if (!/BEGIN (ENCRYPTED )?PRIVATE KEY/.test(text)) {
    err.textContent = "不是 PKCS#8 私钥文件（应以 BEGIN PRIVATE KEY 或 BEGIN ENCRYPTED PRIVATE KEY 开头）";
    return markFile();
  }
  keyText = text;
  keyName = f.name;
  // 文件名形如 op_0001.k1.key.pem：顺手填上运营编号与密钥编号（只在为空或是默认值时）
  const m = /(op_[0-9]{4,12})(?:[._-]([a-z0-9][a-z0-9-]{0,23}))?/.exec(f.name);
  if (m && !form.operator.value) form.operator.value = m[1];
  if (m?.[2] && m[2] !== "key" && (!form.kid.value || form.kid.value === "k1")) form.kid.value = m[2];
  markFile();
  (/BEGIN ENCRYPTED/.test(text) ? form.passphrase : form.operator.value ? $("#login-submit") : form.operator).focus();
}
keyInput.addEventListener("change", () => takeFile(keyInput.files?.[0]));
// 整个卡片都能接住拖放
for (const ev of ["dragenter", "dragover"]) form.addEventListener(ev, (e) => (e.preventDefault(), $("#drop").classList.add("over")));
for (const ev of ["dragleave", "dragend"]) form.addEventListener(ev, (e) => (e.target === form || e.target === $("#drop")) && $("#drop").classList.remove("over"));
form.addEventListener("drop", (e) => {
  e.preventDefault();
  $("#drop").classList.remove("over");
  const f = e.dataTransfer?.files?.[0];
  if (f) takeFile(f);
});

/** 核对凭据并取本人身份与权限：/v1/ops/me（第 45 批）；老控制面没有时退到系统页、再退到律所列表。返回身份（含 must_change）。 */
async function verifyLogin() {
  ctx.perms = null;
  try {
    const me = await api.get("/v1/ops/me");
    ctx.perms = new Set(me.perms ?? []);
    const op = api.operator();
    if (op?.via === "password") Object.assign(op, { must_change: me.must_change === true, expires_at: me.expires_at ?? op.expires_at, login: me.login ?? op.login });
    return me;
  } catch (e) {
    if (e.code !== "not_ready") throw e;
  }
  try {
    const sys = await api.get("/v1/ops/system");
    const me = sys?.roster?.operators?.find((o) => o.id === api.operator().id);
    if (me) ctx.perms = new Set(me.perms ?? []);
    return true;
  } catch (e) {
    if (e.status === 403 && e.code === "ops_permission_denied") return true;
    if (e.code !== "not_ready") throw e;
  }
  try {
    await api.get("/v1/ops/tenants");
    return true;
  } catch (e) {
    if (e.status === 403 && e.code === "ops_permission_denied") return true;
    if (e.code === "not_ready") throw Object.assign(new Error("控制面没有开运营接口：本页所在网段不在运维网段（ops.allow_cidrs）内，或控制面没配运营名册"), { code: "ops_closed" });
    throw e;
  }
}

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const err = $("#login-error");
  err.textContent = "";
  const id = form.operator.value.trim();
  const kid = form.kid.value.trim();
  if (!keyText) return void (err.textContent = "请先选择私钥文件");
  if (!OPERATOR_ID_RE.test(id)) return void (err.textContent = "运营编号须为 op_ 加 4–12 位数字工号，如 op_0001"), form.operator.focus();
  if (!OPS_KEY_ID_RE.test(kid)) return void (err.textContent = "密钥编号只许小写字母、数字与连字符，如 k1"), form.kid.focus();
  const submit = $("#login-submit");
  submit.disabled = true;
  submit.textContent = "正在核对…";
  try {
    const key = await importOpsKey(keyText, form.passphrase.value);
    api.setOperator({ via: "key", id, kid, key });
    await verifyLogin();
    ls.set("kwl-ops-operator", id);
    ls.set("kwl-ops-kid", kid);
    ls.set("kwl-ops-via", "key");
    let until = null;
    if ($("#remember").checked && (await rememberKey({ operator: id, kid, key, deployment: cfg.deployment, base: cfg.control_plane_base }))) until = Date.now() + 8 * 3600_000;
    keyText = null;
    keyInput.value = "";
    form.passphrase.value = "";
    enterApp(until);
  } catch (e) {
    api.setOperator(null);
    err.textContent = e.code === "network" ? e.message : e.message || String(e);
    if (/口令/.test(e.message)) form.passphrase.select();
  } finally {
    submit.disabled = false;
    submit.textContent = "用私钥进入";
  }
});

async function logout(message) {
  const op = api.operator();
  await api.logoutSession();
  api.forgetSession();
  api.setOperator(null);
  pendingCurrent = null;
  ctx.perms = null;
  ctx.tenants = null;
  closeDrawer();
  if ($("#modal").open) $("#modal").close();
  await forgetKey();
  clear($("#content"));
  showLogin(message, { key: op?.via === "key" });
}
$("#btn-logout").addEventListener("click", () => logout());

// ─── 外壳 ──────────────────────────────────────────────────────────
function enterApp(rememberedUntil) {
  $("#boot").hidden = true;
  $("#login").hidden = true;
  $("#app").hidden = false;
  const op = api.operator();
  ctx.operatorId = op.id;
  clear(
    $("#deploy"),
    h("span", { class: "deploy-name" }, cfg.label || "部署"),
    h("span", { class: "deploy-id mono" }, cfg.deployment),
    cfg.demo ? badge("开发演示数据", "warn", "本机开发脚本造的演示数据（client_request_id 以 dev-demo- 开头），不是真实客户") : null,
  );
  const pw = op.via === "password";
  clear(
    $("#who"),
    h("span", { class: "avatar", "aria-hidden": "true" }, pw ? (op.login || op.id).slice(0, 2).toUpperCase() : op.id.slice(-2)),
    h(
      "span",
      { class: "who-text" },
      h("b", { class: pw ? null : "mono" }, pw ? op.login || op.id : op.id),
      h("small", {}, pw ? `${op.id} · 账号密码登录${op.expires_at ? ` · 至 ${fmt.clock(Date.parse(op.expires_at)).slice(0, 5)}` : ""}` : rememberedUntil ? `密钥 ${op.kid} · 记住至 ${fmt.clock(rememberedUntil).slice(0, 5)}` : `密钥 ${op.kid} · 仅本页内存`),
    ),
  );
  $("#btn-passwd").hidden = !pw;
  clear($("#btn-refresh"), icon("refresh"));
  applyTheme();
  buildNav();
  buildSearch();
  clear($("#sidebar-foot"), h("small", {}, "控制面 "), h("span", { class: "mono small" }, new URL(cfg.control_plane_base).host));
  if (!location.hash || location.hash === "#" || location.hash === "#/") location.hash = "#/overview";
  else route();
}

function buildNav() {
  clear(
    $("#nav"),
    PAGES.map(([id, label]) => h("a", { href: `#/${id}`, class: "nav-item", dataset: { page: id } }, icon(id, "nav-icon"), h("span", { class: "nav-label" }, label), h("span", { class: "nav-badge", dataset: { badge: id }, hidden: true }))),
  );
}
/** 侧栏数字角标（总览有未确认告警时） */
export function setNavBadge(id, n) {
  const el = document.querySelector(`[data-badge="${id}"]`);
  if (!el) return;
  el.hidden = !(n > 0);
  el.textContent = n > 99 ? "99+" : String(n ?? "");
}
ctx.setNavBadge = setNavBadge;

// ─── 全局搜索：邮箱 / 律所 / 请求编号 ─────────────────────────────────
function buildSearch() {
  const input = h("input", { type: "search", class: "search", placeholder: "邮箱 / 律所 / 请求编号（/）", "aria-label": "全局搜索：邮箱、律所或请求编号", autocomplete: "off", spellcheck: "false" });
  const menu = h("div", { class: "gs-menu", role: "listbox", hidden: true });
  let items = [];
  let sel = 0;
  const guess = (q) => (q.includes("@") ? "account" : /^ten_/i.test(q) ? "tenant" : /^[A-Za-z0-9][A-Za-z0-9_.:-]{11,}$/.test(q) && !/^ten_|^acc_|^dev_/i.test(q) ? "request" : /[一-龥]/.test(q) ? "tenant" : "account");
  const run = (kind, q) => {
    menu.hidden = true;
    input.blur();
    if (kind === "account") go(`accounts?q=${encodeURIComponent(q)}`);
    else if (kind === "tenant") go(`tenants?q=${encodeURIComponent(q)}`);
    else if (kind === "request") go(`usage?request_id=${encodeURIComponent(q)}&view=records`);
  };
  const draw = () => {
    const q = input.value.trim();
    if (!q) return void (menu.hidden = true);
    const first = guess(q);
    const all = [
      ["account", `在账号里搜“${q}”`, "邮箱或姓名"],
      ["tenant", `在客户里搜“${q}”`, "律所名称或编号"],
      ["request", `按请求编号查“${q}”`, "逐请求明细"],
    ];
    items = [all.find((x) => x[0] === first), ...all.filter((x) => x[0] !== first)];
    sel = 0;
    clear(menu, items.map(([k, t, s], i) => h("button", { type: "button", role: "option", class: ["gs-item", i === sel && "active"], "aria-selected": i === sel ? "true" : "false", onmousedown: (e) => (e.preventDefault(), run(k, q)) }, h("span", {}, t), h("small", {}, s))));
    menu.hidden = false;
  };
  input.addEventListener("input", draw);
  input.addEventListener("focus", draw);
  input.addEventListener("blur", () => setTimeout(() => (menu.hidden = true), 120));
  input.addEventListener("keydown", (e) => {
    if (menu.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      sel = (sel + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      [...menu.children].forEach((c, i) => (c.classList.toggle("active", i === sel), c.setAttribute("aria-selected", i === sel ? "true" : "false")));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(items[sel][0], input.value.trim());
    } else if (e.key === "Escape") menu.hidden = true;
  });
  clear($("#gsearch"), icon("search", "gs-icon"), input, menu);
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) && !$("#drawer").open && !$("#modal").open) {
      e.preventDefault();
      input.focus();
    }
  });
}

// ─── 路由 ──────────────────────────────────────────────────────────
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, query = ""] = raw.split("?");
  const [page, ...rest] = path.split("/").map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  return { page: byId[page] ? page : "overview", arg: rest.join("/") || null, params: Object.fromEntries(new URLSearchParams(query)) };
}
let renderSeq = 0;
function route() {
  if ($("#app").hidden || !api.operator()) return;
  const r = parseHash();
  const p = byId[r.page];
  for (const a of document.querySelectorAll(".nav-item")) {
    const on = a.dataset.page === r.page;
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  closeDrawer();
  const main = $("#content");
  const seq = ++renderSeq;
  clear(main);
  const page = h("div", { class: `page page-${r.page}` });
  main.append(page);
  main.scrollTop = 0;
  ctx.reload = () => route();
  try {
    p.mod.render(page, r);
  } catch (e) {
    page.append(h("div", { class: "state state-error" }, h("b", {}, "页面出错"), h("p", {}, String(e?.message ?? e))));
    console.error(e);
  }
  if (seq === renderSeq) $("#refreshed").textContent = `上次刷新 ${fmt.clock()}`;
}
window.addEventListener("hashchange", route);
$("#btn-refresh").addEventListener("click", () => {
  ctx.tenants = null;
  route();
  toast("已刷新");
});
$("#btn-theme").addEventListener("click", () => {
  const order = ["system", "light", "dark"];
  const cur = ls.get("kwl-ops-theme") ?? "system";
  const next = order[(order.indexOf(cur) + 1) % order.length];
  ls.set("kwl-ops-theme", next === "system" ? null : next);
  applyTheme();
  toast(`主题：${THEMES[next]}`, "info");
});
document.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "r" && !e.metaKey && !e.ctrlKey && !e.altKey && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) && !$("#app").hidden && !$("#drawer").open && !$("#modal").open) route();
});
ctx.openAccount = (aid) => accounts.openAccount(aid);

boot();
