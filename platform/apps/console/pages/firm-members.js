/**
 * 本所 · 成员：账号、角色、状态、最近登录、电脑、本期用量；admin 可停用 / 启用 / 下线 / 发重置码 / 设电脑数与个人上限，partner 只读。
 * 待批准的入组申请只读（批准在管理员电脑上完成）。
 * 接口：GET /v1/firm/members；POST /v1/firm/members/{aid}/disable|enable|sessions/revoke|reset-code|limits（契约 §3.3）。
 */
import * as api from "../api.js";
import { accountBadge, CREATED_VIA, ctx, isMe, pageHead, roleText } from "../domain.js";
import { readOnly } from "./firm-overview.js";
import { badge, btn, clear, confirmAction, dataTable, emptyBlock, facts, fmt, h, load, matches, mono, openDrawer, panel, searchInput, showSecret, toast } from "../ui.js";

const st = { q: "", table: { sort: "name", asc: true } };

export function render(page) {
  const tools = h("div", { class: "toolbar" });
  const box = h("div", { class: "stack" });
  page.append(pageHead("成员", readOnly() ? "合伙人只读；管理操作请本所管理员完成" : "停用、下线、重置码与个人上限在这里改；入组批准在管理员电脑上完成"), tools, box);
  let data = null;
  const reload = () => load(box, () => api.get("/v1/firm/members"), (r) => ((data = r), draw()), "正在读取成员…");
  const draw = () => {
    const members = Array.isArray(data) ? data : data.members ?? [];
    const pending = Array.isArray(data) ? [] : data.pending_joins ?? [];
    clear(box);
    if (pending.length)
      box.append(
        panel(
          `待批准入组（${pending.length}）`,
          h("ul", { class: "mini-list" }, pending.map((p) => h("li", {}, h("span", { class: "cell-2" }, h("b", {}, p.member_name ?? "—"), h("small", {}, `提交于 ${fmt.full(p.created_at)}${p.check_code_hint ? ` · 校验码尾号 ${p.check_code_hint}` : ""}`)), badge("在管理员电脑上批准", "info")))),
          { sub: "核对校验码与本人一致后再批准" },
        ),
      );
    const rows = members.filter((m) => matches(st.q, m.name, m.email, m.member_slug, m.role));
    box.append(
      dataTable({
        rows,
        state: st.table,
        onRow: (m) => openMember(m, reload),
        empty: members.length ? "没有符合条件的成员" : "还没有成员账号",
        rowClass: (m) => (m.status === "disabled" ? "dim" : ""),
        columns: [
          { key: "name", label: "成员", render: (m) => h("div", { class: "cell-2" }, h("b", {}, m.name ?? "—", isMe(m.aid) ? badge("我", "accent") : null), h("small", {}, m.email)) },
          { key: "role", label: "角色", value: (m) => roleText(m.role) },
          { key: "status", label: "状态", render: (m) => h("span", { class: "badges" }, accountBadge({ ...m, locked: Number(m.locked_s) > 0 })) },
          { key: "last_login_at", label: "最近登录", value: (m) => m.last_login_at ?? "", render: (m) => h("span", { title: fmt.full(m.last_login_at) }, fmt.ago(m.last_login_at)) },
          { key: "devices", label: "电脑", num: true, value: (m) => (m.devices ?? []).filter((d) => !d.revoked).length, render: (m) => `${(m.devices ?? []).filter((d) => !d.revoked).length}${m.device_limit ? ` / ${m.device_limit}` : ""}` },
          { key: "usage", label: "本期占本所额度", title: "本期用量 ÷ 本所本期总额度", num: true, value: (m) => Number(m.usage?.used_ratio_of_firm) || 0, render: (m) => fmt.pct(m.usage?.used_ratio_of_firm) },
          { key: "requests", label: "请求", num: true, value: (m) => Number(m.usage?.requests) || 0, render: (m) => fmt.int(m.usage?.requests) },
        ],
      }),
    );
  };
  tools.append(searchInput({ placeholder: "姓名、邮箱、角色", value: st.q, onInput: (v) => ((st.q = v), data && draw()) }));
  reload();
}

function openMember(m, reload) {
  const self = isMe(m.aid);
  const ro = readOnly();
  const why = ro ? "只有本所管理员能操作" : self ? "不能对自己操作" : undefined;
  const after = (msg) => (toast(msg), dr.close(), reload());
  const act = (label, o, fn) => btn(label, fn, { size: "sm", disabled: ro || (self && o.notSelf), title: ro || (self && o.notSelf) ? why : undefined, kind: o.kind });
  const disable = async () => {
    const r = await confirmAction({
      title: `停用 ${m.name ?? m.email}`,
      danger: true,
      consequences: ["这个账号的全部登录立即退出，不能再登录网页与客户端；", "名下电脑不能再调用 AI；本地材料不删除；", "可随时启用恢复。"],
      fields: [{ name: "reason", label: "原因（记入审计，选填）", maxlength: 80 }],
      confirmLabel: "停用",
      run: (v) => api.post(`${api.M(m.aid)}/disable`, v.reason ? { reason: v.reason } : {}),
    });
    if (r) after("已停用");
  };
  const enable = async () => {
    const r = await confirmAction({ title: `启用 ${m.name ?? m.email}`, consequences: ["恢复登录；同时解除登录失败锁定。"], confirmLabel: "启用", run: () => api.post(`${api.M(m.aid)}/enable`) });
    if (r) after("已启用");
  };
  const revoke = async () => {
    const r = await confirmAction({ title: "下线全部登录", consequences: ["这个账号在网页与客户端的登录全部失效；", "本人重新输入密码即可再登录。"], confirmLabel: "全部下线", run: () => api.post(`${api.M(m.aid)}/sessions/revoke`) });
    if (r) after("已下线");
  };
  const reset = async () => {
    const r = await confirmAction({ title: "发一次性重置码", consequences: ["生成一个一次性重置码（只显示一次）；", "本人在客户端或网页的“忘记密码”里用它设新密码；旧密码在设新密码后失效。"], confirmLabel: "生成", run: () => api.post(`${api.M(m.aid)}/reset-code`) });
    if (r?.code) await showSecret({ title: `${m.name ?? m.email} 的重置码`, secret: r.code, expiresAt: r.expires_at, note: "请当面或经电话交给本人，在“忘记密码 → 验证码 / 重置码”里使用。" });
    if (r) reload();
  };
  const limits = async () => {
    const r = await confirmAction({
      title: "个人上限",
      fields: [
        { name: "device_limit", label: "电脑数上限", type: "number", min: 1, max: 9, value: m.device_limit ?? "", hint: "1–9；留空 = 按套餐缺省" },
        { name: "quota_limit", label: "个人本期额度上限", type: "number", min: 0, value: m.quota_limit ?? "", hint: "单位同本所额度；留空 = 不设；不超过本所本期总额度" },
      ],
      validate: (v) => (v.device_limit !== null && !(Number.isInteger(v.device_limit) && v.device_limit >= 1 && v.device_limit <= 9) ? "电脑数填 1–9 的整数" : v.quota_limit !== null && !(v.quota_limit >= 0) ? "个人上限不能为负" : null),
      consequences: ["立即生效：已超过个人上限的成员马上暂停调用 AI；", "已登记的电脑超过新数量的不会被停用，但不能再登记新电脑。"],
      confirmLabel: "保存",
      run: (v) => api.post(`${api.M(m.aid)}/limits`, { device_limit: v.device_limit, quota_limit: v.quota_limit }),
    });
    if (r) after("已保存个人上限");
  };
  const devs = m.devices ?? [];
  const dr = openDrawer({
    title: m.name ?? m.email,
    subtitle: h("span", { class: "sub-row" }, m.email, roleText(m.role), ...accountBadge({ ...m, locked: Number(m.locked_s) > 0 })),
    body: h(
      "div",
      { class: "stack" },
      h(
        "div",
        { class: "action-bar" },
        act("下线全部登录", { notSelf: true }, revoke),
        m.role === "admin" && !self
          ? btn("发重置码", reset, { size: "sm", disabled: true, title: "管理员的重置码由中软客服核验身份后发放（拿到码即可接管对方账号）" })
          : act("发重置码", { notSelf: true }, reset),
        act("个人上限", {}, limits),
        // 第 62 批：危险操作（停用）放在最后
        m.status === "disabled" ? act("启用", {}, enable) : act("停用", { notSelf: true, kind: "danger" }, disable),
      ),
      ro ? h("p", { class: "muted small" }, "合伙人只读：管理操作请本所管理员完成。") : null,
      panel(
        "账号",
        facts([
          ["成员标识", mono(m.member_slug ?? "—")],
          ["加入方式", CREATED_VIA[m.created_via] ?? m.created_via ?? "—"],
          ["最近登录", fmt.full(m.last_login_at)],
          ["登录锁定", Number(m.locked_s) > 0 ? `锁定中，约 ${Math.ceil(m.locked_s / 60)} 分钟后自动解除（启用即可立即解除）` : "无"],
          ["电脑数上限", m.device_limit ? `${m.device_limit} 台` : "按套餐缺省"],
          ["个人额度上限", m.quota_limit === null || m.quota_limit === undefined ? "不设" : fmt.num(m.quota_limit)],
          ["本期用量", m.usage ? `${fmt.int(m.usage.requests)} 次请求 · 占本所本期额度 ${fmt.pct(m.usage.used_ratio_of_firm)}` : "—"],
        ]),
      ),
      panel(
        "电脑",
        devs.length
          ? dataTable({ rows: devs, state: { sort: "last_seen_at", asc: false }, columns: [{ key: "device_id", label: "电脑编号", render: (d) => mono(d.device_id) }, { key: "version", label: "客户端", render: (d) => mono(d.version ?? "—") }, { key: "last_seen_at", label: "最近报到", render: (d) => fmt.ago(d.last_seen_at) }, { key: "revoked", label: "状态", render: (d) => (d.revoked ? badge("已停用", "neutral") : badge("在用", "ok")) }] })
          : emptyBlock("没有电脑"),
        { sub: "停用电脑在管理员电脑上完成" },
      ),
    ),
  });
}
