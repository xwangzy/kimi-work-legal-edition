/**
 * 客户（律所 / 租户）：列表（套餐、席位、本期用量%、预计用完日、到期、状态）→ 详情二级页
 * （概览、成员与账号、设备、用量、套餐与额度、账单、开通与订阅、操作记录）。
 * 接口：GET /v1/ops/tenants、POST /v1/ops/tenants、GET /v1/ops/tenants/{tid} 及其写操作（契约 §2）；操作记录取 GET /v1/ops/system 的 access_log。
 */
import * as api from "../api.js";
import { can, ctx, deviceTable, go, needs, pageHead, periodText, roleText, tenantBadge } from "../domain.js";
import {
  add, badge, btn, clear, confirmAction, copyBtn, dangerZone, dataTable, emptyBlock, facts, fmt, h, hbars, icon, load, matches, metaLine, meter, mono, note, panel,
  periodBars, searchInput, segmented, showSecret, stat, tabBar, toast, trendChart,
} from "../ui.js";

const st = { filter: "all", q: "", table: { sort: "used_ratio", asc: false }, tab: "overview", memberTable: {}, devTable: {}, acctTable: {} };
const DAY = 86_400_000;

const FILTERS = [
  ["all", "全部", () => true],
  ["attention", "需关注", (t) => t.status === "active" && (Number(t.alerts_open) > 0 || Number(t.used_ratio) >= 0.8 || !!t.paused || (t.forecast_exhaust_at && Date.parse(t.forecast_exhaust_at) < Date.parse(t.period?.resets_at ?? "")))],
  ["paused", "已暂停", (t) => !!t.paused],
  ["pending", "待开通", (t) => t.status === "pending"],
  // 与总览“30 天内到期”同一口径（控制面 overview.tenants.expiring_30d：到期日在今后 30 天内，不论是否已完成开通）
  ["expiring", "30 天内到期", (t) => t.status !== "terminated" && !!t.subscription_until && Date.parse(t.subscription_until) > Date.now() && Date.parse(t.subscription_until) - Date.now() < 30 * DAY],
  ["closed", "已到期 / 终止", (t) => t.status === "expired" || t.status === "terminated"],
];

export function render(page, r) {
  if (r.arg) return renderDetail(page, r.arg, r.params);
  if (r.params.q !== undefined) st.q = r.params.q;
  // 总览的信号点进来带 ?filter=attention|pending|expiring
  if (r.params.filter && FILTERS.some(([id]) => id === r.params.filter)) st.filter = r.params.filter;
  const box = h("div", { class: "stack" });
  page.append(
    pageHead("客户", "开通的律所、套餐与本期用量；点一行看详情", btn("开通律所", () => createTenant(), { kind: "primary", icon: icon("plus"), disabled: !can("tenant.manage"), title: needs("tenant.manage") })),
    box,
  );
  load(box, () => api.get("/v1/ops/tenants"), (d) => drawList(box, d.tenants ?? []), "正在读取律所…");
}

function drawList(box, rows) {
  ctx.tenants = rows.map((t) => ({ tid: t.tid, name: t.name ?? t.tid }));
  const tableBox = h("div");
  const counts = Object.fromEntries(FILTERS.map(([id, , f]) => [id, rows.filter(f).length]));
  const seg = h("span");
  const redraw = () => {
    const f = FILTERS.find((x) => x[0] === st.filter)?.[2] ?? (() => true);
    const list = rows.filter((t) => f(t) && matches(st.q, t.name, t.tid, t.plan?.label));
    clear(seg, segmented(FILTERS.map(([id, label]) => ({ id, label, count: counts[id] })), st.filter, (id) => ((st.filter = id), redraw()), "筛选"));
    clear(
      tableBox,
      dataTable({
        state: st.table,
        rows: list,
        onRow: (t) => go(`tenants/${encodeURIComponent(t.tid)}`),
        empty: rows.length ? "没有符合条件的律所" : "还没有开通律所",
        rowClass: (t) => (t.paused ? "danger-row" : FILTERS[1][2](t) ? "flagged" : t.status === "terminated" || t.status === "expired" ? "dim" : ""),
        caption: "律所列表",
        columns: [
          { key: "name", label: "律所", render: (t) => h("div", { class: "cell-2" }, h("b", {}, t.name ?? t.tid), mono(t.tid)) },
          { key: "plan", label: "套餐", class: "nowrap", value: (t) => t.plan?.label ?? "", render: (t) => h("div", { class: "cell-2" }, t.plan?.label ?? t.plan?.id ?? "—", h("small", {}, t.edition === "firm" ? "律所版" : t.edition === "team" ? "团队版" : "")) },
          { key: "seats", label: "席位", num: true, value: (t) => Number(t.seats) || 0, render: (t) => `${fmt.int(t.seats_used)} / ${fmt.int(t.seats)}` },
          { key: "used_ratio", label: "本期用量", value: (t) => Number(t.used_ratio) || 0, class: "col-meter", render: (t) => meter({ ratio: t.used_ratio, used: t.used, total: t.total, unit: t.unit, resetsAt: t.period?.resets_at, inflight: t.in_flight_ratio, capPct: t.cap_pct, paused: t.paused, compact: true }) },
          {
            key: "forecast_exhaust_at",
            label: "预计用完",
            class: "nowrap",
            value: (t) => (t.forecast_exhaust_at ? Date.parse(t.forecast_exhaust_at) : null),
            render: (t) => (t.forecast_exhaust_at ? h("span", { class: Date.parse(t.forecast_exhaust_at) < Date.parse(t.period?.resets_at ?? "") ? "tone-text-warn" : "" }, fmt.date(t.forecast_exhaust_at)) : h("span", { class: "muted" }, "本期内不会")),
          },
          { key: "value_cny", label: "用量价值", num: true, class: "opt", value: (t) => t.value_cny ?? null, render: (t) => fmt.cny(t.value_cny) },
          { key: "accounts", label: "账号 / 设备", num: true, class: "opt", value: (t) => Number(t.accounts) || 0, render: (t) => `${fmt.int(t.accounts)} / ${fmt.int(t.devices)}` },
          {
            key: "subscription_until",
            label: "到期",
            class: "nowrap",
            value: (t) => (t.subscription_until ? Date.parse(t.subscription_until) : null),
            render: (t) => {
              const left = t.subscription_until ? Math.ceil((Date.parse(t.subscription_until) - Date.now()) / DAY) : null;
              return h("div", { class: "cell-2" }, fmt.date(t.subscription_until), left !== null && left <= 30 && left >= 0 ? h("small", { class: "tone-text-warn" }, `${left} 天后`) : null);
            },
          },
          { key: "status", label: "状态", class: "nowrap", value: (t) => (Number(t.alerts_open) || 0) * 10 + ({ active: 1, pending: 2, expired: 3, terminated: 4 }[t.status] ?? 0), render: (t) => h("span", { class: "badges" }, tenantBadge(t.status), Number(t.alerts_open) > 0 ? badge(`${t.alerts_open} 告警`, "warn") : null) },
        ],
      }),
    );
  };
  clear(
    box,
    h("div", { class: "toolbar" }, seg, searchInput({ placeholder: "律所名称或编号", value: st.q, onInput: (v) => ((st.q = v), redraw()) }), h("span", { class: "toolbar-count" }, `共 ${rows.length} 家`)),
    tableBox,
  );
  redraw();
}

async function planOptions() {
  try {
    const r = await api.get("/v1/ops/plans");
    return { options: (r.plans ?? []).map((p) => [p.id, `${p.label ?? p.id}${p.seat_price_cny ? ` · ¥${p.seat_price_cny}/席` : ""}`]), def: r.default_plan ?? r.plans?.[0]?.id };
  } catch {
    return { options: [], def: "" };
  }
}

async function createTenant() {
  const { options, def } = await planOptions();
  const r = await confirmAction({
    title: "开通律所",
    lead: h("p", {}, "开通后在“开通与订阅”里发创始开通码给律所负责人；本批之后开通的律所缺省要求账号登录。"),
    fields: [
      { name: "tid", label: "租户编号", required: true, placeholder: "ten_example", pattern: "ten_[a-z0-9_-]{2,40}", hint: "ten_ 开头，小写字母、数字、下划线；开通后不可改" },
      { name: "name", label: "律所名称", required: true, maxlength: 60 },
      options.length ? { name: "plan", label: "套餐", type: "select", options, value: def } : { name: "plan", label: "套餐编号", value: "standard", hint: "套餐目录接口未就绪：手填套餐编号" },
      { name: "seats", label: "席位数", type: "number", min: 1, max: 5000, value: 5, required: true },
      { name: "subscription_days", label: "订阅天数", type: "number", min: 1, max: 3660, value: 365, required: true },
      { name: "edition", label: "版本", type: "radio", options: [["team", "团队版", "30 人以内"], ["firm", "律所版"]], value: "team" },
      { name: "accounts_required", label: "要求账号登录", type: "checkbox", value: true, hint: "开：设备须有有效的账号会话才拿得到席位令牌" },
    ],
    validate: (v) => (!/^ten_[a-z0-9_-]{2,40}$/.test(v.tid) ? "租户编号须为 ten_ 加 2–40 位小写字母、数字、下划线或连字符" : !(v.seats >= 1) ? "席位数至少 1" : null),
    confirmLabel: "开通",
    run: (v) => api.post("/v1/ops/tenants", { tid: v.tid, name: v.name, plan: v.plan, seats: v.seats, subscription_days: v.subscription_days, edition: v.edition ?? "team", accounts_required: v.accounts_required }),
  });
  if (r) {
    toast("已开通");
    ctx.tenants = null;
    go(`tenants/${encodeURIComponent(r.tenant?.tid ?? "")}`);
  }
}

// ─── 详情 ──────────────────────────────────────────────────────────
const TABS = [
  ["overview", "概览"],
  ["members", "成员与账号"],
  ["devices", "设备"],
  ["usage", "用量"],
  ["quota", "套餐与额度"],
  ["bill", "账单"],
  ["onboarding", "开通与订阅"],
  ["log", "操作记录"],
];

/** 开通码状态（控制面：open / claimed / consumed / revoked；过期由 expires_at 判断）→ [中文, 色调]，不把英文状态码露给运营 */
const actExpired = (a) => Number.isFinite(Date.parse(a.expires_at ?? "")) && Date.parse(a.expires_at) <= Date.now();
function actStatus(a) {
  if (a.status === "consumed" || a.status === "used") return ["已使用", "ok"];
  if (a.status === "revoked") return ["已作废", "neutral"];
  if (a.status === "expired" || actExpired(a)) return ["已过期", "neutral"];
  if (a.status === "claimed") return ["已领取，待完成开通", "info"];
  if (a.status === "open" || a.status === "pending") return ["待使用", "info"];
  return ["状态未知", "neutral"];
}

function renderDetail(page, tid, params) {
  if (params.tab && TABS.some((t) => t[0] === params.tab)) st.tab = params.tab;
  const head = h("div");
  const body = h("div", { class: "stack" });
  page.append(h("button", { type: "button", class: "back link", onclick: () => go("tenants") }, icon("back"), "客户"), head, body);
  const reload = () => load(body, () => api.get(api.T(tid)), (d) => drawDetail(head, body, d, reload), "正在读取律所详情…");
  reload();
}

function drawDetail(head, body, d, reload) {
  const t = d.tenant ?? {};
  const left = t.subscription_until ? Math.ceil((Date.parse(t.subscription_until) - Date.now()) / DAY) : null;
  const usedTone = t.paused || Number(t.used_ratio) >= 1 ? "danger" : Number(t.used_ratio) >= 0.8 ? "warn" : undefined;
  clear(
    head,
    h(
      "div",
      { class: "stack" },
      pageHead(
        h("span", { class: "title-row" }, t.name ?? t.tid, tenantBadge(t.status), t.paused ? badge(({ cap: "已到上限", allowance: "额度用完", burst: "5 小时频率限制已满" })[t.paused] ?? "已暂停", "danger") : null, Number(t.alerts_open) > 0 ? badge(`${t.alerts_open} 条告警`, "warn") : null),
        metaLine(h("span", {}, mono(t.tid), copyBtn(t.tid, "复制编号")), `${t.plan?.label ?? "—"}套餐`, t.edition === "firm" ? "律所版" : "团队版", `开通于 ${fmt.date(t.created_at)}`),
      ),
      // 关键数字：本期用量、席位、到期、本期金额——进详情先看到这四个
      h(
        "div",
        { class: "head-stats" },
        h("div", { class: ["head-stat", "stat", usedTone && `tone-${usedTone}`] }, h("span", { class: "stat-label" }, "本期用量"), h("span", { class: "stat-value num" }, fmt.pct(t.used_ratio)), h("span", { class: "stat-sub" }, [t.used !== undefined && t.total !== undefined ? `${fmt.amount(t.used, t.unit)} / ${fmt.amount(t.total, t.unit)}` : null, t.forecast_exhaust_at ? `预计 ${fmt.date(t.forecast_exhaust_at)} 用完` : fmt.resetLine(t.period?.resets_at)].filter(Boolean).join(" · "))),
        h("div", { class: "head-stat stat" }, h("span", { class: "stat-label" }, "席位"), h("span", { class: "stat-value num" }, `${fmt.int(t.seats_used)} / ${fmt.int(t.seats)}`), h("span", { class: "stat-sub" }, `账号 ${fmt.int(t.accounts)} · 设备 ${fmt.int(t.devices)}`)),
        h("div", { class: ["head-stat", "stat", left !== null && left <= 30 && "tone-warn"] }, h("span", { class: "stat-label" }, "订阅到期"), h("span", { class: "stat-value num" }, fmt.date(t.subscription_until)), h("span", { class: "stat-sub" }, left === null ? "—" : left < 0 ? `已过期 ${-left} 天` : `还有 ${left} 天`)),
        h("div", { class: "head-stat stat" }, h("span", { class: "stat-label" }, "本期用量价值"), h("span", { class: "stat-value num" }, fmt.cny(t.value_cny)), h("span", { class: "stat-sub" }, `成本 ${fmt.cny(t.cost_cny)} · ${fmt.int(t.requests)} 次请求`)),
      ),
    ),
  );
  const tabBox = h("div");
  const drawTabs = () =>
    clear(
      tabBox,
      tabBar(
        TABS.filter(([id]) => id !== "log" || can("system.read")).map(([id, label]) => ({ id, label, count: id === "members" ? d.members?.length : id === "devices" ? d.devices?.length : undefined })),
        st.tab,
        (id) => ((st.tab = id), drawTabs(), drawPane()),
      ),
    );
  const pane = h("div", { class: "stack" });
  const drawPane = () => {
    clear(pane);
    const fn = { overview: paneOverview, members: paneMembers, devices: paneDevices, usage: paneUsage, quota: paneQuota, bill: paneBill, onboarding: paneOnboarding, log: paneLog }[st.tab];
    fn(pane, d, reload);
  };
  clear(body, tabBox, pane);
  drawTabs();
  drawPane();
}

function paneOverview(pane, d) {
  const t = d.tenant ?? {};
  const u = d.usage ?? {};
  add(
    pane,
    h(
      "div",
      { class: "grid-2" },
      panel(
        "本期额度",
        h(
          "div",
          { class: "stack-sm" },
          meter({ label: "律所本期", ratio: t.used_ratio, used: t.used, total: t.total, unit: t.unit, resetsAt: t.period?.resets_at, inflight: t.in_flight_ratio, capPct: t.cap_pct, paused: t.paused }),
          u.burst ? meter({ label: `任意 ${u.burst.hours} 小时窗口`, ratio: u.burst.used_ratio, unit: t.unit, resetText: `滚动窗口：任意 ${u.burst.hours} 小时内至多用本期总额度的一定比例，按小时桶滑动` }) : null,
          facts([
            ["单位", fmt.unit(t.unit)],
            ["周期", periodText(t.period)],
            ["上限", t.cap_pct ? `${t.cap_pct}%（用到即暂停）` : "未设"],
            ["加量", t.boost_pct ? `+${t.boost_pct}%` : "无"],
            ["预计用完", t.forecast_exhaust_at ? fmt.full(t.forecast_exhaust_at) : "本期内不会"],
            Number(t.legacy_used_ratio) > 0 ? ["旧计量", `${fmt.pct(t.legacy_used_ratio)}（迁移前本期已用比例，已计入）`] : null,
          ]),
        ),
      ),
      panel(
        "基本信息",
        facts([
          ["租户编号", mono(t.tid)],
          ["状态", tenantBadge(t.status)],
          ["套餐", `${t.plan?.label ?? "—"}（${t.plan?.id ?? "—"}）`],
          ["席位", `${fmt.int(t.seats_used)} 在用 / ${fmt.int(t.seats)}`],
          ["账号 / 设备", `${fmt.int(t.accounts)} / ${fmt.int(t.devices)}`],
          ["要求账号登录", t.accounts_required === true ? badge("是", "ok") : t.accounts_required === false ? badge("否（旧租户）", "warn") : "—"],
          ["开通于", `${fmt.full(t.created_at)}${t.created_via ? `（${({ ops: "运营开通", self: "自助注册", founder_code: "开通码" })[t.created_via] ?? t.created_via}）` : ""}`],
          ["律所根", t.root_enrolled === true ? badge("已登记", "ok") : t.root_enrolled === false ? badge("未登记（创始开通未完成）", "warn") : "—"],
          ["订阅到期", fmt.full(t.subscription_until)],
          ["未确认告警", fmt.int(t.alerts_open)],
          ["本期请求", fmt.int(t.requests)],
          ["本期用量价值 / 成本", `${fmt.cny(t.value_cny)} / ${fmt.cny(t.cost_cny)}`],
        ]),
      ),
    ),
    u.daily?.length ? panel("本期每日用量", trendChart({ labels: u.daily.map((x) => x.day), series: [{ name: `用量（${fmt.unit(u.unit)}）`, values: u.daily.map((x) => Number(x.used) || 0), kind: "bar" }], format: (v) => (u.unit === "cny" ? fmt.cny(v, 0) : fmt.tokens(v)), tick: (l) => l.slice(5), height: 160 })) : null,
  );
}

function paneMembers(pane, d, reload) {
  const t = d.tenant ?? {};
  pane.append(
    h(
      "div",
      { class: "toolbar" },
      h("p", { class: "muted small" }, "成员与律所根签发的设备证书一一对应；账号是邮箱 + 密码登录的身份。"),
      btn("为本所代建账号", () => import("./accounts.js").then((m) => m.createAccount(t.tid, reload)), { icon: icon("plus"), disabled: !can("account.manage"), title: needs("account.manage") }),
    ),
    dataTable({
      state: st.memberTable,
      rows: d.members ?? [],
      empty: "还没有成员（律所负责人用开通码完成创始开通后出现）",
      columns: [
        { key: "member_slug", label: "成员", render: (m) => mono(m.member_slug ?? m.uid) },
        { key: "name", label: "姓名", value: (m) => m.name ?? "" },
        { key: "email", label: "账号", value: (m) => m.email ?? "", render: (m) => (m.aid ? h("button", { type: "button", class: "link", onclick: () => ctx.openAccount(m.aid) }, m.email ?? m.aid) : h("span", { class: "muted" }, "未建账号")) },
        { key: "role", label: "角色", value: (m) => roleText(m.role) },
        { key: "seat", label: "席位", value: (m) => (m.seat ? (m.seat.revoked_at ? 1 : 2) : 0), render: (m) => (m.seat ? h("span", { class: "cell-2" }, mono(m.seat.sid), m.seat.revoked_at ? h("small", {}, `已收回 ${fmt.date(m.seat.revoked_at)}`) : h("small", {}, "在用")) : h("span", { class: "muted" }, "无")) },
        { key: "devices", label: "设备", num: true, value: (m) => Number(m.devices) || 0 },
        {
          key: "_act",
          label: "",
          sortable: false,
          class: "act",
          render: (m) =>
            m.seat && !m.seat.revoked_at
              ? btn("收回席位", async () => {
                  const ok = await confirmAction({
                    title: "收回席位",
                    danger: true,
                    lead: h("p", {}, `${t.name ?? t.tid} · ${m.name ?? m.member_slug}`),
                    consequences: ["该成员的席位令牌不再续签，到期后不能用 AI；本机功能照常；", "席位空出可分给别人；用量记录保留。"],
                    confirmLabel: "收回",
                    run: () => api.post(`${api.T(t.tid)}/seats/${api.seg(m.uid)}/revoke`),
                  });
                  if (ok) (toast("已收回席位"), reload());
                }, { size: "sm", kind: "danger", disabled: !can("device.revoke"), title: needs("device.revoke") })
              : null,
        },
      ],
    }),
  );
}

function paneDevices(pane, d, reload) {
  pane.append(deviceTable((d.devices ?? []).map((x) => ({ ...x, tid: x.tid ?? d.tenant?.tid })), { state: st.devTable, after: reload, showTenant: false, empty: "还没有登记设备" }));
}

function paneUsage(pane, d) {
  const t = d.tenant ?? {};
  const u = d.usage;
  if (!u) return pane.append(emptyBlock("暂时没有这家律所的用量明细", "控制面没有返回用量数据；稍后点右上角刷新再看"));
  add(
    pane,
    Number(u.unreconciled_leases) > 0 ? h("div", { class: "banner warn" }, `有 ${u.unreconciled_leases} 份网关租约到期未对账：网关可能掉线，这部分用量还没回报。`) : null,
    h(
      "div",
      { class: "grid-2" },
      panel("本期", h("div", { class: "stack-sm" }, meter({ label: "律所本期", ratio: u.used_ratio, used: u.used, total: u.total, unit: u.unit, resetsAt: u.period?.resets_at ?? t.period?.resets_at, capPct: t.cap_pct, inflight: t.in_flight_ratio }), u.burst ? meter({ label: `任意 ${u.burst.hours} 小时窗口`, ratio: u.burst.used_ratio, unit: u.unit, resetText: `滚动窗口：任意 ${u.burst.hours} 小时内，按小时桶滑动` }) : null)),
      panel("历史周期", periodBars(u.history ?? []), { sub: "每期已用比例；标“旧”的是旧计量" }),
    ),
    panel(
      "每日",
      u.daily?.length
        ? trendChart({ labels: u.daily.map((x) => x.day), series: [{ name: `用量（${fmt.unit(u.unit)}）`, values: u.daily.map((x) => Number(x.used) || 0), kind: "bar" }, { name: "请求", values: u.daily.map((x) => Number(x.requests) || 0), kind: "line", cls: "s-warn" }], format: (v) => (u.unit === "cny" ? fmt.num(v, 0) : fmt.tokens(v)), tick: (l) => l.slice(5), height: 170 })
        : emptyBlock("本期还没有用量"),
    ),
    h(
      "div",
      { class: "grid-1-2" },
      panel("按模型", hbars((u.by_model ?? []).map((m) => ({ label: m.alias, value: Number(m.used) || 0, note: `${fmt.int(m.requests)} 次` })), { format: (v) => fmt.amount(v, u.unit), empty: "本期还没有模型用量" })),
      panel(
        "按账号",
        dataTable({
          state: st.acctTable,
          rows: u.by_account ?? [],
          empty: "本期还没有账号用量",
          columns: [
            { key: "email", label: "账号", value: (x) => x.email ?? x.uid, render: (x) => (x.aid ? h("button", { type: "button", class: "link", onclick: () => ctx.openAccount(x.aid) }, x.email ?? x.aid) : h("span", { class: "cell-2" }, mono(x.uid), h("small", {}, "未关联账号"))) },
            { key: "name", label: "姓名" },
            { key: "used", label: "用量", num: true, value: (x) => Number(x.used) || 0, render: (x) => fmt.amount(x.used, u.unit) },
            { key: "used_ratio_of_firm", label: "占律所额度", title: "本期用量 ÷ 律所本期总额度", num: true, value: (x) => Number(x.used_ratio_of_firm) || 0, render: (x) => fmt.pct(x.used_ratio_of_firm) },
            { key: "own_ratio", label: "占个人额度", num: true, value: (x) => x.own_ratio ?? null, render: (x) => (x.own_ratio === null || x.own_ratio === undefined ? h("span", { class: "muted" }, "不单设") : fmt.pct(x.own_ratio)) },
            { key: "requests", label: "请求", num: true, value: (x) => Number(x.requests) || 0, render: (x) => fmt.int(x.requests) },
          ],
        }),
      ),
    ),
  );
}

function paneQuota(pane, d, reload) {
  const t = d.tenant ?? {};
  const T = api.T(t.tid);
  const planBox = h("div");
  planOptions().then(({ options }) => {
    clear(
      planBox,
      facts([
        ["套餐", `${t.plan?.label ?? "—"}（${t.plan?.id ?? "—"}）`],
        ["席位", `${fmt.int(t.seats)}（在用 ${fmt.int(t.seats_used)}）`],
        ["单位", fmt.unit(t.unit)],
      ]),
      btn("改套餐或席位", async () => {
        const r = await confirmAction({
          title: "改套餐或席位",
          fields: [options.length ? { name: "plan", label: "套餐", type: "select", options, value: t.plan?.id } : { name: "plan", label: "套餐编号", value: t.plan?.id ?? "" }, { name: "seats", label: "席位数", type: "number", min: 1, value: t.seats, hint: `不得少于在用席位（${fmt.int(t.seats_used)}）` }],
          consequences: ["本期额度即刻按新套餐 × 席位重算（已用量不变，百分比随之变化）；", "席位费从本期起按新价计入账单；许可随席位数重签。"],
          confirmLabel: "保存",
          run: (v) => api.post(`${T}/plan`, { ...(v.plan && v.plan !== t.plan?.id ? { plan: v.plan } : {}), ...(v.seats !== null && v.seats !== t.seats ? { seats: v.seats } : {}) }),
        });
        if (r) (toast("已更新套餐与席位"), reload());
      }, { disabled: !can("quota.manage"), title: needs("quota.manage") }),
    );
  });
  pane.append(
    h(
      "div",
      { class: "grid-2" },
      panel("套餐与席位", planBox),
      panel(
        "加量包",
        h(
          "div",
          { class: "stack-sm" },
          h("p", { class: "muted small" }, `本期已加量 ${t.boost_pct ? `+${t.boost_pct}%` : "0"}。加量按本期总额度的百分比，加量费 = 席位费 × 加量% × 套餐系数，计入本期账单。`),
          h(
            "div",
            { class: "btn-row" },
            [25, 50, 100].map((p) =>
              btn(`+${p}%`, async () => {
                const r = await confirmAction({
                  title: `加量 ${p}%`,
                  lead: h("p", {}, `${t.name ?? t.tid} 本期总额度增加 ${p}%。`),
                  consequences: [`本期可用额度变为原来的 ${(100 + (Number(t.boost_pct) || 0) + p) / 100} 倍；`, "加量费计入本期账单，下期自动失效。"],
                  confirmLabel: "加量",
                  run: () => api.post(`${T}/boost`, { pct: p }),
                });
                if (r) (toast(`已加量 ${p}%`), reload());
              }, { disabled: !can("quota.manage"), title: needs("quota.manage") }),
            ),
          ),
        ),
      ),
      panel(
        "上限",
        h(
          "div",
          { class: "stack-sm" },
          h("p", { class: "muted small" }, t.cap_pct ? `当前上限 ${t.cap_pct}%：律所用到本期额度的 ${t.cap_pct}% 即暂停。运营只能调低；调高或取消须律所管理员在客户端操作。` : "律所未设上限。运营可代设（只能设低于 100%）。"),
          btn("代设上限", async () => {
            const r = await confirmAction({
              title: "代设上限",
              fields: [{ name: "cap_pct", label: "上限（%）", type: "number", min: 1, max: t.cap_pct || 99, value: t.cap_pct || 90, required: true }],
              consequences: ["律所用到这个比例即暂停 AI（本机功能照常）；", "律所管理员能在客户端看到是运营设的，可自行调整。"],
              validate: (v) => (!(v.cap_pct >= 1 && v.cap_pct <= (t.cap_pct || 99)) ? `须在 1–${t.cap_pct || 99} 之间` : null),
              confirmLabel: "设上限",
              run: (v) => api.post(`${T}/cap`, { cap_pct: v.cap_pct }),
            });
            if (r) (toast("已设上限"), reload());
          }, { disabled: !can("quota.cap"), title: needs("quota.cap") }),
        ),
      ),
      panel(
        "账号闸",
        h(
          "div",
          { class: "stack-sm" },
          h("p", { class: "muted small" }, t.accounts_required ? "已开：设备须有有效的账号会话才拿得到席位令牌；退出登录、停用账号、解绑设备 15 秒内在网关生效。" : "未开（旧租户）：设备证书即可拿席位令牌，不看账号会话。"),
          btn(t.accounts_required ? "关闭账号闸" : "打开账号闸", async () => {
            const next = !t.accounts_required;
            const r = await confirmAction({
              title: next ? "打开账号闸" : "关闭账号闸",
              danger: next,
              consequences: next
                ? ["还没用账号登录的设备，下次续签席位令牌时被拒（AI 暂停，本机功能照常），律师在客户端登录后恢复；", "先确认律所成员都已建好账号。"]
                : ["设备不再需要账号会话即可拿席位令牌；", "停用账号、退出登录将不再能停掉这家律所的 AI 调用。"],
              typeToConfirm: next ? t.tid : undefined,
              confirmLabel: next ? "打开" : "关闭",
              run: () => api.post(`${T}/accounts-required`, { required: next }),
            });
            if (r) (toast(next ? "已打开账号闸" : "已关闭账号闸"), reload());
          }, { kind: t.accounts_required ? "danger" : undefined, disabled: !can("tenant.manage"), title: needs("tenant.manage") }),
        ),
      ),
    ),
  );
}

function paneBill(pane, d) {
  const b = d.bill;
  if (!b) return pane.append(emptyBlock("控制面没有给出本期账单", "BillRow 字段缺失"));
  pane.append(
    h("div", { class: "kpis" }, stat("本期应收", fmt.cny(b.revenue_cny), `席位费 ${fmt.cny(b.seat_fee_cny)} + 加量费 ${fmt.cny(b.boost_fee_cny)}`), stat("用量价值", fmt.cny(b.value_cny)), stat("模型成本", fmt.cny(b.cost_cny)), stat("毛利", fmt.cny(b.margin_cny), undefined, { tone: Number(b.margin_cny) < 0 ? "danger" : undefined })),
    panel(
      "明细",
      facts([
        ["套餐", b.plan?.label ?? "—"],
        ["席位 × 单价", `${fmt.int(b.seats)} × ${fmt.cny(b.seat_price_cny)}`],
        ["席位费", fmt.cny(b.seat_fee_cny)],
        ["加量", b.boost_pct ? `+${b.boost_pct}%` : "无"],
        ["加量费", fmt.cny(b.boost_fee_cny)],
        ["请求 / token", `${fmt.int(b.requests)} 次 / ${fmt.tokens(b.tokens)}`],
      ]),
      { actions: btn("去计费页", () => go("billing"), { size: "sm" }) },
    ),
  );
}

function paneOnboarding(pane, d, reload) {
  const t = d.tenant ?? {};
  const T = api.T(t.tid);
  add(
    pane,
    panel(
      "开通码",
      dataTable({
        state: {},
        rows: d.activation_codes ?? [],
        empty: "还没有发过开通码",
        columns: [
          { key: "id", label: "编号", render: (a) => mono(a.id) },
          { key: "kind", label: "类型", value: (a) => ({ founder: "创始开通", member: "成员邀请" })[a.kind] ?? a.kind },
          { key: "member_slug", label: "成员", render: (a) => mono(a.member_slug ?? "—") },
          { key: "status", label: "状态", class: "nowrap", value: (a) => actStatus(a)[0], render: (a) => badge(...actStatus(a)) },
          { key: "created_at", label: "发出", value: (a) => a.created_at ?? "", render: (a) => fmt.time(a.created_at) },
          { key: "expires_at", label: "有效至", value: (a) => a.expires_at ?? "", render: (a) => fmt.time(a.expires_at) },
          {
            key: "_act",
            label: "",
            sortable: false,
            class: "act",
            render: (a) =>
              ["open", "pending", "claimed"].includes(a.status) && !actExpired(a) && a.kind === "founder"
                ? btn("作废", async () => {
                    const ok = await confirmAction({ title: "作废开通码", danger: true, consequences: ["这个码立即不能再用；已完成的开通不受影响。"], confirmLabel: "作废", run: () => api.post(`${T}/activation-codes/${api.seg(a.id)}/revoke`) });
                    if (ok) (toast("已作废"), reload());
                  }, { size: "sm", kind: "danger", disabled: !can("activation.issue"), title: needs("activation.issue") })
                : null,
          },
        ],
      }),
      {
        actions: btn("发创始开通码", async () => {
          const r = await confirmAction({
            title: "发创始开通码",
            lead: h("p", {}, "给律所负责人：凭码注册即为本所创始管理员。码只显示一次。"),
            fields: [{ name: "member_slug", label: "成员标识（可空）", placeholder: "如 zhang.wei", hint: "小写字母、数字、点；空 = 负责人注册时自填" }],
            confirmLabel: "发码",
            run: (v) => api.post(`${T}/activation-codes`, v.member_slug ? { member_slug: v.member_slug } : {}),
          });
          if (r?.code) {
            await showSecret({ title: "创始开通码", secret: r.code, expiresAt: r.expires_at, note: `开通编号 ${r.activation_id ?? ""}` });
            reload();
          }
        }, { kind: "primary", disabled: !can("activation.issue"), title: needs("activation.issue") }),
      },
    ),
    panel(
        "订阅",
        h(
          "div",
          { class: "stack-sm" },
          facts([["到期", fmt.full(t.subscription_until)], ["状态", tenantBadge(t.status)]]),
          btn("续订", async () => {
            const r = await confirmAction({
              title: "续订",
              fields: [{ name: "days", label: "续订天数", type: "number", min: 1, max: 3660, value: 365, required: true }],
              consequences: ["从当前到期日（已到期则从今天）往后顺延；许可重签。"],
              confirmLabel: "续订",
              run: (v) => api.post(`${T}/renew`, { days: v.days }),
            });
            if (r) (toast("已续订"), reload());
          }, { disabled: !can("tenant.manage") || t.status === "terminated", title: needs("tenant.manage") }),
        ),
      ),
    dangerZone("危险操作", [
      {
        title: "终止订阅",
        desc: "终止后这家律所的许可立即失效：不签发席位令牌、不发放额度。律所本机数据不受影响；不可撤销。",
        action: btn("终止订阅…", async () => {
            const r = await confirmAction({
              title: `终止 ${t.name ?? t.tid} 的订阅`,
              danger: true,
              consequences: ["许可立即失效：全所设备拿不到席位令牌，AI 全部停用（约 15 秒内在网关生效）；", "本期账单照常出；用量记录保留；", "不可撤销：恢复须重新开通。"],
              typeToConfirm: t.tid,
              typeLabel: "再输入一次租户编号以确认：",
              confirmLabel: "终止订阅",
              run: () => api.post(`${T}/terminate`),
            });
            if (r) (toast("已终止"), reload());
          }, { kind: "danger", disabled: !can("tenant.terminate") || t.status === "terminated", title: needs("tenant.terminate") }),
      },
    ]),
  );
}

function paneLog(pane, d) {
  const t = d.tenant ?? {};
  const box = h("div");
  pane.append(panel("操作记录", box, { sub: "运营访问记录（最近 100 条）中与本所相关的" }));
  load(box, () => api.get("/v1/ops/system"), (s) => {
    const rows = (s.access_log ?? []).filter((x) => x.tid === t.tid);
    box.append(
      dataTable({
        state: { sort: "at", asc: false },
        rows,
        empty: "最近 100 条运营访问里没有这家律所",
        columns: [
          { key: "at", label: "时间", render: (x) => fmt.full(x.at) },
          { key: "operator", label: "运营", render: (x) => mono(x.operator) },
          { key: "action", label: "动作", render: (x) => mono(x.action) },
          { key: "target", label: "对象", render: (x) => mono(x.target ?? "—") },
          { key: "result", label: "结果", render: (x) => badge(String(x.result ?? "—"), x.result === "ok" ? "ok" : "warn") },
        ],
      }),
    );
  });
}
