/**
 * 额度台（第 40 批重构；原第 37 批运营控制台）：中软运营管理律所租户、用量与计费的网页。
 *
 * 第一性原理：运营每天要回答三个问题——
 *   1. 谁快用完了？（本月用量的百分比 × 月份进度 → 按当前速度月底到多少、哪天用完）
 *   2. 该收多少钱？（席位 × 套餐 + 加量包；模型成本与毛利同屏）
 *   3. 谁在用？（席位绑定的 Kimi 账号，只见打码昵称与手机尾号）
 * 所以首页是“水位”：每家律所一条轨道，实心是已用、浅色是网关在途、黑色刻度是月份进度、红色虚线是律所设的上限；
 * 已用越过月份刻度 = 用得比日历快。全站不出现“点数”：用量一律是本月额度的百分比（与 Kimi 会员额度同一表达）。
 *
 * 安全口径不变：只调控制面运营接口（/v1/ops/…）；每个请求用本人私钥在浏览器里签名（ops-sign.js），控制面按运营名册逐人核验、
 * 按接口授权、先记访问审计再执行。本页没有自己的后端、不存任何状态；config.json 与本页同源（部署时由运维写入）。
 */
import { importOpsKey, signOpsRequest, OPERATOR_ID_RE, OPS_KEY_ID_RE } from "./ops-sign.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const SVG = "http://www.w3.org/2000/svg";
const state = { cfg: null, op: null, plans: null, tenants: [], view: "overview", filter: "all", query: "", sort: { key: "used", asc: false }, detail: null, pane: "usage", refreshedAt: 0 };

// ─── 小工具 ─────────────────────────────────────────────────────────
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
function svg(tag, attrs = {}) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}
/** 经 CSSOM 设定位与宽度（CSP style-src 'self' 不许 style 属性）。 */
const place = (el, props) => {
  for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v);
  return el;
};
const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));
const fmt = (n) => (n === null || n === undefined ? "—" : Number(n).toLocaleString("zh-CN"));
/** 比例 → 百分比文字：<0.1% 不写 0；10% 以下一位小数。 */
export function pct(r) {
  if (r === null || r === undefined || !Number.isFinite(Number(r))) return "—";
  const p = Number(r) * 100;
  if (p > 0 && p < 0.1) return "<0.1%";
  return `${p < 10 ? (Math.round(p * 10) / 10).toFixed(1).replace(/\.0$/, "") : Math.round(p)}%`;
}
const yuan = (v) => (v === null || v === undefined ? "—" : `¥${Number(v).toLocaleString("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`);
const day = (iso) => (iso ? new Date(iso).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" }) : "—");
const mdDay = (t) => new Date(t).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai", month: "long", day: "numeric" });
const initials = (s) => [...String(s ?? "").trim()][0] ?? "·";

/**
 * 月份进度与月底预测（北京时间自然月）：elapsed = 本月已过的比例；按当前速度月底 = 已用 ÷ elapsed；
 * 用完日 = 月初 + 用到上限（或 100%）所需时间。月初 3 天内样本太少，不预测。
 */
export function forecast(q, now = Date.now()) {
  const m = /^(\d{4})-(\d{2})$/.exec(q?.period ?? "");
  const end = Date.parse(q?.resets_at ?? "");
  if (!m || !Number.isFinite(end)) return { elapsed: null, projected: null, exhaustAt: null, limit: 1 };
  const start = Date.UTC(Number(m[1]), Number(m[2]) - 1, 1) - 8 * 3600_000;
  const elapsed = clamp01((now - start) / (end - start));
  const limit = q.cap_pct ? q.cap_pct / 100 : 1;
  const used = Number(q.used_ratio) || 0;
  if (elapsed < 0.1 || used <= 0) return { elapsed, projected: null, exhaustAt: null, limit };
  const projected = used / elapsed;
  const exhaust = used >= limit ? now : start + ((now - start) * limit) / used;
  return { elapsed, projected, exhaustAt: exhaust < end ? exhaust : null, limit };
}

/** 水位：<80% 正常、≥80%（相对上限）偏高、到上限或暂停为满。 */
export function toneOf(q) {
  const limit = q?.cap_pct ? q.cap_pct / 100 : 1;
  const used = Number(q?.used_ratio) || 0;
  if (q?.paused || used >= limit) return "full";
  return used >= limit * 0.8 ? "high" : "ok";
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 3200);
}
/** 悬停提示（图上的柱子与水位条）。 */
function tipOn(el, text) {
  const tip = $("#tip");
  el.addEventListener("pointerenter", () => {
    tip.textContent = typeof text === "function" ? text() : text;
    tip.hidden = false;
  });
  el.addEventListener("pointermove", (e) => place(tip, { left: `${Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8)}px`, top: `${e.clientY + 14}px` }));
  el.addEventListener("pointerleave", () => (tip.hidden = true));
  return el;
}

const ERR = {
  ops_auth_invalid: "运营凭据无效：运营编号、密钥编号与私钥对不上名册，或已被吊销",
  ops_auth_stale: "本机时间与服务器相差超过 5 分钟：请校准电脑时间",
  ops_auth_missing: "请求没有带运营签名",
  ops_auth_replayed: "重复的请求（随机数已用过）",
  ops_permission_denied: "你在运营名册里没有这项权限",
  ops_roster_unavailable: "运营名册暂不可用（过期、回滚或签名不符）：请安全管理员重签名册",
  not_found: "没有这条接口：控制台所在网段不在运维网段内（allow_cidrs），或控制面没有开运营接口",
  cap_raise_by_firm_only: "调高或取消律所已设的上限须由律所管理员在客户端操作",
  seats_in_use: "席位数不能少于在用席位：先请律所收回席位",
  allowance_missing: "这家律所还没有套餐额度：先设套餐与席位",
  kimi_account_disabled: "控制面没有配置 Kimi 账号对接（kimi_account），不能要求绑定",
  plan_unknown: "套餐不在目录里",
};
class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const errText = (e) => (e instanceof ApiError ? `${e.message}（${e.code}）` : String(e?.message ?? e));

// ─── 签名请求 ───────────────────────────────────────────────────────
async function api(method, path, body) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const headers = await signOpsRequest({ deployment: state.cfg.deployment, audience: "control-plane", operator: state.op.id, kid: state.op.kid, key: state.op.key, method, path, body: raw });
  let r;
  try {
    r = await fetch(state.cfg.control_plane_base + path, {
      method,
      headers: { ...headers, ...(raw ? { "content-type": "application/json" } : {}) },
      ...(raw ? { body: raw } : {}),
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
  } catch {
    throw new ApiError(0, "network", "连不上控制面：检查地址、证书，以及控制面的 ops.console_origins 是否含本页来源");
  }
  let json = null;
  try {
    json = await r.json();
  } catch {
    json = null;
  }
  if (!r.ok) {
    const code = json?.error?.code ?? (typeof json?.error === "string" ? json.error : `http_${r.status}`);
    throw new ApiError(r.status, code, ERR[code] ?? json?.error?.message ?? `请求失败（${r.status}）`);
  }
  return json;
}
const T = (tid) => `/v1/ops/tenants/${encodeURIComponent(tid)}`;

async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try {
    return await fn();
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ─── 配置与登录 ─────────────────────────────────────────────────────
async function loadConfig() {
  const r = await fetch("config.json", { cache: "no-store" });
  if (!r.ok) throw new Error("缺少 config.json（控制面地址与部署标识）");
  const c = await r.json();
  const base = String(c.control_plane_base ?? "").replace(/\/+$/, "");
  const u = new URL(base);
  const loop = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (!(u.protocol === "https:" || (loop && u.protocol === "http:"))) throw new Error("config.json 的 control_plane_base 必须是 https 地址");
  if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(String(c.deployment ?? ""))) throw new Error("config.json 的 deployment（部署标识）不合法");
  return { control_plane_base: base, deployment: c.deployment, label: typeof c.label === "string" ? c.label : "" };
}

function showLogin() {
  state.op = null;
  state.tenants = [];
  $("#shell").hidden = true;
  $("#login").hidden = false;
  $("#detail").open && $("#detail").close();
}

const drop = $("#drop");
const keyInput = $("#login-form").keyfile;
const markFile = () => {
  const f = keyInput.files?.[0];
  drop.classList.toggle("ready", !!f);
  $("#drop-text").replaceChildren(f ? f.name : "把私钥文件拖到这里，或点击选择", h("small", {}, f ? `${Math.max(1, Math.round(f.size / 102.4) / 10)} KB · 只在本页内存里使用` : "ops-cli keygen 生成的 .key.pem"));
};
keyInput.addEventListener("change", markFile);
for (const ev of ["dragenter", "dragover"]) drop.addEventListener(ev, (e) => (e.preventDefault(), drop.classList.add("over")));
for (const ev of ["dragleave", "drop"]) drop.addEventListener(ev, () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files?.length) {
    keyInput.files = e.dataTransfer.files;
    markFile();
  }
});

$("#login-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.currentTarget;
  const err = $("#login-error");
  err.textContent = "";
  const id = f.operator.value.trim();
  const kid = f.kid.value.trim();
  if (!OPERATOR_ID_RE.test(id)) return void (err.textContent = "运营编号须为 op_ 加 4–12 位数字工号");
  if (!OPS_KEY_ID_RE.test(kid)) return void (err.textContent = "密钥编号只许小写字母、数字与连字符");
  const file = keyInput.files?.[0];
  if (!file) return void (err.textContent = "请选择私钥文件");
  if (file.size > 16_384) return void (err.textContent = "这不像私钥文件（太大）");
  await busy(f.querySelector("button[type=submit]"), async () => {
    try {
      const key = await importOpsKey(await file.text(), f.passphrase.value);
      state.op = { id, kid, key };
      f.reset();
      f.kid.value = kid;
      markFile();
      state.plans = await api("GET", "/v1/ops/plans");
      await refresh();
      $("#login").hidden = true;
      $("#shell").hidden = false;
      $("#who-text").textContent = `${id} · ${kid}`;
      $("#who-avatar").textContent = id.slice(-2);
      switchView(state.view);
    } catch (e) {
      state.op = null;
      err.textContent = errText(e);
    }
  });
});
$("#btn-logout").addEventListener("click", () => {
  showLogin();
  toast("已退出：私钥已从本页丢弃");
});

// ─── 数据 ───────────────────────────────────────────────────────────
async function refresh() {
  const r = await api("GET", "/v1/ops/tenants");
  state.tenants = r.tenants ?? [];
  state.refreshedAt = Date.now();
  render();
}
$("#btn-refresh").addEventListener("click", (e) =>
  busy(e.currentTarget, async () => {
    try {
      await refresh();
      if (state.detail && $("#detail").open) await openDetail(state.detail.t.tid, state.pane);
      toast("已刷新");
    } catch (er) {
      toast(errText(er));
    }
  }),
);

/** 律所状态：一个主状态（最要紧的那个）。 */
function statusOf(t, now = Date.now()) {
  const until = Date.parse(t.subscription_until);
  if (until <= now) return { cls: "bad", text: "订阅已到期", key: "ended" };
  if (t.quota?.paused === "allowance") return { cls: "bad", text: "额度用完", key: "paused" };
  if (t.quota?.paused === "cap") return { cls: "warn", text: "已达上限", key: "paused" };
  if (!t.root_enrolled) return { cls: "info", text: "待律所开通", key: "pending" };
  if (until - now < 30 * 86_400_000) return { cls: "warn", text: "30 天内到期", key: "expiring" };
  return { cls: "ok", text: "正常", key: "ok" };
}
const tag = (s) => h("span", { class: `tag ${s.cls}` }, s.text);

/** 需要关注的事（每家律所至多一条最要紧的，按严重度排）。 */
function attentionOf(t, now = Date.now()) {
  const q = t.quota ?? {};
  const f = forecast(q, now);
  const name = t.name ?? t.tid;
  const until = Date.parse(t.subscription_until);
  if (until <= now) return { sev: 0, cls: "bad", t: name, d: "订阅已到期：客户端停用云端能力", go: "续订" };
  if (q.paused === "allowance") return { sev: 1, cls: "bad", t: name, d: `本月额度已用完（${pct(q.used_ratio)}）：AI 处理暂停`, go: "加量" };
  if (q.paused === "cap") return { sev: 2, cls: "warn", t: name, d: `已到律所设的上限 ${q.cap_pct}%：AI 处理暂停`, go: "查看" };
  if (f.exhaustAt) return { sev: 3, cls: "warn", t: name, d: `按当前速度约 ${mdDay(f.exhaustAt)}用完${q.cap_pct ? `上限 ${q.cap_pct}%` : "本月额度"}（月底约 ${pct(f.projected)}）`, go: "加量" };
  if (toneOf(q) === "high") return { sev: 4, cls: "warn", t: name, d: `本月已用 ${pct(q.used_ratio)}`, go: "查看" };
  if (until - now < 30 * 86_400_000) return { sev: 5, cls: "warn", t: name, d: `订阅 ${day(t.subscription_until)} 到期`, go: "续订" };
  if (!t.root_enrolled && now - Date.parse(t.created_at) > 7 * 86_400_000) return { sev: 6, cls: "info", t: name, d: "开通超过 7 天，律所还没有在客户端登记", go: "发码" };
  if (t.kimi?.required && t.kimi.bound < t.seats_used) return { sev: 7, cls: "info", t: name, d: `要求 Kimi 账号登录：${t.seats_used - t.kimi.bound} 个在用席位还没绑定`, go: "查看" };
  return null;
}

// ─── 视图切换 ───────────────────────────────────────────────────────
function switchView(v) {
  state.view = v;
  for (const b of $$(".topbar .tab")) {
    const on = b.dataset.view === v;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  }
  for (const s of $$(".view")) s.hidden = s.id !== `view-${v}`;
  render();
}
for (const b of $$(".topbar .tab")) b.addEventListener("click", () => switchView(b.dataset.view));

function render() {
  if (!state.op) return;
  const label = state.cfg.label ? `${state.cfg.label} · ` : "";
  $("#env-sub").textContent = `${label}${state.cfg.deployment} · ${new URL(state.cfg.control_plane_base).host}`;
  $("#refreshed").textContent = state.refreshedAt ? `${new Date(state.refreshedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 刷新` : "";
  if (state.view === "overview") renderOverview();
  if (state.view === "firms") renderFirms();
  if (state.view === "billing") renderBilling();
}

/** 水位条（总览、律所表、详情共用）。 */
function paceBar(q, o = {}) {
  const used = clamp01(q?.used_ratio);
  const flight = Math.min(1 - used, clamp01(q?.in_flight_ratio));
  const f = forecast(q);
  const tone = toneOf(q);
  const bar = h("div", { class: `pace ${o.sm ? "sm " : ""}${tone === "ok" ? "" : tone}`, role: "meter", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(used * 100), "aria-label": `本月已用 ${pct(q?.used_ratio)}` });
  bar.append(place(h("span", { class: "used" }), { width: `${used * 100}%` }));
  if (flight > 0) bar.append(place(h("span", { class: "flight" }), { left: `${used * 100}%`, width: `${flight * 100}%` }));
  if (f.elapsed !== null) bar.append(place(h("span", { class: "today" }), { left: `${f.elapsed * 100}%` }));
  if (q?.cap_pct) bar.append(place(h("span", { class: "cap" }), { left: `${Math.min(100, q.cap_pct)}%` }));
  tipOn(bar, () => {
    const parts = [`已用 ${pct(q?.used_ratio)}`];
    if (flight > 0) parts.push(`在途 ${pct(q.in_flight_ratio)}`);
    if (f.elapsed !== null) parts.push(`本月已过 ${pct(f.elapsed)}`);
    if (q?.cap_pct) parts.push(`上限 ${q.cap_pct}%`);
    if (f.projected !== null) parts.push(`月底约 ${pct(f.projected)}`);
    return parts.join(" · ");
  });
  return bar;
}

// ─── 总览 ───────────────────────────────────────────────────────────
function renderOverview() {
  const ts = state.tenants;
  // 平台水位：按计量单位加权（各所额度大小不同，不能简单平均百分比）
  const total = ts.reduce((s, t) => s + (t.quota?.units?.total ?? 0), 0);
  const used = ts.reduce((s, t) => s + (t.quota?.units?.used ?? 0), 0);
  const plat = { period: ts[0]?.quota?.period, resets_at: ts[0]?.quota?.resets_at, used_ratio: total ? used / total : 0, cap_pct: null };
  const f = forecast(plat);
  $("#hero-kicker").textContent = `${plat.period ? `${plat.period.replace("-", " 年 ")} 月` : "本月"} · 平台用量`;
  $("#hero-pct").textContent = pct(plat.used_ratio);
  const hp = paceBar(plat);
  hp.id = "hero-pace";
  $("#hero-pace").replaceWith(hp);
  $("#hero-note").textContent =
    f.elapsed === null
      ? "还没有律所。"
      : `本月已过 ${pct(f.elapsed)}。${f.projected === null ? "月初样本太少，暂不预测。" : `按当前速度，月底平台用量约为已售额度的 ${pct(f.projected)}。`}${plat.resets_at ? `${mdDay(Date.parse(plat.resets_at))}零点重置。` : ""}`;
  const seats = ts.reduce((s, t) => s + (t.seats_used ?? 0), 0);
  const seatsSold = ts.reduce((s, t) => s + (t.seats ?? 0), 0);
  const bound = ts.reduce((s, t) => s + (t.kimi?.bound ?? 0), 0);
  const paused = ts.filter((t) => t.quota?.paused).length;
  const revenue = ts.map((t) => t.quota?.bill?.revenue_cny);
  const hasPrice = revenue.some((v) => v !== null && v !== undefined);
  const stat = (k, v, s) => h("div", { class: "stat" }, h("div", { class: "k" }, k), h("div", { class: "v" }, v), s ? h("div", { class: "s" }, s) : null);
  $("#hero-stats").replaceChildren(
    stat("律所", fmt(ts.length), `${fmt(ts.filter((t) => t.root_enrolled).length)} 家已在客户端开通`),
    stat("在用席位", `${fmt(seats)}`, `已售 ${fmt(seatsSold)} 席`),
    stat("Kimi 账号绑定", seats ? pct(bound / seats) : "—", `${fmt(bound)} / ${fmt(seats)} 个在用席位`),
    hasPrice ? stat("本月应收", yuan(revenue.reduce((s, v) => s + (v ?? 0), 0)), paused ? `${paused} 家已暂停` : "席位费 + 加量费") : stat("已暂停", fmt(paused), "额度用完或达上限"),
  );
  // 需要关注
  const items = ts
    .map((t) => ({ t, a: attentionOf(t) }))
    .filter((x) => x.a)
    .sort((x, y) => x.a.sev - y.a.sev);
  $("#attention-count").textContent = items.length ? `${items.length} 项` : "";
  $("#attention").replaceChildren(
    ...(items.length
      ? items.slice(0, 12).map(({ t, a }) =>
          h(
            "li",
            { tabindex: 0, onclick: () => openDetail(t.tid, a.go === "加量" ? "plan" : a.go === "续订" || a.go === "发码" ? "subscription" : "usage"), onkeydown: (e) => e.key === "Enter" && e.currentTarget.click() },
            h("span", { class: `dot ${a.cls}` }),
            h("div", {}, h("div", { class: "t" }, a.t), h("div", { class: "d" }, a.d)),
            h("span", { class: "go" }, `${a.go} →`),
          ),
        )
      : [h("li", { class: "none" }, ts.length ? "一切正常：没有快用完、已暂停或快到期的律所。" : "还没有律所。")]),
  );
  // 水位：按已用降序
  const rows = [...ts].sort((a, b) => (b.quota?.used_ratio ?? 0) - (a.quota?.used_ratio ?? 0));
  $("#levels").replaceChildren(
    ...(rows.length
      ? rows.map((t) =>
          h(
            "div",
            { class: "level", tabindex: 0, onclick: () => openDetail(t.tid), onkeydown: (e) => e.key === "Enter" && openDetail(t.tid) },
            h("div", { class: "nm" }, t.name ?? t.tid, h("small", {}, `${t.quota?.plan?.label ?? "—"} · ${fmt(t.seats)} 席`)),
            paceBar(t.quota),
            h("div", { class: `pc tone-${toneOf(t.quota)}` }, pct(t.quota?.used_ratio)),
          ),
        )
      : [h("p", { class: "muted" }, "还没有律所。")]),
  );
}

// ─── 律所表 ─────────────────────────────────────────────────────────
for (const b of $$("#filters .chip"))
  b.addEventListener("click", () => {
    state.filter = b.dataset.f;
    for (const x of $$("#filters .chip")) x.classList.toggle("on", x === b);
    renderFirms();
  });
$("#filter").addEventListener("input", (e) => {
  state.query = e.target.value;
  renderFirms();
});
for (const th of $$("#firm-table th[data-sort]"))
  th.addEventListener("click", () => {
    const k = th.dataset.sort;
    state.sort = { key: k, asc: state.sort.key === k ? !state.sort.asc : k === "name" || k === "until" };
    renderFirms();
  });

function renderFirms() {
  const now = Date.now();
  const q = state.query.trim().toLowerCase();
  const match = (t) => {
    if (q && !t.tid.toLowerCase().includes(q) && !(t.name ?? "").toLowerCase().includes(q)) return false;
    const s = statusOf(t, now).key;
    if (state.filter === "attention") return !!attentionOf(t, now);
    if (state.filter === "paused") return s === "paused";
    if (state.filter === "pending") return s === "pending";
    if (state.filter === "expiring") return Date.parse(t.subscription_until) - now < 30 * 86_400_000;
    return true;
  };
  const key = {
    name: (t) => t.name ?? t.tid,
    plan: (t) => `${t.quota?.plan?.label ?? ""}${String(t.seats).padStart(6, "0")}`,
    used: (t) => t.quota?.used_ratio ?? 0,
    proj: (t) => forecast(t.quota, now).projected ?? -1,
    kimi: (t) => (t.seats_used ? (t.kimi?.bound ?? 0) / t.seats_used : -1),
    until: (t) => t.subscription_until,
  }[state.sort.key];
  const rows = state.tenants.filter(match).sort((a, b) => {
    const x = key(a);
    const y = key(b);
    const c = typeof x === "string" ? x.localeCompare(y, "zh-CN") : x - y;
    return state.sort.asc ? c : -c;
  });
  for (const th of $$("#firm-table th[data-sort]")) {
    th.classList.toggle("sorted", th.dataset.sort === state.sort.key);
    th.classList.toggle("asc", th.dataset.sort === state.sort.key && state.sort.asc);
  }
  // 筛选片上的计数
  const counts = { all: state.tenants.length, attention: 0, paused: 0, pending: 0, expiring: 0 };
  for (const t of state.tenants) {
    const s = statusOf(t, now).key;
    if (attentionOf(t, now)) counts.attention += 1;
    if (s === "paused") counts.paused += 1;
    if (s === "pending") counts.pending += 1;
    if (Date.parse(t.subscription_until) - now < 30 * 86_400_000) counts.expiring += 1;
  }
  for (const b of $$("#filters .chip")) {
    const n = counts[b.dataset.f];
    b.replaceChildren(b.textContent.replace(/\s*\d+$/, ""), n ? h("span", { class: "n" }, n) : "");
  }
  $("#firm-table tbody").replaceChildren(
    ...rows.map((t) => {
      const f = forecast(t.quota, now);
      return h(
        "tr",
        { tabindex: 0, onclick: () => openDetail(t.tid), onkeydown: (e) => e.key === "Enter" && openDetail(t.tid) },
        h("td", {}, h("div", { class: "firm-name" }, t.name ?? "（未命名）"), h("div", { class: "tid" }, t.tid)),
        h("td", {}, `${t.quota?.plan?.label ?? "—"}${t.quota?.plan?.custom ? "（定制）" : ""} · ${fmt(t.seats_used)}/${fmt(t.seats)} 席`, t.quota?.boost_pct ? h("div", { class: "muted" }, `本月加量 +${t.quota.boost_pct}%`) : null),
        h("td", {}, h("div", { class: "usage-cell" }, paceBar(t.quota, { sm: true }), h("span", { class: `pc tone-${toneOf(t.quota)}` }, pct(t.quota?.used_ratio))), t.quota?.cap_pct ? h("div", { class: "muted" }, `上限 ${t.quota.cap_pct}%`) : null),
        h("td", { class: `num ${f.projected !== null && f.projected >= f.limit ? "tone-full" : ""}` }, f.projected === null ? "—" : pct(f.projected)),
        h("td", { class: "num" }, t.seats_used ? `${fmt(t.kimi?.bound ?? 0)}/${fmt(t.seats_used)}` : "—", t.kimi?.required ? h("div", { class: "muted" }, "须登录") : null),
        h("td", {}, day(t.subscription_until)),
        h("td", {}, tag(statusOf(t, now))),
      );
    }),
  );
  $("#empty").hidden = rows.length > 0;
  $("#empty").textContent = state.tenants.length ? "没有符合条件的律所。" : "还没有律所。点右上角“开通律所”开第一家。";
}

// ─── 账单 ───────────────────────────────────────────────────────────
function renderBilling() {
  const ts = [...state.tenants].sort((a, b) => (b.quota?.bill?.revenue_cny ?? 0) - (a.quota?.bill?.revenue_cny ?? 0));
  const period = ts[0]?.quota?.period ?? "";
  $("#bill-title").textContent = `${period ? period.replace("-", " 年 ") + " 月" : "本月"}账单`;
  const priced = ts.some((t) => t.quota?.bill?.seat_fee_cny !== null && t.quota?.bill?.seat_fee_cny !== undefined);
  const costed = ts.some((t) => t.quota?.bill?.cost_cny !== null && t.quota?.bill?.cost_cny !== undefined);
  $("#bill-note").textContent = `应收 = 席位 × 套餐月价 + 加量包（加量 ${state.plans?.boost_price_factor === 1 ? "50% 收半个月席位费" : `按系数 ${state.plans?.boost_price_factor}`}）；模型成本按网关计量估算，月底以网关计量日志与 MaaS 账单对账为准。`;
  const sum = (k) => ts.reduce((s, t) => s + (t.quota?.bill?.[k] ?? 0), 0);
  const rev = sum("revenue_cny");
  const cost = sum("cost_cny");
  const margin = rev - cost;
  const card = (k, v, s, extra) => h("div", { class: "stat" }, h("div", { class: "k" }, k), h("div", { class: "v" }, v), s ? h("div", { class: "s" }, s) : null, extra ?? null);
  const banners = [];
  if (!priced) banners.push(h("div", { class: "banner warn" }, "套餐还没有配置价格：在控制面配置 billing.plans[].seat_price_cny 后，这里显示应收与毛利。"));
  if (!costed) banners.push(h("div", { class: "banner" }, "没有配置模型成本单价（billing.unit_cost_cny）：只显示应收，不显示成本与毛利。"));
  const mb = h("div", { class: "margin-bar" });
  if (priced && costed && rev > 0) mb.append(place(h("span"), { width: `${clamp01(margin / rev) * 100}%` }));
  $("#bill-cards").replaceChildren(
    ...banners.map((b) => place(b, { "grid-column": "1 / -1" })),
    card("本月应收", priced ? yuan(rev) : "—", `${fmt(ts.length)} 家律所`),
    card("其中加量包", priced ? yuan(sum("boost_fee_cny")) : "—", `${ts.filter((t) => t.quota?.boost_pct).length} 家本月加量`),
    card("模型成本（估）", costed ? yuan(cost) : "—", "按网关计量"),
    card("毛利", priced && costed ? yuan(margin) : "—", priced && costed && rev > 0 ? `毛利率 ${pct(margin / rev)}` : null, priced && costed ? mb : null),
  );
  $("#bill-table tbody").replaceChildren(
    ...ts.map((t) => {
      const b = t.quota?.bill ?? {};
      return h(
        "tr",
        { tabindex: 0, onclick: () => openDetail(t.tid, "plan"), onkeydown: (e) => e.key === "Enter" && openDetail(t.tid, "plan") },
        h("td", {}, h("div", { class: "firm-name" }, t.name ?? t.tid), h("div", { class: "tid" }, t.tid)),
        h("td", {}, `${t.quota?.plan?.label ?? "—"}${t.quota?.plan?.custom ? "（定制）" : ""}`),
        h("td", { class: "num" }, fmt(t.seats)),
        h("td", { class: "num" }, yuan(b.seat_fee_cny)),
        h("td", { class: "num" }, t.quota?.boost_pct ? `+${t.quota.boost_pct}%` : "—"),
        h("td", { class: "num" }, b.boost_fee_cny ? yuan(b.boost_fee_cny) : "—"),
        h("td", { class: "num" }, h("b", {}, yuan(b.revenue_cny))),
        h("td", { class: `num tone-${toneOf(t.quota)}` }, pct(t.quota?.used_ratio)),
        h("td", { class: "num" }, yuan(b.cost_cny)),
        h("td", { class: "num" }, yuan(b.margin_cny)),
      );
    }),
  );
  $("#bill-table tfoot").replaceChildren(
    h("tr", {}, h("td", {}, "合计"), h("td"), h("td", { class: "num" }, fmt(ts.reduce((s, t) => s + (t.seats ?? 0), 0))), h("td", { class: "num" }, priced ? yuan(sum("seat_fee_cny")) : "—"), h("td"), h("td", { class: "num" }, priced ? yuan(sum("boost_fee_cny")) : "—"), h("td", { class: "num" }, priced ? yuan(rev) : "—"), h("td"), h("td", { class: "num" }, costed ? yuan(cost) : "—"), h("td", { class: "num" }, priced && costed ? yuan(margin) : "—")),
  );
}

// ─── CSV 导出 ───────────────────────────────────────────────────────
function download(name, rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    // 防公式注入（以 = + - @ 开头的单元格在 Excel 里会被当成公式）
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const csv = "﻿" + rows.map((r) => r.map(esc).join(",")).join("\r\n");
  const a = h("a", { href: URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => (URL.revokeObjectURL(a.href), a.remove()), 1000);
}
const pctCell = (r) => (r === null || r === undefined ? "" : (Math.round(r * 10_000) / 100).toFixed(2));
$("#btn-export-bill").addEventListener("click", () => {
  const rows = [["租户编号", "律所", "月份", "套餐", "席位", "席位费（元）", "加量（%）", "加量费（元）", "本月应收（元）", "用量（%）", "模型成本估算（元）", "毛利（元）"]];
  for (const t of state.tenants) {
    const b = t.quota?.bill ?? {};
    rows.push([t.tid, t.name ?? "", t.quota?.period, t.quota?.plan?.label, t.seats, b.seat_fee_cny, t.quota?.boost_pct ?? 0, b.boost_fee_cny, b.revenue_cny, pctCell(t.quota?.used_ratio), b.cost_cny, b.margin_cny]);
  }
  download(`kwl-bill-${state.tenants[0]?.quota?.period ?? "month"}.csv`, rows);
});
$("#btn-export-usage").addEventListener("click", (e) =>
  busy(e.currentTarget, async () => {
    try {
      // 对账：百分比之外另给计量单位（与网关计量日志 scripts/meter-report.mjs 同一口径）
      const rows = [["租户编号", "律所", "月份", "用量（%）", "加量（%）", "月度上限（%）", "本月额度（计量单位）", "本月已用（计量单位）", "待对账租约", "席位总数", "在用席位", "Kimi 账号已绑定"]];
      for (const t of state.tenants) {
        const u = await api("GET", `${T(t.tid)}/usage`);
        rows.push([u.tid, t.name ?? "", u.period, pctCell(u.used_ratio), u.boost_pct, u.cap_pct ?? "不设", u.units.total, u.units.used, u.leases.unreconciled, u.seats.total, u.seats.assigned, t.kimi?.bound ?? 0]);
        for (const m of u.history ?? []) rows.push([u.tid, t.name ?? "", m.period, pctCell(m.used_ratio), m.boost_pct, "", "", "", "", "", "", ""]);
      }
      download(`kwl-usage-${new Date().toISOString().slice(0, 10)}.csv`, rows);
    } catch (er) {
      toast(errText(er));
    }
  }),
);

// ─── 开通律所 ───────────────────────────────────────────────────────
const newDlg = $("#new-tenant");
/** 套餐卡（开通与改套餐共用）：单选。 */
function planCards(container, name, selected, seatsOf) {
  const plans = state.plans?.plans ?? [];
  const sync = () => {
    for (const l of $$(".plan", container)) l.classList.toggle("on", l.querySelector("input").checked);
  };
  container.append(
    ...plans.map((p) => {
      const input = h("input", { type: "radio", name, value: p.id, ...(p.id === selected ? { checked: true } : {}) });
      input.addEventListener("change", () => (sync(), container.dispatchEvent(new Event("plan-change"))));
      return h("label", { class: "plan" }, input, h("b", {}, p.label), p.note ? h("small", {}, p.note) : null, p.seat_price_cny !== null ? h("span", { class: "price" }, `${yuan(p.seat_price_cny)} / 席 / 月${seatsOf ? ` · 合计 ${yuan(p.seat_price_cny * seatsOf())}` : ""}`) : h("span", { class: "price muted" }, "价格未配置"));
    }),
  );
  sync();
}
$("#btn-new").addEventListener("click", () => {
  const f = $("#new-form");
  f.reset();
  f.querySelector(".error").textContent = "";
  const box = $("#new-plans");
  box.replaceChildren(h("legend", {}, "套餐"));
  planCards(box, "plan", state.plans?.default_plan, () => Number(f.seats.value) || 0);
  const est = () => {
    const p = state.plans?.plans.find((x) => x.id === f.plan.value);
    const seats = Number(f.seats.value) || 0;
    $("#new-estimate").textContent = p ? `${p.label}套餐 · ${seats} 席${p.seat_price_cny !== null ? ` · 每月 ${yuan(p.seat_price_cny * seats)}` : ""}。用量按本月额度的百分比统计，每月 1 日重置。` : "";
  };
  box.addEventListener("plan-change", est);
  f.seats.oninput = () => {
    box.replaceChildren(h("legend", {}, "套餐"));
    const cur = state.plans?.plans.find((x) => x.id === (f.plan?.value ?? state.plans.default_plan))?.id ?? state.plans?.default_plan;
    planCards(box, "plan", cur, () => Number(f.seats.value) || 0);
    est();
  };
  f.kimi_required.disabled = !state.plans?.kimi_account;
  est();
  newDlg.showModal();
});
for (const d of [newDlg, $("#detail")]) d.addEventListener("click", (e) => (e.target.closest("[data-close]") || e.target === d) && d.close());
$("#new-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.currentTarget;
  const err = f.querySelector(".error");
  err.textContent = "";
  const body = { tid: f.tid.value.trim(), edition: f.edition.value, seats: Number(f.seats.value), subscription_days: Number(f.days.value), plan: f.plan.value };
  if (f.name.value.trim()) body.name = f.name.value.trim();
  if (f.kimi_required.checked) body.kimi_required = true;
  await busy(f.querySelector("button[type=submit]"), async () => {
    try {
      await api("POST", "/v1/ops/tenants", body);
      newDlg.close();
      toast(`已开通 ${body.name ?? body.tid}：下一步发创始开通码`);
      await refresh();
      openDetail(body.tid, "subscription");
    } catch (e) {
      err.textContent = errText(e);
    }
  });
});

// ─── 律所详情 ───────────────────────────────────────────────────────
for (const b of $$("#detail-tabs .tab")) b.addEventListener("click", () => showPane(b.dataset.pane));
function showPane(p) {
  state.pane = p;
  for (const b of $$("#detail-tabs .tab")) {
    const on = b.dataset.pane === p;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  }
  if (state.detail) renderPane();
}

async function openDetail(tid, pane = "usage") {
  const dlg = $("#detail");
  $("#detail-title").textContent = "读取中…";
  $("#detail-sub").textContent = tid;
  $("#detail-body").replaceChildren();
  if (!dlg.open) dlg.showModal();
  try {
    const [{ tenant: t }, u] = await Promise.all([api("GET", T(tid)), api("GET", `${T(tid)}/usage`)]);
    state.detail = { t, u };
    $("#detail-title").textContent = t.name ?? tid;
    $("#detail-sub").replaceChildren(`${tid} · ${t.edition === "firm" ? "律所版" : "团队版"} · ${u.plan.label}${u.plan.custom ? "（定制额度）" : ""}套餐 · ${fmt(t.seats)} 席 · `, tag(statusOf(t)));
    showPane(pane);
  } catch (e) {
    state.detail = null;
    $("#detail-title").textContent = "读取失败";
    $("#detail-body").replaceChildren(h("p", { class: "error" }, errText(e)));
  }
}
/** 写操作之后：刷新列表与本抽屉，停在当前分页。 */
async function after(msg) {
  toast(msg);
  await refresh();
  await openDetail(state.detail.t.tid, state.pane);
}

function renderPane() {
  const body = $("#detail-body");
  const { t, u } = state.detail;
  const panes = { usage: paneUsage, plan: panePlan, members: paneMembers, subscription: paneSubscription };
  body.replaceChildren(...panes[state.pane](t, u).filter(Boolean));
  body.scrollTop = 0;
}

/** 环形水位：外环已用，黑色刻度为月份进度，红色刻度为上限。 */
function gauge(q) {
  const tone = toneOf(q);
  const R = 70;
  const C = 2 * Math.PI * R;
  const used = clamp01(q.used_ratio);
  const f = forecast(q);
  const s = svg("svg", { viewBox: "0 0 168 168", "aria-hidden": "true" });
  s.append(svg("circle", { class: "g-track", cx: 84, cy: 84, r: R, fill: "none", "stroke-width": 14 }));
  s.append(svg("circle", { class: "g-used", cx: 84, cy: 84, r: R, fill: "none", "stroke-width": 14, "stroke-linecap": "round", "stroke-dasharray": `${C}`, "stroke-dashoffset": `${C * (1 - used)}` }));
  const tick = (ratio, cls) => {
    const a = ratio * 2 * Math.PI;
    const [x1, y1, x2, y2] = [84 + (R - 11) * Math.cos(a), 84 + (R - 11) * Math.sin(a), 84 + (R + 11) * Math.cos(a), 84 + (R + 11) * Math.sin(a)];
    s.append(svg("line", { class: cls, x1, y1, x2, y2, "stroke-width": 2.5, "stroke-linecap": "round" }));
  };
  if (f.elapsed !== null) tick(f.elapsed, "g-today");
  if (q.cap_pct) tick(Math.min(1, q.cap_pct / 100), "g-cap");
  return h("div", { class: `gauge ${tone === "ok" ? "" : tone}`, role: "img", "aria-label": `本月已用 ${pct(q.used_ratio)}` }, s, h("div", { class: "gauge-label" }, h("b", { class: `tone-${tone}` }, pct(q.used_ratio)), h("small", {}, "本月已用")));
}

function forecastBox(q) {
  const f = forecast(q);
  if (q.paused === "allowance") return h("div", { class: "forecast bad" }, `本月额度已用完：AI 处理暂停。加量立即生效；不加量则 ${mdDay(Date.parse(q.resets_at))}零点重置。`);
  if (q.paused === "cap") return h("div", { class: "forecast warn" }, `已到律所设的上限 ${q.cap_pct}%：AI 处理暂停。调高或取消上限须律所管理员在客户端操作。`);
  if (f.projected === null) return h("div", { class: "forecast" }, `本月已过 ${f.elapsed === null ? "—" : pct(f.elapsed)}，样本还少，暂不预测。`);
  const limitText = q.cap_pct ? `律所上限 ${q.cap_pct}%` : "本月额度";
  if (f.exhaustAt) return h("div", { class: "forecast warn" }, `用得比日历快：本月已过 ${pct(f.elapsed)}、已用 ${pct(q.used_ratio)}。按当前速度约 ${mdDay(f.exhaustAt)}用完${limitText}，月底约 ${pct(f.projected)}。可以提前联系律所加量。`);
  return h("div", { class: "forecast" }, `本月已过 ${pct(f.elapsed)}、已用 ${pct(q.used_ratio)}：按当前速度月底约 ${pct(f.projected)}，${limitText}够用。`);
}

function monthsChart(u) {
  const months = [...(u.history ?? []).slice(-11), { period: u.period, used_ratio: u.used_ratio, boost_pct: u.boost_pct, cur: true }];
  const max = Math.max(1, ...months.map((m) => m.used_ratio ?? 0));
  const chart = h("div", { class: "months", role: "img", "aria-label": `最近 ${months.length} 个月用量占当月额度` });
  // 100% 参考线
  chart.append(place(h("div", { class: "ref" }, h("span", {}, "100%")), { bottom: `${(1 / max) * 100}%` }));
  for (const m of months) {
    const r = m.used_ratio;
    const bar = h("div", { class: `mbar${m.cur ? " cur" : ""}${r === null ? " none" : r >= 1 ? " full" : ""}` }, place(h("span"), { height: `${r === null ? 2 : Math.max(1.5, (r / max) * 100)}%` }));
    tipOn(bar, `${m.period.replace("-", " 年 ")} 月：${r === null ? "旧版计量" : pct(r)}${m.boost_pct ? `（加量 +${m.boost_pct}%）` : ""}${m.cur ? " · 本月进行中" : ""}`);
    chart.append(bar);
  }
  return h("div", {}, chart, h("div", { class: "mlabels" }, ...months.map((m) => h("span", {}, `${Number(m.period.slice(5))}月`))));
}

function paneUsage(t, u) {
  return [
    h(
      "div",
      { class: "gauge-row" },
      gauge(u),
      h(
        "dl",
        { class: "facts" },
        h("div", {}, h("dt", {}, "本月加量"), h("dd", {}, u.boost_pct ? `+${u.boost_pct}%` : "无")),
        h("div", {}, h("dt", {}, "月度上限"), h("dd", {}, u.cap_pct ? `${u.cap_pct}%` : "不设"), u.cap_set_by ? h("dt", {}, `由${u.cap_set_by === "firm_admin" ? "律所管理员" : u.cap_set_by === "ops" ? "中软运营" : u.cap_set_by}设置`) : null),
        h("div", {}, h("dt", {}, "在途（网关已领未用）"), h("dd", {}, pct(u.in_flight_ratio))),
        h("div", {}, h("dt", {}, "重置"), h("dd", {}, mdDay(Date.parse(u.resets_at)))),
      ),
    ),
    forecastBox(u),
    u.leases.unreconciled > 0 ? h("div", { class: "banner warn" }, `有 ${u.leases.unreconciled} 个网关额度租约到期未收到最终回报：按已报用量结案，须与网关计量日志对账（scripts/meter-report.mjs）。`) : null,
    h("section", { class: "section" }, h("h3", {}, "最近 12 个月"), h("p", { class: "sub" }, "每月用量占当月额度（含当月加量）；黑色是本月"), monthsChart(u)),
    h(
      "section",
      { class: "section" },
      h("h3", {}, "用得最多的席位"),
      h("p", { class: "sub" }, "条长与百分比为占全所本月用量；“份额”是占个人份额（本月额度 ÷ 席位数，只作参照、不单独限额）"),
      seatList(u.by_seat.filter((s) => s.requests > 0).slice(0, 5), { compact: true }),
    ),
  ];
}

function seatList(seats, o = {}) {
  if (!seats.length) return h("p", { class: "muted" }, o.compact ? "本月还没有用量。" : "还没有席位。");
  // 个人份额只是参照（不单独限额），所以不用警示色：条长 = 占全所用量（相对用得最多的席位），右侧另写占个人份额
  const top = Math.max(1e-9, ...seats.map((s) => s.firm_ratio));
  return h(
    "div",
    { class: "seat-list" },
    ...seats.map((s) => {
      const k = s.kimi;
      const share = { used_ratio: s.firm_ratio / top, cap_pct: null };
      return h(
        "div",
        { class: "seat" },
        h("span", { class: `avatar${k ? "" : " none"}`, "aria-hidden": "true" }, k ? initials(k.nickname) : "?"),
        h("div", { class: "who-l" }, h("div", {}, k ? `${k.nickname}${k.phone_tail ? `（尾号 ${k.phone_tail}）` : ""}` : "未绑定 Kimi 账号", s.status === "revoked" ? " · 已收回" : ""), h("small", {}, `${s.sid}${k?.level ? ` · ${k.level}` : ""}`)),
        tipOn(place(h("div", { class: "pace sm seat-bar", role: "img", "aria-label": `占全所 ${pct(s.firm_ratio)}` }, place(h("span", { class: "used" }), { width: `${clamp01(share.used_ratio) * 100}%` })), {}), `占全所本月用量 ${pct(s.firm_ratio)} · 个人份额的 ${pct(s.used_ratio)} · ${fmt(s.requests)} 次请求`),
        h("span", { class: "num seat-pc" }, pct(s.firm_ratio), h("small", {}, `份额 ${pct(s.used_ratio)}`)),
        o.compact || !k
          ? h("span", { class: "seat-act muted" }, o.compact ? "" : `${fmt(s.requests)} 次`)
          : h(
              "button",
              {
                type: "button",
                class: "btn ghost sm seat-act",
                onclick: (e) =>
                  busy(e.currentTarget, async () => {
                    try {
                      if (!confirm(`解除 ${k.nickname} 与席位 ${s.sid} 的 Kimi 账号绑定？律所要求 Kimi 登录时，该成员须重新登录才能用 AI。`)) return;
                      await api("POST", `${T(state.detail.t.tid)}/kimi-accounts/${k.ref}/unbind`);
                      await after("已解绑");
                    } catch (er) {
                      toast(errText(er));
                    }
                  }),
              },
              "解绑",
            ),
      );
    }),
  );
}

/** 一张操作卡：表单 + 提交；出错写在卡里。 */
function action(title, fields, label, run, o = {}) {
  const form = h("form", { class: `action${o.danger ? " danger-zone" : ""}${o.wide ? " wide" : ""}`, autocomplete: "off" }, h("h3", {}, title), ...(o.note ? [h("p", { class: "hint" }, o.note)] : []), ...fields, label ? h("button", { type: "submit", class: o.danger ? "btn danger" : "btn primary" }, label) : null, h("p", { class: "error", role: "alert" }));
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const err = form.querySelector(".error");
    err.textContent = "";
    await busy(form.querySelector("button[type=submit]"), async () => {
      try {
        await run(form, err);
      } catch (e) {
        err.textContent = errText(e);
      }
    });
  });
  return form;
}
const field = (label, name, attrs = {}) => h("label", {}, label, h("input", { name, ...attrs }));

function panePlan(t, u) {
  const plan = state.plans?.plans.find((p) => p.id === u.plan.id);
  const seatFee = plan?.seat_price_cny != null ? plan.seat_price_cny * t.seats : null;
  const factor = state.plans?.boost_price_factor ?? 1;
  // 加量包：一键 +25 / +50 / +100%，显示价格
  const boostCard = action(
    "加量包",
    [
      h(
        "div",
        { class: "boost-row" },
        ...[25, 50, 100].map((p) =>
          h(
            "button",
            {
              type: "button",
              class: "boost",
              onclick: (e) =>
                busy(e.currentTarget, async () => {
                  const err = e.currentTarget.closest("form").querySelector(".error");
                  try {
                    if (!confirm(`给 ${t.name ?? t.tid} 本月额度 +${p}%${seatFee !== null ? `（约 ${yuan((seatFee * p * factor) / 100)}）` : ""}？加量即刻生效，月底清零。`)) return;
                    await api("POST", `${T(t.tid)}/boost`, { pct: p });
                    await after(`已加量 +${p}%`);
                  } catch (er) {
                    err.textContent = errText(er);
                  }
                }),
            },
            h("b", {}, `+${p}%`),
            h("small", {}, seatFee !== null ? yuan((seatFee * p * factor) / 100) : "按套餐额度"),
          ),
        ),
      ),
      h("div", { class: "field-row" }, field("自定义（%）", "pct", { type: "number", min: 1, max: 1000, placeholder: "例如 30" })),
    ],
    "按自定义加量",
    async (f) => {
      const p = Number(f.pct.value);
      if (!Number.isInteger(p) || p < 1 || p > 1000) throw new Error("加量须为 1–1000 的整数百分比");
      if (!confirm(`给 ${t.name ?? t.tid} 本月额度 +${p}%？`)) return;
      await api("POST", `${T(t.tid)}/boost`, { pct: p });
      await after(`已加量 +${p}%`);
    },
    { note: "按套餐额度的百分比加到本月，即刻可用、月底清零；计入本月账单。", wide: true },
  );
  // 改套餐与席位
  const planBox = h("fieldset", { class: "plans" }, h("legend", {}, "套餐"));
  const seatsInput = h("input", { name: "seats", type: "number", min: Math.max(1, t.seats_used), max: 10000, value: t.seats, required: true });
  planCards(planBox, "plan", u.plan.id, () => Number(seatsInput.value) || 0);
  const planCard = action(
    "套餐与席位",
    [planBox, h("div", { class: "field-row" }, h("label", {}, `席位数（在用 ${t.seats_used}）`, seatsInput))],
    "保存",
    async (f) => {
      const body = {};
      if (f.plan.value !== u.plan.id) body.plan = f.plan.value;
      if (Number(f.seats.value) !== t.seats) body.seats = Number(f.seats.value);
      if (!Object.keys(body).length) throw new Error("没有改动");
      await api("POST", `${T(t.tid)}/plan`, body);
      await after("套餐与席位已更新：本月额度即刻按新口径计算");
    },
    { note: u.plan.custom ? "这家律所是定制额度（不按席位 × 套餐计），改套餐不影响额度。" : "改套餐或席位立即改变本月额度；已用量不变，百分比随之重算。", wide: true },
  );
  // 代设上限
  const capCard = action(
    "代设月度上限",
    [field("上限（本月额度的 %）", "cap", { type: "number", min: 1, max: 100, required: true, placeholder: u.cap_pct ? `当前 ${u.cap_pct}%` : "当前不设上限" })],
    "设上限",
    async (f) => {
      const c = Number(f.cap.value);
      await api("POST", `${T(t.tid)}/cap`, { cap_pct: c });
      await after(`月度上限设为 ${c}%`);
    },
    { note: "运营只能调低；调高或取消须律所管理员在客户端操作。几分钟后对已发出的网关租约生效。" },
  );
  const billCard = h(
    "div",
    { class: "action" },
    h("h3", {}, "本月账单"),
    h(
      "dl",
      { class: "facts" },
      h("div", {}, h("dt", {}, "席位费"), h("dd", {}, yuan(u.bill.seat_fee_cny))),
      h("div", {}, h("dt", {}, "加量费"), h("dd", {}, u.boost_pct ? yuan(u.bill.boost_fee_cny) : "—")),
      h("div", {}, h("dt", {}, "应收"), h("dd", {}, yuan(u.bill.revenue_cny))),
      h("div", {}, h("dt", {}, "模型成本（估）"), h("dd", {}, yuan(u.bill.cost_cny))),
    ),
    u.boosts.length ? h("ul", { class: "list-plain" }, ...u.boosts.map((b) => h("li", {}, `${day(b.at)} · +${b.pct}% · ${b.by === "ops" ? "中软运营" : b.by}`))) : h("p", { class: "hint" }, "本月没有加量。"),
  );
  return [h("div", { class: "actions-grid" }, boostCard, capCard, billCard, planCard)];
}

function paneMembers(t, u) {
  const req = u.kimi.required;
  const policy = action(
    "Kimi 账号登录",
    [
      h(
        "div",
        { class: "switch" },
        h("div", {}, h("div", {}, req ? "要求成员先用 Kimi 账号登录" : "不强制 Kimi 账号登录"), h("div", { class: "hint" }, u.kimi.enabled ? `已绑定 ${t.kimi.bound} / ${t.seats_used} 个在用席位。要求登录后，未绑定的成员不能用 AI（本机功能照常）。` : "控制面没有配置 Kimi 账号对接（kimi_account），律师端不显示登录入口。")),
        h("button", { type: "submit", class: req ? "btn" : "btn primary", disabled: !u.kimi.enabled && !req }, req ? "改为不强制" : "要求登录"),
      ),
    ],
    null,
    async () => {
      if (!confirm(req ? "改为不强制 Kimi 账号登录？" : `要求 ${t.name ?? t.tid} 的成员先用 Kimi 账号登录？未绑定的 ${Math.max(0, t.seats_used - t.kimi.bound)} 位成员的 AI 处理会暂停，直到登录。`)) return;
      await api("POST", `${T(t.tid)}/kimi-policy`, { required: !req });
      await after(req ? "已改为不强制" : "已要求 Kimi 账号登录");
    },
    { wide: true },
  );
  return [
    policy,
    h("section", { class: "section" }, h("h3", {}, `席位（${fmt(u.seats.assigned)} / ${fmt(u.seats.total)}）`), h("p", { class: "sub" }, "席位编号是假名；成员姓名只在律所客户端里。Kimi 账号只显示打码昵称与手机尾号。"), seatList(u.by_seat)),
    action(
      "收回席位 / 吊销设备",
      [h("div", { class: "field-row" }, field("成员编号（收回席位，由律所提供）", "uid", { placeholder: "可不填" }), field("设备编号（吊销设备，由律所提供）", "device", { placeholder: "可不填" }))],
      "执行",
      async (f) => {
        const uid = f.uid.value.trim();
        const device = f.device.value.trim();
        if (!uid && !device) throw new Error("成员编号与设备编号至少填一个");
        if (!confirm(`${uid ? `收回成员 ${uid} 的席位` : ""}${uid && device ? "，并" : ""}${device ? `吊销设备 ${device}` : ""}？这一步立即生效，不能撤销。`)) return;
        if (uid) await api("POST", `${T(t.tid)}/seats/${encodeURIComponent(uid)}/revoke`);
        if (device) await api("POST", `${T(t.tid)}/devices/${encodeURIComponent(device)}/revoke`);
        await after("已执行");
      },
      { danger: true, wide: true, note: "律所失窃、员工离职等紧急情况用。平时由律所管理员在客户端操作。" },
    ),
  ];
}

function paneSubscription(t) {
  const codes = h(
    "div",
    { class: "action wide" },
    h("h3", {}, "创始开通码"),
    h("p", { class: "hint" }, `发给律所管理员，在客户端“开通”页输入。成员邀请码由律所管理员在客户端发：共 ${fmt(t.member_invitations.total)} 个，未使用 ${fmt(t.member_invitations.open)} 个。`),
    t.activations.length
      ? h(
          "ul",
          { class: "list-plain" },
          ...t.activations.map((a) =>
            h(
              "li",
              {},
              h("code", {}, a.id),
              tag({ cls: a.status === "open" ? "info" : a.status === "consumed" ? "ok" : a.status === "revoked" ? "bad" : "warn", text: { open: "未使用", consumed: "已使用", claimed: "已认领待确认", revoked: "已作废" }[a.status] ?? a.status }),
              h("span", { class: "muted" }, `${day(a.created_at)} 发 · ${day(a.expires_at)} 到期 · ${a.issued_by}`),
              a.status === "open"
                ? h(
                    "button",
                    {
                      type: "button",
                      class: "btn ghost sm",
                      onclick: (e) =>
                        busy(e.currentTarget, async () => {
                          try {
                            if (!confirm(`作废开通码 ${a.id}？`)) return;
                            await api("POST", `${T(t.tid)}/activation-codes/${a.id}/revoke`);
                            await after("已作废");
                          } catch (er) {
                            toast(errText(er));
                          }
                        }),
                    },
                    "作废",
                  )
                : null,
            ),
          ),
        )
      : h("p", { class: "muted" }, "还没有发过开通码。"),
  );
  return [
    h(
      "div",
      { class: "actions-grid" },
      codes,
      action(
        "发创始开通码",
        [field("管理员标识", "slug", { required: true, placeholder: "admin", pattern: "[a-z0-9_\\-]{1,32}" }), field("管理员姓名（可不填）", "name", { maxlength: 40 }), field("有效小时数", "ttl", { type: "number", min: 1, max: 336, value: 72 })],
        "发码",
        async (f, err) => {
          const r = await api("POST", `${T(t.tid)}/activation-codes`, { slug: f.slug.value.trim(), ...(f.name.value.trim() ? { name: f.name.value.trim() } : {}), ttl_hours: Number(f.ttl.value) });
          err.replaceChildren(h("div", { class: "code-box" }, r.code), h("div", { class: "hint" }, `只显示这一次：请当面或电话告知律所管理员。编号 ${r.activation_id}，${day(r.expires_at)} 到期。`));
          toast("已发码");
          await refresh();
        },
      ),
      action("续订", [h("p", { class: "hint" }, `当前订阅到 ${day(t.subscription_until)}。`), field("续订天数（从今天起算）", "days", { type: "number", min: 1, max: 3650, value: 365, required: true })], "续订", async (f) => {
        await api("POST", `${T(t.tid)}/renew`, { days: Number(f.days.value) });
        await after("已续订");
      }),
      action(
        "终止订阅",
        [field(`输入租户编号 ${t.tid} 确认`, "confirm", { required: true })],
        "终止",
        async (f) => {
          if (f.confirm.value.trim() !== t.tid) throw new Error("租户编号不一致");
          await api("POST", `${T(t.tid)}/terminate`);
          await after("已终止订阅");
        },
        { danger: true, wide: true, note: "订阅即刻到期：客户端在许可到期后停止使用云端能力，律所本机数据不受影响。" },
      ),
    ),
  ];
}

// ─── 启动 ───────────────────────────────────────────────────────────
(async () => {
  try {
    if (!globalThis.isSecureContext) throw new Error("请用 https 打开本页（浏览器只在安全上下文里提供签名接口）");
    state.cfg = await loadConfig();
    $("#env-line").textContent = `${state.cfg.label ? `${state.cfg.label} · ` : ""}${state.cfg.deployment} · ${state.cfg.control_plane_base}`;
    showLogin();
  } catch (e) {
    $("#env-line").textContent = "配置错误";
    $("#login").hidden = false;
    $("#login-error").textContent = errText(e);
    $("#login-form button[type=submit]").disabled = true;
  }
})();
// 每 2 分钟自动刷新（页面在前台时）
setInterval(() => {
  if (state.op && document.visibilityState === "visible" && !$("#detail").open && !newDlg.open) refresh().catch(() => undefined);
}, 120_000);
