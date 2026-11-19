/**
 * 统一云端控制台（第 46 批，D-192/D-193；原第 37/44 批运营控制台、第 40 批额度台）：一个登录页 + 按身份出现的三个分区——
 *   我的      所有账号：概览（个人用量与本所额度水位、我的电脑、安全提示）、账号与安全、我的电脑（平台人员只有“账号与安全”）
 *   本所      律所 admin / partner：概览、成员、电脑、用量、账单；只能在客户端做的事写明“在管理员电脑上完成”
 *   平台运营  中软平台人员，按角色权限出现子页：总览、客户、账号、设备、模型与路由、用量、套餐与额度、计费、人员与权限、系统
 *
 * - 同源静态页、原生 ES 模块、外置 CSS；部署只拷 dist/（scripts/build-console.mjs 拼好，含 tokens.css）；
 * - 会话令牌只由 api.js 放在标签页存储里，关标签页即失效；本页没有自己的后端、不存业务状态；
 *   localStorage 只记主题（非机密）；
 * - hash 路由：#/<分区>/<页>/<参数>?查询，例如 #/ops/tenants/ten_x?tab=usage、#/firm/members。
 */
import * as api from "./api.js";
import { initAuth, resetAuthWidth, setMeta, showEnroll, showLogin, showReset } from "./auth.js";
import { reauthDialog } from "./mfa.js";
import { canAny, ctx, go, isFirmManager, PLATFORM_ROLES, roleLabel, ROLE, SECTIONS } from "./domain.js";
import { $, btn, clear, closeDrawer, errorBlock, fmt, h, icon, toast } from "./ui.js";
import * as meOverview from "./pages/me-overview.js";
import * as meSecurity from "./pages/me-security.js";
import * as meDevices from "./pages/me-devices.js";
import * as firmOverview from "./pages/firm-overview.js";
import * as firmMembers from "./pages/firm-members.js";
import * as firmDevices from "./pages/firm-devices.js";
import * as firmUsage from "./pages/firm-usage.js";
import * as firmBilling from "./pages/firm-billing.js";
import * as overview from "./pages/overview.js";
import * as tenants from "./pages/tenants.js";
import * as accounts from "./pages/accounts.js";
import * as devices from "./pages/devices.js";
import * as routing from "./pages/routing.js";
import * as usage from "./pages/usage.js";
import * as plans from "./pages/plans.js";
import * as billing from "./pages/billing.js";
import * as staff from "./pages/staff.js";
import * as system from "./pages/system.js";

/** 导航：member = 只对成员账号；perms = 平台人员有其一即可 */
export const NAV = [
  {
    id: "me",
    label: "我的",
    items: [
      { id: "overview", label: "概览", icon: "home", mod: meOverview, member: true },
      { id: "security", label: "账号与安全", icon: "shield", mod: meSecurity },
      { id: "devices", label: "我的电脑", icon: "laptop", mod: meDevices, member: true },
    ],
  },
  {
    id: "firm",
    label: "本所",
    items: [
      { id: "overview", label: "概览", icon: "building", mod: firmOverview },
      { id: "members", label: "成员", icon: "members", mod: firmMembers },
      { id: "devices", label: "电脑", icon: "devices", mod: firmDevices },
      { id: "usage", label: "用量", icon: "usage", mod: firmUsage },
      { id: "billing", label: "账单", icon: "billing", mod: firmBilling },
    ],
  },
  {
    id: "ops",
    label: "平台运营",
    items: [
      { id: "overview", label: "总览", icon: "overview", mod: overview, perms: ["tenant.read"] },
      { id: "tenants", label: "客户", icon: "tenants", mod: tenants, perms: ["tenant.read"] },
      { id: "accounts", label: "账号", icon: "accounts", mod: accounts, perms: ["account.read", "account.support"] },
      { id: "devices", label: "设备", icon: "devices", mod: devices, perms: ["tenant.read"] },
      { id: "routing", label: "模型与路由", icon: "routing", mod: routing, perms: ["route.read", "route.manage"] },
      { id: "usage", label: "用量", icon: "usage", mod: usage, perms: ["usage.read"] },
      { id: "plans", label: "套餐与额度", icon: "plans", mod: plans, perms: ["tenant.read", "plan.manage", "settings.manage"] },
      { id: "billing", label: "计费", icon: "billing", mod: billing, perms: ["billing.read"] },
      { id: "staff", label: "人员与权限", icon: "staff", mod: staff, perms: ["staff.manage"] },
      { id: "system", label: "系统", icon: "system", mod: system, perms: ["system.read"] },
    ],
  },
];

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
export const THEMES = { system: "跟随系统", light: "浅色", dark: "深色" };
const themePref = () => ls.get("kwl-console-theme") ?? "system";
function applyTheme() {
  const pref = themePref();
  document.documentElement.dataset.theme = pref === "dark" || (pref === "system" && media.matches) ? "dark" : "light";
  const b = $("#btn-theme");
  if (b) {
    b.title = `主题：${THEMES[pref] ?? THEMES.system}（点击切换）`;
    clear(b, icon(document.documentElement.dataset.theme === "dark" ? "theme" : "sun"));
  }
}
ctx.themePref = themePref;
ctx.setTheme = (pref) => {
  ls.set("kwl-console-theme", pref === "system" ? null : pref);
  applyTheme();
};
media.addEventListener("change", applyTheme);
applyTheme();

// ─── 身份 ──────────────────────────────────────────────────────────
const kindOf = (me) => me?.kind ?? (Array.isArray(me?.account?.roles) ? "staff" : "member");
function setMe(me) {
  const kind = kindOf(me);
  ctx.me = me;
  ctx.kind = kind;
  ctx.operatorId = me.account?.aid ?? "";
  ctx.operatorEmail = me.account?.email ?? "";
  ctx.firmRole = kind === "member" ? (me.firm?.role ?? me.account?.role ?? null) : null;
  if (kind === "staff") {
    const p = me.account?.perms;
    ctx.perms = Array.isArray(p) ? new Set(p) : Array.isArray(me.account?.roles) ? new Set(me.account.roles.flatMap((r) => PLATFORM_ROLES.find((x) => x.id === r)?.perms ?? [])) : null;
  } else ctx.perms = new Set();
  ctx.tenants = null;
}
const sectionVisible = (s) => (s === "me" ? true : s === "firm" ? ctx.kind === "member" && isFirmManager(ctx.firmRole) : s === "ops" ? ctx.kind === "staff" : false);
const itemVisible = (s, it) => sectionVisible(s) && (!it.member || ctx.kind === "member") && (s !== "ops" || canAny(it.perms));
function landing() {
  if (ctx.kind === "staff") {
    const first = NAV[2].items.find((it) => itemVisible("ops", it));
    return first ? `ops/${first.id}` : "me/security";
  }
  return "me/overview";
}

// ─── 启动 ──────────────────────────────────────────────────────────
let cfg = null;
async function boot() {
  try {
    cfg = await api.loadConfig();
  } catch (e) {
    clear($("#boot"), h("div", { class: "state state-error" }, h("b", {}, "控制台配置有误"), h("p", {}, e.message)));
    return;
  }
  document.title = `控制台 · ${cfg.label || cfg.deployment} · Kimi Work 法律版`;
  api.setHooks({
    onAuthLost: (e) => logout(e.message || "登录已失效，请重新登录"),
    onReauth: () => reauthDialog({ mfa: !!ctx.me?.account?.mfa?.enabled, email: ctx.operatorEmail }),
    onOutdated: (e) => outdated(e),
  });
  initAuth({ onAuthed });
  api.auth.meta().then(setMeta, () => setMeta(null));
  if (api.recallSession()) return enter();
  if (/^#\/setup\b/.test(location.hash)) return showReset({ setup: true });
  showLogin();
}

/** 登录 / 两步验证 / 注册得到会话 */
async function onAuthed(r) {
  if (!r?.session_token) throw new Error("控制面没有返回会话");
  api.saveSession(r.session_token, { kind: r.session?.kind ?? null, email: r.account?.email ?? null });
  await enter();
}
async function enter(afterEnroll = false) {
  clear($("#boot"), h("span", { class: "spinner", "aria-hidden": "true" }), "正在进入…");
  let me;
  try {
    me = await api.auth.me();
  } catch (e) {
    if (api.isSessionLost(e)) return void (api.forgetSession(), showLogin(e.message));
    $("#auth").hidden = true;
    $("#app").hidden = true;
    $("#boot").hidden = false;
    clear($("#boot"), errorBlock(e, () => enter()), btn("退出登录", () => logout()));
    return;
  }
  const restricted = me.restricted ?? me.session?.restricted ?? null;
  if (restricted === "mfa_enroll") {
    if (afterEnroll) return logout("两步验证已启用：请重新登录。");
    return showEnroll(me, { onDone: () => enter(true), onLogout: () => logout() });
  }
  resetAuthWidth();
  setMe(me);
  showApp();
}

async function logout(message) {
  await api.logout();
  ctx.me = null;
  ctx.perms = null;
  ctx.kind = null;
  ctx.tenants = null;
  closeDrawer();
  for (const d of ["#modal", "#reauth"]) if ($(d)?.open) $(d).close();
  clear($("#content"));
  clear($("#toasts"));
  clear($("#banner-slot"));
  showLogin(message, message && /已退出/.test(message) ? "note" : "error");
}

function outdated(e) {
  clear($("#banner-slot"), h("div", { class: "banner warn top" }, h("span", {}, e.message || "版本过旧"), e.min_version ? h("span", { class: "muted" }, `（最低 ${e.min_version}）`) : null, btn("刷新页面", () => location.reload(), { size: "sm" })));
}

// ─── 外壳 ──────────────────────────────────────────────────────────
function showApp() {
  $("#boot").hidden = true;
  $("#auth").hidden = true;
  $("#app").hidden = false;
  clear($("#btn-refresh"), icon("refresh"));
  clear($("#btn-menu"), icon("menu"));
  clear($("#env"), h("span", { class: "env-name" }, cfg.label || "部署"), h("span", { class: "env-id mono" }, cfg.deployment));
  buildNav();
  buildUser();
  buildSearch();
  applyTheme();
  const want = location.hash.replace(/^#\/?/, "");
  if (!want || want === "setup") location.hash = `#/${landing()}`;
  else route();
}

function buildNav() {
  const nav = $("#nav");
  clear(nav);
  for (const s of NAV) {
    if (!sectionVisible(s.id)) continue;
    const items = s.items.filter((it) => itemVisible(s.id, it));
    if (!items.length) continue;
    nav.append(
      h(
        "div",
        { class: "nav-section" },
        h("div", { class: "nav-heading" }, s.label),
        items.map((it) => h("a", { href: `#/${s.id}/${it.id}`, class: "nav-item", dataset: { page: `${s.id}/${it.id}` } }, icon(it.icon, "nav-icon"), h("span", { class: "nav-label" }, it.label), h("span", { class: "nav-badge", dataset: { badge: `${s.id}/${it.id}` }, hidden: true }))),
      ),
    );
  }
}
/** 侧栏数字角标；不带分区的 id 归平台运营（旧页面 overview.js 调 setNavBadge("overview", n)） */
ctx.setNavBadge = (id, n) => {
  const el = document.querySelector(`[data-badge="${String(id).includes("/") ? id : `ops/${id}`}"]`);
  if (!el) return;
  el.hidden = !(n > 0);
  el.textContent = n > 99 ? "99+" : String(n ?? "");
};

function buildUser() {
  const a = ctx.me.account ?? {};
  const sub =
    ctx.kind === "staff"
      ? (a.roles ?? []).map((r) => roleLabel(r)).join("、") || "平台人员"
      : [ctx.me.firm?.name ?? a.org?.name, ROLE[ctx.firmRole] ?? ctx.firmRole].filter(Boolean).join(" · ");
  const initials = String(a.name || a.email || "?").trim().slice(0, 1).toUpperCase();
  clear(
    $("#sidebar-foot"),
    h(
      "a",
      { class: "user", href: "#/me/security", title: "账号与安全" },
      h("span", { class: "avatar", "aria-hidden": "true" }, initials),
      h("span", { class: "user-text" }, h("b", {}, a.name || a.email || "—"), h("small", {}, sub || a.email || "")),
    ),
    h("button", { type: "button", class: "icon-btn", id: "btn-theme", "aria-label": "切换主题", onclick: cycleTheme }),
    h("button", { type: "button", class: "icon-btn", id: "btn-logout", "aria-label": "退出登录", title: "退出登录", onclick: () => logout("已退出") }, icon("logout")),
  );
}
function cycleTheme() {
  const order = ["system", "light", "dark"];
  const next = order[(order.indexOf(themePref()) + 1) % order.length];
  ctx.setTheme(next);
  toast(`主题：${THEMES[next]}`, "info");
}

// ─── 全局搜索（平台人员）：邮箱 / 律所 / 请求编号 ───────────────────────
function buildSearch() {
  const box = $("#gsearch");
  clear(box);
  if (ctx.kind !== "staff" || !canAny(["account.read", "tenant.read", "usage.read"])) return void (box.hidden = true);
  box.hidden = false;
  const input = h("input", { type: "search", class: "search", placeholder: "搜索邮箱、律所、请求编号", "aria-label": "全局搜索：邮箱、律所或请求编号", autocomplete: "off", spellcheck: "false" });
  const menu = h("div", { class: "gs-menu", role: "listbox", hidden: true });
  let items = [];
  let sel = 0;
  const guess = (q) => (q.includes("@") ? "account" : /^ten_/i.test(q) ? "tenant" : /^[A-Za-z0-9][A-Za-z0-9_.:-]{11,}$/.test(q) && !/^ten_|^acc_|^dev_|^stf_/i.test(q) ? "request" : /[一-龥]/.test(q) ? "tenant" : "account");
  const run = (kind, q) => {
    menu.hidden = true;
    input.blur();
    if (kind === "account") go(`ops/accounts?q=${encodeURIComponent(q)}`);
    else if (kind === "tenant") go(`ops/tenants?q=${encodeURIComponent(q)}`);
    else if (kind === "request") go(`ops/usage?request_id=${encodeURIComponent(q)}&view=records`);
  };
  const draw = () => {
    const q = input.value.trim();
    if (!q) return void (menu.hidden = true);
    const first = guess(q);
    const all = [
      ["account", `在账号里搜“${q}”`, "邮箱或姓名", "account.read"],
      ["tenant", `在客户里搜“${q}”`, "律所名称或编号", "tenant.read"],
      ["request", `按请求编号查“${q}”`, "逐请求明细", "usage.read"],
    ].filter((x) => canAny([x[3]]));
    items = [...all.filter((x) => x[0] === first), ...all.filter((x) => x[0] !== first)];
    sel = 0;
    clear(menu, items.map(([k, t, s], i) => h("button", { type: "button", role: "option", class: ["gs-item", i === sel && "active"], "aria-selected": i === sel ? "true" : "false", onmousedown: (e) => (e.preventDefault(), run(k, q)) }, h("span", {}, t), h("small", {}, s))));
    menu.hidden = !items.length;
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
  box.append(icon("search", "gs-icon"), input, h("kbd", { class: "gs-kbd", "aria-hidden": "true" }, "/"), menu);
}

// ─── 路由 ──────────────────────────────────────────────────────────
export function parseHash(hash) {
  const raw = String(hash).replace(/^#\/?/, "");
  const [path, query = ""] = raw.split("?");
  const parts = path.split("/").map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  let section = parts[0];
  let rest = parts.slice(1);
  if (!SECTIONS.includes(section)) {
    rest = parts;
    section = "ops";
  }
  return { section, page: rest[0] || "overview", arg: rest.slice(1).join("/") || null, params: Object.fromEntries(new URLSearchParams(query)) };
}
let renderSeq = 0;
function route() {
  if ($("#app").hidden || !ctx.me) return;
  const r = parseHash(location.hash);
  const sec = NAV.find((s) => s.id === r.section);
  const item = sec?.items.find((it) => it.id === r.page);
  if (!item) return void (location.hash = `#/${landing()}`);
  const key = `${r.section}/${r.page}`;
  for (const a of document.querySelectorAll(".nav-item")) {
    const on = a.dataset.page === key;
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  clear($("#crumbs"), h("span", { class: "crumb-sec" }, sec.label), icon("chevron", "crumb-sep"), h("b", {}, item.label));
  $("#app").classList.remove("nav-open");
  closeDrawer();
  const main = $("#content");
  const seq = ++renderSeq;
  clear(main);
  const page = h("div", { class: `page page-${r.section}-${r.page}` });
  main.append(page);
  main.scrollTop = 0;
  ctx.reload = () => route();
  if (!itemVisible(r.section, item)) {
    page.append(errorBlock({ status: 403, message: r.section === "firm" ? "只有本所管理员或合伙人能查看“本所”" : r.section === "ops" ? "只有有相应角色的中软平台人员能查看" : "这一页不适用于你的账号" }));
    return;
  }
  try {
    item.mod.render(page, { ...r, page: r.page });
  } catch (e) {
    page.append(h("div", { class: "state state-error" }, h("b", {}, "页面出错"), h("p", {}, String(e?.message ?? e))));
    console.error(e);
  }
  if (seq === renderSeq) $("#refreshed").textContent = `${fmt.clock().slice(0, 5)} 刷新`;
}
window.addEventListener("hashchange", route);
$("#btn-refresh").addEventListener("click", () => {
  ctx.tenants = null;
  route();
  toast("已刷新");
});
$("#btn-menu").addEventListener("click", () => $("#app").classList.toggle("nav-open"));
$("#scrim").addEventListener("click", () => $("#app").classList.remove("nav-open"));
const typing = (t) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
const anyDialog = () => $("#drawer").open || $("#modal").open || $("#reauth").open;
document.addEventListener("keydown", (e) => {
  if ($("#app").hidden || typing(e.target) || anyDialog() || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "/") {
    const i = $("#gsearch input");
    if (i) (e.preventDefault(), i.focus());
  } else if (e.key.toLowerCase() === "r") route();
  else if (e.key === "Escape") $("#app").classList.remove("nav-open");
});
ctx.openAccount = (aid) => accounts.openAccount(aid);
ctx.logout = (m) => logout(m);
ctx.refreshMe = async () => {
  try {
    setMe(await api.auth.me());
    buildUser();
    applyTheme();
  } catch {
    /* 下次进入时再取 */
  }
};

boot();
