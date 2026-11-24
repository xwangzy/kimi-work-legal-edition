/**
 * 总览（第 62 批第二轮重排）：一页只回答两个问题——“现在有什么要处理”“本期经营得怎样”。
 *   ① 需要关注 = 唯一的待办来源：只列非零项，一项一行（状态点 + 一句话 + 直达动作）；为 0 的项收成一行安静的“其余 N 项正常”。
 *      颜色只留给状态点：红 = 严重（上游不可用、严重告警、律所已暂停），橙 = 注意，灰 = 待办；不用整块底色。
 *      未确认告警就地可确认（原“需要关注”里的能力保留）。
 *   ② 指标条：本期应收、毛利与毛利率、模型成本、用量价值、请求（错误率）、token；金额一律两位小数。
 *   ③ 用量趋势 + 上游健康；④ 按模型 + 规模。
 * 接口：GET /v1/ops/overview?days=7|30；“即将用完”另读 GET /v1/ops/tenants（按 forecast_exhaust_at 与 used_ratio 挑，不另算）。
 * 后端按权限裁剪（hidden: usage / billing）：裁掉的指标与待办整项不出现，不显示成 0。
 */
import * as api from "../api.js";
import { ALERT_KIND, can, ctx, go, pageHead, providerBadge, PROVIDER_STATE } from "../domain.js";
import { btn, clear, emptyBlock, errorBlock, fmt, h, hbars, icon, load, marginBar, metaLine, panel, segmented, stat, toast, trendChart } from "../ui.js";

const st = { days: 30, metric: "tokens" };
const SEV = { danger: 0, warn: 1, neutral: 2 };

/** 即将用完：在用、且（已过 80% / 已暂停 / 按当前速度本期内用完） */
export const nearlyOut = (tenants, resetsAt) =>
  tenants
    .filter((x) => x.status === "active" && (Number(x.used_ratio) >= 0.8 || x.paused || (x.forecast_exhaust_at && Date.parse(x.forecast_exhaust_at) < resetsAt)))
    .sort((a, b) => (Number(b.used_ratio) || 0) - (Number(a.used_ratio) || 0));

/**
 * 待办清单：items = [{label（为 0 时的名字）, count, sev, text, sub?, action:[文字, 去处], extra?}]；count 为 0 的收进“其余 N 项正常”，
 * count 为 null（读不到）的不出现。纯函数部分（分拣）导出给用例。
 */
export function sortTodo(items) {
  const known = items.filter((x) => x && x.count !== null && x.count !== undefined);
  return { open: known.filter((x) => x.count > 0).sort((a, b) => SEV[a.sev] - SEV[b.sev]), calm: known.filter((x) => x.count === 0) };
}
function todoList(items) {
  const { open, calm } = sortTodo(items);
  return h(
    "div",
    {},
    open.length
      ? h(
          "ul",
          { class: "todo" },
          open.map((x) =>
            h(
              "li",
              { class: "todo-item" },
              h("span", { class: `dot tone-${x.sev === "neutral" ? "neutral" : x.sev}`, title: { danger: "严重", warn: "注意", neutral: "待办" }[x.sev], "aria-hidden": "true" }),
              h("div", { class: "todo-text" }, h("b", {}, x.text), x.sub ? h("small", { title: typeof x.sub === "string" ? x.sub : undefined }, x.sub) : null, x.extra ?? null),
              x.action ? h("div", { class: "todo-act" }, btn(x.action[0], () => go(x.action[1]), { size: "sm" })) : null,
            ),
          ),
        )
      : h("p", { class: "todo-empty" }, h("span", { class: "dot", "aria-hidden": "true" }), "没有需要处理的事"),
    calm.length ? h("p", { class: "todo-rest" }, h("span", { class: "dot", "aria-hidden": "true" }), `其余 ${calm.length} 项正常：${calm.map((x) => x.label).join("、")}`) : null,
  );
}

/** 待办里的告警：一行一条（种类 · 对象 · 时间 + 说明），就地确认；不套卡片、不铺底色 */
function alertLines(alerts) {
  return h(
    "ul",
    { class: "todo-sub" },
    alerts.map((a) =>
      h(
        "li",
        {},
        h("span", { class: "todo-sub-main" }, h("b", {}, ALERT_KIND[a.kind] ?? a.kind), h("span", { class: "muted" }, [a.tenant_name ?? a.tid, a.provider ? `上游 ${a.provider}` : null, fmt.time(a.at)].filter(Boolean).join(" · ")), h("small", { title: a.message ?? "" }, a.message ?? "")),
        btn("确认", async (ev) => {
          const b = ev.currentTarget;
          b.disabled = true;
          try {
            await api.post(`/v1/ops/alerts/${api.seg(a.id)}/ack`);
            toast("已确认告警");
            ctx.reload();
          } catch (e) {
            b.disabled = false;
            toast(e.message, "error");
          }
        }, { size: "sm", kind: "ghost" }),
      ),
    ),
  );
}

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
  const hide = new Set(ov.hidden ?? []);
  const tokens = (Number(t.tokens_in) || 0) + (Number(t.tokens_out) || 0);
  const marginRate = Number(t.revenue_cny) > 0 && t.margin_cny !== null && t.margin_cny !== undefined ? Number(t.margin_cny) / Number(t.revenue_cny) : null;
  const errRate = Number(t.requests) > 0 ? Number(t.errors) / Number(t.requests) : null;
  const cacheRate = Number(t.tokens_in) > 0 ? Number(t.tokens_cached) / Number(t.tokens_in) : null;
  const open = ov.attention ?? [];
  ctx.setNavBadge?.("alerts", open.length);

  // ── ① 需要关注 ──
  const resetsAt = Date.parse(ov.period?.resets_at ?? "");
  const soon = Array.isArray(tenants) ? nearlyOut(tenants, resetsAt) : null;
  const paused = soon ? soon.filter((x) => x.paused) : [];
  const providers = ov.routing?.providers ?? [];
  const badProviders = providers.filter((p) => p.state && p.state !== "up" && p.state !== "unknown");
  const severeProvider = badProviders.some((p) => p.state !== "degraded");
  const tn = ov.tenants ?? {};
  const dv = ov.devices ?? {};
  const a = ov.accounts ?? {};
  const critical = open.some((x) => x.level === "critical");
  const names = (list, n = 3) => list.slice(0, n).map((x) => x.name ?? x.tid).join("、") + (list.length > n ? ` 等 ${list.length} 家` : "");
  const todo = todoList([
    {
      label: "上游",
      count: badProviders.length,
      sev: severeProvider ? "danger" : "warn",
      text: badProviders.length === 1 ? `上游“${badProviders[0].label ?? badProviders[0].id}”${(PROVIDER_STATE[badProviders[0].state] ?? [badProviders[0].state])[0]}` : `${badProviders.length} 个上游异常`,
      sub: badProviders.map((p) => `${p.label ?? p.id}：${(PROVIDER_STATE[p.state] ?? [p.state])[0]}${p.last_error ? `（${p.last_error}）` : ""}${p.latency_ms ? ` · ${fmt.ms(p.latency_ms)}` : ""}`).join("；"),
      action: can("route.read") ? ["去模型与路由", "ops/routing"] : null,
    },
    {
      label: "告警",
      count: open.length,
      sev: critical ? "danger" : "warn",
      text: `${open.length} 条告警未确认${critical ? "（含严重）" : ""}`,
      extra: open.length ? alertLines(open.slice(0, 3)) : null,
      action: ["全部告警", "ops/alerts"],
    },
    {
      label: "额度",
      count: soon ? soon.length : null,
      sev: paused.length ? "danger" : "warn",
      text: paused.length ? `${paused.length} 家律所已暂停${soon.length > paused.length ? `，另 ${soon.length - paused.length} 家即将用完` : ""}` : `${soon?.length ?? 0} 家律所本期内会用完`,
      sub: soon?.length ? soon.slice(0, 3).map((x) => `${x.name ?? x.tid} ${fmt.pct(x.used_ratio)}${x.forecast_exhaust_at ? `（预计 ${fmt.date(x.forecast_exhaust_at).slice(5)}）` : ""}`).join(" · ") : null,
      action: ["查看", "ops/tenants?filter=attention"],
    },
    hide.has("usage")
      ? null
      : { label: "待对账", count: Number(t.pending_reconcile) || 0, sev: "warn", text: `${fmt.int(t.pending_reconcile)} 条请求待对账`, sub: `上游没给真实用量、按估算记：不计费、不扣额度${hide.has("billing") ? "" : `；估算 ${fmt.cny(t.est_value_cny)}`}`, action: ["看明细", "ops/usage?view=records"] },
    { label: "到期", count: tn.expiring_30d ?? null, sev: "warn", text: `${fmt.int(tn.expiring_30d)} 家律所 30 天内到期`, sub: "到期后不再签发席位令牌：请续订", action: ["查看", "ops/tenants?filter=expiring"] },
    hide.has("billing") ? null : { label: "价目", count: Number(t.unpriced_rows) || 0, sev: "neutral", text: `${fmt.int(t.unpriced_rows)} 条请求价目生效前未定价`, sub: "不改写；“按现行价估算”在用量与计费页（只读）", action: ["模型与价目", "ops/pricing"] },
    { label: "开通", count: tn.pending ?? null, sev: "neutral", text: `${fmt.int(tn.pending)} 家律所待开通`, sub: "已开通账号，创始开通（律所根登记）还没完成", action: ["查看", "ops/tenants?filter=pending"] },
    can("account.read") ? { label: "设备", count: dv.flagged ?? null, sev: "neutral", text: `${fmt.int(dv.flagged)} 台设备有异常标记`, sub: "久未报到、版本过旧或暂停后仍有请求", action: ["查看", "ops/devices"] } : null,
  ]);

  // ── ② 指标（金额一律两位小数） ──
  const kpis = h(
    "div",
    { class: "kpis" },
    hide.has("billing") ? null : stat("本期应收", fmt.cny(t.revenue_cny), "席位费 + 加量费"),
    hide.has("billing") ? null : stat("毛利", fmt.cny(t.margin_cny), marginRate === null ? "应收 − 模型成本" : `毛利率 ${fmt.pct(marginRate)}`, { tone: Number(t.margin_cny) < 0 ? "danger" : undefined, extra: marginRate === null ? null : marginBar(marginRate) }),
    hide.has("billing") ? null : stat("模型成本", fmt.cny(t.cost_cny), "成本价 × 实测用量"),
    hide.has("billing") ? null : stat("用量价值", fmt.cny(t.value_cny), "售价 × 实测用量"),
    hide.has("usage") ? null : stat("本期请求", fmt.int(t.requests), errRate === null ? "—" : `错误率 ${fmt.pct(errRate)}`, { tone: errRate !== null && errRate >= 0.05 ? "warn" : undefined, title: `错误 ${fmt.int(t.errors)} 次` }),
    hide.has("usage") ? null : stat("Token", fmt.tokens(tokens), `输入 ${fmt.tokens(t.tokens_in)} · 输出 ${fmt.tokens(t.tokens_out)}${cacheRate === null ? "" : ` · 命中 ${fmt.pct(cacheRate)}`}`, { title: `${fmt.int(tokens)} token` }),
  );

  // ── ③ 趋势 ──
  const daily = ov.daily ?? [];
  const labels = daily.map((d) => d.day);
  const metricDefs = {
    tokens: { series: [{ name: "输入", values: daily.map((d) => Number(d.tokens_in ?? 0) || 0), kind: "bar", stack: true }, { name: "输出", values: daily.map((d) => Number(d.tokens_out ?? 0) || 0), kind: "bar", stack: true, cls: "s2" }], format: (v) => fmt.tokens(v) },
    requests: { series: [{ name: "请求", values: daily.map((d) => Number(d.requests) || 0), kind: "bar" }, { name: "错误", values: daily.map((d) => Number(d.errors) || 0), kind: "line", cls: "s-danger" }], format: (v) => fmt.int(v) },
    money: { series: [{ name: "用量价值", values: daily.map((d) => (d.value_cny === null ? null : Number(d.value_cny) || 0)), kind: "bar" }, { name: "成本", values: daily.map((d) => (d.cost_cny === null ? null : Number(d.cost_cny) || 0)), kind: "line", cls: "s-warn" }], format: (v) => fmt.cny(v) },
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

  // ── ④ 上游健康、按模型、规模 ──
  const models = (ov.by_model ?? []).map((x) => ({ label: x.label ?? x.alias, value: Number(x.tokens) || 0, note: [fmt.pct(x.share), `${fmt.int(x.requests)} 次`, hide.has("billing") ? null : fmt.cny(x.value_cny)].filter(Boolean).join(" · "), title: x.alias }));
  const scaleItem = (label, total, rows) => h("div", { class: "scale-item" }, h("span", { class: "stat-label" }, label), h("span", { class: "stat-value num" }, fmt.int(total)), h("ul", {}, rows.map(([k, v]) => h("li", {}, h("span", {}, k), h("b", {}, fmt.int(v))))));

  clear(
    box,
    panel("需要关注", soon === null ? h("div", { class: "stack-sm" }, todo, errorBlock(tenants)) : todo),
    kpis.childElementCount ? kpis : null,
    h(
      "div",
      { class: "grid-2-1" },
      panel("用量趋势", trendBody, { sub: `近 ${st.days} 日 · 北京时间`, actions: metricSeg }),
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
    ),
    h(
      "div",
      { class: "grid-2" },
      panel("按模型", hide.has("usage") ? emptyBlock("需要“用量”查看权限") : hbars(models, { format: (v) => `${fmt.tokens(v)} token`, empty: "本期还没有模型用量" }), { sub: "本期 token" }),
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
