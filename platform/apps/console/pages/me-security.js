/**
 * 我的 · 账号与安全（成员与平台人员都有）：资料、改密码、登录记录与下线、外观。
 * 接口：GET /v1/auth/me；POST /v1/auth/password、/sessions/{sid}/revoke（契约 §3.1）。
 */
import * as api from "../api.js";
import { passwordHint } from "../auth.js";
import { CREATED_VIA, ctx, pageHead, roleLabel, roleText } from "../domain.js";
import { badge, btn, clear, closeDrawer, confirmAction, dataTable, errText, facts, fmt, h, load, mono, panel, segmented, toast } from "../ui.js";

const KIND = { web: "网页", desktop: "Windows 客户端" };

export function render(page) {
  page.append(pageHead("账号与安全", "资料、密码与登录记录"));
  const box = h("div", { class: "stack" });
  page.append(box);
  load(box, () => api.auth.me(), (me) => {
    ctx.me = { ...ctx.me, ...me };
    draw(box, ctx.me);
  }, "正在读取账号…");
}

function draw(box, me) {
  const a = me.account ?? {};
  const staff = ctx.kind === "staff";
  clear(
    box,
    h(
      "div",
      { class: "grid-2" },
      panel(
        "资料",
        facts([
          ["姓名", a.name],
          ["邮箱", a.email],
          staff ? ["角色", h("span", { class: "badges" }, (a.roles ?? []).map((r) => badge(roleLabel(r), "neutral")))] : ["律所", me.firm?.name ?? a.org?.name ?? a.tid],
          staff ? null : ["本所角色", roleText(ctx.firmRole)],
          staff ? null : ["加入方式", CREATED_VIA[a.created_via] ?? a.created_via ?? "—"],
          ["注册于", fmt.full(a.created_at)],
          ["上次登录", fmt.full(a.last_login_at)],
        ]),
        { sub: staff ? "中软平台人员" : "律所成员" },
      ),
      passwordPanel(a),
    ),
    h("div", { class: "grid-2" }, appearancePanel()),
    sessionsPanel(me, () => render.reloadBox?.()),
  );
  render.reloadBox = () => load(box, () => api.auth.me(), (m) => ((ctx.me = { ...ctx.me, ...m }), draw(box, ctx.me)), "正在读取账号…");
}

function passwordPanel(a) {
  const err = h("p", { class: "form-error", role: "alert" });
  const inp = (name, label, auto, hint) => h("div", { class: "field" }, h("label", { for: `pw-${name}` }, label), h("input", { id: `pw-${name}`, name, type: "password", autocomplete: auto }), hint ? h("small", { class: "hint" }, hint) : null);
  const ok = h("button", { type: "submit", class: "btn primary" }, "保存新密码");
  const f = h("form", { class: "settings-form", novalidate: true }, h("input", { type: "text", name: "username", autocomplete: "username", value: a.email ?? "", hidden: true }), inp("current", "当前密码", "current-password"), inp("next", "新密码", "new-password", "至少 10 位，同时包含字母和数字，不含邮箱前缀。"), inp("again", "再输入一次新密码", "new-password"), err, h("div", { class: "btn-row" }, ok));
  f.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    err.textContent = "";
    const current = f.current.value;
    const next = f.next.value;
    if (!current) return void (err.textContent = "请输入当前密码");
    const bad = passwordHint(next, f.again.value, a.email);
    if (bad) return void (err.textContent = bad);
    if (next === current) return void (err.textContent = "新密码不能与当前密码相同");
    ok.disabled = true;
    try {
      const r = await api.auth.password(current, next);
      f.reset();
      toast(r.other_sessions_revoked ? `密码已更新，另有 ${r.other_sessions_revoked} 处登录已退出` : "密码已更新");
    } catch (e) {
      err.textContent = errText(e);
    } finally {
      ok.disabled = false;
    }
  });
  return panel("修改密码", f, { sub: "保存后，你在其他地方的登录会全部退出" });
}

function appearancePanel() {
  const box = h("div");
  const draw = () => clear(box, segmented([{ id: "system", label: "跟随系统" }, { id: "light", label: "浅色" }, { id: "dark", label: "深色" }], ctx.themePref?.() ?? "system", (v) => (ctx.setTheme?.(v), draw()), "主题"));
  draw();
  return panel("外观", h("div", { class: "stack-sm" }, box, h("p", { class: "muted small" }, "只记在这台电脑的浏览器里。")));
}

function sessionsPanel(me, reload) {
  const rows = me.sessions ?? [];
  const others = rows.filter((s) => !s.current);
  const revoke = async (s) => {
    const r = await confirmAction({ title: "下线这处登录", consequences: [`${KIND[s.kind] ?? s.kind} · ${fmt.full(s.created_at)} 登录的会话立即失效；`, "对方要再用须重新输入密码。"], confirmLabel: "下线", run: () => api.auth.revokeSession(s.sid) });
    if (r) (toast("已下线"), reload());
  };
  const revokeOthers = async () => {
    const r = await confirmAction({
      title: "让其他登录全部下线",
      danger: true,
      consequences: [`除本页外的 ${others.length} 处登录立即失效（含 Windows 客户端）；`, "客户端要再用须重新登录；正在进行的任务会在下一次调用 AI 时失败。"],
      confirmLabel: "全部下线",
      run: async () => {
        for (const s of others) await api.auth.revokeSession(s.sid);
        return true;
      },
    });
    if (r) (toast("其他登录已全部下线"), reload());
  };
  return panel(
    "登录记录",
    dataTable({
      rows,
      state: { sort: "last_seen_at", asc: false },
      empty: "没有在用的登录",
      columns: [
        { key: "kind", label: "位置", render: (s) => h("span", { class: "cell-2" }, h("b", {}, KIND[s.kind] ?? s.kind ?? "—"), s.client?.version || s.client?.platform ? h("small", {}, [s.client?.platform, s.client?.version].filter(Boolean).join(" ")) : null) },
        { key: "device_id", label: "电脑", render: (s) => (s.device_id ? mono(s.device_id) : "—") },
        { key: "created_at", label: "登录于", render: (s) => fmt.full(s.created_at) },
        { key: "last_seen_at", label: "最近活动", render: (s) => h("span", { title: fmt.full(s.last_seen_at) }, fmt.ago(s.last_seen_at)) },
        { key: "idle_expires_at", label: "闲置到期", render: (s) => fmt.time(s.idle_expires_at) },
        { key: "_act", label: "", sortable: false, class: "act", render: (s) => (s.current ? badge("本页", "accent") : btn("下线", () => revoke(s), { size: "sm" })) },
      ],
    }),
    { sub: "不认识的登录请立即下线并修改密码", actions: others.length ? btn("其他全部下线", revokeOthers, { size: "sm", kind: "danger" }) : null },
  );
}
