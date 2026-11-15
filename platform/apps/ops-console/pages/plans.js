/**
 * 套餐与额度：套餐目录（单位、每席位额度、周期、5 小时窗口、阈值、设备数），注册设置（open / code / closed、试用套餐与天数），告警列表。
 * 接口：GET/PUT /v1/ops/plans[/{id}]、GET/PUT /v1/ops/settings、GET /v1/ops/alerts、POST /v1/ops/alerts/{id}/ack（契约 §8；Plan 字段见主文 §4.3）。
 */
import * as api from "../api.js";
import { alertList, ALERT_KIND, can, needs, pageHead } from "../domain.js";
import { badge, btn, clear, confirmAction, dataTable, facts, field, fmt, h, icon, load, mono, openDrawer, panel, readForm, segmented, tabBar, toast } from "../ui.js";

const st = { tab: "plans", alerts: "open", aKind: "", table: { sort: "id", asc: true } };
const PLAN_RE = /^[a-z][a-z0-9-]{1,31}$/;

export function render(page, r) {
  if (r.params.tab) st.tab = r.params.tab;
  const tabs = h("div");
  const box = h("div", { class: "stack" });
  page.append(pageHead("套餐与额度", "额度单位只有 token 与金额两种；百分比 = 实际消耗 ÷ 我方配置的额度"), tabs, box);
  const draw = () => {
    clear(tabs, tabBar([{ id: "plans", label: "套餐目录" }, { id: "settings", label: "注册设置" }, { id: "alerts", label: "告警" }], st.tab, (id) => ((st.tab = id), draw())));
    if (st.tab === "plans") panePlans(box);
    else if (st.tab === "settings") paneSettings(box);
    else paneAlerts(box);
  };
  draw();
}

const quotaText = (p) => (p.quota_unit === "cny" ? fmt.cny(p.seat_quota) : p.quota_unit === "tokens" ? `${fmt.tokens(p.seat_quota)} token` : "—");

function panePlans(box) {
  const reload = () =>
    load(box, () => api.get("/v1/ops/plans"), (d) => {
      const plans = d.plans ?? [];
      box.append(
        h("div", { class: "toolbar" }, h("p", { class: "muted small" }, "改套餐即刻影响在用这个套餐的律所（本期总额度按新的每席位额度重算）。旧套餐由“单位”折算为 token 额度的，请商务确认后再改。"), btn("新增套餐", () => editPlan(null, d, reload), { kind: "primary", icon: icon("plus"), disabled: !can("plan.manage"), title: needs("plan.manage") })),
        dataTable({
          state: st.table,
          rows: plans,
          onRow: (p) => editPlan(p, d, reload),
          empty: "套餐目录为空",
          columns: [
            { key: "id", label: "套餐", render: (p) => h("div", { class: "cell-2" }, h("b", {}, p.label ?? p.id, p.id === d.default_plan ? badge("缺省", "accent") : null), mono(p.id), p.origin === "migrated" ? badge("由旧版计量额度换算，待商务确认", "warn") : null) },
            { key: "quota_unit", label: "单位", value: (p) => fmt.unit(p.quota_unit) },
            { key: "seat_quota", label: "每席位每期", num: true, value: (p) => Number(p.seat_quota) || 0, render: (p) => h("span", { title: p.seat_quota_display ?? undefined }, quotaText(p)) },
            { key: "period", label: "周期", value: (p) => ({ month: "自然月", week: "自然周" })[p.period] ?? p.period ?? "—" },
            { key: "burst", label: "5 小时窗口", value: (p) => p.burst?.pct ?? null, render: (p) => (p.burst ? `任意 ${p.burst.hours} 小时 ≤ ${p.burst.pct}%` : h("span", { class: "muted" }, "不限")) },
            { key: "seat_price_cny", label: "席位单价", num: true, value: (p) => p.seat_price_cny ?? null, render: (p) => fmt.cny(p.seat_price_cny) },
            { key: "boost_price_factor", label: "加量系数", num: true, class: "opt", render: (p) => fmt.num(p.boost_price_factor) },
            { key: "device_limit", label: "设备 / 账号", num: true, render: (p) => fmt.int(p.device_limit ?? 2) },
            { key: "alert_thresholds", label: "告警阈值", sortable: false, class: "opt", render: (p) => (p.alert_thresholds ?? [80, 100]).map((x) => `${x}%`).join(" / ") },
            { key: "enforce_seat_quota", label: "个人限额", value: (p) => (p.enforce_seat_quota ? 1 : 0), render: (p) => (p.enforce_seat_quota ? badge("按席位限", "warn") : h("span", { class: "muted" }, "只作参考")) },
            { key: "models", label: "可用模型", sortable: false, class: "opt", render: (p) => (p.models?.length ? h("span", { class: "badges" }, p.models.map((m) => mono(m))) : h("span", { class: "muted" }, "全部")) },
          ],
        }),
        plans.some((p) => p.note) ? panel("说明", h("ul", { class: "plain" }, plans.filter((p) => p.note).map((p) => h("li", {}, h("b", {}, `${p.label ?? p.id}：`), p.note)))) : null,
      );
    }, "正在读取套餐…");
  reload();
}

function editPlan(p, d, reload) {
  const isNew = !p;
  const specs = [
    { name: "id", label: "套餐编号", value: p?.id ?? "", required: true, disabled: !isNew, placeholder: "pro-2027", hint: "小写字母开头，字母、数字、连字符，2–32 位；建好后不可改" },
    { name: "label", label: "显示名", value: p?.label ?? "", required: true, maxlength: 20 },
    { name: "note", label: "说明（可空，至多 60 字）", type: "textarea", value: p?.note ?? "", maxlength: 60 },
    { name: "quota_unit", label: "额度单位", type: "radio", options: [["tokens", "token", "上游 usage 原样：输入 + 输出"], ["cny", "金额（元）", "价目售价 × 实际用量，区分未缓存输入、缓存输入、输出"]], value: p?.quota_unit ?? "tokens" },
    { name: "seat_quota", label: "每席位每期额度", type: "number", min: 0, step: "any", value: p?.seat_quota ?? "", required: true, hint: "token 为整数；金额为元" },
    { name: "period", label: "周期", type: "select", options: [["month", "自然月（北京时间）"], ["week", "自然周（北京时间）"]], value: p?.period ?? "month" },
    { name: "burst_pct", label: "5 小时窗口上限（% ，空 = 不限）", type: "number", min: 1, max: 100, value: p?.burst?.pct ?? "", hint: "任意 5 小时内至多用本期总额度的这个比例（按小时桶算）" },
    { name: "seat_price_cny", label: "席位单价（元 / 席 / 期，空 = 未定价）", type: "number", min: 0, step: "any", value: p?.seat_price_cny ?? "" },
    { name: "boost_price_factor", label: "加量价格系数", type: "number", min: 0, step: "any", value: p?.boost_price_factor ?? 1 },
    { name: "device_limit", label: "每账号设备数", type: "number", min: 1, max: 9, value: p?.device_limit ?? 2 },
    { name: "alert_thresholds", label: "告警阈值（%，逗号分隔）", value: (p?.alert_thresholds ?? [80, 100]).join(", ") },
    { name: "enforce_seat_quota", label: "按每席位额度限制个人", type: "checkbox", value: !!p?.enforce_seat_quota, hint: "关：个人只显示“占每席位额度的比例（参考，不限）”" },
    { name: "models", label: "可用模型别名（逗号分隔，空 = 全部）", value: (p?.models ?? []).join(", ") },
  ];
  const err = h("p", { class: "form-error", role: "alert" });
  const form = h("form", { class: "drawer-form", novalidate: true }, specs.map(field), err, h("div", { class: "drawer-foot" }, h("span", { class: "spacer" }), h("button", { type: "button", class: "btn", onclick: () => dr.close() }, "取消"), h("button", { type: "submit", class: "btn primary", disabled: !can("plan.manage"), title: needs("plan.manage") }, isNew ? "新增套餐" : "保存套餐…")));
  const dr = openDrawer({ title: isNew ? "新增套餐" : `套餐 ${p.label ?? p.id}`, subtitle: isNew ? null : mono(p.id), body: form });
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    err.textContent = "";
    const v = readForm(form, specs);
    const id = isNew ? v.id : p.id;
    if (!PLAN_RE.test(id)) return void (err.textContent = "套餐编号须为小写字母开头的 2–32 位字母、数字或连字符");
    if (!(v.seat_quota >= 0)) return void (err.textContent = "每席位额度须为非负数");
    if (v.quota_unit === "tokens" && !Number.isInteger(v.seat_quota)) return void (err.textContent = "token 额度须为整数");
    const th = v.alert_thresholds.split(/[,，\s]+/).filter(Boolean).map(Number);
    if (th.some((x) => !(Number.isInteger(x) && x >= 1 && x <= 100))) return void (err.textContent = "告警阈值须为 1–100 的整数");
    const models = v.models.split(/[,，\s]+/).filter(Boolean);
    const body = {
      id,
      label: v.label,
      ...(v.note ? { note: v.note } : {}),
      quota_unit: v.quota_unit,
      seat_quota: v.seat_quota,
      period: v.period,
      burst: v.burst_pct ? { hours: 5, pct: v.burst_pct } : null,
      seat_price_cny: v.seat_price_cny,
      boost_price_factor: v.boost_price_factor ?? 1,
      device_limit: v.device_limit ?? 2,
      alert_thresholds: [...new Set(th)].sort((a, b) => a - b),
      enforce_seat_quota: v.enforce_seat_quota,
      models: models.length ? models : null,
    };
    const unitChange = !isNew && p.quota_unit !== body.quota_unit;
    const ok = await confirmAction({
      title: isNew ? `新增套餐 ${id}` : `保存套餐 ${id}`,
      danger: !isNew,
      consequences: isNew
        ? ["新套餐进目录，开通或改套餐时可选；不影响现有律所。"]
        : [
            "在用这个套餐的律所，本期总额度即刻按新的每席位额度重算（已用量不变，百分比随之变化）；",
            unitChange ? "额度单位改了：这些律所的本期百分比按新单位重算，客户端显示随之变化；" : null,
            body.seat_price_cny !== p.seat_price_cny ? `席位单价 ${fmt.cny(p.seat_price_cny)} → ${fmt.cny(body.seat_price_cny)}：从本期账单起按新价；` : null,
            body.burst?.pct !== p.burst?.pct ? "5 小时窗口变化即刻生效。" : null,
          ].filter(Boolean),
      typeToConfirm: !isNew && unitChange ? id : undefined,
      confirmLabel: isNew ? "新增" : "保存",
      run: () => api.put(`/v1/ops/plans/${api.seg(id)}`, body),
    });
    if (ok) {
      toast("已保存套餐");
      dr.close();
      reload();
    }
  });
}

function paneSettings(box) {
  const reload = () =>
    load(box, async () => {
      const [s, p] = await Promise.allSettled([api.get("/v1/ops/settings"), api.get("/v1/ops/plans")]);
      if (s.status === "rejected") throw s.reason;
      return { s: s.value, plans: p.status === "fulfilled" ? p.value.plans ?? [] : [] };
    }, ({ s, plans }) => {
      const specs = [
        {
          name: "registration",
          label: "注册方式",
          type: "radio",
          value: s.registration,
          options: [
            ["open", "开放自助注册", "不带码注册 = 新建个人律所（试用套餐）；带开通码 / 邀请码照常"],
            ["code", "只凭码注册", "须有运营发的开通码或律所管理员发的邀请码"],
            ["closed", "关闭注册", "只能运营代建账号"],
          ],
        },
        plans.length ? { name: "trial_plan", label: "试用套餐", type: "select", options: plans.map((p) => [p.id, p.label ?? p.id]), value: s.trial_plan } : { name: "trial_plan", label: "试用套餐编号", value: s.trial_plan ?? "" },
        { name: "trial_days", label: "试用天数", type: "number", min: 1, max: 365, value: s.trial_days },
        { name: "trial_seats", label: "试用席位", type: "number", min: 1, max: 50, value: s.trial_seats },
        { name: "default_device_limit", label: "缺省每账号设备数", type: "number", min: 1, max: 9, value: s.default_device_limit },
      ];
      const err = h("p", { class: "form-error", role: "alert" });
      const form = h("form", { class: "settings-form", novalidate: true }, specs.map(field), err, h("div", { class: "btn-row" }, h("button", { type: "submit", class: "btn primary", disabled: !can("plan.manage"), title: needs("plan.manage") }, "保存设置…")));
      form.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const v = readForm(form, specs);
        const changes = Object.keys(v).filter((k) => String(v[k] ?? "") !== String(s[k] ?? ""));
        if (!changes.length) return void (err.textContent = "没有改动");
        const ok = await confirmAction({
          title: "保存注册设置",
          danger: v.registration === "open" && s.registration !== "open",
          consequences: [
            v.registration !== s.registration ? { open: "任何人都能自助注册并开一个试用律所；", code: "只有持开通码或邀请码的人能注册；", closed: "客户端注册入口关闭，只能运营代建账号；" }[v.registration] : null,
            "已注册的账号与律所不受影响；试用参数只影响之后的自助注册。",
          ].filter(Boolean),
          confirmLabel: "保存",
          run: () => api.put("/v1/ops/settings", Object.fromEntries(changes.map((k) => [k, v[k]]))),
        });
        if (ok) (toast("已保存设置"), reload());
      });
      box.append(
        h("div", { class: "grid-2-1" }, panel("注册", form), panel("邮件通道", facts([["状态", s.mail?.configured ? badge("已配置", "ok") : badge("未配置", "warn")], ["发件地址", s.mail?.from ?? "—"]]), { sub: s.mail?.configured ? "忘记密码会真发 6 位验证码" : "忘记密码不会真发码：只能运营在“账号”里发一次性重置码" })),
      );
    }, "正在读取设置…");
  reload();
}

function paneAlerts(box) {
  const tools = h("div", { class: "toolbar" });
  const list = h("div");
  box.replaceChildren(tools, list);
  const drawTools = () =>
    clear(
      tools,
      segmented([{ id: "open", label: "未确认" }, { id: "all", label: "全部（最近 500 条）" }], st.alerts, (v) => ((st.alerts = v), drawTools(), reload()), "范围"),
      segmented([{ id: "", label: "全部类型" }, ...Object.entries(ALERT_KIND).map(([id, label]) => ({ id, label }))], st.aKind, (v) => ((st.aKind = v), drawTools(), reload()), "类型"),
    );
  const reload = () => load(list, () => api.get("/v1/ops/alerts", { status: st.alerts, limit: 100 }), (d) => list.append(alertList((d.alerts ?? []).filter((a) => !st.aKind || a.kind === st.aKind), { onAck: reload })), "正在读取告警…");
  drawTools();
  reload();
}
