/**
 * 模型与价目（第 62 批，平台运营 · 经营组；契约 platform/docs/contract-b62-pricing.md §1、§2）：
 * 价目按**上游真实型号**定——成本价缺省取 Kimi 官方价，售价 = 成本 × 加价倍率（整表缺省，可按型号覆盖）或逐项显式售价；
 * 五档计价：未命中输入、缓存命中、缓存写入 5 分钟、缓存写入 1 小时、输出（推理含在输出里、不另计）。
 * 别名切到别的型号（如 highspeed），售价与成本跟着型号走；价目变更即新版本，下一请求起生效，历史行不改写。
 *
 * - 读 GET /v1/ops/pricing（route.read）；改 PUT /v1/ops/pricing（price.manage，危险操作：控制面要求 10 分钟内复核过，api.js 自动弹复核）；
 * - 本期实际按上游型号：GET /v1/ops/usage/summary?group=upstream（usage.read），含待对账与价目生效前；
 * - 旧的按别名改价接口（PUT /v1/ops/routing/prices）在按型号的版本里一律 409，本页与“模型与路由”都不再提供那个入口。
 * 单位：单价元 / 百万 token（两位小数，必要时到四位）；金额元（两位小数）。毛利率 = (售价 − 成本) ÷ 售价。
 */
import * as api from "../api.js";
import { can, go, isMe, needs, pageHead } from "../domain.js";
import { badge, bjDay, btn, clear, confirmAction, dataTable, emptyBlock, errorBlock, fmt, fold, h, icon, load, marginBar, metaLine, mono, note, openDrawer, panel, stat, toast } from "../ui.js";

/** 五档：[字段, 名称, 缺价回退说明] */
export const TIERS = [
  ["input", "未命中输入", null],
  ["cached_input", "缓存命中", "按未命中价"],
  ["cache_write", "缓存写入 5 分钟", "按未命中价"],
  ["cache_write_1h", "缓存写入 1 小时", "按 5 分钟写入价"],
  ["output", "输出", null],
];
const has = (v) => v !== null && v !== undefined;
const r4 = (v) => Math.round(Number(v) * 10000) / 10000;
/** 单位毛利与毛利率（任一价缺 = null） */
export const unitMargin = (sale, cost) => (has(sale) && has(cost) ? { margin: r4(Number(sale) - Number(cost)), rate: Number(sale) > 0 ? (Number(sale) - Number(cost)) / Number(sale) : null } : { margin: null, rate: null });
/** 缺价回退后的有效单价（与控制面 §1 同一规则：命中、写入缺 → 未命中价；1 小时写入缺 → 5 分钟写入价 → 未命中价） */
export function tierValue(rates, k) {
  if (!rates) return null;
  if (has(rates[k])) return rates[k];
  if (k === "cached_input" || k === "cache_write") return rates.input ?? null;
  if (k === "cache_write_1h") return rates.cache_write ?? rates.input ?? null;
  return null;
}
const sourceText = (m) => {
  const s = m.cost_source ?? "";
  if (!s) return m.cost ? "运营录入" : m.official ? "官方价" : "—";
  if (/官方/.test(s)) return `官方价${/（(.+?)抓取）/.exec(s)?.[1] ? ` · ${/（(.+?)抓取）/.exec(s)[1]}` : ""}`;
  return s.length > 24 ? `${s.slice(0, 24)}…` : s;
};

export function render(page) {
  const head = h("div");
  const box = h("div", { class: "stack-lg" });
  page.append(head, box);
  clear(head, pageHead("模型与价目", "按上游型号的成本价、售价与毛利（元 / 百万 token）"));
  const monthFrom = `${bjDay().slice(0, 7)}-01`;
  const reload = () =>
    load(
      box,
      async () => {
        const [pc, us] = await Promise.allSettled([
          can("route.read") ? api.pricing.get() : Promise.reject({ status: 403, message: "你的角色没有“查看路由”权限：看不到单价" }),
          can("usage.read") ? api.get("/v1/ops/usage/summary", { from: monthFrom, to: bjDay(), group: "upstream" }) : Promise.reject({ status: 403, message: "你的角色没有“查看用量”权限" }),
        ]);
        return { pc, us };
      },
      ({ pc, us }) => draw(head, box, pc, us, reload, monthFrom),
      "正在读取价目…",
    );
  reload();
}

function draw(head, box, pc, us, reload, monthFrom) {
  const d = pc.status === "fulfilled" ? pc.value : null;
  const models = d?.models ?? [];
  const unpriced = models.filter((m) => !m.priced);
  const editBtn = btn("调整价目…", () => editPricing(d, reload), { kind: "primary", disabled: !d || !can("price.manage"), title: needs("price.manage") });
  clear(
    head,
    pageHead(
      "模型与价目",
      d ? metaLine(`价目 v${d.version}`, d.basis === "model" ? "按上游型号" : "按别名（旧版本）", d.basis === "model" ? `整表加价 × ${fmt.num(d.markup)}` : null, `生效于 ${fmt.full(d.effective_at)}`, d.by ? `由 ${byText(d.by)}` : null) : "按上游型号的成本价、售价与毛利（元 / 百万 token）",
      editBtn,
    ),
  );

  // 本期实际（按上游型号）
  const u = us.status === "fulfilled" ? us.value : null;
  const ut = u?.totals ?? {};
  const realized = Number(ut.value_cny) > 0 && has(ut.cost_cny) ? (Number(ut.value_cny) - Number(ut.cost_cny)) / Number(ut.value_cny) : null;
  const kpis = u
    ? h(
        "div",
        { class: "kpis" },
        stat("本期用量价值", fmt.cny(ut.value_cny), "售价 × 实测用量", { hero: true }),
        stat("本期模型成本", fmt.cny(ut.cost_cny), "成本价 × 实测用量"),
        stat("模型毛利", has(ut.value_cny) && has(ut.cost_cny) ? fmt.cny(Number(ut.value_cny) - Number(ut.cost_cny)) : "—", realized === null ? "用量价值 − 成本（不含席位费）" : `毛利率 ${fmt.pct(realized)}（不含席位费）`, { hero: true, extra: realized === null ? null : marginBar(realized), tone: realized !== null && realized < 0 ? "danger" : undefined }),
        stat("不计入的行", `${fmt.int(ut.pending_reconcile)} / ${fmt.int(ut.unpriced)}`, "待对账 / 价目生效前", { tone: Number(ut.pending_reconcile) > 0 || Number(ut.unpriced) > 0 ? "warn" : undefined }),
      )
    : null;

  // 单价对照：型号 × 五档（成本 | 售价 | 单位毛利 | 毛利率）
  const cell = (v, fallback) => (has(v) ? fmt.price(v) : h("span", { class: "muted" }, fallback ?? "未定价"));
  const priceTable = !d
    ? errorBlock(pc.reason, reload)
    : !models.length
      ? emptyBlock("还没有型号", "先在“模型与路由”里把别名指向上游型号，再来定价")
      : h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            { class: "tbl" },
            h("caption", { class: "sr-only" }, "各上游型号的成本价、售价与毛利"),
            h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "上游型号"), h("th", { scope: "col" }, "计价项"), h("th", { scope: "col", class: "num group-start" }, "成本价"), h("th", { scope: "col", class: "num" }, "售价"), h("th", { scope: "col", class: "num group-start" }, "单位毛利"), h("th", { scope: "col", class: "num" }, "毛利率"))),
            h(
              "tbody",
              {},
              models.flatMap((m) => {
                const e = m.effective;
                const mk = e?.markup ?? m.markup ?? d.markup;
                return TIERS.map(([k, label, fb], i) => {
                  const cost = tierValue(e?.cost, k);
                  const sale = tierValue(e?.sale, k);
                  const explicit = has(m.sale_override?.[k]);
                  const mg = unitMargin(sale, cost);
                  return h(
                    "tr",
                    { class: [i === 0 && "group-first", i === 0 && !m.priced && "flagged"] },
                    i === 0
                      ? h(
                          "td",
                          { rowspan: String(TIERS.length), class: "model-cell" },
                          h(
                            "div",
                            { class: "cell-2 model-meta" },
                            h("b", {}, m.label ?? m.model),
                            mono(m.model),
                            h("span", { class: "badges" }, (m.used_by ?? []).map((x) => badge(x.alias, x.primary ? "accent" : "neutral", x.primary ? "这个别名的首选型号" : "这个别名的备选目标"))),
                            h("small", {}, `成本：${sourceText(m)}`),
                            h("small", {}, m.priced ? `售价 = 成本 × ${fmt.num(mk)}${m.markup !== null && m.markup !== undefined ? "（按型号）" : ""}${m.sale_override && Object.values(m.sale_override).some(has) ? " · 部分显式" : ""}` : "未定价：有别名指向它时，金额额度的律所会被拒"),
                          ),
                        )
                      : null,
                    h("td", { class: "item-cell muted" }, label),
                    h("td", { class: "num group-start" }, has(e?.cost?.[k]) || !fb ? cell(cost) : h("span", { class: "muted", title: fb }, cost === null ? "—" : fmt.price(cost))),
                    h("td", { class: "num" }, explicit ? h("span", { class: "sale-explicit", title: "显式售价（不按倍率）" }, fmt.price(sale)) : has(e?.sale?.[k]) || !fb ? cell(sale) : h("span", { class: "muted", title: fb }, sale === null ? "—" : fmt.price(sale))),
                    h("td", { class: ["num", "group-start", mg.margin !== null && mg.margin < 0 && "tone-text-danger"] }, mg.margin === null ? "—" : fmt.price(mg.margin)),
                    h("td", { class: "num" }, mg.rate === null ? "—" : h("span", { class: "margin-cell" }, h("span", { class: mg.rate < 0 ? "tone-text-danger" : "" }, fmt.pct(mg.rate)), marginBar(mg.rate))),
                  );
                });
              }),
            ),
          ),
        );

  const aliases = d?.aliases ?? [];
  const aliasTable = aliases.length
    ? dataTable({
        state: { sort: "alias", asc: true },
        rows: aliases,
        columns: [
          { key: "alias", label: "别名", render: (a) => h("span", { class: "badges" }, mono(a.alias), a.enabled === false ? badge("停用", "neutral") : null) },
          { key: "primary_model", label: "首选型号", render: (a) => mono(a.primary_model ?? "—") },
          { key: "targets", label: "全部目标", sortable: false, class: "opt", render: (a) => h("span", { class: "badges" }, [...new Set(a.targets ?? [])].map((t) => mono(t))) },
          { key: "in", label: "售价 · 输入", num: true, value: (a) => a.effective?.sale?.input ?? null, render: (a) => cell(a.effective?.sale?.input) },
          { key: "out", label: "售价 · 输出", num: true, value: (a) => a.effective?.sale?.output ?? null, render: (a) => cell(a.effective?.sale?.output) },
          { key: "basis", label: "计价键", render: (a) => (a.effective ? h("span", { class: "muted" }, a.effective.basis === "model" ? "型号 " : "别名 ", mono(a.effective.key)) : badge("未定价", "warn")) },
        ],
      })
    : emptyBlock("没有别名");

  const byUpstream = u
    ? dataTable({
        state: { sort: "value_cny", asc: false },
        rows: (u.rows ?? []).map((r) => ({ ...r, margin: has(r.value_cny) && has(r.cost_cny) ? Number(r.value_cny) - Number(r.cost_cny) : null, rate: Number(r.value_cny) > 0 && has(r.cost_cny) ? (Number(r.value_cny) - Number(r.cost_cny)) / Number(r.value_cny) : null })),
        empty: "本期还没有用量",
        columns: [
          { key: "key", label: "上游型号", value: (r) => r.key, render: (r) => (r.key ? mono(r.key) : h("span", { class: "muted" }, "未到达上游")) },
          { key: "requests", label: "请求", num: true, render: (r) => fmt.int(r.requests) },
          { key: "tokens", label: "token", num: true, value: (r) => (Number(r.tokens_in) || 0) + (Number(r.tokens_out) || 0), render: (r) => fmt.tokens((Number(r.tokens_in) || 0) + (Number(r.tokens_out) || 0)) },
          { key: "value_cny", label: "用量价值", num: true, value: (r) => r.value_cny ?? null, render: (r) => fmt.cny(r.value_cny) },
          { key: "cost_cny", label: "成本", num: true, value: (r) => r.cost_cny ?? null, render: (r) => fmt.cny(r.cost_cny) },
          { key: "margin", label: "模型毛利", num: true, render: (r) => (r.margin === null ? "—" : h("span", { class: r.margin < 0 ? "tone-text-danger" : "" }, fmt.cny(r.margin))) },
          { key: "rate", label: "毛利率", num: true, render: (r) => (r.rate === null ? "—" : h("span", { class: "margin-cell" }, fmt.pct(r.rate), marginBar(r.rate))) },
          { key: "pending_reconcile", label: "待对账", num: true, render: (r) => (Number(r.pending_reconcile) > 0 ? h("span", { class: "tone-text-warn", title: `估算 ${fmt.cny(r.est_value_cny)}，不计入` }, fmt.int(r.pending_reconcile)) : "0") },
          { key: "unpriced", label: "价目生效前", num: true, render: (r) => (Number(r.unpriced) > 0 ? h("span", { class: "tone-text-warn", title: has(r.unpriced_est_value_cny) ? `按现行价约 ${fmt.cny(r.unpriced_est_value_cny)}（只读）` : undefined }, fmt.int(r.unpriced)) : "0") },
        ],
      })
    : errorBlock(us.reason);

  const official = d?.official?.models ?? {};
  clear(
    box,
    d && d.basis !== "model" ? h("div", { class: "banner info" }, icon("info"), h("span", {}, "当前价目仍按别名（第 62 批之前的版本）。点“调整价目”保存一次即改为按上游型号：成本缺省取官方价，售价按倍率。")) : null,
    unpriced.length ? h("div", { class: "banner warn" }, icon("alert"), h("span", {}, `${unpriced.map((m) => m.model).join("、")} 未定价：有别名指向它时，按金额计费的律所会被拒（不按 0 元放行）。`)) : null,
    kpis,
    panel("单价对照", priceTable, { flush: true, sub: "缺价的档按回退规则（灰字）；蓝框 = 显式售价" }),
    panel("本期实际（按上游型号）", byUpstream, { flush: true, sub: `${monthFrom} 至今 · 模型毛利不含席位费` }),
    panel("别名怎么计价", aliasTable, { flush: true, sub: "按首选型号的价；切到别的型号即按那个型号算", actions: can("route.read") ? h("button", { type: "button", class: "link small", onclick: () => go("ops/routing?tab=models") }, "改路由", icon("chevron")) : null }),
    panel(
      "版本历史",
      (d?.history ?? []).length
        ? dataTable({ state: { sort: "version", asc: false }, rows: d.history, columns: [{ key: "version", label: "版本", num: true, render: (x) => `v${x.version}` }, { key: "effective_at", label: "生效于", render: (x) => fmt.full(x.effective_at) }, { key: "basis", label: "依据", value: (x) => (x.basis === "model" ? "按上游型号" : "按别名") }, { key: "by", label: "修改", render: (x) => byText(x.by) }, { key: "note", label: "说明", class: "wrap", value: (x) => x.note ?? "" }] })
        : emptyBlock(d ? "还没有历史版本" : "看不到价目"),
      { flush: true, sub: "每行用量记它发起时的价目版本；历史版本全部保留" },
    ),
    Object.keys(official).length
      ? fold(
          "Kimi 官方价（成本缺省）",
          d.official.source ?? "",
          dataTable({
            state: { sort: "model", asc: true },
            rows: Object.entries(official).map(([model, v]) => ({ model, ...v })),
            columns: [{ key: "model", label: "型号", render: (x) => h("div", { class: "cell-2" }, h("b", {}, x.label ?? x.model), mono(x.model)) }, ...TIERS.map(([k, l]) => ({ key: k, label: l, num: true, value: (x) => x[k] ?? null, render: (x) => cell(x[k], "—") }))],
          }),
        )
      : null,
  );
}

const byText = (by) => (!by ? "—" : by === "bootstrap:official" ? "部署初始（官方价）" : String(by).startsWith("migration:") ? "第 62 批迁移" : isMe(by) ? "我" : by);

/**
 * 调整价目：整表倍率 + 说明；每个型号：成本（官方价 / 自定五档）、倍率覆盖、逐项显式售价。整表替换，确认框列改动，危险操作（复核）。
 */
function editPricing(d, reload) {
  const official = d.official?.models ?? {};
  const rows = d.models.map((m) => ({
    model: m.model,
    label: m.label ?? "",
    custom: !!m.cost && !(m.cost_source ?? "").includes("官方") && !!official[m.model] ? true : !!m.cost && !official[m.model],
    cost: { ...(m.cost ?? {}) },
    cost_source: m.cost_source && !(m.cost_source ?? "").includes("官方") ? m.cost_source : "",
    markup: m.markup ?? null,
    sale: { ...(m.sale_override ?? {}) },
    referenced: (m.used_by ?? []).length > 0,
    old: m,
  }));
  const markupIn = h("input", { type: "number", min: 0.01, max: 100, step: "0.01", value: d.markup ?? 1, class: "num-input", "aria-label": "整表加价倍率" });
  const noteIn = h("input", { type: "text", maxlength: 200, placeholder: "可选：这次为什么改（记入版本历史）", "aria-label": "说明" });
  const list = h("div", { class: "stack" });
  const num = (v, attrs) => h("input", { type: "number", min: 0, max: 100000, step: "0.0001", inputmode: "decimal", class: "num-input", value: has(v) ? v : "", ...attrs });
  const drawList = () =>
    clear(
      list,
      rows.map((r, idx) => {
        const off = official[r.model];
        const costBox = h("div");
        const drawCost = () =>
          clear(
            costBox,
            TIERS.map(([k, l]) =>
              r.custom || !off
                ? num(r.cost[k], { "aria-label": `${r.model} 成本 ${l}`, placeholder: k === "input" || k === "output" ? "必填" : "回退", oninput: (e) => (r.cost[k] = e.target.value === "" ? null : Number(e.target.value)) })
                : h("span", { class: "num ro" }, has(off[k]) ? fmt.price(off[k]) : "—"),
            ),
          );
        drawCost();
        return h(
          "section",
          { class: "price-model" },
          h(
            "header",
            {},
            h("div", { class: "cell-2" }, h("b", {}, r.label || r.model), mono(r.model)),
            h("span", { class: "spacer" }),
            off
              ? h(
                  "label",
                  { class: "field-check" },
                  h("input", { type: "checkbox", checked: r.custom, onchange: (e) => ((r.custom = e.target.checked), drawCost()) }),
                  h("span", {}, "自定成本（不用官方价）"),
                )
              : h("span", { class: "muted small" }, "官方价表没有这个型号：须自定成本"),
            !r.referenced ? btn("移除", () => (rows.splice(idx, 1), drawList()), { size: "sm", kind: "ghost", title: "没有别名用它：移除后这个型号不再出现在价目里" }) : null,
          ),
          h(
            "div",
            { class: "price-grid" },
            h("span", { class: "pg-head" }, ""),
            TIERS.map(([, l]) => h("span", { class: "pg-head" }, l)),
            h("span", { class: "pg-label" }, r.custom || !off ? "成本（自定）" : "成本（官方价）"),
            costBox,
            h("span", { class: "pg-label" }, "显式售价"),
            TIERS.map(([k, l]) => num(r.sale[k], { "aria-label": `${r.model} 显式售价 ${l}`, placeholder: "按倍率", oninput: (e) => (r.sale[k] = e.target.value === "" ? null : Number(e.target.value)) })),
          ),
          h(
            "div",
            { class: "price-model-foot" },
            h("label", { class: "inline-field" }, "倍率覆盖", h("input", { type: "number", min: 0.01, max: 100, step: "0.01", class: "num-input", value: r.markup ?? "", placeholder: "用整表", "aria-label": `${r.model} 倍率覆盖`, oninput: (e) => (r.markup = e.target.value === "" ? null : Number(e.target.value)) })),
            r.custom || !off ? h("label", { class: "inline-field grow" }, "成本来源", h("input", { type: "text", maxlength: 80, value: r.cost_source, placeholder: "如：合同价 2026-12", "aria-label": `${r.model} 成本来源`, oninput: (e) => (r.cost_source = e.target.value) })) : null,
          ),
        );
      }),
    );
  drawList();
  const addIn = h("input", { type: "text", placeholder: "上游型号，如 kimi-k3", spellcheck: "false", "aria-label": "新增型号" });
  const addBtn = btn("加一个型号", () => {
    const m = addIn.value.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/.test(m)) return void toast("型号只许字母、数字与 . _ : / -", "error");
    if (rows.some((r) => r.model === m)) return void toast("已有这个型号", "error");
    rows.push({ model: m, label: official[m]?.label ?? "", custom: !official[m], cost: {}, cost_source: "", markup: null, sale: {}, referenced: false, old: null });
    addIn.value = "";
    drawList();
  }, { size: "sm", icon: icon("plus") });
  const err = h("p", { class: "form-error", role: "alert" });
  const form = h(
    "form",
    { class: "drawer-form", novalidate: true },
    h("div", { class: "price-global" }, h("label", { class: "inline-field" }, "整表加价倍率", markupIn), h("label", { class: "inline-field grow" }, "说明", noteIn)),
    note("售价 = 成本 × 倍率（按型号的倍率优先于整表），填了显式售价的档不按倍率。缺价回退：命中、5 分钟写入缺 → 未命中价；1 小时写入缺 → 5 分钟写入价。单价元 / 百万 token，0–100000。"),
    list,
    h("div", { class: "btn-row" }, addIn, addBtn),
    err,
    h("div", { class: "drawer-foot" }, h("span", { class: "spacer" }), h("button", { type: "button", class: "btn", onclick: () => dr.close() }, "取消"), h("button", { type: "submit", class: "btn primary" }, "生成新版本…")),
  );
  const dr = openDrawer({ title: "调整价目", subtitle: `当前 v${d.version} · ${d.basis === "model" ? "按上游型号" : "按别名（保存后改为按型号）"}`, body: form, wide: true });
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    err.textContent = "";
    const markup = Number(markupIn.value);
    if (!(markup >= 0.01 && markup <= 100)) return void (err.textContent = "整表倍率须在 0.01–100");
    const body = { markup, ...(noteIn.value.trim() ? { note: noteIn.value.trim() } : {}), models: {} };
    const changes = [];
    for (const r of rows) {
      const bad = [...TIERS.map(([k]) => r.cost[k]), ...TIERS.map(([k]) => r.sale[k])].some((v) => has(v) && !(Number.isFinite(v) && v >= 0 && v <= 100000));
      if (bad) return void (err.textContent = `${r.model} 的单价须为 0–100000 的数字或留空`);
      if (has(r.markup) && !(r.markup >= 0.01 && r.markup <= 100)) return void (err.textContent = `${r.model} 的倍率须在 0.01–100`);
      const off = official[r.model];
      const custom = r.custom || !off;
      if (custom && (!has(r.cost.input) || !has(r.cost.output))) return void (err.textContent = `${r.model} 自定成本时“未命中输入”与“输出”必填`);
      const item = {};
      if (r.label && !off) item.label = r.label;
      if (custom) {
        item.cost = Object.fromEntries(TIERS.map(([k]) => [k, has(r.cost[k]) ? r4(r.cost[k]) : null]));
        if (r.cost_source.trim()) item.cost_source = r.cost_source.trim();
      }
      if (has(r.markup)) item.markup = r.markup;
      const sale = Object.fromEntries(TIERS.filter(([k]) => has(r.sale[k])).map(([k]) => [k, r4(r.sale[k])]));
      if (Object.keys(sale).length) item.sale = sale;
      body.models[r.model] = item;
      // 改动预览：按新规则算未命中输入与输出的售价，与现行生效值比
      const cost = custom ? item.cost : off;
      const mk = has(r.markup) ? r.markup : markup;
      for (const [k, l] of [["input", "输入"], ["output", "输出"]]) {
        const next = has(sale[k]) ? sale[k] : has(cost?.[k]) ? r4(cost[k] * mk) : null;
        const prev = r.old?.effective?.sale?.[k] ?? null;
        if (prev !== next) changes.push(`${r.model} 售价 · ${l}：${prev === null ? "未定价" : fmt.price(prev)} → ${next === null ? "未定价" : fmt.price(next)}`);
      }
    }
    for (const m of d.models) if (!rows.some((r) => r.model === m.model)) changes.push(`${m.model}：从价目移除`);
    if (markup !== d.markup) changes.unshift(`整表倍率：× ${fmt.num(d.markup)} → × ${fmt.num(markup)}`);
    const below = rows.filter((r) => TIERS.some(([k]) => has(r.sale[k]) && has((r.custom || !official[r.model] ? r.cost : official[r.model])?.[k]) && r.sale[k] < (r.custom || !official[r.model] ? r.cost : official[r.model])[k])).map((r) => r.model);
    const ok = await confirmAction({
      title: "生成新价目版本",
      danger: true,
      lead: changes.length ? h("ul", { class: "diff-list" }, changes.slice(0, 14).map((c) => h("li", {}, c)), changes.length > 14 ? h("li", {}, `……共 ${changes.length} 项`) : null) : h("p", {}, "售价没有变化（可能只改了成本、说明或缓存档）。"),
      consequences: [
        `生成价目 v${(Number(d.version) || 0) + 1}（按上游型号），下一请求起生效（网关每 15 秒取一次）；之前的请求仍按原版本记账；`,
        "按金额计费的律所：同样的用量扣得多或少，本期百分比随之变化；",
        "有金额套餐要用的别名失去售价时控制面会拒绝，不产生新版本。",
        below.length ? `注意：${below.join("、")} 有显式售价低于成本（亏本）。` : null,
      ].filter(Boolean),
      confirmLabel: "生成新版本",
      run: () => api.pricing.save(body),
    });
    if (ok) {
      toast(`已生成价目 v${ok.version ?? ""}`);
      dr.close();
      reload();
    }
  });
}
