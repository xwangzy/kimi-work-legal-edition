/**
 * 我的 · 概览（成员账号）：个人用量与本所额度水位、本期 token / 请求 / 计费金额、近 30 日走势与按模型、我的电脑、安全提示。
 * 接口：GET /v1/me/usage?days=30（契约 §3.2）；电脑与登录取自 GET /v1/auth/me（登录时已读）。
 * 三种数字分开写、不互相换算：配额百分比（ratio）、实际消耗（token）、计费金额（元，按价目计）。
 */
import * as api from "../api.js";
import { ctx, go, pageHead, PAUSED, roleText } from "../domain.js";
import { badge, clear, emptyBlock, fmt, h, hbars, icon, load, meter, panel, quotaCard, stat, trendChart } from "../ui.js";

/** 个人额度的分母与是否限制（不同说法只出一句） */
const ownNote = (own) =>
  own.denominator === "seat_quota"
    ? "按每席位额度计，只作参考，不限制使用"
    : own.denominator === "account_limit"
      ? own.enforced === false
        ? "按管理员设的个人上限计，只作参考"
        : "按管理员设的个人上限计：到上限后暂停调用 AI，本机流程不受影响"
      : null;

export function render(page) {
  const me = ctx.me;
  const a = me.account ?? {};
  const firm = me.firm?.name ?? a.org?.name ?? "";
  page.append(pageHead(`你好，${a.name ?? a.email ?? ""}`, [firm, roleText(ctx.firmRole)].filter(Boolean).join(" · ")));
  const usageBox = h("div", { class: "stack" });
  page.append(usageBox, h("div", { class: "grid-2" }, devicesPanel(me), securityPanel(me)));
  load(usageBox, () => api.get("/v1/me/usage", { days: 30 }), (u) => draw(usageBox, u), "正在读取用量…");
}

function draw(box, u) {
  const own = u.own ?? {};
  const firm = u.firm ?? {};
  const resets = u.period?.resets_at;
  const daily = u.daily ?? [];
  const tokens = daily.reduce((s, d) => s + (Number(d.tokens_in) || 0) + (Number(d.tokens_out) || 0), 0);
  const cny = daily.some((d) => d.value_cny === null) ? null : daily.reduce((s, d) => s + (Number(d.value_cny) || 0), 0);
  clear(
    box,
    h(
      "div",
      { class: "grid-2" },
      panel(
        "我的用量",
        quotaCard({
          title: "本期个人额度",
          ratio: own.used_ratio,
          used: own.used,
          total: own.total,
          unit: u.unit,
          resetsAt: resets,
          paused: firm.paused === "seat" ? "seat" : null,
          note: ownNote(own),
        }),
        { sub: u.period?.key ? `本期 ${u.period.key}` : undefined },
      ),
      panel(
        "本所额度水位",
        quotaCard({
          title: "本所本期额度",
          ratio: firm.used_ratio ?? (firm.remaining_ratio !== undefined && firm.remaining_ratio !== null ? 1 - Number(firm.remaining_ratio) : null),
          unit: u.unit,
          resetsAt: resets,
          capPct: firm.cap_pct,
          paused: firm.paused && firm.paused !== "seat" ? firm.paused : null,
          note: firm.paused ? `本所已暂停：${PAUSED[firm.paused] ?? firm.paused}，请联系律所管理员。` : "全所共用；律所管理员可设月度上限。",
          extra: u.burst ? h("div", { class: "burst" }, h("small", { class: "muted" }, `${u.burst.hours ?? 5} 小时窗口（防短时集中用量）`), meter({ label: `${u.burst.hours ?? 5} 小时窗口`, ratio: u.burst.used_ratio, resetsAt: u.burst.resets_at, compact: true })) : null,
        }),
      ),
    ),
    h(
      "div",
      { class: "kpis" },
      stat("本期请求", fmt.int(own.requests), "调用 AI 的次数"),
      stat("实际消耗", `${fmt.tokens(tokens)} token`, `近 ${daily.length || 30} 日输入 + 输出`, { title: `${fmt.int(tokens)} token` }),
      stat("计费金额", fmt.cny(own.value_cny ?? cny), "按价目计的用量价值（元）"),
      stat("占本所用量", own.estimated_share === undefined ? "—" : fmt.pct(own.estimated_share), "本期你的用量在全所中的占比"),
    ),
    h(
      "div",
      { class: "grid-2-1" },
      panel("近 30 日", daily.length ? trendChart({ labels: daily.map((d) => d.day), series: [{ name: "输入 token", values: daily.map((d) => Number(d.tokens_in) || 0), kind: "bar" }, { name: "输出 token", values: daily.map((d) => Number(d.tokens_out) || 0), kind: "bar", cls: "s2" }], format: (v) => fmt.tokens(v), tick: (l) => l.slice(5) }) : emptyBlock("这段时间没有用量", "在 Windows 客户端发起任务后，这里按北京时间日显示"), { sub: "实际消耗（token）" }),
      panel("按模型", hbars((u.by_model ?? []).map((m) => ({ label: m.label ?? m.alias, value: Number(m.tokens) || 0, note: `${fmt.pct(m.share)} · ${fmt.int(m.requests)} 次`, title: m.alias })), { format: (v) => `${fmt.tokens(v)} token`, empty: "本期还没有模型用量" })),
    ),
  );
}

function devicesPanel(me) {
  const list = (me.devices ?? []).filter((d) => !d.revoked_at);
  return panel(
    "我的电脑",
    list.length
      ? h("ul", { class: "mini-list" }, list.slice(0, 4).map((d) => h("li", {}, h("span", { class: "mini-icon", "aria-hidden": "true" }, icon("laptop")), h("span", { class: "cell-2" }, h("b", { class: "mono" }, d.device_id), h("small", {}, `${d.client_version ? `客户端 ${d.client_version} · ` : ""}最近报到 ${fmt.ago(d.last_seen_on)}`)), d.current ? badge("本机", "accent") : null)))
      : emptyBlock("还没有登记电脑", "在 Windows 客户端用本账号登录并完成入组后出现在这里"),
    { sub: me.account?.device_limit ? `至多 ${me.account.device_limit} 台` : undefined, actions: h("a", { class: "btn sm", href: "#/me/devices" }, "管理") },
  );
}

/** 安全提示：只根据已知事实（两步验证、其他登录、久未报到的电脑、未设密码），不编造 */
export function securityTips(me) {
  const a = me.account ?? {};
  const tips = [];
  if (a.mfa && !a.mfa.enabled) tips.push(["warn", "还没有启用两步验证", "启用后，别人即使知道密码也登录不了。", "me/security"]);
  if (a.mfa?.enabled && Number(a.mfa.recovery_left) <= 2) tips.push(["warn", `恢复码只剩 ${fmt.int(a.mfa.recovery_left)} 个`, "用完后手机丢失将无法登录，请重新生成。", "me/security"]);
  if (a.has_password === false) tips.push(["warn", "账号还没有设置密码", "请用管理员给的设置码设置密码。", null]);
  const others = (me.sessions ?? []).filter((s) => !s.current).length;
  if (others > 0) tips.push(["info", `另有 ${others} 处登录`, "不认识的登录请立即下线并修改密码。", "me/security"]);
  const stale = (me.devices ?? []).filter((d) => !d.revoked_at && d.last_seen_on && Date.now() - Date.parse(d.last_seen_on) > 30 * 86_400_000);
  if (stale.length) tips.push(["info", `${stale.length} 台电脑超过 30 天未报到`, "不再使用的电脑请解绑。", "me/devices"]);
  return tips;
}
function securityPanel(me) {
  const tips = securityTips(me);
  return panel(
    "安全提示",
    tips.length
      ? h("ul", { class: "tips" }, tips.map(([tone, t, d, to]) => h("li", { class: `tip tone-${tone}` }, h("span", { class: "tip-dot", "aria-hidden": "true" }), h("div", {}, h("b", {}, t), h("small", {}, d)), to ? h("button", { type: "button", class: "link small", onclick: () => go(to) }, "去处理") : null)))
      : h("div", { class: "all-good" }, h("span", { class: "ok-mark", "aria-hidden": "true" }, icon("check")), h("span", {}, "没有需要处理的安全事项")),
  );
}
