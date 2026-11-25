/**
 * 套餐（第 62 批：原“套餐与额度”只留套餐目录；注册设置挪到“注册管理 · 注册策略”，告警成为一级页面）：
 * 套餐目录以卡片呈现（套餐通常只有几个：一眼看清席位单价、每席位额度、周期与限制），点卡片编辑。
 * 接口：GET/PUT /v1/ops/plans[/{id}]（契约 §8；Plan 字段见主文 §4.3）。
 * 第 62 批（contract-b62-pricing §2.3、§5.1）：额度缺省按金额（元 / 席位 / 月）；售价按上游型号在“模型与价目”里定，套餐这里只核对、不改价
 * （旧的按别名改价接口 PUT /v1/ops/routing/prices 在按型号的版本里一律 409）。“按 token”选项保留给运营显式选择，不作缺省。
 */
import * as api from "../api.js";
import { can, needs, pageHead } from "../domain.js";
import { badge, btn, clear, confirmAction, facts, field, fmt, h, icon, load, mono, note, openDrawer, readForm, toast } from "../ui.js";

// 与服务端 billing.ts 的 PLAN_ID_RE 同一条（原先这里写 2–32 位、字母开头，服务端是 1–24 位：25 位以上的编号界面放行、服务端 404）
const PLAN_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;

export function render(page) {
  const box = h("div", { class: "stack" });
  const addBtn = btn("新增套餐", () => openPlan(null, last, reload), { kind: "primary", icon: icon("plus"), disabled: !can("plan.manage"), title: needs("plan.manage") });
  page.append(pageHead("套餐", "额度按金额（元 / 席位 / 月）；百分比 = 按售价折算的已用金额 ÷ 额度", addBtn), box);
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
        h("span", { class: "badges" }, p.id === d.default_plan ? badge("缺省", "accent", "开通律所时缺省选它") : null, p.quota_unit === "cny" ? null : badge("旧口径：按 token", "warn", "第 62 批起额度按金额计；这个套餐仍按 token")),
      ),
      h("div", { class: "plan-price" }, h("b", {}, p.seat_price_cny === null || p.seat_price_cny === undefined ? "未定价" : fmt.cny(p.seat_price_cny)), h("span", {}, `/ 席 / ${PERIOD[p.period] === "自然周" ? "周" : "月"}`)),
      facts([
        ["每席位额度", h("span", { title: p.seat_quota_display ?? undefined }, `${quotaText(p)} / ${PERIOD[p.period] ?? p.period ?? "期"}`)],
        ["5 小时窗口", p.burst ? `任意 ${p.burst.hours} 小时 ≤ ${p.burst.pct}%` : "不限"],
        // 第 66 批（V40，D-292）：个人账号（自助注册的单人工作室）不按套餐台数挡，换电脑直接登录；这一项只对多人律所生效
        ["设备 / 账号（仅多人律所）", `${fmt.int(p.device_limit ?? 2)} 台`],
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
    note("改套餐即刻影响在用这个套餐的律所（本期总额度按新的每席位额度重算）。售价与成本按上游型号在“模型与价目”里定。"),
  );
}

/** 先取价目（按上游型号，route.read 才有），再开抽屉；取不到也能改套餐的其他项。 */
async function openPlan(p, d, reload) {
  let pricing = null;
  if (can("route.read")) {
    try {
      pricing = await api.pricing.get();
    } catch {
      pricing = null;
    }
  }
  editPlan(p, d, reload, pricing);
}

/**
 * “按金额计费”一节（第 62 批，契约 contract-b62-pricing §2.3）：售价按上游型号在“模型与价目”里定，套餐这里**不再改价**；
 * 只列出可用别名 → 首选型号 → 售价，缺价的标出来（控制面同样校验：别名的每个目标型号都要有售价，否则 409 plan_models_unpriced）。
 * 返回 { el, show(单位), check(可用别名) → 错误文字 | null }。
 */
function saleBox(pricing) {
  const aliases = (pricing?.aliases ?? []).filter((a) => a.enabled !== false);
  const modelOf = Object.fromEntries((pricing?.models ?? []).map((m) => [m.model, m]));
  const unpricedTargets = (a) => (a.targets ?? []).filter((t) => !modelOf[t]?.priced);
  const body = !pricing
    ? h("p", { class: "muted small" }, "你的角色看不到价目：按金额计费的套餐须由系统管理员或客户运营配置。")
    : !aliases.length
      ? h("p", { class: "muted small" }, "还没有启用的模型别名：先到“模型与路由”配好上游与别名。")
      : h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            { class: "tbl" },
            h("thead", {}, h("tr", {}, h("th", {}, "别名"), h("th", {}, "首选型号"), h("th", { class: "num" }, "售价 · 输入"), h("th", { class: "num" }, "售价 · 输出"), h("th", {}, "状态"))),
            h(
              "tbody",
              {},
              aliases.map((a) => {
                const miss = unpricedTargets(a);
                return h(
                  "tr",
                  {},
                  h("td", {}, mono(a.alias)),
                  h("td", {}, mono(a.primary_model ?? "—")),
                  h("td", { class: "num" }, fmt.price(a.effective?.sale?.input ?? null)),
                  h("td", { class: "num" }, fmt.price(a.effective?.sale?.output ?? null)),
                  h("td", {}, miss.length ? badge(`${miss.join("、")} 未定价`, "warn") : badge("已定价", "ok")),
                );
              }),
            ),
          ),
        );
  const el = h(
    "fieldset",
    { class: ["field", "plan-prices"], hidden: true },
    h("legend", {}, "按金额计费的售价（元 / 百万 token）"),
    note("额度按售价折算扣减（缓存命中按命中价）。售价按上游型号在“模型与价目”里定，这里只核对：可用别名的每个目标型号都要有售价。"),
    body,
  );
  return {
    el,
    show: (unit) => (el.hidden = unit !== "cny"),
    check(models) {
      if (!pricing) return "你的角色看不到价目，不能保存按金额计费的套餐";
      const need = aliases.filter((a) => !models.length || models.includes(a.alias));
      if (!need.length) return "这个套餐没有可用的模型：检查“可用模型别名”";
      const miss = need.filter((a) => unpricedTargets(a).length).map((a) => `${a.alias}（${unpricedTargets(a).join("、")}）`);
      return miss.length ? `按金额计费须先定价：${miss.join("；")} 还没有售价，请先到“模型与价目”定价` : null;
    },
  };
}

function editPlan(p, d, reload, pricing) {
  const isNew = !p;
  const specs = [
    { name: "id", label: "套餐编号", value: p?.id ?? "", required: true, disabled: !isNew, placeholder: "pro-2027", hint: "小写字母、数字、连字符，1–24 位，不以连字符开头；建好后不可改" },
    { name: "label", label: "显示名", value: p?.label ?? "", required: true, maxlength: 20 },
    { name: "note", label: "说明（可空，至多 60 字）", type: "textarea", value: p?.note ?? "", maxlength: 60 },
    { name: "quota_unit", label: "额度单位", type: "radio", options: [["cny", "金额（元，缺省）", "按售价折算扣减：未命中输入、缓存命中、缓存写入、输出分档计"], ["tokens", "token（旧口径）", "上游 usage 原样：输入 + 输出；不建议新套餐使用"]], value: p?.quota_unit ?? "cny" },
    { name: "seat_quota", label: "每席位每期额度", suffix: "元 / 席位 / 期（token 口径时为 token）", type: "number", min: 0, step: "any", value: p?.seat_quota ?? "", required: true, hint: "金额额度写元，例如 210；选了 token 口径时写整数 token" },
    { name: "period", label: "周期", type: "select", options: [["month", "自然月（北京时间）"], ["week", "自然周（北京时间）"]], value: p?.period ?? "month" },
    { name: "burst_pct", label: "5 小时窗口上限（% ，空 = 不限）", type: "number", min: 1, max: 100, value: p?.burst?.pct ?? "", hint: "任意 5 小时内至多用本期总额度的这个比例（按小时桶算）" },
    { name: "seat_price_cny", label: "席位单价（元 / 席 / 期，空 = 未定价）", type: "number", min: 0, step: "any", value: p?.seat_price_cny ?? "" },
    { name: "boost_price_factor", label: "加量价格系数", type: "number", min: 0, step: "any", value: p?.boost_price_factor ?? 1 },
    { name: "device_limit", label: "每账号设备数（仅多人律所）", type: "number", min: 1, max: 9, value: p?.device_limit ?? 2, hint: "个人账号不受此限：换电脑直接登录，只有防滥用硬上限（同时 20 台，超出自动移除最久未用的一台）" },
    { name: "alert_thresholds", label: "告警阈值（%，逗号分隔）", value: (p?.alert_thresholds ?? [80, 100]).join(", ") },
    { name: "enforce_seat_quota", label: "按每席位额度限制个人", type: "checkbox", value: !!p?.enforce_seat_quota, hint: "关：个人只显示“占每席位额度的比例（参考，不限）”" },
    { name: "models", label: "可用模型别名（逗号分隔，空 = 全部）", value: (p?.models ?? []).join(", ") },
  ];
  const err = h("p", { class: "form-error", role: "alert" });
  const sale = saleBox(pricing);
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
  const unitNow = () => form.querySelector('input[name="quota_unit"]:checked')?.value ?? "cny";
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
    // 按金额计费：可用别名的每个目标型号都要有售价（服务端同样校验，缺价 409 plan_models_unpriced）；售价不在这里改
    if (body.quota_unit === "cny") {
      if (!(v.seat_quota > 0)) return void (err.textContent = "按金额计费的每席位额度须为正数（元）");
      const bad = sale.check(models);
      if (bad) return void (err.textContent = bad);
    }
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
      run: async () => {
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
