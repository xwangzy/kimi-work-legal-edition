/**
 * 模型与价目（第 62 批，平台运营 · 经营组）：把“成本价、销售价、毛利”放在一张表上看清。原“模型与路由 → 价目表”整块搬来。
 *
 * - 单价对照：每个模型别名 × 三个计价项（未缓存输入、缓存输入、输出），成本价、销售价、单位毛利、毛利率并排；
 *   数据取现有路由价目表 GET /v1/ops/routing 的 prices（route.read），改价目 PUT /v1/ops/routing/prices（price.manage），能力不变；
 * - 本期实际：按模型的用量价值、成本、模型毛利（GET /v1/ops/usage/summary?group=model，北京时间本月 1 日至今）；
 * - 版本历史：账本行记价目版本；
 * - 第 62 批计费后端（另一位同事在做）只经 api.pricing.*：契约（platform/docs/contract-b62-pricing.md）到之前显示“接口未就绪”，不造数据。
 * 单位：元 / 百万 token。毛利率 = (销售价 − 成本价) ÷ 销售价；未定价显示“未定价”，不按 0 算。
 */
import * as api from "../api.js";
import { can, needs, pageHead } from "../domain.js";
import { badge, bjDay, btn, clear, confirmAction, dataTable, emptyBlock, errorBlock, fmt, h, icon, load, marginBar, metaLine, mono, note, openDrawer, panel, stat, toast } from "../ui.js";

export const PRICE_ITEMS = [
  ["input", "cost_input", "未缓存输入"],
  ["cached_input", "cost_cached_input", "缓存输入"],
  ["output", "cost_output", "输出"],
];
const PRICE_COLS = [
  ["input", "售价 · 未缓存输入"],
  ["cached_input", "售价 · 缓存输入"],
  ["output", "售价 · 输出"],
  ["cost_input", "成本 · 未缓存输入"],
  ["cost_cached_input", "成本 · 缓存输入"],
  ["cost_output", "成本 · 输出"],
];
const has = (v) => v !== null && v !== undefined;
/** 单位毛利与毛利率（任一价未定 = null） */
export const unitMargin = (sale, cost) => (has(sale) && has(cost) ? { margin: Number(sale) - Number(cost), rate: Number(sale) > 0 ? (Number(sale) - Number(cost)) / Number(sale) : null } : { margin: null, rate: null });

export function render(page) {
  const head = h("div");
  const box = h("div", { class: "stack-lg" });
  page.append(head, box);
  clear(head, pageHead("模型与价目", "成本价、销售价与毛利（元 / 百万 token）"));
  const monthFrom = `${bjDay().slice(0, 7)}-01`;
  const reload = () =>
    load(
      box,
      async () => {
        const [rt, us, pc] = await Promise.allSettled([
          can("route.read") ? api.get("/v1/ops/routing") : Promise.reject({ status: 403, message: "你的角色没有“查看路由”权限：看不到单价" }),
          can("usage.read") ? api.get("/v1/ops/usage/summary", { from: monthFrom, to: bjDay(), group: "model" }) : Promise.reject({ status: 403, message: "你的角色没有“查看用量”权限" }),
          api.pricing.catalog(),
        ]);
        return { rt, us, pc };
      },
      ({ rt, us, pc }) => draw(head, box, rt, us, pc, reload, monthFrom),
      "正在读取价目…",
    );
  reload();
}

function draw(head, box, rt, us, pc, reload, monthFrom) {
  const d = rt.status === "fulfilled" ? rt.value : null;
  const prices = d?.prices ?? { items: {} };
  const aliases = d ? [...new Set([...(d.models ?? []).map((m) => m.alias), ...Object.keys(prices.items ?? {})])] : [];
  const rows = aliases.map((alias) => ({ alias, label: d.models?.find((m) => m.alias === alias)?.label ?? "", enabled: d.models?.find((m) => m.alias === alias)?.enabled, ...(prices.items?.[alias] ?? {}) }));
  const unpriced = rows.filter((r) => !has(r.input) || !has(r.output));
  const noCost = rows.filter((r) => has(r.input) && (!has(r.cost_input) || !has(r.cost_output)));
  const editBtn = btn("改价目…", () => editPrices(rows, prices, reload), { kind: "primary", disabled: !d || !can("price.manage") || !rows.length, title: needs("price.manage") ?? (rows.length ? undefined : "还没有模型别名：先在“模型与路由”里添加") });
  clear(head, pageHead("模型与价目", d ? metaLine(`价目表 v${prices.version ?? "—"}`, `生效于 ${fmt.full(prices.effective_at)}`, "元 / 百万 token") : "成本价、销售价与毛利（元 / 百万 token）", editBtn));

  // 本期实际（按模型）
  const u = us.status === "fulfilled" ? us.value : null;
  const ut = u?.totals ?? {};
  const realized = Number(ut.value_cny) > 0 && has(ut.cost_cny) ? (Number(ut.value_cny) - Number(ut.cost_cny)) / Number(ut.value_cny) : null;
  const kpis = u
    ? h(
        "div",
        { class: "kpis" },
        stat("本期用量价值", fmt.cny(ut.value_cny), "销售价 × 实际用量", { hero: true }),
        stat("本期模型成本", fmt.cny(ut.cost_cny), "成本价 × 实际用量"),
        stat("模型毛利", has(ut.value_cny) && has(ut.cost_cny) ? fmt.cny(Number(ut.value_cny) - Number(ut.cost_cny)) : "—", realized === null ? "用量价值 − 成本" : `毛利率 ${fmt.pct(realized)}`, { hero: true, extra: realized === null ? null : marginBar(realized), tone: realized !== null && realized < 0 ? "danger" : undefined }),
        stat("未定价请求", fmt.int(ut.unpriced), Number(ut.unpriced) > 0 ? "这些请求不计入上面的金额" : "全部已定价", { tone: Number(ut.unpriced) > 0 ? "warn" : undefined }),
      )
    : null;

  // 单价对照：别名 × 三个计价项
  const priceTable = !d
    ? errorBlock(rt.reason)
    : !rows.length
      ? emptyBlock("还没有模型别名", "先在“模型与路由”里添加别名，再在这里定价")
      : h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            { class: "tbl" },
            h("caption", { class: "sr-only" }, "各模型的成本价、销售价与毛利"),
            h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "模型"), h("th", { scope: "col" }, "计价项"), h("th", { scope: "col", class: "num group-start" }, "成本价"), h("th", { scope: "col", class: "num" }, "销售价"), h("th", { scope: "col", class: "num group-start" }, "单位毛利"), h("th", { scope: "col", class: "num" }, "毛利率"))),
            h(
              "tbody",
              {},
              rows.flatMap((r) =>
                PRICE_ITEMS.map(([sk, ck, label], i) => {
                  const m = unitMargin(r[sk], r[ck]);
                  const cell = (v) => (has(v) ? fmt.price(v) : h("span", { class: "muted" }, "未定价"));
                  return h(
                    "tr",
                    { class: [i === 0 && "group-first", i === 0 && !has(r.input) && "flagged"] },
                    i === 0
                      ? h("td", { rowspan: "3", class: "model-cell" }, h("div", { class: "cell-2" }, h("b", {}, mono(r.alias)), h("small", {}, r.label || "—"), r.enabled === false ? badge("已停用", "neutral") : null))
                      : null,
                    h("td", { class: "muted item-cell" }, label),
                    h("td", { class: "num group-start" }, cell(r[ck])),
                    h("td", { class: "num" }, cell(r[sk])),
                    h("td", { class: ["num", "group-start", m.margin !== null && m.margin < 0 && "tone-text-danger"] }, m.margin === null ? "—" : fmt.price(m.margin)),
                    h("td", { class: "num" }, m.rate === null ? "—" : h("span", { class: "margin-cell" }, h("span", { class: m.rate < 0 ? "tone-text-danger" : "" }, fmt.pct(m.rate)), marginBar(m.rate))),
                  );
                }),
              ),
            ),
          ),
        );

  const byModel = u
    ? dataTable({
        state: { sort: "value_cny", asc: false },
        rows: (u.rows ?? []).map((r) => ({ ...r, margin: has(r.value_cny) && has(r.cost_cny) ? Number(r.value_cny) - Number(r.cost_cny) : null, rate: Number(r.value_cny) > 0 && has(r.cost_cny) ? (Number(r.value_cny) - Number(r.cost_cny)) / Number(r.value_cny) : null })),
        empty: "本期还没有模型用量",
        columns: [
          { key: "key", label: "模型", value: (r) => r.label ?? r.key, render: (r) => (r.label && r.label !== r.key ? h("div", { class: "cell-2" }, h("b", {}, r.label), mono(r.key)) : mono(r.key)) },
          { key: "requests", label: "请求", num: true, render: (r) => fmt.int(r.requests) },
          { key: "tokens", label: "token", num: true, value: (r) => (Number(r.tokens_in) || 0) + (Number(r.tokens_out) || 0), render: (r) => fmt.tokens((Number(r.tokens_in) || 0) + (Number(r.tokens_out) || 0)) },
          { key: "value_cny", label: "用量价值", num: true, value: (r) => r.value_cny ?? null, render: (r) => fmt.cny(r.value_cny) },
          { key: "cost_cny", label: "成本", num: true, value: (r) => r.cost_cny ?? null, render: (r) => fmt.cny(r.cost_cny) },
          { key: "margin", label: "模型毛利", num: true, render: (r) => (r.margin === null ? "—" : h("span", { class: r.margin < 0 ? "tone-text-danger" : "" }, fmt.cny(r.margin))) },
          { key: "rate", label: "毛利率", num: true, render: (r) => (r.rate === null ? "—" : h("span", { class: "margin-cell" }, fmt.pct(r.rate), marginBar(r.rate))) },
          { key: "unpriced", label: "未定价", num: true, render: (r) => (Number(r.unpriced) > 0 ? badge(fmt.int(r.unpriced), "warn", "这些请求的模型未定价：用量价值与成本不含它们") : "0") },
        ],
      })
    : errorBlock(us.reason);

  clear(
    box,
    unpriced.length ? h("div", { class: "banner warn" }, icon("alert"), h("span", {}, `${unpriced.map((r) => r.alias).join("、")} 未定价：用量价值与账单里这部分显示“未定价”，不估算。`)) : null,
    noCost.length ? h("div", { class: "banner warn" }, icon("alert"), h("span", {}, `${noCost.map((r) => r.alias).join("、")} 只填了销售价、没填成本价：毛利算不出来。`)) : null,
    kpis,
    panel("单价对照", priceTable, { flush: true, sub: "成本价来自上游采购价；销售价用于用量价值与按金额计费的额度", actions: d && can("price.manage") ? null : h("span", { class: "muted small" }, needs("price.manage") ? "只读" : "") }),
    panel("本期实际（按模型）", byModel, { flush: true, sub: `${monthFrom} 至今 · 模型毛利不含席位费` }),
    h(
      "div",
      { class: "grid-2" },
      panel(
        "版本历史",
        (d?.price_history ?? []).length
          ? dataTable({ state: { sort: "version", asc: false }, rows: d.price_history, columns: [{ key: "version", label: "版本", num: true, render: (x) => `v${x.version}` }, { key: "effective_at", label: "生效于", render: (x) => fmt.full(x.effective_at) }, { key: "by", label: "修改人", render: (x) => mono(x.by ?? "—") }] })
          : emptyBlock(d ? "还没有历史版本" : "看不到价目"),
        { sub: "账本行记价目版本；历史版本全部保留" },
      ),
      panel("计费后端（第 62 批）", pc.status === "fulfilled" ? h("pre", { class: "mono" }, JSON.stringify(pc.value, null, 2).slice(0, 2000)) : h("div", { class: "stack-sm" }, errorBlock(pc.reason, reload), note("接口就绪后：按套餐区分的销售价、上游采购价来源与生效时间、毛利预警线。")), { sub: "契约待定" }),
    ),
    note("毛利率 = (销售价 − 成本价) ÷ 销售价。改价目会生成新版本，约 15 秒后网关按新价计量；之前的请求仍按原版本记账。按金额计费的套餐的售价也可以在“套餐”里随套餐一起改。"),
  );
}

/** 改价目：六个价一张表，空 = 未定价；确认框列出改动；生成新版本 */
export function editPrices(rows, prices, reload) {
  const inputs = {};
  const table = h(
    "table",
    { class: "tbl price-edit" },
    h("thead", {}, h("tr", {}, h("th", {}, "别名"), PRICE_COLS.map(([, l]) => h("th", { class: "num" }, l)))),
    h(
      "tbody",
      {},
      rows.map((r) =>
        h(
          "tr",
          {},
          h("td", {}, mono(r.alias)),
          PRICE_COLS.map(([k, l]) => {
            const i = h("input", { type: "number", min: 0, step: "0.0001", inputmode: "decimal", class: "num-input", value: r[k] ?? "", placeholder: "未定价", "aria-label": `${r.alias} ${l}` });
            (inputs[r.alias] ??= {})[k] = i;
            return h("td", { class: "num" }, i);
          }),
        ),
      ),
    ),
  );
  const err = h("p", { class: "form-error", role: "alert" });
  const form = h(
    "form",
    { class: "drawer-form", novalidate: true },
    h("p", { class: "muted small" }, "单位：元 / 百万 token（1 元 / 百万 token = 1 微元 / token）。留空 = 未定价（界面与账单显示“未定价”，不按 0 计）。"),
    h("div", { class: "table-wrap" }, table),
    err,
    h("div", { class: "drawer-foot" }, h("span", { class: "spacer" }), h("button", { type: "button", class: "btn", onclick: () => dr.close() }, "取消"), h("button", { type: "submit", class: "btn primary" }, "生成新版本…")),
  );
  const dr = openDrawer({ title: "改价目表", subtitle: `当前 v${prices.version ?? "—"}`, body: form, wide: true });
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    err.textContent = "";
    const items = {};
    const changes = [];
    for (const r of rows) {
      items[r.alias] = {};
      for (const [k, l] of PRICE_COLS) {
        const s = inputs[r.alias][k].value.trim();
        const v = s === "" ? null : Number(s);
        if (v !== null && !(Number.isFinite(v) && v >= 0 && v <= 100000)) return void (err.textContent = `${r.alias} 的“${l}”须为 0–100000 的数字或留空`);
        items[r.alias][k] = v;
        const old = r[k] ?? null;
        if (old !== v) changes.push(`${r.alias} ${l}：${fmt.price(old)} → ${fmt.price(v)}`);
      }
    }
    if (!changes.length) return void (err.textContent = "没有改动");
    const below = rows.filter((r) => PRICE_ITEMS.some(([sk, ck]) => has(items[r.alias][sk]) && has(items[r.alias][ck]) && items[r.alias][sk] < items[r.alias][ck])).map((r) => r.alias);
    const ok = await confirmAction({
      title: "生成新价目版本",
      danger: true,
      lead: h("ul", { class: "diff-list" }, changes.slice(0, 12).map((c) => h("li", {}, c)), changes.length > 12 ? h("li", {}, `……共 ${changes.length} 项`) : null),
      consequences: [
        `生成价目表 v${(Number(prices.version) || 0) + 1}，约 15 秒后网关按新价计量；之前的请求仍按原版本记账；`,
        "金额额度（cny）的律所：同样的用量扣得多或少，本期百分比随之变化；",
        "账单的用量价值与成本按每行的价目版本算。",
        below.length ? `注意：${below.join("、")} 有计价项的销售价低于成本价（亏本）。` : null,
      ].filter(Boolean),
      confirmLabel: "生成新版本",
      run: () => api.put("/v1/ops/routing/prices", { items }),
    });
    if (ok) {
      toast(`已生成价目表 v${ok.version ?? ""}`);
      dr.close();
      reload();
    }
  });
}
