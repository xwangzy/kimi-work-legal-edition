/**
 * 套餐（第 62 批：原“套餐与额度”只留套餐目录；注册设置挪到“注册管理 · 注册策略”，告警成为一级页面）：
 * 套餐目录以卡片呈现（套餐通常只有几个：一眼看清席位单价、每席位额度、周期与限制），点卡片编辑。
 * 接口：GET/PUT /v1/ops/plans[/{id}]（契约 §8；Plan 字段见主文 §4.3）；按金额计费的售价随套餐保存时生成新价目版本（PUT /v1/ops/routing/prices）。
 */
import * as api from "../api.js";
import { can, needs, pageHead, PERM_LABEL } from "../domain.js";
import { badge, btn, clear, confirmAction, facts, field, fmt, h, icon, load, mono, note, openDrawer, readForm, toast } from "../ui.js";

// 与服务端 billing.ts 的 PLAN_ID_RE 同一条（原先这里写 2–32 位、字母开头，服务端是 1–24 位：25 位以上的编号界面放行、服务端 404）
const PLAN_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;

export function render(page) {
  const box = h("div", { class: "stack" });
  const addBtn = btn("新增套餐", () => openPlan(null, last, reload), { kind: "primary", icon: icon("plus"), disabled: !can("plan.manage"), title: needs("plan.manage") });
  page.append(pageHead("套餐", "额度单位只有 token 与金额两种；百分比 = 实际消耗 ÷ 我方配置的额度", addBtn), box);
  let last = { plans: [] };
  const reload = () => load(box, () => api.get("/v1/ops/plans"), (d) => ((last = d), drawPlans(box, d, reload)), "正在读取套餐…");
  reload();
}

const quotaText = (p) => (p.quota_unit === "cny" ? fmt.cny(p.seat_quota) : p.quota_unit === "tokens" ? `${fmt.tokens(p.seat_quota)} token` : "—");
const PERIOD = { month: "自然月", week: "自然周" };

function drawPlans(box, d, reload) {
  const plans = d.plans ?? [];
  const card = (p) =>
    h(
      "div",
      { class: "plan-card clickable", role: "button", tabindex: "0", onclick: () => openPlan(p, d, reload), onkeydown: (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), openPlan(p, d, reload)), "aria-label": `编辑套餐 ${p.label ?? p.id}` },
      h(
        "div",
        { class: "plan-card-head" },
        h("div", {}, h("b", {}, p.label ?? p.id), mono(p.id)),
        h("span", { class: "badges" }, p.id === d.default_plan ? badge("缺省", "accent", "开通律所时缺省选它") : null, badge(p.quota_unit === "cny" ? "按金额" : "按 token", "neutral")),
      ),
      h("div", { class: "plan-price" }, h("b", {}, p.seat_price_cny === null || p.seat_price_cny === undefined ? "未定价" : fmt.cny(p.seat_price_cny, 0)), h("span", {}, `/ 席 / ${PERIOD[p.period] === "自然周" ? "周" : "月"}`)),
      facts([
        ["每席位额度", h("span", { title: p.seat_quota_display ?? undefined }, `${quotaText(p)} / ${PERIOD[p.period] ?? p.period ?? "期"}`)],
        ["5 小时窗口", p.burst ? `任意 ${p.burst.hours} 小时 ≤ ${p.burst.pct}%` : "不限"],
        ["设备 / 账号", `${fmt.int(p.device_limit ?? 2)} 台`],
        ["告警阈值", (p.alert_thresholds ?? [80, 100]).map((x) => `${x}%`).join(" / ")],
        ["加量系数", fmt.num(p.boost_price_factor)],
        ["个人限额", p.enforce_seat_quota ? "按席位额度限制" : "只作参考"],
      ]),
      h("div", { class: "plan-card-foot" }, p.models?.length ? p.models.map((m) => badge(m, "neutral")) : h("span", { class: "muted small" }, "可用全部模型"), p.origin === "migrated" ? badge("由旧版计量额度换算，待商务确认", "warn") : null),
      p.note ? h("p", { class: "muted small" }, p.note) : null,
    );
  clear(
    box,
    plans.length
      ? h("div", { class: "plan-grid" }, plans.map(card), can("plan.manage") ? h("button", { type: "button", class: "plan-card plan-new", onclick: () => openPlan(null, d, reload) }, icon("plus"), "新增套餐") : null)
      : h("div", { class: "state state-empty" }, h("b", {}, "套餐目录为空")),
    note("改套餐即刻影响在用这个套餐的律所（本期总额度按新的每席位额度重算）。旧套餐由“单位”折算为 token 额度的，请商务确认后再改；模型的成本价与销售价在“模型与价目”。"),
  );
}

// 售价三项（元 / 百万 token）：按金额计费的套餐就按这三项算；成本单价仍在“模型与路由 → 价目表”
const SALE_COLS = [
  ["input", "输入（未命中缓存）"],
  ["cached_input", "输入（缓存命中）"],
  ["output", "输出"],
];

/** 先取模型与价目（看得到路由的角色才有），再开抽屉；取不到也能改套餐的其他项。 */
async function openPlan(p, d, reload) {
  let routing = null;
  if (can("route.read")) {
    try {
      routing = await api.get("/v1/ops/routing");
    } catch {
      routing = null;
    }
  }
  editPlan(p, d, reload, routing);
}

/**
 * “按金额计费的单价”一节：每个启用的模型别名一行，三项售价。有 price.manage 的可以就地改（保存套餐时先生成新价目版本）。
 * 返回 { el, show(单位), read(可用模型) → { error } | { items, changes } }。
 */
function saleBox(routing) {
  const enabled = (routing?.models ?? []).filter((m) => m.enabled !== false);
  const cur = routing?.prices?.items ?? {};
  const editable = can("price.manage") && !!routing;
  const inputs = {};
  const body = !routing
    ? h("p", { class: "muted small" }, "你的角色看不到模型与价目：按金额计费的套餐须由系统管理员或客户运营配置。")
    : !enabled.length
      ? h("p", { class: "muted small" }, "还没有启用的模型别名：先到“模型与路由”配好上游与别名。")
      : h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            { class: "tbl price-edit" },
            h("thead", {}, h("tr", {}, h("th", {}, "模型"), SALE_COLS.map(([, l]) => h("th", { class: "num" }, l)))),
            h(
              "tbody",
              {},
              enabled.map((m) =>
                h(
                  "tr",
                  {},
                  h("td", {}, h("div", { class: "cell-2" }, mono(m.alias), m.label ? h("small", {}, m.label) : null)),
                  SALE_COLS.map(([k, l]) => {
                    const i = h("input", { type: "number", min: 0, step: "0.0001", inputmode: "decimal", class: "num-input", value: cur[m.alias]?.[k] ?? "", placeholder: k === "cached_input" ? "同未命中价" : "必填", disabled: !editable, "aria-label": `${m.alias} ${l}` });
                    (inputs[m.alias] ??= {})[k] = i;
                    return h("td", { class: "num" }, i);
                  }),
                ),
              ),
            ),
          ),
        );
  const el = h(
    "fieldset",
    { class: ["field", "plan-prices"], hidden: true },
    h("legend", {}, "按金额计费的单价（元 / 百万 token）"),
    h("p", { class: "muted small" }, "金额额度 = 单价 × 实际用量，三项分开算。输入里命中缓存的部分按“缓存命中”价；不填缓存命中价就按未命中价算。", editable ? "改了单价会在保存套餐时生成新的价目版本，对所有按金额计费的律所生效。" : routing ? `你的角色没有“${PERM_LABEL["price.manage"] ?? "改价目"}”权限：只能看，不能改。` : ""),
    body,
  );
  return {
    el,
    show: (unit) => (el.hidden = unit !== "cny"),
    read(models) {
      if (!routing) return { error: "你的角色看不到价目，不能保存按金额计费的套餐" };
      const need = enabled.map((m) => m.alias).filter((a) => !models.length || models.includes(a));
      if (!need.length) return { error: "这个套餐没有可用的模型：检查“可用模型别名”" };
      const items = Object.fromEntries(Object.entries(cur).map(([a, v]) => [a, { ...v }]));
      const changes = [];
      for (const m of enabled) {
        const row = (items[m.alias] ??= { input: null, cached_input: null, output: null, cost_input: null, cost_cached_input: null, cost_output: null });
        for (const [k, l] of SALE_COLS) {
          const raw = inputs[m.alias][k].value.trim();
          const v = raw === "" ? null : Number(raw);
          if (v !== null && !(Number.isFinite(v) && v >= 0 && v <= 100000)) return { error: `${m.alias} 的“${l}”须为 0–100000 的数字` };
          const old = cur[m.alias]?.[k] ?? null;
          if (old !== v) changes.push(`${m.alias} ${l}：${fmt.price(old)} → ${fmt.price(v)}`);
          row[k] = v;
        }
      }
      const miss = need.filter((a) => items[a]?.input === null || items[a]?.input === undefined || items[a]?.output === null || items[a]?.output === undefined);
      if (miss.length) return { error: `按金额计费须先定价：${miss.join("、")} 还缺“输入（未命中缓存）”或“输出”单价` };
      if (changes.length && !editable) return { error: "你的角色不能改价目" };
      return { items, changes };
    },
  };
}

function editPlan(p, d, reload, routing) {
  const isNew = !p;
  const specs = [
    { name: "id", label: "套餐编号", value: p?.id ?? "", required: true, disabled: !isNew, placeholder: "pro-2027", hint: "小写字母、数字、连字符，1–24 位，不以连字符开头；建好后不可改" },
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
  const sale = saleBox(routing);
  // 没有权限时把原因写在按钮旁（原先只有悬停提示，看上去就是一个点不动的按钮）
  const why = needs("plan.manage");
  const form = h(
    "form",
    { class: "drawer-form", novalidate: true },
    specs.map((f) => [field(f), f.name === "seat_quota" ? sale.el : null]),
    err,
    h("div", { class: "drawer-foot" }, why ? h("span", { class: "muted small" }, `${why}，不能保存`) : null, h("span", { class: "spacer" }), h("button", { type: "button", class: "btn", onclick: () => dr.close() }, "取消"), h("button", { type: "submit", class: "btn primary", disabled: !can("plan.manage"), title: why }, isNew ? "新增套餐" : "保存套餐…")),
  );
  const dr = openDrawer({ title: isNew ? "新增套餐" : `套餐 ${p.label ?? p.id}`, subtitle: isNew ? null : mono(p.id), body: form, wide: true });
  const unitNow = () => form.querySelector('input[name="quota_unit"]:checked')?.value ?? "tokens";
  sale.show(unitNow());
  form.addEventListener("change", (ev) => ev.target?.name === "quota_unit" && sale.show(unitNow()));
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    err.textContent = "";
    const v = readForm(form, specs);
    const id = isNew ? v.id : p.id;
    if (!PLAN_RE.test(id)) return void (err.textContent = "套餐编号须为 1–24 位小写字母、数字或连字符，不以连字符开头");
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
    // 按金额计费：三项单价必须齐；改了的先生成新价目版本，再存套餐（服务端同样校验，缺价 409 plan_models_unpriced）
    let priced = null;
    if (body.quota_unit === "cny") {
      if (!(v.seat_quota > 0)) return void (err.textContent = "按金额计费的每席位额度须为正数（元）");
      priced = sale.read(models);
      if (priced.error) return void (err.textContent = priced.error);
    }
    const unitChange = !isNew && p.quota_unit !== body.quota_unit;
    const ok = await confirmAction({
      title: isNew ? `新增套餐 ${id}` : `保存套餐 ${id}`,
      danger: !isNew,
      consequences: isNew
        ? ["新套餐进目录，开通或改套餐时可选；不影响现有律所。", priced?.changes.length ? "单价有改动：先生成新的价目版本（约 15 秒后网关按新价计量），对所有按金额计费的律所生效。" : null].filter(Boolean)
        : [
            "在用这个套餐的律所，本期总额度即刻按新的每席位额度重算（已用量不变，百分比随之变化）；",
            priced?.changes.length ? "单价有改动：先生成新的价目版本（约 15 秒后网关按新价计量），对所有按金额计费的律所生效；之前的请求仍按原版本记账；" : null,
            unitChange ? "额度单位改了：这些律所的本期百分比按新单位重算，客户端显示随之变化；" : null,
            body.seat_price_cny !== p.seat_price_cny ? `席位单价 ${fmt.cny(p.seat_price_cny)} → ${fmt.cny(body.seat_price_cny)}：从本期账单起按新价；` : null,
            body.burst?.pct !== p.burst?.pct ? "5 小时窗口变化即刻生效。" : null,
          ].filter(Boolean),
      lead: priced?.changes.length ? h("ul", { class: "diff-list" }, priced.changes.slice(0, 12).map((c) => h("li", {}, c)), priced.changes.length > 12 ? h("li", {}, `……共 ${priced.changes.length} 项`) : null) : undefined,
      typeToConfirm: !isNew && unitChange ? id : undefined,
      confirmLabel: isNew ? "新增" : "保存",
      run: async () => {
        if (priced?.changes.length) await api.put("/v1/ops/routing/prices", { items: priced.items });
        return api.put(`/v1/ops/plans/${api.seg(id)}`, body);
      },
    });
    if (ok) {
      toast("已保存套餐");
      dr.close();
      reload();
    }
  });
}
