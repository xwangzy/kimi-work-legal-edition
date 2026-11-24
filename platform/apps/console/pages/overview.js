/**
 * 总览（第 62 批重排）：一页只回答两个问题——“现在有什么要处理”“本期经营得怎样”。
 *   ① 信号条：未确认告警、即将用完、上游异常、未定价用量、待开通、30 天内到期、设备异常（为 0 退成灰色；点开即到对应的筛选列表）；
 *   ② 指标条：本期应收（主指标）、毛利与毛利率、模型成本、用量价值、请求（错误率）、token（缓存命中率）；
 *   ③ 用量趋势（token / 请求 / 金额）+ 需要关注（告警可就地确认、即将用完的律所）；
 *   ④ 按模型、上游健康、规模。
 * 接口：GET /v1/ops/overview?days=7|30；“即将用完”另读 GET /v1/ops/tenants（按 forecast_exhaust_at 与 used_ratio 挑，不另算）。
 * 后端按权限裁剪（hidden: usage / billing）：裁掉的指标整格不画，不显示成 0。
 */
import * as api from "../api.js";
import { alertList, can, ctx, go, pageHead, providerBadge } from "../domain.js";
import { clear, emptyBlock, errorBlock, fmt, h, hbars, icon, load, marginBar, metaLine, meter, panel, segmented, signals, stat, trendChart } from "../ui.js";

const st = { days: 30, metric: "tokens" };

/** 即将用完：在用、且（已过 80% / 已暂停 / 按当前速度本期内用完） */
export const nearlyOut = (tenants, resetsAt) =>
  tenants
    .filter((x) => x.status === "active" && (Number(x.used_ratio) >= 0.8 || x.paused || (x.forecast_exhaust_at && Date.parse(x.forecast_exhaust_at) < resetsAt)))
    .sort((a, b) => (Number(b.used_ratio) || 0) - (Number(a.used_ratio) || 0));

export function render(page) {
  const box = h("div", { class: "stack-lg" });
  const head = h("div");
  page.append(head, box);
  const drawHead = (ov) =>
    clear(
      head,
      pageHead(
        "总览",
        ov ? metaLine(`本期 ${fmt.period(ov.period) ?? "—"}`, fmt.resetLine(ov.period?.resets_at), `数据生成于 ${fmt.time(ov.generated_at)}`) : "本期平台用量与需要处理的事",
        segmented([{ id: 7, label: "近 7 日" }, { id: 30, label: "近 30 日" }], st.days, (d) => ((st.days = d), ctx.reload()), "趋势天数"),
      ),
    );
  drawHead(null);
  load(
    box,
    async () => {
      const [ov, tl] = await Promise.allSettled([api.get("/v1/ops/overview", { days: st.days }), api.get("/v1/ops/tenants")]);
      if (ov.status === "rejected") throw ov.reason;
      return { ov: ov.value, tenants: tl.status === "fulfilled" ? tl.value.tenants ?? [] : tl.reason };
    },
    ({ ov, tenants }) => (drawHead(ov), draw(box, ov, tenants)),
    "正在读取总览…",
  );
}

function draw(box, ov, tenants) {
  const t = ov.totals ?? {};
  // 后端按权限裁剪（第 46 批）：没有账单权限不给金额、没有用量权限不给请求与 token——对应格子不画，不显示成 0
  const hide = new Set(ov.hidden ?? []);
  const tokens = (Number(t.tokens_in) || 0) + (Number(t.tokens_out) || 0);
  const marginRate = Number(t.revenue_cny) > 0 && t.margin_cny !== null && t.margin_cny !== undefined ? Number(t.margin_cny) / Number(t.revenue_cny) : null;
  const errRate = Number(t.requests) > 0 ? Number(t.errors) / Number(t.requests) : null;
  const cacheRate = Number(t.tokens_in) > 0 ? Number(t.tokens_cached) / Number(t.tokens_in) : null;
  const open = ov.attention ?? [];
  ctx.setNavBadge?.("alerts", open.length);

  // ── ① 信号 ──
  const resetsAt = Date.parse(ov.period?.resets_at ?? "");
  const soon = Array.isArray(tenants) ? nearlyOut(tenants, resetsAt) : null;
  const providers = ov.routing?.providers ?? [];
  const badProviders = providers.filter((p) => p.state && p.state !== "up" && p.state !== "unknown");
  const silent = providers.filter((p) => !p.state || p.state === "unknown");
  const tn = ov.tenants ?? {};
  const dv = ov.devices ?? {};
  const a = ov.accounts ?? {};
  const critical = open.some((x) => x.level === "critical");
  const sig = signals([
    { label: "未确认告警", count: open.length, tone: critical ? "danger" : "warn", hint: critical ? "含严重告警" : "跨阈值、到上限、异常", zeroHint: "没有待确认", onClick: () => go("ops/alerts") },
    { label: "即将用完", count: soon ? soon.length : null, tone: "warn", hint: soon?.[0] ? `${soon[0].name ?? soon[0].tid} ${fmt.pct(soon[0].used_ratio)}` : "", zeroHint: "本期内都够用", onClick: () => go("ops/tenants?filter=attention") },
    { label: "上游异常", count: badProviders.length, tone: "danger", hint: badProviders.map((p) => p.label ?? p.id).join("、"), zeroHint: silent.length ? `${silent.length} 个未上报` : "全部正常", onClick: can("route.read") ? () => go("ops/routing") : undefined },
    hide.has("billing") ? null : { label: "未定价用量", count: t.unpriced_rows ?? null, tone: "warn", hint: "行请求未计入金额", zeroHint: "全部已定价", onClick: () => go("ops/pricing") },
    { label: "待开通律所", count: tn.pending ?? null, tone: "info", hint: "创始开通未完成", zeroHint: "没有", onClick: () => go("ops/tenants?filter=pending") },
    { label: "30 天内到期", count: tn.expiring_30d ?? null, tone: "warn", hint: "需续订", zeroHint: "没有", onClick: () => go("ops/tenants?filter=expiring") },
    can("account.read") ? { label: "设备异常", count: dv.flagged ?? null, tone: "warn", hint: "久未报到、版本过旧等", zeroHint: "没有", onClick: () => go("ops/devices") } : null,
  ]);

  // ── ② 指标 ──
  const kpis = h(
    "div",
    { class: "kpis" },
    hide.has("billing") ? null : stat("本期应收", fmt.cnyCompact(t.revenue_cny), "席位费 + 加量费", { hero: true, title: fmt.cny(t.revenue_cny) }),
    hide.has("billing") ? null : stat("毛利", fmt.cnyCompact(t.margin_cny), marginRate === null ? "应收 − 模型成本" : `毛利率 ${fmt.pct(marginRate)}`, { hero: true, title: fmt.cny(t.margin_cny), tone: Number(t.margin_cny) < 0 ? "danger" : undefined, extra: marginRate === null ? null : marginBar(marginRate) }),
    hide.has("billing") ? null : stat("模型成本", fmt.cny(t.cost_cny), "上游成本价 × 实际用量"),
    hide.has("billing") ? null : stat("用量价值", fmt.cny(t.value_cny), "价目售价 × 实际用量"),
    hide.has("usage") ? null : stat("本期请求", fmt.int(t.requests), [errRate === null ? null : `错误率 ${fmt.pct(errRate)}`, t.estimated_rows ? `估算 ${fmt.int(t.estimated_rows)} 行` : null].filter(Boolean).join(" · ") || "—", { tone: errRate !== null && errRate >= 0.05 ? "warn" : undefined, title: `错误 ${fmt.int(t.errors)} 次` }),
    hide.has("usage") ? null : stat("Token", fmt.tokens(tokens), `输入 ${fmt.tokens(t.tokens_in)} · 输出 ${fmt.tokens(t.tokens_out)}${cacheRate === null ? "" : ` · 缓存 ${fmt.pct(cacheRate)}`}`, { title: `${fmt.int(tokens)} token` }),
  );

  // ── ③ 趋势 ──
  const daily = ov.daily ?? [];
  const labels = daily.map((d) => d.day);
  const metricDefs = {
    tokens: { series: [{ name: "输入", values: daily.map((d) => Number(d.tokens_in ?? 0) || 0), kind: "bar", stack: true }, { name: "输出", values: daily.map((d) => Number(d.tokens_out ?? 0) || 0), kind: "bar", stack: true, cls: "s2" }], format: (v) => fmt.tokens(v) },
    requests: { series: [{ name: "请求", values: daily.map((d) => Number(d.requests) || 0), kind: "bar" }, { name: "错误", values: daily.map((d) => Number(d.errors) || 0), kind: "line", cls: "s-danger" }], format: (v) => fmt.int(v) },
    money: { series: [{ name: "用量价值", values: daily.map((d) => (d.value_cny === null ? null : Number(d.value_cny) || 0)), kind: "bar" }, { name: "成本", values: daily.map((d) => (d.cost_cny === null ? null : Number(d.cost_cny) || 0)), kind: "line", cls: "s-warn" }], format: (v) => fmt.cny(v, v >= 100 ? 0 : 2) },
  };
  // 控制面的 daily 只给合计 tokens 时退回单柱
  if (daily.length && daily.every((d) => d.tokens_in === undefined)) metricDefs.tokens = { series: [{ name: "Token", values: daily.map((d) => Number(d.tokens) || 0), kind: "bar" }], format: (v) => fmt.tokens(v) };
  const trendBody = h("div");
  const drawTrend = () => clear(trendBody, daily.length ? trendChart({ labels, series: metricDefs[st.metric].series, format: metricDefs[st.metric].format, tick: (l) => l.slice(5), height: 220 }) : emptyBlock("这段时间没有用量"));
  if (hide.has("billing") && st.metric === "money") st.metric = "tokens";
  if (hide.has("usage")) clear(trendBody, emptyBlock("需要“用量”查看权限", "请联系系统管理员调整角色"));
  else drawTrend();
  const metricSeg = h("span");
  const drawSeg = () =>
    clear(
      metricSeg,
      segmented([{ id: "tokens", label: "Token" }, { id: "requests", label: "请求" }, ...(hide.has("billing") ? [] : [{ id: "money", label: "金额" }])], st.metric, (id) => {
        st.metric = id;
        drawSeg();
        drawTrend();
      }, "趋势指标"),
    );
  if (!hide.has("usage")) drawSeg();

  // 需要关注：告警（可就地确认）+ 即将用完
  const calm = open.length === 0 && Array.isArray(soon) && soon.length === 0;
  const attention = calm
    ? h("div", { class: "all-good" }, h("span", { class: "ok-mark", "aria-hidden": "true" }, icon("check")), h("span", {}, h("b", {}, "没有需要处理的事"), h("br"), h("small", { class: "muted" }, "没有未确认的告警，也没有律所会在本期内用完。")))
    : h(
    "div",
    { class: "attention" },
    h("h4", {}, "未确认告警", h("span", { class: "count" }, String(open.length)), open.length > 5 ? h("button", { type: "button", class: "link small", onclick: () => go("ops/alerts") }, `全部 ${open.length} 条`, icon("chevron")) : null),
    alertList(open.slice(0, 5), { onAck: () => ctx.reload(), compact: true }),
    h("h4", {}, "即将用完", soon ? h("span", { class: "count" }, String(soon.length)) : null, soon?.length > 5 ? h("button", { type: "button", class: "link small", onclick: () => go("ops/tenants?filter=attention") }, "全部", icon("chevron")) : null),
    soon === null
      ? errorBlock(tenants)
      : soon.length
        ? h(
            "ul",
            { class: "soon" },
            soon.slice(0, 5).map((x) =>
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
  );

  // ── ④ 按模型、上游健康、规模 ──
  const models = (ov.by_model ?? []).map((x) => ({ label: x.label ?? x.alias, value: Number(x.tokens) || 0, note: [fmt.pct(x.share), `${fmt.int(x.requests)} 次`, hide.has("billing") ? null : fmt.cny(x.value_cny)].filter(Boolean).join(" · "), title: x.alias }));
  const scaleItem = (label, total, rows) => h("div", { class: "scale-item" }, h("span", { class: "stat-label" }, label), h("span", { class: "stat-value num" }, fmt.int(total)), h("ul", {}, rows.map(([k, v]) => h("li", {}, h("span", {}, k), h("b", {}, fmt.int(v))))));

  clear(
    box,
    sig,
    kpis.childElementCount ? kpis : null,
    h(
      "div",
      { class: "grid-2-1" },
      panel("用量趋势", trendBody, { sub: `近 ${st.days} 日 · 北京时间`, actions: metricSeg }),
      panel("需要关注", attention),
    ),
    h(
      "div",
      { class: "grid-3" },
      panel("按模型", hide.has("usage") ? emptyBlock("需要“用量”查看权限") : hbars(models, { format: (v) => `${fmt.tokens(v)} token`, empty: "本期还没有模型用量" }), { sub: "本期 token" }),
      panel(
        "上游健康",
        providers.length
          ? h(
              "ul",
              { class: "health" },
              providers.map((p) => h("li", {}, h("span", { class: "health-name" }, p.label ?? p.id, h("small", { class: "mono" }, p.id)), providerBadge(p, true), h("span", { class: "num muted", title: `回报于 ${fmt.ago(p.updated_at)}` }, fmt.ms(p.latency_ms)))),
            )
          : emptyBlock("还没有上游", "在“模型与路由”里登记上游"),
        { sub: ov.routing?.version !== undefined ? `路由 v${ov.routing.version}` : undefined, actions: can("route.read") ? h("button", { type: "button", class: "link small", onclick: () => go("ops/routing") }, "路由", icon("chevron")) : null },
      ),
      panel(
        "规模",
        h(
          "div",
          { class: "scale" },
          scaleItem("律所", tn.total, [["在用", tn.active], ["待开通", tn.pending], ["30 天内到期", tn.expiring_30d]]),
          scaleItem("账号", a.total, [["7 日活跃", a.active_7d], ["7 日新增", a.new_7d], ["已停用", a.disabled]]),
          scaleItem("设备", dv.total, [["7 日活跃", dv.active_7d], ["标记异常", dv.flagged]]),
        ),
      ),
    ),
  );
}
