/**
 * 本所 · 用量：按日、按成员、按模型的汇总，与逐请求明细（不含内容）；明细可导出 CSV。
 * 实际消耗（token）与计费金额（元，按价目计）分列，不互相换算。
 * 接口：GET /v1/firm/usage/summary?days=；GET /v1/firm/usage/records?from&to&aid&alias&cursor；/records.csv 同参数（契约 §3.3）。
 */
import * as api from "../api.js";
import { outcomeBadge, pageHead, sourceBadge } from "../domain.js";
import { badge, bjDay, btn, clear, dataTable, emptyBlock, errorBlock, field, fmt, h, hbars, icon, load, loadingBlock, mono, panel, readForm, segmented, stat, tabBar, toast, trendChart } from "../ui.js";

const st = { view: "summary", days: 30, from: `${bjDay().slice(0, 7)}-01`, to: bjDay(), aid: "", alias: "", members: [], models: [] };
const tokensOf = (r) => (Number(r.tokens_in) || 0) + (Number(r.tokens_out) || 0);

export function render(page, r) {
  if (r.params.view) st.view = r.params.view;
  const tabs = h("div");
  const box = h("div", { class: "stack" });
  page.append(pageHead("本所用量", "逐请求只记用量，不含任何内容"), tabs, box);
  const draw = () => {
    clear(tabs, tabBar([{ id: "summary", label: "汇总" }, { id: "records", label: "逐请求明细" }], st.view, (id) => ((st.view = id), draw())));
    if (st.view === "summary") summary(box);
    else records(box);
  };
  draw();
}

function summary(box) {
  const head = h("div", { class: "toolbar" }, segmented([{ id: 7, label: "近 7 日" }, { id: 30, label: "近 30 日" }, { id: 90, label: "近 90 日" }], st.days, (d) => ((st.days = d), summary(box)), "天数"));
  const body = h("div", { class: "stack" });
  clear(box, head, body);
  load(body, () => api.get("/v1/firm/usage/summary", { days: st.days }), (d) => {
    const t = d.totals ?? {};
    const daily = d.daily ?? [];
    st.members = (d.by_member ?? []).map((m) => [m.aid, m.name ?? m.email ?? m.aid]);
    st.models = (d.by_model ?? []).map((m) => [m.alias, m.label ?? m.alias]);
    body.append(
      h(
        "div",
        { class: "kpis" },
        stat("请求", fmt.int(t.requests), `近 ${st.days} 日`),
        stat("实际消耗", `${fmt.tokens(tokensOf(t) || t.tokens)} token`, `输入 ${fmt.tokens(t.tokens_in)}（缓存 ${fmt.tokens(t.tokens_cached)}）· 输出 ${fmt.tokens(t.tokens_out)}`),
        stat("计费金额", fmt.cny(t.value_cny), "按价目计的用量价值（元）"),
        stat("活跃成员", fmt.int((d.by_member ?? []).filter((m) => Number(m.requests) > 0).length), "有请求的成员"),
      ),
      panel("按日", daily.length ? trendChart({ labels: daily.map((x) => x.day), series: [{ name: "输入 token", values: daily.map((x) => Number(x.tokens_in) || 0), kind: "bar" }, { name: "输出 token", values: daily.map((x) => Number(x.tokens_out) || 0), kind: "bar", cls: "s2" }], format: (v) => fmt.tokens(v), tick: (l) => l.slice(5), height: 200 }) : emptyBlock("这段时间没有用量"), { sub: "实际消耗（token），北京时间日" }),
      h(
        "div",
        { class: "grid-2" },
        panel(
          "按成员",
          dataTable({
            rows: d.by_member ?? [],
            state: { sort: "tokens", asc: false },
            empty: "没有成员用量",
            onRow: (m) => ((st.aid = m.aid), (st.view = "records"), (location.hash = "#/firm/usage?view=records")),
            columns: [
              { key: "name", label: "成员", render: (m) => h("div", { class: "cell-2" }, h("b", {}, m.name ?? "—"), h("small", {}, m.email ?? "")) },
              { key: "requests", label: "请求", num: true, render: (m) => fmt.int(m.requests) },
              { key: "tokens", label: "token", num: true, value: (m) => Number(m.tokens ?? tokensOf(m)) || 0, render: (m) => h("span", { title: fmt.int(m.tokens ?? tokensOf(m)) }, fmt.tokens(m.tokens ?? tokensOf(m))) },
              { key: "value_cny", label: "金额", num: true, value: (m) => m.value_cny ?? null, render: (m) => fmt.cny(m.value_cny) },
              { key: "share", label: "占比", num: true, render: (m) => fmt.pct(m.share) },
            ],
          }),
          { sub: "点一行看此人的明细" },
        ),
        panel("按模型", hbars((d.by_model ?? []).map((m) => ({ label: m.label ?? m.alias, value: Number(m.tokens) || 0, note: `${fmt.pct(m.share)} · ${fmt.int(m.requests)} 次${m.value_cny !== undefined ? ` · ${fmt.cny(m.value_cny)}` : ""}`, title: m.alias })), { format: (v) => `${fmt.tokens(v)} token`, empty: "没有模型用量" })),
      ),
    );
  }, "正在读取用量…");
}

function records(box) {
  const specs = [
    { name: "from", label: "起", type: "date", value: st.from },
    { name: "to", label: "止", type: "date", value: st.to },
    { name: "aid", label: "成员", type: "select", options: [["", "全部成员"], ...st.members], value: st.aid },
    { name: "alias", label: "模型", type: "select", options: [["", "全部模型"], ...st.models], value: st.alias },
  ];
  const form = h("form", { class: "filters", novalidate: true }, specs.map(field), h("div", { class: "filter-actions" }, h("button", { type: "submit", class: "btn primary" }, "查询"), btn("导出 CSV", async (ev) => {
    const b = ev.currentTarget;
    b.disabled = true;
    try {
      await api.downloadCsv("/v1/firm/usage/records.csv", params(), `kwl-firm-usage-${st.from}_${st.to}.csv`);
      toast("已导出");
    } catch (e) {
      toast(e.message, "error");
    } finally {
      b.disabled = false;
    }
  }, { icon: icon("download") })));
  const list = h("div", { class: "stack-sm" });
  clear(box, form, list);
  const params = () => ({ from: st.from, to: st.to, aid: st.aid, alias: st.alias });
  let rows = [];
  let next = null;
  const more = h("div", { class: "more" });
  const table = h("div");
  const drawTable = () => {
    clear(
      table,
      dataTable({
        rows,
        state: { sort: "at", asc: false },
        empty: "这段时间没有请求",
        rowClass: (r) => (r.usage_source === "estimated" ? "estimated" : ""),
        columns: [
          { key: "at", label: "时间", render: (r) => fmt.full(r.at) },
          { key: "member", label: "成员", value: (r) => r.member ?? "" },
          { key: "alias", label: "模型", render: (r) => mono(r.alias ?? "—") },
          { key: "tokens_in", label: "输入", num: true, render: (r) => fmt.tokens(r.tokens_in) },
          { key: "tokens_cached", label: "缓存", num: true, render: (r) => fmt.tokens(r.tokens_cached) },
          { key: "tokens_out", label: "输出", num: true, render: (r) => fmt.tokens(r.tokens_out) },
          { key: "value_cny", label: "金额", num: true, value: (r) => r.value_cny ?? null, render: (r) => fmt.cny(r.value_cny, 4) },
          { key: "outcome", label: "结果", render: (r) => h("span", { class: "badges" }, outcomeBadge(r.outcome), r.retry_of ? badge("重试", "info", "同一请求的重试：每次都真实调用了上游，照常计费") : null, r.partial ? badge("中断估算", "warn") : null, sourceBadge(r.usage_source)) },
          { key: "request_id", label: "请求编号", render: (r) => mono(String(r.request_id ?? "").slice(0, 14), r.request_id) },
        ],
      }),
    );
    clear(more, next ? btn("加载更多", () => fetchPage(true), { size: "sm" }) : rows.length ? h("small", { class: "muted" }, `共 ${rows.length} 条`) : null);
  };
  const fetchPage = async (append) => {
    if (!append) clear(list, loadingBlock("正在读取明细…"));
    try {
      const r = await api.get("/v1/firm/usage/records", { ...params(), cursor: append ? next : undefined });
      rows = append ? [...rows, ...(r.records ?? [])] : r.records ?? [];
      next = r.next ?? null;
      clear(list, table, more);
      drawTable();
    } catch (e) {
      clear(list, errorBlock(e, () => fetchPage(false)));
    }
  };
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    Object.assign(st, readForm(form, specs));
    if (st.from > st.to) return void toast("起始日期晚于结束日期", "error");
    fetchPage(false);
  });
  fetchPage(false);
}
