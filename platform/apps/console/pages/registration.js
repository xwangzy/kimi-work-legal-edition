/**
 * 注册管理（第 62 批，平台运营 · 客户组一级菜单；契约 platform/docs/contract-b62-registration.md §4、§8）：
 *   注册策略  概览（注册方式、手机号验证、短信通道、邀请码存量）+ 策略（开放 / 仅凭码 / 关闭、必须验证手机号、试用规格、缺省设备数；
 *             PUT /v1/ops/registration/policy，危险操作要复核）+ 客户端最低版本与邮件通道（/v1/ops/settings）
 *   邀请码    批次（生成、整批停用）与码列表（状态筛选、搜索、按批次、复制、详情与使用记录、单个 / 批量停用与重新启用、导出 CSV）
 *   短信服务  配置（AppKey 只写不回显、测试连接 = 查余额、发送测试短信要复核）、发送记录、注册管理操作记录
 * 权限：看 registration.read；改策略、邀请码 registration.manage；短信通道 settings.manage（系统设置）。
 * 完整的邀请码只在 registration.manage 下给（列表 code 字段）；只读角色看打码 ABCD-****-WXYZ。
 */
import * as api from "../api.js";
import { can, ctx, go, isMe, needs, pageHead } from "../domain.js";
import {
  $, badge, btn, clear, confirmAction, copyBtn, dataTable, errorBlock, facts, field, fmt, h, icon, load, loadingBlock, mono, note, openDrawer, panel, readForm, saveCsv,
  searchInput, segmented, selectEl, settingRow, stat, tabBar, toast,
} from "../ui.js";

export const SUBPAGES = [
  ["policy", "注册策略"],
  ["invites", "邀请码"],
  ["sms", "短信服务"],
];

export function render(page, r) {
  const sub = SUBPAGES.some(([id]) => id === r.arg) ? r.arg : "policy";
  if (sub === "invites") return renderInvites(page, r);
  if (sub === "sms") return renderSms(page, r);
  return renderPolicy(page);
}

const MODE = { open: "开放自助注册", code: "仅凭码注册", closed: "关闭注册" };
const SMS_REASON = { sms_disabled: "未启用", sms_not_configured: "未配置齐" };
const MISSING = { app_id: "AppID", app_key: "AppKey", sign_name: "签名", "projects.register": "注册模板", "projects.reset": "找回模板", register: "注册模板", reset: "找回模板" };
const missingText = (list) => (list ?? []).map((k) => MISSING[k] ?? k).join("、");
const smsStatus = (v) =>
  !v ? ["—", "neutral"] : v.available ? [v.mode === "dry_run" ? "可用 · 测试模式（不真发）" : "可用", v.mode === "dry_run" ? "warn" : "ok"] : [`不可用：${SMS_REASON[v.unavailable_reason] ?? v.unavailable_reason ?? "未启用"}`, "neutral"];
/** 复制按钮（表格里用小图标，不抢视线） */
const copyIcon = (text, what = "邀请码") =>
  h("button", { type: "button", class: "icon-btn sm", "aria-label": `复制${what}`, title: "复制", onclick: async (ev) => {
    ev.stopPropagation();
    try {
      await navigator.clipboard.writeText(String(text));
      toast("已复制");
    } catch {
      toast("浏览器不允许写剪贴板：请手动选中复制", "error");
    }
  } }, icon("copy"));

// ─── 注册策略 ───────────────────────────────────────────────────────
const REG = [
  ["open", "开放自助注册", "不带码注册 = 新建一家试用律所；带开通码、成员邀请码或注册邀请码照常"],
  ["code", "仅凭码注册", "必须填开通码、成员邀请码或平台注册邀请码"],
  ["closed", "关闭注册", "客户端注册入口关闭（发注册验证码同样拒绝），只能运营代建账号"],
];

function renderPolicy(page) {
  const head = h("div");
  const box = h("div", { class: "stack-lg" });
  page.append(head, box);
  clear(head, pageHead("注册策略", "谁能注册、要不要验证手机号、试用给多少"));
  const reload = () =>
    load(
      box,
      async () => {
        const [o, s, p] = await Promise.allSettled([api.registration.overview(), api.get("/v1/ops/settings"), api.get("/v1/ops/plans")]);
        if (o.status === "rejected") throw o.reason;
        return { o: o.value, set: s.status === "fulfilled" ? s.value : null, plans: p.status === "fulfilled" ? p.value.plans ?? [] : [] };
      },
      ({ o, set, plans }) => drawPolicy(head, box, o, set, plans, reload),
      "正在读取注册策略…",
    );
  reload();
}

function drawPolicy(head, box, o, set, plans, reload) {
  const pol = o.policy ?? {};
  const sms = o.sms ?? {};
  const inv = o.invites ?? {};
  const canEdit = can("registration.manage");
  const specs = [
    { name: "registration", type: "radio" },
    plans.length ? { name: "trial_plan", label: "试用套餐", type: "select", options: plans.map((p) => [p.id, p.label ?? p.id]), value: pol.trial_plan } : { name: "trial_plan", label: "试用套餐编号", value: pol.trial_plan ?? "" },
    { name: "trial_days", label: "试用天数", type: "number", min: 1, max: 365, value: pol.trial_days },
    { name: "trial_seats", label: "试用席位", type: "number", min: 1, max: 50, value: pol.trial_seats },
    { name: "default_device_limit", label: "缺省每账号设备数", type: "number", min: 1, max: 9, value: pol.default_device_limit, class: "bare" },
    { name: "phone_required", label: "注册必须验证手机号", type: "checkbox", value: pol.phone_required, hint: sms.available ? "打开后注册要填手机号与短信验证码；手机号与账号一对一" : "短信通道不可用：先在“短信服务”配好并启用", disabled: !pol.phone_required && !sms.available },
  ];
  const f = (name) => field(specs.find((x) => x.name === name));
  const err = h("p", { class: "form-error", role: "alert" });
  const regCards = h(
    "fieldset",
    { class: "radio-cards", disabled: !canEdit },
    h("legend", { class: "sr-only" }, "注册方式"),
    REG.map(([v, label, desc]) => h("label", { class: "radio-card" }, h("input", { type: "radio", name: "registration", value: v, checked: pol.registration === v }), h("span", {}, h("b", {}, label), h("small", {}, desc)))),
  );
  const form = h(
    "form",
    { class: "settings", novalidate: true },
    settingRow("注册方式", "开放注册没有人工审核，存在批量注册领取试用额度的风险；对外推广期以外建议“仅凭码注册”。", regCards),
    settingRow("手机号验证", "律师端注册时填手机号并收短信验证码。打开前先把客户端最低版本设为本批客户端（旧客户端不认识这一项）。", f("phone_required")),
    settingRow("试用规格", "不带码、或注册邀请码没指定时，新律所按这里开试用；已开通的律所不受影响。", h("div", { class: "inline-fields" }, f("trial_plan"), f("trial_days"), f("trial_seats"))),
    settingRow("缺省每账号设备数", "套餐没写设备数时用这个值；同一账号最多 9 台。", f("default_device_limit")),
    err,
    h("div", { class: "settings-foot" }, canEdit ? null : h("span", { class: "muted small" }, `${needs("registration.manage")}，只能查看`), h("button", { type: "submit", class: "btn primary", disabled: !canEdit, title: needs("registration.manage") }, "保存注册策略…")),
  );
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    err.textContent = "";
    const v = readForm(form, specs.filter((x) => x.name !== "phone_required" || !x.disabled));
    if (specs.find((x) => x.name === "phone_required").disabled) v.phone_required = pol.phone_required === true;
    const changed = Object.keys(v).filter((k) => String(v[k] ?? "") !== String(pol[k] ?? ""));
    if (!changed.length) return void (err.textContent = "没有改动");
    const ok = await confirmAction({
      title: "保存注册策略",
      danger: (v.registration === "open" && pol.registration !== "open") || (v.phone_required && !pol.phone_required),
      consequences: [
        v.registration !== pol.registration ? { open: "任何人都能自助注册并开一家试用律所（存在批量注册薅试用额度的风险）；", code: "只有持开通码、成员邀请码或注册邀请码的人能注册；", closed: "客户端注册入口关闭，只能运营代建账号；" }[v.registration] : null,
        v.phone_required !== (pol.phone_required === true) ? (v.phone_required ? "之后注册必须验证手机号（旧客户端不认识这一项，只会看到通用失败）；" : "之后注册不再强制手机号（填了仍会验证）；") : null,
        "已注册的账号与律所不受影响；试用规格只影响之后的注册。这是危险操作：要求 10 分钟内复核过密码。",
      ].filter(Boolean),
      confirmLabel: "保存",
      run: () => api.registration.savePolicy(Object.fromEntries(changed.map((k) => [k, v[k]]))),
    });
    if (ok) (toast("已保存注册策略"), reload());
  });

  // 客户端最低版本（系统设置，/v1/ops/settings）与邮件通道：独立的一张卡，次要动作
  const mvSpec = { name: "min_version", label: "客户端最低版本", value: set?.clients?.min_version ?? set?.min_client_version ?? "", placeholder: "如 1.8.0；空 = 不限", class: "bare" };
  const mvErr = h("p", { class: "form-error", role: "alert" });
  const mvForm = h(
    "form",
    { class: "settings", novalidate: true },
    settingRow("客户端最低版本", "低于此版本的客户端登录、注册与取席位令牌时被拒（426）并提示升级。", h("div", { class: "btn-row" }, field(mvSpec), h("button", { type: "submit", class: "btn", disabled: !can("settings.manage"), title: needs("settings.manage") }, "保存…")), mvErr),
    settingRow("邮件通道", set?.mail?.configured ? "忘记密码会真发 6 位验证码。" : "未配置时忘记密码不会真发码：只能运营在“账号”里发一次性重置码。", h("span", { class: "status-line" }, h("span", { class: `dot tone-${set?.mail?.configured ? "ok" : "neutral"}`, "aria-hidden": "true" }), set ? (set.mail?.configured ? `已配置 · ${set.mail?.from ?? ""}` : "未配置") : "读不到")),
  );
  mvForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    mvErr.textContent = "";
    const v = readForm(mvForm, [mvSpec]).min_version;
    if (v && !/^\d+\.\d+\.\d+$/.test(v)) return void (mvErr.textContent = "写成 x.y.z，如 1.8.0");
    if (v === (mvSpec.value ?? "")) return void (mvErr.textContent = "没有改动");
    const ok = await confirmAction({ title: "客户端最低版本", consequences: [v ? `低于 ${v} 的客户端将无法登录与调用 AI，须先升级。` : "取消客户端最低版本限制。"], confirmLabel: "保存", run: () => api.put("/v1/ops/settings", { clients: { min_version: v || null } }) });
    if (ok) (toast("已保存"), reload());
  });

  const [, smsTone] = smsStatus(sms);
  const byS = inv.by_status ?? {};
  clear(
    box,
    h(
      "div",
      { class: "kpis" },
      stat("注册方式", MODE[pol.registration] ?? pol.registration ?? "—", o.meta?.invite_required ? "须填码" : "可不带码"),
      stat("手机号验证", pol.phone_required ? "必须" : "可选", pol.phone_required ? "注册要短信验证码" : "填了才验证"),
      stat("短信通道", h("span", { class: "status-line" }, h("span", { class: `dot tone-${smsTone}`, "aria-hidden": "true" }), sms.available ? "可用" : "不可用"), sms.dry_run_blocked ? "测试模式被部署禁用" : sms.available ? (sms.mode === "dry_run" ? "测试模式（不真发）" : "真实发送") : `${SMS_REASON[sms.unavailable_reason] ?? "未启用"}${sms.missing?.length ? `：缺 ${missingText(sms.missing)}` : ""}`, { onClick: can("settings.manage") ? () => go("ops/registration/sms") : undefined }),
      stat("注册邀请码", `${fmt.int(byS.available)} 可用`, `共 ${fmt.int(inv.total)} 个 · ${fmt.int(inv.batches)} 批`, { onClick: () => go("ops/registration/invites") }),
    ),
    sms.dry_run_blocked ? h("div", { class: "banner warn" }, icon("alert"), h("span", {}, "短信设置里开着测试模式，但本部署不允许测试模式：按关闭处理。请到“短信服务”关闭测试模式并配置真实通道。")) : null,
    panel(null, form),
    panel("客户端与邮件", mvForm),
  );
}

// ─── 邀请码 ─────────────────────────────────────────────────────────
const INVITE_STATUS = { available: ["可用", "ok"], exhausted: ["已用完", "neutral"], expired: ["已过期", "neutral"], disabled: ["已停用", "danger"] };
const ist = { status: "", q: "", batch: "", table: { sort: "created_at", asc: false }, selected: new Set() };

function renderInvites(page, r) {
  if (r.params.q !== undefined) ist.q = r.params.q;
  if (r.params.batch !== undefined) ist.batch = r.params.batch;
  const canEdit = can("registration.manage");
  const genBtn = btn("生成一批…", () => createBatch(() => ctx.reload()), { kind: "primary", icon: icon("plus"), disabled: !canEdit, title: needs("registration.manage") });
  const batchesBox = h("div");
  const codesBox = h("div");
  page.append(pageHead("注册邀请码", "凭码注册即开一家试用律所（套餐、天数、席位可随批次设定）；码 12 位，可复制、导出交给渠道", genBtn), batchesBox, codesBox);
  let batches = [];
  const loadBatches = () =>
    load(batchesBox, () => api.registration.batches(), (d) => {
      batches = d.batches ?? [];
      drawBatches();
      drawCodesTools();
    }, "正在读取批次…");
  const drawBatches = () =>
    clear(
      batchesBox,
      panel(
        "批次",
        dataTable({
          state: { sort: "created_at", asc: false },
          rows: batches,
          empty: "还没有生成过邀请码：点右上角“生成一批”",
          onRow: (b) => ((ist.batch = ist.batch === b.id ? "" : b.id), ist.selected.clear(), drawBatches(), drawCodesTools(), fetchCodes(false)),
          rowClass: (b) => (b.id === ist.batch ? "selected-row" : ""),
          columns: [
            { key: "name", label: "批次", render: (b) => h("div", { class: "cell-2" }, h("b", {}, b.name), b.note ? h("small", {}, b.note) : mono(b.id)) },
            { key: "count", label: "码数", num: true, render: (b) => fmt.int(b.count) },
            { key: "used_total", label: "已注册", num: true, render: (b) => fmt.int(b.used_total) },
            { key: "by_status", label: "可用 / 用完 / 过期 / 停用", num: true, sortable: false, render: (b) => h("span", { class: "num" }, ["available", "exhausted", "expired", "disabled"].map((k) => fmt.int(b.by_status?.[k])).join(" / ")) },
            { key: "max_uses", label: "每码可用", num: true, render: (b) => fmt.int(b.max_uses) },
            { key: "plan", label: "套餐 / 试用", value: (b) => b.plan ?? "", render: (b) => (b.plan || b.trial_days || b.trial_seats ? `${b.plan ?? "缺省"} · ${b.trial_days ? `${b.trial_days} 天` : "缺省天数"} · ${b.trial_seats ? `${b.trial_seats} 席` : "缺省席位"}` : h("span", { class: "muted" }, "按注册策略")) },
            { key: "expires_at", label: "有效至", value: (b) => b.expires_at ?? "", render: (b) => (b.expires_at ? fmt.date(b.expires_at) : "长期") },
            { key: "created_at", label: "生成", value: (b) => b.created_at ?? "", render: (b) => h("span", { title: b.created_by ? `${isMe(b.created_by) ? "我" : b.created_by} 生成` : undefined }, fmt.date(b.created_at)) },
            {
              key: "_act",
              label: "",
              sortable: false,
              class: "act",
              render: (b) =>
                (b.by_status?.available ?? 0) > 0
                  ? btn("停用整批", async () => {
                      const ok = await confirmAction({ title: `停用批次“${b.name}”`, danger: true, consequences: [`这一批还能用的 ${fmt.int(b.by_status?.available)} 个码立即不能再用于注册；已用它注册的账号不受影响；`, "停用的码可在下方逐个重新启用。"], fields: [{ name: "reason", label: "原因（选填，记入操作记录）", maxlength: 100 }], confirmLabel: "停用整批", run: (v) => api.registration.disableBatch(b.id, v.reason) });
                      if (ok) (toast(`已停用 ${fmt.int(ok.disabled)} 个码`), loadBatches(), fetchCodes(false));
                    }, { size: "sm", kind: "danger", class: "ghost", disabled: !canEdit, title: needs("registration.manage") })
                  : null,
            },
          ],
        }),
        { flush: true, sub: ist.batch ? "点同一行取消筛选" : "点一行只看这一批的码" },
      ),
    );

  // 码列表
  const tools = h("div", { class: "toolbar" });
  const listBox = h("div");
  let rows = [];
  let next = null;
  let total = 0;
  let revealed = false;
  let seq = 0;
  const params = () => ({ status: ist.status, q: ist.q.trim(), batch_id: ist.batch });
  const fetchCodes = async (append) => {
    const my = ++seq;
    if (!append) clear(listBox, loadingBlock("正在读取邀请码…"));
    try {
      const d = await api.registration.invites({ ...params(), limit: 100, cursor: append ? next : undefined });
      if (my !== seq) return;
      rows = append ? rows.concat(d.invites ?? []) : d.invites ?? [];
      next = d.next ?? null;
      total = d.total ?? rows.length;
      revealed = !!d.revealed;
      drawCodes();
    } catch (e) {
      if (my === seq) clear(listBox, errorBlock(e, () => fetchCodes(false)));
    }
  };
  const drawCodesTools = () => {
    const bsel = selectEl([["", "全部批次"], ...batches.map((b) => [b.id, b.name])], ist.batch, (v) => ((ist.batch = v), ist.selected.clear(), drawBatches(), fetchCodes(false)), { "aria-label": "批次" });
    clear(
      tools,
      segmented([{ id: "", label: "全部" }, ...Object.entries(INVITE_STATUS).map(([id, [label]]) => ({ id, label }))], ist.status, (v) => ((ist.status = v), ist.selected.clear(), drawCodesTools(), fetchCodes(false)), "状态"),
      bsel,
      searchInput({ placeholder: "完整的码、批次名、码末 4 位、使用人邮箱或手机号", value: ist.q, onInput: (v) => ((ist.q = v), ist.selected.clear(), fetchCodes(false)), delay: 300 }),
      h("span", { class: "spacer" }),
      btn("导出 CSV", async (ev) => {
        const b = ev.currentTarget;
        b.disabled = true;
        try {
          await api.registration.exportInvites(params(), `kwl-invites-${new Date().toISOString().slice(0, 10)}.csv`);
          toast("已导出（含完整的码，请妥善保管）");
        } catch (e) {
          toast(e.message, "error");
        } finally {
          b.disabled = !canEdit;
        }
      }, { icon: icon("download"), disabled: !canEdit, title: canEdit ? "按当前筛选导出，含完整的码" : needs("registration.manage") }),
    );
  };
  const drawCodes = () => {
    const sel = ist.selected;
    const selectable = rows.filter((x) => x.status !== "disabled");
    const allOn = selectable.length > 0 && selectable.every((x) => sel.has(x.id));
    const head = h("input", { type: "checkbox", checked: allOn, disabled: !canEdit || !selectable.length, "aria-label": "全选本页", onchange: (e) => (selectable.forEach((x) => (e.target.checked ? sel.add(x.id) : sel.delete(x.id))), drawCodes()) });
    const bar = sel.size
      ? h(
          "div",
          { class: "selection-bar" },
          `已选 ${sel.size} 个`,
          btn("停用所选…", async () => {
            const ids = [...sel];
            const ok = await confirmAction({ title: `停用 ${ids.length} 个邀请码`, danger: true, consequences: ["这些码立即不能再用于注册；已用它们注册的账号不受影响；", "可逐个重新启用。"], fields: [{ name: "reason", label: "原因（选填）", maxlength: 100 }], confirmLabel: "停用", run: (v) => api.registration.disableInvites(ids, v.reason) });
            if (ok) (toast(`已停用 ${fmt.int(ok.disabled)} 个`), sel.clear(), loadBatches(), fetchCodes(false));
          }, { size: "sm", kind: "danger" }),
          btn("取消选择", () => (sel.clear(), drawCodes()), { size: "sm", kind: "ghost" }),
        )
      : null;
    clear(
      listBox,
      panel(
        `邀请码${ist.batch ? ` · ${batches.find((b) => b.id === ist.batch)?.name ?? ""}` : ""}`,
        h(
          "div",
          {},
          bar,
          dataTable({
            state: ist.table,
            rows,
            onRow: (x) => openInvite(x.id, () => (loadBatches(), fetchCodes(false))),
            empty: ist.q || ist.status || ist.batch ? "没有符合条件的邀请码" : "还没有邀请码",
            rowClass: (x) => (x.status !== "available" ? "dim" : ""),
            columns: [
              canEdit ? { key: "_sel", label: head, sortable: false, class: "check-col", render: (x) => (x.status === "disabled" ? null : h("input", { type: "checkbox", checked: sel.has(x.id), "aria-label": `选择 ${x.code_masked}`, onchange: (e) => (e.target.checked ? sel.add(x.id) : sel.delete(x.id), drawCodes()) })) } : null,
              { key: "code", label: "邀请码", value: (x) => x.code ?? x.code_masked, render: (x) => h("span", { class: "code-cell" }, mono(x.code ?? x.code_masked), x.code ? copyIcon(x.code) : null) },
              { key: "batch_name", label: "批次" },
              { key: "status", label: "状态", render: (x) => badge(...(INVITE_STATUS[x.status] ?? [x.status, "neutral"]), x.disabled_reason ?? undefined) },
              { key: "used", label: "已用 / 可用", num: true, value: (x) => Number(x.used) || 0, render: (x) => `${fmt.int(x.used)} / ${fmt.int(x.max_uses)}` },
              { key: "expires_at", label: "有效至", value: (x) => x.expires_at ?? "", render: (x) => (x.expires_at ? fmt.date(x.expires_at) : "长期") },
              { key: "plan", label: "套餐 / 试用", class: "opt", value: (x) => x.plan ?? "", render: (x) => (x.plan || x.trial_days ? `${x.plan ?? "缺省"}${x.trial_days ? ` · ${x.trial_days} 天` : ""}${x.trial_seats ? ` · ${x.trial_seats} 席` : ""}` : h("span", { class: "muted" }, "按注册策略")) },
              { key: "last_used_at", label: "最近使用", value: (x) => x.last_used_at ?? "", render: (x) => (x.last_used_at ? h("span", { title: fmt.full(x.last_used_at) }, fmt.ago(x.last_used_at)) : h("span", { class: "muted" }, "未使用")) },
              {
                key: "_act",
                label: "",
                sortable: false,
                class: "act",
                render: (x) =>
                  x.status === "disabled"
                    ? btn("重新启用", async () => {
                        try {
                          await api.registration.enableInvite(x.id);
                          toast("已重新启用");
                          loadBatches();
                          fetchCodes(false);
                        } catch (e) {
                          toast(e.message, "error");
                        }
                      }, { size: "sm", disabled: !canEdit, title: needs("registration.manage") })
                    : null,
              },
            ].filter(Boolean),
          }),
        ),
        { flush: true, sub: `共 ${fmt.int(total)} 个${revealed ? "" : " · 你的角色只看打码"}`, actions: next ? btn("加载更多", () => fetchCodes(true), { size: "sm" }) : null },
      ),
    );
  };
  clear(codesBox, h("div", { class: "stack" }, tools, listBox));
  drawCodesTools();
  loadBatches();
  fetchCodes(false);
}

/** 邀请码详情抽屉：码、批次、状态、使用记录（关联用户与律所） */
function openInvite(id, after) {
  const body = h("div", { class: "stack" }, loadingBlock("正在读取邀请码…"));
  const dr = openDrawer({ title: "邀请码", subtitle: mono(id), body, wide: true });
  const reload = () =>
    load(body, () => api.registration.invite(id), (d) => {
      const x = d.invite ?? {};
      dr.setTitle(x.code ?? x.code_masked ?? "邀请码");
      const canEdit = can("registration.manage");
      body.append(
        h(
          "div",
          { class: "action-bar" },
          x.code ? copyBtn(x.code, "复制邀请码") : null,
          h("span", { class: "spacer" }),
          x.status === "disabled"
            ? btn("重新启用", async () => {
                try {
                  await api.registration.enableInvite(id);
                  toast("已重新启用");
                  reload();
                  after?.();
                } catch (e) {
                  toast(e.message, "error");
                }
              }, { size: "sm", disabled: !canEdit, title: needs("registration.manage") })
            : btn("停用…", async () => {
                const ok = await confirmAction({ title: "停用邀请码", danger: true, consequences: ["这个码立即不能再用于注册；已用它注册的账号不受影响。"], fields: [{ name: "reason", label: "原因（选填）", maxlength: 100 }], confirmLabel: "停用", run: (v) => api.registration.disableInvite(id, v.reason) });
                if (ok) (toast("已停用"), reload(), after?.());
              }, { size: "sm", kind: "danger", disabled: !canEdit, title: needs("registration.manage") }),
        ),
        panel(
          null,
          facts([
            ["状态", badge(...(INVITE_STATUS[x.status] ?? [x.status, "neutral"]))],
            ["批次", d.batch?.name ?? x.batch_name],
            ["已用 / 可用", `${fmt.int(x.used)} / ${fmt.int(x.max_uses)}（剩 ${fmt.int(x.remaining)}）`],
            ["有效至", x.expires_at ? fmt.full(x.expires_at) : "长期"],
            ["注册后", x.plan || x.trial_days || x.trial_seats ? `${x.plan ?? "缺省套餐"} · ${x.trial_days ?? "缺省"} 天 · ${x.trial_seats ?? "缺省"} 席` : "按注册策略的试用规格"],
            ["生成", `${fmt.full(x.created_at)}${d.batch?.created_by ? `（${d.batch.created_by}）` : ""}`],
            x.disabled_at ? ["停用", `${fmt.full(x.disabled_at)}${x.disabled_by ? `（${x.disabled_by}）` : ""}${x.disabled_reason ? `：${x.disabled_reason}` : ""}`] : null,
          ]),
        ),
        panel(
          "使用记录",
          dataTable({
            state: { sort: "at", asc: false },
            rows: d.uses ?? [],
            empty: "还没有人用这个码注册",
            columns: [
              { key: "at", label: "注册于", render: (u) => fmt.full(u.at) },
              { key: "email", label: "账号", render: (u) => (u.aid && ctx.openAccount ? h("button", { type: "button", class: "link", onclick: () => ctx.openAccount(u.aid) }, u.email ?? u.aid) : u.email ?? mono(u.aid)) },
              { key: "name", label: "姓名" },
              { key: "phone", label: "手机号", render: (u) => (u.phone ? mono(u.phone) : "—") },
              { key: "tenant_name", label: "律所", render: (u) => h("button", { type: "button", class: "link", onclick: () => go(`tenants/${encodeURIComponent(u.tid)}`) }, u.tenant_name ?? u.tid) },
            ],
          }),
          { flush: true },
        ),
      );
    });
  reload();
}

/** 生成一批：数量、有效期、每码可用次数、批次名、可选套餐与试用天数席位；应答含全部的码（只在这里完整显示一次，之后有 manage 权限仍可查看与导出） */
async function createBatch(after) {
  let plans = [];
  try {
    plans = (await api.get("/v1/ops/plans")).plans ?? [];
  } catch {
    plans = [];
  }
  const r = await confirmAction({
    title: "生成一批注册邀请码",
    wide: true,
    lead: h("p", { class: "muted small" }, "凭码注册即开一家试用律所。套餐、试用天数与席位不填就按注册策略。"),
    fields: [
      { name: "name", label: "批次名", required: true, maxlength: 40, placeholder: "如：11 月推介会" },
      { name: "count", label: "数量", type: "number", min: 1, max: 1000, value: 10, required: true },
      { name: "max_uses", label: "每个码可用次数", type: "number", min: 1, max: 1000, value: 1, required: true },
      { name: "ttl_days", label: "有效天数", type: "number", min: 1, max: 3650, value: 30, hint: "留空 = 长期有效" },
      plans.length ? { name: "plan", label: "注册后套餐", type: "select", options: [["", "按注册策略"], ...plans.map((p) => [p.id, p.label ?? p.id])], value: "" } : { name: "plan", label: "注册后套餐编号（可空）" },
      { name: "trial_days", label: "试用天数", type: "number", min: 1, max: 365, hint: "留空 = 按注册策略" },
      { name: "trial_seats", label: "试用席位", type: "number", min: 1, max: 50, hint: "留空 = 按注册策略" },
      { name: "note", label: "备注（发给谁、什么渠道）", maxlength: 200 },
    ],
    validate: (v) => (!(v.count >= 1 && v.count <= 1000) ? "数量须为 1–1000" : !(v.max_uses >= 1 && v.max_uses <= 1000) ? "可用次数须为 1–1000" : null),
    confirmLabel: "生成",
    run: (v) =>
      api.registration.createBatch({
        name: v.name,
        count: v.count,
        max_uses: v.max_uses,
        ...(v.ttl_days ? { ttl_days: v.ttl_days } : {}),
        ...(v.note ? { note: v.note } : {}),
        ...(v.plan ? { plan: v.plan } : {}),
        ...(v.trial_days ? { trial_days: v.trial_days } : {}),
        ...(v.trial_seats ? { trial_seats: v.trial_seats } : {}),
      }),
  });
  if (r?.codes) {
    await showCodes(r.batch, r.codes);
    after?.();
  }
}

/** 生成结果：全部的码 + 复制全部 / 下载 CSV（本页生成，不经第三方） */
function showCodes(batch, codes) {
  const d = $("#modal");
  const text = codes.map((c) => c.code).join("\n");
  return new Promise((resolve) => {
    d.className = "modal wide";
    clear(
      d,
      h(
        "div",
        { class: "modal-form" },
        h("h2", { class: "modal-title" }, `已生成 ${codes.length} 个邀请码`),
        h("p", { class: "modal-lead" }, `批次“${batch?.name ?? ""}”${batch?.expires_at ? ` · 有效至 ${fmt.date(batch.expires_at)}` : " · 长期有效"} · 每个可用 ${fmt.int(batch?.max_uses)} 次`),
        h("pre", { class: "code-list" }, text),
        h("p", { class: "modal-note" }, "之后在列表里仍可查看、复制与导出（需要“管理注册”权限）。请经安全渠道交给对方。"),
        h(
          "div",
          { class: "modal-actions" },
          copyBtn(text, "复制全部"),
          btn("下载 CSV", () => saveCsv([["邀请码", "批次", "可用次数", "有效期至"], ...codes.map((c) => [c.code, c.batch_name ?? batch?.name ?? "", c.max_uses, c.expires_at ?? "长期"])], `kwl-invites-${batch?.id ?? "batch"}.csv`), { size: "sm", icon: icon("download") }),
          h("span", { class: "spacer" }),
          h("button", { type: "button", class: "btn primary", onclick: () => d.close() }, "完成"),
        ),
      ),
    );
    d.onclose = () => resolve(true);
    d.oncancel = null;
    d.showModal();
  });
}

// ─── 短信服务 ───────────────────────────────────────────────────────
const PURPOSE = { register: "注册", reset: "找回密码", test: "测试" };
const SEND_RESULT = { sent: ["已发送", "ok"], dry_run: ["测试模式", "info"], failed: ["失败", "danger"] };
const AUDIT_ACTION = {
  "registration.policy_update": "改注册策略",
  "sms.settings_update": "改短信设置",
  "sms.test_connection": "测试连接",
  "sms.test_send": "发送测试短信",
  "invite.batch_create": "生成邀请码",
  "invite.batch_disable": "停用整批",
  "invite.disable_many": "批量停用",
  "invite.disable": "停用邀请码",
  "invite.enable": "重新启用邀请码",
  "invite.export": "导出邀请码",
};
const sst = { tab: "config", purpose: "", result: "" };

function renderSms(page, r) {
  if (["config", "logs", "audit"].includes(r.params.tab)) sst.tab = r.params.tab;
  const tabs = h("div");
  const box = h("div", { class: "stack-lg" });
  page.append(pageHead("短信服务", "手机号注册与找回密码用的短信通道（赛邮云）"), tabs, box);
  const draw = () => {
    clear(tabs, tabBar([{ id: "config", label: "配置" }, { id: "logs", label: "发送记录" }, { id: "audit", label: "操作记录" }], sst.tab, (id) => ((sst.tab = id), draw())));
    if (sst.tab === "logs") return smsLogs(box);
    if (sst.tab === "audit") return regAudit(box);
    return smsConfig(box);
  };
  draw();
}

function smsConfig(box) {
  const reload = () => load(box, () => api.registration.sms(), (d) => drawSmsConfig(box, d.sms ?? d, reload), "正在读取短信设置…");
  reload();
}

function drawSmsConfig(box, c, reload) {
  const canEdit = can("settings.manage");
  const N = (name, label, min, max, value, hint) => ({ name, label, type: "number", min, max, value, hint });
  const specs = [
    { name: "enabled", label: "启用短信验证码", type: "checkbox", value: !!c.enabled, hint: "关掉后手机号注册与找回不可用（注册策略要求手机号时不能关）" },
    { name: "provider", label: "服务商", type: "select", options: [["submail", "赛邮云 SUBMAIL"]], value: c.provider ?? "submail" },
    { name: "app_id", label: "AppID", value: c.app_id ?? "" },
    { name: "sign_name", label: "短信签名", value: c.sign_name ?? "", placeholder: "不带【】", hint: "须在赛邮云审核通过" },
    { name: "p_register", label: "注册模板项目", value: c.projects?.register ?? "" },
    { name: "p_reset", label: "找回密码模板项目", value: c.projects?.reset ?? "" },
    { name: "p_login", label: "登录模板项目（预留）", value: c.projects?.login ?? "" },
    N("code_length", "验证码位数", 4, 8, c.code_length),
    N("ttl_minutes", "有效分钟", 1, 30, c.ttl_minutes),
    N("resend_seconds", "重发间隔（秒）", 30, 600, c.resend_seconds),
    N("max_attempts", "单码校验次数", 1, 10, c.max_attempts),
    N("daily_limit_per_phone", "同号每日", 1, 50, c.daily_limit_per_phone),
    N("ip_hourly_limit", "同来源每小时", 1, 1000, c.ip_hourly_limit),
    N("daily_total_limit", "全平台每日", 1, 100000, c.daily_total_limit),
    c.dry_run_allowed ? { name: "dry_run", label: "测试模式（不真发，验证码随应答返回）", type: "checkbox", value: !!c.dry_run, hint: "只在允许测试模式的非生产部署可用" } : null,
  ].filter(Boolean);
  const f = (name) => field({ ...specs.find((x) => x.name === name), disabled: !canEdit });
  const keyIn = h("input", { type: "password", name: "app_key", autocomplete: "new-password", spellcheck: "false", disabled: !canEdit, placeholder: c.app_key?.set ? `已设置 ··${c.app_key.hint ?? ""}；留空 = 不改` : "粘贴 AppKey" });
  const keyClear = h("input", { type: "checkbox", disabled: !canEdit || !c.app_key?.set });
  const err = h("p", { class: "form-error", role: "alert" });
  const [txt, tone] = smsStatus(c);
  const form = h(
    "form",
    { class: "settings", novalidate: true },
    settingRow("状态", c.updated_at ? `最近由 ${isMe(c.updated_by) ? "我" : c.updated_by ?? "—"} 于 ${fmt.full(c.updated_at)} 修改` : null, h("span", { class: "status-line" }, h("span", { class: `dot tone-${tone}`, "aria-hidden": "true" }), txt), c.missing?.length ? h("small", { class: "muted" }, `真实发送还缺：${missingText(c.missing)}`) : null, f("enabled")),
    settingRow("凭据", "AppKey 只写不回显：保存后输入框清空，控制面只存密文与末 4 位。服务器出口 IP 若在赛邮云开了白名单须先加上。", h("div", { class: "inline-fields" }, f("provider"), f("app_id")), h("div", { class: "field" }, h("label", {}, "AppKey"), keyIn), h("label", { class: "field-check" }, keyClear, h("span", {}, "清除已存的 AppKey"))),
    settingRow("签名与模板", "模板项目编号在赛邮云控制台申请；注册与找回各用一套。", h("div", { class: "inline-fields" }, f("sign_name"), f("p_register"), f("p_reset"), f("p_login"))),
    settingRow("验证码", null, h("div", { class: "inline-fields" }, f("code_length"), f("ttl_minutes"), f("resend_seconds"), f("max_attempts"))),
    settingRow("限额", "防刷：超过即拒发（429）并记发送记录。", h("div", { class: "inline-fields" }, f("daily_limit_per_phone"), f("ip_hourly_limit"), f("daily_total_limit"))),
    c.dry_run_allowed ? settingRow("测试模式", "联调时不真发短信；生产部署不允许打开。", f("dry_run")) : null,
    err,
    h(
      "div",
      { class: "settings-foot" },
      btn("测试连接", async (ev) => {
        const b = ev.currentTarget;
        b.disabled = true;
        try {
          const r = await api.registration.testConnection();
          toast(`连接正常：余额 ${fmt.int(r.balance)} 条（事务类 ${fmt.int(r.transactional_balance)}）`);
        } catch (e) {
          toast(`${e.message}${e.provider_code ? `（赛邮云 ${e.provider_code}）` : ""}`, "error");
        } finally {
          b.disabled = !canEdit;
        }
      }, { disabled: !canEdit, title: canEdit ? "查赛邮云余额，不发短信" : needs("settings.manage") }),
      btn("发送测试短信…", async () => {
        const r = await confirmAction({ title: "发送测试短信", lead: h("p", {}, "按注册模板给这个号发一条随机码（不能用来注册）；受同号间隔与每日上限约束。危险操作：要求 10 分钟内复核过密码。"), fields: [{ name: "phone", label: "手机号", required: true, inputmode: "tel", maxlength: 20 }], confirmLabel: "发送", run: (v) => api.registration.testSend(v.phone) });
        if (r) toast(`已发送到 ${r.phone}`);
      }, { disabled: !canEdit, title: needs("settings.manage") }),
      h("span", { class: "spacer" }),
      h("button", { type: "submit", class: "btn primary", disabled: !canEdit, title: needs("settings.manage") }, "保存…"),
    ),
  );
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    err.textContent = "";
    const v = readForm(form, specs);
    const cur = { enabled: !!c.enabled, provider: c.provider ?? "submail", app_id: c.app_id ?? "", sign_name: c.sign_name ?? "", p_register: c.projects?.register ?? "", p_reset: c.projects?.reset ?? "", p_login: c.projects?.login ?? "", code_length: c.code_length, ttl_minutes: c.ttl_minutes, resend_seconds: c.resend_seconds, max_attempts: c.max_attempts, daily_limit_per_phone: c.daily_limit_per_phone, ip_hourly_limit: c.ip_hourly_limit, daily_total_limit: c.daily_total_limit, dry_run: !!c.dry_run };
    const body = {};
    for (const k of Object.keys(v)) {
      if (String(v[k] ?? "") === String(cur[k] ?? "")) continue;
      if (k.startsWith("p_")) (body.projects ??= {})[k.slice(2)] = v[k] || null;
      else body[k] = v[k] === "" ? null : v[k];
    }
    const plain = keyIn.value;
    if (plain) body.app_key = plain;
    else if (keyClear.checked) body.app_key = null;
    if (!Object.keys(body).length) return void (err.textContent = "没有改动");
    const ok = await confirmAction({
      title: "保存短信设置",
      danger: c.enabled && body.enabled === false,
      consequences: [
        body.enabled === false ? "停用后手机号注册与找回不可用；" : body.enabled === true ? "启用后律师端注册与找回可以收短信验证码；" : null,
        plain ? "AppKey 换成新的一把（只存密文与末 4 位）；" : body.app_key === null ? "清除已存的 AppKey；" : "AppKey 不改；",
        body.dry_run === true ? "打开测试模式：不真发短信，验证码随应答返回（只用于联调）；" : null,
        "这是危险操作：要求 10 分钟内复核过密码。",
      ].filter(Boolean),
      confirmLabel: "保存",
      run: () => {
        keyIn.value = "";
        return api.registration.saveSms(body);
      },
    });
    keyIn.value = "";
    if (ok) (toast(ok.changed?.length ? `已保存：${ok.changed.length} 项` : "已保存"), reload());
  });
  clear(box, c.dry_run_blocked ? h("div", { class: "banner warn" }, icon("alert"), h("span", {}, "状态里开着测试模式，但本部署不允许测试模式：按关闭处理。请关闭测试模式并配好真实通道。")) : null, panel(null, form));
}

function smsLogs(box) {
  const tools = h("div", { class: "toolbar" });
  const list = h("div");
  clear(box, h("div", { class: "stack" }, tools, list));
  const drawTools = () =>
    clear(
      tools,
      segmented([{ id: "", label: "全部用途" }, ...Object.entries(PURPOSE).map(([id, label]) => ({ id, label }))], sst.purpose, (v) => ((sst.purpose = v), drawTools(), reload()), "用途"),
      segmented([{ id: "", label: "全部结果" }, ...Object.entries(SEND_RESULT).map(([id, [label]]) => ({ id, label }))], sst.result, (v) => ((sst.result = v), drawTools(), reload()), "结果"),
    );
  const reload = () =>
    load(list, () => api.registration.smsLogs({ purpose: sst.purpose, result: sst.result, limit: 500 }), (d) =>
      list.append(
        panel(
          null,
          dataTable({
            state: { sort: "at", asc: false },
            rows: d.logs ?? [],
            empty: "没有发送记录",
            rowClass: (x) => (x.result === "failed" ? "danger-row" : ""),
            columns: [
              { key: "at", label: "时间", render: (x) => fmt.full(x.at) },
              { key: "purpose", label: "用途", value: (x) => PURPOSE[x.purpose] ?? x.purpose },
              { key: "phone", label: "手机号", render: (x) => mono(x.phone ?? "—") },
              { key: "result", label: "结果", render: (x) => badge(...(SEND_RESULT[x.result] ?? [x.result, "neutral"])) },
              { key: "code", label: "失败原因", render: (x) => (x.code ? h("span", {}, mono(x.code), x.provider_code ? h("span", { class: "muted" }, ` · 赛邮云 ${x.provider_code}`) : null) : "—") },
              { key: "by", label: "发起", render: (x) => (x.by ? (isMe(x.by) ? "我" : mono(x.by)) : h("span", { class: "muted" }, "律师端")) },
            ],
          }),
          { flush: true, sub: "最近 500 条；手机号打码，不含验证码" },
        ),
      ),
    "正在读取发送记录…");
  drawTools();
  reload();
}

function regAudit(box) {
  load(box, () => api.registration.audit({ limit: 500 }), (d) =>
    box.append(
      panel(
        null,
        dataTable({
          state: { sort: "at", asc: false },
          rows: d.entries ?? [],
          empty: "没有操作记录",
          columns: [
            { key: "at", label: "时间", render: (x) => fmt.full(x.at) },
            { key: "actor", label: "人员", render: (x) => (isMe(x.actor) ? badge("我", "accent") : mono(x.actor ?? "—")) },
            { key: "action", label: "动作", value: (x) => AUDIT_ACTION[x.action] ?? x.action },
            { key: "target", label: "对象", render: (x) => (x.target ? mono(x.target) : "—") },
            { key: "detail", label: "详情", class: "wrap", sortable: false, render: (x) => (x.detail && typeof x.detail === "object" ? h("span", { class: "muted small" }, Object.entries(x.detail).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ")) : "—") },
          ],
        }),
        { flush: true, sub: "注册策略、短信设置、邀请码的改动（最近 1000 条；不含验证码、AppKey 与完整手机号）" },
      ),
    ),
  "正在读取操作记录…");
}
