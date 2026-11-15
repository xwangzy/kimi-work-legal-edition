/**
 * 运营控制台 · 业务词表与共用块（第 44 批）：状态与枚举的中文、告警列表、设备表与吊销、权限判断、路由跳转。
 * 字段名一律照《运营接口契约》（research/2026-11-14-V19云端账号路由计量/03-运营接口契约.md），不自创。
 */
import * as api from "./api.js";
import { badge, btn, confirmAction, dataTable, dot, fmt, h, mono, toast } from "./ui.js";

/** 全局上下文：app.js 登录后填入 */
export const ctx = {
  /** 当前运营的权限集合；null = 未知（系统页接口未就绪），交由控制面判定 */
  perms: null,
  operatorId: "",
  /** 律所列表缓存（下拉框用）：{tid, name}[] | null */
  tenants: null,
  openAccount: null,
  reload: () => {},
};
export const can = (perm) => !ctx.perms || ctx.perms.has(perm);
export const needs = (perm) => (can(perm) ? undefined : `需要权限 ${perm}`);
export const go = (path) => {
  const next = `#/${path}`;
  if (location.hash === next) ctx.reload();
  else location.hash = next;
};

export const ROLE = { admin: "管理员", partner: "合伙人", lawyer: "律师", assistant: "助理" };
export const TENANT_STATUS = { active: ["正常", "ok"], pending: ["待开通", "info"], expired: ["已到期", "warn"], terminated: ["已终止", "neutral"] };
export const ACCOUNT_STATUS = { active: ["正常", "ok"], disabled: ["已停用", "danger"] };
export const CREATED_VIA = { self: "自助注册", founder_code: "开通码", invite_code: "邀请码", ops: "运营代建" };
export const DEVICE_FLAG = { stale: ["30 天未报到", "warn"], outdated: ["版本过旧", "warn"], suspended: ["暂停后仍有请求", "danger"] };
export const PROVIDER_STATE = {
  up: ["正常", "ok"],
  degraded: ["降级", "warn"],
  down: ["不可用", "danger"],
  blocked_by_allowlist: ["不在网关白名单", "danger"],
  key_unusable: ["密钥解不开", "danger"],
  disabled: ["已停用", "neutral"],
  unknown: ["未上报", "neutral"],
};
export const ALERT_KIND = { threshold: "跨过阈值", cap: "到上限", exhausted: "额度用完", anomaly: "用量异常", route_down: "上游不可用", device_flag: "设备异常" };
export const ALERT_LEVEL = { info: ["提示", "info"], warn: ["注意", "warn"], critical: ["严重", "danger"] };
export const OUTCOME = { ok: ["成功", "ok"], client_gone: ["客户端断开", "warn"], upstream_error: ["上游出错", "danger"], timeout: ["超时", "danger"], blocked: ["已拦截", "neutral"] };
export const USAGE_SOURCE = { upstream: ["上游回执", "ok"], drained: ["断开后读完", "info"], estimated: ["估算", "warn"], none: ["无用量", "neutral"] };
export const PAUSED = { cap: "已到上限", allowance: "额度用完", burst: "5 小时窗口用满", seat: "个人额度用完" };
export const DENOMINATOR = { account_limit: "分母：个人上限", seat_quota: "分母：每席位额度（参考，不限）" };

const pick = (map, k, fallback) => map[k] ?? [k ? String(k) : fallback ?? "—", "neutral"];
export const tenantBadge = (s) => badge(...pick(TENANT_STATUS, s));
export const accountBadge = (a) => [badge(...pick(ACCOUNT_STATUS, a?.status), a?.disabled_reason ? `停用原因：${a.disabled_reason}` : undefined), a?.locked ? badge("已锁定", "warn", "登录失败次数过多，暂时锁定") : null];
export const providerBadge = (health, enabled) => {
  if (enabled === false) return badge("已停用", "neutral");
  if (!health || health.state === "unknown") return badge("未上报", "neutral", "网关还没有回报这个上游的健康（网关没连上控制面，或刚登记）");
  const [t, tone] = pick(PROVIDER_STATE, health.state);
  return h("span", { class: "state-cell" }, dot(tone), t);
};
export const outcomeBadge = (o) => badge(...pick(OUTCOME, o));
export const sourceBadge = (s) => (s === "upstream" ? null : badge(...pick(USAGE_SOURCE, s)));
export const roleText = (r) => ROLE[r] ?? r ?? "—";

/** 告警列表（总览“需要关注”、套餐与额度页、账号抽屉） */
export function alertList(alerts, { onAck, compact } = {}) {
  if (!alerts?.length) return h("div", { class: "state state-empty small" }, h("b", {}, "没有未确认的告警"));
  return h(
    "ul",
    { class: ["alerts", compact && "compact"] },
    alerts.map((a) => {
      const [lv, tone] = pick(ALERT_LEVEL, a.level);
      const who = [a.tenant_name ?? a.tid, a.email, a.provider ? `上游 ${a.provider}` : null].filter(Boolean).join(" · ");
      const ack = onAck && !a.acked_at
        ? btn("确认", async (ev) => {
            const b = ev.currentTarget;
            b.disabled = true;
            try {
              await api.post(`/v1/ops/alerts/${api.seg(a.id)}/ack`);
              toast("已确认告警");
              onAck(a);
            } catch (e) {
              b.disabled = false;
              toast(e.message, "error");
            }
          }, { size: "sm" })
        : a.acked_at
          ? h("span", { class: "muted small" }, `${a.acked_by ?? ""} 已确认`)
          : null;
      return h(
        "li",
        { class: `alert lv-${tone}` },
        h("span", { class: `alert-bar tone-${tone}`, "aria-hidden": "true" }),
        h(
          "div",
          { class: "alert-main" },
          h("div", { class: "alert-top" }, badge(lv, tone), h("b", {}, ALERT_KIND[a.kind] ?? a.kind), who ? h("span", { class: "alert-who" }, who) : null, h("time", { class: "alert-at", datetime: a.at }, fmt.time(a.at))),
          h("div", { class: "alert-msg" }, a.message ?? ""),
        ),
        ack,
      );
    }),
  );
}

/** 吊销设备（现有吊销机制：设备进吊销集、网关拒绝；绑在该设备上的会话一并吊销） */
export async function revokeDevice(d, after) {
  const r = await confirmAction({
    title: "吊销设备",
    danger: true,
    lead: h("p", {}, `${d.tenant_name ?? d.tid} · ${d.email ?? d.uid ?? ""}`),
    consequences: [
      "该设备立即进吊销集：网关拒绝它的席位令牌，约 15 秒内生效；",
      "绑在这台设备上的登录会话一并吊销；",
      "不可撤销：这台电脑要再用，须重新登录并由律所管理员批准入组。",
    ],
    typeToConfirm: d.device_id,
    typeLabel: "再输入一次设备编号以确认：",
    confirmLabel: "吊销设备",
    run: () => api.post(`${api.T(d.tid)}/devices/${api.seg(d.device_id)}/revoke`),
  });
  if (r) {
    toast(`已吊销 ${d.device_id}`);
    after?.();
  }
}

/** 设备表（设备页、律所详情、账号抽屉共用） */
export function deviceTable(rows, { state, after, showTenant = true, empty } = {}) {
  const cols = [
    { key: "device_id", label: "设备编号", render: (d) => mono(d.device_id) },
    showTenant ? { key: "tenant_name", label: "律所", value: (d) => d.tenant_name ?? d.tid } : null,
    { key: "email", label: "账号", value: (d) => d.email ?? d.uid, render: (d) => (d.aid && ctx.openAccount ? h("button", { type: "button", class: "link", onclick: () => ctx.openAccount(d.aid) }, d.email ?? d.aid) : d.email ?? mono(d.uid)) },
    { key: "role", label: "角色", value: (d) => roleText(d.role) },
    { key: "client_version", label: "客户端", render: (d) => mono(d.client_version ?? "—") },
    { key: "last_seen_on", label: "最近报到", value: (d) => d.last_seen_on ?? "", render: (d) => h("span", { title: fmt.full(d.last_seen_on) }, fmt.ago(d.last_seen_on)) },
    { key: "session", label: "会话", render: (d) => (d.session === "active" ? badge("在线会话", "ok") : badge("无会话", "neutral")) },
    { key: "flags", label: "标记", value: (d) => (d.flags ?? []).length, render: (d) => ((d.flags ?? []).length ? h("span", { class: "badges" }, d.flags.map((f) => badge(...pick(DEVICE_FLAG, f)))) : "") },
    { key: "revoked_at", label: "状态", value: (d) => (d.revoked_at ? 1 : 0), render: (d) => (d.revoked_at ? badge(`已吊销 ${fmt.date(d.revoked_at)}`, "neutral") : badge("在用", "ok")) },
    {
      key: "_act",
      label: "",
      sortable: false,
      class: "act",
      render: (d) => (d.revoked_at ? null : btn("吊销", () => revokeDevice(d, after), { size: "sm", kind: "danger", disabled: !can("device.revoke"), title: needs("device.revoke") })),
    },
  ].filter(Boolean);
  return dataTable({ columns: cols, rows, state: state ?? { sort: "last_seen_on", asc: false }, empty: empty ?? "没有设备", rowClass: (d) => (d.revoked_at ? "dim" : (d.flags ?? []).length ? "flagged" : "") });
}

/** 页头：标题 + 说明 + 右侧操作 */
export function pageHead(title, sub, actions) {
  return h("header", { class: "page-head" }, h("div", { class: "page-titles" }, h("h1", {}, title), sub ? h("p", { class: "page-sub" }, sub) : null), actions ? h("div", { class: "page-actions" }, actions) : null);
}

/** 律所下拉（账号、设备、用量页的筛选） */
export async function tenantOptions() {
  if (!ctx.tenants) {
    try {
      const r = await api.get("/v1/ops/tenants");
      ctx.tenants = (r.tenants ?? []).map((t) => ({ tid: t.tid, name: t.name ?? t.tid }));
    } catch {
      ctx.tenants = [];
    }
  }
  return [["", "全部律所"], ...ctx.tenants.map((t) => [t.tid, `${t.name}（${t.tid}）`])];
}

export const periodText = (p) => (p ? `${p.key ?? ""}${p.kind === "week" ? " 周" : ""} · ${fmt.resets(p.resets_at) ?? "—"} 重置` : "—");
