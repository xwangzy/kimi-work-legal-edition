/**
 * 账号。第 71 批（V45）重构：
 *   列表   跨客户的查找入口（接电话先在这里搜手机号或邮箱）：7 列；“共 N 个”用接口的 total；?jump=1 且只命中一个时直接进详情。
 *   详情   #/ops/accounts/<aid> 是“这个人”的唯一落点（原先是没有网址的抽屉）：登录诊断、电脑（让它退出登录 / 移除这台电脑）、
 *          本期用量、会话、告警、身份。页头主操作随状态变：锁定 → 解锁（B-3）；停用 → 启用；其余 → 发重置码。
 * 接口：GET /v1/ops/accounts?q&tid&status&limit&cursor、GET /v1/ops/accounts/{aid}（seat、tenant 摘要、join_requests_pending）、
 *       POST …/reset-code|sessions/revoke|enable|disable|limits、POST …/devices/{id}/signout（第 71 批契约）、
 *       POST /v1/ops/tenants/{tid}/seats/{uid}/revoke 与 …/devices/{id}/revoke（停用时一并收回 / 移除）。
 */
import * as api from "../api.js";
import { accountBadge, alertList, can, canSupport, CREATED_VIA, ctx, DENOMINATOR, deviceLabel, deviceState, deviceTable, go, LIMIT_SOURCE, needs, pageHead, PAUSED, pendingRow, revokeDevice, ROLE, roleText, setCrumbs, signoutDevice, tenantOptions } from "../domain.js";
import {
  add, badge, btn, clear, confirmAction, copyBtn, dataTable, errorBlock, facts, fmt, fold, h, hbars, icon, loadingBlock, meter, metaLine, mono, note, panel,
  rowMenu, searchInput, segmented, showSecret, stateCell, toast, trendChart,
} from "../ui.js";

const st = { q: "", tid: "", status: "", table: { sort: "last_login_at", asc: false } };

export function render(page, r) {
  if (r.arg) return renderDetail(page, r.arg, r.params);
  if (r.params.q !== undefined) st.q = r.params.q;
  if (r.params.tid !== undefined) st.tid = r.params.tid;
  const jump = r.params.jump === "1";
  const tools = h("div", { class: "toolbar" });
  const box = h("div", { class: "stack" });
  page.append(pageHead("账号", "所有客户的成员账号。接电话时先在这里搜手机号或邮箱", btn("代建账号", () => createAccount(st.tid || null, () => ctx.reload()), { kind: "primary", icon: icon("plus"), disabled: !can("account.manage"), title: needs("account.manage") })), tools, box);
  let rows = [];
  let next = null;
  let total = 0;
  let counts = null;
  let seq = 0;
  let first = true;
  const fetchPage = async (append) => {
    const my = ++seq;
    if (!append) clear(box, loadingBlock("正在读取账号…"));
    try {
      const res = await api.get("/v1/ops/accounts", { q: st.q, tid: st.tid, status: st.status, limit: 50, cursor: append ? next : undefined });
      if (my !== seq) return;
      rows = append ? rows.concat(res.accounts ?? []) : res.accounts ?? [];
      next = res.next ?? null;
      total = Number(res.total ?? rows.length);
      counts = res.counts ?? counts;
      drawSeg();
      if (first && jump && st.q && rows.length === 1 && total === 1) return void location.replace(`#/ops/accounts/${encodeURIComponent(rows[0].aid)}`);
      first = false;
      draw();
    } catch (e) {
      if (my !== seq) return;
      clear(box, errorBlock(e, () => fetchPage(false)));
    }
  };
  const draw = () =>
    clear(
      box,
      dataTable({
        state: st.table,
        rows,
        onRow: (a) => go(`accounts/${encodeURIComponent(a.aid)}`),
        empty: st.q ? `没有找到“${st.q}”。可以试试手机号后四位、邮箱前缀或客户名称` : st.tid || st.status ? "没有符合条件的账号" : "还没有账号：律师自助注册或运营代建后出现在这里",
        rowClass: (a) => (a.status === "disabled" ? "dim" : a.locked ? "flagged" : ""),
        caption: "账号",
        columns: [
          { key: "name", label: "成员", value: (a) => a.name ?? a.email, render: (a) => h("div", { class: "cell-2" }, h("b", {}, a.name || "—"), h("small", {}, [a.phone, a.email].filter(Boolean).join(" · "))) },
          { key: "tenant_name", label: "客户", value: (a) => a.tenant_name ?? a.tid, render: (a) => h("div", { class: "cell-2" }, a.tenant_name ?? a.tid, mono(a.tid)) },
          { key: "role", label: "角色", value: (a) => roleText(a.role) },
          { key: "status", label: "状态", value: (a) => (a.status === "disabled" ? 2 : a.locked ? 1 : 0), render: (a) => accountState(a) },
          { key: "last_login_at", label: "最近登录", value: (a) => a.last_login_at ?? "", render: (a) => h("span", { title: fmt.full(a.last_login_at) }, a.last_login_at ? fmt.ago(a.last_login_at) : "从未登录") },
          { key: "devices", label: "电脑", value: (a) => Number(a.devices_signed_in ?? a.devices) || 0, render: (a) => devicesCell(a) },
          { key: "seat_used", label: "席位", title: "席位 = 律所可同时使用 AI 的成员名额；个人客户不讲席位", value: (a) => (a.seat_used === null || a.seat_used === undefined ? 2 : a.seat_used ? 0 : 1), render: (a) => (a.seat_used === null || a.seat_used === undefined ? h("span", { class: "muted" }, "个人") : a.seat_used ? stateCell("已占席", "ok") : stateCell("未占席", "neutral", "能登录，但用不了 AI")) },
          { key: "used_ratio", label: "本期用量", num: true, value: (a) => a.used_ratio ?? null, render: (a) => (a.used_ratio === null || a.used_ratio === undefined ? h("span", { class: "muted" }, "—") : fmt.pct(a.used_ratio)) },
          { key: "_act", label: "", sortable: false, class: "act", render: (a) => rowMenu(listActions(a, () => fetchPage(false)), { aria: `操作：${a.name || a.email}` }) },
        ],
      }),
      next ? h("div", { class: "more" }, btn(`加载更多（已显示 ${rows.length} / ${total}）`, (ev) => ((ev.currentTarget.disabled = true), fetchPage(true)))) : rows.length ? h("p", { class: "muted small center" }, `共 ${fmt.int(total)} 个`) : null,
    );
  // 客户筛选：可输入（原先是一次装入全部客户的下拉框；个人客户一多就没法用，且依赖 tenant.read）
  const dl = h("datalist", { id: "acct-tenant-opts" });
  const tIn = h("input", { type: "search", class: "search", list: "acct-tenant-opts", placeholder: "客户：输入名称或编号", "aria-label": "按客户筛选", value: st.tid, autocomplete: "off" });
  tIn.addEventListener("change", () => {
    const v = tIn.value.trim();
    const m = /（(ten_[A-Za-z0-9_-]+)）$/.exec(v) ?? /^(ten_[A-Za-z0-9_-]+)$/.exec(v);
    st.tid = v ? (m?.[1] ?? st.tid) : "";
    fetchPage(false);
  });
  if (can("tenant.read")) tenantOptions().then((opts) => clear(dl, opts.filter(([v]) => v).map(([v, l]) => h("option", { value: l })))).catch(() => {});
  const statusSeg = h("span");
  const drawSeg = () => clear(statusSeg, h("span", { class: "seg-label" }, "状态"), segmented([{ id: "", label: "全部", count: counts?.all }, { id: "active", label: "正常", count: counts?.active }, { id: "locked", label: "已锁定", count: counts?.locked }, { id: "disabled", label: "已停用", count: counts?.disabled }, { id: "unseated", label: "未占席", count: counts?.unseated }], st.status, (v) => ((st.status = v), drawSeg(), fetchPage(false)), "状态"));
  drawSeg();
  tools.append(searchInput({ placeholder: "手机号、邮箱或姓名", value: st.q, onInput: (v) => ((st.q = v.trim()), fetchPage(false)), delay: 300 }), tIn, dl, statusSeg);
  fetchPage(false);
}

/** 列表行尾菜单（第二轮 05）：发重置码 / 解锁 / 查看电脑 / 停用（停用要在详情页填原因与确认） */
function listActions(a, after) {
  const locked = !!a.locked && a.status !== "disabled";
  return [
    { label: "打开详情", onClick: () => go(`accounts/${encodeURIComponent(a.aid)}`) },
    { label: "查看电脑", onClick: () => go(`accounts/${encodeURIComponent(a.aid)}?section=devices`) },
    locked ? { label: "解锁…", onClick: () => quickEnable(a, true, after), disabled: !canSupport(), title: canSupport() ? undefined : needs("account.support") } : null,
    a.status === "disabled" ? { label: "启用…", onClick: () => quickEnable(a, false, after), disabled: !canSupport(), title: canSupport() ? undefined : needs("account.support") } : { label: a.has_password === false ? "生成设置码…" : "生成重置码…", onClick: () => quickReset(a), disabled: !canSupport(), title: canSupport() ? undefined : needs("account.support") },
    a.status === "disabled" ? null : { label: "停用账号…", danger: true, onClick: () => go(`accounts/${encodeURIComponent(a.aid)}?action=disable`), disabled: !can("account.manage"), title: needs("account.manage") },
  ];
}
async function quickEnable(a, unlock, after) {
  const ok = await confirmAction({ title: unlock ? `解锁 ${a.name || a.email}` : `启用 ${a.name || a.email}`, consequences: unlock ? ["立即解除登录失败锁定，本人可以马上再试；", "不改密码、不影响已有登录。"] : ["本人可再次登录；同时解除登录失败锁定。"], confirmLabel: unlock ? "解锁" : "启用", run: () => api.post(`${api.A(a.aid)}/enable`) });
  if (ok) (toast(unlock ? "已解锁" : "已启用"), after?.());
}
async function quickReset(a) {
  const r = await confirmAction({ title: a.has_password === false ? "生成设置码" : "生成重置码", lead: h("p", {}, a.name ? `${a.name} · ${a.email}` : a.email), consequences: [a.has_password === false ? "生成一次性设置密码码（24 小时），只在这个屏幕上显示一次，不发短信；" : "生成一次性重置码（30 分钟），只在这个屏幕上显示一次，不发短信；", "本人凭码设新密码后，全部登录失效、须重新登录；改密码同时解除登录锁定。"], confirmLabel: a.has_password === false ? "生成设置码" : "生成重置码", run: () => api.post(`${api.A(a.aid)}/reset-code`) });
  if (r?.reset_code) await showSecret({ title: `${r.purpose === "setup" ? "设置密码码" : "重置码"} · ${a.email}`, secret: r.reset_code, expiresAt: r.expires_at, note: "请当面或经电话交给本人，在“忘记密码 → 重置码”里使用。" });
}

const accountState = (a) =>
  a.status === "disabled"
    ? stateCell("已停用", "neutral", a.disabled_reason ? `停用原因：${a.disabled_reason}` : undefined)
    : a.locked
      ? stateCell("已锁定", "warn", "登录失败次数过多，暂时锁定")
      : a.status === "active"
        ? stateCell("正常", "ok")
        : accountBadge(a);
/** “登录中 x / 上限 n”：电脑数上限按同时登录的电脑计（第 71 批）；旧云端没给 devices_signed_in 时用未移除台数 */
function devicesCell(a) {
  const on = a.devices_signed_in ?? a.devices;
  const full = Number(on) >= Number(a.device_limit);
  return h("div", { class: "cell-2", title: `同时登录上限 ${fmt.int(a.device_limit)} 台；已登记 ${fmt.int(a.devices)} 台` }, h("span", { class: full ? "tone-text-warn" : "" }, `${fmt.int(on)} / ${fmt.int(a.device_limit)} 台在线${full ? " · 已满" : ""}`), Number(a.devices_pending) > 0 ? h("small", { class: "tone-text-warn" }, `${fmt.int(a.devices_pending)} 台待批准`) : null);
}

/** 代建账号：返回一次性“设置密码码”（24 小时） */
export async function createAccount(tid, after) {
  const opts = await tenantOptions();
  const r = await confirmAction({
    title: "代建账号",
    lead: h("p", {}, "为律所成员建账号。建好后给出一次性“设置密码码”（24 小时），交本人在客户端登录页设置密码。"),
    fields: [
      { name: "tid", label: "律所", type: "select", options: opts.filter(([v]) => v), value: tid ?? "", required: true },
      { name: "email", label: "邮箱", type: "email", required: true, placeholder: "name@firm.example" },
      { name: "name", label: "显示名", required: true, maxlength: 40 },
      { name: "role", label: "角色", type: "select", options: Object.entries(ROLE), value: "lawyer" },
    ],
    validate: (v) => (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email) ? "邮箱格式不对" : !v.tid ? "请选择律所" : null),
    confirmLabel: "建账号",
    run: (v) => api.post("/v1/ops/accounts", { tid: v.tid, email: v.email.toLowerCase(), name: v.name, role: v.role }),
  });
  if (r?.setup_code) {
    await showSecret({ title: `设置密码码 · ${r.account?.email ?? ""}`, secret: r.setup_code, expiresAt: r.expires_at, note: "本人首次登录时在“忘记密码 / 设置密码”处输入此码并设密码。" });
    after?.();
  }
}

/** 旧调用方（客户详情、电脑表）用的入口：第 71 批起账号详情是页面 */
export const openAccount = (aid) => go(`accounts/${encodeURIComponent(aid)}`);

// ─── 账号详情页 ──────────────────────────────────────────────────────
function renderDetail(page, aid, params) {
  const head = h("div");
  const body = h("div", { class: "stack" });
  page.append(head, body);
  const reload = async () => {
    clear(body, loadingBlock("正在读取账号…"));
    try {
      const d = await api.get(api.A(aid));
      draw(head, body, d, reload, params);
      if (params?.action === "disable") (history.replaceState(null, "", `#/ops/accounts/${encodeURIComponent(aid)}`), (params.action = null), ctx.disableAccount?.());
    } catch (e) {
      clear(head);
      clear(body, errorBlock(e, reload));
    }
  };
  reload();
}

function draw(head, body, d, reload, params) {
  const a = d.account ?? {};
  const u = d.usage ?? {};
  const t = d.tenant;
  const A = api.A(a.aid);
  const devs = (d.devices ?? []).map((x) => ({ ...x, aid: x.aid ?? a.aid, email: x.email ?? a.email, tid: x.tid ?? a.tid }));
  const live = devs.filter((x) => deviceState(x) !== "revoked");
  const signedIn = live.filter((x) => deviceState(x) === "signed_in");
  const limit = Number(a.device_limit) || 0;
  const full = limit > 0 && signedIn.length >= limit;
  const locked = !!a.locked && a.status !== "disabled";
  // 第二轮（06）：面包屑与侧栏高亮一致——都在“账号”下；所属客户放在元信息行里可点
  setCrumbs([["账号", "ops/accounts"], [a.name || a.email]]);
  const admins = d.firm_admins ?? [];
  const joins = d.join_requests_pending ?? [];
  const adminText = admins.map((x) => [x.name, x.phone, x.email].filter(Boolean).join(" ")).join("；");

  const resetCode = async () => {
    const r = await confirmAction({ title: a.has_password === false ? "生成设置码" : "生成重置码", lead: h("p", {}, a.name ? `${a.name} · ${a.email}` : a.email), consequences: a.has_password === false ? ["生成一次性设置密码码（24 小时），只在这个屏幕上显示一次，不发短信；", "请当面或经电话交给本人，本人凭码设密码。"] : ["生成一次性重置码（30 分钟），只在这个屏幕上显示一次，不发短信；", "本人凭码设新密码后，全部登录失效、须重新登录；改密码同时解除登录锁定。"], confirmLabel: a.has_password === false ? "生成设置码" : "生成重置码", run: () => api.post(`${A}/reset-code`) });
    if (r?.reset_code) await showSecret({ title: `${r.purpose === "setup" ? "设置密码码" : "重置码"} · ${a.email}`, secret: r.reset_code, expiresAt: r.expires_at, note: "请当面或经电话交给本人，在“忘记密码 → 重置码”里使用。" });
  };
  const signoutAll = async () => {
    const r = await confirmAction({ title: "全部退出登录", consequences: [`这个账号在网页与客户端的 ${fmt.int(a.sessions_active)} 个登录会话全部失效（约 15 秒内生效）；`, "本人重新登录即可继续用；电脑上的资料保留。"], confirmLabel: "全部退出登录", run: () => api.post(`${A}/sessions/revoke`) });
    if (r) (toast(`已退出 ${fmt.int(r.revoked)} 个登录会话`), reload());
  };
  const enable = async (unlock) => {
    const ok = await confirmAction({ title: unlock ? "解锁账号" : "启用账号", consequences: unlock ? ["立即解除登录失败锁定，本人可以马上再试；", "不改密码、不影响已有登录。"] : ["本人可再次登录；之前失效的登录不恢复，须重新登录；", "同时解除登录失败锁定。"], confirmLabel: unlock ? "解锁" : "启用", run: () => api.post(`${A}/enable`) });
    if (ok) (toast(unlock ? "已解锁" : "已启用"), reload());
  };
  const limits = async () => {
    const custom = a.device_limit_custom === undefined ? null : a.device_limit_custom;
    const r = await confirmAction({
      title: "个人上限",
      lead: h("p", {}, `${a.name || a.email} · 现在同时登录的电脑数上限 ${fmt.int(a.device_limit)} 台（${LIMIT_SOURCE[a.device_limit_source] ?? "生效值"}）`),
      fields: [
        { name: "device_limit", label: "同时登录的电脑数上限", type: "number", min: 1, max: 9, value: custom ?? "", hint: `1–9；留空 = 按套餐${a.device_limit_source !== "account" ? `（现在是 ${fmt.int(a.device_limit)} 台）` : ""}。登录中、未移除的电脑才占名额` },
        { name: "quota_limit", label: `个人额度上限（每期，${u.unit === "cny" ? "元" : "额度单位"}）`, type: "number", min: 0, value: a.quota_limit ?? "", hint: "留空 = 不单设（按套餐每人额度显示参考比例）" },
      ],
      validate: (v) => (v.device_limit !== null && !(Number.isInteger(v.device_limit) && v.device_limit >= 1 && v.device_limit <= 9) ? "电脑数填 1–9 的整数，或留空" : v.quota_limit !== null && !(v.quota_limit > 0) ? "个人额度上限须大于 0，或留空" : null),
      consequences: ["个人额度上限立即参与额度判定：用到上限即暂停该账号的 AI；", "电脑数上限只影响新登录的电脑；已登录的电脑不会被强制退出。"],
      confirmLabel: "保存",
      // B-2：只送改了的项——原先把生效值当单设值写回，保存一次账号就脱离了套餐
      run: (v) => {
        const body = {};
        if (v.device_limit !== custom) body.device_limit = v.device_limit;
        if (v.quota_limit !== (a.quota_limit ?? null)) body.quota_limit = v.quota_limit;
        return Object.keys(body).length ? api.post(`${A}/limits`, body) : { ok: true, unchanged: true };
      },
    });
    if (r) (toast(r.unchanged ? "没有改动" : "已保存"), reload());
  };
  const disable = async () => {
    const seatLive = d.seat && !d.seat.revoked_at;
    const canRevoke = can("device.revoke");
    const fields = [
      { name: "reason", label: "停用原因（记入审计，本人可见）", type: "textarea", required: true, maxlength: 100 },
      seatLive && canRevoke ? { name: "seat", label: "同时收回席位", type: "checkbox", value: true, hint: "离职时勾上：席位空出可分给别人" } : null,
      live.length && canRevoke ? { name: "devices", label: `同时移除名下 ${live.length} 台电脑`, type: "checkbox", value: false, hint: "停用后这些电脑已不能用 AI；只有电脑丢失或要回收时才需要移除" } : null,
    ].filter(Boolean);
    const r = await confirmAction({
      title: `停用 ${a.name || a.email}`,
      danger: true,
      consequences: ["立即让该账号的全部登录失效：所有电脑约 15 秒内暂停（AI 停用，本机功能照常）；", "本人不能再登录，直到运营启用；", "用量与审计记录保留。"],
      fields,
      typeToConfirm: a.email,
      typeLabel: "再输入一次邮箱以确认：",
      confirmLabel: "停用账号",
      run: async (v) => {
        await api.post(`${A}/disable`, { reason: v.reason });
        const done = ["已停用"];
        const bad = [];
        if (v.seat && d.seat) await api.post(`${api.T(a.tid)}/seats/${api.seg(d.uid ?? d.seat.sid)}/revoke`).then(() => done.push("已收回席位"), (e) => bad.push(`收回席位：${e.message}`));
        if (v.devices) for (const x of live) await api.post(`${api.T(a.tid)}/devices/${api.seg(x.device_id)}/revoke`).then(() => {}, (e) => bad.push(`${deviceLabel(x)}：${e.message}`));
        if (v.devices && bad.length < live.length) done.push("已移除电脑");
        return { done, bad };
      },
    });
    if (r) (toast(`${r.done.join("，")}${r.bad.length ? `；未完成：${r.bad.join("；")}` : ""}`, r.bad.length ? "error" : "ok"), reload());
  };

  // 页头主操作随状态变（V-4）：锁定 → 解锁；停用 → 启用；其余 → 发重置码
  ctx.disableAccount = disable;
  const copyAdmins = () => navigator.clipboard?.writeText(adminText).then(() => toast("已复制律所管理员联系方式"), () => toast(adminText, "info"));
  const primary = joins.length && admins.length && !locked && a.status !== "disabled"
    ? btn("复制管理员联系方式", copyAdmins, { kind: "primary", title: adminText })
    : locked
    ? btn("解锁…", () => enable(true), { kind: "primary", disabled: !canSupport(), title: canSupport() ? undefined : needs("account.support") })
    : a.status === "disabled"
      ? btn("启用…", () => enable(false), { kind: "primary", disabled: !canSupport(), title: canSupport() ? undefined : needs("account.support") })
      : btn(a.has_password === false ? "生成设置码…" : "生成重置码…", resetCode, { kind: "primary", disabled: !canSupport(), title: canSupport() ? undefined : needs("account.support") });
  const actions = h(
    "div",
    { class: "btn-row" },
    primary,
    locked || a.status === "disabled" ? btn("生成重置码…", resetCode, { disabled: !canSupport() || a.status === "disabled", title: canSupport() ? undefined : needs("account.support") }) : null,
    btn("全部退出登录…", signoutAll, { disabled: !canSupport() || !a.sessions_active, title: !canSupport() ? needs("account.support") : !a.sessions_active ? "没有登录会话" : undefined }),
    rowMenu([joins.length && admins.length ? { label: "生成重置码…", onClick: resetCode, disabled: !canSupport() || a.status === "disabled" } : null, { label: "个人上限…", onClick: limits, disabled: !can("account.manage"), title: needs("account.manage") }, a.status === "disabled" ? null : { label: "停用账号…", danger: true, onClick: disable, disabled: !can("account.manage"), title: needs("account.manage") }], { label: "更多", aria: "更多操作" }),
  );
  const tenantLinkEl = () => (can("tenant.read") ? h("button", { type: "button", class: "link", onclick: () => go(`tenants/${encodeURIComponent(a.tid)}`) }, a.tenant_name ?? a.tid) : h("span", {}, a.tenant_name ?? a.tid));
  clear(
    head,
    h(
      "div",
      { class: "stack" },
      pageHead(
        h("span", { class: "title-row" }, a.name || a.email || "账号", a.status === "disabled" ? badge("已停用", "neutral") : null, locked ? badge("已锁定", "warn") : null, t?.personal ? h("span", { class: "kind-tag" }, "个人客户") : null),
        metaLine(a.phone ? h("span", {}, a.phone) : null, a.email, roleText(a.role), tenantLinkEl()),
        actions,
      ),
      h(
        "div",
        { class: "head-stats" },
        h("div", { class: ["head-stat", "stat", Number(u.used_ratio) >= 1 && u.enforced ? "tone-danger" : Number(u.used_ratio) >= 0.8 ? "tone-warn" : null] }, h("span", { class: "stat-label" }, "本期用量"), h("span", { class: "stat-value num" }, fmt.pct(u.used_ratio)), h("span", { class: "stat-sub" }, DENOMINATOR[u.denominator] ?? (u.total === null ? "不单设上限" : "—"))),
        h("div", { class: ["head-stat", "stat", full && "tone-warn"] }, h("span", { class: "stat-label" }, "电脑"), h("span", { class: "stat-value num" }, `登录中 ${signedIn.length} / ${fmt.int(limit)}${full ? " · 已满" : ""}`), h("span", { class: "stat-sub" }, `同时登录上限 ${fmt.int(limit)} 台（${LIMIT_SOURCE[a.device_limit_source] ?? "上限"}）${joins.length ? ` · ${joins.length} 台待批准` : ""}`)),
        h("div", { class: "head-stat stat" }, h("span", { class: "stat-label" }, "最近登录"), h("span", { class: "stat-value num" }, a.last_login_at ? fmt.ago(a.last_login_at) : "从未"), h("span", { class: "stat-sub" }, fmt.full(a.last_login_at))),
        t?.personal
          ? h("div", { class: "head-stat stat" }, h("span", { class: "stat-label" }, "所属客户"), h("span", { class: "stat-value" }, "个人"), h("span", { class: "stat-sub" }, "一人一所，不讲席位"))
          : h("div", { class: ["head-stat", "stat"], title: "席位 = 律所可同时使用 AI 的成员名额" }, h("span", { class: "stat-label" }, "席位"), h("span", { class: "stat-value" }, d.seat && !d.seat.revoked_at ? "已占席" : "未占席"), h("span", { class: "stat-sub" }, d.seat && !d.seat.revoked_at ? "这名成员可以用 AI" : "能登录，但用不了 AI；第一次在电脑上用 AI 时自动占席")),
      ),
    ),
  );
  const devBox = h("div", { id: "acct-devices" });
  clear(
    body,
    a.disabled_reason ? h("div", { class: "banner danger" }, icon("alert"), h("span", {}, `停用原因：${a.disabled_reason}`)) : null,
    diagnosis({ a, d, t, u, live, signedIn, limit, full, locked, enable, limits }),
    add(devBox, panel("电脑", deviceTable([...devs.map((x) => ({ ...x, member_name: a.name })), ...joins.map((j) => pendingRow({ ...j, aid: a.aid, email: a.email, member_name: a.name }, { tid: a.tid, admins_text: adminText || null }))], { state: { sort: "state", asc: true }, after: reload, showTenant: false, showMember: false, onRow: false, empty: "还没有登记电脑：在客户端用这个账号登录后出现在这里" }), { flush: true, sub: "“让它退出登录”可逆，资料留在那台电脑上；“移除这台电脑”不可逆，用于丢失或不再使用" })),
    h(
      "div",
      { class: "grid-2" },
      panel(
        "本期用量",
        h(
          "div",
          { class: "stack-sm" },
          meter({ label: "个人", ratio: u.used_ratio, used: u.used, total: u.total, unit: u.unit, denominator: DENOMINATOR[u.denominator] ?? (u.total === null ? "不单设上限" : null), resetsAt: u.period?.resets_at ?? null }),
          facts([
            ["请求", fmt.int(u.requests)],
            u.value_cny !== undefined ? ["用量价值", fmt.cny(u.value_cny)] : null,
            ["个人额度上限", a.quota_limit === null || a.quota_limit === undefined ? "不单设" : fmt.amount(a.quota_limit, u.unit)],
          ]),
          u.daily?.length ? trendChart({ labels: u.daily.map((x) => x.day), series: [{ name: "用量", values: u.daily.map((x) => Number(x.used) || 0), kind: "bar" }], format: (v) => (u.unit === "cny" ? fmt.num(v, 0) : fmt.tokens(v)), tick: (l) => l.slice(5), height: 130 }) : null,
          u.by_model?.length ? hbars(u.by_model.map((m) => ({ label: m.alias, value: Number(m.used) || 0, note: `${fmt.int(m.requests)} 次` })), { format: (v) => fmt.amount(v, u.unit) }) : null,
        ),
      ),
      panel(
        "身份",
        facts([
          ["账号编号", h("span", {}, mono(a.aid), copyBtn(a.aid, "复制"))],
          ["成员标识", mono(a.member_slug ?? "—")],
          ["手机号", a.phone ?? "未绑定"],
          ["已设密码", a.has_password === true ? "是" : a.has_password === false ? badge("未设（待本人凭设置密码码设置）", "warn") : "—"],
          ["注册方式", `${CREATED_VIA[a.created_via] ?? a.created_via ?? "—"}${a.invite_id ? `（邀请码 ${a.invite_id}）` : ""}`],
          ["注册于", fmt.full(a.created_at)],
          ["席位", d.seat ? (d.seat.revoked_at ? `已收回 ${fmt.date(d.seat.revoked_at)}` : h("span", {}, "在用 ", mono(d.seat.sid))) : "无"],
          ["所属客户", tenantLinkEl()],
        ]),
      ),
    ),
    panel(
      "登录会话",
      dataTable({
        state: { sort: "last_seen_at", asc: false },
        rows: d.sessions ?? [],
        empty: "没有登录会话",
        columns: [
          { key: "kind", label: "类型", value: (s) => ({ desktop: "桌面端", web: "网页" })[s.kind] ?? s.kind },
          { key: "device_id", label: "电脑", value: (s) => s.device_id ?? "", render: (s) => { const x = devs.find((y) => y.device_id === s.device_id); return s.device_id ? h("div", { class: "cell-2" }, x?.name ?? "未命名的电脑", mono(s.device_id)) : h("span", { class: "muted" }, "未绑定电脑"); } },
          { key: "client", label: "客户端", value: (s) => `${s.client?.platform ?? ""} ${s.client?.version ?? ""}`.trim() },
          { key: "created_at", label: "登录于", value: (s) => s.created_at ?? "", render: (s) => fmt.time(s.created_at) },
          { key: "last_seen_at", label: "最近活动", value: (s) => s.last_seen_at ?? "", render: (s) => fmt.ago(s.last_seen_at) },
          { key: "idle_expires_at", label: "闲置到期", value: (s) => s.idle_expires_at ?? "", render: (s) => fmt.time(s.idle_expires_at) },
        ],
      }),
      { flush: true, sub: "一台电脑同一时间只有一个登录会话；网页控制台的登录不占电脑名额" },
    ),
    (d.alerts ?? []).length ? panel("告警", alertList(d.alerts ?? [], { onAck: reload })) : null,
  );
  if (params?.section === "devices") requestAnimationFrame(() => devBox.scrollIntoView({ block: "start" }));
}

/**
 * 登录诊断（第 71 批）：把“为什么登不上 / 用不了 AI”的原因列在一处——账号、电脑名额、客户、个人额度、待批准入组。
 * 有问题时排在最前并展开；都正常时收成一行。
 */
function diagnosis({ a, d, t, u, live, signedIn, limit, full, locked, enable, limits }) {
  const admins = d.firm_admins ?? [];
  const rows = [];
  const row = (tone, text, ...acts) => rows.push({ tone, text, acts: acts.filter(Boolean) });
  if (a.status === "disabled") row("bad", `账号已停用：不能登录${a.disabled_reason ? `（${a.disabled_reason}）` : ""}`, btn("启用…", () => enable(false), { size: "sm", disabled: !canSupport() }));
  else if (locked) row("warn", `账号已锁定：登录失败次数过多${a.locked_s ? `，约 ${Math.max(1, Math.ceil(a.locked_s / 60))} 分钟后自动解除` : ""}`, btn("解锁…", () => enable(true), { size: "sm", disabled: !canSupport() }));
  else row("ok", `账号正常${a.has_password === false ? "" : "，已设密码"}`);
  if (a.has_password === false && a.status !== "disabled") row("warn", "还没设密码：本人要先用设置密码码设置");
  if (full)
    row(
      "bad",
      `同时登录的电脑已满（登录中 ${signedIn.length} / ${limit}，${LIMIT_SOURCE[a.device_limit_source] ?? "上限"}）：新电脑登录会被拒`,
      signedIn.length ? btn("让一台退出登录…", () => pick(signedIn, "让哪台电脑退出登录？", "可逆：那台电脑上的资料保留，之后可以再登录").then((x) => x && signoutDevice({ ...x, aid: x.aid ?? a.aid }, () => ctx.reload())), { size: "sm", kind: "primary", disabled: !canSupport() }) : null,
      btn("改电脑数上限", limits, { size: "sm", disabled: !can("account.manage") }),
      btn("移除一台…", () => pick(live, "移除哪台电脑？", "不可逆：那台电脑不能再用这个账号").then((x) => x && revokeDevice(x, () => ctx.reload())), { size: "sm", kind: "ghost", class: "text-danger", disabled: !can("device.revoke") }),
    );
  else row("ok", `电脑：登录中 ${signedIn.length} / ${limit}（${LIMIT_SOURCE[a.device_limit_source] ?? "上限"}），还能再登录 ${Math.max(0, limit - signedIn.length)} 台`);
  if (t && !t.personal && !(d.seat && !d.seat.revoked_at)) row("warn", "未占席：这名成员能登录，但用不了 AI。第一次在电脑上用 AI 时自动占席；席位不够时改套餐或席位", btn("去客户详情", () => go(`tenants/${encodeURIComponent(t.tid)}?tab=people`), { size: "sm" }));
  if (t) {
    const left = t.subscription_until ? Math.ceil((Date.parse(t.subscription_until) - Date.now()) / 86_400_000) : null;
    if (t.status !== "active") row("bad", `客户${({ pending: "待开通", expired: "已到期", terminated: "已终止" })[t.status] ?? t.status}：${t.status === "pending" ? "创始开通还没完成" : "不签发席位令牌，AI 不可用"}`, btn("去客户详情", () => go(`tenants/${encodeURIComponent(t.tid)}?tab=subscription`), { size: "sm" }));
    else if (t.paused) row("bad", `客户已暂停：${PAUSED[t.paused] ?? t.paused}，全员 AI 暂停`, btn("去加量", () => go(`tenants/${encodeURIComponent(t.tid)}?tab=plan`), { size: "sm" }));
    else row("ok", `客户正常 · 订阅到 ${fmt.date(t.subscription_until)}${left !== null && left <= 30 ? `（${left} 天后到期）` : ""} · 没有暂停`);
    if (t.personal) row("info", "个人客户：新电脑直接登录即可，不需要批准（24 小时内最多登记 3 台）");
  } else if (!can("tenant.read")) row("info", "你的角色没有“查看客户”权限：这里不显示客户状态");
  if (u.enforced && Number(u.used_ratio) >= 1) row("bad", `${PAUSED.seat}：这个账号的 AI 已暂停`, btn("改个人上限", limits, { size: "sm", disabled: !can("account.manage") }));
  const joins = d.join_requests_pending ?? [];
  if (joins.length)
    row(
      "warn",
      `有 ${joins.length} 台新电脑待律所管理员批准（${joins.map((j) => fmt.time(j.created_at)).join("、")} 申请）${admins.length ? `：请联系 ${admins.map((x) => [x.name, x.phone ?? x.email].filter(Boolean).join(" ")).join("、")}，在其电脑上批准` : "：请联系律所管理员在其电脑上批准"}`,
      admins.length ? btn("复制联系方式", () => navigator.clipboard?.writeText(admins.map((x) => [x.name, x.phone, x.email].filter(Boolean).join(" ")).join("；")).then(() => toast("已复制"), () => {}), { size: "sm" }) : null,
    );
  const ICON = { bad: ["✕", "danger"], warn: ["!", "warn"], ok: ["✓", "ok"], info: ["·", "info"] };
  const list = h(
    "ul",
    { class: "diag" },
    rows
      .sort((x, y) => ["bad", "warn", "info", "ok"].indexOf(x.tone) - ["bad", "warn", "info", "ok"].indexOf(y.tone))
      .map((r) => h("li", { class: `diag-row tone-${ICON[r.tone][1]}` }, h("span", { class: "diag-icon", "aria-hidden": "true" }, ICON[r.tone][0]), h("span", { class: "diag-text" }, r.text), r.acts.length ? h("span", { class: "btn-row" }, r.acts) : null)),
  );
  const problems = rows.filter((r) => r.tone === "bad" || r.tone === "warn").length;
  return problems ? panel("登录诊断", list, { tone: "warn", sub: `发现 ${problems} 个可能阻止登录或使用 AI 的原因` }) : h("div", { class: "panel flush diag-fold" }, fold("登录诊断", "没有发现阻止登录或使用 AI 的原因", list));
}
/** 让运营在几台电脑里点选一台（按名字认，编号放后面） */
async function pick(list, title, lead) {
  if (list.length === 1) return list[0];
  const v = await confirmAction({
    title,
    lead: h("p", { class: "muted" }, lead),
    fields: [{ name: "id", label: "电脑", type: "radio", options: list.map((x) => [x.device_id, x.name || "未命名的电脑", `${x.device_id} · 客户端 ${x.client_version ?? "—"} · 最近报到 ${x.last_seen_on ? fmt.ago(x.last_seen_on) : "从未"}`]), value: list[0].device_id }],
    confirmLabel: "下一步",
  });
  return v ? list.find((x) => x.device_id === v.id) ?? null : null;
}
