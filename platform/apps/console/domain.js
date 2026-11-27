/**
 * 统一云端控制台 · 业务词表与共用块（第 44 批起；第 46 批加统一账号、平台角色与权限、三分区路由）：
 * 状态与枚举的中文、告警列表、设备表与吊销、权限判断、路由跳转。
 * 字段名照《运营接口契约》（research/2026-11-14-V19…/03-运营接口契约.md）与第 46 批契约 §3（research/2026-11-19-V20…/00-架构决策与接口契约.md），不自创。
 */
import * as api from "./api.js";
import { badge, btn, clear, confirmAction, dataTable, dot, fmt, h, mono, rowMenu, segmented, stateCell, toast } from "./ui.js";

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
export const CREATED_VIA = { self: "自助注册", founder_code: "开通码", invite_code: "邀请码", ops: "运营代建", team_invite: "团队邀请" };
/**
 * 电脑的异常标记（第 71 批，B-6 / P-09）：运营侧与本所侧同一口径与说法——
 *   30 天未报到；低于最低版本（云端设置的 min_version）；未登录（账号闸开着且这台电脑没有有效登录：只是暂停，不是“仍有请求”，中性色）。
 */
/** 第 72 批评审（K5/K10/K13）：巡检标记改中性色——警示色只留给要人处理的行（待管理员确认） */
export const FIRM_DEVICE_FLAG = { stale_30d: ["30 天没在线", "neutral"], old_client: ["低于最低版本", "neutral"], rejected_after_logout: ["未登录", "neutral"] };
export const DEVICE_FLAG = { stale: ["30 天没在线", "neutral"], outdated: ["低于最低版本", "neutral"], suspended: ["未登录", "neutral"] };
/** 没上报版本时不断言“低于最低版本”，写“版本未知”（客户端列已写“未上报版本”） */
export const flagBadge = (f, d) => ((f === "outdated" || f === "old_client") && (!(d?.client_version ?? d?.version) || (d?.client_version ?? d?.version) === "legacy") ? badge("版本未知", "neutral", "这台电脑没上报客户端版本") : badge(...pick(f in FIRM_DEVICE_FLAG ? FIRM_DEVICE_FLAG : DEVICE_FLAG, f)));
/** 电脑状态（第 71 批）：登录中 / 已退出登录（资料还在那台电脑上，可再登录）/ 已移除（不能再用这个账号） */
export const DEVICE_STATE = { signed_in: ["登录中", "ok"], signed_out: ["已退出登录", "neutral"], pending: ["待批准登录", "warn"], revoked: ["已移除", "neutral"] };
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
// 第 72 批评审（跨页 1）：内部设备编号不进主列，放悬停
export const deviceCell = (d) => h("div", { class: "cell-2" }, h("b", { class: d?.name ? "" : "derived", title: [d?.name ? null : d?.pending ? "入组申请还没批准" : "律师还没给这台电脑起名", d?.device_id ? `编号 ${d.device_id}` : null].filter(Boolean).join(" · ") || undefined }, deviceLabel(d)), d?.pending ? h("small", {}, `申请于 ${fmt.time(d.created_at)}`) : null);
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
export const ALERT_KIND = { threshold: "跨过阈值", cap: "到上限", exhausted: "额度用完", anomaly: "用量异常", route_down: "上游不可用", device_flag: "设备异常", usage_missing: "上游未给用量", new_device: "新电脑登录" };
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
      const whoParts = [a.tid ? link(a.tenant_name ?? a.tid, `ops/tenants/${encodeURIComponent(a.tid)}`) : null, a.aid ? link(a.email ?? a.aid, `ops/people/${encodeURIComponent(a.aid)}`) : a.email ?? null, a.provider ? `上游 ${a.provider}` : null].filter(Boolean);
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
      // 第 72 批评审（跨页 7）：新电脑登录告警的正文是写给律师本人的，运营 / 管理员看到的改成第三人称与可做的事（原文放悬停）
      const ip = a.kind === "new_device" ? /（[^（）]*）/.exec(String(a.message ?? ""))?.[0] ?? "" : "";
      const person = a.member_name ?? a.email ?? null;
      const msg = a.kind === "new_device" ? `${person ? `${person}在` : "有成员在"}一台新电脑上登录${ip}。若本人否认，可在“电脑”里移除这台电脑，并提醒本人改密码。` : a.message ?? "";
      return h(
        "li",
        { class: `alert lv-${tone}` },
        h("span", { class: `alert-bar tone-${tone}`, "aria-hidden": "true" }),
        h(
          "div",
          { class: "alert-main" },
          h("div", { class: "alert-top" }, badge(lv, tone), h("b", {}, ALERT_KIND[a.kind] ?? a.kind), who ? h("span", { class: "alert-who" }, ...who) : null, h("time", { class: "alert-at", datetime: a.at }, fmt.time(a.at))),
          h("div", { class: "alert-msg", title: a.kind === "new_device" ? a.message : undefined }, msg),
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
/**
 * 团队里“待确认”的电脑（第 72 批，D-304、契约 §3.5）：账号签发钥登记（issuer = account_ca）的电脑能登录、用 AI、处理自己的事项，
 * 但还不能接收团队共享事项，须团队管理员在管理员电脑上确认。个人空间的电脑都是这样登记的，不算待确认——只在团队范围内标（o.team）。
 */
export const CONFIRM_TIP = "能登录、用 AI、处理自己的事项；要接收团队共享事项前，须团队管理员在管理员电脑“设置 → 管理”里确认这台电脑";
export const unconfirmed = (d) => d?.issuer === "account_ca" && !d?.pending && deviceState(d) !== "revoked";
/** 工作空间的叫法：个人空间一律叫“个人空间”（不再写“某某的工作室”）；类型取 d.kind / 客户列表缓存的 kind，旧数据按名称近似 */
export const wsKindOfTid = (tid, name) => ctx.tenants?.find((t) => t.tid === tid)?.kind ?? (/的工作室$/.test(String(name ?? "")) ? "personal" : "team");
export const wsNameOf = (d) => ((d?.kind ?? wsKindOfTid(d?.tid, d?.tenant_name)) === "personal" ? "个人空间" : d?.tenant_name ?? d?.tid);
/** 待管理员确认（D-304）：状态格两行——主状态 + 灰字说明与下一步 */
export const confirmCell = (d, hint) => h("span", { class: "cell-2" }, stateCell("待管理员确认", "warn", CONFIRM_TIP), h("small", {}, hint ?? "确认后才能接收团队共享事项"));
export function deviceTable(rows, { state, after, showTenant = true, showMember = true, empty, onRow, memberLabel = "成员", team = false, confirmHint } = {}) {
  const isTeam = typeof team === "function" ? team : () => !!team;
  // 第 72 批（D-306）：行与“成员”列进用户详情（一个人）；用户详情按工作空间分组列电脑
  const openRow = onRow === false ? undefined : onRow ?? ((d) => d.aid && go(`ops/people/${encodeURIComponent(d.aid)}?section=devices`));
  const anyFlag = rows.some((d) => (d.flags ?? []).some((f) => f !== "suspended"));
  const cols = [
    { key: "name", label: "电脑", value: (d) => deviceLabel(d), render: (d) => deviceCell(d) },
    showMember ? { key: "member", label: memberLabel, value: (d) => d.member_name ?? d.email ?? "", render: (d) => (d.aid ? h("button", { type: "button", class: "link plain", title: d.email ?? undefined, onclick: () => go(`ops/people/${encodeURIComponent(d.aid)}`) }, d.member_name ?? d.email ?? d.aid) : h("span", { class: "muted" }, "未建账号")) } : null,
    showTenant ? { key: "tenant_name", label: "工作空间", value: (d) => wsNameOf(d), render: (d) => h("button", { type: "button", class: "link plain", title: `打开${wsNameOf(d) === "个人空间" ? "个人空间" : "组织"}详情`, onclick: () => go(`ops/tenants/${encodeURIComponent(d.tid)}`) }, wsNameOf(d)) } : null,
    { key: "platform", label: "系统", value: (d) => platformText(d.platform) },
    { key: "client_version", label: "客户端", render: (d) => (d.pending ? h("span", { class: "muted" }, "—") : d.client_version && d.client_version !== "legacy" ? mono(d.client_version) : h("span", { class: "muted" }, versionText(d.client_version))) },
    { key: "last_seen_on", label: "最近在线", value: (d) => d.last_seen_on ?? "", render: (d) => (d.pending ? h("span", { class: "muted" }, "—") : d.last_active_at ? h("span", { title: fmt.full(d.last_active_at) }, fmt.ago(d.last_active_at)) : h("span", { title: fmt.full(d.last_seen_on) }, d.last_seen_on ? fmt.ago(d.last_seen_on) : "从未在线")) },
    { key: "state", label: "状态", value: (d) => ({ pending: 0, signed_in: 1, signed_out: 2, revoked: 3 })[deviceState(d)], render: (d) => (isTeam(d) && unconfirmed(d) ? confirmCell(d, confirmHint) : deviceStateCell(d)) },
    anyFlag ? { key: "flags", label: "标记", value: (d) => (d.flags ?? []).length, render: (d) => ((d.flags ?? []).filter((f) => f !== "suspended").length ? h("span", { class: "badges" }, d.flags.filter((f) => f !== "suspended").map((f) => flagBadge(f, d))) : "") } : null,
    { key: "_act", label: "", sortable: false, class: "act", render: (d) => rowMenu(deviceActions(d, after), { aria: `操作：${deviceLabel(d)}` }) },
  ].filter(Boolean);
  return dataTable({ columns: cols, rows, state: state ?? { sort: "state", asc: true }, onRow: openRow, empty: empty ?? "没有电脑", rowClass: (d) => (deviceState(d) === "revoked" ? "dim" : d.pending ? "pending-row" : isTeam(d) && unconfirmed(d) ? "flagged" : "") });
}

/**
 * 席位提示（第六轮，按真实情况分三种）：有空席 → 第一次用 AI 时自动占用（不是问题）；席位已满且有人未占 → 这些人用不了 AI（是问题）；一致 → 不提示。
 */
export function seatNote(unseated, total, used) {
  const n = Number(unseated) || 0;
  if (!n) return null;
  const free = Math.max(0, (Number(total) || 0) - (Number(used) || 0));
  return free > 0
    ? { full: false, free, tone: "neutral", text: `另有 ${n} 个账号未占席：第一次用 AI 时自动占用（还有 ${free} 个空席）` }
    : { full: true, free: 0, tone: "warn", text: `席位已满：另有 ${n} 个账号用不了 AI，请改套餐或席位` };
}
export const UNSEATED_TIP = "还没占席：有空席时，第一次在电脑上用 AI 会自动占用（管理员也可以直接分配）；席位已满时用不了 AI";
/** 第 72 批（D-306 第 6 条，全站一个说法）：席位 = 能用 AI 的名额；个人空间不讲席位 */
export const SEAT_NOTE = "席位：能用 AI 的名额";

/**
 * 工作空间（第 72 批，D-305）：一个人 = 一个账号；工作空间 = 这个人在某个租户里的成员身份，类型是显式字段 kind（personal | team）。
 * 旧云端没给 kind 时按 personal 布尔近似（只读，不推断别的）。
 */
export const KIND_LABEL = { personal: "个人", team: "团队" };
export const kindOf = (x) => (x?.kind === "personal" || x?.kind === "team" ? x.kind : x?.personal === true ? "personal" : "team");
/** 当前登录的成员在哪种工作空间（/v1/auth/me 的 workspace.kind；旧云端看 personal） */
export const workspaceKind = () => ctx.me?.workspace?.kind ?? (ctx.me?.personal === true ? "personal" : ctx.me?.personal === false ? "team" : null);
export const isPersonalSpace = () => ctx.kind === "member" && workspaceKind() === "personal";
/** 工作空间状态：团队移出 / 平台停用（disabled_by，A3 R2）分开说 */
export const WS_STATUS = { active: ["正常", "ok"], team: ["已移出团队", "neutral"], left: ["已退出团队", "neutral"], platform: ["平台停用", "warn"], disabled: ["已停用", "neutral"] };
/** 云端给 disabled_kind（disabled / removed / left）时按它；旧云端按 disabled_by */
export const wsStatus = (w) => (w?.status !== "disabled" ? "active" : w.disabled_kind === "left" ? "left" : w.disabled_kind === "removed" ? "team" : w.disabled_by === "platform" ? "platform" : w.disabled_by === "team" ? "team" : "disabled");
export const wsStatusCell = (w) => ((k) => stateCell(WS_STATUS[k][0], WS_STATUS[k][1], k === "platform" ? "由中软平台停用：团队管理员不能启用" : k === "team" ? "团队管理员已把他移出（或本人退出）：凭证保留，团队里的电脑记录保留" : undefined))(wsStatus(w));
/** 团队邀请（契约 §3.2；运营侧 GET /v1/ops/tenants/{tid}/invites 与本所 GET /v1/team/invites 同一形状，不含码） */
export const INVITE_STATUS = { open: ["待接受", "info"], accepted: ["已接受", "ok"], revoked: ["已撤销", "neutral"], expired: ["已过期", "neutral"] };
export function inviteTable(all, { state, onRevoke, revokeTitle } = {}) {
  const box = h("div");
  let show = all.some((x) => x.status === "open") ? "open" : "all";
  const draw = () => clear(box, all.length ? h("div", { class: "toolbar inset" }, segmented([{ id: "open", label: "待接受", count: all.filter((x) => x.status === "open").length }, { id: "all", label: "全部", count: all.length }], show, (v) => ((show = v), draw()), "邀请状态")) : null, table(show === "open" ? all.filter((x) => x.status === "open") : all));
  const table = (rows) => dataTable({
    state: state ?? { sort: "created_at", asc: false },
    rows,
    empty: "还没有发过邀请",
    rowClass: (x) => (x.status === "open" ? "" : "dim"),
    caption: "团队邀请",
    columns: [
      { key: "name", label: "被邀请人", render: (x) => h("div", { class: "cell-2" }, h("b", {}, x.name ?? "—"), h("small", {}, x.phone_hint ?? "未填手机号")) },
      { key: "role", label: "角色", value: (x) => roleText(x.role) },
      { key: "status", label: "状态", value: (x) => x.status, render: (x) => stateCell(...(INVITE_STATUS[x.status] ?? [x.status, "neutral"])) },
      { key: "created_at", label: "发出", value: (x) => x.created_at ?? "", render: (x) => h("div", { class: "cell-2" }, fmt.time(x.created_at), h("small", {}, x.created_by === "platform" ? "平台代发" : "团队管理员")) },
      { key: "expires_at", label: "有效至 / 接受于", value: (x) => x.accepted_at ?? x.expires_at ?? "", render: (x) => (x.status === "accepted" ? h("span", { class: "muted" }, `${fmt.time(x.accepted_at)} 已接受`) : x.status === "open" ? fmt.time(x.expires_at) : h("span", { class: "muted" }, "—")) },
      { key: "_act", label: "", sortable: false, class: "act", render: (x) => (x.status === "open" && onRevoke ? rowMenu([{ label: "撤销邀请…", danger: true, disabled: !!revokeTitle, title: revokeTitle, onClick: () => onRevoke(x) }], { aria: `操作：${x.name}` }) : null) },
    ],
  });
  draw();
  return box;
}
/** 一枚工作空间标签：“个人” 或 “团队名 · 角色” */
export const wsChip = (w, o = {}) =>
  h(
    "span",
    { class: ["ws-chip", w.status === "disabled" && "off", o.link && "clickable"], title: [KIND_LABEL[kindOf(w)], w.name, ROLE[w.role] ?? w.role, w.status === "disabled" ? WS_STATUS[wsStatus(w)][0] : null].filter(Boolean).join(" · ") },
    kindOf(w) === "personal" ? h("span", { class: "ws-kind" }, "个人") : [h("span", { class: "ws-kind team" }, "团队"), h("span", { class: "ws-name" }, w.name ?? w.tid)],
    kindOf(w) === "team" && w.role ? h("small", {}, ROLE[w.role] ?? w.role) : null,
    w.status === "disabled" ? h("small", {}, WS_STATUS[wsStatus(w)][0]) : null,
  );

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
      ctx.tenants = (r.tenants ?? []).map((t) => ({ tid: t.tid, name: t.name ?? t.tid, kind: kindOf(t) }));
    } catch {
      ctx.tenants = [];
    }
  }
  return [["", "全部律所"], ...ctx.tenants.map((t) => [t.tid, `${t.name}（${t.tid}）`])];
}

export const periodText = (p) => (p ? `${p.key ?? ""}${p.kind === "week" ? " 周" : ""} · ${fmt.resets(p.resets_at) ?? "—"} 重置` : "—");
