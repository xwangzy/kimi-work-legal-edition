/**
 * 本所 · 成员（律所 admin 可管理，partner 只读）。第 71 批第二轮（10）：
 *   - 页头写清席位：已用 x / 共 y；账号多于席位时写“另有 N 个账号未占席：这些成员能登录，但用不了 AI”；成员表“席位”列写占用 / 未占用，可筛“未占席”；
 *   - 待批准的新电脑并进成员行（“1 台待批准”）与页首提示（用姓名，不用成员标识），批准仍在管理员电脑上完成；
 *   - 行尾“…”：打开详情、全部退出登录、发重置码、个人上限、解锁 / 启用 / 停用；右上角“邀请成员”说明在管理员电脑上发邀请码；
 *   - 成员详情里的电脑：状态四态，admin 可在网页上“让它退出登录”（POST /v1/firm/members/{aid}/devices/{id}/signout）；移除仍在管理员电脑上。
 * 接口：GET /v1/firm/members（members、pending_joins、seats）；POST /v1/firm/members/{aid}/disable|enable|sessions/revoke|reset-code|limits|devices/{id}/signout。
 */
import * as api from "../api.js";
import { CREATED_VIA, deviceCell, deviceStateCell, isMe, LIMIT_SOURCE, pageHead, pendingRow, roleText, versionText } from "../domain.js";
import { readOnly } from "./firm-overview.js";
import { btn, clear, confirmAction, dataTable, facts, fmt, h, icon, load, matches, mono, openDrawer, panel, rowMenu, searchInput, segmented, showSecret, stateCell, toast } from "../ui.js";

const st = { q: "", status: "", table: { sort: "name", asc: true } };
const SEAT_NOTE = "席位 = 律所可同时使用 AI 的成员名额";

export function render(page) {
  const head = h("div");
  const tools = h("div", { class: "toolbar" });
  const box = h("div", { class: "stack" });
  page.append(head, tools, box);
  let data = null;
  const reload = () => load(box, () => api.get("/v1/firm/members"), (r) => ((data = r), draw()), "正在读取成员…");
  const draw = () => {
    const members = Array.isArray(data) ? data : data.members ?? [];
    const pending = Array.isArray(data) ? [] : data.pending_joins ?? [];
    const seats = data.seats ?? null;
    const unseated = members.filter((m) => m.seat_used === false).length;
    const pendOf = (aid) => pending.filter((p) => p.aid === aid).length;
    clear(
      head,
      pageHead(
        "成员",
        h("span", { title: SEAT_NOTE }, seats ? `席位 已用 ${seats.used} / 共 ${seats.total}` : "成员与席位", unseated ? h("span", { class: "tone-text-warn" }, `；另有 ${unseated} 个账号未占席：这些成员能登录，但用不了 AI`) : null, unseated ? h("span", { class: "muted" }, "。成员在电脑上第一次用 AI 时自动占席；席位不够时请平台改套餐或席位") : null, readOnly() ? "。合伙人只读，管理操作请本所管理员完成" : null),
        btn("邀请成员", invite, { kind: "primary", icon: icon("plus"), disabled: readOnly(), title: readOnly() ? "只有本所管理员能邀请" : undefined }),
      ),
    );
    const STATUS = [
      ["", "全部", () => true],
      ["active", "正常", (m) => m.status === "active" && !(Number(m.locked_s) > 0)],
      ["locked", "已锁定", (m) => Number(m.locked_s) > 0 && m.status !== "disabled"],
      ["disabled", "已停用", (m) => m.status === "disabled"],
      ["unseated", "未占席", (m) => m.seat_used === false],
    ];
    const f = STATUS.find(([id]) => id === st.status)?.[2] ?? (() => true);
    clear(tools, searchInput({ placeholder: "姓名、邮箱、角色", value: st.q, onInput: (v) => ((st.q = v), data && draw()) }), h("span", { class: "seg-label" }, "状态"), segmented(STATUS.map(([id, label, fn]) => ({ id, label, count: members.filter(fn).length })), st.status, (v) => ((st.status = v), draw()), "状态"));
    clear(box);
    if (pending.length)
      box.append(
        h("div", { class: "banner warn" }, icon("info"), h("span", { class: "spacer" }, `${pending.map((p) => `${p.member_name ?? "成员"}的新电脑（申请于 ${fmt.time(p.created_at)}）`).join("、")}等你批准：请在管理员电脑的“设置 → 管理”里核对校验码与本人一致后再批准。`)),
      );
    const rows = members.filter((m) => f(m) && matches(st.q, m.name, m.email, m.member_slug, roleText(m.role)));
    box.append(
      dataTable({
        rows,
        state: st.table,
        onRow: (m) => openMember(m, pending.filter((p) => p.aid === m.aid), reload),
        empty: members.length ? "没有符合条件的成员" : "还没有成员账号",
        rowClass: (m) => (m.status === "disabled" ? "dim" : pendOf(m.aid) || Number(m.locked_s) > 0 ? "flagged" : ""),
        caption: "成员",
        columns: [
          { key: "name", label: "成员", render: (m) => h("div", { class: "cell-2" }, h("b", {}, m.name ?? "—", isMe(m.aid) ? h("span", { class: "kind-tag" }, "我") : null), h("small", {}, m.email)) },
          { key: "role", label: "角色", value: (m) => roleText(m.role) },
          { key: "status", label: "状态", value: (m) => (m.status === "disabled" ? 2 : Number(m.locked_s) > 0 ? 1 : 0), render: (m) => statusCell(m) },
          { key: "last_login_at", label: "最近登录", value: (m) => m.last_login_at ?? "", render: (m) => h("span", { title: fmt.full(m.last_login_at) }, m.last_login_at ? fmt.ago(m.last_login_at) : "从未登录") },
          {
            key: "devices",
            label: "电脑",
            value: (m) => (m.devices ?? []).filter((d) => d.state === "signed_in").length,
            render: (m) => {
              const on = (m.devices ?? []).filter((d) => (d.state ? d.state === "signed_in" : !d.revoked)).length;
              const full = m.device_limit && on >= m.device_limit;
              return h("div", { class: "cell-2", title: `同时登录上限 ${m.device_limit ?? "—"} 台` }, h("span", { class: full ? "tone-text-warn" : "" }, `${on} / ${m.device_limit ?? "—"} 台在线${full ? " · 已满" : ""}`), pendOf(m.aid) ? h("small", { class: "tone-text-warn" }, `${pendOf(m.aid)} 台待批准`) : null);
            },
          },
          { key: "seat_used", label: "席位", title: `${SEAT_NOTE}；未占席的成员能登录，但用不了 AI`, value: (m) => (m.seat_used ? 1 : 0), render: (m) => (m.seat_used === undefined ? "—" : m.seat_used ? stateCell("已占席", "ok") : stateCell("未占席", "neutral", "能登录，但用不了 AI")) },
          { key: "usage", label: "本期占本所额度", title: "本期用量 ÷ 本所本期总额度", num: true, value: (m) => Number(m.usage?.used_ratio_of_firm) || 0, render: (m) => fmt.pct(m.usage?.used_ratio_of_firm) },
          { key: "_act", label: "", sortable: false, class: "act", render: (m) => rowMenu(memberActions(m, reload).menu, { aria: `操作：${m.name ?? m.email}` }) },
        ],
      }),
    );
  };
  reload();
}

const statusCell = (m) => (m.status === "disabled" ? stateCell("已停用", "neutral", m.disabled_reason ? `停用原因：${m.disabled_reason}` : undefined) : Number(m.locked_s) > 0 ? stateCell("已锁定", "warn", "登录失败次数过多，暂时锁定") : stateCell("正常", "ok"));

async function invite() {
  await confirmAction({
    title: "邀请成员",
    lead: h("p", {}, "成员邀请码由本所管理员在管理员电脑上发：打开客户端“设置 → 管理 → 邀请成员”，生成邀请码交给本人。本人用邀请码注册后会出现在这里，新电脑同样在管理员电脑上批准。"),
    note: "邀请码只能在管理员电脑上生成；网页这里看得到结果。",
    confirmLabel: "知道了",
  });
}

/** 一名成员能做的事（行尾菜单与详情抽屉共用） */
function memberActions(m, reload) {
  const self = isMe(m.aid);
  const ro = readOnly();
  const why = ro ? "只有本所管理员能操作" : self ? "不能对自己操作" : undefined;
  const after = (msg) => (toast(msg), closeDrawer(), reload());
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
  const enable = async (unlock) => {
    const r = await confirmAction({ title: `${unlock ? "解锁" : "启用"} ${m.name ?? m.email}`, consequences: unlock ? ["立即解除登录失败锁定，本人可以马上再试。"] : ["恢复登录；同时解除登录失败锁定。"], confirmLabel: unlock ? "解锁" : "启用", run: () => api.post(`${api.M(m.aid)}/enable`) });
    if (r) after(unlock ? "已解锁" : "已启用");
  };
  const signoutAll = async () => {
    const r = await confirmAction({ title: "全部退出登录", consequences: ["这个账号在网页与客户端的登录全部失效；", "本人重新输入密码即可再登录；电脑上的资料保留。"], confirmLabel: "全部退出登录", run: () => api.post(`${api.M(m.aid)}/sessions/revoke`) });
    if (r) after("已退出登录");
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
        // 第 71 批（B-2）：预填单设值 device_limit_custom（原先预填生效值，保存一次就脱离套餐缺省）
        { name: "device_limit", label: "同时登录的电脑数上限", type: "number", min: 1, max: 9, value: m.device_limit_custom ?? "", hint: `1–9；留空 = 按套餐缺省（现在 ${m.device_limit ?? "—"} 台）` },
        { name: "quota_limit", label: "个人本期额度上限", type: "number", min: 0, value: m.quota_limit ?? "", hint: "单位同本所额度；留空 = 不设；不超过本所本期总额度" },
      ],
      validate: (v) => (v.device_limit !== null && !(Number.isInteger(v.device_limit) && v.device_limit >= 1 && v.device_limit <= 9) ? "电脑数填 1–9 的整数" : v.quota_limit !== null && !(v.quota_limit >= 0) ? "个人上限不能为负" : null),
      consequences: ["立即生效：已超过个人上限的成员马上暂停调用 AI；", "已登录的电脑超过新数量的不会被强制退出，但不能再登录新电脑。"],
      confirmLabel: "保存",
      run: (v) => api.post(`${api.M(m.aid)}/limits`, { ...(v.device_limit !== (m.device_limit_custom ?? null) ? { device_limit: v.device_limit } : {}), ...(v.quota_limit !== (m.quota_limit ?? null) ? { quota_limit: v.quota_limit } : {}) }),
    });
    if (r) after("已保存个人上限");
  };
  const locked = Number(m.locked_s) > 0 && m.status !== "disabled";
  const dis = (o = {}) => ({ disabled: ro || (self && o.notSelf), title: ro || (self && o.notSelf) ? why : o.title });
  const menu = [
    { label: "打开详情", onClick: () => openMember(m, [], reload) },
    { label: "全部退出登录…", onClick: signoutAll, ...dis({ notSelf: true }) },
    m.role === "admin" && !self ? { label: "发重置码…", disabled: true, title: "管理员的重置码由中软客服核验身份后发放（拿到码即可接管对方账号）" } : { label: "发重置码…", onClick: reset, ...dis({ notSelf: true }) },
    { label: "个人上限…", onClick: limits, ...dis() },
    locked ? { label: "解锁…", onClick: () => enable(true), ...dis() } : null,
    m.status === "disabled" ? { label: "启用…", onClick: () => enable(false), ...dis() } : { label: "停用账号…", danger: true, onClick: disable, ...dis({ notSelf: true }) },
  ];
  return { menu, signoutAll, reset, limits, enable, disable, locked };
}
const closeDrawer = () => document.querySelector("#drawer")?.open && document.querySelector("#drawer").close();

function openMember(m, pending, reload) {
  const acts = memberActions(m, reload);
  const ro = readOnly();
  const signoutOne = async (d) => {
    const r = await confirmAction({
      title: "让这台电脑退出登录",
      lead: h("p", {}, h("b", {}, d.name || "这台电脑"), h("span", { class: "muted" }, " · ", mono(d.device_id))),
      consequences: ["这台电脑上的登录立即失效，腾出一个“同时登录”的名额；", "电脑上的资料保留，本人之后在那台电脑上重新登录即可继续用；", "不移除这台电脑（移除请在管理员电脑上完成）。"],
      confirmLabel: "退出登录",
      run: async () => {
        try {
          return await api.post(`${api.M(m.aid)}/devices/${api.seg(d.device_id)}/signout`);
        } catch (e) {
          if (e?.code === "not_ready") throw new Error("云端版本过旧：还不支持在网页上让电脑退出登录，请在管理员电脑上操作");
          throw e;
        }
      },
    });
    if (r) (toast("已退出登录"), closeDrawer(), reload());
  };
  const devs = [...(m.devices ?? []).map((d) => ({ ...d, member_name: m.name, client_version: d.version, last_seen_on: d.last_seen_at })), ...pending.map((p) => pendingRow({ ...p, member_name: m.name }))];
  openDrawer({
    title: m.name ?? m.email,
    subtitle: h("span", { class: "sub-row" }, m.email, roleText(m.role), statusCell(m)),
    body: h(
      "div",
      { class: "stack" },
      h("div", { class: "action-bar" }, acts.locked ? btn("解锁…", () => acts.enable(true), { size: "sm", kind: "primary", disabled: ro }) : null, btn("全部退出登录…", acts.signoutAll, { size: "sm", disabled: ro || isMe(m.aid) }), btn("个人上限…", acts.limits, { size: "sm", disabled: ro }), rowMenu(acts.menu.slice(2), { label: "更多", aria: "更多操作" })),
      ro ? h("p", { class: "muted small" }, "合伙人只读：管理操作请本所管理员完成。") : null,
      panel(
        "电脑",
        dataTable({
          rows: devs,
          state: { sort: "state", asc: true },
          empty: "没有电脑",
          columns: [
            { key: "name", label: "电脑", render: (d) => deviceCell(d) },
            { key: "version", label: "客户端", render: (d) => (d.pending ? "—" : d.version && d.version !== "legacy" ? mono(d.version) : h("span", { class: "muted" }, versionText(d.version))) },
            { key: "last_seen_at", label: "最近在线", render: (d) => (d.pending ? "—" : d.last_seen_at ? fmt.ago(d.last_seen_at) : "从未在线") },
            { key: "state", label: "状态", value: (d) => ({ pending: 0, signed_in: 1, signed_out: 2, revoked: 3 })[d.state ?? (d.revoked ? "revoked" : "signed_out")], render: (d) => deviceStateCell(d) },
            { key: "_act", label: "", sortable: false, class: "act", render: (d) => (d.pending ? null : rowMenu([d.state === "signed_in" ? { label: "让它退出登录…", onClick: () => signoutOne(d), disabled: ro, title: ro ? "只有本所管理员能操作" : undefined } : null, d.state === "revoked" ? null : { label: "移除（在管理员电脑上完成）", disabled: true, title: "移除只能在管理员电脑的“设置 → 管理”里完成" }])) },
          ],
        }),
        { flush: true, sub: "让电脑退出登录可在这里做；移除与批准新电脑在管理员电脑上完成" },
      ),
      panel(
        "账号",
        facts([
          ["加入方式", CREATED_VIA[m.created_via] ?? m.created_via ?? "—"],
          ["最近登录", m.last_login_at ? fmt.full(m.last_login_at) : "从未登录"],
          ["登录锁定", Number(m.locked_s) > 0 ? `锁定中，约 ${Math.ceil(m.locked_s / 60)} 分钟后自动解除（可立即解锁）` : "无"],
          ["席位", m.seat_used === undefined ? "—" : m.seat_used ? "已占席（可以用 AI）" : "未占席（能登录，但用不了 AI；第一次在电脑上用 AI 时自动占席）"],
          ["电脑数上限", m.device_limit ? `同时登录 ${m.device_limit} 台（${m.device_limit_custom === null || m.device_limit_custom === undefined ? LIMIT_SOURCE.plan : LIMIT_SOURCE.account}）` : "按套餐缺省"],
          ["个人额度上限", m.quota_limit === null || m.quota_limit === undefined ? "不设" : fmt.num(m.quota_limit)],
          ["本期用量", m.usage ? `${fmt.int(m.usage.requests)} 次请求 · 占本所本期额度 ${fmt.pct(m.usage.used_ratio_of_firm)}` : "—"],
        ]),
      ),
    ),
  });
}
