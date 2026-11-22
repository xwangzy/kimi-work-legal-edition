/**
 * 本所 · 账单：席位费、加量费、应收、用量价值（按价目计）；不含成本与毛利。北京时间自然月，金额以元计。
 * 接口：GET /v1/firm/billing?period=YYYY-MM（契约 §3.3）。
 */
import * as api from "../api.js";
import { pageHead } from "../domain.js";
import { bjMonth, clear, facts, fmt, h, load, monthShift, panel, selectEl, stat } from "../ui.js";

const st = { period: bjMonth() };

export function render(page) {
  const cur = bjMonth();
  const months = Array.from({ length: 12 }, (_, i) => monthShift(cur, -i));
  const box = h("div", { class: "stack" });
  const sel = selectEl(months.map((m) => [m, m === cur ? `${m}（本期）` : m]), st.period, (v) => ((st.period = v), reload()), { "aria-label": "账期" });
  page.append(pageHead("本所账单", "北京时间自然月；金额以元计，保留两位小数", sel), box);
  const reload = () => load(box, () => api.get("/v1/firm/billing", { period: st.period }), (d) => draw(box, d), "正在读取账单…");
  reload();
}

function draw(box, raw) {
  const d = raw.bill ?? raw;
  const plan = d.plan ?? {};
  clear(
    box,
    d.priced === false ? h("div", { class: "banner warn" }, "价目未配齐：未定价的项显示“未定价”，合计只含已定价部分。") : null,
    d.basis === "current_estimate" ? h("div", { class: "banner warn" }, "这个月的席位费与加量费按现在的套餐与席位估算（当月结束时没有留下记录），以账单为准。") : null,
    h(
      "div",
      { class: "kpis" },
      stat("应收", fmt.cny(d.revenue_cny), `席位费 ${fmt.cny(d.seat_fee_cny)} + 加量费 ${fmt.cny(d.boost_fee_cny)}`),
      stat("席位费", fmt.cny(d.seat_fee_cny), `${fmt.int(d.seats)} 席 × ${fmt.cny(d.seat_price_cny)}`),
      stat("加量费", fmt.cny(d.boost_fee_cny), d.boost_pct ? `本期加量 +${d.boost_pct}%` : "本期未加量"),
      stat("用量价值", fmt.cny(d.value_cny), "按价目计的实际用量（不另收费）"),
    ),
    panel(
      `${d.period ?? st.period} 明细`,
      facts([
        ["套餐", plan.label ?? plan.id ?? d.plan_label ?? "—"],
        ["席位", fmt.int(d.seats)],
        ["席位单价", fmt.cny(d.seat_price_cny)],
        ["加量", d.boost_pct ? `+${d.boost_pct}%` : "—"],
        ["请求", fmt.int(d.requests)],
        ["实际消耗", d.tokens === undefined ? "—" : `${fmt.tokens(d.tokens)} token`],
        ["账期", d.period ?? st.period],
        ["状态", d.status ?? (d.period === bjMonth() ? "本期进行中，数字会随用量变化" : "—")],
      ]),
      { sub: "应收 = 席位费 + 加量费；用量价值只作参考" },
    ),
  );
}
