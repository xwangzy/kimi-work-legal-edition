/**
 * 第 72 批（D-306，契约 §8）：以“人”和“组织”两条主轴——
 *   列表   同一菜单两个页签：团队客户（一行 = 组织：成员 / 席位、套餐、用量、到期，点开组织详情）与
 *          个人客户（一行 = 一个人的个人空间：姓名、打码手机号、套餐、本期用量、电脑数、到期，点开用户详情）；类型取显式字段 kind。
 *          地址 ?kind=team|personal；旧 ?type=firm|personal|all 照认。
 *   组织详情 概览 / 成员与席位（运营代发团队邀请、分配 / 释放席位、停用）/ 电脑 / 用量与账单 / 订阅与开通 / 操作记录；
 *          旧 ?tab=people|plan|quota|bill|onboarding 照认（people&view=devices → 电脑）。个人空间仍可打开（订阅、加量、操作记录）。
 * 以下为第 71 批的说明（仍适用的部分）：
 * 客户（律所 / 个人客户 / 租户）。第 71 批（V45）按“以客户为主轴”重构（research/2026-11-26-V45…/03-控制台信息架构分析.md §5）：
 *   列表   类型（律所 / 个人）+ 状态筛选；8 列，状态提前；用量价值只给有 billing.read 的（控制面按 hidden 裁剪，B-8）。
 *   详情   律所版式 6 个页签：概览、成员与电脑、用量、套餐与额度（含本期账单）、订阅与开通、操作记录；
 *          个人版式没有“成员与电脑”，概览里直接放“这个人 + 他的电脑”。页签写进网址（?tab=），旧值照认。
 * 接口：GET /v1/ops/tenants、POST /v1/ops/tenants、GET /v1/ops/tenants/{tid}（hidden、join_requests）、GET …/{tid}/audit（B-1）、
 *       GET /v1/ops/accounts?tid（成员状态与电脑上限）、GET /v1/ops/alerts，以及各写操作（契约 §2）。
 */
import * as api from "../api.js";
import { accountBadge, alertList, can, canSupport, ctx, deviceState, deviceTable, go, kindOf, LIMIT_SOURCE, needs, pageHead, PAUSED, pendingRow, periodText, ROLE, roleText, SEAT_NOTE, seatNote, inviteTable, setCrumbs, tenantBadge, unconfirmed, UNSEATED_TIP, wsStatus, wsStatusCell } from "../domain.js";
import {
  add, badge, btn, clear, confirmAction, copyBtn, dangerZone, dataTable, emptyBlock, errorBlock, facts, fmt, h, hbars, icon, load, loadingBlock, matches, metaLine, meter, mono, note, panel,
  periodBars, rowMenu, saveCsv, searchInput, segmented, showSecret, signals, stateCell, tabBar, toast, trendChart,
} from "../ui.js";

/** “按电脑”视图的状态筛选（第三轮 27：从横幅进来只看待批准，待批准排最前） */
const DSTATUS = [
  ["", "全部", () => true],
  ["signed_in", "登录中", (d) => deviceState(d) === "signed_in"],
  ["signed_out", "已退出登录", (d) => deviceState(d) === "signed_out"],
  ["pending", "待批准登录", (d) => deviceState(d) === "pending"],
  // 第 72 批（D-304）：团队里还没经管理员确认、不能接收团队共享事项的电脑（电脑行 issuer = account_ca）
  ["confirm", "待确认共享", (d) => unconfirmed(d)],
  ["revoked", "已移除", (d) => deviceState(d) === "revoked"],
];
const st = { dstatus: "", kind: "team", filter: "all", q: "", table: { sort: "used_ratio", asc: false }, tab: "overview", tabTid: null, pq: "", pstatus: "", memberTable: { sort: "name", asc: true }, devTable: { sort: "state", asc: true }, acctTable: {}, sel: new Set() };
const DAY = 86_400_000;

/** 个人客户：第 72 批起取显式字段 kind；旧云端给 personal（第 71 批 I-1）；都没给时按“自助注册且只有 1 个账号”近似 */
/** 一个人有效的团队身份（个人客户行“另在 N 个团队”） */
export const activeTeamsOf = (p) => (p?.workspaces ?? []).filter((w) => kindOf(w) === "team" && w.status !== "disabled");
export const isPersonal = (t) => (t?.kind === "personal" || t?.kind === "team" ? t.kind === "personal" : typeof t?.personal === "boolean" ? t.personal : t?.created_via === "self" && Number(t?.accounts) <= 1);
/** 两个页签（D-306 第 1 条）；旧地址的 ?type= 照认 */
const KINDS = [
  ["team", "团队客户", (t) => !isPersonal(t)],
  ["personal", "个人客户", isPersonal],
];
const TYPE_ALIAS = { firm: "team", personal: "personal", all: "team" };
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
/** 第 72 批评审（K1/K2/K14）：有未确认告警的正常客户主状态写“需关注”（告警数作次级）；自助注册还没在电脑上开通的写“待创建人开通” */
const PENDING_SELF = "待创建人在电脑上完成开通";
const tenantState = (t) => (t.paused ? stateCell(PAUSED[t.paused] ?? "已暂停", "danger") : t.status === "active" && Number(t.alerts_open) > 0 ? stateCell("需关注", "warn") : t.status === "pending" && t.created_via === "self" ? stateCell("待创建人开通", "info", PENDING_SELF) : stateCell(...(STATUS_CELL[t.status] ?? [t.status ?? "—", "neutral"])));
const daysLeft = (t) => (t.subscription_until ? Math.ceil((Date.parse(t.subscription_until) - Date.now()) / DAY) : null);

export function render(page, r) {
  if (r.arg) return renderDetail(page, r.arg, r.params);
  if (r.params.q !== undefined) st.q = r.params.q;
  const want = r.params.kind ?? TYPE_ALIAS[r.params.type];
  if (want && KINDS.some(([id]) => id === want)) st.kind = want;
  // 总览的信号点进来带 ?filter=attention|pending|expiring
  if (r.params.filter && FILTERS.some(([id]) => id === r.params.filter)) st.filter = r.params.filter;
  const box = h("div", { class: "stack" });
  page.append(
    pageHead("客户", "团队客户按组织管理成员、席位与电脑；个人客户按人管理", btn("开通客户", () => createCustomer(), { kind: "primary", icon: icon("plus"), disabled: !can("tenant.manage"), title: needs("tenant.manage") })),
    box,
  );
  load(box, () => Promise.all([api.get("/v1/ops/tenants"), personsByTid()]), ([d, people]) => drawList(box, d.tenants ?? [], people), "正在读取客户…");
}
/**
 * 个人客户的“这个人”：GET /v1/ops/people（account.read）里各人的个人空间 → {tid: 人}。没有权限或读不到时为空，个人客户行退回显示工作室名。
 * 每页 50 人，先读第 1 页，再并行读其余页（至多 20 页，再多的个人客户行同样退回工作室名）。
 */
async function loadPeople() {
  if (!can("account.read")) return [];
  const all = [];
  try {
    const first = await api.get("/v1/ops/people", { page: 1 });
    all.push(...(first.people ?? []));
    const pages = Math.min(20, Number(first.pages) || 1);
    for (const r of await Promise.all(Array.from({ length: pages - 1 }, (_, i) => api.get("/v1/ops/people", { page: i + 2 }).catch(() => null)))) all.push(...(r?.people ?? []));
  } catch {
    /* 没有 account.read 或旧云端：个人客户行显示工作室名 */
  }
  return all;
}
async function personsByTid() {
  const map = new Map();
  for (const p of await loadPeople()) for (const w of p.workspaces ?? []) if (kindOf(w) === "personal") map.set(w.tid, p);
  return map;
}

/** 席位口径（第 71 批第二轮，G1；第 72 批说法统一为“席位 = 能用 AI 的名额”，见 domain.js）：账号多于席位时写清后果。个人客户不讲席位 */
/**
 * 第 72 批（验收 Q-5）：成员数、未占席只算有效身份——被移出 / 停用的成员不算“成员”，也不算“未占席”。
 * member_count 由云端按有效身份给（旧云端没有时退回 accounts）；云端另给 members_removed 时作次要信息显示。
 */
export const activeMembersOf = (t) => Number(t.member_count ?? t.accounts) || 0;
const removedOf = (t) => Number(t.members_removed) || 0;
export const unseatedOf = (t) => Math.max(0, activeMembersOf(t) - (Number(t.seats_used) || 0));
function seatCell(t) {
  if (isPersonal(t)) return h("div", { class: "cell-2" }, "个人", h("small", {}, `${fmt.int(t.devices)} 台电脑`));
  const n = unseatedOf(t);
  const sn = seatNote(n, t.seats, t.seats_used);
  const removed = removedOf(t) ? ` · 另有 ${fmt.int(removedOf(t))} 人已移出` : "";
  return h("div", { class: "cell-2", title: sn ? `${SEAT_NOTE}。${sn.text}` : SEAT_NOTE }, `${fmt.int(activeMembersOf(t))} 名成员 · 已用 ${fmt.int(t.seats_used)} / 共 ${fmt.int(t.seats)} 席`, sn ? h("small", { class: sn.full ? "tone-text-warn" : "" }, `${sn.full ? `席位已满 · ${n} 人用不了 AI` : `${n} 人未占席 · 还有 ${sn.free} 个空席`}${removed}`) : h("small", {}, `${fmt.int(t.devices)} 台电脑${removed}`));
}

function drawList(box, rows, people) {
  ctx.tenants = rows.map((t) => ({ tid: t.tid, name: t.name ?? t.tid, kind: kindOf(t) }));
  const tabBox = h("div");
  const tableBox = h("div");
  const seg = h("span");
  const count = h("span", { class: "toolbar-count" });
  const personOf = (t) => people.get(t.tid) ?? null;
  // 个人客户一行 = 一个人：点开进用户详情（读不到这个人时退回个人空间详情）
  const open = (t) => (isPersonal(t) && personOf(t) ? go(`people/${encodeURIComponent(personOf(t).aid)}`) : go(`tenants/${encodeURIComponent(t.tid)}`));
  const usageCol = { key: "used_ratio", label: "本期用量", value: (t) => Number(t.used_ratio) || 0, class: "col-meter", render: (t) => meter({ ratio: t.used_ratio, used: t.used, total: t.total, unit: t.unit, resetsAt: t.period?.resets_at, inflight: t.in_flight_ratio, capPct: t.cap_pct, paused: t.paused, compact: true, noRemain: true }) };
  const statusCol = {
    key: "status",
    label: "状态",
    class: "nowrap",
    value: (t) => (t.paused ? 0 : 1) * 100 - (Number(t.alerts_open) || 0) + ({ active: 1, pending: 2, expired: 3, terminated: 4 }[t.status] ?? 0),
    render: (t) => h("div", { class: "cell-2" }, tenantState(t), Number(t.alerts_open) > 0 ? h("small", {}, `${fmt.int(t.alerts_open)} 条告警未确认`) : t.paused ? h("small", {}, tenantBadgeText(t.status)) : t.status === "pending" && t.created_via === "self" ? h("small", {}, "第一次在电脑上登录即开通") : null),
  };
  const untilCol = {
    key: "subscription_until",
    label: "到期",
    class: "nowrap",
    value: (t) => (t.subscription_until ? Date.parse(t.subscription_until) : null),
    render: (t) => {
      const left = daysLeft(t);
      return h("div", { class: "cell-2" }, fmt.date(t.subscription_until), left !== null && left <= 30 && left >= 0 ? h("small", { class: "tone-text-warn" }, `${left} 天后`) : null);
    },
  };
  const menuCol = {
    key: "_act",
    label: "",
    sortable: false,
    class: "act",
    render: (t) =>
      rowMenu([
        isPersonal(t) && personOf(t) ? { label: "打开用户详情", onClick: () => open(t) } : { label: "打开详情", onClick: () => go(`tenants/${encodeURIComponent(t.tid)}`) },
        isPersonal(t) ? { label: "个人空间的订阅与用量", onClick: () => go(`tenants/${encodeURIComponent(t.tid)}`) } : { label: "成员与席位", onClick: () => go(`tenants/${encodeURIComponent(t.tid)}?tab=members`) },
        { label: "加量…", onClick: () => boost(t, () => ctx.reload()), disabled: !can("quota.manage") || t.status === "terminated", title: needs("quota.manage") },
        { label: "续订…", onClick: () => renew(t, () => ctx.reload()), disabled: !can("tenant.manage") || t.status === "terminated", title: needs("tenant.manage") },
        { label: "复制客户编号", onClick: () => navigator.clipboard?.writeText(t.tid).then(() => toast("已复制"), () => toast(t.tid, "info")) },
      ], { aria: `操作：${t.name ?? t.tid}` }),
  };
  const COLS = {
    team: [
      // 评审（跨页 1）：客户编号不进主列，放悬停；第二行写人能用的信息（怎么开通的、哪天）
      { key: "name", label: "组织", value: (t) => t.name ?? t.tid, render: (t) => h("div", { class: "cell-2" }, h("b", { title: `客户编号 ${t.tid}` }, t.name ?? t.tid), h("small", {}, `${({ ops: "运营开通", self: "自助注册", founder_code: "开通码" })[t.created_via] ?? "开通"} · ${fmt.date(t.created_at)}`)) },
      statusCol,
      { key: "plan", label: "套餐", class: "nowrap", value: (t) => t.plan?.label ?? "", render: (t) => h("div", { class: "cell-2" }, t.plan?.label ?? t.plan?.id ?? "—", h("small", {}, t.edition === "firm" ? "律所版" : "团队版")) },
      { key: "seats", label: "成员 / 席位", title: SEAT_NOTE, value: (t) => Number(t.member_count ?? t.accounts) || 0, render: (t) => seatCell(t) },
      usageCol,
      {
        key: "forecast_exhaust_at",
        label: "预计用完",
        class: "nowrap",
        value: (t) => (t.forecast_exhaust_at ? Date.parse(t.forecast_exhaust_at) : null),
        render: (t) => (t.forecast_exhaust_at ? h("span", { class: Date.parse(t.forecast_exhaust_at) < Date.parse(t.period?.resets_at ?? "") ? "tone-text-warn" : "" }, fmt.date(t.forecast_exhaust_at)) : h("span", { class: "muted" }, "本期内不会")),
      },
      untilCol,
      menuCol,
    ],
    personal: [
      {
        key: "name",
        label: "用户",
        value: (t) => personOf(t)?.name ?? t.name ?? t.tid,
        // 验收 Q-5：“另在 N 个团队”只算有效的团队身份（被移出 / 停用的不算）
        render: (t) => ((p, teams) => (p ? h("div", { class: "cell-2" }, h("b", {}, p.name ?? "—", teams.length ? h("span", { class: "kind-tag", title: teams.map((w) => `${w.name} · ${ROLE[w.role] ?? w.role}`).join("、") }, `另在 ${teams.length} 个团队`) : null), h("small", {}, p.phone_masked ?? p.email_masked ?? "未绑定手机号")) : h("div", { class: "cell-2" }, h("b", { title: `客户编号 ${t.tid}` }, t.name ?? t.tid), h("small", {}, "个人空间"))))(personOf(t), activeTeamsOf(personOf(t))),
      },
      statusCol,
      { key: "plan", label: "套餐", class: "nowrap", value: (t) => t.plan?.label ?? "", render: (t) => t.plan?.label ?? t.plan?.id ?? "—" },
      usageCol,
      { key: "devices", label: "电脑", num: true, value: (t) => Number(t.devices) || 0, render: (t) => `${fmt.int(t.devices)} 台` },
      untilCol,
      menuCol,
    ],
  };
  const redraw = () => {
    const kf = KINDS.find((x) => x[0] === st.kind)?.[2] ?? (() => true);
    const ofKind = rows.filter(kf);
    const f = FILTERS.find((x) => x[0] === st.filter)?.[2] ?? (() => true);
    const list = ofKind.filter((t) => f(t) && matches(st.q, t.name, t.tid, t.plan?.label, personOf(t)?.name, personOf(t)?.phone_masked));
    clear(tabBox, tabBar(KINDS.map(([id, label, fn]) => ({ id, label, count: rows.filter(fn).length })), st.kind, (id) => ((st.kind = id), history.replaceState(null, "", `#/ops/tenants?kind=${id}`), redraw())));
    clear(seg, h("span", { class: "seg-label" }, "状态"), segmented(FILTERS.map(([id, label, fn]) => ({ id, label, count: ofKind.filter(fn).length })), st.filter, (id) => ((st.filter = id), redraw()), "状态"));
    count.textContent = `${list.length === ofKind.length ? "共" : `${list.length} /`} ${ofKind.length} ${st.kind === "personal" ? "人" : "家"}`;
    clear(
      tableBox,
      dataTable({
        state: st.table,
        rows: list,
        onRow: open,
        empty: ofKind.length
          ? h("div", { class: "empty-cta" }, "没有符合条件的客户", btn("清除筛选", () => ((st.filter = "all"), (st.q = ""), redraw()), { size: "sm", kind: "ghost" }))
          : st.kind === "personal"
            ? "还没有个人客户：律师自助注册后自动出现。"
            : "还没有团队客户：由运营开通，或个人律师在客户端把工作室升级为团队。",
        rowClass: (t) => (t.paused ? "danger-row" : FILTERS[1][2](t) ? "flagged" : t.status === "terminated" || t.status === "expired" ? "dim" : ""),
        caption: st.kind === "personal" ? "个人客户" : "团队客户",
        columns: COLS[st.kind],
      }),
    );
  };
  clear(box, tabBox, h("div", { class: "toolbar" }, searchInput({ placeholder: "名称、姓名或手机号后四位", value: st.q, onInput: (v) => ((st.q = v), redraw()) }), seg, h("span", { class: "spacer" }), count), tableBox);
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
  ["members", "成员与席位"],
  ["devices", "电脑"],
  ["usage", "用量与账单"],
  ["subscription", "订阅与开通"],
  ["log", "操作记录"],
];
/** 旧页签名（第 71 批的 people / plan，更早的 quota / bill / onboarding；计费页与旧书签带的 ?tab=）照认 */
const TAB_ALIAS = { people: "members", quota: "subscription", plan: "subscription", bill: "usage", onboarding: "subscription" };
/** 个人空间没有成员与席位、电脑另在概览（这个人和他的电脑） */
const TEAM_ONLY_TABS = new Set(["members", "devices"]);

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
  const want = params.tab === "people" && params.view === "devices" ? "devices" : TAB_ALIAS[params.tab] ?? params.tab;
  if (st.tabTid !== tid) ((st.tab = "overview"), (st.tabTid = tid), st.sel.clear(), (st.pq = ""), (st.pstatus = ""), (st.dstatus = ""));
  if (want && TABS.some((t) => t[0] === want)) st.tab = want;
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
  const unseated = unseatedOf(t);
  setCrumbs([[personal ? "个人客户" : "团队客户", `ops/tenants?kind=${personal ? "personal" : "team"}`], [t.name ?? t.tid]]);
  const tabs = TABS.filter(([id]) => !(personal && TEAM_ONLY_TABS.has(id)));
  if (!tabs.some(([id]) => id === st.tab)) st.tab = "overview";
  const setTab = (id, dstatus) => {
    st.tab = id;
    if (dstatus !== undefined) st.dstatus = dstatus;
    history.replaceState(null, "", `#/ops/tenants/${encodeURIComponent(t.tid)}?tab=${id}`);
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
        h("span", { class: "title-row" }, t.name ?? t.tid, personal ? h("span", { class: "kind-tag" }, "个人客户") : null, t.status === "pending" && t.created_via === "self" ? badge(PENDING_SELF, "info") : tenantBadge(t.status), t.paused ? badge(PAUSED[t.paused] ?? "已暂停", "danger") : null, Number(t.alerts_open) > 0 ? badge(`${t.alerts_open} 条告警`, "warn") : null),
        metaLine(`${t.plan?.label ?? "—"}套餐`, personal ? null : t.edition === "firm" ? "律所版" : "团队版", `${({ ops: "运营开通", self: "自助注册", founder_code: "开通码" })[t.created_via] ?? "开通"}于 ${fmt.date(t.created_at)}`, personal ? null : t.member_device_policy === "approve" ? "新电脑须管理员确认" : "新电脑：成员自己登录即可"),
        actions,
      ),
      h(
        "div",
        { class: "head-stats", id: "tenant-head-stats" },
        h("div", { class: ["head-stat", "stat", usedTone && `tone-${usedTone}`] }, h("span", { class: "stat-label" }, "本期用量"), h("span", { class: "stat-value num" }, fmt.pct(t.used_ratio)), h("span", { class: "stat-sub" }, [t.used !== undefined && t.total !== undefined ? `${fmt.amount(t.used, t.unit)} / ${fmt.amount(t.total, t.unit)}` : null, t.forecast_exhaust_at ? `预计 ${fmt.date(t.forecast_exhaust_at)} 用完` : fmt.resetLine(t.period?.resets_at)].filter(Boolean).join(" · "))),
        personal
          ? ((lim) => h("div", { class: ["head-stat", "stat", lim && signedIn >= lim && "tone-warn"] }, h("span", { class: "stat-label" }, "电脑"), h("span", { class: "stat-value num" }, hidden.has("accounts") ? `${fmt.int(t.devices)} 台` : lim ? `${signedIn} / ${lim} 台在线${signedIn >= lim ? " · 已满" : ""}` : `${signedIn} 台在线`), h("span", { class: "stat-sub" }, `共登记 ${fmt.int(t.devices)} 台；只有登录中的电脑占名额`)))(Number(person?.device_limit) || 0)
          : h("div", { class: "head-stat stat", title: SEAT_NOTE }, h("span", { class: "stat-label" }, "成员 / 席位"), h("span", { class: "stat-value num" }, `${fmt.int(t.member_count ?? t.accounts)} 人 · 已用 ${fmt.int(t.seats_used)} / 共 ${fmt.int(t.seats)} 席`), unseated && !hidden.has("accounts") ? ((sn) => h("span", { class: ["stat-sub", sn.full && "tone-text-warn"] }, sn.text))(seatNote(unseated, t.seats, t.seats_used)) : h("span", { class: "stat-sub" }, `电脑 ${fmt.int(t.devices)} 台`)),
        h("div", { class: ["head-stat", "stat", left !== null && left <= 30 && "tone-warn"] }, h("span", { class: "stat-label" }, "订阅到期"), h("span", { class: "stat-value num" }, fmt.date(t.subscription_until)), h("span", { class: "stat-sub" }, left === null ? "—" : left < 0 ? `已过期 ${-left} 天` : `还有 ${left} 天`)),
        hidden.has("billing")
          ? h("div", { class: "head-stat stat" }, h("span", { class: "stat-label" }, "本期请求"), h("span", { class: "stat-value num" }, fmt.int(t.requests)), h("span", { class: "stat-sub" }, "金额只对有“查看账单”权限的人员显示"))
          : h("div", { class: "head-stat stat" }, h("span", { class: "stat-label" }, "本期用量价值"), h("span", { class: "stat-value num" }, fmt.cny(t.value_cny)), h("span", { class: "stat-sub" }, `成本 ${fmt.cny(t.cost_cny)} · ${fmt.int(t.requests)} 次请求`)),
      ),
    ),
  );
  const tabBox = h("div");
  const drawTabs = () => clear(tabBox, tabBar(tabs.map(([id, label]) => ({ id, label, count: id === "members" ? t.member_count ?? (d.members ?? []).filter((m) => m.aid).length : id === "devices" ? liveDevs.length + (d.join_requests ?? []).length : undefined })), st.tab, (id) => setTab(id)));
  const pane = h("div", { class: "stack" });
  const drawPane = () => {
    clear(pane);
    // 第三轮（08）：数字条只在概览页签出现；别的页签收起，把首屏留给本页签的内容
    const hs = head.querySelector("#tenant-head-stats");
    if (hs) hs.hidden = st.tab !== "overview";
    const fn = { overview: paneOverview, members: paneMembers, devices: paneDevices, usage: paneUsageBill, subscription: paneSubscription, log: paneLog }[st.tab];
    fn(pane, d, reload, { setTab, personal, person, hidden });
  };
  clear(body, tabBox, pane);
  drawTabs();
  drawPane();
}

// ─── 写操作（页头与页签共用） ───────────────────────────────────────
async function changePlan(t, reload, d) {
  // 第 72 批（契约 §1 PlanSpec.audience）：只列适用于这类客户的套餐（缺省 any）
  const plans = (await planOptions()).plans.filter((p) => !p.audience || p.audience === "any" || p.audience === (isPersonal(t) ? "personal" : "team"));
  const unseated = unseatedOf(t);
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
      unseated && !isPersonal(t) ? ((sn) => (sn.full ? h("p", { class: "tone-text-warn" }, `${sn.text}：改为 ${need} 席可让所有成员使用 AI${fee(cur, need) ? `（按当前套餐月费 ${fee(cur, need)}）` : ""}。`) : h("p", { class: "muted" }, `${sn.text}。`)))(seatNote(unseated, t.seats, t.seats_used)) : null,
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
      u.burst ? h("div", { title: `近 ${u.burst.hours} 小时内至多用本期总额度的一定比例，随时间逐步恢复` }, meter({ label: `近 ${u.burst.hours} 小时用量`, ratio: u.burst.used_ratio, resetText: "随时间逐步恢复" })) : null,
      facts([
        ["周期", periodText(t.period)],
        ["月度上限", t.cap_pct ? `${t.cap_pct}%（用到即暂停）` : "未设（用满本期额度为止）"],
        ["账号登录", t.accounts_required ? "成员须登录账号才能用 AI" : "不要求登录（旧方式）"],
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
    { label: "待开通", count: t.status === "pending" ? 1 : 0, tone: "info", hint: t.created_via === "self" ? "自助注册的工作空间：律师第一次在客户端登录即完成开通，不用开通码" : "请开通专员发创始开通码", onClick: t.created_via === "self" ? null : () => o.setTab("subscription") },
    o.personal ? null : { label: "电脑待批准", count: o.hidden.has("accounts") ? 0 : joins.length, tone: "warn", hint: `${joins.slice(0, 2).map((j) => `${j.member_name ?? "成员"}的新电脑`).join("、")}等团队管理员批准`, onClick: () => o.setTab("devices", "pending") },
    { label: "待结算的预留额度", count: Number(u.unreconciled_leases) || 0, tone: "warn", hint: "有用量还没回报，稍后会自动结算" },
  ].filter(Boolean);
  const live = todo.filter((x) => x.count > 0);
  const daily = u.daily?.length ? panel("近 30 天每日用量", trendChart({ labels: u.daily.map((x) => x.day), series: [{ name: `用量（${fmt.unit(u.unit)}）`, values: u.daily.map((x) => Number(x.used) || 0), kind: "bar" }], format: (v) => (u.unit === "cny" ? fmt.cny(v, 0) : fmt.tokens(v)), tick: (l) => l.slice(5), height: 160 })) : panel("近 30 天每日用量", emptyBlock("近 30 天还没有用量"));
  add(
    pane,
    // 第二轮（04）：全为 0 时收成一行“无待办”，不占首屏三张空卡
    // 评审第二轮（K3）：有未确认告警时不写“没有待办”（下方告警卡就是待办）；没有任何待办时才写这一行
    live.length ? h("div", { class: "stack-sm" }, live.map((x) => h("button", { type: "button", class: ["banner", x.tone === "info" ? "info" : "warn", x.onClick && "clickable"], onclick: x.onClick, disabled: !x.onClick }, icon("info"), h("span", { class: "spacer" }, h("b", {}, `${x.label} ${fmt.int(x.count)}`), `：${x.hint}`), x.onClick ? h("span", { class: "link" }, "查看") : null))) : Number(t.alerts_open) > 0 ? null : h("p", { class: "no-todo" }, stateCell("没有待办", "ok"), h("span", { class: "muted small" }, o.personal ? "没有待开通的事项和未确认的告警" : "没有待开通、待批准的电脑和未确认的告警")),
    Number(t.alerts_open) > 0 ? panel("未确认的告警", alertsBox) : null,
    o.personal ? personCard(d, reload, o) : null,
    h("div", { class: "grid-2" }, quotaPanel(t, d), daily),
  );
  if (Number(t.alerts_open) > 0) load(alertsBox, () => api.get("/v1/ops/alerts", { status: "open", limit: 500 }), (r) => alertsBox.append(alertList((r.alerts ?? []).filter((a) => a.tid === t.tid), { onAck: reload })), "正在读取告警…");
}
/** 个人客户：账号持有人和他的电脑（全宽，电脑表的操作列不被裁） */
function personCard(d, reload, o) {
  const m = o.person;
  if (o.hidden.has("accounts")) return panel("这个人", note("你的角色没有“查看账号”权限：这里不显示姓名、邮箱与电脑清单。"));
  return panel(
    "这个人",
    h(
      "div",
      { class: "stack-sm" },
      m
        ? h("div", { class: "person-head" }, h("span", { class: "avatar lg", "aria-hidden": "true" }, String(m.name || m.email || "?").slice(0, 1).toUpperCase()), h("div", { class: "cell-2" }, h("button", { type: "button", class: "link strong", onclick: () => go(`people/${encodeURIComponent(m.aid)}`) }, m.name ?? m.email ?? "—"), h("small", {}, m.email ?? "")), btn("打开用户详情", () => go(`people/${encodeURIComponent(m.aid)}`), { size: "sm" }))
        : note("还没有账号"),
      deviceTable((d.devices ?? []).map((x) => ({ ...x, member_name: x.member_name ?? m?.name })), { state: st.devTable, after: reload, showTenant: false, showMember: false, empty: "还没有登记电脑：律师在客户端登录后出现在这里" }),
    ),
    { sub: "新电脑直接登录即可；同时登录的电脑满额时，先让一台退出登录" },
  );
}

function noAccounts(pane, d) {
  const t = d.tenant ?? {};
  pane.append(panel("成员与电脑", h("div", { class: "stack-sm" }, note("你的角色没有“查看账号”权限：只显示人数与席位，不显示姓名、手机号与电脑清单。"), facts([["成员", `${fmt.int(t.member_count ?? (d.members ?? []).length)} 人`], ["席位", `${fmt.int(t.seats_used)} 在用 / ${fmt.int(t.seats)}`], ["电脑", `${fmt.int(t.devices)} 台（未移除）`]]))));
}
// ─── 成员与席位（团队，D-306 第 2 条） ──────────────────────────────
function paneMembers(pane, d, reload) {
  if (new Set(d.hidden ?? []).has("accounts")) return noAccounts(pane, d);
  const box = h("div", { class: "stack-sm" });
  pane.append(box);
  // 评审（跨页 9）：团队身份的姓名取邀请上写的名字（契约设计）；运营视图在旁边写“本人：某某”，与用户列表对得上
  load(box, () => Promise.all([api.get("/v1/ops/accounts", { tid: d.tenant?.tid, limit: 200 }).catch(() => ({ accounts: [] })), loadPeople()]), ([r, people]) => drawMembers(box, d, r.accounts ?? [], reload, new Map(people.map((p) => [p.aid, p]))), "正在读取成员…");
}
function drawMembers(box, d, accs, reload, people = new Map()) {
  const t = d.tenant ?? {};
  const byAid = new Map(accs.map((a) => [a.aid, a]));
  const usage = new Map((d.usage?.by_account ?? []).filter((x) => x.aid).map((x) => [x.aid, x]));
  const joins = d.join_requests ?? [];
  const pendingOf = (aid) => joins.filter((j) => j.aid && j.aid === aid).length;
  const rows = (d.members ?? []).map((m) => ({ ...m, acc: m.aid ? byAid.get(m.aid) ?? null : null, use: m.aid ? usage.get(m.aid) ?? null : null, pend: m.aid ? pendingOf(m.aid) : 0, seated: !!(m.seat && !m.seat.revoked_at) }));
  const tools = h("div", { class: "toolbar" });
  const batch = h("div");
  const tableBox = h("div");
  const STATUS = [
    ["", "全部（含已移出）", () => true],
    ["active", "正常", (m) => m.acc?.status === "active" && !m.acc?.locked],
    ["locked", "已锁定", (m) => !!m.acc?.locked],
    ["disabled", "已停用 / 移出", (m) => m.acc?.status === "disabled"],
    ["unseated", "未占席", (m) => !!m.aid && !m.seated && m.acc?.status !== "disabled"],
  ];
  const drawBatch = () => {
    const ids = [...st.sel].filter((aid) => byAid.has(aid));
    clear(batch, ids.length ? h("div", { class: "batch-bar" }, h("b", {}, `已选 ${ids.length} 人`), btn("设电脑数上限…", () => batchLimit(ids, accs, reload), { size: "sm", disabled: !can("account.manage"), title: needs("account.manage") }), btn("全部退出登录…", () => batchSignout(ids, reload), { size: "sm", disabled: !canSupport(), title: canSupport() ? undefined : needs("account.support") }), btn("取消选择", () => (st.sel.clear(), draw()), { size: "sm", kind: "ghost" })) : null);
  };
  const statusOf = (m) => (!m.acc ? h("span", { class: "muted" }, "—") : m.acc.status === "disabled" ? wsStatusCell(m.acc) : m.acc.locked ? stateCell("已锁定", "warn", "登录失败次数过多，暂时锁定") : stateCell("正常", "ok"));
  const draw = () => {
    const f = STATUS.find((x) => x[0] === st.pstatus)?.[2] ?? (() => true);
    clear(
      tools,
      searchInput({ placeholder: "姓名、手机号、邮箱", value: st.pq, onInput: (v) => ((st.pq = v), drawTable()) }),
      h("span", { class: "seg-label" }, "状态"),
      segmented(STATUS.map(([id, label, fn]) => ({ id, label, count: rows.filter(fn).length })), st.pstatus, (v) => ((st.pstatus = v), draw()), "状态"),
      h("span", { class: "spacer" }),
      // 第 72 批（D-306 第 3 条）：代建成员只留这一个入口——运营代发团队邀请（POST /v1/ops/tenants/{tid}/invites，account.manage，C-9）
      btn("邀请成员…", () => inviteMember(t, reload), { kind: "primary", icon: icon("plus"), size: "sm", disabled: !can("account.manage") || isPersonal(t), title: isPersonal(t) ? "个人空间要先升级为团队" : needs("account.manage") }),
    );
    const drawTable = () => {
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
          onRow: (m) => m.aid && go(`people/${encodeURIComponent(m.aid)}`),
          empty: rows.length ? "没有符合条件的成员" : "还没有成员。点右上角“邀请成员”发团队邀请码，对方用自己的手机号登录后输入即可加入。",
          rowClass: (m) => (m.acc?.status === "disabled" ? "dim" : m.acc?.locked || m.pend ? "flagged" : ""),
          caption: "成员",
          columns: [
            { key: "_sel", label: headBox, sortable: false, class: "sel", render: (m) => (m.aid ? h("input", { type: "checkbox", "aria-label": `选择 ${m.name ?? m.email}`, checked: st.sel.has(m.aid), onchange: (ev) => (ev.currentTarget.checked ? st.sel.add(m.aid) : st.sel.delete(m.aid), drawTable()) }) : null) },
            { key: "name", label: "成员", value: (m) => m.name ?? "", render: (m) => (m.aid ? ((pr) => h("div", { class: "cell-2" }, h("b", {}, m.name ?? "—"), h("small", {}, [pr && pr.name && pr.name !== m.name ? `本人：${pr.name}` : null, m.acc?.phone, m.email].filter(Boolean).join(" · "))))(m.acc?.person ? people.get(m.acc.person) : null) : h("div", { class: "cell-2" }, h("b", { class: "muted" }, "未建账号的成员"), h("small", {}, m.seat ? `席位 ${m.seat.sid}` : "旧租户入组"))) },
            { key: "role", label: "角色", value: (m) => roleText(m.role) },
            { key: "status", label: "状态", value: (m) => (m.acc ? (m.acc.status === "disabled" ? 2 : m.acc.locked ? 1 : 0) : 3), render: statusOf },
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
            { key: "seat", label: "席位", title: `${SEAT_NOTE}；${UNSEATED_TIP}`, value: (m) => (m.seated ? 1 : 0), render: (m) => (m.acc?.status === "disabled" && !m.seated ? h("span", { class: "muted" }, "—") : m.seated ? stateCell("已占席", "ok") : m.seat?.revoked_at ? stateCell(`已释放 ${fmt.date(m.seat.revoked_at)}`, "neutral", UNSEATED_TIP) : stateCell("未占席", "neutral", UNSEATED_TIP)) },
            { key: "use", label: "占本期额度", num: true, title: "本期用量 ÷ 本期总额度", value: (m) => Number(m.use?.used_ratio_of_firm) || 0, render: (m) => (m.use ? fmt.pct(m.use.used_ratio_of_firm) : "0%") },
            { key: "_act", label: "", sortable: false, class: "act", render: (m) => rowMenu(memberOpsActions(t, m, reload), { aria: `操作：${m.name ?? m.email ?? "成员"}` }) },
          ],
        }),
      );
    };
    drawTable();
  };
  // 第 72 批（W-3）：团队邀请列表（GET /v1/ops/tenants/{tid}/invites，account.read，不含码）与撤回（account.manage）
  const invBox = h("div");
  clear(box, note("运营可代发邀请、改角色、移出成员，与团队管理员在“本所 · 成员”里做的是同一件事，都记审计。"), tools, batch, tableBox, panel("团队邀请", invBox, { flush: true, sub: "邀请码只在生成时显示一次；未接受的可以撤销" }));
  draw();
  load(invBox, () => api.get(`${api.T(t.tid)}/invites`), (r) => clear(invBox, inviteTable(r.invites ?? [], { onRevoke: (x) => revokeInviteOps(t, x, reload), revokeTitle: needs("account.manage") })), "正在读取邀请…");
}
async function revokeInviteOps(t, x, reload) {
  const ok = await confirmAction({ title: `撤销给${x.name}的邀请`, danger: true, lead: h("p", {}, `${t.name ?? t.tid} · ${roleText(x.role)}`), consequences: ["这个邀请码立即不能再用；", "已经加入的成员不受影响；记入这家客户的操作记录。"], confirmLabel: "撤销", run: () => api.post(`${api.T(t.tid)}/invites/${api.seg(x.id)}/revoke`) });
  if (ok) (toast("已撤销邀请"), reload());
}
/**
 * 成员行能做的事（运营；D-306 第 2 条）：打开用户详情、改角色、分配 / 释放席位、平台停用 / 启用、移出团队。
 * 改角色与移出走 POST /v1/ops/tenants/{tid}/members/{aid}/role|remove（account.manage；移出是危险操作要复核），约束同本所：最后一名管理员不能降级或移出。
 */
export function memberOpsActions(t, m, reload) {
  const acc = m.acc;
  const off = acc?.status === "disabled";
  return [
    m.aid ? { label: "打开用户详情", onClick: () => go(`people/${encodeURIComponent(m.aid)}`) } : null,
    m.pend ? { label: "查看待批准的电脑", onClick: () => go(`tenants/${encodeURIComponent(t.tid)}?tab=devices&dstatus=pending`) } : null,
    m.aid && !m.seated && !off ? { label: "分配席位…", onClick: () => assignSeatOps(t, m, reload), disabled: !can("device.revoke"), title: needs("device.revoke") } : null,
    m.seated ? { label: "释放席位…", danger: true, onClick: () => revokeSeat(t, m, reload), disabled: !can("device.revoke"), title: needs("device.revoke") } : null,
    acc && off ? { label: "启用…", onClick: () => enableMember(acc, reload), disabled: !canSupport() || wsStatus(acc) === "team", title: wsStatus(acc) === "team" ? "团队管理员移出的成员，由团队管理员处理" : canSupport() ? undefined : needs("account.support") } : null,
    acc && !off ? { label: "改角色…", onClick: () => changeRoleOps(t, m, reload), disabled: !can("account.manage"), title: needs("account.manage") } : null,
    acc && !off ? { label: "停用（平台停用）…", danger: true, onClick: () => disableMember(t, m, reload), disabled: !can("account.manage"), title: needs("account.manage") } : null,
    acc && !off ? { label: "移出团队…", danger: true, onClick: () => removeMemberOps(t, m, reload), disabled: !can("account.manage"), title: needs("account.manage") } : null,
  ];
}
async function changeRoleOps(t, m, reload) {
  const r = await confirmAction({
    title: `改${m.name ?? "成员"}的角色`,
    lead: h("p", { class: "muted" }, `${t.name ?? t.tid}：代团队管理员操作，记入这家客户的操作记录`),
    fields: [{ name: "role", label: "角色", type: "radio", options: [["lawyer", ROLE.lawyer, "处理自己的事项"], ["assistant", ROLE.assistant, "协助律师"], ["partner", ROLE.partner, "另可只读查看“本所”"], ["admin", ROLE.admin, "管理成员、席位、电脑与团队设置"]], value: m.role }],
    consequences: ["立即生效；他下次刷新或重新登录时看到新权限；", "最后一名管理员不能降级；管理员降级时，他发出的未接受邀请一并撤销。"],
    confirmLabel: "保存",
    run: (v) => (v.role === m.role ? { ok: true, unchanged: true } : api.post(`${api.T(t.tid)}/members/${api.seg(m.aid)}/role`, { role: v.role })),
  });
  if (r) (toast(r.unchanged ? "没有改动" : "已改角色"), reload());
}
async function removeMemberOps(t, m, reload) {
  const r = await confirmAction({
    title: `把${m.name ?? "成员"}移出${t.name ?? t.tid}`,
    danger: true,
    consequences: [
      "他在本团队的登录立即失效，名下电脑不能再用本团队的 AI；",
      "席位释放；电脑记录保留，事项与材料在他自己的电脑上；",
      "账号不删除：个人空间与别的团队照常可用；要再加入须重新邀请。",
    ],
    typeToConfirm: m.name ?? m.aid,
    typeLabel: "再输入一次成员姓名以确认：",
    confirmLabel: "移出团队",
    run: () => api.post(`${api.T(t.tid)}/members/${api.seg(m.aid)}/remove`),
  });
  if (r) (toast(r.seat_released ? "已移出团队，席位已释放" : "已移出团队"), reload());
}
/** 平台停用这名成员在本团队的身份（其他工作空间不受影响）；可一并收回席位 */
async function disableMember(t, m, reload) {
  const seatLive = m.seated && can("device.revoke");
  const r = await confirmAction({
    title: `停用 ${m.name ?? ""} · ${t.name ?? t.tid}`,
    danger: true,
    consequences: ["这名成员在本团队的全部登录立即失效：名下电脑约 15 秒内暂停 AI（本机功能照常）；", "记为“平台停用”：团队管理员不能自行启用；", "这个人的个人空间与别的团队不受影响；用量与审计记录保留。"],
    fields: [{ name: "reason", label: "停用原因（记入审计，本人可见）", type: "textarea", required: true, maxlength: 100 }, seatLive ? { name: "seat", label: "同时释放席位", type: "checkbox", value: true, hint: "席位空出可分给别人" } : null].filter(Boolean),
    confirmLabel: "停用",
    run: async (v) => {
      await api.post(`${api.A(m.aid)}/disable`, { reason: v.reason });
      if (v.seat) await api.post(`${api.T(t.tid)}/seats/${api.seg(m.uid ?? m.seat?.sid)}/revoke`).catch(() => null);
      return true;
    },
  });
  if (r) (toast("已停用"), reload());
}
async function enableMember(acc, reload) {
  const ok = await confirmAction({ title: `启用 ${acc.name ?? ""}`, consequences: ["本人可再次登录这个团队；之前失效的登录不恢复，须重新登录；", "同时解除登录失败锁定。"], confirmLabel: "启用", run: () => api.post(`${api.A(acc.aid)}/enable`) });
  if (ok) (toast("已启用"), reload());
}
/** 运营分配席位（契约 §8；权限与收回席位同为 device.revoke，C-9） */
async function assignSeatOps(t, m, reload) {
  const ok = await confirmAction({
    title: "分配席位",
    lead: h("p", {}, `${t.name ?? t.tid} · ${m.name ?? m.email ?? ""}（已用 ${fmt.int(t.seats_used)} / 共 ${fmt.int(t.seats)} 席）`),
    consequences: ["这名成员立即可以用 AI（席位 = 能用 AI 的名额）；", "不超过席位数：已满时会被拒绝，请先改套餐或席位。"],
    confirmLabel: "分配",
    run: () => api.post(`${api.T(t.tid)}/seats/${api.seg(m.aid)}/assign`),
  });
  if (ok) (toast("已分配席位"), reload());
}
/** 运营代发团队邀请：返回一次性码（只显示这一次），对方凭码加入 */
export async function inviteMember(t, reload) {
  const r = await confirmAction({
    title: `邀请成员加入 ${t.name ?? t.tid}`,
    lead: h("p", { class: "muted" }, "生成一次性团队邀请码（7 天有效）。对方用自己的手机号登录客户端或控制台后输入；没注册的人注册时填这个码，直接进团队。"),
    fields: [
      { name: "name", label: "姓名", required: true, maxlength: 40, hint: "成员在团队里显示的名字" },
      { name: "role", label: "角色", type: "select", options: [["lawyer", ROLE.lawyer], ["assistant", ROLE.assistant], ["partner", ROLE.partner], ["admin", ROLE.admin]], value: "lawyer" },
      { name: "phone_hint", label: "手机号（选填）", type: "tel", placeholder: "如 13900001234", hint: "只保存脱敏后的号码（如 139****1234），用来核对是谁；不会发短信" },
    ],
    consequences: ["席位不在发邀请时占用：接受后有空席即可用 AI，席位已满时能加入但用不了 AI；", "邀请码只显示这一次，请当面或经安全渠道交给本人。"],
    confirmLabel: "生成邀请码",
    run: (v) => api.post(`${api.T(t.tid)}/invites`, { name: v.name.trim(), role: v.role, ...(v.phone_hint ? { phone_hint: v.phone_hint.trim() } : {}) }),
  });
  if (r?.code) {
    await showSecret({ title: `团队邀请码 · ${r.invite?.name ?? ""}`, secret: r.code, expiresAt: r.invite?.expires_at, note: `${t.name ?? t.tid} · ${roleText(r.invite?.role)}。对方在客户端“加入团队”或注册页填这个码。` });
    reload?.();
  }
}

// ─── 电脑（团队；D-306 第 2 条：同时登录、待批准） ───────────────────
function paneDevices(pane, d, reload) {
  const t = d.tenant ?? {};
  if (new Set(d.hidden ?? []).has("accounts")) return noAccounts(pane, d);
  const joins = d.join_requests ?? [];
  const devRows = [...(d.devices ?? []), ...joins.map((j) => pendingRow(j, { tid: t.tid, tenant_name: t.name }))];
  const tools = h("div", { class: "toolbar" });
  const tableBox = h("div");
  const draw = () => {
    const df = DSTATUS.find(([id]) => id === st.dstatus)?.[2] ?? (() => true);
    clear(tools, searchInput({ placeholder: "电脑名称、成员、版本", value: st.pq, onInput: (v) => ((st.pq = v), draw()) }), h("span", { class: "seg-label" }, "状态"), segmented(DSTATUS.map(([id, label, fn]) => ({ id, label, count: devRows.filter(fn).length })), st.dstatus, (v) => ((st.dstatus = v), draw()), "电脑状态"));
    clear(tableBox, deviceTable(devRows.filter((x) => df(x) && matches(st.pq, x.name, x.device_id, x.member_name, x.email, x.client_version)), { state: st.devTable, after: reload, showTenant: false, team: true, confirmHint: "由团队管理员在管理员电脑上确认", empty: "还没有登记电脑：成员在客户端登录后出现在这里" }));
  };
  add(
    pane,
    note(t.member_device_policy === "approve" ? "新电脑须团队管理员确认后才能登录。" : "新电脑：成员自己登录即可；要接收团队共享事项的电脑须团队管理员确认。"),
    tools,
    tableBox,
  );
  draw();
}
/** 收回席位：有成员编号按成员编号，没有账号的成员按席位编号（第 71 批 I-6，B-4：原先拼出 seats/null/revoke 必然 404） */
export async function revokeSeat(t, m, reload) {
  const key = m.uid ?? m.seat?.sid;
  const ok = await confirmAction({
    title: "释放席位",
    danger: true,
    lead: h("p", {}, `${t.name ?? t.tid} · ${m.name ?? m.email ?? `席位 ${m.seat?.sid ?? ""}`}`),
    consequences: ["这名成员的席位令牌不再续签，到期后不能用 AI；本机功能照常；", "席位空出可分给别人；用量记录保留。"],
    confirmLabel: "释放",
    run: () => api.post(`${api.T(t.tid)}/seats/${api.seg(key)}/revoke`),
  });
  if (ok) (toast("已释放席位"), reload?.());
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
      panel("本期额度", h("div", { class: "stack-sm" }, meter({ label: "已用", ratio: u.used_ratio, used: u.used, total: u.total, unit: u.unit, resetsAt: u.period?.resets_at ?? t.period?.resets_at, capPct: t.cap_pct, inflight: t.in_flight_ratio }), u.burst ? meter({ label: `近 ${u.burst.hours} 小时用量`, ratio: u.burst.used_ratio, resetText: "随时间逐步恢复" }) : null)),
      panel("历史周期", periodBars(u.history ?? []), { sub: "每期已用比例" }),
    ),
    panel(
      "近 30 天每日",
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
          onRow: (x) => x.aid && go(`people/${encodeURIComponent(x.aid)}`),
          empty: "本期还没有成员用量",
          columns: [
            { key: "name", label: "成员", value: (x) => x.name ?? x.email ?? "", render: (x) => (x.aid ? h("div", { class: "cell-2" }, h("b", {}, x.name ?? "—"), h("small", {}, x.email ?? "")) : h("span", { class: "muted" }, x.uid ? "未关联账号" : "—")) },
            { key: "used", label: "用量", num: true, value: (x) => Number(x.used) || 0, render: (x) => fmt.amount(x.used, u.unit) },
            { key: "used_ratio_of_firm", label: "占本期额度", title: "本期用量 ÷ 本期总额度", num: true, value: (x) => Number(x.used_ratio_of_firm) || 0, render: (x) => fmt.pct(x.used_ratio_of_firm) },
            { key: "own_ratio", label: "占个人上限", title: "管理员给这名成员单设的本期上限；没单设的不算", num: true, value: (x) => x.own_ratio ?? null, render: (x) => (x.own_ratio === null || x.own_ratio === undefined ? h("span", { class: "muted" }, "不单设") : fmt.pct(x.own_ratio)) },
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
  );
}
/** 本期账单（第 72 批移到“用量与账单”页签） */
function billPanel(d) {
  const t = d.tenant ?? {};
  const b = d.bill;
  return (
    b
      ? panel(
          "本期账单",
          h(
            "div",
            { class: "stack-sm" },
            h("div", { class: "kpis" }, stat("本期应收", fmt.cny(b.revenue_cny), `席位费 ${fmt.cny(b.seat_fee_cny)} + 加量费 ${fmt.cny(b.boost_fee_cny)}`), stat("用量价值", fmt.cny(b.value_cny)), stat("模型成本", fmt.cny(b.cost_cny)), stat("毛利", fmt.cny(b.margin_cny), undefined, { tone: Number(b.margin_cny) < 0 ? "danger" : undefined })),
            facts([
              b.seat_price_cny === null || b.seat_price_cny === undefined ? ["席位费", "试用期不计费"] : ["席位 × 单价", `${fmt.int(b.seats)} × ${fmt.cny(b.seat_price_cny)}`],
              ["加量", b.boost_pct ? `+${b.boost_pct}%（${fmt.cny(b.boost_fee_cny)}）` : "无"],
              ["请求 / token", `${fmt.int(b.requests)} 次 / ${fmt.tokens(b.tokens)}`],
            ]),
          ),
          { actions: btn("去计费页", () => go(`billing?q=${encodeURIComponent(t.tid)}`), { size: "sm" }) },
        )
      : new Set(d.hidden ?? []).has("billing")
        ? note("本期账单只对有“查看账单”权限的人员显示。")
        : null
  );
}
/** 用量与账单：本期 / 历史 / 每日 / 按模型 / 按成员，加本期账单 */
function paneUsageBill(pane, d) {
  paneUsage(pane, d);
  add(pane, billPanel(d));
}
const stat = (label, value, sub, o = {}) => h("div", { class: ["stat", o.tone && `tone-${o.tone}`] }, h("div", { class: "stat-label" }, label), h("div", { class: "stat-value num" }, value), sub ? h("div", { class: "stat-sub" }, sub) : null);

// ─── 订阅与开通 ────────────────────────────────────────────────────
function paneSubscription(pane, d, reload) {
  const t = d.tenant ?? {};
  const T = api.T(t.tid);
  // 订阅在前，套餐 / 加量 / 上限 / 账号登录随后（原“套餐与额度”页签并入，第 72 批）
  const planBox = h("div");
  panePlan(planBox, d, reload);
  add(
    pane,
    h(
      "div",
      { class: "grid-2" },
      panel("订阅", h("div", { class: "stack-sm" }, facts([["到期", fmt.date(t.subscription_until)], ["状态", t.status === "pending" && t.created_via === "self" ? badge(PENDING_SELF, "info") : tenantBadge(t.status)], ["授权有效至", fmt.date(d.license?.expires_at)]]), h("div", { class: "btn-row" }, btn("续订…", () => renew(t, reload), { disabled: !can("tenant.manage") || t.status === "terminated", title: needs("tenant.manage") })))),
      panel(
        "类型与成员",
        isPersonal(t)
          ? facts([["类型", "个人空间（一人）"], ["说明", "个人律师可在客户端把工作室升级为团队（就地升级，事项、电脑不动）；升级后才能邀请同事"]])
          : facts([["类型", "团队"], ["成员新电脑", t.member_device_policy === "approve" ? "须团队管理员确认后才能登录" : "成员自己登录即可；接收团队共享事项的电脑须管理员确认"], ["加成员", h("span", {}, "在“成员与席位”里", h("button", { type: "button", class: "link", onclick: () => go(`tenants/${encodeURIComponent(t.tid)}?tab=members`) }, "邀请成员"), "（运营代发团队邀请，对方凭码加入）")]]),
      ),
    ),
    planBox,
    t.created_via === "self" && !(d.activation_codes ?? []).length ? null : panel(
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
  "account.register": "注册账号",
  "account.phone_bind": "绑定手机号",
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
  "seat.assign": "占用 / 分配席位",
  "workspace.upgrade_team": "升级为团队",
  "team.invite_create": "发团队邀请",
  "team.invite_revoke": "撤销团队邀请",
  "team.invite_accept": "接受团队邀请",
  "team.member_remove": "移出团队",
  "team.leave": "退出团队",
  "team.member_device_policy": "改成员新电脑策略",
  "account.role": "改角色",
  "account.reset_sms": "给本人发重置短信",
  "account.workspace_switch": "切换工作空间",
  "seat.revoke": "释放席位",
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
  ["account", "账号与成员", (a) => /^(account|team|workspace)\./.test(a)],
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
const DETAIL_LABEL = { seats: "席位", seats_from: "原席位", seats_to: "新席位", pct: "加量 %", cap_pct: "上限 %", days: "续订天数", seat_released: "释放席位", seat_reassigned: "还回席位", renamed: "改名", trial: "试用期", approve: "须确认", admin: "管理员", invites_revoked: "撤销邀请" };
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
  const who = (x) => labels[x.actor?.id] ?? `${ACTOR[x.actor?.kind] ?? "系统"}`;
  const targetText = (x) => (x.target ? labels[x.target] ?? (String(x.target).startsWith("fp:") ? "电脑" : String(x.target).startsWith("seat_") ? "席位" : String(x.target).startsWith("dev_") ? "电脑" : String(x.target).startsWith("acc_") ? "账号" : String(x.target).startsWith("act_") ? "开通码" : x.target) : "—");
  const link = (id) => {
    const k = kinds[id];
    if (k === "account" && String(id).startsWith("acc_")) return () => go(`people/${encodeURIComponent(id)}`);
    if (k === "join") return () => o.setTab(o.personal ? "overview" : "devices", "pending");
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
  const drawRows = () => (setTimeout(() => drawMore?.(), 0),
    clear(
      box,
      dataTable({
        state: { sort: "seq", asc: false },
        rows: filtered(),
        empty: rows.length ? "没有符合条件的记录" : "还没有操作记录",
        rowClass: (x) => (failed(x) ? "danger-row" : ""),
        columns: [
          { key: "at", label: "时间", value: (x) => x.at ?? "", render: (x) => h("span", { class: "nowrap" }, fmt.full(x.at)) },
          { key: "action", label: "动作", value: (x) => actionText(x.action), render: (x) => h("div", { class: "cell-2" }, ACTION_LABEL[x.action] ? h("span", { title: x.action }, ACTION_LABEL[x.action]) : mono(x.action ?? "—"), x.detail && Object.keys(x.detail).length ? h("small", {}, Object.entries(x.detail).map(([k, v]) => `${DETAIL_LABEL[k] ?? k} ${v}`).join(" · ")) : null) },
          { key: "actor", label: "操作人", value: (x) => who(x), render: (x) => cell(x.actor?.id, who(x)) },
          { key: "target", label: "对象", value: (x) => targetText(x), render: (x) => (!x.target ? h("span", { class: "muted" }, "—") : x.target === x.actor?.id ? h("span", { class: "muted", title: nameOnly(targetText(x)).title ?? undefined }, "本人") : cell(x.target, targetText(x))) },
          { key: "result", label: "结果", value: (x) => (failed(x) ? 0 : 1), render: (x) => (failed(x) ? badge(/^rejected/.test(String(x.result)) ? "被拒绝" : "未完成", "danger", String(x.result ?? "")) : h("span", { class: "muted" }, "成功")) },
          { key: "seq", label: "序号", num: true, class: "muted-col", value: (x) => Number(x.seq) || 0 },
        ],
      }),
    ));
  const exportCsv = () => {
    const list = filtered().sort((a, b) => (Number(b.seq) || 0) - (Number(a.seq) || 0));
    saveCsv([["时间", "动作", "事件码", "操作人", "对象", "结果", "序号"], ...list.map((x) => [fmt.full(x.at), actionText(x.action), x.action ?? "", who(x), targetText(x), failed(x) ? String(x.result ?? "") : "成功", x.seq])], `操作记录-${t.tid}-${new Date().toISOString().slice(0, 10)}.csv`);
  };
  // 表尾计数跟筛选走：筛选一变就重画
  const drawMore = () => clear(more, oldest && oldest > 1 ? h("div", { class: "more" }, h("span", { class: "muted small" }, `显示 ${fmt.int(filtered().length)} 条${f.noLogin ? "（不含登录）" : ""} / 已载入 ${fmt.int(rows.length)} 条　`), btn("加载更多", () => fetchMore(), { size: "sm" })) : rows.length ? h("p", { class: "muted small center" }, `共 ${fmt.int(filtered().length)} 条${f.noLogin ? "（不含登录）" : ""} / 全部 ${fmt.int(rows.length)} 条`) : null);
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
        drawMore();
      },
      (e) => clear(more, e?.code === "not_ready" ? h("div", { class: "state state-notready" }, h("b", {}, "云端版本过旧"), h("p", {}, "这台控制面还不提供客户的操作记录；升级后这里会显示。")) : errorBlock(e, fetchMore)),
    );
  };
  fetchMore();
}

// 供账号详情复用
export { accountBadge, tenantState };
