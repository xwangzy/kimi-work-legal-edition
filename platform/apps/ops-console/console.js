/**
 * 运营控制台（第 37 批）：中软运营人员管理律所租户的网页。
 * 只调控制面运营接口（/v1/ops/…）；每个请求用本人私钥在浏览器里签名（ops-sign.js），控制面按运营名册逐人核验、按接口授权、先记访问审计再执行。
 * 本页没有自己的后端、不存任何状态；配置 config.json 与本页同源（部署时由运维写入）。
 */
import { importOpsKey, signOpsRequest, OPERATOR_ID_RE, OPS_KEY_ID_RE } from "./ops-sign.js";

const $ = (s, el = document) => el.querySelector(s);
const state = { cfg: null, op: null, tenants: [], filter: "" };

// ─── 小工具 ─────────────────────────────────────────────────────────
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style") el.style.cssText = v; // 经 CSSOM 设置：CSP style-src 'self' 会拦掉 style 属性
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const fmt = (n) => (n === null || n === undefined ? "—" : Number(n).toLocaleString("zh-CN"));
const day = (iso) => (iso ? new Date(iso).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" }) : "—");
const money = (points) => {
  const p = state.cfg?.point_price_cny;
  return typeof p === "number" && p > 0 ? `约 ¥${(points * p).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}` : null;
};
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 3200);
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
};
class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

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
const errText = (e) => (e instanceof ApiError ? `${e.message}（${e.code}）` : String(e?.message ?? e));

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
  return { control_plane_base: base, deployment: c.deployment, point_price_cny: typeof c.point_price_cny === "number" ? c.point_price_cny : null, label: typeof c.label === "string" ? c.label : "" };
}

function showLogin() {
  state.op = null;
  $("#who").hidden = true;
  $("#dash").hidden = true;
  $("#login").hidden = false;
}

$("#login-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.currentTarget;
  const err = $("#login-error");
  err.textContent = "";
  const id = f.operator.value.trim();
  const kid = f.kid.value.trim();
  if (!OPERATOR_ID_RE.test(id)) return void (err.textContent = "运营编号须为 op_ 加 4–12 位数字工号");
  if (!OPS_KEY_ID_RE.test(kid)) return void (err.textContent = "密钥编号只许小写字母、数字与连字符");
  const file = f.keyfile.files?.[0];
  if (!file) return void (err.textContent = "请选择私钥文件");
  if (file.size > 16_384) return void (err.textContent = "这不像私钥文件（太大）");
  await busy(f.querySelector("button[type=submit]"), async () => {
    try {
      const key = await importOpsKey(await file.text(), f.passphrase.value);
      state.op = { id, kid, key };
      f.reset();
      f.kid.value = kid;
      await refresh();
      $("#login").hidden = true;
      $("#dash").hidden = false;
      $("#who").hidden = false;
      $("#who-text").textContent = `${id} · 密钥 ${kid}`;
    } catch (e) {
      state.op = null;
      err.textContent = errText(e);
    }
  });
});
$("#btn-logout").addEventListener("click", () => {
  state.tenants = [];
  $("#tenant-table tbody").replaceChildren();
  showLogin();
  toast("已退出：私钥已从本页丢弃");
});

// ─── 租户列表 ───────────────────────────────────────────────────────
async function refresh() {
  const r = await api("GET", "/v1/ops/tenants");
  state.tenants = r.tenants ?? [];
  renderList();
}

function statusTag(t) {
  const now = Date.now();
  if (t.subscription_until && Date.parse(t.subscription_until) <= now) return h("span", { class: "tag bad" }, "订阅已到期/终止");
  if (!t.root_enrolled) return h("span", { class: "tag warn" }, "待律所开通");
  if (t.quota?.paused === "pool") return h("span", { class: "tag bad" }, "点数用完");
  if (t.quota?.paused === "cap") return h("span", { class: "tag warn" }, "已达月度上限");
  if (t.subscription_until && Date.parse(t.subscription_until) - now < 30 * 86_400_000) return h("span", { class: "tag warn" }, "30 天内到期");
  return h("span", { class: "tag ok" }, "正常");
}

function renderList() {
  const q = state.filter.trim().toLowerCase();
  const rows = state.tenants.filter((t) => !q || t.tid.toLowerCase().includes(q) || (t.name ?? "").toLowerCase().includes(q));
  const tbody = $("#tenant-table tbody");
  tbody.replaceChildren(
    ...rows.map((t) =>
      h(
        "tr",
        { onclick: () => openDetail(t.tid), tabindex: 0, onkeydown: (e) => e.key === "Enter" && openDetail(t.tid) },
        h("td", {}, h("div", { class: "name" }, t.name ?? "（未命名）"), h("div", { class: "tid" }, t.tid)),
        h("td", {}, t.edition === "firm" ? "律所版" : "团队版"),
        h("td", { class: "num" }, `${fmt(t.seats_used)} / ${fmt(t.seats)}`),
        h("td", { class: "num" }, fmt(t.quota?.period_used)),
        h("td", { class: "num" }, t.quota?.cap_monthly === null ? "不设" : fmt(t.quota?.cap_monthly)),
        h("td", { class: "num" }, fmt(t.quota?.pool_remaining)),
        h("td", {}, day(t.subscription_until)),
        h("td", {}, statusTag(t)),
      ),
    ),
  );
  $("#empty").hidden = state.tenants.length > 0;
  const used = state.tenants.reduce((s, t) => s + (t.quota?.period_used ?? 0), 0);
  const pool = state.tenants.reduce((s, t) => s + Math.max(0, t.quota?.pool_remaining ?? 0), 0);
  const seats = state.tenants.reduce((s, t) => s + (t.seats_used ?? 0), 0);
  const paused = state.tenants.filter((t) => t.quota?.paused).length;
  const period = state.tenants[0]?.quota?.period ?? "";
  const stat = (k, v, s) => h("div", { class: "stat" }, h("div", { class: "k" }, k), h("div", { class: "v" }, v), s ? h("div", { class: "s" }, s) : null);
  $("#stats").replaceChildren(
    stat("律所租户", fmt(state.tenants.length), `${fmt(state.tenants.filter((t) => t.root_enrolled).length)} 家已在客户端开通`),
    stat("在用席位", fmt(seats)),
    stat(`本月用量（点${period ? ` · ${period}` : ""}）`, fmt(used), money(used)),
    stat("各所池余额合计（点）", fmt(pool), money(pool)),
    stat("已暂停的租户", fmt(paused), "点数用完或达月度上限"),
  );
  $("#env-line").textContent = `${state.cfg.label ? `${state.cfg.label} · ` : ""}部署 ${state.cfg.deployment} · ${state.cfg.control_plane_base} · ${new Date().toLocaleTimeString("zh-CN")} 刷新`;
}
$("#filter").addEventListener("input", (e) => {
  state.filter = e.target.value;
  renderList();
});
$("#btn-refresh").addEventListener("click", (e) =>
  busy(e.currentTarget, async () => {
    try {
      await refresh();
      toast("已刷新");
    } catch (er) {
      toast(errText(er));
    }
  }),
);

// ─── CSV 导出（对账用：点数与席位编号，不含成员与内容） ──────────────
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
$("#btn-export-all").addEventListener("click", (e) =>
  busy(e.currentTarget, async () => {
    try {
      const rows = [["租户编号", "律所", "月份", "用量（点）", "本月在途（点）", "池余额（点）", "累计注入（点）", "月度上限（点）", "席位总数", "在用席位"]];
      for (const t of state.tenants) {
        const u = await api("GET", `/v1/ops/tenants/${encodeURIComponent(t.tid)}/usage`);
        rows.push([u.tid, t.name ?? "", u.period, u.period_used, u.in_flight, u.pool_remaining, u.granted_total, u.cap_monthly ?? "不设", u.seats.total, u.seats.assigned]);
        for (const m of u.history ?? []) rows.push([u.tid, t.name ?? "", m.period, m.used, "", "", "", "", "", ""]);
      }
      download(`kwl-usage-${new Date().toISOString().slice(0, 10)}.csv`, rows);
    } catch (er) {
      toast(errText(er));
    }
  }),
);

// ─── 开通律所 ───────────────────────────────────────────────────────
const newDlg = $("#new-tenant");
$("#btn-new").addEventListener("click", () => {
  $("#new-form").reset();
  $("#new-form .error").textContent = "";
  newDlg.showModal();
});
for (const d of [newDlg, $("#detail")]) d.addEventListener("click", (e) => e.target.closest("[data-close]") && d.close());
$("#new-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.currentTarget;
  const err = f.querySelector(".error");
  err.textContent = "";
  const body = { tid: f.tid.value.trim(), edition: f.edition.value, seats: Number(f.seats.value), subscription_days: Number(f.days.value) };
  if (f.name.value.trim()) body.name = f.name.value.trim();
  if (Number(f.points.value) > 0) body.points = Number(f.points.value);
  await busy(f.querySelector("button[type=submit]"), async () => {
    try {
      await api("POST", "/v1/ops/tenants", body);
      newDlg.close();
      toast(`已开通 ${body.tid}：下一步发创始开通码`);
      await refresh();
      openDetail(body.tid);
    } catch (e) {
      err.textContent = errText(e);
    }
  });
});

// ─── 租户详情 ───────────────────────────────────────────────────────
async function openDetail(tid) {
  const dlg = $("#detail");
  $("#detail-title").textContent = "读取中…";
  $("#detail-sub").textContent = tid;
  $("#detail-body").replaceChildren();
  if (!dlg.open) dlg.showModal();
  try {
    const [{ tenant: t }, u] = await Promise.all([api("GET", `/v1/ops/tenants/${encodeURIComponent(tid)}`), api("GET", `/v1/ops/tenants/${encodeURIComponent(tid)}/usage`)]);
    renderDetail(t, u);
  } catch (e) {
    $("#detail-title").textContent = "读取失败";
    $("#detail-body").replaceChildren(h("p", { class: "error" }, errText(e)));
  }
}

function card(k, v, s) {
  return h("div", { class: "stat" }, h("div", { class: "k" }, k), h("div", { class: "v" }, v), s ? h("div", { class: "s" }, s) : null);
}

function bars(u) {
  const months = [...(u.history ?? []).slice(-11), { period: u.period, used: u.period_used, cur: true }];
  const max = Math.max(1, ...months.map((m) => m.used));
  return h(
    "div",
    {},
    h("div", { class: "bars", role: "img", "aria-label": `最近 ${months.length} 个月用量` }, ...months.map((m) => h("div", { class: m.cur ? "bar cur" : "bar", style: `height:${Math.max(2, Math.round((m.used / max) * 100))}%`, title: `${m.period}：${fmt(m.used)} 点` }))),
    h("div", { class: "bar-labels" }, ...months.map((m) => h("span", {}, m.period.slice(2)))),
  );
}

function action(title, fields, label, run, o = {}) {
  const form = h("form", { class: "action", autocomplete: "off" }, h("h3", {}, title), ...(o.note ? [h("p", { class: "hint" }, o.note)] : []), ...fields, h("button", { type: "submit", class: o.danger ? "btn danger" : "btn primary" }, label), h("p", { class: "error", role: "alert" }));
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const err = form.querySelector(".error");
    err.textContent = "";
    await busy(form.querySelector("button"), async () => {
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

function renderDetail(t, u) {
  const tid = t.tid;
  $("#detail-title").textContent = t.name ?? tid;
  $("#detail-sub").replaceChildren(`${tid} · ${t.edition === "firm" ? "律所版" : "团队版"} · 订阅到 ${day(t.subscription_until)} · `, statusTag(t));
  const after = async (msg) => {
    toast(msg);
    await refresh();
    await openDetail(tid);
  };
  const cap = u.cap_monthly === null ? "不设上限" : fmt(u.cap_monthly);
  const body = [
    h(
      "div",
      { class: "cards" },
      card(`本月已用（${u.period}）`, fmt(u.period_used), money(u.period_used)),
      card("月度上限", cap, u.cap_set_by ? `设置者：${u.cap_set_by === "firm_admin" ? "律所管理员" : u.cap_set_by}` : null),
      card("池余额", fmt(u.pool_remaining), money(u.pool_remaining)),
      card("累计注入", fmt(u.granted_total)),
      card("在途（已发给网关未用完）", fmt(u.in_flight)),
      card("席位", `${fmt(u.seats.assigned)} / ${fmt(u.seats.total)}`, `设备 ${fmt(t.devices.active)} 台在用`),
    ),
    u.leases.unreconciled > 0 ? h("p", { class: "error" }, `有 ${u.leases.unreconciled} 个网关额度租约到期未收到最终回报：按已报用量结案，须与网关计量日志对账（scripts/meter-report.mjs）`) : null,
    h("div", { class: "section" }, h("h3", {}, "最近 12 个月用量（点）"), bars(u)),
    h(
      "div",
      { class: "section" },
      h("h3", {}, "本月按席位（席位编号是假名，不含成员姓名；需要对应到人请律所管理员在客户端查看）"),
      u.by_seat.length
        ? h(
            "div",
            { class: "table-wrap" },
            h(
              "table",
              { class: "grid" },
              h("thead", {}, h("tr", {}, h("th", {}, "席位编号"), h("th", {}, "状态"), h("th", { class: "num" }, "点数"), h("th", { class: "num" }, "请求数"))),
              h("tbody", {}, ...u.by_seat.map((s) => h("tr", {}, h("td", {}, h("code", {}, s.sid)), h("td", {}, s.status === "active" ? "在用" : s.status === "revoked" ? "已收回" : "—"), h("td", { class: "num" }, fmt(s.points)), h("td", { class: "num" }, fmt(s.requests))))),
            ),
          )
        : h("p", { class: "muted" }, "本月还没有用量。"),
      h("div", { class: "row-end" }, h("button", { type: "button", class: "btn", onclick: () => download(`kwl-${tid}-${u.period}.csv`, [["租户编号", "月份", "席位编号", "状态", "点数", "请求数"], ...u.by_seat.map((s) => [tid, u.period, s.sid, s.status, s.points, s.requests])]) }, "导出本月席位明细（CSV）")),
    ),
    h(
      "div",
      { class: "section" },
      h("h3", {}, "创始开通码（发给律所管理员，在客户端“开通”页输入）"),
      t.activations.length
        ? h("ul", {}, ...t.activations.map((a) => h("li", {}, h("code", {}, a.id), ` · ${a.status === "open" ? "未使用" : a.status === "consumed" ? "已使用" : a.status === "claimed" ? "已认领待确认" : a.status === "revoked" ? "已作废" : a.status} · ${day(a.created_at)} 发 · ${day(a.expires_at)} 到期 · ${a.issued_by} `, a.status === "open" ? h("button", { type: "button", class: "btn ghost", onclick: async (e) => busy(e.currentTarget, async () => { try { if (!confirm(`作废开通码 ${a.id}？`)) return; await api("POST", `/v1/ops/tenants/${encodeURIComponent(tid)}/activation-codes/${a.id}/revoke`); await after("已作废"); } catch (er) { toast(errText(er)); } }) }, "作废") : null)))
        : h("p", { class: "muted" }, "还没有发过开通码。"),
      h("p", { class: "muted" }, `成员邀请码由律所管理员在客户端发：共 ${fmt(t.member_invitations.total)} 个，未使用 ${fmt(t.member_invitations.open)} 个。`),
    ),
    h(
      "div",
      { class: "section actions" },
      action("加量（注入点数）", [field("点数", "points", { type: "number", min: 1, required: true, placeholder: "例如 100000" })], "加量", async (f) => {
        const points = Number(f.points.value);
        if (!confirm(`给 ${t.name ?? tid} 注入 ${fmt(points)} 点？${money(points) ? `（${money(points)}）` : ""}`)) return;
        await api("POST", `/v1/ops/tenants/${encodeURIComponent(tid)}/points`, { points });
        await after(`已注入 ${fmt(points)} 点`);
      }),
      action(
        "代设月度上限",
        [field("每月上限（点）", "cap", { type: "number", min: 0, required: true, placeholder: u.cap_monthly === null ? "当前不设上限" : `当前 ${u.cap_monthly}` })],
        "设上限",
        async (f) => {
          const capV = Number(f.cap.value);
          await api("POST", `/v1/ops/tenants/${encodeURIComponent(tid)}/cap`, { cap: capV });
          await after(`月度上限设为 ${fmt(capV)} 点`);
        },
        { note: "运营只能调低；调高或取消须律所管理员在客户端操作。调低几分钟后对已发出的网关租约生效。" },
      ),
      action("续订", [field("续订天数", "days", { type: "number", min: 1, max: 3650, value: 365, required: true })], "续订", async (f) => {
        await api("POST", `/v1/ops/tenants/${encodeURIComponent(tid)}/renew`, { days: Number(f.days.value) });
        await after("已续订");
      }),
      action(
        "发创始开通码",
        [field("管理员标识", "slug", { required: true, placeholder: "admin", pattern: "[a-z0-9_\\-]{1,32}" }), field("管理员姓名（可不填）", "name", { maxlength: 40 }), field("有效小时数", "ttl", { type: "number", min: 1, max: 336, value: 72 })],
        "发码",
        async (f, err) => {
          const r = await api("POST", `/v1/ops/tenants/${encodeURIComponent(tid)}/activation-codes`, { slug: f.slug.value.trim(), ...(f.name.value.trim() ? { name: f.name.value.trim() } : {}), ttl_hours: Number(f.ttl.value) });
          err.replaceChildren(h("div", { class: "code-box" }, `开通码（只显示这一次，请当面或电话告知律所管理员）：${r.code}`), h("div", { class: "muted" }, `编号 ${r.activation_id}，${day(r.expires_at)} 到期`));
          toast("已发码");
          await refresh();
        },
      ),
      action(
        "收回席位 / 吊销设备",
        [field("成员编号（收回席位，由律所提供）", "uid", { placeholder: "可不填" }), field("设备编号（吊销设备，由律所提供）", "device", { placeholder: "可不填" })],
        "执行",
        async (f) => {
          const uid = f.uid.value.trim();
          const device = f.device.value.trim();
          if (!uid && !device) throw new Error("成员编号与设备编号至少填一个");
          if (!confirm(`${uid ? `收回成员 ${uid} 的席位` : ""}${uid && device ? "，并" : ""}${device ? `吊销设备 ${device}` : ""}？这一步立即生效，不能撤销。`)) return;
          if (uid) await api("POST", `/v1/ops/tenants/${encodeURIComponent(tid)}/seats/${encodeURIComponent(uid)}/revoke`);
          if (device) await api("POST", `/v1/ops/tenants/${encodeURIComponent(tid)}/devices/${encodeURIComponent(device)}/revoke`);
          await after("已执行");
        },
        { danger: true, note: "律所失窃、员工离职等紧急情况用。平时由律所管理员在客户端操作。" },
      ),
      action(
        "终止订阅",
        [field(`输入租户编号 ${tid} 确认`, "confirm", { required: true })],
        "终止",
        async (f) => {
          if (f.confirm.value.trim() !== tid) throw new Error("租户编号不一致");
          await api("POST", `/v1/ops/tenants/${encodeURIComponent(tid)}/terminate`);
          await after("已终止订阅");
        },
        { danger: true, note: "订阅即刻到期：客户端在许可到期后停止使用云端能力，律所本机数据不受影响。" },
      ),
    ),
  ];
  $("#detail-body").replaceChildren(...body.filter(Boolean));
}

// ─── 启动 ───────────────────────────────────────────────────────────
(async () => {
  try {
    if (!globalThis.isSecureContext) throw new Error("请用 https 打开本页（浏览器只在安全上下文里提供签名接口）");
    state.cfg = await loadConfig();
    $("#env-line").textContent = `${state.cfg.label ? `${state.cfg.label} · ` : ""}部署 ${state.cfg.deployment} · ${state.cfg.control_plane_base}`;
    showLogin();
  } catch (e) {
    $("#env-line").textContent = "配置错误";
    $("#login").hidden = false;
    $("#login-error").textContent = errText(e);
    $("#login-form button[type=submit]").disabled = true;
  }
})();
