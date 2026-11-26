/**
 * 统一云端控制台 · 业务词表与共用块（第 44 批起；第 46 批加统一账号、平台角色与权限、三分区路由）：
 * 状态与枚举的中文、告警列表、设备表与吊销、权限判断、路由跳转。
 * 字段名照《运营接口契约》（research/2026-11-14-V19…/03-运营接口契约.md）与第 46 批契约 §3（research/2026-11-19-V20…/00-架构决策与接口契约.md），不自创。
 */
import * as api from "./api.js";
import { badge, btn, confirmAction, dataTable, dot, fmt, h, mono, rowMenu, stateCell, toast } from "./ui.js";

/** 全局上下文：app.js 登录后填入 */
export const ctx = {
  /** 当前平台人员的权限集合；null = 未知（控制面没给），交由控制面判定（403 显示无权限空状态） */
  perms: null,
  /** GET /v1/auth/me 的应答；kind = "member" | "staff" */
  me: null,
  kind: null,
  /** 本人标识（审计里标“我”）：人员 stf_… 或成员 acc_…，以及邮箱 */
  operatorId: "",
  operatorEmail: "",
  /** 律所列表缓存（下拉框用）：{tid, name}[] | null */
  tenants: null,
  openAccount: null,
  reload: () => {},
};
export const can = (perm) => !ctx.perms || ctx.perms.has(perm);
/** 任一权限即可（导航入口） */
export const canAny = (perms) => !perms?.length || perms.some(can);
export const PERM_LABEL = {
  "price.manage": "改价目",
  "tenant.read": "查看客户",
  "tenant.manage": "管理客户",
  "tenant.terminate": "终止客户",
  "tenant.purge": "清除客户数据",
  "quota.manage": "调整额度",
  "quota.cap": "设置律所上限",
  "plan.manage": "管理套餐",
  "account.read": "查看账号",
  "account.manage": "管理账号",
  "account.support": "账号客服",
  "device.revoke": "吊销设备",
  "activation.issue": "签发开通码",
  "usage.read": "查看用量",
  "billing.read": "查看账单",
  "route.read": "查看路由",
  "route.manage": "管理路由",
  "system.read": "查看系统",
  "staff.manage": "管理人员",
  "settings.manage": "管理设置",
  "registration.read": "查看注册管理",
  "registration.manage": "管理注册",
};
export const needs = (perm) => (can(perm) ? undefined : `你的角色没有“${PERM_LABEL[perm] ?? perm}”权限`);
/** 平台角色（GET /v1/ops/roles 未就绪时的兜底，与控制面 rbac.ts 同表；第 62 批加注册管理两项、客户运营加改价目） */
const READS = ["tenant.read", "account.read", "usage.read", "billing.read", "route.read", "system.read", "registration.read"];
export const PLATFORM_ROLES = [
  { id: "sysadmin", label: "系统管理员", description: "人员与权限、系统设置（含短信通道）、注册管理、模型与路由、套餐与价目、清除数据", perms: ["staff.manage", "settings.manage", "registration.manage", "route.manage", "price.manage", "plan.manage", "tenant.purge", ...READS] },
  { id: "operator", label: "客户运营", description: "开通与管理律所、额度、套餐与价目、注册邀请码、账号、设备", perms: ["tenant.manage", "tenant.terminate", "quota.manage", "quota.cap", "plan.manage", "price.manage", "registration.manage", "account.manage", "account.support", "device.revoke", "tenant.read", "account.read", "usage.read", "billing.read", "route.read", "registration.read"] },
  { id: "issuer", label: "开通专员", description: "签发开通码（与客户运营互斥）", perms: ["activation.issue", "tenant.read", "account.read"] },
  { id: "finance", label: "财务", description: "查看客户、用量与账单", perms: ["tenant.read", "usage.read", "billing.read"] },
  { id: "support", label: "客服", description: "账号客服（解锁、重置码）、看注册记录与只读", perms: ["account.support", "tenant.read", "account.read", "usage.read", "registration.read"] },
  { id: "viewer", label: "只读", description: "全部只读", perms: READS },
];
export const roleLabel = (id, roles = PLATFORM_ROLES) => roles.find((r) => r.id === id)?.label ?? id;
/** 三分区：#/me/…、#/firm/…、#/ops/…；旧页面里的 go("tenants/…") 等不带分区的路径一律归平台运营 */
export const SECTIONS = ["me", "firm", "ops"];
export const go = (path) => {
  const first = String(path).split(/[/?]/)[0];
  const next = `#/${SECTIONS.includes(first) ? path : `ops/${path}`}`;
  if (location.hash === next) ctx.reload();
  else location.hash = next;
};

export const ROLE = { admin: "管理员", partner: "合伙人", lawyer: "律师", assistant: "助理" };
export const isFirmManager = (role) => role === "admin" || role === "partner";
export const TENANT_STATUS = { active: ["正常", "ok"], pending: ["待开通", "info"], expired: ["已到期", "warn"], terminated: ["已终止", "neutral"] };
/** 第 71 批（V45，V-2）：危险色只给“正在影响使用”的情况；运营主动做的结果（已停用）用中性色 */
export const ACCOUNT_STATUS = { active: ["正常", "ok"], disabled: ["已停用", "neutral"], pending: ["待设置密码", "info"] };
export const CREATED_VIA = { self: "自助注册", founder_code: "开通码", invite_code: "邀请码", ops: "运营代建" };
/**
 * 电脑的异常标记（第 71 批，B-6 / P-09）：运营侧与本所侧同一口径与说法——
 *   30 天未报到；低于最低版本（云端设置的 min_version）；未登录（账号闸开着且这台电脑没有有效登录：只是暂停，不是“仍有请求”，中性色）。
 */
export const FIRM_DEVICE_FLAG = { stale_30d: ["30 天没在线", "warn"], old_client: ["低于最低版本", "warn"], rejected_after_logout: ["未登录", "neutral"] };
export const DEVICE_FLAG = { stale: ["30 天没在线", "warn"], outdated: ["低于最低版本", "warn"], suspended: ["未登录", "neutral"] };
/** 电脑状态（第 71 批）：登录中 / 已退出登录（资料还在那台电脑上，可再登录）/ 已移除（不能再用这个账号） */
export const DEVICE_STATE = { signed_in: ["登录中", "ok"], signed_out: ["已退出登录", "neutral"], pending: ["待批准", "warn"], revoked: ["已移除", "neutral"] };
/** 接口给了 state 用它；旧云端没有就按吊销时间与会话推断 */
export const deviceState = (d) => (d?.state && DEVICE_STATE[d.state] ? d.state : d?.pending ? "pending" : d?.revoked_at || d?.revoked ? "revoked" : d?.session === "active" || d?.session === true ? "signed_in" : "signed_out");
export const deviceStateCell = (d) => {
  const s = deviceState(d);
  const [t, tone] = DEVICE_STATE[s];
  return stateCell(s === "revoked" && d?.revoked_at ? `${t} ${fmt.date(d.revoked_at)}` : t, tone, s === "pending" ? "新电脑等律所管理员在其电脑上批准" : undefined);
};
/**
 * 待批准的新电脑（第 71 批第二轮，G2）：入组申请还没批，电脑表里补一行“新电脑 · 待批准 · 申请于…”。
 * j: {created_at, aid?, email?, member_name?, tid?, tenant_name?, join_id|id}
 */
export const pendingRow = (j, extra = {}) => ({ pending: true, state: "pending", device_id: null, name: null, join_id: j.join_id ?? j.id, created_at: j.created_at, aid: j.aid ?? null, email: j.email ?? null, member_name: j.member_name ?? null, tid: j.tid ?? null, tenant_name: j.tenant_name ?? null, ...extra });
/** 系统与版本的说法（第 71 批，评分区域 5）：不露 darwin / win32 / legacy 这类工程词；没上报版本的写“未上报版本” */
const PLATFORM = { win32: "Windows", windows: "Windows", darwin: "macOS", mac: "macOS", macos: "macOS", linux: "Linux" };
export const platformText = (p) => (p ? PLATFORM[String(p).toLowerCase()] ?? String(p) : "—");
export const versionText = (v) => (!v || v === "legacy" ? "未上报版本" : v);
/** 电脑的叫法：律师起的名字在前；没起名时派生“某某的 Mac / Windows 电脑”（第 71 批第二轮，07） */
export const derivedName = (d) => {
  if (d?.pending) return d?.member_name ? `${d.member_name}的新电脑` : "新电脑";
  const p = platformText(d?.platform ?? d?.client?.platform ?? null);
  const kind = p === "macOS" ? "Mac" : p === "Windows" ? "Windows 电脑" : "电脑";
  return d?.member_name ? `${d.member_name}的${/^[A-Za-z]/.test(kind) ? ` ${kind}` : kind}` : p !== "—" ? kind : "未命名的电脑";
};
export const deviceLabel = (d) => d?.name || derivedName(d);
/** 电脑单元格：名称（没起名时派生名，灰色）+ 第二行编号或申请时间 */
export const deviceCell = (d) => h("div", { class: "cell-2" }, h("b", { class: d?.name ? "" : "derived", title: d?.name ? undefined : d?.pending ? "入组申请还没批准" : "律师还没给这台电脑起名" }, deviceLabel(d)), d?.pending ? h("small", {}, `申请于 ${fmt.full(d.created_at)}`) : mono(d?.device_id));
/** 电脑数上限的来源（第 71 批，B-2） */
export const LIMIT_SOURCE = { account: "单独设置", plan: "按套餐", default: "按缺省" };
export const PROVIDER_STATE = {
  up: ["正常", "ok"],
  degraded: ["降级", "warn"],
  down: ["不可用", "danger"],
  blocked_by_allowlist: ["不在网关白名单", "danger"],
  key_unusable: ["密钥解不开", "danger"],
  disabled: ["已停用", "neutral"],
  unknown: ["未上报", "neutral"],
};
export const ALERT_KIND = { threshold: "跨过阈值", cap: "到上限", exhausted: "额度用完", anomaly: "用量异常", route_down: "上游不可用", device_flag: "设备异常", usage_missing: "上游未给用量" };
export const ALERT_LEVEL = { info: ["提示", "info"], warn: ["注意", "warn"], critical: ["严重", "danger"] };
export const OUTCOME = { ok: ["成功", "ok"], client_gone: ["客户端断开", "warn"], upstream_error: ["上游出错", "danger"], timeout: ["超时", "danger"], blocked: ["已拦截", "neutral"] };
/** 用量来源。第 62 批起 estimated 行不计费、不扣额度，待与上游账单对账（契约 contract-b62-pricing §3、§6） */
export const USAGE_SOURCE = { upstream: ["上游回执", "ok"], drained: ["断开后读完", "info"], estimated: ["估算（待对账）", "warn"], none: ["无用量", "neutral"] };
export const PAUSED = { cap: "已到上限", allowance: "额度用完", burst: "任意 5 小时窗口已满", seat: "个人额度用完" };
/** 个人用量的分母：与客户端 firm-usage.ts 的 ownDenominatorText 同一说法 */
export const DENOMINATOR = { account_limit: "按个人上限（管理员设置）计算", seat_quota: "按每人额度（套餐约定，仅作参考、不限制）计算" };

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
/**
 * 账本行的计费徽章（第 62 批口径）：待对账 = 上游没给真实用量、按估算记——不计费、不扣额度；
 * partial = 流式中途服务出错——不计费（拿到真实用量时成本照记）。原先写的“按已转发内容估算计费”与实际口径不符，已改。
 */
export const billingBadges = (r) => [
  r?.reconcile === "pending" ? badge("待对账（不计费）", "warn", r.billing_note || "上游没给真实用量，按估算记：不计入额度与金额，待与上游账单对账") : null,
  r?.partial && r?.reconcile !== "pending" ? badge("服务出错，不计费", "warn", r.billing_note || "流式中途服务出错：不扣额度、不计售价；拿到真实用量时成本照记") : null,
  r?.retry_of ? badge("重试", "info", `同一客户端请求的重试（首个请求 ${r.retry_of}）；每次都真实调用了上游，各自计费`) : null,
  r?.usage && r?.value_micro === null && r?.reconcile !== "pending" ? badge("价目生效前", "neutral", "这一行发生时价目里还没有它的价格：不改写，金额记“未定价”") : null,
];
export const firmFlagBadge = (f) => badge(...pick(FIRM_DEVICE_FLAG, f));
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
      // 第 71 批（P-12）：告警里的客户与账号可点
      const link = (text, to) => h("button", { type: "button", class: "link", onclick: () => go(to) }, text);
      const whoParts = [a.tid ? link(a.tenant_name ?? a.tid, `ops/tenants/${encodeURIComponent(a.tid)}`) : null, a.aid ? link(a.email ?? a.aid, `ops/accounts/${encodeURIComponent(a.aid)}`) : a.email ?? null, a.provider ? `上游 ${a.provider}` : null].filter(Boolean);
      const who = whoParts.length ? whoParts.flatMap((x, i) => (i ? [" · ", x] : [x])) : null;
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
          h("div", { class: "alert-top" }, badge(lv, tone), h("b", {}, ALERT_KIND[a.kind] ?? a.kind), who ? h("span", { class: "alert-who" }, ...who) : null, h("time", { class: "alert-at", datetime: a.at }, fmt.time(a.at))),
          h("div", { class: "alert-msg" }, a.message ?? ""),
        ),
        ack,
      );
    }),
  );
}

/**
 * 移除这台电脑（第 71 批，V45：原“吊销”，与律师端“移除这台电脑”同一说法；机制不变——设备进吊销集、网关拒绝，绑在上面的登录一并失效）。
 * 不可撤销，所以要确认；但不再要求输入整串编号，只输编号末段（V-15）。
 */
export async function revokeDevice(d, after) {
  const tail = String(d.device_id ?? "").split(/[_:]/).filter(Boolean).pop() ?? d.device_id;
  const r = await confirmAction({
    title: "移除这台电脑",
    danger: true,
    lead: h("p", {}, h("b", {}, deviceLabel(d)), d.name ? h("span", { class: "muted" }, " · ", mono(d.device_id)) : null, h("br"), h("span", { class: "muted small" }, [d.tenant_name ?? d.tid, d.email].filter(Boolean).join(" · "))),
    consequences: [
      "这台电脑立即不能再用这个账号调用 AI，上面的登录一并失效（约 15 秒内生效）；",
      "电脑上的本地事项与材料不会被删除；",
      "不可撤销：用于电脑丢失或不再使用。只想让它退出登录、以后还要用，请选“让它退出登录”。",
    ],
    typeToConfirm: tail,
    typeLabel: "输入编号末段以确认：",
    confirmLabel: "移除这台电脑",
    run: () => api.post(`${api.T(d.tid)}/devices/${api.seg(d.device_id)}/revoke`),
  });
  if (r) {
    toast(`已移除 ${deviceLabel(d)}`);
    after?.();
  }
}

/** 云端还没有这个接口（控制面版本早于第 71 批）时的说法 */
const tooOld = (e) => e?.code === "not_ready" || (e?.status === 404 && !e?.code);
/**
 * 让它退出登录（第 71 批，V45）：可逆——那台电脑上的资料保留，之后可以再登录；只是腾出“同时登录”的名额。
 * 接口 POST /v1/ops/accounts/{aid}/devices/{device_id}/signout（account.support），应答 { ok, signed_out: 会话数 }。
 */
export async function signoutDevice(d, after) {
  if (!d.aid) return toast("这台电脑没有关联账号，不能单独退出登录", "error");
  const r = await confirmAction({
    title: "让这台电脑退出登录",
    lead: h("p", {}, h("b", {}, deviceLabel(d)), d.email ? h("span", { class: "muted" }, ` · ${d.email}`) : null),
    consequences: ["这台电脑上的登录立即失效，腾出一个“同时登录”的名额；", "电脑上的资料保留，律师之后在这台电脑上重新登录即可继续用；", "不移除这台电脑。"],
    confirmLabel: "让它退出登录",
    run: async () => {
      try {
        return await api.post(`${api.A(d.aid)}/devices/${api.seg(d.device_id)}/signout`);
      } catch (e) {
        if (tooOld(e)) throw Object.assign(new Error("云端版本过旧：这台控制面还不支持“让它退出登录”，请先升级云端；也可以“移除这台电脑”"), { code: "cloud_outdated" });
        throw e;
      }
    },
  });
  if (r) {
    toast(r.signed_out ? `已退出 ${fmt.int(r.signed_out)} 个登录` : "已退出登录");
    after?.();
  }
}

/** 一台电脑能做的事（行尾菜单与账号详情共用） */
export function deviceActions(d, after) {
  const s = deviceState(d);
  if (s === "revoked") return [];
  if (s === "pending")
    return [
      d.admins_text ? { label: "复制管理员联系方式", onClick: () => navigator.clipboard?.writeText(d.admins_text).then(() => toast("已复制"), () => toast(d.admins_text, "info")) } : null,
      d.tid ? { label: "查看申请记录", onClick: () => go(`ops/tenants/${encodeURIComponent(d.tid)}?tab=log`) } : null,
      { label: "由律所管理员在其电脑上批准", disabled: true, title: "运营这里只能查看" },
    ];
  const fp = String(d.device_id ?? "").startsWith("fp:");
  return [
    s === "signed_in" ? { label: "让它退出登录…", onClick: () => signoutDevice(d, after), disabled: !canSupport() || !d.aid, title: !canSupport() ? needs("account.support") : !d.aid ? "没有关联账号" : undefined } : null,
    { label: "移除这台电脑…", danger: true, onClick: () => revokeDevice(d, after), disabled: !can("device.revoke"), title: needs("device.revoke") ?? (fp ? "没有账号的成员：按证书指纹移除" : undefined) },
  ];
}
/** 客服动作：账号管理或账号客服任一即可（契约 §2.2） */
export const canSupport = () => can("account.manage") || can("account.support");

/**
 * 电脑表（电脑页、客户详情、账号详情共用；第 71 批重做）：首列是律师起的名字，编号放第二行；状态用圆点；
 * 退出登录 / 移除收进行尾菜单。o.showTenant / o.showMember 控制“客户”“成员”两列；o.onRow 点行（缺省进账号详情）。
 */
export function deviceTable(rows, { state, after, showTenant = true, showMember = true, empty, onRow } = {}) {
  const openRow = onRow === false ? undefined : onRow ?? ((d) => d.aid && go(`ops/accounts/${encodeURIComponent(d.aid)}?section=devices`));
  const anyFlag = rows.some((d) => (d.flags ?? []).length);
  const cols = [
    { key: "name", label: "电脑", value: (d) => deviceLabel(d), render: (d) => deviceCell(d) },
    showMember ? { key: "member", label: "成员", value: (d) => d.member_name ?? d.email ?? "", render: (d) => (d.aid ? h("button", { type: "button", class: "link", title: d.email ?? undefined, onclick: () => go(`ops/accounts/${encodeURIComponent(d.aid)}`) }, d.member_name ?? d.email ?? d.aid) : h("span", { class: "muted" }, "未建账号")) } : null,
    showTenant ? { key: "tenant_name", label: "客户", value: (d) => d.tenant_name ?? d.tid, render: (d) => h("button", { type: "button", class: "link", onclick: () => go(`ops/tenants/${encodeURIComponent(d.tid)}`) }, d.tenant_name ?? d.tid) } : null,
    { key: "platform", label: "系统", value: (d) => platformText(d.platform) },
    { key: "client_version", label: "客户端", render: (d) => (d.pending ? h("span", { class: "muted" }, "—") : d.client_version && d.client_version !== "legacy" ? mono(d.client_version) : h("span", { class: "muted" }, versionText(d.client_version))) },
    { key: "last_seen_on", label: "最近在线", value: (d) => d.last_seen_on ?? "", render: (d) => (d.pending ? h("span", { class: "muted" }, "—") : d.last_active_at ? h("span", { title: fmt.full(d.last_active_at) }, fmt.ago(d.last_active_at)) : h("span", { title: fmt.full(d.last_seen_on) }, d.last_seen_on ? fmt.ago(d.last_seen_on) : "从未在线")) },
    { key: "state", label: "状态", value: (d) => ({ pending: 0, signed_in: 1, signed_out: 2, revoked: 3 })[deviceState(d)], render: (d) => deviceStateCell(d) },
    anyFlag ? { key: "flags", label: "标记", value: (d) => (d.flags ?? []).length, render: (d) => ((d.flags ?? []).length ? h("span", { class: "badges" }, d.flags.map((f) => badge(...pick(DEVICE_FLAG, f)))) : "") } : null,
    { key: "_act", label: "", sortable: false, class: "act", render: (d) => rowMenu(deviceActions(d, after), { aria: `操作：${deviceLabel(d)}` }) },
  ].filter(Boolean);
  return dataTable({ columns: cols, rows, state: state ?? { sort: "state", asc: true }, onRow: openRow, empty: empty ?? "没有电脑", rowClass: (d) => (deviceState(d) === "revoked" ? "dim" : d.pending ? "pending-row" : (d.flags ?? []).some((f) => DEVICE_FLAG[f]?.[1] === "warn") ? "flagged" : "") });
}

/** 详情页的面包屑（第 71 批，V-11）：parts = [[文字, 路径?], …] */
export const setCrumbs = (parts) => ctx.setCrumbs?.(parts);

/** 页头：标题 + 说明（文字或元信息行 metaLine）+ 右侧操作 */
export function pageHead(title, sub, actions) {
  return h("header", { class: "page-head" }, h("div", { class: "page-titles" }, h("h1", {}, title), sub ? h(typeof sub === "string" ? "p" : "div", { class: "page-sub" }, sub) : null), actions ? h("div", { class: "page-actions" }, actions) : null);
}
/** 是不是本人（审计、人员表里标“我”） */
export const isMe = (who) => !!who && (who === ctx.operatorId || (ctx.operatorEmail && String(who).toLowerCase() === ctx.operatorEmail.toLowerCase()));

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
