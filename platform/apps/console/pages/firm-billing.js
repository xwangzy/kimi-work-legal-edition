/**
 * 本所 · 账单：席位费、加量费、应收、用量价值（按价目计）；不含成本与毛利。北京时间自然月，金额以元计。
 * 接口：GET /v1/firm/billing?period=YYYY-MM（契约 §3.3）。
 */
import * as api from "../api.js";
import { pageHead } from "../domain.js";
import { bjMonth, clear, facts, fmt, h, icon, load, monthShift, panel, selectEl, stat } from "../ui.js";

const st = { period: bjMonth() };

export function render(page) {
  const cur = bjMonth();
  const months = Array.from({ length: 12 }, (_, i) => monthShift(cur, -i));
  const box = h("div", { class: "stack" });
  const sel = selectEl(months.map((m) => [m, m === cur ? `${m}（本期）` : m]), st.period, (v) => ((st.period = v), reload()), { "aria-label": "账期" });
  page.append(pageHead(location.hash.startsWith("#/me/") ? "账单" : "本所账单", "按北京时间自然月出账", sel), box);
  const reload = () => load(box, () => api.get("/v1/firm/billing", { period: st.period }), (d) => draw(box, d), "正在读取账单…");
  reload();
}

/**
 * 第 72 批评审（K16c）：写给付钱的人看——首格直接给结论“本月费用”；试用期（席位没有定价）写“试用期免费”，不列一串“未定价”；
 * 个人空间不讲席位；调用量用“AI 调用 N 次”，token 只放在悬停。
 */
function draw(box, raw) {
  const d = raw.bill ?? raw;
  const plan = d.plan ?? {};
  const personal = location.hash.startsWith("#/me/");
  const trial = d.seat_price_cny === null || d.seat_price_cny === undefined;
  const tokens = d.tokens === undefined ? null : `${fmt.tokens(d.tokens)} token`;
  clear(
    box,
    !trial && d.priced === false ? h("div", { class: "banner warn" }, icon("alert"), h("span", {}, "部分价目还没配齐：合计只含已定价的部分。")) : null,
    d.basis === "current_estimate" ? h("div", { class: "banner warn" }, icon("alert"), h("span", {}, "这个月的费用按现在的套餐与席位估算（当月结束时没有留下记录），以正式账单为准。")) : null,
    h(
      "div",
      { class: "kpis" },
      trial ? stat("本月费用", "¥0", "试用期免费") : stat("本月费用", fmt.cny(d.revenue_cny), personal ? `套餐费 ${fmt.cny(d.seat_fee_cny)} + 加量费 ${fmt.cny(d.boost_fee_cny)}` : `席位费 ${fmt.cny(d.seat_fee_cny)} + 加量费 ${fmt.cny(d.boost_fee_cny)}`),
      trial ? null : stat(personal ? "套餐费" : "席位费", fmt.cny(d.seat_fee_cny), personal ? "个人版" : `${fmt.int(d.seats)} 席 × ${fmt.cny(d.seat_price_cny)}`),
      stat("加量", d.boost_pct ? `+${d.boost_pct}%` : "无", trial ? "试用期加量不收费" : d.boost_pct ? `加量费 ${fmt.cny(d.boost_fee_cny)}` : "本月没有加量"),
      stat("AI 调用", `${fmt.int(d.requests)} 次`, tokens ? h("span", { title: tokens }, "按价目折合 ", fmt.cny(d.value_cny), "，不另收费") : "不另收费"),
    ),
    panel(
      `${d.period ?? st.period} 明细`,
      facts([
        ["套餐", plan.label ?? plan.id ?? d.plan_label ?? "—"],
        personal ? null : ["席位", fmt.int(d.seats)],
        personal || trial ? null : ["席位单价", fmt.cny(d.seat_price_cny)],
        ["加量", d.boost_pct ? `+${d.boost_pct}%` : "—"],
        ["AI 调用", `${fmt.int(d.requests)} 次`, tokens ?? undefined],
        ["状态", d.status ?? (d.period === bjMonth() ? "本月进行中，数字会随用量变化" : "—")],
      ]),
      { sub: trial ? "试用期内不收费；正式定价后按月出账" : personal ? "本月费用 = 套餐费 + 加量费" : "本月费用 = 席位费 + 加量费" },
    ),
  );
}
