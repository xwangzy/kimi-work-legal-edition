/**
 * 我的 · 概览（成员账号）：个人用量与本所额度水位、本期 token / 请求 / 计费金额、近 30 日走势与按模型、我的电脑、安全提示。
 * 接口：GET /v1/me/usage?days=30（契约 §3.2）；电脑与登录取自 GET /v1/auth/me（登录时已读）。
 * 三种数字分开写、不互相换算：配额百分比（ratio）、实际消耗（token）、计费金额（元，按价目计）。
 */
import * as api from "../api.js";
import { ctx, deviceLabel, go, pageHead, PAUSED, roleText } from "../domain.js";
import { badge, btn, clear, confirmAction, emptyBlock, fmt, h, hbars, icon, load, meter, panel, quotaCard, stat, toast, trendChart } from "../ui.js";

/** 个人额度的分母与是否限制（不同说法只出一句；分母名称与客户端 firm-usage.ts 的 ownDenominatorText 一致） */
const ownNote = (own) =>
  own.denominator === "seat_quota"
    ? "按每人额度（套餐约定）计，仅作参考、不限制"
    : own.denominator === "account_limit"
      ? own.enforced === false
        ? "按个人上限（管理员设置）计，仅作参考"
        : "按个人上限（管理员设置）计：到上限后暂停调用 AI，本机流程不受影响"
      : null;
/** 5 小时频率限制（客户端“用量”页同一说法） */
const burstBlock = (b) =>
  h(
    "div",
    { class: "burst" },
    meter({ label: `${b.hours ?? 5} 小时频率限制`, ratio: b.used_ratio, resetsAt: b.resets_at, compact: true }),
    // 控制面 /v1/me/usage 的 burst 不带 pct（只给已用比例与恢复时刻）：没有就不写“—%”
    h("small", { class: "muted" }, [b.pct === null || b.pct === undefined ? `任意 ${b.hours ?? 5} 小时窗口` : `任意 ${b.hours ?? 5} 小时内最多用本期额度的 ${b.pct}%`, fmt.resets(b.resets_at) ? `${fmt.resets(b.resets_at)} 起逐步恢复` : null].filter(Boolean).join(" · ")),
  );

const emptyBlockSafe = (t) => h("div", { class: "state state-empty small" }, h("b", {}, t));
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
  // 第三轮：面向律师的页面不出现 token 与网关，用量用请求次数与额度比例表达
  const cny = daily.some((d) => d.value_cny === null) ? null : daily.reduce((s, d) => s + (Number(d.value_cny) || 0), 0);
  clear(
    box,
    h(
      "div",
      { class: "grid-2" },
      panel(
        "我的用量",
        quotaCard({
          title: own.denominator === "account_limit" ? "本期个人上限" : "本期每人额度",
          ratio: own.used_ratio,
          used: own.used,
          total: own.total,
          unit: u.unit,
          resetsAt: resets,
          paused: firm.paused === "seat" ? "seat" : null,
          note: ownNote(own),
        }),
        { sub: u.period ? fmt.period(u.period) : undefined },
      ),
      panel(
        "本所本期额度",
        quotaCard({
          title: "全所本期已用",
          ratio: firm.used_ratio ?? (firm.remaining_ratio !== undefined && firm.remaining_ratio !== null ? 1 - Number(firm.remaining_ratio) : null),
          unit: u.unit,
          resetsAt: resets,
          capPct: firm.cap_pct,
          paused: firm.paused && firm.paused !== "seat" ? firm.paused : null,
          note: firm.paused ? `本所已暂停：${PAUSED[firm.paused] ?? firm.paused}，请联系律所管理员。` : "全所共用；律所管理员可设月度上限。",
          extra: u.burst ? burstBlock(u.burst) : null,
        }),
      ),
    ),
    h(
      "div",
      { class: "kpis" },
      stat("本期请求", fmt.int(own.requests), "调用 AI 的次数"),
      stat("计费金额", fmt.cny(own.value_cny ?? cny), "按价目计的用量价值（元）"),
      // 控制面 own.estimated_share = 本期按估算计入的请求数 ÷ 请求数（server.ts /v1/me/usage），不是“占本所用量”
      stat("本期额度已用", fmt.pct(own.used_ratio ?? u.used_ratio), "占你本期额度的比例"),
    ),
    h(
      "div",
      { class: "grid-2-1" },
      panel("近 30 日", daily.length ? trendChart({ labels: daily.map((d) => d.day), series: [{ name: "请求", values: daily.map((d) => Number(d.requests) || 0), kind: "bar" }], format: (v) => `${fmt.int(v)} 次`, tick: (l) => l.slice(5), height: 150 }) : emptyBlockSafe("近 30 日还没有用量")),
      panel("按模型", hbars((u.by_model ?? []).map((m) => ({ label: m.label ?? m.alias, value: Number(m.requests) || 0, note: fmt.pct(m.share), title: m.alias })), { format: (v) => `${fmt.int(v)} 次`, empty: "本期还没有模型用量" })),
    ),
  );
}

function devicesPanel(me) {
  const list = (me.devices ?? []).filter((d) => !d.revoked_at);
  return panel(
    "我的电脑",
    list.length
      ? h("ul", { class: "mini-list" }, list.slice(0, 4).map((d) => h("li", {}, h("span", { class: "mini-icon", "aria-hidden": "true" }, icon("laptop")), h("span", { class: "cell-2" }, h("b", {}, deviceLabel({ ...d, member_name: "我" })), h("small", {}, `${d.client_version && d.client_version !== "legacy" ? `客户端 ${d.client_version} · ` : ""}最近在线 ${d.last_seen_on ? fmt.ago(d.last_seen_on) : "从未"}`)), d.current ? badge("本机", "accent") : null)))
      : emptyBlock("还没有登记电脑", "在客户端用本账号登录后出现在这里"),
    { sub: me.account?.device_limit ? `至多 ${me.account.device_limit} 台` : undefined, actions: h("a", { class: "btn sm", href: "#/me/devices" }, "管理") },
  );
}

/** 安全提示：只根据已知事实（其他登录、久未报到的电脑、未设密码），不编造 */
export function securityTips(me) {
  const a = me.account ?? {};
  const tips = [];
  if (a.has_password === false) tips.push(["warn", "账号还没有设置密码", "请用管理员给的设置码设置密码。", null]);
  const others = (me.sessions ?? []).filter((s) => !s.current && s.kind !== "desktop").length;
  if (others > 0) tips.push(["info", `网页登录 ${others} 处（不占电脑名额）`, "不认识的登录请立即退出并修改密码。", "me/security", "web-signout"]);
  const stale = (me.devices ?? []).filter((d) => !d.revoked_at && d.last_seen_on && Date.now() - Date.parse(d.last_seen_on) > 30 * 86_400_000);
  if (stale.length) tips.push(["info", `${stale.length} 台电脑超过 30 天没在线`, "不再使用的电脑请移除。", "me/devices"]);
  return tips;
}
/** 第四轮（24）：网页登录单列——不占电脑名额；一键让本页以外的网页登录全部退出 */
async function signoutWeb(me) {
  const list = (me.sessions ?? []).filter((x) => !x.current && x.kind !== "desktop");
  const r = await confirmAction({ title: "全部退出网页登录", consequences: [`除本页外的 ${list.length} 处网页登录立即失效；`, "电脑上的客户端登录不受影响。"], confirmLabel: "全部退出网页登录", run: async () => { for (const x of list) await api.auth.revokeSession(x.sid); return true; } });
  if (r) (toast("已退出网页登录"), ctx.reload());
}
function securityPanel(me) {
  const tips = securityTips(me);
  return panel(
    "安全提示",
    tips.length
      ? h("ul", { class: "tips" }, tips.map(([tone, t, d, to, act]) => h("li", { class: `tip tone-${tone}` }, h("span", { class: "tip-dot", "aria-hidden": "true" }), h("div", {}, h("b", {}, t), h("small", {}, act === "web-signout" ? btn("全部退出网页登录…", () => signoutWeb(me), { size: "sm" }) : d)), to ? h("button", { type: "button", class: "link small", onclick: () => go(to) }, "去处理") : null)))
      : h("div", { class: "all-good" }, h("span", { class: "ok-mark", "aria-hidden": "true" }, icon("check")), h("span", {}, "没有需要处理的安全事项")),
  );
}
