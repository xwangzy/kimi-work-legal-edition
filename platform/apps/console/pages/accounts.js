/**
 * 账号：搜索邮箱 / 姓名 / 律所；状态、最近登录、设备数；详情抽屉（设备、会话、用量、个人上限）；
 * 停用 / 启用、发重置码、强制下线、解绑设备、代建账号。
 * 接口：GET /v1/ops/accounts?q&tid&status&limit&cursor、GET /v1/ops/accounts/{aid}、写操作（account.manage，契约 §3）。
 */
import * as api from "../api.js";
import { accountBadge, alertList, can, ctx, CREATED_VIA, DENOMINATOR, deviceTable, go, needs, pageHead, ROLE, roleText, tenantOptions } from "../domain.js";
import {
  badge, btn, clear, confirmAction, dataTable, errorBlock, facts, fmt, h, hbars, icon, loadingBlock, meter, mono, openDrawer, panel,
  searchInput, segmented, selectEl, showSecret, toast, trendChart,
} from "../ui.js";

/** 客服动作（解锁启用、重置码、强制下线）：账号管理或账号客服任一即可（契约 §2.2） */
const canSupport = () => can("account.manage") || can("account.support");
const st = { q: "", tid: "", status: "", table: { sort: "last_login_at", asc: false } };

export function render(page, r) {
  if (r.params.q !== undefined) st.q = r.params.q;
  if (r.params.tid !== undefined) st.tid = r.params.tid;
  const tools = h("div", { class: "toolbar" });
  const box = h("div", { class: "stack" });
  page.append(pageHead("账号", "邮箱 + 密码登录的身份；一个账号对应律所里的一名成员", btn("代建账号", () => createAccount(st.tid || null, () => ctx.reload()), { kind: "primary", icon: icon("plus"), disabled: !can("account.manage"), title: needs("account.manage") })), tools, box);
  let rows = [];
  let next = null;
  let seq = 0;
  const fetchPage = async (append) => {
    const my = ++seq;
    if (!append) clear(box, loadingBlock("正在读取账号…"));
    try {
      const res = await api.get("/v1/ops/accounts", { q: st.q, tid: st.tid, status: st.status, limit: 50, cursor: append ? next : undefined });
      if (my !== seq) return;
      rows = append ? rows.concat(res.accounts ?? []) : res.accounts ?? [];
      next = res.next ?? null;
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
        onRow: (a) => openAccount(a.aid),
        empty: st.q || st.tid || st.status ? "没有符合条件的账号" : "还没有账号",
        columns: [
          { key: "email", label: "邮箱", render: (a) => h("span", { class: "cell-email" }, a.email) },
          { key: "name", label: "姓名" },
          { key: "tenant_name", label: "律所", value: (a) => a.tenant_name ?? a.tid },
          { key: "role", label: "角色", value: (a) => roleText(a.role) },
          { key: "status", label: "状态", render: (a) => h("span", { class: "badges" }, accountBadge(a)) },
          { key: "last_login_at", label: "最近登录", value: (a) => a.last_login_at ?? "", render: (a) => h("span", { title: fmt.full(a.last_login_at) }, a.last_login_at ? fmt.ago(a.last_login_at) : "从未") },
          { key: "devices", label: "设备", num: true, value: (a) => Number(a.devices) || 0, render: (a) => `${fmt.int(a.devices)} / ${a.device_limit ?? "套餐"}` },
          { key: "sessions_active", label: "会话", num: true, class: "opt", value: (a) => Number(a.sessions_active) || 0, render: (a) => fmt.int(a.sessions_active) },
          { key: "used_ratio", label: "本期用量", num: true, value: (a) => a.used_ratio ?? null, render: (a) => (a.used_ratio === null || a.used_ratio === undefined ? h("span", { class: "muted" }, "—") : fmt.pct(a.used_ratio)) },
          { key: "created_via", label: "来源", class: "opt", value: (a) => CREATED_VIA[a.created_via] ?? a.created_via ?? "" },
          { key: "created_at", label: "注册于", class: "opt", value: (a) => a.created_at ?? "", render: (a) => fmt.date(a.created_at) },
        ],
      }),
      next ? h("div", { class: "more" }, btn("加载更多", (ev) => ((ev.currentTarget.disabled = true), fetchPage(true)))) : rows.length ? h("p", { class: "muted small center" }, `共 ${rows.length} 个`) : null,
    );
  const tSel = selectEl([["", "全部律所"]], st.tid, (v) => ((st.tid = v), fetchPage(false)), { "aria-label": "律所" });
  tenantOptions().then((opts) => {
    clear(tSel, opts.map(([v, l]) => h("option", { value: v }, l)));
    tSel.value = st.tid;
  });
  const statusSeg = h("span");
  const drawSeg = () => clear(statusSeg, segmented([{ id: "", label: "全部" }, { id: "active", label: "正常" }, { id: "disabled", label: "已停用" }], st.status, (v) => ((st.status = v), drawSeg(), fetchPage(false)), "状态"));
  drawSeg();
  tools.append(searchInput({ placeholder: "邮箱或姓名", value: st.q, onInput: (v) => ((st.q = v.trim()), fetchPage(false)), delay: 300 }), tSel, statusSeg);
  fetchPage(false);
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

/** 账号详情抽屉 */
export function openAccount(aid) {
  const body = h("div", { class: "stack" }, loadingBlock("正在读取账号…"));
  const dr = openDrawer({ title: "账号", subtitle: mono(aid), body, wide: true });
  const reload = async () => {
    clear(body, loadingBlock("正在读取账号…"));
    try {
      const d = await api.get(api.A(aid));
      draw(d);
    } catch (e) {
      clear(body, errorBlock(e, reload));
    }
  };
  const draw = (d) => {
    const a = d.account ?? {};
    const u = d.usage ?? {};
    dr.setTitle(a.name ? `${a.name}` : a.email ?? aid);
    const A = api.A(aid);
    // 第 62 批：危险操作（停用）放在最后，常用的客服动作在前
    const actions = h(
      "div",
      { class: "btn-row" },
      btn("发重置码", async () => {
        const r = await confirmAction({ title: "发密码重置码", consequences: ["生成一次性重置码（30 分钟）；本人凭码设新密码后，全部会话吊销、须重新登录。"], confirmLabel: "生成", run: () => api.post(`${A}/reset-code`) });
        if (r?.reset_code) await showSecret({ title: `重置码 · ${a.email}`, secret: r.reset_code, expiresAt: r.expires_at });
      }, { disabled: !canSupport() || a.status === "disabled", title: canSupport() ? undefined : needs("account.support") }),
      btn("强制下线", async () => {
        const r = await confirmAction({
          title: "强制下线",
          danger: true,
          consequences: [`吊销该账号全部 ${fmt.int(a.sessions_active)} 个会话；设备 15 秒内在网关暂停，本人重新登录即恢复。`],
          confirmLabel: "强制下线",
          run: () => api.post(`${A}/sessions/revoke`),
        });
        if (r) (toast(`已吊销 ${fmt.int(r.revoked)} 个会话`), reload());
      }, { disabled: !canSupport(), title: canSupport() ? undefined : needs("account.support") }),
      btn("个人上限", async () => {
        const r = await confirmAction({
          title: "个人上限",
          fields: [
            { name: "quota_limit", label: `个人额度上限（每期，${u.unit === "cny" ? "元" : "token"}）`, type: "number", min: 0, value: a.quota_limit ?? "", hint: "空 = 不单设（按套餐每席位额度显示参考比例）" },
            { name: "device_limit", label: "设备上限", type: "number", min: 1, max: 9, value: a.device_limit ?? "", hint: "空 = 按套餐（缺省 2 台）；同一账号最多 9 台；个人账号同样按此上限" },
          ],
          consequences: ["个人上限立即参与额度判定：用到上限即暂停该账号的 AI；", "设备上限只影响新设备入组，已绑定的不受影响。"],
          confirmLabel: "保存",
          run: (v) => api.post(`${A}/limits`, { quota_limit: v.quota_limit, device_limit: v.device_limit }),
        });
        if (r) (toast("已保存"), reload());
      }, { disabled: !can("account.manage"), title: needs("account.manage") }),
      a.status === "disabled"
        ? btn("启用", async () => {
            const ok = await confirmAction({ title: "启用账号", consequences: ["本人可再次登录；之前吊销的会话不恢复，须重新登录。"], confirmLabel: "启用", run: () => api.post(`${A}/enable`) });
            if (ok) (toast("已启用"), reload(), ctx.reload());
          }, { disabled: !canSupport(), title: canSupport() ? undefined : needs("account.support") })
        : btn("停用…", async () => {
            const ok = await confirmAction({
              title: `停用 ${a.email}`,
              danger: true,
              consequences: ["立即吊销该账号的全部会话：所有设备 15 秒内在网关暂停（AI 停用，本机功能照常）；", "本人不能再登录，直到运营启用；", "用量与审计记录保留。"],
              fields: [{ name: "reason", label: "停用原因（记入审计，本人可见）", type: "textarea", required: true, maxlength: 200 }],
              typeToConfirm: a.email,
              typeLabel: "再输入一次邮箱以确认：",
              confirmLabel: "停用账号",
              run: (v) => api.post(`${A}/disable`, { reason: v.reason }),
            });
            if (ok) (toast("已停用"), reload(), ctx.reload());
          }, { kind: "danger", disabled: !can("account.manage"), title: needs("account.manage") }),
    );

    clear(
      body,
      h("div", { class: "drawer-hero" }, h("div", {}, h("div", { class: "hero-email" }, a.email), h("div", { class: "badges" }, accountBadge(a), h("span", { class: "muted small" }, `${roleText(a.role)} · `, h("button", { type: "button", class: "link", onclick: () => go(`tenants/${encodeURIComponent(a.tid)}`) }, a.tenant_name ?? a.tid)))), actions),
      d.account?.disabled_reason ? h("div", { class: "banner danger" }, `停用原因：${d.account.disabled_reason}`) : null,
      panel(
        "本期用量",
        h(
          "div",
          { class: "stack-sm" },
          meter({ label: "个人", ratio: u.used_ratio, used: u.used, total: u.total, unit: u.unit, denominator: DENOMINATOR[u.denominator] ?? (u.total === null ? "不单设上限" : null), resetsAt: u.period?.resets_at ?? null }),
          facts([
            ["请求", fmt.int(u.requests)],
            ["用量价值", fmt.cny(u.value_cny)],
            ["个人上限", a.quota_limit === null || a.quota_limit === undefined ? "不单设" : fmt.amount(a.quota_limit, u.unit)],
            ["设备上限", a.device_limit ?? "按套餐"],
          ]),
          u.daily?.length ? trendChart({ labels: u.daily.map((x) => x.day), series: [{ name: "用量", values: u.daily.map((x) => Number(x.used) || 0), kind: "bar" }], format: (v) => (u.unit === "cny" ? fmt.num(v, 0) : fmt.tokens(v)), tick: (l) => l.slice(5), height: 130 }) : null,
          u.by_model?.length ? hbars(u.by_model.map((m) => ({ label: m.alias, value: Number(m.used) || 0, note: `${fmt.int(m.requests)} 次` })), { format: (v) => fmt.amount(v, u.unit) }) : null,
        ),
      ),
      panel("设备", deviceTable((d.devices ?? []).map((x) => ({ ...x, tid: x.tid ?? a.tid })), { state: {}, after: reload, showTenant: false, empty: "还没有绑定设备" }), { sub: "吊销 = 解绑：设备进吊销集、绑在上面的会话一并吊销" }),
      panel(
        "会话",
        dataTable({
          state: { sort: "last_seen_at", asc: false },
          rows: d.sessions ?? [],
          empty: "没有有效会话",
          columns: [
            { key: "sid", label: "会话", render: (s) => mono(s.sid) },
            { key: "kind", label: "类型", value: (s) => ({ desktop: "桌面端", web: "网页" })[s.kind] ?? s.kind },
            { key: "device_id", label: "设备", render: (s) => mono(s.device_id ?? "未绑定") },
            { key: "client", label: "客户端", value: (s) => `${s.client?.platform ?? ""} ${s.client?.version ?? ""}`.trim() },
            { key: "created_at", label: "登录于", value: (s) => s.created_at ?? "", render: (s) => fmt.time(s.created_at) },
            { key: "last_seen_at", label: "最近活动", value: (s) => s.last_seen_at ?? "", render: (s) => fmt.ago(s.last_seen_at) },
            { key: "idle_expires_at", label: "闲置到期", value: (s) => s.idle_expires_at ?? "", render: (s) => fmt.time(s.idle_expires_at) },
          ],
        }),
      ),
      panel("告警", alertList(d.alerts ?? [], { onAck: reload })),
      facts([
        ["账号编号", mono(a.aid)],
        ["成员标识", mono(a.member_slug ?? "—")],
        ["已设密码", a.has_password === true ? "是" : a.has_password === false ? badge("未设（待本人凭设置密码码设置）", "warn") : "—"],
        ["注册方式", CREATED_VIA[a.created_via] ?? a.created_via],
        ["注册于", fmt.full(a.created_at)],
        ["最近登录", fmt.full(a.last_login_at)],
      ]),
    );
  };
  reload();
}
