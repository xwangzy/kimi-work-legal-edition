/**
 * 本所 · 成员（团队 admin 可管理，partner 只读）。第 71 批第二轮（10）起；第 72 批（D-305 第 5 条、D-306，契约 §3.2、§3.4）：
 *   - 页首显著写明“事项内容只在成员电脑，控制台看不到”（团队管理员结构上读不到成员事项）；
 *   - “邀请成员”在网页上发（POST /v1/team/invites，一次性码只显示一次 + 复制 + 有效期），下方列出邀请（待接受 / 已接受 / 已撤销 / 已过期，可撤销）；
 *   - 行尾“…”：改角色、分配 / 释放席位、全部退出登录、发重置短信（C-6：发到本人手机，管理员看不到码）、电脑数上限（≤ 套餐，A3 R1）、
 *     解锁 / 启用（平台停用的不能启用，A3 R2）/ 停用、移出团队（一步完成，确认框写清后果）；
 *   - 成员新电脑：直接登录（缺省）/ 须确认（PUT /v1/firm/policy/member-device，写清选“须确认”的后果）；
 *   - 成员详情里的电脑：状态四态，admin 可在网页上“让它退出登录”；移除与确认新电脑仍在管理员电脑上。
 * 接口：GET /v1/firm/members（members[].seat / devices_summary / disabled_by / person_phone_masked、pending_joins、seats）；
 *       POST /v1/firm/members/{aid}/disable|enable|sessions/revoke|reset-code|limits|remove|role|devices/{id}/signout；
 *       POST /v1/firm/seats/{aid}/assign|release；GET|POST /v1/team/invites[/{id}/revoke]；PUT /v1/firm/policy/member-device。
 */
import * as api from "../api.js";
import { CREATED_VIA, ctx, deviceCell, deviceStateCell, isMe, LIMIT_SOURCE, pageHead, pendingRow, ROLE, roleText, SEAT_NOTE, seatNote, inviteTable, UNSEATED_TIP, versionText, WS_STATUS, wsStatus, wsStatusCell } from "../domain.js";
import { readOnly } from "./firm-overview.js";
import { add, btn, clear, confirmAction, dataTable, facts, fmt, h, icon, load, matches, mono, openDrawer, panel, rowMenu, searchInput, segmented, settingRow, showSecret, stateCell, toast } from "../ui.js";

const st = { q: "", status: "", table: { sort: "name", asc: true }, invTable: { sort: "created_at", asc: false } };
const seatOf = (m) => (m.seat !== undefined ? !!m.seat : !!m.seat_used);
const onlineOf = (m) => m.devices_summary?.signed_in ?? (m.devices ?? []).filter((d) => (d.state ? d.state === "signed_in" : !d.revoked)).length;
const limitOf = (m) => m.devices_summary?.limit ?? m.device_limit;

export function render(page) {
  const head = h("div");
  const tools = h("div", { class: "toolbar" });
  const box = h("div", { class: "stack" });
  const side = h("div", { class: "stack" });
  page.append(head, h("div", { class: "banner info soft" }, icon("shield"), h("span", {}, h("b", {}, "事项内容只在成员电脑，控制台看不到。"), "这里只有成员、角色、席位、电脑与用量（不含任何事项、材料与对话）。")), tools, box, side);
  let data = null;
  const reload = () => {
    load(box, () => api.get("/v1/firm/members"), (r) => ((data = r), draw()), "正在读取成员…");
    drawSide(side, reload);
  };
  const draw = () => {
    const members = Array.isArray(data) ? data : data.members ?? [];
    const pending = Array.isArray(data) ? [] : data.pending_joins ?? [];
    const seats = data.seats ?? null;
    const unseated = members.filter((m) => m.status !== "disabled" && !seatOf(m)).length;
    const pendOf = (aid) => pending.filter((p) => p.aid === aid).length;
    clear(
      head,
      pageHead(
        "成员",
        h("span", { title: SEAT_NOTE }, seats ? `席位 已用 ${seats.used} / 共 ${seats.total}` : "成员与席位", ((sn) => (sn ? h("span", { class: sn.full ? "tone-text-warn" : "muted" }, `；${sn.text}`) : null))(seats ? seatNote(unseated, seats.total, seats.used) : null), readOnly() ? "。合伙人只读，管理操作请团队管理员完成" : null),
        btn("邀请成员", () => invite(reload, seats), { kind: "primary", icon: icon("plus"), disabled: readOnly(), title: readOnly() ? "只有团队管理员能邀请" : undefined }),
      ),
    );
    const STATUS = [
      ["", "全部", () => true],
      ["active", "正常", (m) => m.status === "active" && !(Number(m.locked_s) > 0)],
      ["locked", "已锁定", (m) => Number(m.locked_s) > 0 && m.status !== "disabled"],
      ["disabled", "已停用 / 移出", (m) => m.status === "disabled"],
      ["unseated", "未占席", (m) => m.status !== "disabled" && !seatOf(m)],
    ];
    const f = STATUS.find(([id]) => id === st.status)?.[2] ?? (() => true);
    clear(tools, searchInput({ placeholder: "姓名、手机号后四位、角色", value: st.q, onInput: (v) => ((st.q = v), data && draw()) }), h("span", { class: "seg-label" }, "状态"), segmented(STATUS.map(([id, label, fn]) => ({ id, label, count: members.filter(fn).length })), st.status, (v) => ((st.status = v), draw()), "状态"));
    clear(box);
    if (pending.length)
      box.append(
        h("div", { class: "banner warn soft" }, icon("info"), h("span", { class: "spacer" }, pending.map((p, i) => [i ? "、" : null, h("b", {}, `${p.member_name ?? "成员"}的新电脑`), `（申请于 ${fmt.time(p.created_at)}）`]), "等你确认：请在管理员电脑的“设置 → 管理”里核对校验码与本人一致后再批准。")),
      );
    const rows = members.filter((m) => f(m) && matches(st.q, m.name, m.email, m.person_phone_masked, m.member_slug, roleText(m.role)));
    box.append(
      dataTable({
        rows,
        state: st.table,
        onRow: (m) => openMember(m, pending.filter((p) => p.aid === m.aid), reload),
        empty: members.length ? "没有符合条件的成员" : "还没有成员：点右上角“邀请成员”",
        rowClass: (m) => (m.status === "disabled" ? "dim" : pendOf(m.aid) || Number(m.locked_s) > 0 ? "flagged" : ""),
        caption: "成员",
        columns: [
          { key: "name", label: "成员", render: (m) => h("div", { class: "cell-2" }, h("b", {}, m.name ?? "—", isMe(m.aid) || m.aid === ctx.me?.workspace?.aid ? h("span", { class: "kind-tag" }, "我") : null), h("small", {}, m.person_phone_masked ?? m.email ?? "未绑定手机号")) },
          { key: "role", label: "角色", value: (m) => roleText(m.role) },
          { key: "status", label: "状态", value: (m) => (m.status === "disabled" ? 2 : Number(m.locked_s) > 0 ? 1 : 0), render: (m) => statusCell(m) },
          { key: "last_login_at", label: "最近登录", value: (m) => m.last_login_at ?? "", render: (m) => h("span", { title: fmt.full(m.last_login_at) }, m.last_login_at ? fmt.ago(m.last_login_at) : "从未登录") },
          {
            key: "devices",
            label: "电脑",
            value: (m) => onlineOf(m),
            render: (m) => {
              const on = onlineOf(m);
              const lim = limitOf(m);
              const full = lim && on >= lim;
              return h("div", { class: "cell-2", title: `同时登录上限 ${lim ?? "—"} 台` }, h("span", { class: full ? "tone-text-warn" : "" }, `${on} / ${lim ?? "—"} 台在线${full ? " · 已满" : ""}`), pendOf(m.aid) ? h("small", { class: "tone-text-warn" }, `${pendOf(m.aid)} 台待确认`) : null);
            },
          },
          { key: "seat", label: "席位", title: `${SEAT_NOTE}；${UNSEATED_TIP}`, value: (m) => (seatOf(m) ? 1 : 0), render: (m) => (m.status === "disabled" ? h("span", { class: "muted" }, "—") : seatOf(m) ? stateCell("已占席", "ok") : stateCell("未占席", "neutral", UNSEATED_TIP)) },
          { key: "usage", label: "占本期额度", title: "本期用量 ÷ 本团队本期总额度", num: true, value: (m) => Number(m.usage?.used_ratio_of_firm) || 0, render: (m) => fmt.pct(m.usage?.used_ratio_of_firm) },
          { key: "_act", label: "", sortable: false, class: "act", render: (m) => rowMenu(memberActions(m, reload).menu, { aria: `操作：${m.name ?? m.email}` }) },
        ],
      }),
    );
  };
  reload();
}

const statusCell = (m) => (m.status === "disabled" ? wsStatusCell(m) : Number(m.locked_s) > 0 ? stateCell("已锁定", "warn", "登录失败次数过多，暂时锁定") : stateCell("正常", "ok"));

// ─── 邀请与成员新电脑（页面下半部） ────────────────────────────────
function drawSide(side, reload) {
  const inv = h("div");
  clear(side, policyPanel(), panel("邀请", inv, { flush: true, sub: "邀请码只在生成时显示一次；未接受的可以撤销" }));
  load(
    inv,
    () => api.get("/v1/team/invites"),
    (r) =>
      clear(inv, inviteTable(r.invites ?? [], { state: st.invTable, onRevoke: (x) => revokeInvite(x, reload), revokeTitle: readOnly() ? "只有团队管理员能操作" : undefined })),
    "正在读取邀请…",
  );
}
async function revokeInvite(x, reload) {
  const ok = await confirmAction({ title: `撤销给 ${x.name} 的邀请`, danger: true, consequences: ["这个邀请码立即不能再用；", "已经加入的成员不受影响。"], confirmLabel: "撤销", run: () => api.post(`/v1/team/invites/${api.seg(x.id)}/revoke`) });
  if (ok) (toast("已撤销邀请"), reload());
}
/** 成员新电脑策略（D-304、契约 §3.4）：缺省“直接登录”；选“须确认”要写清后果 */
function policyPanel() {
  const cur = ctx.me?.workspace?.member_device_policy ?? "auto";
  const set = async (next) => {
    if (next === cur) return;
    const ok = await confirmAction({
      title: next === "approve" ? "成员新电脑改为“须确认”" : "成员新电脑改为“直接登录”",
      danger: next === "approve",
      consequences:
        next === "approve"
          ? ["新成员、换电脑的成员：新电脑要等你在管理员电脑“设置 → 管理”里核对校验码并确认后才能登录；", "确认之前，他们在那台新电脑上用不了 AI，也处理不了事项（已登录的电脑不受影响）；", "你不在时没人能确认：请确保至少有一位管理员能及时处理。"]
          : ["成员的新电脑直接登录，能用 AI、处理自己的事项；", "要接收团队共享事项前，那台电脑仍须你在管理员电脑上确认（共享事项的密钥只给确认过的电脑）；", "正在等确认的新电脑不会自动通过：请在管理员电脑上处理。"],
      confirmLabel: "保存",
      run: () => api.put("/v1/firm/policy/member-device", { policy: next }),
    });
    if (ok) (toast("已保存"), await ctx.refreshMe?.(), ctx.reload());
  };
  return panel(
    "成员新电脑",
    settingRow(
      "登录方式",
      cur === "approve" ? "须确认：新电脑要等管理员确认后才能登录。" : "直接登录（默认）：成员自己登录即可；要接收团队共享事项的电脑须管理员确认。",
      h("div", { class: "btn-row" }, segmented([{ id: "auto", label: "直接登录" }, { id: "approve", label: "须确认" }], cur, (v) => (readOnly() ? toast("只有团队管理员能改", "error") : set(v)), "成员新电脑")),
    ),
  );
}

/** 邀请成员（契约 §3.2）：一次性码只显示这一次 + 复制 + 有效期 */
async function invite(reload, seats) {
  const full = seats && Number(seats.used) >= Number(seats.total);
  const r = await confirmAction({
    title: "邀请成员",
    lead: h("p", { class: "muted" }, "生成一次性邀请码（7 天有效）。对方用自己的手机号登录客户端或控制台后输入；没注册的人注册时填这个码，直接进团队。"),
    fields: [
      { name: "name", label: "姓名", required: true, maxlength: 40, hint: "成员在团队里显示的名字" },
      { name: "role", label: "角色", type: "select", options: [["lawyer", ROLE.lawyer], ["assistant", ROLE.assistant], ["partner", ROLE.partner], ["admin", ROLE.admin]], value: "lawyer" },
      { name: "phone_hint", label: "手机号（选填）", type: "tel", placeholder: "如 13900001234", hint: "只保存打码后的号码，用来核对是谁；不会发短信" },
    ],
    consequences: [full ? `当前席位已满（${seats.used} / ${seats.total}）：对方加入后暂时用不了 AI，需要先腾出或加席位；` : "对方加入后有空席即可用 AI（席位不在发邀请时占用）；", "邀请码只显示这一次，请当面或经安全渠道交给本人。"],
    confirmLabel: "生成邀请码",
    run: (v) => api.post("/v1/team/invites", { name: v.name.trim(), role: v.role, ...(v.phone_hint ? { phone_hint: v.phone_hint.trim() } : {}) }),
  });
  if (r?.code) {
    await showSecret({ title: `邀请码 · ${r.invite?.name ?? ""}（${roleText(r.invite?.role)}）`, secret: r.code, expiresAt: r.invite?.expires_at, note: "对方在客户端“加入团队”或注册页填这个码；用过、过期或撤销后失效。" });
    reload();
  }
}

/** 一名成员能做的事（行尾菜单与详情抽屉共用） */
function memberActions(m, reload) {
  const self = isMe(m.aid) || m.aid === ctx.me?.workspace?.aid;
  const ro = readOnly();
  const why = ro ? "只有团队管理员能操作" : self ? "不能对自己操作" : undefined;
  const off = m.status === "disabled";
  const after = (msg) => (toast(msg), closeDrawer(), reload());
  const who = m.name ?? m.email ?? "这名成员";
  const disable = async () => {
    const r = await confirmAction({
      title: `停用 ${who}`,
      danger: true,
      consequences: ["他在本团队的全部登录立即退出，名下电脑不能再调用 AI；本地材料不删除；", "同时释放席位（启用时有空席会还给他）；", "可随时启用恢复；他的个人空间与别的团队不受影响。"],
      fields: [{ name: "reason", label: "原因（记入审计，选填）", maxlength: 80 }],
      confirmLabel: "停用",
      run: (v) => api.post(`${api.M(m.aid)}/disable`, v.reason ? { reason: v.reason } : {}),
    });
    if (r) after("已停用");
  };
  const remove = async () => {
    const r = await confirmAction({
      title: `把${who}移出团队`,
      danger: true,
      lead: h("p", {}, `${who} · ${roleText(m.role)}${m.person_phone_masked ? ` · ${m.person_phone_masked}` : ""}`),
      consequences: [
        "他在本团队的登录立即失效，名下电脑不能再用本团队的 AI；",
        "席位释放，可分给别人；电脑记录保留，事项与材料在他自己的电脑上（离所交接在客户端完成）；",
        "他的账号不删除：个人空间与别的团队照常可用；",
        "要再加入须重新邀请（或在这里“启用”恢复）。",
      ],
      confirmLabel: "移出团队",
      run: () => api.post(`${api.M(m.aid)}/remove`),
    });
    if (r) after(r.seat_released ? "已移出团队，席位已释放" : "已移出团队");
  };
  const role = async () => {
    const r = await confirmAction({
      title: `改${who}的角色`,
      fields: [{ name: "role", label: "角色", type: "radio", options: [["lawyer", ROLE.lawyer, "处理自己的事项"], ["assistant", ROLE.assistant, "协助律师"], ["partner", ROLE.partner, "另可只读查看“本所”"], ["admin", ROLE.admin, "管理成员、席位、电脑与团队设置"]], value: m.role }],
      consequences: ["立即生效；他下次刷新或重新登录时看到新权限；", "最后一名管理员不能降级。"],
      confirmLabel: "保存",
      run: (v) => (v.role === m.role ? { ok: true, unchanged: true } : api.post(`${api.M(m.aid)}/role`, { role: v.role })),
    });
    if (r) after(r.unchanged ? "没有改动" : "已改角色");
  };
  const seat = async (assign) => {
    const r = await confirmAction({
      title: assign ? `给${who}分配席位` : `释放${who}的席位`,
      danger: !assign,
      consequences: assign ? ["他立即可以用 AI（席位 = 能用 AI 的名额）；", "不超过席位数：已满时请联系中软加席位。"] : ["他不能再用 AI（本机功能照常）；", "席位空出可分给别人；用量记录保留。"],
      confirmLabel: assign ? "分配" : "释放",
      run: () => api.post(`/v1/firm/seats/${api.seg(m.aid)}/${assign ? "assign" : "release"}`),
    });
    if (r) after(assign ? "已分配席位" : "已释放席位");
  };
  const enable = async (unlock) => {
    const r = await confirmAction({ title: `${unlock ? "解锁" : "启用"} ${who}`, consequences: unlock ? ["立即解除登录失败锁定，本人可以马上再试。"] : ["恢复登录；同时解除登录失败锁定；", "停用时释放的席位：有空席就还给他，没有空席照样启用（用不了 AI）。"], confirmLabel: unlock ? "解锁" : "启用", run: () => api.post(`${api.M(m.aid)}/enable`) });
    if (r) after(unlock ? "已解锁" : "已启用");
  };
  const signoutAll = async () => {
    const r = await confirmAction({ title: "全部退出登录", consequences: ["他在本团队网页与客户端的登录全部失效；", "本人重新登录即可再用；电脑上的资料保留。"], confirmLabel: "全部退出登录", run: () => api.post(`${api.M(m.aid)}/sessions/revoke`) });
    if (r) after("已退出登录");
  };
  // 第 72 批（C-6）：重置改为给成员本人手机发短信验证码，管理员看不到码
  const reset = async () => {
    const r = await confirmAction({
      title: `给${who}发重置密码短信`,
      consequences: ["给他本人绑定的手机号发一条找回密码的验证码（你看不到码）；", "他在登录页“忘记密码”里填验证码、设新密码；设好后他的全部登录失效、须重新登录。"],
      confirmLabel: "发短信",
      run: async () => {
        try {
          return await api.post(`${api.M(m.aid)}/reset-code`);
        } catch (e) {
          if (e?.code === "phone_unbound") throw Object.assign(new Error("他还没有绑定手机号，发不了短信：请让本人在登录页用“忘记密码”按邮箱找回，或联系中软客服核验身份后重置"), { code: "phone_unbound" });
          throw e;
        }
      },
    });
    if (r) after(r.dry_run ? `测试环境：只记录、不真发短信（${r.phone_masked ?? ""}）` : `已发到 ${r.phone_masked ?? "他的手机"}，${Math.round((Number(r.expires_in_s) || 600) / 60)} 分钟内有效`);
  };
  const limits = async () => {
    const r = await confirmAction({
      title: "个人上限",
      fields: [
        { name: "device_limit", label: "同时登录的电脑数上限", type: "number", min: 1, max: 9, value: m.device_limit_custom ?? "", hint: `留空 = 按套餐（现在 ${m.device_limit ?? "—"} 台）；不能超过套餐，需要更多请联系中软` },
        { name: "quota_limit", label: "个人本期额度上限", type: "number", min: 0, value: m.quota_limit ?? "", hint: "单位同本团队额度；留空 = 不设；不超过本团队本期总额度" },
      ],
      validate: (v) => (v.device_limit !== null && !(Number.isInteger(v.device_limit) && v.device_limit >= 1 && v.device_limit <= 9) ? "电脑数填 1–9 的整数" : v.quota_limit !== null && !(v.quota_limit >= 0) ? "个人上限不能为负" : null),
      consequences: ["立即生效：已超过个人上限的成员马上暂停调用 AI；", "已登录的电脑超过新数量的不会被强制退出，但不能再登录新电脑。"],
      confirmLabel: "保存",
      run: (v) => api.post(`${api.M(m.aid)}/limits`, { ...(v.device_limit !== (m.device_limit_custom ?? null) ? { device_limit: v.device_limit } : {}), ...(v.quota_limit !== (m.quota_limit ?? null) ? { quota_limit: v.quota_limit } : {}) }),
    });
    if (r) after("已保存个人上限");
  };
  const locked = Number(m.locked_s) > 0 && !off;
  const dis = (o = {}) => ({ disabled: ro || (self && o.notSelf), title: ro || (self && o.notSelf) ? why : o.title });
  const platformOff = off && wsStatus(m) === "platform";
  const menu = [
    { label: "打开详情", onClick: () => openMember(m, [], reload) },
    off ? null : { label: "改角色…", onClick: role, ...dis({ notSelf: true }) },
    off ? null : seatOf(m) ? { label: "释放席位…", danger: true, onClick: () => seat(false), ...dis() } : { label: "分配席位…", onClick: () => seat(true), ...dis() },
    off ? null : { label: "全部退出登录…", onClick: signoutAll, ...dis({ notSelf: true }) },
    off ? null : m.role === "admin" && !self ? { label: "发重置短信…", disabled: true, title: "管理员的密码由中软客服核验身份后重置" } : { label: "发重置短信…", onClick: reset, ...dis({ notSelf: true }) },
    off ? null : { label: "个人上限…", onClick: limits, ...dis() },
    locked ? { label: "解锁…", onClick: () => enable(true), ...dis() } : null,
    off ? (platformOff ? { label: "启用（平台停用，联系中软）", disabled: true, title: "这个账号由中软平台停用，团队管理员不能启用" } : { label: "启用…", onClick: () => enable(false), ...dis() }) : { label: "停用…", onClick: disable, ...dis({ notSelf: true }) },
    off ? null : { label: "移出团队…", danger: true, onClick: remove, ...dis({ notSelf: true }) },
  ];
  return { menu, signoutAll, reset, limits, enable, disable, remove, role, locked };
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
    subtitle: h("span", { class: "sub-row" }, m.person_phone_masked ?? m.email, roleText(m.role), statusCell(m)),
    body: add(
      h("div", { class: "stack" }),
      h("div", { class: "action-bar" }, acts.locked ? btn("解锁…", () => acts.enable(true), { size: "sm", kind: "primary", disabled: ro }) : null, m.status === "disabled" ? null : btn("全部退出登录…", acts.signoutAll, { size: "sm", disabled: ro || isMe(m.aid) }), rowMenu(acts.menu.slice(1), { label: "更多", aria: "更多操作" })),
      ro ? h("p", { class: "muted small" }, "合伙人只读：管理操作请团队管理员完成。") : null,
      h("p", { class: "muted small" }, "事项内容只在成员电脑，这里看不到。"),
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
            { key: "_act", label: "", sortable: false, class: "act", render: (d) => (d.pending ? null : rowMenu([d.state === "signed_in" ? { label: "让它退出登录…", onClick: () => signoutOne(d), disabled: ro, title: ro ? "只有团队管理员能操作" : undefined } : null, d.state === "revoked" ? null : { label: "移除（在管理员电脑上完成）", disabled: true, title: "移除只能在管理员电脑的“设置 → 管理”里完成" }])) },
          ],
        }),
        { flush: true, sub: "让电脑退出登录可在这里做；移除与确认新电脑在管理员电脑上完成" },
      ),
      panel(
        "成员",
        facts([
          ["加入方式", CREATED_VIA[m.created_via] ?? (m.created_via === "team_invite" ? "团队邀请" : m.created_via ?? "—")],
          ["状态", m.status === "disabled" ? `${WS_STATUS[wsStatus(m)][0]}${m.disabled_reason ? `（${m.disabled_reason}）` : ""}` : "正常"],
          ["最近登录", m.last_login_at ? fmt.full(m.last_login_at) : "从未登录"],
          ["登录锁定", Number(m.locked_s) > 0 ? `锁定中，约 ${Math.ceil(m.locked_s / 60)} 分钟后自动解除（可立即解锁）` : "无"],
          ["席位", m.status === "disabled" ? "—" : seatOf(m) ? `已占席（可以用 AI）${m.seat?.assigned_at ? `，${fmt.date(m.seat.assigned_at)} 起` : ""}` : "未占席（有空席时第一次用 AI 自动占用，也可直接分配）"],
          ["电脑数上限", limitOf(m) ? `同时登录 ${limitOf(m)} 台（${m.device_limit_custom === null || m.device_limit_custom === undefined ? LIMIT_SOURCE.plan : LIMIT_SOURCE.account}）` : "按套餐缺省"],
          ["个人额度上限", m.quota_limit === null || m.quota_limit === undefined ? "不设" : fmt.num(m.quota_limit)],
          ["本期用量", m.usage ? `${fmt.int(m.usage.requests)} 次请求 · 占本团队本期额度 ${fmt.pct(m.usage.used_ratio_of_firm)}` : "—"],
        ]),
      ),
    ),
  });
}
