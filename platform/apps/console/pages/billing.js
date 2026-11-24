/**
 * 计费：本期账单、历史月份、导出。席位费 = 席位 × 席位单价；加量费 = 席位费 × 加量% × 系数；应收 = 二者之和；
 * 用量价值 = Σ 售价金额；成本 = Σ 成本金额；毛利 = 应收 − 成本。价未配的项显示“未定价”，不估。
 * 接口：GET /v1/ops/billing?period=YYYY-MM、GET /v1/ops/billing.csv?period=（契约 §7）。
 */
import * as api from "../api.js";
import { can, ctx, go, needs, pageHead } from "../domain.js";
import { badge, bjMonth, btn, clear, confirmAction, dataTable, facts, fmt, fold, h, icon, load, marginBar, mono, monthShift, note, panel, selectEl, stat, toast } from "../ui.js";

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
  page.append(pageHead("计费", "北京时间自然月；金额以元计，保留两位小数", h("div", { class: "btn-row" }, sel, exportBtn)), box);
  const reload = () => load(box, () => api.get("/v1/ops/billing", { period: st.period }), (d) => draw(box, d), "正在读取账单…");
  reload();
}

function draw(box, d) {
  const t = d.totals ?? {};
  const rows = d.rows ?? [];
  const rate = Number(t.revenue_cny) > 0 && t.margin_cny !== null && t.margin_cny !== undefined ? Number(t.margin_cny) / Number(t.revenue_cny) : null;
  clear(
    box,
    d.priced === false ? h("div", { class: "banner warn" }, icon("alert"), h("span", {}, "价目未配齐：未定价的套餐或模型在下表显示“未定价”，合计只含已定价部分，不估算。")) : null,
    // 第 56 批：历史月份按该月结束时记下的套餐、席位、单价与加量算；没有记录的更早月份只能按当前值估
    rows.some((b) => b.basis === "current_estimate") ? h("div", { class: "banner warn" }, icon("alert"), h("span", {}, `有 ${rows.filter((b) => b.basis === "current_estimate").length} 家律所这个月的席位费与加量费是按“现在的”套餐与席位估的（当月结束时没有留下记录）：出账前请人工核对。`)) : null,
    h(
      "div",
      { class: "kpis" },
      stat("应收", fmt.cny(t.revenue_cny), `席位费 ${fmt.cny(t.seat_fee_cny)} + 加量费 ${fmt.cny(t.boost_fee_cny)}`),
      stat("毛利", fmt.cny(t.margin_cny), rate === null ? "应收 − 模型成本" : `毛利率 ${fmt.pct(rate)}`, { tone: Number(t.margin_cny) < 0 ? "danger" : undefined, extra: rate === null ? null : marginBar(rate) }),
      stat("模型成本", fmt.cny(t.cost_cny), "上游成本价 × 实际用量"),
      stat("用量价值", fmt.cny(t.value_cny), "价目售价 × 实际用量（参考）"),
      stat("请求 / token", fmt.int(t.requests), `${fmt.tokens(t.tokens)} token`),
    ),
    panel(`${d.period ?? st.period} 账单`, dataTable({
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
        { key: "margin_cny", label: "毛利", num: true, value: (b) => b.margin_cny ?? null, render: (b) => h("span", { class: Number(b.margin_cny) < 0 ? "tone-text-danger" : "", title: Number(b.revenue_cny) > 0 && b.margin_cny !== null && b.margin_cny !== undefined ? `毛利率 ${fmt.pct(Number(b.margin_cny) / Number(b.revenue_cny))}` : undefined }, fmt.cny(b.margin_cny)) },
        { key: "requests", label: "请求", num: true, class: "opt", render: (b) => fmt.int(b.requests) },
        { key: "tokens", label: "token", num: true, class: "opt", render: (b) => h("span", { title: fmt.int(b.tokens) }, fmt.tokens(b.tokens)) },
        // 第 62 批：待对账（上游没给用量、按估算，不计费）与价目生效前（未定价，另给按现行价的只读估算）分开列
        { key: "pending_reconcile", label: "待对账", num: true, title: "上游没给真实用量、按估算记的行：不计入金额；悬停看估算", render: (b) => (Number(b.pending_reconcile) > 0 ? h("span", { class: "tone-text-warn", title: `估算 ${fmt.cny(b.est_value_cny)}（成本 ${fmt.cny(b.est_cost_cny)}），不计入` }, fmt.int(b.pending_reconcile)) : "0") },
        { key: "unpriced_rows", label: "价目生效前", num: true, render: (b) => (Number(b.unpriced_rows) > 0 ? h("span", { class: "tone-text-warn", title: "这些请求发生时价目里还没有它的价格：用量价值与成本不含它们" }, fmt.int(b.unpriced_rows)) : "0") },
        { key: "unpriced_est_value_cny", label: "按现行价估算", num: true, class: "opt", title: "价目生效前的行按当前价目重算（只读，不计入合计）", value: (b) => b.unpriced_est_value_cny ?? null, render: (b) => (b.unpriced_est_value_cny === null || b.unpriced_est_value_cny === undefined ? "—" : h("span", { class: "muted" }, fmt.cny(b.unpriced_est_value_cny))) },
      ],
      footer: rows.length
        ? { name: "合计", seat_fee_cny: fmt.cny(t.seat_fee_cny), boost_fee_cny: fmt.cny(t.boost_fee_cny), revenue_cny: fmt.cny(t.revenue_cny), value_cny: fmt.cny(t.value_cny), cost_cny: fmt.cny(t.cost_cny), margin_cny: fmt.cny(t.margin_cny), requests: fmt.int(t.requests), tokens: fmt.tokens(t.tokens) }
        : null,
    }), { flush: true, sub: `${rows.length} 家律所 · 点一行看该律所账单` }),
    note("席位费 = 席位 × 席位单价；加量费 = 席位费 × 加量% × 系数；应收 = 二者之和；毛利 = 应收 − 模型成本。用量价值只作参考，不另收费；待对账与价目生效前的行不计入金额。"),
    migrationBox(),
  );
}

/**
 * 第 62 批计费迁移（契约 contract-b62-pricing §5.2、§5.3）：tokens 套餐按 4.2 元 / 百万 token 折成金额套餐、价目改按上游型号。
 * 只读状态 GET /v1/ops/billing/migrations（billing.read）；还原 POST …/b62/revert（plan.manage，危险操作，二次确认）。
 */
function migrationBox() {
  const body = h("div");
  load(body, () => api.pricing.migrations(), (d) => {
    const m = d.b62_billing;
    const STATUS = { native: ["新部署，无需迁移", "neutral"], applied: ["已迁移", "ok"], reverted: ["已还原", "warn"] };
    const [label, tone] = STATUS[m?.status] ?? [m ? String(m.status) : "没有记录", "neutral"];
    body.append(
      h(
        "div",
        { class: "stack-sm" },
        facts([
          ["状态", badge(label, tone)],
          m?.at ? ["迁移于", fmt.full(m.at)] : null,
          m?.coefficient_cny_per_mtok ? ["折算系数", `${fmt.num(m.coefficient_cny_per_mtok)} 元 / 百万 token`] : null,
          m?.price_version_from !== undefined && m?.price_version_to !== undefined ? ["价目版本", `v${m.price_version_from} → v${m.price_version_to}`] : null,
          m?.plans ? ["套餐", `${fmt.int(m.plans.length)} 个`] : null,
          m?.tenants ? ["律所自定额度", `${fmt.int(m.tenants.length)} 家`] : null,
          m?.accounts ? ["个人上限", `${fmt.int(m.accounts.length)} 个`] : null,
        ]),
        m?.status === "applied"
          ? h(
              "div",
              { class: "btn-row" },
              btn("还原迁移…", async () => {
                const r = await confirmAction({
                  title: "还原第 62 批计费迁移",
                  danger: true,
                  consequences: [
                    "套餐、律所自定额度、个人上限回到迁移前的 token 原值——只还原仍是迁移值的项，迁移后又改过的跳过；",
                    "迁移前已用回到迁移前；收回在途租约（网关下次回报得知）；",
                    "价目不还原（按型号的版本对 token 套餐的额度无影响）；状态记为“已还原”，之后读回不再自动迁移。",
                  ],
                  typeToConfirm: "b62",
                  typeLabel: "再输入一次迁移编号以确认：",
                  confirmLabel: "还原迁移",
                  run: () => api.pricing.revertB62(),
                });
                if (r) (toast(`已还原 ${fmt.int(r.restored_plans?.length ?? r.restored_plans)} 个套餐${r.skipped?.length ? `，跳过 ${r.skipped.length} 项` : ""}`), ctx.reload());
              }, { size: "sm", kind: "danger", disabled: !can("plan.manage"), title: needs("plan.manage") }),
            )
          : null,
      ),
    );
  });
  return fold("计费口径迁移（第 62 批）", "额度改按金额、价目改按上游型号", body);
}
