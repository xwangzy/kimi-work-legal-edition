/**
 * 注册管理（第 62 批新的一级菜单，平台运营 · 客户组）：注册策略 / 邀请码 / 短信服务。
 *
 * - 注册策略：现有的注册设置（注册方式 open / code / closed、试用套餐与天数与席位、缺省设备数、客户端最低版本、邮件通道状态）
 *   照旧读写 GET/PUT /v1/ops/settings（原“套餐与额度 → 注册设置”整块搬来，能力不变）；
 *   第 62 批新增的注册策略项走 api.registration.policy()（后端另一位同事在做），契约到之前显示“接口未就绪”。
 * - 邀请码、短信服务：只经 api.registration.*；契约（platform/docs/contract-b62-registration.md）到之前显示“接口未就绪”，
 *   页面骨架与操作先排好，**不造任何数据**。字段名待契约核对后改（见各处“契约待定”）。
 */
import * as api from "../api.js";
import { can, needs, pageHead } from "../domain.js";
import { badge, btn, clear, confirmAction, dataTable, errorBlock, facts, field, fmt, h, icon, load, loadingBlock, mono, note, panel, readForm, searchInput, segmented, settingRow, showSecret, toast } from "../ui.js";

export const SUBPAGES = [
  ["policy", "注册策略"],
  ["invites", "邀请码"],
  ["sms", "短信服务"],
];

export function render(page, r) {
  const sub = SUBPAGES.some(([id]) => id === r.arg) ? r.arg : "policy";
  if (sub === "invites") return renderInvites(page, r);
  if (sub === "sms") return renderSms(page);
  return renderPolicy(page);
}

// ─── 注册策略 ───────────────────────────────────────────────────────
const REG = [
  ["open", "开放自助注册", "不带码注册 = 新建个人律所（试用套餐）；带开通码 / 邀请码照常", "warn"],
  ["code", "只凭码注册", "须有运营发的开通码或律所管理员发的邀请码", "ok"],
  ["closed", "关闭注册", "只能运营代建账号", "neutral"],
];

function renderPolicy(page) {
  const box = h("div", { class: "stack-lg" });
  page.append(pageHead("注册策略", "谁能注册、试用给多少、客户端最低版本"), box);
  const reload = () =>
    load(
      box,
      async () => {
        const [s, p, np] = await Promise.allSettled([api.get("/v1/ops/settings"), api.get("/v1/ops/plans"), api.registration.policy()]);
        if (s.status === "rejected") throw s.reason;
        return { s: s.value, plans: p.status === "fulfilled" ? p.value.plans ?? [] : [], next: np };
      },
      ({ s, plans, next }) => drawPolicy(box, s, plans, next, reload),
      "正在读取注册设置…",
    );
  reload();
}

function drawPolicy(box, s, plans, next, reload) {
  const cur = { ...s, min_version: s.clients?.min_version ?? s.min_client_version ?? "" };
  const specs = [
    { name: "registration", type: "radio" },
    plans.length ? { name: "trial_plan", label: "试用套餐", type: "select", options: plans.map((p) => [p.id, p.label ?? p.id]), value: s.trial_plan } : { name: "trial_plan", label: "试用套餐编号", value: s.trial_plan ?? "" },
    { name: "trial_days", label: "试用天数", type: "number", min: 1, max: 365, value: s.trial_days },
    { name: "trial_seats", label: "试用席位", type: "number", min: 1, max: 50, value: s.trial_seats },
    { name: "default_device_limit", label: "缺省每账号设备数", type: "number", min: 1, max: 9, value: s.default_device_limit },
    { name: "min_version", label: "客户端最低版本", value: cur.min_version, placeholder: "如 1.8.0；空 = 不限" },
  ];
  // 设置行左边已有名称：单个控件的行把字段标签只留给读屏（.bare）
  const f = (name, bare) => field({ ...specs.find((x) => x.name === name), ...(bare ? { class: "bare" } : {}) });
  const err = h("p", { class: "form-error", role: "alert" });
  const canEdit = can("settings.manage");
  const regCards = h(
    "fieldset",
    { class: "radio-cards", disabled: !canEdit },
    h("legend", { class: "sr-only" }, "注册方式"),
    REG.map(([v, label, desc, tone]) => h("label", { class: "radio-card" }, h("input", { type: "radio", name: "registration", value: v, checked: s.registration === v }), h("span", {}, h("b", {}, label), h("small", {}, desc), s.registration === v ? badge("当前", tone) : null))),
  );
  const form = h(
    "form",
    { class: "settings", novalidate: true },
    settingRow("注册方式", "开放注册没有邮箱验证，存在批量注册领取试用额度的风险；对外推广期以外建议“只凭码注册”。", regCards),
    settingRow("试用", "只影响之后的自助注册（注册方式为“开放”时不带码注册即开试用律所）；已开通的律所不受影响。", h("div", { class: "inline-fields" }, f("trial_plan"), f("trial_days"), f("trial_seats"))),
    settingRow("缺省每账号设备数", "套餐没写设备数时用这个值；同一账号最多 9 台。", f("default_device_limit", true)),
    settingRow("客户端最低版本", "低于此版本的 Windows 客户端登录、注册与取席位令牌时被拒（426），并提示升级。", f("min_version", true)),
    settingRow(
      "邮件通道",
      s.mail?.configured ? "忘记密码会真发 6 位验证码。" : "未配置时忘记密码不会真发码：只能运营在“账号”里发一次性重置码。",
      facts([["状态", s.mail?.configured ? badge("已配置", "ok") : badge("未配置", "warn")], ["发件地址", s.mail?.from ?? "—"]]),
    ),
    err,
    h("div", { class: "settings-foot" }, canEdit ? null : h("span", { class: "muted small" }, `${needs("settings.manage")}，只能查看`), h("button", { type: "submit", class: "btn primary", disabled: !canEdit, title: needs("settings.manage") }, "保存设置…")),
  );
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    err.textContent = "";
    const v = readForm(form, specs);
    const changes = Object.keys(v).filter((k) => String(v[k] ?? "") !== String(cur[k] ?? ""));
    if (!changes.length) return void (err.textContent = "没有改动");
    if (v.min_version && !/^\d+\.\d+\.\d+$/.test(v.min_version)) return void (err.textContent = "客户端最低版本写成 x.y.z，如 1.8.0");
    const ok = await confirmAction({
      title: "保存注册设置",
      danger: v.registration === "open" && s.registration !== "open",
      consequences: [
        v.registration !== s.registration ? { open: "任何人都能自助注册并开一个试用律所（没有邮箱验证，存在批量注册薅试用额度的风险）；", code: "只有持开通码或邀请码的人能注册；", closed: "客户端注册入口关闭，只能运营代建账号；" }[v.registration] : null,
        changes.includes("min_version") ? (v.min_version ? `低于 ${v.min_version} 的客户端将无法登录与调用 AI，须先升级；` : "取消客户端最低版本限制；") : null,
        "已注册的账号与律所不受影响；试用参数只影响之后的自助注册。",
      ].filter(Boolean),
      confirmLabel: "保存",
      run: () => api.put("/v1/ops/settings", Object.fromEntries(changes.map((k) => (k === "min_version" ? ["clients", { min_version: v.min_version || null }] : [k, v[k]])))),
    });
    if (ok) (toast("已保存设置"), reload());
  });

  // 第 62 批新增的注册策略项（契约待定）：接口就绪前如实显示未就绪
  const nextBox =
    next.status === "fulfilled"
      ? panel("更多注册策略", facts(Object.entries(next.value ?? {}).filter(([k]) => k !== "ok").map(([k, v]) => [mono(k), typeof v === "object" ? mono(JSON.stringify(v)) : String(v)])), { sub: "第 62 批新增项（契约待定：字段与控件按契约改）" })
      : panel("更多注册策略", h("div", { class: "stack-sm" }, errorBlock(next.reason, reload), h("div", { class: "skeleton-note" }, h("span", {}, "接口就绪后这里会出现第 62 批新增的注册策略，例如："), h("ul", {}, h("li", {}, "注册所需的验证方式（邮箱、手机号短信）"), h("li", {}, "邀请码是否必填、单码可用次数缺省值"), h("li", {}, "同一手机号 / 邮箱 / 来源的注册频率限制")))), { sub: "第 62 批新增，后端在做" });
  clear(box, panel(null, form), nextBox);
}

// ─── 邀请码 ─────────────────────────────────────────────────────────
// 契约待定：字段名（code_hint、uses、max_uses、expires_at、plan、note、status、created_by）按契约核对
const INVITE_STATUS = { active: ["有效", "ok"], exhausted: ["已用完", "neutral"], expired: ["已过期", "neutral"], revoked: ["已作废", "neutral"] };
const ist = { status: "active", q: "", table: { sort: "created_at", asc: false } };

function renderInvites(page, r) {
  if (r.params.q !== undefined) ist.q = r.params.q;
  const canEdit = can("settings.manage");
  const createBtn = btn("生成邀请码", () => createInvite(reload), { kind: "primary", icon: icon("plus"), disabled: true, title: "接口就绪后可用" });
  const tools = h("div", { class: "toolbar" });
  const box = h("div", { class: "stack" });
  page.append(pageHead("邀请码", "平台发给潜在客户的注册邀请码：可用次数、有效期、注册后进入的套餐", createBtn), tools, box);
  let rows = [];
  const drawTools = () =>
    clear(
      tools,
      segmented([{ id: "active", label: "有效" }, { id: "exhausted", label: "已用完" }, { id: "revoked", label: "已作废" }, { id: "", label: "全部" }], ist.status, (v) => ((ist.status = v), drawTools(), reload()), "状态"),
      searchInput({ placeholder: "备注或码尾号", value: ist.q, onInput: (v) => ((ist.q = v), draw()) }),
    );
  const draw = () =>
    clear(
      box,
      dataTable({
        state: ist.table,
        rows: rows.filter((x) => !ist.q || [x.note, x.code_hint, x.plan].some((f) => String(f ?? "").toLowerCase().includes(ist.q.toLowerCase()))),
        empty: rows.length ? "没有符合条件的邀请码" : "还没有发过邀请码",
        rowClass: (x) => (x.status && x.status !== "active" ? "dim" : ""),
        columns: [
          { key: "code_hint", label: "邀请码", render: (x) => h("div", { class: "cell-2" }, mono(x.code_hint ?? x.id ?? "—"), x.note ? h("small", {}, x.note) : null) },
          { key: "plan", label: "注册后套餐", value: (x) => x.plan_label ?? x.plan ?? "" },
          { key: "uses", label: "已用 / 上限", num: true, value: (x) => Number(x.uses) || 0, render: (x) => `${fmt.int(x.uses)} / ${x.max_uses === null || x.max_uses === undefined ? "不限" : fmt.int(x.max_uses)}` },
          { key: "expires_at", label: "有效至", value: (x) => x.expires_at ?? "", render: (x) => (x.expires_at ? fmt.date(x.expires_at) : "长期") },
          { key: "created_at", label: "生成", value: (x) => x.created_at ?? "", render: (x) => h("div", { class: "cell-2" }, fmt.date(x.created_at), x.created_by ? h("small", {}, x.created_by) : null) },
          { key: "status", label: "状态", render: (x) => badge(...(INVITE_STATUS[x.status] ?? [x.status ?? "—", "neutral"])) },
          {
            key: "_act",
            label: "",
            sortable: false,
            class: "act",
            render: (x) =>
              x.status === "active"
                ? btn("作废", async () => {
                    const ok = await confirmAction({ title: "作废邀请码", danger: true, consequences: ["这个码立即不能再用于注册；已用它注册的账号不受影响。"], confirmLabel: "作废", run: () => api.registration.revokeInvite(x.id) });
                    if (ok) (toast("已作废"), reload());
                  }, { size: "sm", kind: "danger", disabled: !canEdit, title: needs("settings.manage") })
                : null,
          },
        ],
      }),
    );
  const reload = async () => {
    clear(box, loadingBlock("正在读取邀请码…"));
    try {
      const d = await api.registration.invites({ status: ist.status });
      rows = Array.isArray(d) ? d : d.invites ?? [];
      createBtn.disabled = !canEdit;
      createBtn.title = needs("settings.manage") ?? "";
      draw();
    } catch (e) {
      createBtn.disabled = true;
      clear(box, errorBlock(e, reload), e?.code === "not_ready" ? skeleton(["邀请码（只显示尾号）与备注", "注册后进入的套餐", "已用次数 / 上限、有效期", "生成人与状态；有效的码可作废"]) : null);
    }
  };
  drawTools();
  reload();
}

async function createInvite(after) {
  let plans = [];
  try {
    plans = (await api.get("/v1/ops/plans")).plans ?? [];
  } catch {
    plans = [];
  }
  const r = await confirmAction({
    title: "生成邀请码",
    lead: h("p", {}, "凭码注册的人进入下面的套餐。码只显示一次。"),
    fields: [
      { name: "note", label: "备注（发给谁）", required: true, maxlength: 60, placeholder: "如：某律所 张律师（11 月推介会）" },
      plans.length ? { name: "plan", label: "注册后套餐", type: "select", options: plans.map((p) => [p.id, p.label ?? p.id]) } : { name: "plan", label: "注册后套餐编号", placeholder: "trial" },
      { name: "max_uses", label: "可用次数", type: "number", min: 1, max: 1000, value: 1, hint: "空 = 不限次数" },
      { name: "days", label: "有效天数", type: "number", min: 1, max: 365, value: 30 },
    ],
    confirmLabel: "生成",
    run: (v) => api.registration.createInvite({ note: v.note, plan: v.plan, max_uses: v.max_uses, days: v.days }),
  });
  if (r?.code) {
    await showSecret({ title: "邀请码", secret: r.code, expiresAt: r.expires_at, warn: "只显示这一次：关掉后无法再查看。请经安全渠道交给对方。" });
    after?.();
  }
}

// ─── 短信服务 ───────────────────────────────────────────────────────
// 契约待定：服务商、签名、模板、限额字段与密钥是否须本页加密（同上游密钥）按契约定；明文密钥提交后立即清空
function renderSms(page) {
  const box = h("div", { class: "stack-lg" });
  page.append(pageHead("短信服务", "手机号注册与找回密码用的短信通道：服务商、签名、模板、发送限额"), box);
  const reload = () =>
    load(
      box,
      () => api.registration.sms(),
      (d) => drawSms(box, d, reload),
      "正在读取短信服务配置…",
    ).then(() => {
      if (box.querySelector(".state-notready")) box.append(skeleton(["服务商与签名、注册与找回密码两套模板", "访问密钥（只存密文与尾号，不回显明文）", "同一手机号每日上限、全局每分钟上限", "发测试短信、最近发送结果与失败原因"]));
    });
  reload();
}

function drawSms(box, d, reload) {
  const c = d.sms ?? d;
  const canEdit = can("settings.manage");
  const specs = [
    { name: "enabled", label: "启用短信验证码", type: "checkbox", value: !!c.enabled },
    { name: "provider", label: "服务商", type: "select", options: (c.providers ?? [[c.provider ?? "", c.provider ?? "—"]]).map((p) => (Array.isArray(p) ? p : [p.id, p.label ?? p.id])), value: c.provider ?? "" },
    { name: "sign_name", label: "短信签名", value: c.sign_name ?? "" },
    { name: "template_register", label: "注册验证码模板", value: c.templates?.register ?? "" },
    { name: "template_reset", label: "找回密码模板", value: c.templates?.reset ?? "" },
    { name: "access_key_id", label: "访问密钥编号", value: c.access_key_id ?? "" },
    { name: "per_phone_daily", label: "同一手机号每日上限", type: "number", min: 1, max: 100, value: c.limits?.per_phone_daily ?? "" },
  ];
  const secret = h("input", { type: "password", name: "access_secret", autocomplete: "new-password", spellcheck: "false", disabled: !canEdit, placeholder: c.secret_hint ? `已设 ${c.secret_hint}；留空 = 不改` : "粘贴访问密钥" });
  const err = h("p", { class: "form-error", role: "alert" });
  const form = h(
    "form",
    { class: "settings", novalidate: true },
    settingRow("状态", c.last_error ? `最近一次发送失败：${c.last_error}` : "关掉后手机号注册与找回密码不可用。", field(specs[0]), c.health ? badge(c.health === "ok" ? "通道正常" : "通道异常", c.health === "ok" ? "ok" : "danger") : null),
    settingRow("服务商与签名", null, h("div", { class: "inline-fields" }, field(specs[1]), field(specs[2]))),
    settingRow("模板", "模板编号在服务商控制台申请。", h("div", { class: "inline-fields" }, field(specs[3]), field(specs[4]))),
    settingRow("访问密钥", "明文只在本页停留：保存后输入框立即清空，控制面只回尾号。", field(specs[5]), h("div", { class: "field" }, h("label", {}, "访问密钥"), secret)),
    settingRow("限额", "防止被刷：超过即拒发并记审计。", field(specs[6])),
    err,
    h(
      "div",
      { class: "settings-foot" },
      btn("发测试短信…", async () => {
        const r = await confirmAction({ title: "发测试短信", fields: [{ name: "phone", label: "手机号", required: true, inputmode: "tel", maxlength: 20 }], confirmLabel: "发送", run: (v) => api.registration.testSms({ phone: v.phone }) });
        if (r) toast("已发送，请查收");
      }, { disabled: !canEdit, title: needs("settings.manage") }),
      h("span", { class: "spacer" }),
      h("button", { type: "submit", class: "btn primary", disabled: !canEdit, title: needs("settings.manage") }, "保存…"),
    ),
  );
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    err.textContent = "";
    const v = readForm(form, specs);
    const plain = secret.value;
    const ok = await confirmAction({
      title: "保存短信服务配置",
      danger: c.enabled && !v.enabled,
      consequences: [v.enabled ? "保存后约 15 秒生效。" : "停用后手机号注册与找回密码不可用。", plain ? "访问密钥换成新的一把（旧的作废）。" : "访问密钥不改。"],
      confirmLabel: "保存",
      run: () => {
        const body = { enabled: v.enabled, provider: v.provider, sign_name: v.sign_name, templates: { register: v.template_register, reset: v.template_reset }, access_key_id: v.access_key_id, limits: { per_phone_daily: v.per_phone_daily }, ...(plain ? { access_secret: plain } : {}) };
        secret.value = "";
        return api.registration.saveSms(body);
      },
    });
    secret.value = "";
    if (ok) (toast("已保存"), reload());
  });
  clear(box, panel(null, form));
}

/** 接口未就绪时：说明这一页就绪后会显示什么（不造数据） */
function skeleton(items) {
  return h("div", { class: "skeleton-note" }, h("span", {}, "接口就绪后这一页显示："), h("ul", {}, items.map((x) => h("li", {}, x))));
}
