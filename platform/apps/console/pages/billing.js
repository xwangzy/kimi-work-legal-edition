/**
 * 计费：本期账单、历史月份、导出。席位费 = 席位 × 席位单价；加量费 = 席位费 × 加量% × 系数；应收 = 二者之和；
 * 用量价值 = Σ 售价金额；成本 = Σ 成本金额；毛利 = 应收 − 成本。价未配的项显示“未定价”，不估。
 * 接口：GET /v1/ops/billing?period=YYYY-MM、GET /v1/ops/billing.csv?period=（契约 §7）。
 */
import * as api from "../api.js";
import { go, pageHead } from "../domain.js";
import { badge, bjMonth, btn, clear, dataTable, fmt, h, icon, load, mono, monthShift, selectEl, stat, toast } from "../ui.js";

const st = { period: bjMonth(), table: { sort: "revenue_cny", asc: false } };

export function render(page, r) {
  if (r.params.period && /^\d{4}-\d{2}$/.test(r.params.period)) st.period = r.params.period;
  const cur = bjMonth();
  const months = Array.from({ length: 12 }, (_, i) => monthShift(cur, -i));
  const sel = selectEl(months.map((m) => [m, m === cur ? `${m}（本期）` : m]), st.period, (v) => ((st.period = v), reload()), { "aria-label": "账期" });
  const exportBtn = btn("导出账单 CSV", async (ev) => {
    const b = ev.currentTarget;
    b.disabled = true;
    try {
      await api.downloadCsv("/v1/ops/billing.csv", { period: st.period }, `kwl-bill-${st.period}.csv`);
      toast("已导出");
    } catch (e) {
      toast(e.message, "error");
    } finally {
      b.disabled = false;
    }
  }, { icon: icon("download") });
  const box = h("div", { class: "stack" });
  page.append(pageHead("计费", "北京时间自然月；金额以元计，界面保留两位小数", h("div", { class: "btn-row" }, sel, exportBtn)), box);
  const reload = () => load(box, () => api.get("/v1/ops/billing", { period: st.period }), (d) => draw(box, d), "正在读取账单…");
  reload();
}

function draw(box, d) {
  const t = d.totals ?? {};
  const rows = d.rows ?? [];
  const rate = Number(t.revenue_cny) > 0 && t.margin_cny !== null && t.margin_cny !== undefined ? Number(t.margin_cny) / Number(t.revenue_cny) : null;
  clear(
    box,
    d.priced === false ? h("div", { class: "banner warn" }, "价目未配齐：未定价的套餐或模型在下表显示“未定价”，合计只含已定价部分，不估算。") : null,
    // 第 56 批：历史月份按该月结束时记下的套餐、席位、单价与加量算；没有记录的更早月份只能按当前值估
    rows.some((b) => b.basis === "current_estimate") ? h("div", { class: "banner warn" }, `有 ${rows.filter((b) => b.basis === "current_estimate").length} 家律所这个月的席位费与加量费是按“现在的”套餐与席位估的（当月结束时没有留下记录）：出账前请人工核对。`) : null,
    h(
      "div",
      { class: "kpis" },
      stat("应收", fmt.cny(t.revenue_cny), `席位费 ${fmt.cny(t.seat_fee_cny)} + 加量费 ${fmt.cny(t.boost_fee_cny)}`),
      stat("用量价值", fmt.cny(t.value_cny), "价目售价 × 实际用量"),
      stat("模型成本", fmt.cny(t.cost_cny), "上游成本价 × 实际用量"),
      stat("毛利", fmt.cny(t.margin_cny), rate === null ? "应收 − 成本" : `毛利率 ${fmt.pct(rate)}`, { tone: Number(t.margin_cny) < 0 ? "danger" : undefined }),
      stat("请求 / token", fmt.int(t.requests), `${fmt.tokens(t.tokens)} token`),
    ),
    dataTable({
      state: st.table,
      rows,
      onRow: (b) => go(`tenants/${encodeURIComponent(b.tid)}?tab=bill`),
      empty: `${d.period ?? st.period} 没有账单`,
      columns: [
        { key: "name", label: "律所", render: (b) => h("div", { class: "cell-2" }, h("b", {}, b.name ?? b.tid), mono(b.tid)) },
        { key: "plan", label: "套餐", class: "opt", value: (b) => b.plan?.label ?? "", render: (b) => h("span", {}, b.plan?.label ?? "", b.basis === "current_estimate" ? badge("按当前估", "warn", "这个月结束时没有留下套餐与席位记录：按现在的值估算") : null) },
        { key: "seats", label: "席位", num: true, render: (b) => fmt.int(b.seats) },
        { key: "seat_price_cny", label: "席位单价", num: true, class: "opt", value: (b) => b.seat_price_cny ?? null, render: (b) => fmt.cny(b.seat_price_cny) },
        { key: "seat_fee_cny", label: "席位费", num: true, value: (b) => b.seat_fee_cny ?? null, render: (b) => fmt.cny(b.seat_fee_cny) },
        { key: "boost_pct", label: "加量", num: true, class: "opt", render: (b) => (b.boost_pct ? `+${b.boost_pct}%` : "—") },
        { key: "boost_fee_cny", label: "加量费", num: true, value: (b) => b.boost_fee_cny ?? null, render: (b) => fmt.cny(b.boost_fee_cny) },
        { key: "revenue_cny", label: "应收", num: true, value: (b) => b.revenue_cny ?? null, render: (b) => h("b", {}, fmt.cny(b.revenue_cny)) },
        { key: "value_cny", label: "用量价值", num: true, value: (b) => b.value_cny ?? null, render: (b) => fmt.cny(b.value_cny) },
        { key: "cost_cny", label: "成本", num: true, value: (b) => b.cost_cny ?? null, render: (b) => fmt.cny(b.cost_cny) },
        { key: "margin_cny", label: "毛利", num: true, value: (b) => b.margin_cny ?? null, render: (b) => h("span", { class: Number(b.margin_cny) < 0 ? "tone-text-danger" : "" }, fmt.cny(b.margin_cny)) },
        { key: "requests", label: "请求", num: true, class: "opt", render: (b) => fmt.int(b.requests) },
        { key: "tokens", label: "token", num: true, class: "opt", render: (b) => h("span", { title: fmt.int(b.tokens) }, fmt.tokens(b.tokens)) },
        { key: "unpriced_rows", label: "未定价行", num: true, render: (b) => (Number(b.unpriced_rows) > 0 ? badge(fmt.int(b.unpriced_rows), "warn", "这些请求的模型未定价：用量价值与成本不含它们") : "0") },
      ],
      footer: rows.length
        ? { name: "合计", seat_fee_cny: fmt.cny(t.seat_fee_cny), boost_fee_cny: fmt.cny(t.boost_fee_cny), revenue_cny: fmt.cny(t.revenue_cny), value_cny: fmt.cny(t.value_cny), cost_cny: fmt.cny(t.cost_cny), margin_cny: fmt.cny(t.margin_cny), requests: fmt.int(t.requests), tokens: fmt.tokens(t.tokens) }
        : null,
    }),
  );
}
