/**
 * 模型与路由：上游（地址、密钥尾号、健康、延迟、测试连接）、模型别名（目标与优先级、启停、默认）。
 * 第 62 批：价目按上游型号，在“模型与价目”（pages/pricing.js）里改；本页不再提供按别名改价的入口（旧接口 PUT /v1/ops/routing/prices 一律 409）；#/ops/routing?tab=prices 自动转过去。
 * 接口：GET /v1/ops/routing；写（route.manage）PUT/DELETE providers/{id}、POST providers/{id}/probe、PUT/DELETE models/{alias}（契约 §5）。
 *
 * 上游密钥：在本页用网关路由公钥加密成 key_sealed 再提交（seal-key.js，主文 §3.2），同时只提交“…”+ 末 4 位作 key_hint。
 * 第 46 批：公钥取自 GET /v1/ops/routing 的 routing_key {kid, spki_b64, fingerprint}（不再读静态 config.json，审计 cloud §9-5），
 * 页头显示本页按 SPKI 算出的指纹供与部署记录核对；控制面没给、导入失败或指纹不符时密钥输入禁用并说明原因。明文不出页面；提交后立即清空输入框。
 */
import * as api from "../api.js";
import { checkRoutingKey, fingerprintText, keyHint, sealUpstreamKey } from "../seal-key.js";
import { can, go, needs, pageHead, providerBadge } from "../domain.js";
import { badge, btn, clear, confirmAction, dataTable, facts, field, fmt, h, icon, load, metaLine, mono, note, openDrawer, panel, readForm, tabBar, toast } from "../ui.js";

const st = { tab: "providers", pTable: { sort: "id", asc: true }, mTable: { sort: "alias", asc: true } };
const BUILTIN = new Set(["legal/k3", "legal/k2.6"]);
const PROVIDER_RE = /^[a-z][a-z0-9-]{1,31}$/;
const ALIAS_RE = /^[a-z0-9][a-z0-9._/-]{1,47}$/;

/** 网关路由公钥：每次读到路由时按 routing_key 核对一次（编辑上游时用同一结果） */
let keyCheck = null;
const routingKeyStatus = () => keyCheck ?? Promise.resolve({ ok: false, reason: "还没读到路由：请刷新本页。" });

export function render(page, r) {
  if (r.params.tab === "providers" || r.params.tab === "models") st.tab = r.params.tab;
  const head = h("div");
  const box = h("div", { class: "stack" });
  page.append(head, box);
  const reload = () => load(box, () => api.get("/v1/ops/routing"), (d) => draw(head, box, d, reload), "正在读取路由…");
  clear(head, pageHead("模型与路由", "客户端只认别名（legal/k3 主任务、legal/k2.6 子任务）；这里改“别名 → 上游与型号”。改动经签名订阅约 15 秒下发到全部网关。"));
  reload();
}

function draw(head, box, d, reload) {
  keyCheck = checkRoutingKey(d.routing_key);
  const fp = h("span", {}, "路由公钥核对中…");
  const warn = h("div");
  keyCheck.then((ks) => {
    clear(fp, "路由公钥 ", mono(ks.kid ?? d.routing_key?.kid ?? d.routing_key_id ?? "未登记"), ks.fingerprint ? h("span", { title: ks.fingerprint }, `指纹 ${fingerprintText(ks.fingerprint)}`) : null, ks.ok ? badge("已核对", "ok", "本页按控制面给的公钥算出的 SHA-256 指纹；请与部署记录（cloud-init-secrets 输出）比对") : badge("未核对", "danger"));
    if (!ks.ok) clear(warn, h("div", { class: "banner danger" }, ks.reason));
  });
  clear(
    head,
    pageHead(
      "模型与路由",
      h("div", { class: "stack-sm" }, metaLine(`路由版本 v${d.version ?? "—"}`, `${fmt.full(d.updated_at)} 由 ${d.updated_by_label ?? d.updated_by ?? "—"} 更新`), h("div", { class: "meta-line" }, fp)),
      h("div", { class: "btn-row" }, can("route.read") ? btn("模型与价目", () => go("ops/pricing"), { icon: icon("tag") }) : null, btn("刷新健康", () => reload(), { icon: icon("refresh") })),
    ),
  );
  const tabs = h("div");
  const pane = h("div", { class: "stack" });
  const drawTabs = () => clear(tabs, tabBar([{ id: "providers", label: "上游", count: d.providers?.length }, { id: "models", label: "模型别名", count: d.models?.length }], st.tab, (id) => ((st.tab = id), drawTabs(), drawPane())));
  const drawPane = () => {
    clear(pane);
    if (st.tab === "models") paneModels(pane, d, reload);
    else paneProviders(pane, d, reload);
  };
  clear(box, warn, tabs, pane);
  drawTabs();
  drawPane();
}

// ─── 上游 ──────────────────────────────────────────────────────────
function paneProviders(pane, d, reload) {
  const used = new Map();
  for (const m of d.models ?? []) for (const t of m.targets ?? []) used.set(t.provider, [...(used.get(t.provider) ?? []), m.alias]);
  pane.append(
    h("div", { class: "toolbar" }, note("网关本机配置有上游主机白名单（routing.allow_hosts）：名单外的上游显示“不在网关白名单”，不会被使用。"), btn("新增上游", () => editProvider(null, d, reload), { kind: "primary", icon: icon("plus"), disabled: !can("route.manage"), title: needs("route.manage") })),
    dataTable({
      state: st.pTable,
      rows: d.providers ?? [],
      empty: "还没有上游：新增一个，再在“模型别名”里指向它",
      onRow: (p) => editProvider(p, d, reload),
      columns: [
        { key: "id", label: "上游", render: (p) => h("div", { class: "cell-2" }, h("b", {}, p.label ?? p.id), mono(p.id)) },
        { key: "vendor", label: "厂商", class: "opt", render: (p) => mono(p.vendor ?? "—") },
        { key: "base_url", label: "地址", class: "trunc", render: (p) => mono(p.base_url, p.base_url) },
        { key: "key_hint", label: "密钥", value: (p) => (p.key_set ? 1 : 0), render: (p) => (p.key_set ? h("span", { class: "cell-2" }, mono(p.key_hint ?? "已设"), h("small", {}, fmt.date(p.key_set_at))) : p.use_local_key ? badge("网关本机密钥", "info", "没有经控制台下发密钥：网关用本机配置的上游密钥") : badge("未设密钥", "warn")) },
        { key: "state", label: "健康", value: (p) => p.health?.state ?? "", render: (p) => h("div", { class: "cell-2" }, providerBadge(p.health, p.enabled), p.health?.last_error ? h("small", { class: "tone-text-danger", title: p.health.last_error }, p.health.last_error) : p.health ? h("small", {}, `${p.health.holder ?? ""} · ${fmt.ago(p.health.updated_at)}`) : null) },
        { key: "latency", label: "延迟", num: true, class: "opt", value: (p) => p.health?.latency_ms ?? null, render: (p) => fmt.ms(p.health?.latency_ms) },
        { key: "fails", label: "连续失败", num: true, class: "opt", value: (p) => p.health?.consecutive_failures ?? null, render: (p) => fmt.int(p.health?.consecutive_failures) },
        { key: "max_concurrency", label: "并发上限", num: true, class: "opt", render: (p) => fmt.int(p.max_concurrency) },
        { key: "used_by", label: "被引用", sortable: false, class: "opt wrap-sm", render: (p) => ((used.get(p.id) ?? []).length ? h("span", { class: "badges" }, used.get(p.id).map((a) => mono(a))) : h("span", { class: "muted" }, "无")) },
        {
          key: "_act",
          label: "",
          sortable: false,
          class: "act",
          render: (p) =>
            h(
              "div",
              { class: "btn-row nowrap" },
              btn("测试连接", async (ev) => {
                const b = ev.currentTarget;
                b.disabled = true;
                try {
                  const r = await api.post(`/v1/ops/routing/providers/${api.seg(p.id)}/probe`);
                  toast(`已请求探测（${fmt.time(r.probe_requested_at)}）：网关下一轮（约 15 秒）立即探测，稍后刷新看结果`, "info");
                } catch (e) {
                  toast(e.message, "error");
                } finally {
                  b.disabled = false;
                }
              }, { size: "sm", disabled: !can("route.manage"), title: needs("route.manage") }),
              btn("删除", async () => {
                const refs = used.get(p.id) ?? [];
                if (refs.length) return void toast(`还有模型别名在用这个上游（${refs.join("、")}）：先改别名的目标`, "error");
                const ok = await confirmAction({
                  title: `删除上游 ${p.id}`,
                  danger: true,
                  consequences: ["从路由表删除该上游与它的密文；约 15 秒后全部网关不再认它；", "不可撤销：恢复须重新登记并重新输入密钥。"],
                  typeToConfirm: p.id,
                  typeLabel: "再输入一次上游编号以确认：",
                  confirmLabel: "删除上游",
                  run: () => api.del(`/v1/ops/routing/providers/${api.seg(p.id)}`),
                });
                if (ok) (toast("已删除上游"), reload());
              }, { size: "sm", kind: "danger", disabled: !can("route.manage"), title: needs("route.manage") }),
            ),
        },
      ],
    }),
  );
}

async function editProvider(p, d, reload) {
  const isNew = !p;
  const ks = await routingKeyStatus();
  const specs = [
    { name: "id", label: "上游编号", value: p?.id ?? "", required: true, disabled: !isNew, placeholder: "csi-maas", hint: "小写字母开头，字母、数字、连字符，2–32 位；建好后不可改（密钥按编号绑定）" },
    { name: "label", label: "显示名", value: p?.label ?? "", required: true, maxlength: 40 },
    { name: "vendor", label: "厂商", value: p?.vendor ?? "", required: true, placeholder: "csi-maas", hint: "同一厂商的上游之间可互相切换；跨厂商要在别名上单独允许" },
    { name: "base_url", label: "地址", value: p?.base_url ?? "", required: true, placeholder: "https://maas.example.com/v1", hint: "https，不带用户名与密码；主机须在网关的 allow_hosts 白名单里" },
    { name: "max_concurrency", label: "每网关实例并发上限", type: "number", min: 1, max: 4096, value: p?.max_concurrency ?? 64 },
    { name: "header_timeout_ms", label: "首包超时（毫秒）", type: "number", min: 1000, max: 600000, value: p?.header_timeout_ms ?? "", hint: "空 = 网关缺省" },
    { name: "idle_timeout_ms", label: "流式空闲超时（毫秒）", type: "number", min: 1000, max: 600000, value: p?.idle_timeout_ms ?? "", hint: "空 = 网关缺省" },
    { name: "enabled", label: "启用", type: "checkbox", value: p ? p.enabled !== false : true },
  ];
  const keyInput = h("input", { type: "password", name: "upstream_key", autocomplete: "new-password", spellcheck: "false", disabled: !ks.ok || !can("route.manage"), placeholder: ks.ok ? (p?.key_set ? `已设 ${p.key_hint ?? ""}；留空 = 不改` : p?.use_local_key ? "当前用网关本机密钥；填写即改为下发的密钥" : "粘贴上游 API 密钥") : "不可用" });
  const err = h("p", { class: "form-error", role: "alert" });
  const submit = h("button", { type: "submit", class: "btn primary", disabled: !can("route.manage"), title: needs("route.manage") }, isNew ? "登记上游" : "保存");
  const form = h(
    "form",
    { class: "drawer-form", novalidate: true },
    specs.map(field),
    h(
      "div",
      { class: "field key-field" },
      h("label", {}, "上游密钥"),
      keyInput,
      ks.ok
        ? h("small", { class: "hint" }, `提交前在本页用网关路由公钥（${ks.kid}，指纹 ${fingerprintText(ks.fingerprint)}）加密，控制面只存密文与尾号，看不到明文；提交后输入框立即清空。`)
        : h("div", { class: "banner warn" }, ks.reason),
    ),
    p?.health ? panel("健康", facts([["状态", providerBadge(p.health, p.enabled)], ["延迟", fmt.ms(p.health.latency_ms)], ["最近成功", fmt.full(p.health.last_ok_at)], ["连续失败", fmt.int(p.health.consecutive_failures)], ["最近错误", p.health.last_error ?? "—"], ["最近探测", fmt.full(p.health.probed_at)], ["回报网关", p.health.holder ?? "—"], ["待探测", p.probe_requested_at ? fmt.full(p.probe_requested_at) : "—"]])) : null,
    err,
    h("div", { class: "drawer-foot" }, h("button", { type: "button", class: "btn", onclick: () => dr.close() }, "取消"), submit),
  );
  const dr = openDrawer({ title: isNew ? "新增上游" : `上游 ${p.label ?? p.id}`, subtitle: isNew ? "登记后在“模型别名”里把别名指向它" : mono(p.id), body: form, onClose: () => (keyInput.value = "") });
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    err.textContent = "";
    const v = readForm(form, specs);
    const id = isNew ? v.id : p.id;
    if (!PROVIDER_RE.test(id)) return void (err.textContent = "上游编号须为小写字母开头的 2–32 位字母、数字、连字符");
    let u;
    try {
      u = new URL(v.base_url);
    } catch {
      return void (err.textContent = "地址不是合法网址");
    }
    if (u.protocol !== "https:" || u.username || u.password) return void (err.textContent = "地址须为 https，且不带用户名与密码");
    if (!v.label || !v.vendor) return void (err.textContent = "显示名与厂商必填");
    const plain = keyInput.value;
    if (isNew && !plain && ks.ok) return void (err.textContent = "新上游要输入密钥");
    const body = { label: v.label, vendor: v.vendor, base_url: v.base_url.replace(/\/+$/, ""), enabled: v.enabled, max_concurrency: v.max_concurrency ?? undefined, header_timeout_ms: v.header_timeout_ms ?? undefined, idle_timeout_ms: v.idle_timeout_ms ?? undefined };
    const routeChange = !isNew && (p.base_url !== body.base_url || (p.enabled !== false) !== body.enabled || p.vendor !== body.vendor);
    const refs = (d.models ?? []).filter((m) => (m.targets ?? []).some((t) => t.provider === id)).map((m) => m.alias);
    const conseq = [
      isNew ? "登记后约 15 秒下发到全部网关；没有别名指向它之前不承接流量。" : "保存后约 15 秒下发到全部网关。",
      routeChange && refs.length ? `正在用它的别名（${refs.join("、")}）的流量将按新设置转发${body.enabled ? "" : "；停用后这些别名改走其余目标，没有其余目标的别名将不可用"}。` : null,
      plain ? `密钥换成尾号 ${keyHint(plain)} 的这一把（旧密钥作废）。` : isNew ? null : "密钥不改。",
    ].filter(Boolean);
    const ok = await confirmAction({
      title: isNew ? `登记上游 ${id}` : `保存上游 ${id}`,
      danger: routeChange && refs.length > 0,
      consequences: conseq,
      typeToConfirm: routeChange && refs.length > 0 ? id : undefined,
      confirmLabel: isNew ? "登记" : "保存",
      run: async () => {
        const payload = { ...body };
        if (plain) {
          payload.key_sealed = await sealUpstreamKey({ publicKey: ks.key, kid: ks.kid, providerId: id, plaintext: plain });
          payload.key_hint = keyHint(plain);
        }
        keyInput.value = "";
        return api.put(`/v1/ops/routing/providers/${api.seg(id)}`, payload);
      },
    });
    keyInput.value = "";
    if (ok) {
      toast(isNew ? "已登记上游" : "已保存上游");
      dr.close();
      reload();
    }
  });
}

// ─── 模型别名 ──────────────────────────────────────────────────────
function paneModels(pane, d, reload) {
  const pmap = Object.fromEntries((d.providers ?? []).map((p) => [p.id, p]));
  pane.append(
    h("div", { class: "toolbar" }, note("同一别名的目标按优先级（小者先）；只在还没给客户端写出任何字节之前切换（连接失败、5xx、429、首包超时），至多 3 次；4xx 不切换。"), btn("新增别名", () => editModel(null, d, reload), { kind: "primary", icon: icon("plus"), disabled: !can("route.manage"), title: needs("route.manage") })),
    dataTable({
      state: st.mTable,
      rows: d.models ?? [],
      empty: "还没有模型别名",
      onRow: (m) => editModel(m, d, reload),
      columns: [
        { key: "alias", label: "别名", render: (m) => h("div", { class: "cell-2" }, mono(m.alias), h("small", {}, m.label ?? "")) },
        { key: "enabled", label: "状态", value: (m) => (m.enabled ? 1 : 0), render: (m) => h("span", { class: "badges" }, m.enabled ? badge("启用", "ok") : badge("停用", "neutral"), m.is_default ? badge("默认", "accent") : null, m.builtin || BUILTIN.has(m.alias) ? badge("内置", "info", "客户端写死的别名，不可删") : null) },
        {
          key: "targets",
          label: "目标（按优先级）",
          sortable: false,
          render: (m) =>
            h(
              "ol",
              { class: "targets" },
              [...(m.targets ?? [])].sort((a, b) => a.priority - b.priority).map((t) => h("li", {}, h("span", { class: "prio num" }, String(t.priority)), mono(t.provider), h("span", { class: "muted" }, " → "), mono(t.model), pmap[t.provider] ? providerBadge(pmap[t.provider].health, pmap[t.provider].enabled) : badge("上游不存在", "danger"))),
            ),
        },
        // 第 66 批：客户端模型目录——在哪些入口可选、是否给客户端看（律师端按套餐与路由动态拉取，不需重新封装）
        { key: "scopes", label: "客户端入口", sortable: false, class: "opt", render: (m) => (m.client_visible === false ? h("span", { class: "muted" }, "不给客户端") : h("span", { class: "badges" }, (m.scopes ?? []).includes("qa") ? badge("问答", "info") : null, (m.scopes ?? []).includes("task") ? badge("任务", "info") : null, !(m.scopes ?? []).length ? h("span", { class: "muted" }, "无") : null)) },
        { key: "sort", label: "排序", num: true, class: "opt", render: (m) => fmt.int(m.sort ?? 100) },
        { key: "allow_cross_vendor", label: "跨厂商切换", value: (m) => (m.allow_cross_vendor ? 1 : 0), render: (m) => (m.allow_cross_vendor ? badge("允许", "warn") : h("span", { class: "muted" }, "不允许")) },
        { key: "default_max_tokens", label: "缺省 max_tokens", num: true, render: (m) => fmt.int(m.default_max_tokens) },
      ],
    }),
  );
}

function editModel(m, d, reload) {
  const isNew = !m;
  const providers = (d.providers ?? []).map((p) => [p.id, `${p.label ?? p.id}（${p.vendor ?? ""}）`]);
  const specs = [
    { name: "alias", label: "别名", value: m?.alias ?? "", required: true, disabled: !isNew, placeholder: "legal/k3-fast", hint: "小写字母数字开头，可含 . _ / -，2–48 位；建好后不可改名" },
    { name: "label", label: "显示名", value: m?.label ?? "", required: true, maxlength: 40 },
    { name: "enabled", label: "启用", type: "checkbox", value: m ? !!m.enabled : true },
    { name: "is_default", label: "设为默认别名", type: "checkbox", value: !!m?.is_default, hint: "至多一个；客户端未指定别名时用它" },
    { name: "allow_cross_vendor", label: "允许跨厂商切换", type: "checkbox", value: !!m?.allow_cross_vendor, hint: "关：只在同厂商的目标之间切换" },
    { name: "default_max_tokens", label: "缺省 max_tokens（256–262144）", type: "number", min: 256, max: 262_144, value: m?.default_max_tokens ?? 8192 },
  ];
  // 第 66 批：客户端模型目录的展示与能力（律师端选择器显示；上游目标、型号与密钥不下发给客户端）
  const has = (k, x) => (m?.[k] ?? []).includes(x);
  const metaSpecs = [
    { name: "description", label: "说明（给律师看，≤ 60 字）", value: m?.description ?? "", maxlength: 60, placeholder: "适合复杂问题" },
    { name: "sort", label: "排序（小者在前，0–9999）", type: "number", min: 0, max: 9999, value: m?.sort ?? 100 },
    { name: "thinking", label: "深度思考的控制方式", type: "select", value: m?.thinking ?? "none", options: [["effort", "调强度（K3 系列：始终思考，reasoning_effort）"], ["toggle", "开 / 关（K2.6：thinking.type）"], ["none", "不可控（不发思考参数）"]] },
    { name: "eff_low", label: "档位 low", type: "checkbox", value: isNew ? false : has("efforts", "low"), hint: "只对“调强度”的模型有效" },
    { name: "eff_high", label: "档位 high", type: "checkbox", value: isNew ? false : has("efforts", "high") },
    { name: "eff_max", label: "档位 max", type: "checkbox", value: isNew ? false : has("efforts", "max") },
    { name: "cap_tool_use", label: "能力：工具调用（tool_use）", type: "checkbox", value: isNew ? true : has("capabilities", "tool_use"), hint: "任务入口要求有这项" },
    { name: "cap_thinking", label: "能力：深度思考（thinking）", type: "checkbox", value: isNew ? false : has("capabilities", "thinking") },
    { name: "cap_long_context", label: "能力：长上下文（long_context）", type: "checkbox", value: isNew ? false : has("capabilities", "long_context") },
    { name: "scope_qa", label: "可在问答里选", type: "checkbox", value: isNew ? true : has("scopes", "qa") },
    { name: "scope_task", label: "可在任务里选", type: "checkbox", value: isNew ? false : has("scopes", "task"), hint: "任务的子 Agent 另有规则，不经这里" },
    { name: "client_visible", label: "对客户端可见", type: "checkbox", value: m ? m.client_visible !== false : true, hint: "关：只作内部别名，不出现在律师端选择器" },
    { name: "max_context", label: "上下文窗口（token，空 = 缺省 262144）", type: "number", min: 8192, max: 2_000_000, value: m?.max_context ?? "" },
  ];
  let targets = (m?.targets ?? []).map((t) => ({ ...t }));
  if (!targets.length) targets = [{ provider: providers[0]?.[0] ?? "", model: "", priority: 1 }];
  const tBox = h("div", { class: "targets-edit" });
  const drawTargets = () =>
    clear(
      tBox,
      targets.map((t, i) =>
        h(
          "div",
          { class: "target-row" },
          h("input", { type: "number", class: "prio-input", min: 1, max: 99, value: t.priority, "aria-label": "优先级", oninput: (e) => (t.priority = Number(e.target.value)) }),
          h("select", { "aria-label": "上游", onchange: (e) => (t.provider = e.target.value) }, providers.map(([v, l]) => h("option", { value: v, selected: v === t.provider }, l))),
          h("input", { type: "text", value: t.model, placeholder: "上游型号，如 kimi-k3.1-pro", "aria-label": "上游型号", spellcheck: "false", oninput: (e) => (t.model = e.target.value.trim()) }),
          h("button", { type: "button", class: "icon-btn", "aria-label": "删掉这个目标", disabled: targets.length <= 1, onclick: () => (targets.splice(i, 1), drawTargets()) }, icon("close")),
        ),
      ),
      targets.length < 4 ? btn("加一个目标", () => (targets.push({ provider: providers[0]?.[0] ?? "", model: "", priority: Math.max(0, ...targets.map((x) => x.priority || 0)) + 1 }), drawTargets()), { size: "sm", icon: icon("plus") }) : h("small", { class: "muted" }, "至多 4 个目标"),
    );
  drawTargets();
  const err = h("p", { class: "form-error", role: "alert" });
  const builtin = m && (m.builtin || BUILTIN.has(m.alias));
  const form = h(
    "form",
    { class: "drawer-form", novalidate: true },
    specs.map(field),
    h("div", { class: "field" }, h("label", {}, "目标（优先级小者先）"), providers.length ? tBox : h("div", { class: "banner warn" }, "还没有上游：先在“上游”里登记。")),
    h("div", { class: "field" }, h("label", {}, "律师端显示与能力"), note("律师端按套餐与这里的设置动态拉取可选模型（约 10 分钟内或下次登录生效，不需重新封装客户端）；不下发上游、型号与密钥。")),
    metaSpecs.map(field),
    err,
    h(
      "div",
      { class: "drawer-foot" },
      !isNew && !builtin
        ? btn("删除别名", async () => {
            const ok = await confirmAction({ title: `删除别名 ${m.alias}`, danger: true, consequences: ["约 15 秒后全部网关不再认这个别名：用它的请求返回“模型不可用”；", "历史账本行保留。"], typeToConfirm: m.alias, typeLabel: "再输入一次别名以确认：", confirmLabel: "删除别名", run: () => api.del(`/v1/ops/routing/models/${encodeURIComponent(m.alias)}`) });
            if (ok) (toast("已删除别名"), dr.close(), reload());
          }, { kind: "danger", disabled: !can("route.manage"), title: needs("route.manage") })
        : h("span"),
      h("span", { class: "spacer" }),
      h("button", { type: "button", class: "btn", onclick: () => dr.close() }, "取消"),
      h("button", { type: "submit", class: "btn primary", disabled: !can("route.manage") || !providers.length, title: needs("route.manage") }, isNew ? "新增别名" : "保存路由"),
    ),
  );
  const dr = openDrawer({ title: isNew ? "新增模型别名" : `别名 ${m.alias}`, subtitle: builtin ? "内置别名：旧客户端写死，不可改名、不可删；可改它指向的上游与型号、律师端显示与能力" : null, body: form });
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    err.textContent = "";
    const v = readForm(form, specs);
    const mv = readForm(form, metaSpecs);
    const meta = {
      description: (mv.description ?? "").trim() || null,
      sort: mv.sort ?? 100,
      thinking: mv.thinking || "none",
      efforts: mv.thinking === "effort" ? ["low", "high", "max"].filter((x) => mv[`eff_${x}`]) : [],
      capabilities: ["tool_use", "thinking", "long_context"].filter((x) => mv[`cap_${x}`]),
      scopes: ["qa", "task"].filter((x) => mv[`scope_${x}`]),
      client_visible: !!mv.client_visible,
      max_context: mv.max_context ?? null,
    };
    if (meta.scopes.includes("task") && !meta.capabilities.includes("tool_use")) return void (err.textContent = "任务入口要求模型支持工具调用：勾选“能力：工具调用”，或取消“可在任务里选”");
    const alias = isNew ? v.alias : m.alias;
    if (!ALIAS_RE.test(alias)) return void (err.textContent = "别名须为小写字母数字开头、可含 . _ / - 的 2–48 位");
    const ts = targets.map((t) => ({ provider: t.provider, model: t.model, priority: Number(t.priority) }));
    if (!ts.length || ts.length > 4) return void (err.textContent = "目标须 1–4 个");
    if (ts.some((t) => !t.provider || !t.model || !(t.priority >= 1))) return void (err.textContent = "每个目标都要选上游、填型号、优先级 ≥ 1");
    const vendors = new Set(ts.map((t) => d.providers?.find((p) => p.id === t.provider)?.vendor));
    if (vendors.size > 1 && !v.allow_cross_vendor) return void (err.textContent = "目标跨了厂商：勾选“允许跨厂商切换”，或只留同厂商的目标");
    const before = (m?.targets ?? []).map((t) => `${t.priority}. ${t.provider} → ${t.model}`).join("；") || "无";
    const after = [...ts].sort((a, b) => a.priority - b.priority).map((t) => `${t.priority}. ${t.provider} → ${t.model}`).join("；");
    const ok = await confirmAction({
      title: isNew ? `新增别名 ${alias}` : `改路由：${alias}`,
      danger: !isNew,
      lead: isNew ? null : h("div", { class: "diff" }, h("div", {}, h("b", {}, "原来："), before), h("div", {}, h("b", {}, "改为："), after)),
      consequences: [
        "约 15 秒内全部网关按新路由转发这个别名的请求（进行中的请求不受影响）；",
        v.enabled ? null : "停用后用这个别名的请求返回“模型不可用”；",
        v.is_default && !m?.is_default ? "设为默认后，原来的默认别名自动取消默认；" : null,
        "计价按实际服务的上游型号：别名改指别的型号（如 highspeed），售价与成本跟着型号走（见“模型与价目”；目标型号未定价时金额额度的律所会被拒）。",
      ].filter(Boolean),
      typeToConfirm: !isNew && builtin ? alias : undefined,
      confirmLabel: isNew ? "新增" : "保存路由",
      run: () => api.put(`/v1/ops/routing/models/${encodeURIComponent(alias)}`, { label: v.label, enabled: v.enabled, is_default: v.is_default, targets: ts, allow_cross_vendor: v.allow_cross_vendor, default_max_tokens: v.default_max_tokens ?? 8192, ...meta }),
    });
    if (ok) {
      toast(isNew ? "已新增别名" : "已保存路由");
      dr.close();
      reload();
    }
  });
}
