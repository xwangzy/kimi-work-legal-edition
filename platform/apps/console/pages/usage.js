/**
 * 用量：按日 / 模型（别名）/ 上游型号 / 律所 / 账号的分布；逐请求明细（请求编号检索、筛选、导出）；对账提示。
 * 接口：GET /v1/ops/usage/summary、GET /v1/ops/usage/records、GET /v1/ops/usage/records.csv（契约 §6；第 62 批 contract-b62-pricing §3、§4.1）。
 * 第 62 批口径：
 *   - 待对账（reconcile: "pending"）= 上游没给真实用量、按估算记：不计入额度与金额，估算金额另列（不进合计）；
 *   - partial = 流式中途服务出错：不计费（原先徽章写“按已转发内容估算计费”，与实际不符，已改）；
 *   - 价目生效前 = 行发生时价目里还没有它的价格：不改写，金额“未定价”，另给“按现行价估算”（只读）。
 */
import * as api from "../api.js";
import { billingBadges, ctx, go as goTo, OUTCOME, outcomeBadge, pageHead, sourceBadge, tenantOptions, USAGE_SOURCE } from "../domain.js";
import {
  badge, bjDay, btn, clear, dataTable, emptyBlock, errorBlock, facts, field, fmt, h, hbars, icon, load, loadingBlock, mono, note, openDrawer, panel,
  readForm, segmented, stat, tabBar, toast, trendChart,
} from "../ui.js";

const monthStart = () => `${bjDay().slice(0, 7)}-01`;
const st = {
  from: monthStart(),
  to: bjDay(),
  tid: "",
  aid: "",
  group: "day",
  alias: "",
  outcome: "",
  request_id: "",
  view: "summary",
  sTable: { sort: "key", asc: true },
  rTable: { sort: "at", asc: false },
};

export function render(page, r) {
  for (const k of ["from", "to", "tid", "aid", "group", "alias", "outcome", "request_id", "view"]) if (r.params[k] !== undefined) st[k] = r.params[k];
  if (r.params.request_id) st.view = "records";
  const filters = h("div");
  const viewSeg = h("div");
  const box = h("div", { class: "stack" });
  page.append(pageHead("用量", "逐请求一条账：按请求编号去重、按价目版本重算费用；额度与账单都从这一份账出"), viewSeg, filters, box);
  const drawSeg = () => clear(viewSeg, tabBar([{ id: "summary", label: "分布" }, { id: "records", label: "逐请求明细" }], st.view, (v) => ((st.view = v), drawSeg(), drawFilters(), run())));
  const specs = () => [
    { name: "from", label: "起", type: "date", value: st.from },
    { name: "to", label: "止", type: "date", value: st.to },
    { name: "tid", label: "律所", type: "select", options: tenantOpts, value: st.tid },
    { name: "aid", label: "账号编号", value: st.aid, placeholder: "acc_…" },
    ...(st.view === "records"
      ? [
          { name: "alias", label: "模型别名", value: st.alias, placeholder: "legal/k3" },
          { name: "outcome", label: "结果", type: "select", options: [["", "全部"], ...Object.entries(OUTCOME).map(([k, [l]]) => [k, l])], value: st.outcome },
          { name: "request_id", label: "请求编号", value: st.request_id, placeholder: "请求编号或客户端请求编号" },
        ]
      : []),
  ];
  let tenantOpts = [["", "全部律所"]];
  const drawFilters = () => {
    const sp = specs();
    const f = h(
      "form",
      { class: "filters", novalidate: true },
      sp.map((x) => field({ ...x, class: `f-${x.name}` })),
      h("div", { class: "filter-actions" }, h("button", { type: "submit", class: "btn primary" }, "查询"), btn("重置", () => {
        Object.assign(st, { from: monthStart(), to: bjDay(), tid: "", aid: "", alias: "", outcome: "", request_id: "" });
        drawFilters();
        run();
      })),
    );
    f.addEventListener("submit", (ev) => {
      ev.preventDefault();
      Object.assign(st, readForm(f, sp));
      run();
    });
    clear(filters, f);
  };
  const run = () => (st.view === "records" ? runRecords(box) : runSummary(box));
  drawSeg();
  drawFilters();
  tenantOptions().then((o) => {
    tenantOpts = o;
    drawFilters();
  });
  run();
}

const range = () => ({ from: st.from, to: st.to, tid: st.tid, aid: st.aid });
/** 分组：模型 = 客户端用的别名；上游型号 = 实际服务的型号（成本对账用） */
const GROUPS = [
  ["day", "日"],
  ["model", "模型"],
  ["upstream", "上游型号"],
  ["tenant", "律所"],
  ["account", "账号"],
];
const groupLabel = (g) => GROUPS.find(([id]) => id === g)?.[1] ?? g;

function runSummary(box) {
  const groupBox = h("span");
  const body = h("div", { class: "stack" });
  const drawGroup = () =>
    clear(groupBox, segmented(GROUPS.map(([id, label]) => ({ id, label: `按${label}` })), st.group, (g) => ((st.group = g), drawGroup(), go()), "分组"));
  const go = () =>
    load(
      body,
      async () => {
        const [s, o] = await Promise.allSettled([api.get("/v1/ops/usage/summary", { ...range(), group: st.group }), api.get("/v1/ops/overview", { days: 7 })]);
        if (s.status === "rejected") throw s.reason;
        return { s: s.value, ov: o.status === "fulfilled" ? o.value : null };
      },
      ({ s, ov }) => drawSummary(body, s, ov),
      "正在汇总…",
    );
  clear(box, h("div", { class: "toolbar" }, groupBox), body);
  drawGroup();
  go();
}

const tokensOf = (r) => (Number(r.tokens_in) || 0) + (Number(r.tokens_out) || 0);
const nz = (v) => Number(v) > 0;
function drawSummary(body, s, ov) {
  const rows = s.rows ?? [];
  const t = s.totals ?? {};
  const chart = !rows.length
    ? emptyBlock("这段时间没有用量")
    : st.group === "day"
      ? trendChart({ labels: rows.map((r) => r.label ?? r.key), series: [{ name: "输入", values: rows.map((r) => Number(r.tokens_in) || 0), kind: "bar", stack: true }, { name: "输出", values: rows.map((r) => Number(r.tokens_out) || 0), kind: "bar", stack: true, cls: "s2" }], format: (v) => fmt.tokens(v), tick: (l) => String(l).slice(5), height: 220 })
      : hbars([...rows].sort((a, b) => tokensOf(b) - tokensOf(a)).slice(0, 12).map((r) => ({ label: r.label ?? (r.key || "未到达上游"), value: tokensOf(r), note: `${fmt.int(r.requests)} 次 · ${fmt.cny(r.value_cny)}`, title: r.key })), { format: (v) => `${fmt.tokens(v)} token` });
  const recon = ov?.totals ?? null;
  const errRate = Number(t.requests) > 0 ? Number(t.errors) / Number(t.requests) : null;
  const pending = Number(t.pending_reconcile) || 0;
  const unpriced = Number(t.unpriced) || 0;
  const hasEst = (v) => v !== null && v !== undefined;
  body.append(
    h(
      "div",
      { class: "kpis" },
      stat("请求", fmt.int(t.requests), errRate === null ? "所选范围" : `错误 ${fmt.int(t.errors)}（${fmt.pct(errRate)}）`, { tone: errRate !== null && errRate >= 0.05 ? "warn" : undefined }),
      stat("Token", fmt.tokens(tokensOf(t)), `输入 ${fmt.tokens(t.tokens_in)} · 输出 ${fmt.tokens(t.tokens_out)}`, { title: `${fmt.int(tokensOf(t))} token` }),
      stat("用量价值", fmt.cny(t.value_cny), "售价 × 实测用量"),
      stat("成本", fmt.cny(t.cost_cny), "成本价 × 实测用量"),
      stat("待对账", fmt.int(pending), pending ? `估算 ${fmt.cny(t.est_value_cny)}，不计入` : "没有", { tone: pending ? "warn" : undefined }),
      stat("价目生效前", fmt.int(unpriced), unpriced && hasEst(t.unpriced_est_value_cny) ? `按现行价约 ${fmt.cny(t.unpriced_est_value_cny)}` : unpriced ? "行，未定价" : "没有"),
    ),
    h(
      "div",
      { class: "grid-2-1" },
      panel("分布", chart, { sub: `${st.from} 至 ${st.to}（北京时间）` }),
      panel(
        "对账提示",
        h(
          "div",
          { class: "stack-sm" },
          facts([
            ["本期待对账行", recon ? fmt.int(recon.pending_reconcile ?? recon.estimated_rows) : "—"],
            ["本期价目生效前行", recon ? fmt.int(recon.unpriced_rows) : "—"],
            ["所选范围错误请求", fmt.int(t.errors)],
            ["所选范围待对账估算", pending ? `${fmt.cny(t.est_value_cny)}（成本 ${fmt.cny(t.est_cost_cny)}）` : "—"],
          ]),
          note(s.notes?.pending_reconcile ?? "上游没给真实用量、按估算记的行：不计入额度与金额，估算另列，待与上游账单对账。"),
          unpriced ? note(s.notes?.unpriced ?? "价目生效前的行没有金额（未改写）；“按现行价估算”按当前价目重算，只读。") : null,
          h("div", { class: "btn-row" }, btn("看上游出错的请求", () => ((st.view = "records"), (st.outcome = "upstream_error"), ctx.reload()), { size: "sm" })),
        ),
      ),
    ),
    panel(
      `按${groupLabel(st.group)}明细`,
      dataTable({
        state: st.sTable,
        rows,
        empty: "这段时间没有用量",
        rowClass: (r) => (nz(r.pending_reconcile) ? "estimated" : ""),
        columns: [
          { key: "key", label: groupLabel(st.group), value: (r) => r.label ?? r.key, render: (r) => (st.group === "upstream" && !r.key ? h("span", { class: "muted" }, "未到达上游") : r.label && r.label !== r.key ? h("div", { class: "cell-2" }, r.label, mono(r.key)) : mono(r.key)) },
          { key: "requests", label: "请求", num: true, render: (r) => fmt.int(r.requests) },
          { key: "tokens_in", label: "输入", num: true, render: (r) => h("span", { title: fmt.int(r.tokens_in) }, fmt.tokens(r.tokens_in)) },
          { key: "tokens_cached", label: "其中命中", num: true, class: "opt", render: (r) => h("span", { title: fmt.int(r.tokens_cached) }, fmt.tokens(r.tokens_cached)) },
          { key: "tokens_cache_write", label: "其中写入", num: true, class: "opt", render: (r) => h("span", { title: fmt.int(r.tokens_cache_write) }, fmt.tokens(r.tokens_cache_write)) },
          { key: "tokens_out", label: "输出", num: true, render: (r) => h("span", { title: fmt.int(r.tokens_out) }, fmt.tokens(r.tokens_out)) },
          { key: "value_cny", label: "用量价值", num: true, value: (r) => r.value_cny ?? null, render: (r) => fmt.cny(r.value_cny) },
          { key: "cost_cny", label: "成本", num: true, value: (r) => r.cost_cny ?? null, render: (r) => fmt.cny(r.cost_cny) },
          { key: "errors", label: "错误", num: true, render: (r) => (nz(r.errors) ? h("span", { class: "tone-text-danger" }, fmt.int(r.errors)) : "0") },
          { key: "pending_reconcile", label: "待对账", num: true, title: "上游没给真实用量、按估算记的行：不计费；悬停看估算金额", render: (r) => (nz(r.pending_reconcile) ? h("span", { class: "tone-text-warn", title: `估算 ${fmt.cny(r.est_value_cny)}（成本 ${fmt.cny(r.est_cost_cny)}），不计入` }, fmt.int(r.pending_reconcile)) : "0") },
          { key: "unpriced", label: "价目生效前", num: true, render: (r) => (nz(r.unpriced) ? h("span", { class: "tone-text-warn" }, fmt.int(r.unpriced)) : "0") },
          { key: "unpriced_est_value_cny", label: "按现行价估算", num: true, title: "价目生效前的行按当前价目重算（只读，不计入合计）", value: (r) => r.unpriced_est_value_cny ?? null, render: (r) => (hasEst(r.unpriced_est_value_cny) ? h("span", { class: "muted" }, fmt.cny(r.unpriced_est_value_cny)) : "—") },
        ],
        footer: rows.length
          ? { key: "合计", requests: fmt.int(t.requests), tokens_in: fmt.tokens(t.tokens_in), tokens_cached: fmt.tokens(t.tokens_cached), tokens_cache_write: fmt.tokens(t.tokens_cache_write), tokens_out: fmt.tokens(t.tokens_out), value_cny: fmt.cny(t.value_cny), cost_cny: fmt.cny(t.cost_cny), errors: fmt.int(t.errors), pending_reconcile: fmt.int(t.pending_reconcile), unpriced: fmt.int(t.unpriced), unpriced_est_value_cny: hasEst(t.unpriced_est_value_cny) ? fmt.cny(t.unpriced_est_value_cny) : "—" }
          : null,
      }),
      { flush: true, sub: s.price_version ? `现行价目 v${s.price_version}` : undefined },
    ),
  );
}

// ─── 逐请求明细 ────────────────────────────────────────────────────
function recParams() {
  return { ...range(), alias: st.alias, outcome: st.outcome, request_id: st.request_id };
}
function runRecords(box) {
  let rows = [];
  let next = null;
  const list = h("div");
  const exportBtn = btn("导出 CSV", async (ev) => {
    const b = ev.currentTarget;
    b.disabled = true;
    try {
      await api.downloadCsv("/v1/ops/usage/records.csv", recParams(), `kwl-usage-${st.from}_${st.to}.csv`);
      toast("已导出（至多 10 万行）");
    } catch (e) {
      toast(e.message, "error");
    } finally {
      b.disabled = false;
    }
  }, { icon: icon("download") });
  clear(box, h("div", { class: "toolbar" }, note("按时间倒序；点一行看完整账本行（计价依据、计费明细、切换记录）。左侧橙条 = 待对账（不计费）或出错。"), exportBtn), list);
  const fetchPage = async (append) => {
    if (!append) clear(list, loadingBlock("正在读取明细…"));
    try {
      const res = await api.get("/v1/ops/usage/records", { ...recParams(), limit: 50, cursor: append ? next : undefined });
      rows = append ? rows.concat(res.records ?? []) : res.records ?? [];
      next = res.next ?? null;
      draw();
    } catch (e) {
      clear(list, errorBlock(e, () => fetchPage(false)));
    }
  };
  const draw = () =>
    clear(
      list,
      dataTable({
        state: st.rTable,
        rows,
        onRow: openRecord,
        empty: st.request_id ? `没有请求编号为“${st.request_id}”的记录` : "这段时间没有记录",
        rowClass: (r) => (r.reconcile === "pending" || r.usage_source === "estimated" ? "estimated" : r.outcome && r.outcome !== "ok" ? "flagged" : ""),
        columns: [
          { key: "at", label: "时间", render: (r) => h("span", { title: fmt.full(r.at) }, fmt.time(r.at)) },
          { key: "request_id", label: "请求编号", render: (r) => mono(r.request_id) },
          { key: "tenant_name", label: "律所", value: (r) => r.tenant_name ?? r.tid },
          { key: "email", label: "账号", value: (r) => r.email ?? r.uid ?? "" },
          { key: "alias", label: "模型", render: (r) => h("div", { class: "cell-2" }, mono(r.alias), h("small", {}, `${r.provider ?? "—"} · ${r.upstream_model ?? "—"}`)) },
          { key: "outcome", label: "结果", render: (r) => h("span", { class: "badges" }, outcomeBadge(r.outcome), billingBadges(r), r.status && r.status !== 200 ? mono(String(r.status)) : null) },
          { key: "in", label: "输入", num: true, value: (r) => r.usage?.input ?? null, render: (r) => fmt.int(r.usage?.input) },
          { key: "cached", label: "缓存", num: true, value: (r) => r.usage?.cached ?? null, render: (r) => fmt.int(r.usage?.cached) },
          { key: "out", label: "输出", num: true, value: (r) => r.usage?.output ?? null, render: (r) => fmt.int(r.usage?.output) },
          { key: "usage_source", label: "来源", render: (r) => sourceBadge(r.usage_source) ?? h("span", { class: "muted" }, "上游") },
          { key: "value_micro", label: "价值", num: true, value: (r) => r.value_micro ?? null, render: (r) => (r.reconcile === "pending" ? h("span", { class: "muted", title: `估算 ${fmt.cny(r.est_value_cny, 4)}，不计入` }, "不计费") : fmt.cny(r.value_micro === null || r.value_micro === undefined ? r.value_micro : r.value_micro / 1e6, 4)) },
          { key: "cost_micro", label: "成本", num: true, value: (r) => r.cost_micro ?? null, render: (r) => (r.reconcile === "pending" && (r.cost_micro === null || r.cost_micro === undefined) ? h("span", { class: "muted" }, "待对账") : fmt.cny(r.cost_micro === null || r.cost_micro === undefined ? r.cost_micro : r.cost_micro / 1e6, 4)) },
          { key: "latency_ms", label: "耗时", num: true, render: (r) => fmt.ms(r.latency_ms) },
          { key: "attempts", label: "尝试", num: true, value: (r) => (r.attempts ?? []).length, render: (r) => ((r.attempts ?? []).length > 1 ? badge(`${r.attempts.length} 次`, "warn", "切换过上游") : "1") },
        ],
      }),
      next ? h("div", { class: "more" }, btn("加载更多", (ev) => ((ev.currentTarget.disabled = true), fetchPage(true)))) : rows.length ? h("p", { class: "muted small center" }, `共 ${rows.length} 条`) : null,
    );
  fetchPage(false);
}

function openRecord(r) {
  const yuan = (m) => (m === null || m === undefined ? fmt.cny(m) : fmt.cny(m / 1e6, 4));
  const charge = r.unit === "cny" ? yuan(r.charge) : r.charge === null || r.charge === undefined ? "—" : `${fmt.int(r.charge)} token`;
  openDrawer({
    title: "请求明细",
    subtitle: mono(r.request_id),
    wide: true,
    body: h(
      "div",
      { class: "stack" },
      r.billing_note ? h("div", { class: ["banner", r.reconcile === "pending" || r.partial ? "warn" : "info"] }, icon("info"), h("span", {}, r.billing_note, r.reconcile === "pending" ? "：不计入额度与金额，估算另列，待与上游账单对账。" : "")) : null,
      r.outcome === "upstream_error" && !r.billing_note ? h("div", { class: "banner danger" }, icon("alert"), h("span", {}, "上游出错：没有用量，不计不扣；上游可能仍计费，对账时单列。")) : null,
      panel(
        "请求",
        facts([
          ["请求编号", mono(r.request_id)],
          ["客户端请求编号", mono(r.client_request_id ?? "—")],
          ["重试", r.retry_of ? h("span", {}, "是，首个请求 ", mono(r.retry_of)) : "否"],
          ["中途出错", r.partial ? "是：流式中途服务出错，不计费（拿到真实用量时成本照记）" : "否"],
          ["上游请求编号", mono(r.upstream_request_id ?? "—")],
          ["开始 / 结束", `${fmt.full(r.started_at)} → ${fmt.full(r.at)}`],
          ["周期", r.period ?? "—"],
          // 第 71 批（V45，P-11）：律所与账号可点，直达客户详情与账号详情（原先是纯文字，要复制邮箱再搜一次）
          ["律所", r.tid ? h("button", { type: "button", class: "link", onclick: () => goTo(`ops/tenants/${encodeURIComponent(r.tid)}`) }, `${r.tenant_name ?? r.tid}（${r.tid}）`) : "—"],
          ["账号", r.aid ? h("button", { type: "button", class: "link", onclick: () => goTo(`ops/accounts/${encodeURIComponent(r.aid)}`) }, r.email ?? r.aid) : r.email ?? "—"],
          ["成员 / 会话 / 设备", h("span", {}, mono(r.uid ?? "—"), " / ", mono(r.sid ?? "—"), " / ", mono(r.dev ?? "—"))],
          ["模型", h("span", {}, mono(r.alias), " → ", mono(r.provider ?? "—"), " · ", mono(r.upstream_model ?? "—"))],
          ["流式", r.stream ? "是" : "否"],
          ["数据级别", r.qa ?? "—"],
          ["状态", h("span", { class: "badges" }, outcomeBadge(r.outcome), mono(String(r.status ?? "—")))],
          ["耗时", fmt.ms(r.latency_ms)],
        ]),
      ),
      panel(
        "计量",
        facts([
          ["用量来源", h("span", {}, (USAGE_SOURCE[r.usage_source] ?? [r.usage_source ?? "—"])[0])],
          ["输入（含缓存）", fmt.int(r.usage?.input)],
          ["其中缓存", fmt.int(r.usage?.cached)],
          ["输出", fmt.int(r.usage?.output)],
          ["其中推理", fmt.int(r.usage?.reasoning)],
          ["缓存写入", r.usage?.cache_write ? `${fmt.int(r.usage.cache_write)}${r.usage.cache_write_1h ? `（其中 1 小时 ${fmt.int(r.usage.cache_write_1h)}）` : ""}` : "—"],
          ["扣额度", `${charge}（单位 ${fmt.unit(r.unit)}）`],
          ["用量价值", r.reconcile === "pending" ? `不计费（估算 ${fmt.cny(r.est_value_cny, 4)}）` : yuan(r.value_micro)],
          ["成本", r.reconcile === "pending" && (r.cost_micro === null || r.cost_micro === undefined) ? `待对账（估算 ${fmt.cny(r.est_cost_cny, 4)}）` : yuan(r.cost_micro)],
          r.unpriced_est_value_cny !== null && r.unpriced_est_value_cny !== undefined ? ["按现行价估算", `${fmt.cny(r.unpriced_est_value_cny, 4)}（只读，不计入）`] : null,
          ["计价依据", r.price_basis ? h("span", {}, r.price_basis === "model" ? "按上游型号 " : "按别名 ", mono(r.price_key ?? "—")) : "—"],
          ["加价倍率", r.markup === null || r.markup === undefined ? "—" : `× ${fmt.num(r.markup)}`],
          ["价目版本", mono(String(r.price_version ?? "—"))],
        ]),
      ),
      r.billed
        ? panel(
            "计费明细（token）",
            facts([
              ["未命中输入", fmt.int(r.billed.uncached)],
              ["缓存命中", fmt.int(r.billed.cached)],
              ["缓存写入（5 分钟）", fmt.int(r.billed.cache_write_5m)],
              ["缓存写入（1 小时）", fmt.int(r.billed.cache_write_1h)],
              ["输出（含推理）", fmt.int(r.billed.output)],
              ["其中推理（不另计）", fmt.int(r.billed.reasoning)],
            ]),
            { sub: "金额 = 各档 × 该档单价（元 / 百万 token）" },
          )
        : null,

      panel(
        "尝试",
        (r.attempts ?? []).length
          ? dataTable({ state: {}, rows: r.attempts.map((a, i) => ({ ...a, n: i + 1 })), columns: [{ key: "n", label: "#", num: true }, { key: "provider", label: "上游", render: (a) => mono(a.provider) }, { key: "status", label: "状态", render: (a) => mono(String(a.status ?? "—")) }, { key: "ms", label: "耗时", num: true, render: (a) => fmt.ms(a.ms) }] })
          : emptyBlock("没有尝试记录"),
      ),
    ),
  });
}
