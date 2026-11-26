/**
 * 客户（律所 / 个人客户 / 租户）。第 71 批（V45）按“以客户为主轴”重构（research/2026-11-26-V45…/03-控制台信息架构分析.md §5）：
 *   列表   类型（律所 / 个人）+ 状态筛选；8 列，状态提前；用量价值只给有 billing.read 的（控制面按 hidden 裁剪，B-8）。
 *   详情   律所版式 6 个页签：概览、成员与电脑、用量、套餐与额度（含本期账单）、订阅与开通、操作记录；
 *          个人版式没有“成员与电脑”，概览里直接放“这个人 + 他的电脑”。页签写进网址（?tab=），旧值照认。
 * 接口：GET /v1/ops/tenants、POST /v1/ops/tenants、GET /v1/ops/tenants/{tid}（hidden、join_requests）、GET …/{tid}/audit（B-1）、
 *       GET /v1/ops/accounts?tid（成员状态与电脑上限）、GET /v1/ops/alerts，以及各写操作（契约 §2）。
 */
import * as api from "../api.js";
import { accountBadge, alertList, can, canSupport, ctx, deviceState, deviceTable, go, LIMIT_SOURCE, needs, pageHead, PAUSED, pendingRow, periodText, roleText, setCrumbs, tenantBadge } from "../domain.js";
import {
  add, badge, btn, clear, confirmAction, copyBtn, dangerZone, dataTable, emptyBlock, errorBlock, facts, fmt, h, hbars, icon, load, loadingBlock, matches, metaLine, meter, mono, note, panel,
  periodBars, rowMenu, saveCsv, searchInput, segmented, showSecret, signals, stateCell, tabBar, toast, trendChart,
} from "../ui.js";

/** “按电脑”视图的状态筛选（第三轮 27：从横幅进来只看待批准，待批准排最前） */
const DSTATUS = [
  ["", "全部", () => true],
  ["signed_in", "登录中", (d) => deviceState(d) === "signed_in"],
  ["signed_out", "已退出登录", (d) => deviceState(d) === "signed_out"],
  ["pending", "待批准", (d) => deviceState(d) === "pending"],
  ["revoked", "已移除", (d) => deviceState(d) === "revoked"],
];
const st = { dstatus: "", type: "all", filter: "all", q: "", table: { sort: "used_ratio", asc: false }, tab: "overview", tabTid: null, view: "members", pq: "", pstatus: "", memberTable: { sort: "name", asc: true }, devTable: { sort: "state", asc: true }, acctTable: {}, sel: new Set() };
const DAY = 86_400_000;

/** 个人客户：控制面给 personal（第 71 批 I-1）；旧云端没给时按“自助注册且只有 1 个账号”近似 */
export const isPersonal = (t) => (typeof t?.personal === "boolean" ? t.personal : t?.created_via === "self" && Number(t?.accounts) <= 1);
const TYPES = [
  ["all", "全部", () => true],
  ["firm", "律所", (t) => !isPersonal(t)],
  ["personal", "个人", isPersonal],
];
const FILTERS = [
  ["all", "全部", () => true],
  ["attention", "需关注", (t) => t.status === "active" && (Number(t.alerts_open) > 0 || Number(t.used_ratio) >= 0.8 || !!t.paused || (t.forecast_exhaust_at && Date.parse(t.forecast_exhaust_at) < Date.parse(t.period?.resets_at ?? "")))],
  ["paused", "已暂停", (t) => !!t.paused],
  ["pending", "待开通", (t) => t.status === "pending"],
  // 与总览“30 天内到期”同一口径（控制面 overview.tenants.expiring_30d）
  ["expiring", "30 天内到期", (t) => t.status !== "terminated" && !!t.subscription_until && Date.parse(t.subscription_until) > Date.now() && Date.parse(t.subscription_until) - Date.now() < 30 * DAY],
  ["closed", "已到期 / 终止", (t) => t.status === "expired" || t.status === "terminated"],
];
const STATUS_CELL = { active: ["正常", "ok"], pending: ["待开通", "info"], expired: ["已到期", "warn"], terminated: ["已终止", "neutral"] };
const tenantState = (t) => (t.paused ? stateCell(PAUSED[t.paused] ?? "已暂停", "danger") : stateCell(...(STATUS_CELL[t.status] ?? [t.status ?? "—", "neutral"])));
const daysLeft = (t) => (t.subscription_until ? Math.ceil((Date.parse(t.subscription_until) - Date.now()) / DAY) : null);

export function render(page, r) {
  if (r.arg) return renderDetail(page, r.arg, r.params);
  if (r.params.q !== undefined) st.q = r.params.q;
  if (r.params.type && TYPES.some(([id]) => id === r.params.type)) st.type = r.params.type;
  // 总览的信号点进来带 ?filter=attention|pending|expiring
  if (r.params.filter && FILTERS.some(([id]) => id === r.params.filter)) st.filter = r.params.filter;
  const box = h("div", { class: "stack" });
  page.append(
    pageHead("客户", "开通的律所与个人客户：席位、本期用量与到期", btn("开通客户", () => createCustomer(), { kind: "primary", icon: icon("plus"), disabled: !can("tenant.manage"), title: needs("tenant.manage") })),
    box,
  );
  load(box, () => api.get("/v1/ops/tenants"), (d) => drawList(box, d.tenants ?? [], new Set(d.hidden ?? [])), "正在读取客户…");
}

/** 席位口径（第 71 批第二轮，G1）：席位 = 律所可同时使用 AI 的成员名额；账号多于席位时写清后果。个人客户不讲席位 */
export const SEAT_NOTE = "席位 = 律所可同时使用 AI 的成员名额";
const unseatedOf = (t) => Math.max(0, (Number(t.accounts) || 0) - (Number(t.seats_used) || 0));
function seatCell(t) {
  if (isPersonal(t)) return h("div", { class: "cell-2" }, "个人", h("small", {}, `${fmt.int(t.devices)} 台电脑`));
  const n = unseatedOf(t);
  return h("div", { class: "cell-2", title: SEAT_NOTE }, `已用 ${fmt.int(t.seats_used)} / 共 ${fmt.int(t.seats)} 席`, n ? h("small", { class: "tone-text-warn" }, `另有 ${n} 个账号未占席`) : h("small", {}, `${fmt.int(t.accounts)} 个账号 · ${fmt.int(t.devices)} 台电脑`));
}

function drawList(box, rows) {
  ctx.tenants = rows.map((t) => ({ tid: t.tid, name: t.name ?? t.tid }));
  const tableBox = h("div");
  const typeSeg = h("span");
  const seg = h("span");
  const count = h("span", { class: "toolbar-count" });
  const redraw = () => {
    const tf = TYPES.find((x) => x[0] === st.type)?.[2] ?? (() => true);
    const ofType = rows.filter(tf);
    const f = FILTERS.find((x) => x[0] === st.filter)?.[2] ?? (() => true);
    const list = ofType.filter((t) => f(t) && matches(st.q, t.name, t.tid, t.plan?.label));
    clear(typeSeg, h("span", { class: "seg-label" }, "类型"), segmented(TYPES.map(([id, label, fn]) => ({ id, label, count: rows.filter(fn).length })), st.type, (id) => ((st.type = id), redraw()), "类型"));
    clear(seg, h("span", { class: "seg-label" }, "状态"), segmented(FILTERS.map(([id, label, fn]) => ({ id, label, count: ofType.filter(fn).length })), st.filter, (id) => ((st.filter = id), redraw()), "状态"));
    count.textContent = `${list.length === rows.length ? "共" : `${list.length} /`} ${rows.length} 家`;
    clear(
      tableBox,
      dataTable({
        state: st.table,
        rows: list,
        onRow: (t) => go(`tenants/${encodeURIComponent(t.tid)}`),
        empty: rows.length
          ? h("div", { class: "empty-cta" }, "没有符合条件的客户", btn("清除筛选", () => ((st.type = "all"), (st.filter = "all"), (st.q = ""), redraw()), { size: "sm", kind: "ghost" }))
          : "还没有客户。律所由运营开通；个人客户在律师自助注册后自动出现。",
        rowClass: (t) => (t.paused ? "danger-row" : FILTERS[1][2](t) ? "flagged" : t.status === "terminated" || t.status === "expired" ? "dim" : ""),
        caption: "客户列表",
        columns: [
          { key: "name", label: "客户", value: (t) => t.name ?? t.tid, render: (t) => h("div", { class: "cell-2" }, h("b", {}, t.name ?? t.tid, isPersonal(t) ? h("span", { class: "kind-tag" }, "个人") : null), mono(t.tid)) },
          {
            key: "status",
            label: "状态",
            class: "nowrap",
            value: (t) => (t.paused ? 0 : 1) * 100 - (Number(t.alerts_open) || 0) + ({ active: 1, pending: 2, expired: 3, terminated: 4 }[t.status] ?? 0),
            render: (t) => h("div", { class: "cell-2" }, tenantState(t), Number(t.alerts_open) > 0 ? h("small", { class: "tone-text-warn" }, `${fmt.int(t.alerts_open)} 条告警`) : t.paused ? h("small", {}, tenantBadgeText(t.status)) : null),
          },
          { key: "plan", label: "套餐", class: "nowrap", value: (t) => t.plan?.label ?? "", render: (t) => h("div", { class: "cell-2" }, t.plan?.label ?? t.plan?.id ?? "—", h("small", {}, isPersonal(t) ? "个人" : t.edition === "firm" ? "律所版" : "团队版")) },
          { key: "seats", label: "席位", title: SEAT_NOTE, value: (t) => Number(t.seats_used) || 0, render: (t) => seatCell(t) },
          { key: "used_ratio", label: "本期用量", value: (t) => Number(t.used_ratio) || 0, class: "col-meter", render: (t) => meter({ ratio: t.used_ratio, used: t.used, total: t.total, unit: t.unit, resetsAt: t.period?.resets_at, inflight: t.in_flight_ratio, capPct: t.cap_pct, paused: t.paused, compact: true, noRemain: true }) },
          {
            key: "forecast_exhaust_at",
            label: "预计用完",
            class: "nowrap",
            value: (t) => (t.forecast_exhaust_at ? Date.parse(t.forecast_exhaust_at) : null),
            render: (t) => (t.forecast_exhaust_at ? h("span", { class: Date.parse(t.forecast_exhaust_at) < Date.parse(t.period?.resets_at ?? "") ? "tone-text-warn" : "" }, fmt.date(t.forecast_exhaust_at)) : h("span", { class: "muted" }, "本期内不会")),
          },
          {
            key: "subscription_until",
            label: "到期",
            class: "nowrap",
            value: (t) => (t.subscription_until ? Date.parse(t.subscription_until) : null),
            render: (t) => {
              const left = daysLeft(t);
              return h("div", { class: "cell-2" }, fmt.date(t.subscription_until), left !== null && left <= 30 && left >= 0 ? h("small", { class: "tone-text-warn" }, `${left} 天后`) : null);
            },
          },
          {
            key: "_act",
            label: "",
            sortable: false,
            class: "act",
            render: (t) =>
              h(
                "span",
                { class: "act-wrap" },
                rowMenu([
                  { label: "打开详情", onClick: () => go(`tenants/${encodeURIComponent(t.tid)}`) },
                  { label: "加量…", onClick: () => boost(t, () => ctx.reload()), disabled: !can("quota.manage") || t.status === "terminated", title: needs("quota.manage") },
                  { label: "续订…", onClick: () => renew(t, () => ctx.reload()), disabled: !can("tenant.manage") || t.status === "terminated", title: needs("tenant.manage") },
                  { label: "复制客户编号", onClick: () => navigator.clipboard?.writeText(t.tid).then(() => toast("已复制"), () => toast(t.tid, "info")) },
                ], { aria: `操作：${t.name ?? t.tid}` }),
              ),
          },
        ],
      }),
    );
  };
  clear(box, h("div", { class: "toolbar" }, typeSeg, seg), h("div", { class: "toolbar" }, searchInput({ placeholder: "名称、编号或套餐", value: st.q, onInput: (v) => ((st.q = v), redraw()) }), count), tableBox);
  redraw();
}
const tenantBadgeText = (s) => STATUS_CELL[s]?.[0] ?? s ?? "";

async function planOptions() {
  try {
    const r = await api.get("/v1/ops/plans");
    return { options: (r.plans ?? []).map((p) => [p.id, `${p.label ?? p.id}${p.seat_price_cny ? ` · ¥${p.seat_price_cny}/席` : ""}`]), def: r.default_plan ?? r.plans?.[0]?.id, plans: r.plans ?? [] };
  } catch {
    return { options: [], def: "", plans: [] };
  }
}

/** 开通客户（第二轮，01）：先选律所还是个人。个人客户由律师自助注册开通，运营这里只指路到注册邀请码 */
async function createCustomer() {
  const kind = await confirmAction({
    title: "开通客户",
    fields: [{ name: "kind", label: "客户类型", type: "radio", options: [["firm", "律所", "多人共用一份额度，按席位计费；开通后发创始开通码给负责人"], ["personal", "个人", "一人一所，律师自助注册即开通"]], value: "firm" }],
    confirmLabel: "下一步",
  });
  if (!kind) return;
  if (kind.kind === "personal") {
    const go2 = await confirmAction({
      title: "开通个人客户",
      lead: h("p", {}, "个人客户由律师在客户端或网页自助注册后自动出现，不需要运营代开。要给某人开通试用，请发一张注册邀请码给他。"),
      confirmLabel: "去发注册邀请码",
    });
    if (go2) go("registration");
    return;
  }
  return createTenant();
}

// ─── 详情 ──────────────────────────────────────────────────────────
const TABS = [
  ["overview", "概览"],
  ["people", "成员与电脑"],
  ["usage", "用量"],
  ["plan", "套餐与额度"],
  ["subscription", "订阅与开通"],
  ["log", "操作记录"],
];
/** 第 71 批之前的页签名（计费页、旧书签带的 ?tab=）照认 */
const TAB_ALIAS = { members: "people", devices: "people", quota: "plan", bill: "plan", onboarding: "subscription" };

/** 开通码状态 → [中文, 色调] */
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
  const want = TAB_ALIAS[params.tab] ?? params.tab;
  if (st.tabTid !== tid) ((st.tab = "overview"), (st.tabTid = tid), st.sel.clear(), (st.pq = ""), (st.view = "members"), (st.pstatus = ""), (st.dstatus = ""));
  if (want && TABS.some((t) => t[0] === want)) st.tab = want;
  if (params.view === "devices" || params.view === "members") st.view = params.view;
  if (params.dstatus !== undefined) st.dstatus = DSTATUS.some(([id]) => id === params.dstatus) ? params.dstatus : "";
  const head = h("div");
  const body = h("div", { class: "stack" });
  // 第二轮（G4）：返回链接与面包屑重复，去掉；面包屑“客户 › 名称”可点回列表
  page.append(head, body);
  const reload = () => load(body, () => api.get(api.T(tid)), (d) => drawDetail(head, body, d, reload), "正在读取客户详情…");
  reload();
}

function drawDetail(head, body, d, reload) {
  const t = d.tenant ?? {};
  const hidden = new Set(d.hidden ?? []);
  const personal = isPersonal(t);
  const person = (d.members ?? []).find((m) => m.aid) ?? null;
  const left = daysLeft(t);
  const usedTone = t.paused || Number(t.used_ratio) >= 1 ? "danger" : Number(t.used_ratio) >= 0.8 ? "warn" : undefined;
  const liveDevs = (d.devices ?? []).filter((x) => deviceState(x) !== "revoked");
  const signedIn = liveDevs.filter((x) => deviceState(x) === "signed_in").length;
  const unseated = (d.members ?? []).filter((m) => m.aid && !(m.seat && !m.seat.revoked_at)).length;
  setCrumbs([["客户", "ops/tenants"], [t.name ?? t.tid]]);
  const tabs = TABS.filter(([id]) => !(personal && id === "people"));
  if (!tabs.some(([id]) => id === st.tab)) st.tab = "overview";
  const setTab = (id, view, dstatus) => {
    st.tab = id;
    if (view) st.view = view;
    if (dstatus !== undefined) st.dstatus = dstatus;
    history.replaceState(null, "", `#/ops/tenants/${encodeURIComponent(t.tid)}?tab=${id}${view ? `&view=${view}` : ""}`);
    drawTabs();
    drawPane();
  };
  const moreItems = [
    personal ? { label: "改套餐…", onClick: () => changePlan(t, reload, d), disabled: !can("tenant.manage"), title: needs("tenant.manage") } : null,
    { label: "续订…", onClick: () => renew(t, reload), disabled: !can("tenant.manage") || t.status === "terminated", title: needs("tenant.manage") },
    t.status === "pending" || !t.root_enrolled ? { label: "发创始开通码…", onClick: () => issueFounder(t, reload), disabled: !can("activation.issue"), title: needs("activation.issue") } : null,
    { label: "复制客户编号", onClick: () => navigator.clipboard?.writeText(t.tid).then(() => toast("已复制"), () => toast(t.tid, "info")) },
    { label: "终止订阅…", danger: true, onClick: () => setTab("subscription"), disabled: !can("tenant.terminate") || t.status === "terminated", title: needs("tenant.terminate") },
  ];
  // 页头主操作是这家客户最常用的商业操作：律所调整席位，个人加量（第二轮 04：不再把“打开账号详情”放主位）
  const actions = h(
    "div",
    { class: "btn-row" },
    personal
      ? btn("加量…", () => boost(t, reload), { kind: "primary", disabled: !can("quota.manage") || t.status === "terminated", title: needs("quota.manage") })
      : btn("改套餐或席位…", () => changePlan(t, reload, d), { kind: "primary", disabled: !can("tenant.manage"), title: needs("tenant.manage") }),
    personal ? null : btn("加量…", () => boost(t, reload), { disabled: !can("quota.manage") || t.status === "terminated", title: needs("quota.manage") }),
    rowMenu(moreItems, { label: "更多", aria: "更多操作" }),
  );
  clear(
    head,
    h(
      "div",
      { class: "stack" },
      pageHead(
        h("span", { class: "title-row" }, t.name ?? t.tid, personal ? h("span", { class: "kind-tag" }, "个人客户") : null, tenantBadge(t.status), t.paused ? badge(PAUSED[t.paused] ?? "已暂停", "danger") : null, Number(t.alerts_open) > 0 ? badge(`${t.alerts_open} 条告警`, "warn") : null),
        metaLine(mono(t.tid), `${t.plan?.label ?? "—"}套餐`, personal ? null : t.edition === "firm" ? "律所版" : "团队版", `${({ ops: "运营开通", self: "自助注册", founder_code: "开通码" })[t.created_via] ?? "开通"}于 ${fmt.date(t.created_at)}`, t.accounts_required ? "要求账号登录" : "不要求账号登录"),
        actions,
      ),
      h(
        "div",
        { class: "head-stats", id: "tenant-head-stats" },
        h("div", { class: ["head-stat", "stat", usedTone && `tone-${usedTone}`] }, h("span", { class: "stat-label" }, "本期用量"), h("span", { class: "stat-value num" }, fmt.pct(t.used_ratio)), h("span", { class: "stat-sub" }, [t.used !== undefined && t.total !== undefined ? `${fmt.amount(t.used, t.unit)} / ${fmt.amount(t.total, t.unit)}` : null, t.forecast_exhaust_at ? `预计 ${fmt.date(t.forecast_exhaust_at)} 用完` : fmt.resetLine(t.period?.resets_at)].filter(Boolean).join(" · "))),
        personal
          ? ((lim) => h("div", { class: ["head-stat", "stat", lim && signedIn >= lim && "tone-warn"] }, h("span", { class: "stat-label" }, "电脑"), h("span", { class: "stat-value num" }, hidden.has("accounts") ? `${fmt.int(t.devices)} 台` : lim ? `${signedIn} / ${lim} 台在线${signedIn >= lim ? " · 已满" : ""}` : `${signedIn} 台在线`), h("span", { class: "stat-sub" }, `共登记 ${fmt.int(t.devices)} 台；只有登录中的电脑占名额`)))(Number(person?.device_limit) || 0)
          : h("div", { class: "head-stat stat", title: SEAT_NOTE }, h("span", { class: "stat-label" }, "席位"), h("span", { class: "stat-value num" }, `已用 ${fmt.int(t.seats_used)} / 共 ${fmt.int(t.seats)}`), unseated && !hidden.has("accounts") ? h("span", { class: "stat-sub tone-text-warn" }, `另有 ${unseated} 个账号未占席：这些成员能登录，但用不了 AI`) : h("span", { class: "stat-sub" }, `账号 ${fmt.int(t.accounts)} · 电脑 ${fmt.int(t.devices)}`)),
        h("div", { class: ["head-stat", "stat", left !== null && left <= 30 && "tone-warn"] }, h("span", { class: "stat-label" }, "订阅到期"), h("span", { class: "stat-value num" }, fmt.date(t.subscription_until)), h("span", { class: "stat-sub" }, left === null ? "—" : left < 0 ? `已过期 ${-left} 天` : `还有 ${left} 天`)),
        hidden.has("billing")
          ? h("div", { class: "head-stat stat" }, h("span", { class: "stat-label" }, "本期请求"), h("span", { class: "stat-value num" }, fmt.int(t.requests)), h("span", { class: "stat-sub" }, "金额只对有“查看账单”权限的人员显示"))
          : h("div", { class: "head-stat stat" }, h("span", { class: "stat-label" }, "本期用量价值"), h("span", { class: "stat-value num" }, fmt.cny(t.value_cny)), h("span", { class: "stat-sub" }, `成本 ${fmt.cny(t.cost_cny)} · ${fmt.int(t.requests)} 次请求`)),
      ),
    ),
  );
  const tabBox = h("div");
  const drawTabs = () => clear(tabBox, tabBar(tabs.map(([id, label]) => ({ id, label, count: id === "people" ? (d.members ?? []).length : undefined })), st.tab, (id) => setTab(id)));
  const pane = h("div", { class: "stack" });
  const drawPane = () => {
    clear(pane);
    // 第三轮（08）：数字条只在概览页签出现；别的页签收起，把首屏留给本页签的内容
    const hs = head.querySelector("#tenant-head-stats");
    if (hs) hs.hidden = st.tab !== "overview";
    const fn = { overview: paneOverview, people: panePeople, usage: paneUsage, plan: panePlan, subscription: paneSubscription, log: paneLog }[st.tab];
    fn(pane, d, reload, { setTab, personal, person, hidden });
  };
  clear(body, tabBox, pane);
  drawTabs();
  drawPane();
}

// ─── 写操作（页头与页签共用） ───────────────────────────────────────
async function changePlan(t, reload, d) {
  const { plans } = await planOptions();
  const unseated = (d?.members ?? []).filter((m) => m.aid && !(m.seat && !m.seat.revoked_at)).length;
  const cur = plans.find((p) => p.id === t.plan?.id);
  const fee = (p, seats) => (p?.seat_price_cny ? fmt.cny(Number(p.seat_price_cny) * seats) : null);
  const need = Number(t.seats_used || 0) + unseated;
  const r = await confirmAction({
    title: "改套餐或席位",
    lead: h(
      "div",
      { class: "stack-sm" },
      h("p", {}, `${t.name ?? t.tid} · 当前 ${t.plan?.label ?? "—"}，${fmt.int(t.seats)} 席（在用 ${fmt.int(t.seats_used)}）${fee(cur, t.seats) ? `，月费 ${fee(cur, t.seats)}` : ""}`),
      plans.length && plans.every((p) => !p.seat_price_cny) ? h("p", { class: "muted small" }, "这些套餐还没有设席位单价：试用期不计费。") : null,
      unseated && !isPersonal(t) ? h("p", { class: "tone-text-warn" }, `另有 ${unseated} 个账号未占席：改为 ${need} 席可让所有成员使用 AI${fee(cur, need) ? `（按当前套餐月费 ${fee(cur, need)}）` : ""}。`) : null,
    ),
    fields: [
      plans.length
        ? { name: "plan", label: "套餐", type: "radio", options: plans.map((p) => [p.id, p.label ?? p.id, p.seat_price_cny ? `¥${p.seat_price_cny} / 席 / 月${fee(p, t.seats) ? ` · ${fmt.int(t.seats)} 席月费 ${fee(p, t.seats)}` : ""}` : undefined]), value: t.plan?.id }
        : { name: "plan", label: "套餐编号", value: t.plan?.id ?? "" },
      isPersonal(t) ? null : { name: "seats", label: "席位数", type: "number", min: 1, value: t.seats, hint: `不得少于在用席位（${fmt.int(t.seats_used)}）${unseated ? `；改为 ${need} 席可让所有成员使用 AI` : ""}` },
    ].filter(Boolean),
    consequences: ["本期额度即刻按新套餐 × 席位重算（已用量不变，百分比随之变化）；", "席位费从本期起按新价计入账单。"],
    confirmLabel: "保存",
    run: (v) => api.post(`${api.T(t.tid)}/plan`, { ...(v.plan && v.plan !== t.plan?.id ? { plan: v.plan } : {}), ...(v.seats !== null && v.seats !== undefined && v.seats !== t.seats ? { seats: v.seats } : {}) }),
  });
  if (r) (toast("已更新套餐与席位"), reload());
}
async function boost(t, reload, pct) {
  const { plans } = await planOptions();
  const p = plans.find((x) => x.id === t.plan?.id);
  // 加量费 = 席位费 × 加量% × 套餐系数；本期可用额度 + 总额度 × 加量%（按金额计额度且有权限看金额时写出）
  const seatFee = p?.seat_price_cny ? Number(p.seat_price_cny) * (Number(t.seats) || 1) : null;
  const factor = Number(p?.boost_price_factor ?? 1) || 1;
  const priceOf = (x) => [seatFee !== null ? `加量费 ${fmt.cny((seatFee * x * factor) / 100)}` : null, t.unit === "cny" && Number.isFinite(Number(t.total)) ? `本期额度 +${fmt.cny((Number(t.total) * x) / 100)}` : null].filter(Boolean).join(" · ") || undefined;
  const r = await confirmAction({
    title: pct ? `加量 ${pct}%` : "加量",
    lead: h("p", {}, `${t.name ?? t.tid} 本期已加量 ${t.boost_pct ? `+${t.boost_pct}%` : "0"}。加量按本期总额度的百分比计，${seatFee === null ? "试用期不计费。" : "费用计入本期账单。"}`),
    fields: pct ? [] : [{ name: "pct", label: "加量", type: "radio", options: [25, 50, 100].map((x) => [String(x), `+${x}%`, priceOf(x)]), value: "25" }],
    consequences: [pct && priceOf(pct) ? `${priceOf(pct)}；` : "本期可用额度随之增加；", "加量费计入本期账单，下期自动失效。"],
    confirmLabel: "加量",
    run: (v) => api.post(`${api.T(t.tid)}/boost`, { pct: pct ?? Number(v.pct) }),
  });
  if (r) (toast("已加量"), reload());
}
async function renew(t, reload) {
  const r = await confirmAction({
    title: "续订",
    lead: h("p", {}, `${t.name ?? t.tid} · 当前到期 ${fmt.date(t.subscription_until)}`),
    fields: [{ name: "days", label: "续订天数", type: "number", min: 1, max: 3660, value: 365, required: true }],
    consequences: ["从当前到期日（已到期则从今天）往后顺延；许可重签。"],
    confirmLabel: "续订",
    run: (v) => api.post(`${api.T(t.tid)}/renew`, { days: v.days }),
  });
  if (r) (toast("已续订"), reload());
}
async function issueFounder(t, reload) {
  const r = await confirmAction({
    title: "发创始开通码",
    lead: h("p", {}, "给律所负责人：凭码注册即为律所创始管理员。码只显示一次。"),
    fields: [{ name: "member_slug", label: "成员标识（可空）", placeholder: "如 zhang.wei", hint: "小写字母、数字、点；空 = 负责人注册时自填" }],
    confirmLabel: "发码",
    run: (v) => api.post(`${api.T(t.tid)}/activation-codes`, v.member_slug ? { member_slug: v.member_slug } : {}),
  });
  if (r?.code) {
    await showSecret({ title: "创始开通码", secret: r.code, expiresAt: r.expires_at, note: `开通编号 ${r.activation_id ?? ""}` });
    reload();
  }
}

// ─── 概览 ──────────────────────────────────────────────────────────
/** 额度规则（第二轮 G4：用量、总额度、重置时刻已在数字条，这里只放数字条没有的规则） */
function quotaPanel(t, d) {
  const u = d.usage ?? {};
  return panel(
    "额度规则",
    h(
      "div",
      { class: "stack-sm" },
      u.burst ? h("div", { title: `任意 ${u.burst.hours} 小时内至多用本期总额度的一定比例，按小时桶滑动` }, meter({ label: `任意 ${u.burst.hours} 小时窗口`, ratio: u.burst.used_ratio, unit: t.unit, resetText: "滚动窗口" })) : null,
      facts([
        ["周期", periodText(t.period)],
        ["上限", t.cap_pct ? `${t.cap_pct}%（用到即暂停）` : "未设"],
        ["加量", t.boost_pct ? `+${t.boost_pct}%` : "无"],
        ["预计用完", t.forecast_exhaust_at ? fmt.full(t.forecast_exhaust_at) : "本期内不会"],
        Number(t.legacy_used_ratio) > 0 ? ["迁移前已用", `${fmt.pct(t.legacy_used_ratio)}（计费方式调整前本期已用的比例，已计入）`] : null,
      ]),
    ),
  );
}
function paneOverview(pane, d, reload, o) {
  const t = d.tenant ?? {};
  const u = d.usage ?? {};
  const joins = d.join_requests ?? [];
  const alertsBox = h("div");
  const todo = [
    { label: "待开通", count: t.status === "pending" ? 1 : 0, tone: "info", hint: "请开通专员发创始开通码", onClick: () => o.setTab("subscription") },
    o.personal ? null : { label: "电脑待批准", count: o.hidden.has("accounts") ? 0 : joins.length, tone: "warn", hint: `${joins.slice(0, 2).map((j) => `${j.member_name ?? "成员"}的新电脑`).join("、")}等律所管理员在其电脑上批准`, onClick: () => ((st.dstatus = "pending"), o.setTab("people", "devices")) },
    { label: "未确认告警", count: Number(t.alerts_open) || 0, tone: "warn", hint: "见下方" },
    { label: "待结算的预留额度", count: Number(u.unreconciled_leases) || 0, tone: "warn", hint: "有用量还没回报，稍后会自动结算" },
  ].filter(Boolean);
  const live = todo.filter((x) => x.count > 0);
  const daily = u.daily?.length ? panel("本期每日用量", trendChart({ labels: u.daily.map((x) => x.day), series: [{ name: `用量（${fmt.unit(u.unit)}）`, values: u.daily.map((x) => Number(x.used) || 0), kind: "bar" }], format: (v) => (u.unit === "cny" ? fmt.cny(v, 0) : fmt.tokens(v)), tick: (l) => l.slice(5), height: 160 })) : panel("本期每日用量", emptyBlock("本期还没有用量"));
  add(
    pane,
    // 第二轮（04）：全为 0 时收成一行“无待办”，不占首屏三张空卡
    live.length ? h("div", { class: "stack-sm" }, live.map((x) => h("button", { type: "button", class: ["banner", x.tone === "info" ? "info" : "warn", x.onClick && "clickable"], onclick: x.onClick, disabled: !x.onClick }, icon("info"), h("span", { class: "spacer" }, h("b", {}, `${x.label} ${fmt.int(x.count)}`), `：${x.hint}`), x.onClick ? h("span", { class: "link" }, "查看") : null))) : h("p", { class: "no-todo" }, stateCell("没有待办", "ok"), h("span", { class: "muted small" }, o.personal ? "没有待开通、告警或待结算的预留额度" : "没有待开通、待批准的电脑、告警或待结算的预留额度")),
    Number(t.alerts_open) > 0 ? panel("未确认的告警", alertsBox) : null,
    o.personal ? personCard(d, reload, o) : null,
    h("div", { class: "grid-2" }, quotaPanel(t, d), daily),
  );
  if (Number(t.alerts_open) > 0) load(alertsBox, () => api.get("/v1/ops/alerts", { status: "open", limit: 500 }), (r) => alertsBox.append(alertList((r.alerts ?? []).filter((a) => a.tid === t.tid), { onAck: reload })), "正在读取告警…");
}
/** 个人客户：账号持有人和他的电脑（全宽，电脑表的操作列不被裁） */
function personCard(d, reload, o) {
  const m = o.person;
  if (o.hidden.has("accounts")) return panel("账号持有人", note("你的角色没有“查看账号”权限：这里不显示姓名、邮箱与电脑清单。"));
  return panel(
    "账号持有人",
    h(
      "div",
      { class: "stack-sm" },
      m
        ? h("div", { class: "person-head" }, h("span", { class: "avatar lg", "aria-hidden": "true" }, String(m.name || m.email || "?").slice(0, 1).toUpperCase()), h("div", { class: "cell-2" }, h("button", { type: "button", class: "link strong", onclick: () => go(`accounts/${encodeURIComponent(m.aid)}`) }, m.name ?? m.email ?? "—"), h("small", {}, m.email ?? "")), btn("打开账号详情", () => go(`accounts/${encodeURIComponent(m.aid)}`), { size: "sm" }))
        : note("还没有账号"),
      deviceTable((d.devices ?? []).map((x) => ({ ...x, member_name: x.member_name ?? m?.name })), { state: st.devTable, after: reload, showTenant: false, showMember: false, empty: "还没有登记电脑：律师在客户端登录后出现在这里" }),
    ),
    { sub: "新电脑直接登录即可；同时登录的电脑满额时，先让一台退出登录" },
  );
}

// ─── 成员与电脑（律所） ───────────────────────────────────────────
function panePeople(pane, d, reload) {
  const t = d.tenant ?? {};
  const hidden = new Set(d.hidden ?? []);
  if (hidden.has("accounts")) {
    pane.append(panel("成员与电脑", h("div", { class: "stack-sm" }, note("你的角色没有“查看账号”权限：只显示人数与席位，不显示姓名、邮箱与电脑清单。"), facts([["成员", `${fmt.int((d.members ?? []).length)} 人`], ["席位", `${fmt.int(t.seats_used)} 在用 / ${fmt.int(t.seats)}`], ["电脑", `${fmt.int(t.devices)} 台（未移除）`]]))));
    return;
  }
  const box = h("div", { class: "stack-sm" });
  pane.append(box);
  load(box, () => api.get("/v1/ops/accounts", { tid: t.tid, limit: 200 }).catch(() => ({ accounts: [] })), (r) => drawPeople(box, d, r.accounts ?? [], reload), "正在读取成员…");
}
function drawPeople(box, d, accs, reload) {
  const t = d.tenant ?? {};
  const byAid = new Map(accs.map((a) => [a.aid, a]));
  const usage = new Map((d.usage?.by_account ?? []).filter((x) => x.aid).map((x) => [x.aid, x]));
  const joins = d.join_requests ?? [];
  const pendingOf = (aid) => joins.filter((j) => j.aid && j.aid === aid).length;
  const rows = (d.members ?? []).map((m) => ({ ...m, acc: m.aid ? byAid.get(m.aid) ?? null : null, use: m.aid ? usage.get(m.aid) ?? null : null, pend: m.aid ? pendingOf(m.aid) : 0, seated: !!(m.seat && !m.seat.revoked_at) }));
  const devRows = [...(d.devices ?? []).map((x) => ({ ...x, member_name: x.member_name ?? byAid.get(x.aid)?.name ?? null })), ...joins.map((j) => pendingRow({ ...j, email: byAid.get(j.aid)?.email ?? null }, { tid: t.tid, tenant_name: t.name }))];
  const tools = h("div", { class: "toolbar" });
  const batch = h("div");
  const tableBox = h("div");
  const STATUS = [
    ["", "全部", () => true],
    ["active", "正常", (m) => m.acc?.status === "active" && !m.acc?.locked],
    ["locked", "已锁定", (m) => !!m.acc?.locked],
    ["disabled", "已停用", (m) => m.acc?.status === "disabled"],
    ["unseated", "未占席", (m) => !!m.aid && !m.seated],
  ];
  const drawBatch = () => {
    const ids = [...st.sel].filter((aid) => byAid.has(aid));
    clear(batch, ids.length ? h("div", { class: "batch-bar" }, h("b", {}, `已选 ${ids.length} 人`), btn("设电脑数上限…", () => batchLimit(ids, accs, reload), { size: "sm", disabled: !can("account.manage"), title: needs("account.manage") }), btn("全部退出登录…", () => batchSignout(ids, reload), { size: "sm", disabled: !canSupport(), title: canSupport() ? undefined : needs("account.support") }), btn("取消选择", () => (st.sel.clear(), draw()), { size: "sm", kind: "ghost" })) : null);
  };
  const draw = () => {
    const f = STATUS.find((x) => x[0] === st.pstatus)?.[2] ?? (() => true);
    clear(
      tools,
      segmented([{ id: "members", label: "按成员", count: rows.length }, { id: "devices", label: "按电脑", count: devRows.filter((x) => deviceState(x) !== "revoked").length }], st.view, (v) => ((st.view = v), draw()), "视图"),
      searchInput({ placeholder: st.view === "members" ? "姓名、手机号、邮箱" : "电脑名称、成员、版本", value: st.pq, onInput: (v) => ((st.pq = v), drawTable()) }),
      st.view === "members" ? [h("span", { class: "seg-label" }, "状态"), segmented(STATUS.map(([id, label, fn]) => ({ id, label, count: rows.filter(fn).length })), st.pstatus, (v) => ((st.pstatus = v), draw()), "状态")] : null,
      st.view === "devices" ? [h("span", { class: "seg-label" }, "状态"), segmented(DSTATUS.map(([id, label, fn]) => ({ id, label, count: devRows.filter(fn).length })), st.dstatus, (v) => ((st.dstatus = v), draw()), "电脑状态")] : null,
      h("span", { class: "spacer" }),
      st.view === "members" ? btn("代建账号", () => import("./accounts.js").then((m) => m.createAccount(t.tid, reload)), { icon: icon("plus"), size: "sm", disabled: !can("account.manage"), title: needs("account.manage") }) : null,
    );
    const drawTable = () => {
      if (st.view === "devices") {
        clear(batch);
        const df = DSTATUS.find(([id]) => id === st.dstatus)?.[2] ?? (() => true);
        clear(tableBox, deviceTable(devRows.filter((x) => df(x) && matches(st.pq, x.name, x.device_id, x.member_name, x.email, x.client_version)), { state: st.devTable, after: reload, showTenant: false, empty: "还没有登记电脑" }));
        return;
      }
      drawBatch();
      const list = rows.filter((m) => f(m) && matches(st.pq, m.name, m.email, m.acc?.phone, m.member_slug));
      const selectable = list.filter((m) => m.aid);
      const allOn = selectable.length > 0 && selectable.every((m) => st.sel.has(m.aid));
      const headBox = h("input", { type: "checkbox", "aria-label": "全选", checked: allOn, disabled: !selectable.length, onchange: (ev) => { for (const m of selectable) ev.currentTarget.checked ? st.sel.add(m.aid) : st.sel.delete(m.aid); drawTable(); } });
      clear(
        tableBox,
        dataTable({
          state: st.memberTable,
          rows: list,
          onRow: (m) => m.aid && go(`accounts/${encodeURIComponent(m.aid)}`),
          empty: rows.length ? "没有符合条件的成员" : "还没有成员。律所负责人用创始开通码完成开通后，成员会出现在这里。",
          rowClass: (m) => (m.acc?.status === "disabled" ? "dim" : m.acc?.locked || m.pend ? "flagged" : ""),
          caption: "成员",
          columns: [
            { key: "_sel", label: headBox, sortable: false, class: "sel", render: (m) => (m.aid ? h("input", { type: "checkbox", "aria-label": `选择 ${m.name ?? m.email}`, checked: st.sel.has(m.aid), onchange: (ev) => (ev.currentTarget.checked ? st.sel.add(m.aid) : st.sel.delete(m.aid), drawTable()) }) : null) },
            { key: "name", label: "成员", value: (m) => m.name ?? "", render: (m) => (m.aid ? h("div", { class: "cell-2" }, h("b", {}, m.name ?? "—"), h("small", {}, [m.acc?.phone, m.email].filter(Boolean).join(" · "))) : h("div", { class: "cell-2" }, h("b", { class: "muted" }, "未建账号的成员"), h("small", {}, m.seat ? `席位 ${m.seat.sid}` : "旧租户入组"))) },
            { key: "role", label: "角色", value: (m) => roleText(m.role) },
            { key: "status", label: "状态", value: (m) => (m.acc ? (m.acc.status === "disabled" ? 2 : m.acc.locked ? 1 : 0) : 3), render: (m) => (m.acc ? (m.acc.status === "disabled" ? stateCell("已停用", "neutral", m.acc.disabled_reason ? `停用原因：${m.acc.disabled_reason}` : undefined) : m.acc.locked ? stateCell("已锁定", "warn", "登录失败次数过多，暂时锁定") : stateCell("正常", "ok")) : h("span", { class: "muted" }, "—")) },
            { key: "last_login_at", label: "最近登录", value: (m) => m.acc?.last_login_at ?? "", render: (m) => (m.acc ? h("span", { title: fmt.full(m.acc.last_login_at) }, m.acc.last_login_at ? fmt.ago(m.acc.last_login_at) : "从未登录") : "—") },
            {
              key: "devices",
              label: "电脑",
              value: (m) => Number(m.acc?.devices_signed_in ?? m.devices) || 0,
              render: (m) => {
                if (!m.acc) return `${fmt.int(m.devices)} 台`;
                const on = m.acc.devices_signed_in ?? m.acc.devices;
                const full = Number(on) >= Number(m.acc.device_limit);
                return h("div", { class: "cell-2", title: `同时登录上限 ${fmt.int(m.acc.device_limit)} 台（${LIMIT_SOURCE[m.acc.device_limit_source] ?? "上限"}）；已登记 ${fmt.int(m.acc.devices)} 台` }, h("span", { class: full ? "tone-text-warn" : "" }, `${fmt.int(on)} / ${fmt.int(m.acc.device_limit)} 台在线${full ? " · 已满" : ""}`), m.pend ? h("small", { class: "tone-text-warn" }, `${m.pend} 台待批准`) : null);
              },
            },
            { key: "seat", label: "席位", title: `${SEAT_NOTE}；未占席的成员能登录，但用不了 AI`, value: (m) => (m.seated ? 1 : 0), render: (m) => (m.seated ? stateCell("占用", "ok") : m.seat?.revoked_at ? stateCell(`已收回 ${fmt.date(m.seat.revoked_at)}`, "neutral", "能登录，但用不了 AI") : stateCell("未占席", "neutral", "能登录，但用不了 AI；成员在电脑上第一次用 AI 时自动占席，席位不够时改套餐或席位")) },
            { key: "use", label: "占本期额度", num: true, title: "本期用量 ÷ 本期总额度", value: (m) => Number(m.use?.used_ratio_of_firm) || 0, render: (m) => (m.use ? fmt.pct(m.use.used_ratio_of_firm) : "0%") },
            {
              key: "_act",
              label: "",
              sortable: false,
              class: "act",
              render: (m) =>
                rowMenu([
                  m.aid ? { label: "打开账号详情", onClick: () => go(`accounts/${encodeURIComponent(m.aid)}`) } : null,
                  m.pend ? { label: "查看待批准的电脑", onClick: () => ((st.view = "devices"), (st.dstatus = "pending"), (st.pq = m.name ?? ""), draw()) } : null,
                  m.seated ? { label: "收回席位…", danger: true, onClick: () => revokeSeat(t, m, reload), disabled: !can("device.revoke"), title: needs("device.revoke") } : null,
                ], { aria: `操作：${m.name ?? m.email ?? "成员"}` }),
            },
          ],
        }),
      );
    };
    drawTable();
  };
  const banner = joins.length
    ? h(
        "button",
        { type: "button", class: "banner warn clickable", onclick: () => ((st.view = "devices"), (st.dstatus = "pending"), (st.pq = ""), draw()) },
        icon("info"),
        h("span", { class: "spacer" }, `${joins.slice(0, 3).map((j) => `${j.member_name ?? "成员"}的新电脑（申请于 ${fmt.time(j.created_at)}）`).join("、")}${joins.length > 3 ? ` 等 ${joins.length} 台` : ""}等律所管理员在其电脑上批准。`),
        h("span", { class: "link" }, "查看待批准的电脑"),
      )
    : null;
  clear(box, banner, tools, batch, tableBox);
  draw();
}
/** 收回席位：有成员编号按成员编号，没有账号的成员按席位编号（第 71 批 I-6，B-4：原先拼出 seats/null/revoke 必然 404） */
export async function revokeSeat(t, m, reload) {
  const key = m.uid ?? m.seat?.sid;
  const ok = await confirmAction({
    title: "收回席位",
    danger: true,
    lead: h("p", {}, `${t.name ?? t.tid} · ${m.name ?? m.email ?? `席位 ${m.seat?.sid ?? ""}`}`),
    consequences: ["这名成员的席位令牌不再续签，到期后不能用 AI；本机功能照常；", "席位空出可分给别人；用量记录保留。"],
    confirmLabel: "收回",
    run: () => api.post(`${api.T(t.tid)}/seats/${api.seg(key)}/revoke`),
  });
  if (ok) (toast("已收回席位"), reload?.());
  return ok;
}
async function batchLimit(ids, accs, reload) {
  const sample = accs.find((a) => ids.includes(a.aid));
  const r = await confirmAction({
    title: `设电脑数上限（${ids.length} 人）`,
    lead: h("p", {}, "按“同时登录的电脑数”计：登录中、未移除的电脑才占名额。"),
    fields: [{ name: "device_limit", label: "同时登录的电脑数上限", type: "number", min: 1, max: 9, value: "", hint: `1–9；留空 = 恢复按套餐（目前套餐给 ${sample?.device_limit_source === "plan" && sample?.device_limit_custom === null ? `${sample.device_limit} 台` : "见套餐页"}）` }],
    validate: (v) => (v.device_limit !== null && !(Number.isInteger(v.device_limit) && v.device_limit >= 1 && v.device_limit <= 9) ? "填 1–9 的整数，或留空" : null),
    consequences: ["立即生效：已登录的电脑不会被踢下线，但超过新数量后不能再登录新电脑；", "逐人保存，失败的会单独列出。"],
    confirmLabel: "保存",
    run: async (v) => {
      const bad = [];
      for (const aid of ids) await api.post(`${api.A(aid)}/limits`, { device_limit: v.device_limit }).catch((e) => bad.push(`${byName(accs, aid)}：${e.message}`));
      if (bad.length === ids.length) throw new Error(bad.join("；"));
      return { bad };
    },
  });
  if (r) (toast(r.bad.length ? `已保存 ${ids.length - r.bad.length} 人，${r.bad.length} 人失败：${r.bad.join("；")}` : `已为 ${ids.length} 人设置`, r.bad.length ? "error" : "ok"), st.sel.clear(), reload());
}
async function batchSignout(ids, reload) {
  const r = await confirmAction({
    title: `全部退出登录（${ids.length} 人）`,
    consequences: ["这些账号在网页与客户端的登录全部失效；", "本人重新登录即可继续用；电脑上的资料保留。"],
    confirmLabel: "全部退出登录",
    run: async () => {
      let n = 0;
      for (const aid of ids) n += Number((await api.post(`${api.A(aid)}/sessions/revoke`)).revoked) || 0;
      return { n };
    },
  });
  if (r) (toast(`已退出 ${fmt.int(r.n)} 个登录`), st.sel.clear(), reload());
}
const byName = (accs, aid) => accs.find((a) => a.aid === aid)?.name ?? aid;

// ─── 用量 ──────────────────────────────────────────────────────────
function paneUsage(pane, d) {
  const t = d.tenant ?? {};
  const u = d.usage;
  if (!u) return pane.append(emptyBlock("暂时没有这家客户的用量明细", "控制面没有返回用量数据；稍后点右上角刷新再看"));
  add(
    pane,
    Number(u.unreconciled_leases) > 0 ? h("div", { class: "banner warn" }, `有 ${u.unreconciled_leases} 份待结算的预留额度：这部分用量还没回报，稍后会自动结算。`) : null,
    h(
      "div",
      { class: "grid-2" },
      panel("本期", h("div", { class: "stack-sm" }, meter({ label: "本期", ratio: u.used_ratio, used: u.used, total: u.total, unit: u.unit, resetsAt: u.period?.resets_at ?? t.period?.resets_at, capPct: t.cap_pct, inflight: t.in_flight_ratio }), u.burst ? meter({ label: `任意 ${u.burst.hours} 小时窗口`, ratio: u.burst.used_ratio, unit: u.unit, resetText: "滚动窗口" }) : null)),
      panel("历史周期", periodBars(u.history ?? []), { sub: "每期已用比例" }),
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
        "按成员",
        dataTable({
          state: st.acctTable,
          rows: u.by_account ?? [],
          onRow: (x) => x.aid && go(`accounts/${encodeURIComponent(x.aid)}`),
          empty: "本期还没有成员用量",
          columns: [
            { key: "name", label: "成员", value: (x) => x.name ?? x.email ?? "", render: (x) => (x.aid ? h("div", { class: "cell-2" }, h("b", {}, x.name ?? "—"), h("small", {}, x.email ?? "")) : h("span", { class: "muted" }, x.uid ? "未关联账号" : "—")) },
            { key: "used", label: "用量", num: true, value: (x) => Number(x.used) || 0, render: (x) => fmt.amount(x.used, u.unit) },
            { key: "used_ratio_of_firm", label: "占本期额度", title: "本期用量 ÷ 本期总额度", num: true, value: (x) => Number(x.used_ratio_of_firm) || 0, render: (x) => fmt.pct(x.used_ratio_of_firm) },
            { key: "own_ratio", label: "占个人额度", num: true, value: (x) => x.own_ratio ?? null, render: (x) => (x.own_ratio === null || x.own_ratio === undefined ? h("span", { class: "muted" }, "不单设") : fmt.pct(x.own_ratio)) },
            { key: "requests", label: "请求", num: true, value: (x) => Number(x.requests) || 0, render: (x) => fmt.int(x.requests) },
          ],
        }),
      ),
    ),
  );
}

// ─── 套餐与额度（含本期账单） ─────────────────────────────────────
function panePlan(pane, d, reload) {
  const t = d.tenant ?? {};
  const T = api.T(t.tid);
  const b = d.bill;
  add(
    pane,
    h(
      "div",
      { class: "grid-2" },
      panel(
        "套餐与席位",
        h(
          "div",
          { class: "stack-sm" },
          facts([
            ["套餐", t.plan?.label ?? "—"],
            ["席位", `${fmt.int(t.seats)}（在用 ${fmt.int(t.seats_used)}）`],
            ["单位", fmt.unit(t.unit)],
          ]),
          // 第 71 批（B-7）：控制面改套餐要 tenant.manage（原先前端按 quota.manage 判）
          h("div", { class: "btn-row" }, btn("改套餐或席位…", () => changePlan(t, reload, d), { disabled: !can("tenant.manage"), title: needs("tenant.manage") })),
        ),
      ),
      panel(
        "加量包",
        h(
          "div",
          { class: "stack-sm" },
          h("p", { class: "muted small" }, `本期已加量 ${t.boost_pct ? `+${t.boost_pct}%` : "0"}；加量费计入本期账单，下期自动失效。`),
          ((row) => (planOptions().then(({ plans }) => {
            const pl = plans.find((x) => x.id === t.plan?.id);
            const seatFee = pl?.seat_price_cny ? Number(pl.seat_price_cny) * (Number(t.seats) || 1) : null;
            const factor = Number(pl?.boost_price_factor ?? 1) || 1;
            const extra = (p) => (t.unit === "cny" && Number.isFinite(Number(t.total)) ? ` · 本期额度 +${fmt.cny((Number(t.total) * p) / 100)}` : "");
            clear(row, [25, 50, 100].map((p) => btn(`+${p}%${extra(p)}${seatFee !== null ? ` · 加量费 ${fmt.cny((seatFee * p * factor) / 100)}` : ""}`, () => boost(t, reload, p), { disabled: !can("quota.manage"), title: needs("quota.manage") })), seatFee === null ? h("span", { class: "muted small" }, "试用期不计费") : null);
          }), row))(h("div", { class: "btn-row" }, [25, 50, 100].map((p) => btn(`+${p}%`, () => boost(t, reload, p), { disabled: !can("quota.manage"), title: needs("quota.manage") })))),
        ),
      ),
      panel(
        "上限",
        h(
          "div",
          { class: "stack-sm" },
          h("p", { class: "muted small" }, t.cap_pct ? `当前上限 ${t.cap_pct}%：用到本期额度的 ${t.cap_pct}% 即暂停。运营只能调低；调高或取消须律所管理员在客户端操作。` : "未设上限。运营可代设（只能设低于 100%）。"),
          h(
            "div",
            { class: "btn-row" },
            btn("代设上限…", async () => {
              const r = await confirmAction({
                title: "代设上限",
                fields: [{ name: "cap_pct", label: "上限（%）", type: "number", min: 1, max: t.cap_pct || 99, value: t.cap_pct || 90, required: true }],
                consequences: ["用到这个比例即暂停 AI（本机功能照常）；", "律所管理员能在客户端看到是运营设的，可自行调整。"],
                validate: (v) => (!(v.cap_pct >= 1 && v.cap_pct <= (t.cap_pct || 99)) ? `须在 1–${t.cap_pct || 99} 之间` : null),
                confirmLabel: "设上限",
                run: (v) => api.post(`${T}/cap`, { cap_pct: v.cap_pct }),
              });
              if (r) (toast("已设上限"), reload());
            }, { disabled: !can("quota.cap"), title: needs("quota.cap") }),
          ),
        ),
      ),
      panel(
        "要求账号登录",
        h(
          "div",
          { class: "stack-sm" },
          h("p", { class: "muted small" }, t.accounts_required ? "已开：电脑须有有效登录才能用 AI；退出登录、停用账号、移除电脑约 15 秒内生效。" : "未开（旧租户）：电脑凭证书即可用 AI，不看登录。"),
          h(
            "div",
            { class: "btn-row" },
            btn(t.accounts_required ? "不再要求账号登录…" : "要求账号登录…", async () => {
              const next = !t.accounts_required;
              const r = await confirmAction({
                title: next ? "要求账号登录" : "不再要求账号登录",
                danger: !next,
                consequences: next
                  ? ["还没用账号登录的电脑，下次续签时被拒（AI 暂停，本机功能照常），律师在客户端登录后恢复；", "先确认成员都已建好账号。"]
                  : ["电脑不再需要登录即可用 AI；", "停用账号、退出登录将不再能停掉这家客户的 AI 调用。"],
                typeToConfirm: next ? undefined : t.tid,
                typeLabel: "再输入一次租户编号以确认：",
                confirmLabel: next ? "打开" : "关闭",
                run: () => api.post(`${T}/accounts-required`, { required: next }),
              });
              if (r) (toast(next ? "已要求账号登录" : "已不再要求账号登录"), reload());
            }, { kind: t.accounts_required ? "danger" : undefined, disabled: !can("tenant.manage"), title: needs("tenant.manage") }),
          ),
        ),
      ),
    ),
    b
      ? panel(
          "本期账单",
          h(
            "div",
            { class: "stack-sm" },
            h("div", { class: "kpis" }, stat("本期应收", fmt.cny(b.revenue_cny), `席位费 ${fmt.cny(b.seat_fee_cny)} + 加量费 ${fmt.cny(b.boost_fee_cny)}`), stat("用量价值", fmt.cny(b.value_cny)), stat("模型成本", fmt.cny(b.cost_cny)), stat("毛利", fmt.cny(b.margin_cny), undefined, { tone: Number(b.margin_cny) < 0 ? "danger" : undefined })),
            facts([
              ["席位 × 单价", `${fmt.int(b.seats)} × ${fmt.cny(b.seat_price_cny)}`],
              ["加量", b.boost_pct ? `+${b.boost_pct}%（${fmt.cny(b.boost_fee_cny)}）` : "无"],
              ["请求 / token", `${fmt.int(b.requests)} 次 / ${fmt.tokens(b.tokens)}`],
            ]),
          ),
          { actions: btn("去计费页", () => go(`billing?q=${encodeURIComponent(t.tid)}`), { size: "sm" }) },
        )
      : new Set(d.hidden ?? []).has("billing")
        ? note("本期账单只对有“查看账单”权限的人员显示。")
        : null,
  );
}
const stat = (label, value, sub, o = {}) => h("div", { class: ["stat", o.tone && `tone-${o.tone}`] }, h("div", { class: "stat-label" }, label), h("div", { class: "stat-value num" }, value), sub ? h("div", { class: "stat-sub" }, sub) : null);

// ─── 订阅与开通 ────────────────────────────────────────────────────
function paneSubscription(pane, d, reload) {
  const t = d.tenant ?? {};
  const T = api.T(t.tid);
  add(
    pane,
    h(
      "div",
      { class: "grid-2" },
      panel("订阅", h("div", { class: "stack-sm" }, facts([["到期", fmt.full(t.subscription_until)], ["状态", tenantBadge(t.status)], ["许可", `${fmt.date(d.license?.issued_at)} 签发，有效至 ${fmt.date(d.license?.expires_at)}`]]), h("div", { class: "btn-row" }, btn("续订…", () => renew(t, reload), { disabled: !can("tenant.manage") || t.status === "terminated", title: needs("tenant.manage") })))),
      panel("成员邀请", facts([["已发", d.member_invitations ? `${fmt.int(d.member_invitations.total)} 个` : "—"], ["待使用", d.member_invitations ? `${fmt.int(d.member_invitations.open)} 个` : "—"], ["说明", "成员邀请由律所管理员在客户端发，运营只看数量"]])),
    ),
    panel(
      "创始开通码",
      dataTable({
        state: {},
        rows: d.activation_codes ?? [],
        empty: isPersonal(t) ? "个人客户自助注册开通，不用开通码" : "还没有发过开通码",
        columns: [
          { key: "id", label: "编号", render: (a) => mono(a.id) },
          { key: "status", label: "状态", class: "nowrap", value: (a) => actStatus(a)[0], render: (a) => badge(...actStatus(a)) },
          { key: "created_at", label: "发出", value: (a) => a.created_at ?? "", render: (a) => fmt.time(a.created_at) },
          { key: "expires_at", label: "有效至", value: (a) => a.expires_at ?? "", render: (a) => fmt.time(a.expires_at) },
          {
            key: "_act",
            label: "",
            sortable: false,
            class: "act",
            render: (a) =>
              rowMenu([
                ["open", "pending", "claimed"].includes(a.status) && !actExpired(a)
                  ? {
                      label: "作废…",
                      danger: true,
                      disabled: !can("activation.issue"),
                      title: needs("activation.issue"),
                      onClick: async () => {
                        const ok = await confirmAction({ title: "作废开通码", danger: true, consequences: ["这个码立即不能再用；已完成的开通不受影响。"], confirmLabel: "作废", run: () => api.post(`${T}/activation-codes/${api.seg(a.id)}/revoke`) });
                        if (ok) (toast("已作废"), reload());
                      },
                    }
                  : null,
              ]),
          },
        ],
      }),
      { flush: true, actions: [can("activation.issue") ? null : h("span", { class: "muted small" }, "由开通专员发（与客户运营职责分离）"), btn("发创始开通码…", () => issueFounder(t, reload), { size: "sm", kind: t.status === "pending" && can("activation.issue") ? "primary" : undefined, disabled: !can("activation.issue"), title: can("activation.issue") ? undefined : "由开通专员发：与客户运营职责分离" })] },
    ),
    dangerZone("危险操作", [
      {
        title: "终止订阅",
        desc: "终止后立即失效：全部电脑不能再用 AI，额度不再发放。客户本机数据不受影响；不可撤销。",
        action: btn("终止订阅…", async () => {
          const r = await confirmAction({
            title: `终止 ${t.name ?? t.tid} 的订阅`,
            danger: true,
            consequences: ["立即失效：全部电脑不能再用 AI（约 15 秒内生效）；", "本期账单照常出；用量记录保留；", "不可撤销：恢复须重新开通。"],
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

// ─── 操作记录（第三轮 08：全部事件中文、映射不到写原始事件码；申请人与入组申请可读可点；按动作、操作人、时间、结果筛选；加载更多；导出 CSV） ───
const ACTION_LABEL = {
  "account.create": "代建账号",
  "account.disable": "停用账号",
  "account.enable": "启用 / 解锁账号",
  "account.reset_code": "生成重置码",
  "account.sessions_revoke": "全部退出登录",
  "account.session_revoke": "退出一处登录",
  "account.limits": "改个人上限",
  "account.password_setup": "设置密码",
  "account.password_reset": "重置密码",
  "account.password_change": "修改密码",
  "account.device_signout": "让电脑退出登录",
  "account.rebind": "电脑换绑账号",
  "account.login": "登录",
  "account.logout": "退出登录",
  "account.refresh": "刷新登录",
  "device.signout": "电脑退出登录",
  "device.revoke": "移除电脑",
  "device.auto_revoke": "自动移除电脑",
  "device.register": "登记电脑",
  "device.auto_enroll": "新电脑直接登记",
  "device.rename": "给电脑改名",
  "seat.assign": "占用席位",
  "seat.revoke": "收回席位",
  "seat_token.issue": "领取用 AI 的凭证",
  "plan.change": "改套餐或席位",
  "quota.boost": "加量",
  "quota.cap_set": "设上限",
  "quota.grant": "加量（旧）",
  "license.renew": "续订",
  "license.terminate": "终止订阅",
  "accounts.policy": "要求账号登录（开 / 关）",
  "activation.issue": "发创始开通码",
  "activation.revoke": "作废开通码",
  "activation.redeem": "使用开通码",
  "invitation.create": "发成员邀请",
  "invitation.revoke": "作废成员邀请",
  "join.request": "新电脑申请（待批准）",
  "join.withdraw": "撤回入组申请",
  "join.approve": "批准新电脑",
  "join.reject": "拒绝新电脑",
  "tenant.create": "开通客户",
  "tenant.enroll_root": "完成律所开通",
  "connector.remove": "移除连接器",
  "draft.create": "新建草稿",
  "anon_summary.update": "更新匿名统计",
};
const LOG_KINDS = [
  ["", "全部", () => true],
  ["account", "账号", (a) => a.startsWith("account.")],
  ["device", "电脑与席位", (a) => /^(device|join|seat|seat_token)\./.test(a)],
  ["quota", "套餐与额度", (a) => /^(quota|plan)\./.test(a)],
  ["subscription", "订阅与开通", (a) => /^(license|activation|invitation|tenant)\./.test(a) || a === "accounts.policy"],
];
const RANGES = [
  ["", "全部时间", 0],
  ["1", "今天", 1],
  ["7", "近 7 天", 7],
  ["30", "近 30 天", 30],
];
const ACTOR = { ops: "平台人员", device: "律所电脑", account: "成员", claimant: "申请人", firm_admin: "律所管理员", system: "系统" };
function paneLog(pane, d, _reload, o) {
  const t = d.tenant ?? {};
  const box = h("div");
  const toolBox = h("div", { class: "toolbar" });
  const toolBox2 = h("div", { class: "toolbar" });
  const more = h("div");
  pane.append(toolBox, toolBox2, panel("操作记录", h("div", {}, box, more), { class: "log-panel", flush: true, sub: "这家客户的审计链：平台人员与律所的操作", actions: btn("导出 CSV", () => exportCsv(), { size: "sm", icon: icon("download"), title: "只导出当前筛选出来的记录，在浏览器本地生成" }) }));
  const rows = [];
  const labels = {};
  const kinds = {};
  const f = { kind: "", actor: "", range: "", failed: false, noLogin: true };
  let oldest = null;
  const actionText = (a) => ACTION_LABEL[a] ?? a ?? "—";
  const failed = (x) => x.result !== "ok";
  const who = (x) => labels[x.actor?.id] ?? `${ACTOR[x.actor?.kind] ?? "其他"}`;
  const targetText = (x) => (x.target ? labels[x.target] ?? (String(x.target).startsWith("fp:") ? "电脑" : x.target) : "—");
  const link = (id) => {
    const k = kinds[id];
    if (k === "account" && String(id).startsWith("acc_")) return () => go(`accounts/${encodeURIComponent(id)}`);
    if (k === "join") return () => o.setTab("people", "devices", "pending");
    return null;
  };
  // 第五轮：只显示姓名，邮箱放悬停；链接平时用正文色（.log-panel .link）
  const nameOnly = (text) => {
    const m = /^(.*)（([^（）]*@[^（）]*)）$/.exec(String(text));
    return m ? { text: m[1], title: m[2] } : { text, title: null };
  };
  const cell = (id, text) => {
    const to = id ? link(id) : null;
    const n = nameOnly(text);
    const title = [n.title, id].filter(Boolean).join(" · ") || undefined;
    return to ? h("button", { type: "button", class: "link", title, onclick: to }, n.text) : h("span", { title }, n.text);
  };
  const LOGIN_ACTS = new Set(["account.login", "account.logout", "account.refresh", "account.session_revoke"]);
  const filtered = () => {
    const kf = LOG_KINDS.find(([id]) => id === f.kind)?.[2] ?? (() => true);
    const days = RANGES.find(([id]) => id === f.range)?.[2] ?? 0;
    const since = days ? Date.now() - days * 86_400_000 : 0;
    return rows.filter((x) => kf(String(x.action ?? "")) && (!f.noLogin || !LOGIN_ACTS.has(x.action)) && (!f.actor || who(x) === f.actor) && (!since || Date.parse(x.at ?? "") >= since) && (!f.failed || failed(x)));
  };
  const actorDl = h("datalist", { id: "log-actor-opts" });
  const actorIn = h("input", { type: "search", class: "search", list: "log-actor-opts", placeholder: "操作人：输入姓名", "aria-label": "按操作人筛选", autocomplete: "off" });
  actorIn.addEventListener("change", () => ((f.actor = actorIn.value.trim()), drawTools(), drawRows()));
  actorIn.addEventListener("search", () => ((f.actor = actorIn.value.trim()), drawTools(), drawRows()));
  const drawTools = () => {
    clear(toolBox, h("span", { class: "seg-label" }, "动作"), segmented(LOG_KINDS.map(([id, label, kf]) => ({ id, label, count: rows.filter((x) => kf(String(x.action ?? ""))).length })), f.kind, (v) => ((f.kind = v), drawTools(), drawRows()), "动作类型"));
    clear(actorDl, [...new Set(rows.map(who))].map((v) => h("option", { value: v })));
    clear(
      toolBox2,
      h("span", { class: "seg-label" }, "登录"),
      segmented([{ id: "hide", label: "不含登录", count: rows.filter((x) => !LOGIN_ACTS.has(x.action)).length }, { id: "show", label: "含登录", count: rows.length }], f.noLogin ? "hide" : "show", (v) => ((f.noLogin = v === "hide"), drawTools(), drawRows()), "登录事件"),
      actorIn,
      actorDl,
      h("span", { class: "seg-label" }, "时间"),
      segmented(RANGES.map(([id, label]) => ({ id, label })), f.range, (v) => ((f.range = v), drawTools(), drawRows()), "时间范围"),
      h("span", { class: "seg-label" }, "结果"),
      segmented([{ id: "", label: "全部" }, { id: "failed", label: "只看失败", count: rows.filter(failed).length }], f.failed ? "failed" : "", (v) => ((f.failed = v === "failed"), drawTools(), drawRows()), "结果"),
    );
  };
  const drawRows = () =>
    clear(
      box,
      dataTable({
        state: { sort: "seq", asc: false },
        rows: filtered(),
        empty: rows.length ? "没有符合条件的记录" : "还没有操作记录",
        rowClass: (x) => (failed(x) ? "danger-row" : ""),
        columns: [
          { key: "at", label: "时间", value: (x) => x.at ?? "", render: (x) => h("span", { class: "nowrap" }, fmt.full(x.at)) },
          { key: "action", label: "动作", value: (x) => actionText(x.action), render: (x) => (ACTION_LABEL[x.action] ? h("span", { title: x.action }, ACTION_LABEL[x.action]) : mono(x.action ?? "—")) },
          { key: "actor", label: "操作人", value: (x) => who(x), render: (x) => cell(x.actor?.id, who(x)) },
          { key: "target", label: "对象", value: (x) => targetText(x), render: (x) => (!x.target ? h("span", { class: "muted" }, "—") : x.target === x.actor?.id ? h("span", { class: "muted", title: nameOnly(targetText(x)).title ?? undefined }, "本人") : cell(x.target, targetText(x))) },
          { key: "result", label: "结果", value: (x) => (failed(x) ? 0 : 1), render: (x) => (failed(x) ? badge(/^rejected/.test(String(x.result)) ? "被拒绝" : "未完成", "danger", String(x.result ?? "")) : h("span", { class: "muted" }, "成功")) },
          { key: "seq", label: "序号", num: true, class: "muted-col", value: (x) => Number(x.seq) || 0 },
        ],
      }),
    );
  const exportCsv = () => {
    const list = filtered().sort((a, b) => (Number(b.seq) || 0) - (Number(a.seq) || 0));
    saveCsv([["时间", "动作", "事件码", "操作人", "对象", "结果", "序号"], ...list.map((x) => [fmt.full(x.at), actionText(x.action), x.action ?? "", who(x), targetText(x), failed(x) ? String(x.result ?? "") : "成功", x.seq])], `操作记录-${t.tid}-${new Date().toISOString().slice(0, 10)}.csv`);
  };
  const fetchMore = () => {
    clear(more, loadingBlock("正在读取操作记录…"));
    api.get(`${api.T(t.tid)}/audit`, { limit: 100, before: oldest ?? undefined }).then(
      (r) => {
        Object.assign(labels, r.labels ?? {});
        Object.assign(kinds, r.kinds ?? {});
        rows.push(...(r.records ?? []));
        oldest = rows.length ? Math.min(...rows.map((x) => Number(x.seq) || 0)) : null;
        drawTools();
        drawRows();
        clear(more, oldest && oldest > 1 ? h("div", { class: "more" }, btn("加载更多", () => fetchMore(), { size: "sm" })) : rows.length ? h("p", { class: "muted small center" }, `共 ${fmt.int(rows.length)} 条`) : null);
      },
      (e) => clear(more, e?.code === "not_ready" ? h("div", { class: "state state-notready" }, h("b", {}, "云端版本过旧"), h("p", {}, "这台控制面还不提供客户的操作记录；升级后这里会显示。")) : errorBlock(e, fetchMore)),
    );
  };
  fetchMore();
}

// 供账号详情复用
export { accountBadge, tenantState };
