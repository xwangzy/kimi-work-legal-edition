/**
 * 运营控制台（第 44 批重做；原第 37 批运营控制台、第 40 批额度台）：中软运营管理律所、账号、设备、模型路由、用量与计费的网页。
 *
 * - 同源静态页、原生 ES 模块、外置 CSS；部署只拷 dist/（scripts/build-ops-console.mjs 拼好，含 tokens.css）；
 * - 鉴权不变：运营私钥在本页内存里签名每个请求（ops-sign.js），控制面按运营名册逐人核验、按接口授权、先记访问审计再执行；
 * - 本页没有自己的后端、不存业务状态；只有主题、上次的运营编号与密钥编号（非机密）记在 localStorage；
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
  api.onAuthLost((e) => logout(`${e.message}。请重新载入私钥。`));
  const kept = await recallKey({ deployment: cfg.deployment, base: cfg.control_plane_base });
  if (kept) {
    api.setOperator({ id: kept.operator, kid: kept.kid, key: kept.key });
    const ok = await verifyLogin().catch(() => false);
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

function showLogin(message) {
  $("#boot").hidden = true;
  $("#app").hidden = true;
  $("#login").hidden = false;
  form.operator.value ||= ls.get("kwl-ops-operator") ?? "";
  form.kid.value ||= ls.get("kwl-ops-kid") ?? "k1";
  $("#login-error").textContent = message ?? "";
  $("#login-foot").textContent = "浏览器须支持 Ed25519（Chrome / Edge 137 以上、Firefox 129 以上、Safari 17 以上）。";
  markFile();
}
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

/** 用一次只读请求核对签名：系统页（顺带拿到本人权限）；没就绪就退到律所列表。 */
async function verifyLogin() {
  ctx.perms = null;
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
    api.setOperator({ id, kid, key });
    await verifyLogin();
    ls.set("kwl-ops-operator", id);
    ls.set("kwl-ops-kid", kid);
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
    submit.textContent = "进入控制台";
  }
});

async function logout(message) {
  api.setOperator(null);
  ctx.perms = null;
  ctx.tenants = null;
  closeDrawer();
  if ($("#modal").open) $("#modal").close();
  await forgetKey();
  clear($("#content"));
  showLogin(message);
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
  clear(
    $("#who"),
    h("span", { class: "avatar", "aria-hidden": "true" }, op.id.slice(-2)),
    h("span", { class: "who-text" }, h("b", { class: "mono" }, op.id), h("small", {}, rememberedUntil ? `密钥 ${op.kid} · 记住至 ${fmt.clock(rememberedUntil).slice(0, 5)}` : `密钥 ${op.kid} · 仅本页内存`)),
  );
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
