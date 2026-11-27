/**
 * 用户（第 72 批，D-306 第 3 条；原“账号”页）：一行 = 一个人（主账号），列出他的个人空间与加入的各团队。
 *   列表   GET /v1/ops/people?q=&page=（account.read）；?jump=1 且只命中一个人时直接进详情（顶栏搜索用）。
 *   详情   #/ops/people/<aid>：身份与登录诊断、工作空间（个人 / 各团队 + 角色、状态、席位）、按工作空间分组的电脑、会话、告警。
 *          传团队成员身份的编号也认：控制面回 primary_aid，地址就地换成这个人的主账号。
 *          旧 #/ops/accounts/<aid> 由 app.js 转到这里。代建成员不在这里：只在组织详情“成员与席位 → 邀请成员”。
 * 接口：GET /v1/ops/people/{aid}；诊断所需的客户摘要、席位、待批准入组、本期用量逐工作空间取 GET /v1/ops/accounts/{aid}（第 71 批已有）；
 *       写操作沿用 /v1/ops/accounts/{aid}/reset-code|enable|disable|limits|sessions/revoke、
 *       POST /v1/ops/tenants/{tid}/seats/{aid}/assign（契约 §8，权限 device.revoke，C-9）与 …/seats/{uid}/revoke。
 */
import * as api from "../api.js";
import { alertList, can, canSupport, CREATED_VIA, DENOMINATOR, deviceLabel, deviceState, deviceTable, go, kindOf, LIMIT_SOURCE, needs, pageHead, PAUSED, pendingRow, revokeDevice, roleText, SEAT_NOTE, setCrumbs, signoutDevice, UNSEATED_TIP, wsChip, wsStatus, wsStatusCell } from "../domain.js";
import { add, badge, btn, clear, confirmAction, copyBtn, dataTable, errorBlock, facts, fmt, fold, h, loadingBlock, meter, metaLine, mono, note, panel, rowMenu, searchInput, showSecret, stateCell, toast } from "../ui.js";

const st = { q: "", table: { sort: "last_login_at", asc: false } };
const wsLabel = (w) => (kindOf(w) === "personal" ? "个人空间" : w.name ?? w.tid);

export function render(page, r) {
  if (r.arg) return renderDetail(page, r.arg, r.params);
  if (r.params.q !== undefined) st.q = r.params.q;
  const jump = r.params.jump === "1";
  const count = h("span", { class: "toolbar-count" });
  const tools = h("div", { class: "toolbar" });
  const box = h("div", { class: "stack" });
  page.append(pageHead("用户", "一行 = 一个人：他的个人空间与加入的团队。接电话时先在这里搜手机号、邮箱或姓名；要给团队加人，在客户 · 团队详情里“邀请成员”"), tools, box);
  let rows = [];
  let pageNo = 1;
  let pages = 1;
  let total = 0;
  let seq = 0;
  let first = true;
  const fetchPage = async (append) => {
    const my = ++seq;
    if (!append) clear(box, loadingBlock("正在读取用户…"));
    try {
      const res = await api.get("/v1/ops/people", { q: st.q, page: append ? pageNo + 1 : 1 });
      if (my !== seq) return;
      rows = append ? rows.concat(res.people ?? []) : res.people ?? [];
      pageNo = Number(res.page) || 1;
      pages = Number(res.pages) || 1;
      total = Number(res.total ?? rows.length);
      if (first && jump && st.q && rows.length === 1 && total === 1) return void location.replace(`#/ops/people/${encodeURIComponent(rows[0].aid)}`);
      first = false;
      draw();
    } catch (e) {
      if (my !== seq) return;
      clear(box, errorBlock(e, () => fetchPage(false)));
    }
  };
  const draw = () => {
    count.textContent = `共 ${fmt.int(total)} 人`;
    clear(
      box,
      dataTable({
        state: st.table,
        rows,
        onRow: (p) => go(`people/${encodeURIComponent(p.aid)}`),
        empty: st.q ? `没有找到“${st.q}”。可以试试手机号后四位、邮箱前缀或团队名称` : "还没有用户：律师自助注册或接受团队邀请后出现在这里",
        rowClass: (p) => (p.status === "disabled" && (p.workspaces ?? []).every((w) => w.status === "disabled") ? "dim" : ""),
        caption: "用户",
        columns: [
          { key: "name", label: "用户", value: (p) => p.name ?? "", render: (p) => h("div", { class: "cell-2" }, h("b", {}, p.name || "—"), h("small", {}, [p.phone_masked, p.email_masked].filter(Boolean).join(" · ") || "未绑定手机号")) },
          { key: "workspaces", label: "工作空间", sortable: false, render: (p) => h("span", { class: "ws-chips" }, (p.workspaces ?? []).map((w) => wsChip(w))) },
          { key: "status", label: "状态", value: (p) => (p.status === "disabled" ? 1 : 0), render: (p) => personState(p) },
          { key: "last_login_at", label: "最近登录", value: (p) => p.last_login_at ?? "", render: (p) => h("span", { title: fmt.full(p.last_login_at) }, p.last_login_at ? fmt.ago(p.last_login_at) : "从未登录") },
          { key: "created_at", label: "注册于", class: "nowrap", value: (p) => p.created_at ?? "", render: (p) => fmt.date(p.created_at) },
          {
            key: "_act",
            label: "",
            sortable: false,
            class: "act",
            render: (p) =>
              rowMenu([
                { label: "打开详情", onClick: () => go(`people/${encodeURIComponent(p.aid)}`) },
                { label: "查看电脑", onClick: () => go(`people/${encodeURIComponent(p.aid)}?section=devices`) },
                { label: "复制用户编号", onClick: () => navigator.clipboard?.writeText(p.aid).then(() => toast("已复制"), () => toast(p.aid, "info")) },
              ], { aria: `操作：${p.name ?? p.aid}` }),
          },
        ],
      }),
      pageNo < pages ? h("div", { class: "more" }, btn(`加载更多（已显示 ${rows.length} / ${total}）`, (ev) => ((ev.currentTarget.disabled = true), fetchPage(true)))) : rows.length ? h("p", { class: "muted small center" }, `共 ${fmt.int(total)} 人`) : null,
    );
  };
  tools.append(searchInput({ placeholder: "手机号、邮箱、姓名或团队名", value: st.q, onInput: (v) => ((st.q = v.trim()), fetchPage(false)), delay: 300 }), h("span", { class: "spacer" }), count);
  fetchPage(false);
}

/** 一个人的状态：主账号（登录凭证所在）停用了，但团队身份还能用时照实写 */
function personState(p) {
  const live = (p.workspaces ?? []).filter((w) => w.status !== "disabled").length;
  if (p.status !== "disabled") return stateCell("正常", "ok");
  return live ? stateCell("个人空间已停用", "neutral", `还有 ${live} 个工作空间可用：凭证照常认证，登录进可用的那个`) : stateCell("已停用", "neutral");
}

// ─── 用户详情 ────────────────────────────────────────────────────────
function renderDetail(page, aid, params) {
  const head = h("div");
  const body = h("div", { class: "stack" });
  page.append(head, body);
  const reload = async () => {
    clear(body, loadingBlock("正在读取用户…"));
    try {
      const d = await api.get(`/v1/ops/people/${api.seg(aid)}`);
      // 传的是团队成员身份：控制面回这个人的主账号（primary_aid），地址就地换成它
      if (d.primary_aid && d.primary_aid !== aid) history.replaceState(null, "", `#/ops/people/${encodeURIComponent(d.primary_aid)}${params?.section ? `?section=${params.section}` : ""}`);
      // 诊断要的客户摘要、席位、待批准入组、本期用量：逐工作空间读账号详情（读不到的照样画，只少这一块）
      const accs = await Promise.all((d.workspaces ?? []).map((w) => api.get(api.A(w.aid)).catch(() => null)));
      draw(head, body, d, accs, reload, params);
    } catch (e) {
      clear(head);
      clear(body, errorBlock(e, reload));
    }
  };
  reload();
}

function draw(head, body, d, accs, reload, params) {
  const p = d.person ?? {};
  const a = d.account ?? {};
  const ws = (d.workspaces ?? []).map((w, i) => ({ ...w, acc: w.account ?? accs[i]?.account ?? {}, dd: accs[i] ?? null }));
  const devsOf = (w) => (w.devices ?? []).map((x) => ({ ...x, aid: x.aid ?? w.aid, tid: x.tid ?? w.tid, email: x.email ?? a.email, member_name: x.member_name ?? p.name }));
  const all = ws.flatMap(devsOf);
  const live = all.filter((x) => deviceState(x) !== "revoked");
  const signedIn = live.filter((x) => deviceState(x) === "signed_in");
  const locked = !!a.locked && a.status !== "disabled";
  // 验收 Q-5：团队数只算有效身份；被移出 / 停用的另写一句
  const nTeam = ws.filter((w) => kindOf(w) === "team" && w.status !== "disabled").length;
  const nOff = ws.filter((w) => w.status === "disabled").length;
  const nPersonal = ws.filter((w) => kindOf(w) === "personal").length;
  const sessions = ws.flatMap((w) => (w.sessions ?? []).map((s) => ({ ...s, ws: w })));
  setCrumbs([["用户", "ops/people"], [p.name || a.email || p.aid]]);

  const resetCode = async () => {
    const setup = a.has_password === false;
    const r = await confirmAction({ title: setup ? "生成设置码" : "生成重置码", lead: h("p", {}, [p.name, p.phone_masked ?? a.email].filter(Boolean).join(" · ")), consequences: setup ? ["生成一次性设置密码码（24 小时），只在这个屏幕上显示一次，不发短信；", "请当面或经电话交给本人，本人凭码设密码。"] : ["生成一次性重置码（30 分钟），只在这个屏幕上显示一次，不发短信；", "密码是这个人的（各工作空间共用）：设新密码后全部工作空间的登录都失效、须重新登录；同时解除登录锁定。"], confirmLabel: setup ? "生成设置码" : "生成重置码", run: () => api.post(`${api.A(a.aid)}/reset-code`) });
    if (r?.reset_code) await showSecret({ title: `${r.purpose === "setup" ? "设置密码码" : "重置码"} · ${p.name ?? a.email}`, secret: r.reset_code, expiresAt: r.expires_at, note: "请当面或经电话交给本人，在“忘记密码 → 重置码”里使用。" });
  };
  const enable = async (acc, unlock) => {
    const ok = await confirmAction({ title: unlock ? `解锁 ${p.name ?? ""}` : `启用 ${acc === a ? "个人空间" : acc.tenant_name ?? ""}`, consequences: unlock ? ["立即解除登录失败锁定，本人可以马上再试；", "不改密码、不影响已有登录。"] : ["本人可再次登录这个工作空间；之前失效的登录不恢复，须重新登录；", "同时解除登录失败锁定。"], confirmLabel: unlock ? "解锁" : "启用", run: () => api.post(`${api.A(acc.aid)}/enable`) });
    if (ok) (toast(unlock ? "已解锁" : "已启用"), reload());
  };
  const signoutAll = async () => {
    const r = await confirmAction({ title: "全部退出登录", lead: h("p", {}, `${p.name ?? ""} 在 ${ws.length} 个工作空间里共 ${fmt.int(sessions.length)} 个登录`), consequences: ["网页与客户端的登录全部失效（约 15 秒内生效）；", "本人重新登录即可继续用；电脑上的资料保留。"], confirmLabel: "全部退出登录", run: async () => { let n = 0; for (const w of ws) n += Number((await api.post(`${api.A(w.aid)}/sessions/revoke`)).revoked) || 0; return { n }; } });
    if (r) (toast(`已退出 ${fmt.int(r.n)} 个登录`), reload());
  };
  const primary = locked
    ? btn("解锁…", () => enable(a, true), { kind: "primary", disabled: !canSupport(), title: canSupport() ? undefined : needs("account.support") })
    : btn(a.has_password === false ? "生成设置码…" : "生成重置码…", resetCode, { kind: "primary", disabled: !canSupport(), title: canSupport() ? undefined : needs("account.support") });
  clear(
    head,
    h(
      "div",
      { class: "stack" },
      pageHead(
        h("span", { class: "title-row" }, p.name || a.email || "用户", locked ? badge("已锁定", "warn") : null, ws.length && ws.every((w) => w.status === "disabled") ? badge("已停用", "neutral") : null),
        metaLine(p.phone_masked ?? "未绑定手机号", a.email, `${ws.length} 个工作空间`, `${CREATED_VIA[a.created_via] ?? "注册"}于 ${fmt.date(a.created_at)}`),
        h("div", { class: "btn-row" }, primary, btn("全部退出登录…", signoutAll, { disabled: !canSupport() || !sessions.length, title: !canSupport() ? needs("account.support") : !sessions.length ? "没有登录会话" : undefined }), rowMenu([{ label: "复制用户编号", onClick: () => navigator.clipboard?.writeText(a.aid).then(() => toast("已复制"), () => toast(a.aid, "info")) }], { label: "更多", aria: "更多操作" })),
      ),
      h(
        "div",
        { class: "head-stats" },
        h("div", { class: "head-stat stat" }, h("span", { class: "stat-label" }, "工作空间"), h("span", { class: "stat-value num" }, `${ws.length} 个`), h("span", { class: "stat-sub" }, [nPersonal ? "个人空间 1" : "没有个人空间", nTeam ? `团队 ${nTeam}` : null, nOff ? `已移出 / 停用 ${nOff}` : null].filter(Boolean).join(" · "))),
        h("div", { class: "head-stat stat" }, h("span", { class: "stat-label" }, "电脑"), h("span", { class: "stat-value num" }, `${signedIn.length} 台在线`), h("span", { class: "stat-sub" }, `共登记 ${live.length} 台 · 各工作空间分别计同时登录上限`)),
        h("div", { class: "head-stat stat" }, h("span", { class: "stat-label" }, "最近登录"), h("span", { class: "stat-value num" }, p.last_login_at ? fmt.ago(p.last_login_at) : "从未"), h("span", { class: "stat-sub" }, fmt.full(p.last_login_at))),
        h("div", { class: "head-stat stat" }, h("span", { class: "stat-label" }, "登录会话"), h("span", { class: "stat-value num" }, `${fmt.int(sessions.length)} 个`), h("span", { class: "stat-sub" }, `桌面 ${sessions.filter((s) => s.kind === "desktop").length} · 网页 ${sessions.filter((s) => s.kind !== "desktop").length}（网页不占电脑名额）`)),
      ),
    ),
  );
  const devBox = h("div", { class: "stack", id: "person-devices" });
  clear(
    body,
    diagnosis({ p, a, ws, locked, enable, reload }),
    panel("工作空间", wsTable(ws, p, reload), { flush: true, sub: "一个人、一个账号；个人空间与每个团队各是一个工作空间，角色、席位、电脑上限、用量分开算" }),
    add(devBox, ...devicePanels(ws, devsOf, reload)),
    usagePanel(ws),
    h("div", { class: "grid-2" }, identityPanel(p, a), sessionsPanel(sessions, all)),
    (d.alerts ?? []).length ? panel("告警", alertList(d.alerts ?? [], { onAck: reload })) : null,
  );
  if (params?.section === "devices") requestAnimationFrame(() => devBox.scrollIntoView({ block: "start" }));
}

/** 工作空间表：个人在前；团队行可分配 / 收回席位、停用这个身份；行点开组织详情（个人空间点开它的订阅与用量） */
function wsTable(ws, p, reload) {
  const signedOf = (w) => (w.devices ?? []).filter((x) => deviceState(x) === "signed_in").length;
  return dataTable({
    state: {},
    rows: ws,
    onRow: (w) => can("tenant.read") && go(`tenants/${encodeURIComponent(w.tid)}`),
    empty: "没有工作空间",
    rowClass: (w) => (w.status === "disabled" ? "dim" : ""),
    caption: "工作空间",
    columns: [
      { key: "name", label: "工作空间", sortable: false, render: (w) => h("div", { class: "cell-2" }, h("b", {}, wsLabel(w), h("span", { class: "kind-tag" }, kindOf(w) === "personal" ? "个人" : "团队")), mono(w.tid)) },
      { key: "role", label: "角色", sortable: false, render: (w) => (kindOf(w) === "personal" ? h("span", { class: "muted" }, "本人") : roleText(w.role)) },
      { key: "status", label: "状态", sortable: false, render: (w) => wsStatusCell(w) },
      { key: "seat", label: "席位", title: SEAT_NOTE, sortable: false, render: (w) => (kindOf(w) === "personal" ? h("span", { class: "muted" }, "个人不讲席位") : w.status === "disabled" ? h("span", { class: "muted" }, "—") : w.seat ? stateCell("已占席", "ok") : stateCell("未占席", "neutral", UNSEATED_TIP)) },
      { key: "devices", label: "电脑", sortable: false, render: (w) => ((on, lim) => h("span", { class: lim && on >= lim ? "tone-text-warn" : "", title: `同时登录上限 ${fmt.int(lim)} 台（${LIMIT_SOURCE[w.acc.device_limit_source] ?? "上限"}）` }, `${on} / ${fmt.int(lim)} 台在线${lim && on >= lim ? " · 已满" : ""}`))(signedOf(w), Number(w.acc.device_limit) || 0) },
      { key: "used", label: "本期用量", num: true, sortable: false, title: "个人上限或每人额度的已用比例", render: (w) => (w.acc.used_ratio === null || w.acc.used_ratio === undefined ? h("span", { class: "muted" }, "—") : fmt.pct(w.acc.used_ratio)) },
      { key: "joined", label: "加入", class: "nowrap", sortable: false, render: (w) => h("div", { class: "cell-2" }, fmt.date(w.acc.created_at), h("small", {}, CREATED_VIA[w.acc.created_via] ?? (w.acc.created_via === "team_invite" ? "团队邀请" : "—"))) },
      { key: "_act", label: "", sortable: false, class: "act", render: (w) => rowMenu(wsActions(w, p, reload), { aria: `操作：${wsLabel(w)}` }) },
    ],
  });
}
export function wsActions(w, p, reload) {
  const team = kindOf(w) === "team";
  const off = w.status === "disabled";
  const seatRec = w.dd?.seat;
  return [
    { label: team ? "打开组织详情" : "个人空间的订阅与用量", onClick: () => go(`tenants/${encodeURIComponent(w.tid)}`), disabled: !can("tenant.read"), title: needs("tenant.read") },
    team && !off && !w.seat ? { label: "分配席位…", onClick: () => assignSeat(w, p, reload), disabled: !can("device.revoke"), title: needs("device.revoke") } : null,
    team && w.seat ? { label: "收回席位…", danger: true, onClick: () => revokeSeatOf(w, p, seatRec, reload), disabled: !can("device.revoke") || !seatRec, title: needs("device.revoke") } : null,
    off ? null : { label: "电脑数上限…", onClick: () => limitsOf(w, p, reload), disabled: !can("account.manage"), title: needs("account.manage") },
    off
      ? { label: "启用这个身份…", onClick: () => enableWs(w, p, reload), disabled: !canSupport() || wsStatus(w) === "team", title: wsStatus(w) === "team" ? "团队管理员移出的成员，由团队管理员重新邀请或启用" : canSupport() ? undefined : needs("account.support") }
      : { label: team ? "停用这个团队身份…" : "停用个人空间…", danger: true, onClick: () => disableWs(w, p, reload), disabled: !can("account.manage"), title: needs("account.manage") },
  ];
}
async function assignSeat(w, p, reload) {
  const t = w.dd?.tenant;
  const ok = await confirmAction({
    title: "分配席位",
    lead: h("p", {}, `${p.name ?? ""} · ${w.name ?? w.tid}${t ? `（已用 ${fmt.int(t.seats_used)} / 共 ${fmt.int(t.seats)} 席）` : ""}`),
    consequences: ["这名成员立即可以用 AI（席位 = 能用 AI 的名额）；", "不超过席位数：席位已满时会被拒绝，请先改套餐或席位。"],
    confirmLabel: "分配",
    run: () => api.post(`${api.T(w.tid)}/seats/${api.seg(w.aid)}/assign`),
  });
  if (ok) (toast("已分配席位"), reload());
}
async function revokeSeatOf(w, p, seatRec, reload) {
  const ok = await confirmAction({
    title: "收回席位",
    danger: true,
    lead: h("p", {}, `${p.name ?? ""} · ${w.name ?? w.tid}`),
    consequences: ["这名成员不能再用 AI（本机功能照常）；", "席位空出可分给别人；用量记录保留。"],
    confirmLabel: "收回",
    run: () => api.post(`${api.T(w.tid)}/seats/${api.seg(w.dd?.uid ?? seatRec.sid)}/revoke`),
  });
  if (ok) (toast("已收回席位"), reload());
}
async function limitsOf(w, p, reload) {
  const acc = w.acc;
  const custom = acc.device_limit_custom === undefined ? null : acc.device_limit_custom;
  const r = await confirmAction({
    title: "电脑数上限",
    lead: h("p", {}, `${p.name ?? ""} · ${wsLabel(w)} · 现在同时登录 ${fmt.int(acc.device_limit)} 台（${LIMIT_SOURCE[acc.device_limit_source] ?? "生效值"}）`),
    fields: [{ name: "device_limit", label: "同时登录的电脑数上限", type: "number", min: 1, max: 9, value: custom ?? "", hint: "1–9；留空 = 按套餐。登录中、未移除的电脑才占名额；每个工作空间分别计" }],
    validate: (v) => (v.device_limit !== null && !(Number.isInteger(v.device_limit) && v.device_limit >= 1 && v.device_limit <= 9) ? "填 1–9 的整数，或留空" : null),
    consequences: ["只影响新登录的电脑；已登录的电脑不会被强制退出。"],
    confirmLabel: "保存",
    run: (v) => (v.device_limit !== custom ? api.post(`${api.A(w.aid)}/limits`, { device_limit: v.device_limit }) : { ok: true, unchanged: true }),
  });
  if (r) (toast(r.unchanged ? "没有改动" : "已保存"), reload());
}
async function enableWs(w, p, reload) {
  const ok = await confirmAction({ title: `启用 ${p.name ?? ""} · ${wsLabel(w)}`, consequences: ["本人可再次登录这个工作空间；之前失效的登录不恢复，须重新登录；", "同时解除登录失败锁定。"], confirmLabel: "启用", run: () => api.post(`${api.A(w.aid)}/enable`) });
  if (ok) (toast("已启用"), reload());
}
async function disableWs(w, p, reload) {
  const team = kindOf(w) === "team";
  const devs = (w.devices ?? []).filter((x) => deviceState(x) !== "revoked");
  const seatRec = w.dd?.seat && !w.dd.seat.revoked_at ? w.dd.seat : null;
  const canRevoke = can("device.revoke");
  const r = await confirmAction({
    title: `停用 ${p.name ?? ""} · ${wsLabel(w)}`,
    danger: true,
    consequences: [
      "这个工作空间的全部登录立即失效：名下电脑约 15 秒内暂停 AI（本机功能照常）；",
      "记为“平台停用”：团队管理员不能自行启用，只有平台人员能启用；",
      team ? "这个人的其他工作空间（个人空间、别的团队）不受影响；" : "这个人加入的团队不受影响；",
      "用量与审计记录保留。",
    ],
    fields: [
      { name: "reason", label: "停用原因（记入审计，本人可见）", type: "textarea", required: true, maxlength: 100 },
      seatRec && canRevoke ? { name: "seat", label: "同时收回席位", type: "checkbox", value: true, hint: "离职时勾上：席位空出可分给别人" } : null,
      devs.length && canRevoke ? { name: "devices", label: `同时移除这个工作空间里的 ${devs.length} 台电脑`, type: "checkbox", value: false, hint: "停用后这些电脑已不能用 AI；只有电脑丢失或要回收时才需要移除" } : null,
    ].filter(Boolean),
    typeToConfirm: w.name && team ? w.name : (p.name ?? w.aid),
    typeLabel: team ? "再输入一次团队名称以确认：" : "再输入一次姓名以确认：",
    confirmLabel: "停用",
    run: async (v) => {
      await api.post(`${api.A(w.aid)}/disable`, { reason: v.reason });
      const done = ["已停用"];
      const bad = [];
      if (v.seat && seatRec) await api.post(`${api.T(w.tid)}/seats/${api.seg(w.dd?.uid ?? seatRec.sid)}/revoke`).then(() => done.push("已收回席位"), (e) => bad.push(`收回席位：${e.message}`));
      if (v.devices) for (const x of devs) await api.post(`${api.T(w.tid)}/devices/${api.seg(x.device_id)}/revoke`).then(() => {}, (e) => bad.push(`${x.name ?? x.device_id}：${e.message}`));
      if (v.devices && bad.length < devs.length) done.push("已移除电脑");
      return { done, bad };
    },
  });
  if (r) (toast(`${r.done.join("，")}${r.bad.length ? `；未完成：${r.bad.join("；")}` : ""}`, r.bad.length ? "error" : "ok"), reload());
}

/** 电脑按工作空间分组（D-306 第 3 条）：每个工作空间一张表；没有电脑的工作空间收成一行说明 */
function devicePanels(ws, devsOf, reload) {
  const withDevs = ws.filter((w) => devsOf(w).length || (w.dd?.join_requests_pending ?? []).length);
  const none = ws.filter((w) => !withDevs.includes(w));
  const out = withDevs.map((w) =>
    panel(
      `电脑 · ${wsLabel(w)}`,
      deviceTable([...devsOf(w), ...(w.dd?.join_requests_pending ?? []).map((j) => pendingRow({ ...j, aid: w.aid, member_name: w.acc.name }, { tid: w.tid, tenant_name: w.name }))], { state: { sort: "state", asc: true }, after: reload, showTenant: false, showMember: false, onRow: false, team: kindOf(w) === "team" }),
      { flush: true, sub: kindOf(w) === "personal" ? "个人空间：新电脑直接登录；“让它退出登录”可逆，“移除这台电脑”不可逆" : "这个团队里的电脑：“让它退出登录”可逆，资料留在那台电脑上；“移除这台电脑”不可逆" },
    ),
  );
  if (!withDevs.length) out.push(panel("电脑", note("还没有登记电脑：在客户端用这个账号登录后出现在这里（按工作空间分组）。")));
  else if (none.length) out.push(note(`${none.map(wsLabel).join("、")}：还没有登记电脑。`));
  return out;
}

/** 本期用量（逐工作空间：分母是个人上限或套餐每人额度，与成员端同一说法） */
function usagePanel(ws) {
  const list = ws.filter((w) => w.dd?.usage && w.status !== "disabled");
  if (!list.length) return null;
  return panel(
    "本期用量",
    h("div", { class: "stack-sm" }, list.map((w) => ((u) => meter({ label: wsLabel(w), ratio: u.used_ratio, used: u.used, total: u.total, unit: u.unit, denominator: DENOMINATOR[u.denominator] ?? (u.total === null ? "不单设上限" : null), resetsAt: u.period?.resets_at ?? null }))(w.dd.usage))),
    { sub: "按工作空间分别计；个人空间与团队的额度互不相通" },
  );
}
function identityPanel(p, a) {
  return panel(
    "身份",
    facts([
      ["用户编号", h("span", {}, mono(a.aid), copyBtn(a.aid, "复制"))],
      ["手机号", p.phone_masked ?? "未绑定"],
      ["邮箱", a.email ?? "—"],
      ["已设密码", a.has_password === true ? "是" : a.has_password === false ? badge("未设（待本人凭设置密码码设置）", "warn") : "—"],
      ["注册方式", `${CREATED_VIA[a.created_via] ?? (a.created_via === "team_invite" ? "团队邀请" : a.created_via ?? "—")}${a.invite_id ? `（邀请码 ${a.invite_id}）` : ""}`],
      ["注册于", fmt.full(a.created_at)],
    ]),
    { sub: "手机号、邮箱、密码只在这个人身上，各工作空间共用" },
  );
}
function sessionsPanel(sessions, devs) {
  return panel(
    "登录会话",
    dataTable({
      state: { sort: "last_seen_at", asc: false },
      rows: sessions,
      empty: "没有登录会话",
      columns: [
        { key: "ws", label: "工作空间", value: (s) => wsLabel(s.ws) },
        { key: "kind", label: "类型", value: (s) => ({ desktop: "桌面端", web: "网页" })[s.kind] ?? s.kind },
        { key: "device_id", label: "电脑", value: (s) => s.device_id ?? "", render: (s) => ((x) => (s.device_id ? (x ? deviceLabel(x) : "已移除的电脑") : h("span", { class: "muted" }, "—")))(devs.find((y) => y.device_id === s.device_id)) },
        { key: "last_seen_at", label: "最近活动", value: (s) => s.last_seen_at ?? "", render: (s) => h("span", { title: `登录于 ${fmt.full(s.created_at)}` }, fmt.ago(s.last_seen_at)) },
      ],
    }),
    { flush: true, sub: "一台电脑同一时间只有一个登录" },
  );
}

/**
 * 登录诊断（第 71 批起；第 72 批按“人 + 工作空间”）：身份（锁定、密码）一条，之后逐工作空间列阻止登录或用 AI 的原因——
 * 工作空间停用（平台 / 团队）、同时登录已满、席位、客户状态与暂停、个人额度、待批准的新电脑。有问题时排在最前并展开；都正常时收成一行。
 */
function diagnosis({ p, a, ws, locked, enable, reload }) {
  const rows = [];
  const row = (tone, text, ...acts) => rows.push({ tone, text, acts: acts.filter(Boolean) });
  if (locked) row("warn", `登录已锁定：登录失败次数过多${a.locked_s ? `，约 ${Math.max(1, Math.ceil(a.locked_s / 60))} 分钟后自动解除` : ""}`, btn("解锁…", () => enable(a, true), { size: "sm", disabled: !canSupport() }));
  else row("ok", `身份正常：${p.phone_masked ? "已绑手机号" : "未绑手机号"}${a.has_password === false ? "" : "，已设密码"}`);
  if (a.has_password === false) row("warn", "还没设密码：只能用手机号验证码登录，或用设置密码码设置");
  if (ws.length && ws.every((w) => w.status === "disabled")) row("bad", "全部工作空间都已停用：这个人现在登不上");
  for (const w of ws) {
    const L = `${wsLabel(w)}：`;
    const team = kindOf(w) === "team";
    const t = w.dd?.tenant ?? null;
    if (w.status === "disabled") {
      const k = wsStatus(w);
      row(k === "platform" ? "warn" : "info", `${L}${k === "platform" ? "平台停用" : k === "team" ? "已移出团队" : "已停用"}${w.acc.disabled_reason ? `（${w.acc.disabled_reason}）` : ""}`, k !== "team" ? btn("启用…", () => enableWs(w, p, reload), { size: "sm", disabled: !canSupport() }) : null);
      continue;
    }
    const on = (w.devices ?? []).filter((x) => deviceState(x) === "signed_in");
    const lim = Number(w.acc.device_limit) || 0;
    // 验收 Q-6（D-298 / D-303）：满额不是故障——新电脑登录时会出选择页，本人可选一台退出；这里是中性提示，运营也可代为让一台退出
    if (lim && on.length >= lim)
      row(
        "info",
        `${L}已达同时登录上限（${on.length} / ${lim} 台）：在新电脑登录时可选一台退出`,
        btn("让一台退出登录…", () => pickOne(on, "让哪台电脑退出登录？", "可逆：那台电脑上的资料保留，之后可以再登录").then((x) => x && signoutDevice({ ...x, aid: x.aid ?? w.aid, tid: x.tid ?? w.tid }, reload)), { size: "sm", disabled: !canSupport() }),
        btn("改电脑数上限", () => limitsOf(w, p, reload), { size: "sm", disabled: !can("account.manage") }),
        btn("移除一台…", () => pickOne(on, "移除哪台电脑？", "不可逆：那台电脑不能再用这个账号").then((x) => x && revokeDevice({ ...x, tid: x.tid ?? w.tid }, reload)), { size: "sm", kind: "ghost", class: "text-danger", disabled: !can("device.revoke") }),
      );
    else row("ok", `${L}电脑 ${on.length} / ${lim} 台在线，还能再登录 ${Math.max(0, lim - on.length)} 台`);
    if (team && !w.seat && t) {
      const free = Math.max(0, Number(t.seats) - Number(t.seats_used));
      if (free > 0) row("info", `${L}未占席：第一次在电脑上用 AI 时自动占用（还有 ${free} 个空席）`, btn("分配席位…", () => assignSeat(w, p, reload), { size: "sm", disabled: !can("device.revoke"), title: needs("device.revoke") }));
      else row("warn", `${L}席位已满：用不了 AI，请改套餐或席位`, btn("去组织详情", () => go(`tenants/${encodeURIComponent(w.tid)}?tab=subscription`), { size: "sm" }));
    }
    if (t) {
      if (t.status !== "active") row("bad", `${L}${({ pending: "待开通", expired: "已到期", terminated: "已终止" })[t.status] ?? t.status}：${t.status === "pending" ? "还没有在电脑上完成开通（第一次在客户端登录即完成）" : "不签发用 AI 的凭证"}`, btn("去看订阅", () => go(`tenants/${encodeURIComponent(w.tid)}?tab=subscription`), { size: "sm" }));
      else if (t.paused) row("bad", `${L}已暂停（${PAUSED[t.paused] ?? t.paused}），这里的 AI 全部暂停`, btn("去加量", () => go(`tenants/${encodeURIComponent(w.tid)}?tab=subscription`), { size: "sm" }));
      else row("ok", `${L}订阅正常，到 ${fmt.date(t.subscription_until)}，没有暂停`);
    }
    const u = w.dd?.usage;
    if (u?.enforced && Number(u.used_ratio) >= 1) row("bad", `${L}${PAUSED.seat}：这个工作空间的 AI 已暂停`, btn("改个人上限", () => go(`tenants/${encodeURIComponent(w.tid)}?tab=members`), { size: "sm" }));
    const joins = w.dd?.join_requests_pending ?? [];
    const admins = w.dd?.firm_admins ?? [];
    if (joins.length) row("warn", `${L}有 ${joins.length} 台新电脑待团队管理员批准${admins.length ? `：请联系 ${admins.map((x) => [x.name, x.phone ?? x.email].filter(Boolean).join(" ")).join("、")}` : ""}`);
  }
  const ICON = { bad: ["✕", "danger"], warn: ["!", "warn"], ok: ["✓", "ok"], info: ["·", "info"] };
  const order = ["bad", "warn", "info", "ok"];
  const list = h("ul", { class: "diag" }, rows.sort((x, y) => order.indexOf(x.tone) - order.indexOf(y.tone)).map((r) => h("li", { class: `diag-row tone-${ICON[r.tone][1]}` }, h("span", { class: "diag-icon", "aria-hidden": "true" }, ICON[r.tone][0]), h("span", { class: "diag-text" }, r.text), r.acts.length ? h("span", { class: "btn-row" }, r.acts) : null)));
  const problems = rows.filter((r) => r.tone === "bad" || r.tone === "warn").length;
  return problems ? panel("登录诊断", list, { tone: "warn", sub: `发现 ${problems} 个可能阻止登录或使用 AI 的原因` }) : h("div", { class: "panel flush diag-fold" }, fold("登录诊断", "没有发现阻止登录或使用 AI 的原因", list));
}
/** 在几台电脑里点选一台（按名字认，编号放后面） */
async function pickOne(list, title, lead) {
  if (list.length === 1) return list[0];
  const v = await confirmAction({
    title,
    lead: h("p", { class: "muted" }, lead),
    fields: [{ name: "id", label: "电脑", type: "radio", options: list.map((x) => [x.device_id, x.name || "未命名的电脑", `${x.device_id} · 客户端 ${x.client_version ?? "—"} · 最近报到 ${x.last_seen_on ? fmt.ago(x.last_seen_on) : "从未"}`]), value: list[0].device_id }],
    confirmLabel: "下一步",
  });
  return v ? list.find((x) => x.device_id === v.id) ?? null : null;
}
