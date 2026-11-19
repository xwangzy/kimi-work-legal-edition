/**
 * 平台运营 · 人员与权限（staff.manage，系统管理员）：中软平台人员、角色、状态、两步验证、最近登录；
 * 新建人员（得一次性设置码）、改角色、停用 / 启用、重置（发新设置码，可同时清除两步验证）。
 * 规则（契约 §2.2）：一人 1–3 个角色；客户运营与开通专员互斥；至少保留一名有效系统管理员；不能停用自己、不能去掉自己的系统管理员。
 * 写操作是危险操作：控制面要求 10 分钟内复核过（401 reauth_required → 复核框 → 自动重试）。
 * 接口：GET /v1/ops/staff、GET /v1/ops/roles、POST /v1/ops/staff、POST /v1/ops/staff/{aid}/roles|disable|enable|reset。
 */
import * as api from "../api.js";
import { isMe, pageHead, PERM_LABEL, PLATFORM_ROLES } from "../domain.js";
import { badge, btn, clear, confirmAction, dataTable, facts, fmt, h, icon, load, matches, mono, openDrawer, panel, readForm, searchInput, showSecret, toast } from "../ui.js";

const st = { q: "", table: { sort: "name", asc: true }, roles: PLATFORM_ROLES };
const S = (aid) => `/v1/ops/staff/${api.seg(aid)}`;
const STATUS = { active: ["正常", "ok"], disabled: ["已停用", "danger"], pending: ["待设置密码", "info"] };

/** 角色组合校验（与控制面同一规则；以控制面结果为准） */
export function rolesProblem(roles, { self = false, wasSysadmin = false, activeSysadmins = 2 } = {}) {
  if (!roles.length) return "至少选一个角色";
  if (roles.length > 3) return "一人至多 3 个角色";
  if (roles.includes("operator") && roles.includes("issuer")) return "客户运营与开通专员不能由同一人兼任（职责分离）";
  if (self && wasSysadmin && !roles.includes("sysadmin")) return "不能去掉自己的系统管理员角色";
  if (wasSysadmin && !roles.includes("sysadmin") && activeSysadmins <= 1) return "至少保留一名有效的系统管理员";
  return null;
}
const roleBadges = (ids) => h("span", { class: "badges" }, (ids ?? []).map((r) => badge(st.roles.find((x) => x.id === r)?.label ?? r, r === "sysadmin" ? "accent" : "neutral")));

export function render(page) {
  const box = h("div", { class: "stack" });
  const tools = h("div", { class: "toolbar" });
  let rows = [];
  const reload = () =>
    load(box, async () => {
      const [s, r] = await Promise.allSettled([api.get("/v1/ops/staff"), api.get("/v1/ops/roles")]);
      if (s.status === "rejected") throw s.reason;
      if (r.status === "fulfilled") {
        const list = Array.isArray(r.value) ? r.value : r.value.roles;
        if (Array.isArray(list) && list.length) st.roles = list.map((x) => ({ ...PLATFORM_ROLES.find((p) => p.id === x.id), ...x }));
      }
      return Array.isArray(s.value) ? s.value : s.value.staff ?? [];
    }, (list) => ((rows = list), draw()), "正在读取人员…");
  const activeSysadmins = () => rows.filter((x) => x.status === "active" && (x.roles ?? []).includes("sysadmin")).length;
  const draw = () => {
    const list = rows.filter((x) => matches(st.q, x.name, x.email, ...(x.roles ?? [])));
    clear(
      box,
      dataTable({
        rows: list,
        state: st.table,
        onRow: (x) => openStaff(x, { reload, activeSysadmins: activeSysadmins() }),
        empty: rows.length ? "没有符合条件的人员" : "还没有平台人员",
        rowClass: (x) => (x.status === "disabled" ? "dim" : ""),
        columns: [
          { key: "name", label: "人员", render: (x) => h("div", { class: "cell-2" }, h("b", {}, x.name ?? "—", isMe(x.aid) ? badge("我", "accent") : null), h("small", {}, x.email)) },
          { key: "roles", label: "角色", sortable: false, render: (x) => roleBadges(x.roles) },
          { key: "status", label: "状态", render: (x) => badge(...(STATUS[x.status] ?? [x.status ?? "—", "neutral"])) },
          { key: "mfa", label: "两步验证", value: (x) => (x.mfa?.enabled ? 1 : 0), render: (x) => (x.mfa?.enabled ? badge("已启用", "ok") : badge("未启用", "warn")) },
          { key: "last_login_at", label: "最近登录", value: (x) => x.last_login_at ?? "", render: (x) => h("span", { title: fmt.full(x.last_login_at) }, fmt.ago(x.last_login_at)) },
          { key: "created_at", label: "添加于", render: (x) => fmt.date(x.created_at) },
        ],
      }),
      panel("角色说明", h("div", { class: "role-grid" }, st.roles.map((r) => h("div", { class: "role-card" }, h("b", {}, r.label ?? r.id), h("p", {}, r.note ?? r.description ?? ""), h("div", { class: "badges wrap" }, (r.perms ?? []).map((p) => h("span", { class: "perm", title: p }, PERM_LABEL[p] ?? p)))))), { sub: "一人 1–3 个角色；客户运营与开通专员互斥" }),
    );
  };
  page.append(pageHead("人员与权限", "中软平台人员都用邮箱 + 密码 + 两步验证登录；平台运营接口只对运维网段开放", btn("添加人员", () => createStaff(reload), { kind: "primary", icon: icon("plus") })), tools, box);
  tools.append(searchInput({ placeholder: "姓名、邮箱、角色", value: st.q, onInput: (v) => ((st.q = v), draw()) }));
  reload();
}

function roleChecks(selected) {
  return h(
    "fieldset",
    { class: "field role-checks" },
    h("legend", {}, "角色（1–3 个）"),
    st.roles.map((r) => h("label", { class: "radio" }, h("input", { type: "checkbox", name: "role", value: r.id, checked: selected.includes(r.id) }), h("span", {}, r.label ?? r.id, h("small", {}, r.note ?? r.description ?? "")))),
  );
}
const checkedRoles = (form) => [...form.querySelectorAll('input[name="role"]:checked')].map((i) => i.value);

async function createStaff(reload) {
  const specs = [
    { name: "email", label: "邮箱", type: "email", required: true, placeholder: "name@chinasoft.example" },
    { name: "name", label: "姓名", required: true, maxlength: 40 },
  ];
  const err = h("p", { class: "form-error", role: "alert" });
  const submit = h("button", { type: "submit", class: "btn primary" }, "添加并生成设置码");
  const form = h("form", { class: "drawer-form", novalidate: true }, specs.map((f) => h("div", { class: "field" }, h("label", { for: `st-${f.name}` }, f.label), h("input", { id: `st-${f.name}`, name: f.name, type: f.type ?? "text", maxlength: f.maxlength, placeholder: f.placeholder, autocomplete: "off", spellcheck: "false" }))), roleChecks(["viewer"]), h("p", { class: "muted small" }, "添加后得到一次性设置码（24 小时内有效）：本人在登录页“首次设置密码”里用它设密码，登录后须绑定两步验证。"), err, h("div", { class: "drawer-foot" }, h("button", { type: "button", class: "btn", onclick: () => dr.close() }, "取消"), submit));
  const dr = openDrawer({ title: "添加平台人员", body: form });
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    err.textContent = "";
    const v = readForm(form, specs);
    const roles = checkedRoles(form);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) return void (err.textContent = "请输入邮箱");
    if (!v.name) return void (err.textContent = "请填写姓名");
    const bad = rolesProblem(roles);
    if (bad) return void (err.textContent = bad);
    submit.disabled = true;
    try {
      const r = await api.post("/v1/ops/staff", { email: v.email, name: v.name, roles });
      dr.close();
      await showSecret({ title: `${v.name} 的设置码`, secret: r.setup_code, expiresAt: r.expires_at, note: "请经安全渠道交给本人：在控制台登录页点“首次设置密码 / 我有设置码”使用。" });
      toast("已添加");
      reload();
    } catch (e) {
      err.textContent = e.message;
    } finally {
      submit.disabled = false;
    }
  });
}

function openStaff(x, { reload, activeSysadmins }) {
  const self = isMe(x.aid);
  const wasSysadmin = (x.roles ?? []).includes("sysadmin");
  const after = (msg) => (toast(msg), dr.close(), reload());
  const editRoles = async () => {
    const box = roleChecks(x.roles ?? []);
    const err = h("p", { class: "form-error", role: "alert" });
    const r = await confirmAction({
      title: `改角色：${x.name ?? x.email}`,
      lead: h("div", {}, box, err),
      consequences: ["保存后立即生效：此人下一次请求起按新角色授权；", "去掉的权限对应的页面将不再出现。"],
      confirmLabel: "保存角色",
      validate: () => rolesProblem(checkedRoles(box.closest("form")), { self, wasSysadmin, activeSysadmins }),
      run: () => api.post(`${S(x.aid)}/roles`, { roles: checkedRoles(box.closest("form")) }),
    });
    if (r) after("已更新角色");
  };
  const disable = async () => {
    const r = await confirmAction({
      title: `停用 ${x.name ?? x.email}`,
      danger: true,
      consequences: ["此人的全部登录立即退出，不能再登录控制台；", "操作记录保留；可随时启用恢复。"],
      typeToConfirm: x.email,
      typeLabel: "再输入一次邮箱以确认：",
      confirmLabel: "停用",
      run: () => api.post(`${S(x.aid)}/disable`),
    });
    if (r) after("已停用");
  };
  const enable = async () => {
    const r = await confirmAction({ title: `启用 ${x.name ?? x.email}`, consequences: ["恢复登录（按现有角色授权）。"], confirmLabel: "启用", run: () => api.post(`${S(x.aid)}/enable`) });
    if (r) after("已启用");
  };
  const reset = async () => {
    const r = await confirmAction({
      title: `重置 ${x.name ?? x.email}`,
      danger: true,
      fields: [{ name: "reset_mfa", label: "同时清除两步验证（手机丢失时勾选；本人须重新绑定）", type: "checkbox", value: false }],
      consequences: ["生成新的一次性设置码（只显示一次，24 小时内有效），旧密码作废；", "此人的全部登录立即退出。"],
      confirmLabel: "重置并生成设置码",
      run: (v) => api.post(`${S(x.aid)}/reset`, { reset_mfa: !!v.reset_mfa }),
    });
    if (r?.setup_code) await showSecret({ title: `${x.name ?? x.email} 的新设置码`, secret: r.setup_code, expiresAt: r.expires_at, note: "请经安全渠道交给本人：在登录页“首次设置密码 / 我有设置码”里使用。" });
    if (r) (dr.close(), reload());
  };
  const lastSys = wasSysadmin && activeSysadmins <= 1 && x.status === "active";
  const dr = openDrawer({
    title: x.name ?? x.email,
    subtitle: h("span", { class: "sub-row" }, x.email, badge(...(STATUS[x.status] ?? [x.status ?? "—", "neutral"]))),
    body: h(
      "div",
      { class: "stack" },
      h(
        "div",
        { class: "btn-row" },
        btn("改角色", editRoles, { size: "sm" }),
        x.status === "disabled" ? btn("启用", enable, { size: "sm" }) : btn("停用", disable, { size: "sm", kind: "danger", disabled: self || lastSys, title: self ? "不能停用自己" : lastSys ? "至少保留一名有效的系统管理员" : undefined }),
        btn("重置密码与设置码", reset, { size: "sm", disabled: self, title: self ? "改自己的密码请到“账号与安全”" : undefined }),
      ),
      panel(
        "人员",
        facts([
          ["编号", mono(x.aid)],
          ["角色", roleBadges(x.roles)],
          ["两步验证", x.mfa?.enabled ? `已启用（剩余恢复码 ${fmt.int(x.mfa.recovery_left)} 个）` : "未启用"],
          ["添加于", `${fmt.full(x.created_at)}${x.created_by ? `（${x.created_by}）` : ""}`],
          ["最近登录", fmt.full(x.last_login_at)],
          x.disabled_reason ? ["停用原因", x.disabled_reason] : null,
        ]),
      ),
    ),
  });
}
