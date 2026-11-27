/**
 * 统一云端控制台（第 46 批，D-192/D-193；原第 37/44 批运营控制台、第 40 批额度台）：一个登录页 + 按身份出现的三个分区——
 *   我的      成员账号：概览（个人用量与本所额度水位、我的电脑、安全提示）、我的电脑、账号与安全；
 *             平台人员的“账号与安全”收在侧栏底部的本人卡片里（第 62 批：侧栏只留运营工作，不再单列一个只有一项的分区）
 *   本所      律所 admin / partner：概览、成员、电脑、用量、账单；只能在客户端做的事写明“在管理员电脑上完成”
 *   平台运营  中软平台人员，按角色权限出现子页，第 62 批按工作分四组：
 *               工作台  总览、告警
 *               客户    客户、账号、电脑、注册管理（注册策略 / 邀请码 / 短信服务）
 *             第 71 批（V45）：以“客户”为主轴——客户详情含成员与电脑；账号详情是页面 #/ops/accounts/<aid>；账号、电脑两页是查找入口
 *             第 72 批（D-306）：“人”和“组织”两条主轴——客户分“团队客户 / 个人客户”两个页签；“账号”改“用户”（#/ops/people，一行 = 一个人），
 *               旧 #/ops/accounts[/<aid>] 转到用户；代建成员只留组织详情“邀请成员”一个入口
 *   个人用户（第 72 批）：没有“本所 / 我的工作室”分区——用量、账单、电脑、账号与安全都在“我的”；团队管理员才有“本所”
 *               经营    套餐、模型与价目、计费、用量
 *               平台    模型与路由、人员与权限、系统
 *             旧地址照认：#/ops/plans?tab=settings → 注册管理 · 注册策略；?tab=alerts → 告警；#/ops/routing?tab=prices → 模型与价目
 *
 * - 同源静态页、原生 ES 模块、外置 CSS；部署只拷 dist/（scripts/build-console.mjs 拼好，含 tokens.css）；
 * - 会话令牌只由 api.js 放在标签页存储里，关标签页即失效；本页没有自己的后端、不存业务状态；
 *   localStorage 只记主题（非机密）；
 * - hash 路由：#/<分区>/<页>/<参数>?查询，例如 #/ops/tenants/ten_x?tab=usage、#/firm/members。
 */
import * as api from "./api.js";
import { initAuth, setMeta, showLogin, showReset } from "./auth.js";
import { reauthDialog } from "./reauth.js";
import { canAny, ctx, go, isFirmManager, isPersonalSpace, KIND_LABEL, PLATFORM_ROLES, roleLabel, ROLE, SECTIONS, workspaceKind } from "./domain.js";
import { $, btn, clear, closeDrawer, errorBlock, errorRef, fmt, h, icon, toast } from "./ui.js";
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
import * as people from "./pages/people.js";
import * as devices from "./pages/devices.js";
import * as routing from "./pages/routing.js";
import * as usage from "./pages/usage.js";
import * as plans from "./pages/plans.js";
import * as billing from "./pages/billing.js";
import * as staff from "./pages/staff.js";
import * as system from "./pages/system.js";
import * as alerts from "./pages/alerts.js";
import * as registration from "./pages/registration.js";
import * as pricing from "./pages/pricing.js";

/**
 * 导航：member = 只对成员账号；perms = 平台人员有其一即可；group = 平台运营里的分组标题；
 * children = 一级菜单下的子页（#/ops/<页>/<子页>，侧栏在当前页时展开）。
 */
export const NAV = [
  {
    id: "me",
    label: "我的",
    items: [
      { id: "overview", label: "我的概览", icon: "home", mod: meOverview, member: true },
      { id: "devices", label: "我的电脑", icon: "laptop", mod: meDevices, member: true },
      // 第 72 批（D-306 第 5 条）：个人用户的用量与账单在“我的”里（读同一份 /v1/firm/usage*、/v1/firm/billing；个人空间不开放团队写接口，C-11）
      { id: "usage", label: "用量", icon: "usage", mod: firmUsage, member: true, personal: true },
      { id: "billing", label: "账单", icon: "billing", mod: firmBilling, member: true, personal: true },
      { id: "security", label: "账号与安全", icon: "shield", mod: meSecurity },
    ],
  },
  {
    id: "firm",
    label: "本所",
    items: [
      { id: "overview", label: "本所概览", icon: "building", mod: firmOverview },
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
      { id: "overview", label: "总览", icon: "overview", mod: overview, perms: ["tenant.read"], group: "工作台" },
      { id: "alerts", label: "告警", icon: "bell", mod: alerts, perms: ["tenant.read"], group: "工作台" },
      { id: "tenants", label: "客户", icon: "tenants", mod: tenants, perms: ["tenant.read"], group: "客户" },
      // 第 72 批（契约 §8，C-9）：用户 = 一个人（GET /v1/ops/people 按 account.read）
      { id: "people", label: "用户", icon: "accounts", mod: people, perms: ["account.read"], group: "客户" },
      // GET /v1/ops/devices 控制面按“查看账号”（account.read）鉴权：只有“查看客户”的财务看得到菜单却永远 403
      { id: "devices", label: "电脑", icon: "devices", mod: devices, perms: ["account.read"], group: "客户" },
      {
        id: "registration",
        label: "注册管理",
        icon: "register",
        mod: registration,
        perms: ["registration.read", "registration.manage", "settings.manage"],
        group: "客户",
        children: registration.SUBPAGES,
      },
      { id: "plans", label: "套餐", icon: "plans", mod: plans, perms: ["tenant.read", "plan.manage", "settings.manage"], group: "经营" },
      { id: "pricing", label: "模型与价目", icon: "tag", mod: pricing, perms: ["route.read", "price.manage", "billing.read"], group: "经营" },
      { id: "billing", label: "计费", icon: "billing", mod: billing, perms: ["billing.read"], group: "经营" },
      { id: "usage", label: "用量", icon: "usage", mod: usage, perms: ["usage.read"], group: "经营" },
      { id: "routing", label: "模型与路由", icon: "routing", mod: routing, perms: ["route.read", "route.manage"], group: "平台" },
      { id: "staff", label: "人员与权限", icon: "staff", mod: staff, perms: ["staff.manage"], group: "平台" },
      { id: "system", label: "系统", icon: "system", mod: system, perms: ["system.read"], group: "平台" },
    ],
  },
];
/** 旧地址（页内分页签挪成了独立页）：[分区/页, 查询参数名, 值] → 新地址 */
const MOVED = [
  ["ops/plans", "tab", "settings", "ops/registration/policy"],
  ["ops/plans", "tab", "alerts", "ops/alerts"],
  ["ops/routing", "tab", "prices", "ops/pricing"],
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
/** 第 72 批（D-306 第 5 条）：“本所”只给团队空间的管理员 / 合伙人；个人用户侧栏不出现任何“本所 / 我的工作室” */
const sectionVisible = (s) => (s === "me" ? true : s === "firm" ? ctx.kind === "member" && isFirmManager(ctx.firmRole) && !isPersonalSpace() : s === "ops" ? ctx.kind === "staff" : false);
const itemVisible = (s, it) => sectionVisible(s) && (!it.member || ctx.kind === "member") && (!it.personal || isPersonalSpace()) && (s !== "ops" || canAny(it.perms));
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
    onReauth: () => reauthDialog({ email: ctx.operatorEmail }),
    onOutdated: (e) => outdated(e),
  });
  initAuth({ onAuthed });
  api.auth.meta().then(setMeta, () => setMeta(null));
  if (api.recallSession()) return enter();
  if (/^#\/setup\b/.test(location.hash)) return showReset({ setup: true });
  showLogin();
}

/** 登录 / 注册得到会话 */
async function onAuthed(r) {
  if (!r?.session_token) throw new Error("控制面没有返回会话");
  api.saveSession(r.session_token, { kind: r.session?.kind ?? null, email: r.account?.email ?? null });
  await enter();
}
async function enter() {
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
  // 侧栏“告警”角标：进来就读一次未确认数（总览与告警页之后会再刷新它）；读不到不显示
  if (ctx.kind === "staff" && canAny(["tenant.read"])) api.get("/v1/ops/alerts", { status: "open", limit: 100 }).then((d) => ctx.setNavBadge("alerts", (d.alerts ?? []).length), () => {});
  applyTheme();
  const want = location.hash.replace(/^#\/?/, "");
  if (!want || want === "setup") location.hash = `#/${landing()}`;
  else route();
}

/** 侧栏里出现的分区：平台人员的“我的”只有“账号与安全”，收在底部本人卡片里，不单列 */
const sectionInNav = (s) => sectionVisible(s) && !(s === "me" && ctx.kind === "staff");
function buildNav() {
  const nav = $("#nav");
  clear(nav);
  const link = (s, it) => {
    const page = `${s.id}/${it.id}`;
    const kids = it.children?.length ? it.children : null;
    const a = h(
      "a",
      { href: `#/${page}${kids ? `/${kids[0][0]}` : ""}`, class: ["nav-item", kids && "parent"], dataset: { page } },
      icon(it.icon, "nav-icon"),
      h("span", { class: "nav-label" }, it.label),
      h("span", { class: "nav-badge", dataset: { badge: page }, hidden: true }),
      kids ? icon("chevron", "nav-caret") : null,
    );
    if (!kids) return a;
    return [a, h("div", { class: "nav-sub", dataset: { sub: page }, hidden: true }, kids.map(([id, label]) => h("a", { href: `#/${page}/${id}`, class: "nav-subitem", dataset: { page: `${page}/${id}` } }, label)))];
  };
  for (const s of NAV) {
    if (!sectionInNav(s.id)) continue;
    const items = s.items.filter((it) => itemVisible(s.id, it));
    if (!items.length) continue;
    if (s.id === "ops") {
      // 平台运营按工作分组：分组标题代替分区标题
      const groups = [...new Set(items.map((it) => it.group ?? ""))];
      for (const g of groups) nav.append(h("div", { class: "nav-section", "aria-label": g || s.label }, h("div", { class: "nav-heading" }, g || s.label), items.filter((it) => (it.group ?? "") === g).map((it) => link(s, it))));
      continue;
    }
    nav.append(h("div", { class: "nav-section", "aria-label": s.label }, h("div", { class: "nav-heading" }, s.label), items.map((it) => link(s, it))));
  }
}
/** 侧栏数字角标；不带分区的 id 归平台运营（总览与告警页调 setNavBadge("alerts", 未确认告警数)） */
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
      : isPersonalSpace()
        ? "个人"
        : [ctx.me.workspace?.name ?? ctx.me.firm?.name ?? a.org?.name, workspaceKind() ? KIND_LABEL[workspaceKind()] : null, ROLE[ctx.firmRole] ?? ctx.firmRole].filter(Boolean).join(" · ");
  const initials = String(a.name || a.email || "?").trim().slice(0, 1).toUpperCase();
  clear(
    $("#sidebar-foot"),
    h(
      "a",
      { class: "user", href: "#/me/security", title: "账号与安全", "aria-label": `账号与安全：${a.name || a.email || ""}` },
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
  if (ctx.kind !== "staff" || !canAny(["account.read", "tenant.read", "usage.read"])) return void ((box.hidden = true), (ctx.gsearchOn = false));
  box.hidden = false;
  ctx.gsearchOn = true;
  const input = h("input", { type: "search", class: "search", placeholder: "搜索手机号、邮箱、律所、电脑、请求编号", "aria-label": "全局搜索：手机号、邮箱、律所、电脑编号或名称、请求编号", autocomplete: "off", spellcheck: "false" });
  const menu = h("div", { class: "gs-menu", role: "listbox", hidden: true });
  let items = [];
  let sel = 0;
  const guess = (q) => (q.includes("@") || /^\+?[\d\s-]{7,}$/.test(q) ? "account" : /^acc_/i.test(q) ? "account_id" : /^ten_/i.test(q) ? "tenant" : /^dev_/i.test(q) ? "device" : /^[A-Za-z0-9][A-Za-z0-9_.:-]{11,}$/.test(q) && !/^ten_|^acc_|^dev_|^stf_/i.test(q) ? "request" : /[一-龥]/.test(q) ? "tenant" : "account");
  const run = (kind, q) => {
    menu.hidden = true;
    input.blur();
    // 第 71 批：账号只命中一个时直接进账号详情（jump=1，由账号页判断）
    if (kind === "account") go(`ops/people?q=${encodeURIComponent(q)}&jump=1`);
    else if (kind === "account_id") go(`ops/people/${encodeURIComponent(q)}`);
    else if (kind === "device") go(`ops/devices?status=&q=${encodeURIComponent(q)}`);
    else if (kind === "tenant") go(`ops/tenants?q=${encodeURIComponent(q)}`);
    else if (kind === "request") go(`ops/usage?request_id=${encodeURIComponent(q)}&view=records`);
  };
  const draw = () => {
    const q = input.value.trim();
    if (!q) return void (menu.hidden = true);
    const first = guess(q);
    const all = [
      ["account", `在用户里搜“${q}”`, "手机号、邮箱、姓名或团队名；只命中一个人时直接打开", "account.read"],
      ["account_id", `打开用户 ${q}`, "账号编号（团队成员身份的编号也认）", "account.read"],
      ["device", `在电脑里搜“${q}”`, "电脑编号、名称或版本", "account.read"],
      ["tenant", `在客户里搜“${q}”`, "团队名称、个人姓名或客户编号", "tenant.read"],
      ["request", `按请求编号查“${q}”`, "逐请求明细", "usage.read"],
    ].filter((x) => canAny([x[3]]) && (x[0] !== "account_id" || /^acc_/i.test(q)));
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
  const moved = MOVED.find(([pg, k, v]) => pg === `${r.section}/${r.page}` && r.params[k] === v);
  if (moved) return void location.replace(`#/${moved[3]}`);
  // 第 72 批：旧“账号”地址转到“用户”（#/ops/accounts/<aid> → 这个人的用户详情；查询串照带）；个人用户的旧“我的工作室”地址转到“我的”
  const q0 = String(location.hash).split("?")[1];
  if (r.section === "ops" && r.page === "accounts") return void location.replace(`#/ops/people${r.arg ? `/${encodeURIComponent(r.arg)}` : ""}${q0 ? `?${q0}` : ""}`);
  if (r.section === "firm" && isPersonalSpace() && (r.page === "usage" || r.page === "billing")) return void location.replace(`#/me/${r.page}${q0 ? `?${q0}` : ""}`);
  const sec = NAV.find((s) => s.id === r.section);
  const item = sec?.items.find((it) => it.id === r.page);
  if (!item) return void (location.hash = `#/${landing()}`);
  // 有子页的一级菜单：没写子页（或子页不认识）就落到第一个子页
  const sub = item.children?.length ? item.children.find(([id]) => id === r.arg) : null;
  if (item.children?.length && !sub) return void location.replace(`#/${r.section}/${r.page}/${item.children[0][0]}`);
  const key = `${r.section}/${r.page}`;
  const subKey = sub ? `${key}/${sub[0]}` : null;
  for (const a of document.querySelectorAll(".nav-item, .nav-subitem")) {
    const parent = a.classList.contains("parent");
    const on = parent ? false : a.dataset.page === (a.classList.contains("nav-subitem") ? subKey : key);
    a.classList.toggle("active", on);
    if (parent) a.classList.toggle("open", a.dataset.page === key);
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  for (const box of document.querySelectorAll(".nav-sub")) box.hidden = box.dataset.sub !== key;
  $("#sidebar-foot .user")?.classList.toggle("active", key === "me/security" && ctx.kind === "staff");
  // 第 71 批（第二轮，05）：账号列表页自带搜手机号 / 邮箱的搜索框，顶栏全局搜索在这一页收起，免得同屏两个搜索框
  // 第五轮：全站同一规则——列表页自带搜索框的（客户、账号、电脑）收起顶栏搜索；其余页（含详情页）保留
  if ($("#gsearch")) $("#gsearch").hidden = !ctx.gsearchOn || (["ops/tenants", "ops/people", "ops/devices"].includes(key) && !r.arg);
  const secLabel = sec.label;
  clear($("#crumbs"), h("span", { class: "crumb-sec" }, secLabel), icon("chevron", "crumb-sep"), sub ? [h("span", { class: "crumb-sec" }, item.label), icon("chevron", "crumb-sep"), h("b", {}, sub[1])] : h("b", {}, item.label));
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
    page.append(errorBlock({ status: 403, message: r.section === "firm" ? (isPersonalSpace() ? "个人空间没有“本所”：用量、账单在“我的”里" : "只有本所管理员或合伙人能查看“本所”") : r.section === "ops" ? "只有有相应角色的中软平台人员能查看" : "这一页不适用于你的账号" }));
    return;
  }
  try {
    item.mod.render(page, { ...r, page: r.page });
  } catch (e) {
    // 评审第二轮：不把原始异常给客户看；原始错误连同编号进浏览器控制台日志
    page.append(h("div", { class: "state state-error" }, h("b", {}, "这一页暂时打不开"), h("p", {}, `请刷新后重试；仍不行请联系平台（错误编号 ${errorRef(e)}）。`)));
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
// 第 71 批（V45）：账号详情是页面（有网址、可后退），不再是抽屉
ctx.openAccount = (aid) => go(`ops/people/${encodeURIComponent(aid)}`);
/** 详情页把面包屑写到对象名：parts = [[文字, 路径?], …]，最后一项加粗 */
ctx.setCrumbs = (parts) => {
  const r = parseHash(location.hash);
  const sec = NAV.find((s) => s.id === r.section);
  const items = (parts ?? []).filter(Boolean);
  clear(
    $("#crumbs"),
    h("span", { class: "crumb-sec" }, sec?.label ?? ""),
    items.map(([t, to], i) => [icon("chevron", "crumb-sep"), i === items.length - 1 || !to ? h(i === items.length - 1 ? "b" : "span", { class: i === items.length - 1 ? "crumb-cur" : "crumb-sec" }, t) : h("a", { class: "crumb-link", href: `#/${to}` }, t)]),
  );
};
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
