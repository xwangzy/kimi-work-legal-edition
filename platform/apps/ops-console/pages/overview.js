/**
 * 总览：本期平台用量（token、用量价值、成本、请求数）、需要关注（告警、即将用完、上游异常）、7/30 日趋势、上游健康。
 * 接口：GET /v1/ops/overview?days=7|30；“即将用完”另读 GET /v1/ops/tenants（按 forecast_exhaust_at 与 used_ratio 挑，不另算）。
 */
import * as api from "../api.js";
import { alertList, ctx, go, pageHead, periodText, providerBadge } from "../domain.js";
import { clear, emptyBlock, errorBlock, facts, fmt, h, hbars, load, meter, panel, segmented, stat, trendChart } from "../ui.js";

const st = { days: 30, metric: "tokens" };

export function render(page) {
  const box = h("div", { class: "stack" });
  const head = pageHead("总览", "本期平台用量与需要关注的事", segmented([{ id: 7, label: "近 7 日" }, { id: 30, label: "近 30 日" }], st.days, (d) => ((st.days = d), ctx.reload()), "趋势天数"));
  page.append(head, box);
  load(
    box,
    async () => {
      const [ov, tl] = await Promise.allSettled([api.get("/v1/ops/overview", { days: st.days }), api.get("/v1/ops/tenants")]);
      if (ov.status === "rejected") throw ov.reason;
      return { ov: ov.value, tenants: tl.status === "fulfilled" ? tl.value.tenants ?? [] : tl.reason };
    },
    ({ ov, tenants }) => draw(box, ov, tenants),
    "正在读取总览…",
  );
}

function draw(box, ov, tenants) {
  const t = ov.totals ?? {};
  const tokens = (Number(t.tokens_in) || 0) + (Number(t.tokens_out) || 0);
  const marginRate = Number(t.revenue_cny) > 0 && t.margin_cny !== null && t.margin_cny !== undefined ? Number(t.margin_cny) / Number(t.revenue_cny) : null;
  ctx.setNavBadge?.("overview", (ov.attention ?? []).length);
  const kpis = h(
    "div",
    { class: "kpis" },
    stat("本期请求", fmt.int(t.requests), [`错误 ${fmt.int(t.errors)}`, t.estimated_rows ? `估算 ${fmt.int(t.estimated_rows)} 行` : null, t.unpriced_rows ? `未定价 ${fmt.int(t.unpriced_rows)} 行` : null].filter(Boolean).join(" · "), { tone: Number(t.errors) > 0 ? "warn" : undefined }),
    stat("Token", fmt.tokens(tokens), `输入 ${fmt.tokens(t.tokens_in)}（缓存 ${fmt.tokens(t.tokens_cached)}）· 输出 ${fmt.tokens(t.tokens_out)}`, { title: `${fmt.int(tokens)} token` }),
    stat("用量价值", fmt.cny(t.value_cny), "价目售价 × 实际用量"),
    stat("模型成本", fmt.cny(t.cost_cny), "上游成本价 × 实际用量"),
    stat("本期应收", fmt.cny(t.revenue_cny), "席位费 + 加量费"),
    stat("毛利", fmt.cny(t.margin_cny), marginRate === null ? "应收 − 成本" : `毛利率 ${fmt.pct(marginRate)}`, { tone: Number(t.margin_cny) < 0 ? "danger" : undefined }),
  );

  // 趋势
  const daily = ov.daily ?? [];
  const labels = daily.map((d) => d.day);
  const metricDefs = {
    tokens: { series: [{ name: "Token", values: daily.map((d) => Number(d.tokens) || 0), kind: "bar" }], format: (v) => fmt.tokens(v) },
    requests: { series: [{ name: "请求", values: daily.map((d) => Number(d.requests) || 0), kind: "bar" }, { name: "错误", values: daily.map((d) => Number(d.errors) || 0), kind: "line", cls: "s-danger" }], format: (v) => fmt.int(v) },
    money: { series: [{ name: "用量价值", values: daily.map((d) => (d.value_cny === null ? null : Number(d.value_cny) || 0)), kind: "bar" }, { name: "成本", values: daily.map((d) => (d.cost_cny === null ? null : Number(d.cost_cny) || 0)), kind: "line", cls: "s-warn" }], format: (v) => fmt.cny(v, v >= 100 ? 0 : 2) },
  };
  const trendBody = h("div");
  const drawTrend = () => clear(trendBody, daily.length ? trendChart({ labels, series: metricDefs[st.metric].series, format: metricDefs[st.metric].format, tick: (l) => l.slice(5), height: 200 }) : emptyBlock("这段时间没有用量"));
  drawTrend();
  const metricSeg = h("span");
  const drawSeg = () =>
    clear(
      metricSeg,
      segmented([{ id: "tokens", label: "Token" }, { id: "requests", label: "请求" }, { id: "money", label: "金额" }], st.metric, (id) => {
        st.metric = id;
        drawSeg();
        drawTrend();
      }, "趋势指标"),
    );
  drawSeg();

  // 需要关注：告警 + 即将用完 + 上游异常
  const resetsAt = Date.parse(ov.period?.resets_at ?? "");
  const soon = Array.isArray(tenants)
    ? tenants
        .filter((x) => x.status === "active" && (Number(x.used_ratio) >= 0.8 || x.paused || (x.forecast_exhaust_at && Date.parse(x.forecast_exhaust_at) < resetsAt)))
        .sort((a, b) => (Number(b.used_ratio) || 0) - (Number(a.used_ratio) || 0))
        .slice(0, 8)
    : null;
  const badProviders = (ov.routing?.providers ?? []).filter((p) => p.state && p.state !== "up" && p.state !== "unknown");
  const silent = (ov.routing?.providers ?? []).filter((p) => !p.state || p.state === "unknown");
  const attention = h(
    "div",
    { class: "attention" },
    h("h4", {}, "告警", h("span", { class: "count" }, String((ov.attention ?? []).length))),
    alertList(ov.attention ?? [], { onAck: () => ctx.reload(), compact: true }),
    h("h4", {}, "即将用完", soon ? h("span", { class: "count" }, String(soon.length)) : null),
    soon === null
      ? errorBlock(tenants)
      : soon.length
        ? h(
            "ul",
            { class: "soon" },
            soon.map((x) =>
              h(
                "li",
                {},
                h("button", { type: "button", class: "link", onclick: () => go(`tenants/${encodeURIComponent(x.tid)}`) }, x.name ?? x.tid),
                meter({ ratio: x.used_ratio, used: x.used, total: x.total, unit: x.unit, resetsAt: x.period?.resets_at, capPct: x.cap_pct, paused: x.paused, inflight: x.in_flight_ratio, compact: true }),
                h("small", { class: "muted" }, x.forecast_exhaust_at ? `按当前速度 ${fmt.time(x.forecast_exhaust_at)} 用完` : x.paused ? "已暂停" : "已过 80%"),
              ),
            ),
          )
        : h("p", { class: "muted small" }, "没有律所会在本期内用完。"),
    h("h4", {}, "上游异常", h("span", { class: "count" }, String(badProviders.length))),
    badProviders.length
      ? h("ul", { class: "soon" }, badProviders.map((p) => h("li", {}, h("button", { type: "button", class: "link", onclick: () => go("routing") }, p.label ?? p.id), providerBadge(p, true))))
      : h("p", { class: "muted small" }, silent.length ? `没有异常；${silent.length} 个上游还没有健康回报（网关没连上控制面，或刚登记）。` : "所有上游正常。"),
  );

  const models = (ov.by_model ?? []).map((x) => ({ label: x.label ?? x.alias, value: Number(x.tokens) || 0, note: `${fmt.pct(x.share)} · ${fmt.int(x.requests)} 次 · ${fmt.cny(x.value_cny)}`, title: x.alias }));
  const providers = ov.routing?.providers ?? [];
  const a = ov.accounts ?? {};
  const tn = ov.tenants ?? {};
  const dv = ov.devices ?? {};

  clear(
    box,
    h("p", { class: "period-line" }, `本期 ${periodText(ov.period)}（北京时间）`, h("span", { class: "muted" }, ` · 数据生成于 ${fmt.time(ov.generated_at)}`)),
    kpis,
    h(
      "div",
      { class: "grid-2-1" },
      panel("用量趋势", trendBody, { sub: `近 ${st.days} 日，按北京时间日`, actions: metricSeg }),
      panel("需要关注", attention),
    ),
    h(
      "div",
      { class: "grid-3" },
      panel("按模型", hbars(models, { format: (v) => `${fmt.tokens(v)} token`, empty: "本期还没有模型用量" })),
      panel(
        "上游健康",
        providers.length
          ? h(
              "ul",
              { class: "health" },
              providers.map((p) => h("li", {}, h("span", { class: "health-name" }, p.label ?? p.id, h("small", { class: "mono" }, p.id)), providerBadge(p, true), h("span", { class: "num muted" }, fmt.ms(p.latency_ms)), h("small", { class: "muted" }, fmt.ago(p.updated_at)))),
            )
          : emptyBlock("还没有上游", "在“模型与路由”里登记上游"),
        { sub: ov.routing?.version !== undefined ? `路由版本 v${ov.routing.version}` : undefined },
      ),
      panel(
        "规模",
        facts([
          ["律所", `${fmt.int(tn.total)}（在用 ${fmt.int(tn.active)} · 待开通 ${fmt.int(tn.pending)} · 30 天内到期 ${fmt.int(tn.expiring_30d)}）`],
          ["账号", `${fmt.int(a.total)}（7 日活跃 ${fmt.int(a.active_7d)} · 7 日新增 ${fmt.int(a.new_7d)} · 已停用 ${fmt.int(a.disabled)}）`],
          ["设备", `${fmt.int(dv.total)}（7 日活跃 ${fmt.int(dv.active_7d)} · 标记异常 ${fmt.int(dv.flagged)}）`],
        ]),
      ),
    ),
  );
}
