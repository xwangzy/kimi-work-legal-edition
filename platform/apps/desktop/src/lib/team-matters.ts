/**
 * 第 73 批（V47，D-307～D-310，契约 02 §3）：团队共享事项在界面这一侧的纯函数——谁能看到、选同事、事项成员行、同步状态、开通同事之间同步。
 *
 * - 只在团队空间出现（个人空间一处不变）；“和同事一起办”要这台电脑经团队确认（律所根签的证书），且事项不是“客户要求不上云”。
 * - 同事电脑能否接收与第 72 批同一口径（lib/workspace.ts shareReadyText 的 peer 分支），不另起句库。
 * - 所内没开通同事之间同步时允许建团队事项，如实说“开通后才收得到”；这句只在列表上方说一次，不逐行重复。
 * - 律师层不讲中继、证书、密钥、纪元、包裹（用例 b73-team-matters-ui 把这几个词作为本批文案的门禁）。
 */
import type { MatterMemberRow, MatterRole, MatterSync, RelayStatus, ShareRelayStatus, TeamRoster, TeamRosterMember } from "../api.ts";
import { dueLabel, shareReadyText, WS_ROLE_LABEL, type WorkspaceKind, type WorkspaceRole } from "./workspace.ts";

export type CollabScope = "personal" | "team";

/** 新建事项“谁能看到”的两段（A5 §6.3 定稿）。 */
export const SCOPE_OPTIONS: readonly { v: CollabScope; label: string; hint: string }[] = [
  { v: "personal", label: "只有我", hint: "只在你的电脑上；以后可以在事项里加同事。" },
  { v: "team", label: "和同事一起办", hint: "加进来的同事在自己的电脑上也能看到、一起办；内容加密后在你们的电脑之间同步，中软打不开。" },
];

/** 所内还没开通同事之间同步（规则没允许）。 */
export const RELAY_NOT_ALLOWED_TEXT = "所内还没开通同事之间同步：加进来的同事要等管理员开通后才收得到。";
/** 中软还没为本所开通（服务没部署）。 */
export const RELAY_NOT_CONFIGURED_TEXT = "中软还没为本所开通同事之间同步：加进来的同事要等开通后才收得到。";

/**
 * 同事之间同步能不能用（true 已开通 / false 没开通 / null 不知道），给 shareReadyText 与“谁能看到”的说明用。纯函数。
 * 第 73 批（D-309）：本所规则没允许（not_allowed）如实算“没开通”——原来映射成“不知道”；只有规则过期回退（policy_fallback）是暂停、不是没开通，仍算不知道。
 */
export function relayReady(st: Pick<RelayStatus, "blocked" | "policy_fallback"> | null | undefined): boolean | null {
  if (!st) return null;
  if (st.blocked === "not_configured") return false;
  if (st.blocked === "not_allowed") return st.policy_fallback ? null : false;
  return st.blocked === null ? true : null;
}

/** relay.status → 事项成员页同一套状态（与内核 matters.members.list 的 sync 同口径）。纯函数。 */
export function relaySyncOf(st: Pick<RelayStatus, "blocked" | "policy_fallback"> | null | undefined): MatterSync {
  if (!st) return "unknown";
  if (st.blocked === "not_configured") return "not_configured";
  if (st.blocked === "not_allowed" && !st.policy_fallback) return "not_allowed";
  return st.blocked === null ? "ok" : "unknown";
}

export interface ScopeAvailability {
  /** 显示“谁能看到”（只在团队空间）。 */
  show: boolean;
  /** “和同事一起办”能不能选。 */
  team: boolean;
  /** 不能选时的一句原因。 */
  reason: string | null;
  /** 原因是这台电脑还没经团队确认：给“去申请 →”（设置 → 团队）。 */
  apply: boolean;
}

/**
 * “谁能看到”的可用性（D-307）。kind 传 effectiveKind 的结果（不知道时按名单推断）。纯函数。
 * 顺序：客户要求不上云（与这件事项的选择相关，就近说）→ 这台电脑还没经团队确认 → 同事名单服务不支持。
 */
export function scopeAvailability(o: { kind: WorkspaceKind | null; issuer: "firm_root" | "account_ca" | null; level: string; roster?: Pick<TeamRoster, "reason"> | null }): ScopeAvailability {
  if (o.kind !== "team") return { show: false, team: false, reason: null, apply: false };
  if (o.level === "strict") return { show: true, team: false, reason: "客户要求不上云的事项只在这台电脑上，不能和同事一起办。", apply: false };
  // 只在确知这台电脑是直接登录、还没经团队确认时置灰；不知道（null）时交给内核判断（device_not_confirmed 如实显示）
  if (o.issuer === "account_ca") return { show: true, team: false, reason: "这台电脑还不能接收团队共享事项：申请并经管理员确认后，才能和同事一起办。", apply: true };
  if (o.roster?.reason === "not_supported") return { show: true, team: false, reason: "暂时不能和同事一起办：Kimi Work 服务还不支持同事名单，请联系 Kimi Work 客服。", apply: false };
  return { show: true, team: true, reason: null, apply: false };
}

/** 选中“谁能看到”某一项时下面那一行说明；团队共享且所内没开通同步时换成如实的一句。纯函数。 */
export function scopeHint(scope: CollabScope, relay: boolean | null, configured: boolean | null = null): string {
  if (scope === "team" && relay === false) return configured === false ? RELAY_NOT_CONFIGURED_TEXT : RELAY_NOT_ALLOWED_TEXT;
  return SCOPE_OPTIONS.find((s) => s.v === scope)!.hint;
}

/** 建事项要提交的协作范围：选了一起办但现在不能选（如改成了“客户要求不上云”）时回落到“只有我”，选的同事不提交。纯函数。 */
export function scopeToSubmit(scope: CollabScope, avail: ScopeAvailability, picked: readonly string[]): { collab_scope?: CollabScope; members?: { user_id: string; matter_role: "editor" }[] } {
  if (!avail.show || scope !== "team" || !avail.team) return {};
  return { collab_scope: "team", members: picked.map((user_id) => ({ user_id, matter_role: "editor" as const })) };
}

/** 能加进事项的同事：名单里在用、不是自己、还不在事项里；按姓名排（云端已排，这里再稳一次）。纯函数。 */
export function pickableColleagues(roster: Pick<TeamRoster, "members"> | null | undefined, exclude: Iterable<string> = []): TeamRosterMember[] {
  const ex = new Set(exclude);
  return (roster?.members ?? []).filter((m) => m.status === "active" && !m.is_me && !ex.has(m.user_id)).sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
}

/** 选同事列表超过 8 人时出搜索框；按姓名包含匹配。纯函数。 */
export const PICKER_SEARCH_FROM = 8;
export function filterColleagues(list: readonly TeamRosterMember[], q: string): TeamRosterMember[] {
  const k = q.replace(/\s+/g, "");
  return k ? list.filter((m) => m.name.replace(/\s+/g, "").includes(k)) : [...list];
}

/** 选同事每一行的小字：角色 · 电脑还不能接收。纯函数。 */
export function colleagueMeta(m: Pick<TeamRosterMember, "role" | "can_receive">): string {
  const role = m.role in WS_ROLE_LABEL ? WS_ROLE_LABEL[m.role as WorkspaceRole] : "";
  return [role, shareReadyText({ kind: "peer", confirmed: m.can_receive, relay: null })].filter(Boolean).join(" · ");
}

/** 名单取不到时选同事处的一句（不是错误：可以先建好，联网后在事项里加）。纯函数。 */
export function rosterNote(r: Pick<TeamRoster, "available" | "reason" | "members"> | null): string | null {
  if (!r) return "正在取同事名单…";
  if (r.available) return null;
  if (r.reason === "offline") return r.members.length > 0 ? "联不上 Kimi Work 服务：下面是上次取到的同事名单。" : "联不上 Kimi Work 服务，暂时取不到同事名单：可以先建好，联网后在事项里加同事。";
  if (r.reason === "not_supported") return "Kimi Work 服务还不支持同事名单，请联系 Kimi Work 客服。";
  return "暂时取不到同事名单：可以先建好，之后在事项里加同事。";
}

/** 首字头像（姓名第一个字；没有姓名用“同”）。纯函数。 */
export function avatarOf(name: string | null | undefined): string {
  const n = (name ?? "").trim();
  return n ? [...n][0]! : "同";
}

/** 事项角色（D-308：只露负责人 / 一起办 / 只看；复核、签发两种另有入口，遇到时照实写）。 */
export const MATTER_ROLE_LABEL: Readonly<Record<MatterRole, string>> = { owner: "负责人", editor: "一起办", viewer: "只看", reviewer: "复核", issuer: "签发" };
export const MATTER_ROLE_OPTIONS: readonly { value: "editor" | "viewer"; label: string; hint: string }[] = [
  { value: "editor", label: "一起办", hint: "加材料、发起任务、改成果" },
  { value: "viewer", label: "只看", hint: "看材料和成果，不能改" },
];
export function matterRoleLabel(r: string | null | undefined): string {
  return r && r in MATTER_ROLE_LABEL ? MATTER_ROLE_LABEL[r as MatterRole] : "成员";
}

/** 事项成员排序：负责人在前，其次自己，再按姓名；已离开团队的排最后。纯函数。 */
export function sortMembers<T extends Pick<MatterMemberRow, "matter_role" | "is_me" | "name" | "departed">>(rows: readonly T[]): T[] {
  const rank = (m: T) => (m.departed ? 3 : m.matter_role === "owner" ? 0 : m.is_me ? 1 : 2);
  return [...rows].sort((a, b) => rank(a) - rank(b) || (a.name ?? "").localeCompare(b.name ?? "", "zh-Hans-CN"));
}

/** 成员显示名（内核不认识时给的是编号：律师层不露编号，写“一位同事”）。纯函数。 */
export function memberName(m: Pick<MatterMemberRow, "name" | "user_id">): string {
  const n = (m.name ?? "").trim();
  return n && n !== m.user_id && !/^usr_/.test(n) ? n : "一位同事";
}

/**
 * 成员行的小字（D-308）：已离开团队 / 电脑还不能接收（长句）；自己、能接收的不写。纯函数。
 * 所内没开通同步时那一句在列表上方说（syncNotice），这里不重复。
 */
export function memberRowNote(m: Pick<MatterMemberRow, "departed" | "can_receive" | "is_me">): { text: string; tone: "off" | "quiet" } | null {
  if (m.departed) return { text: "已离开团队", tone: "off" };
  if (m.is_me || m.can_receive) return null;
  return { text: shareReadyText({ kind: "peer", confirmed: false, relay: null, long: true }), tone: "quiet" };
}

/** 事项成员列表上方的一句（sync 非 ok 时；不知道时不替它说）。admin = 这台电脑能开通（给“去开通 →”）。纯函数。 */
export function syncNotice(sync: MatterSync | null | undefined): { text: string; enable: boolean } | null {
  switch (sync) {
    case "not_allowed":
      return { text: RELAY_NOT_ALLOWED_TEXT, enable: true };
    case "not_configured":
      return { text: RELAY_NOT_CONFIGURED_TEXT, enable: false };
    case "unreachable":
      return { text: "暂时连不上同步服务：改动先留在这台电脑上，连上后自动同步给同事。", enable: false };
    case "pending":
      // 内核：刚建、刚改为一起办，或有改动还没发出（会自动重试）
      return { text: "这个事项还在等第一次同步：联网时会自动同步给同事。", enable: false };
    default:
      return null;
  }
}

/** 事项头胶囊（D-310）：“团队共享 · 3 人”；还没取到人数时只写“团队共享”。读屏另有一句。纯函数。 */
export function teamPillText(n: number | null | undefined): { label: string; aria: string } {
  return typeof n === "number" && n > 0 ? { label: `团队共享 · ${n} 人`, aria: `团队共享事项，${n} 位事项成员，展开查看` } : { label: "团队共享", aria: "团队共享事项，展开查看事项成员" };
}

/** 侧栏、列表、搜索的团队共享记号：只在不是个人空间时出现（个人空间不可能有团队共享事项，D-310）。纯函数。 */
export function isTeamShared(m: { collab_scope?: string | null } | null | undefined, kind: WorkspaceKind | null): boolean {
  return !!m && m.collab_scope === "team" && kind !== "personal";
}
/** 菜单、搜索副标题的前缀（“团队共享 · 客户甲 / 乙公司”）。纯函数。 */
export function teamPrefix(sub: string, shared: boolean): string {
  return shared ? (sub ? `团队共享 · ${sub}` : "团队共享") : sub;
}

/**
 * 我是负责人、但这台电脑现在不能调整成员时的一句（内核 can_manage = false）：最先同步这个事项的是另一位负责人 / 负责人暂时无法确认 / 已结案。纯函数。
 */
export function manageBlockedText(v: { is_owner: boolean; can_manage?: boolean; relay_controller?: string | null; members: readonly Pick<MatterMemberRow, "user_id" | "name" | "is_me">[] }, closed: boolean): string | null {
  if (!v.is_owner) return null;
  if (closed) return "事项已结案（只读）：不能再加同事、改角色或移出。";
  if (v.can_manage !== false) return null;
  const ctl = v.relay_controller ? v.members.find((m) => m.user_id === v.relay_controller && !m.is_me) : null;
  if (ctl) return `这个事项的成员由最先同步它的负责人${memberName(ctl)}调整：要加人、改角色或移出，请找他；也可以请他把这件事交给你。`;
  return "这台电脑暂时不能调整这个事项的成员（负责人暂时无法确认，或还在等第一次同步）：联网同步一次后再试。";
}

/** 这台电脑能不能调整成员：内核给了 can_manage 就用它，旧内核按“负责人且进行中”。纯函数。 */
export function canManageMembers(v: { is_owner: boolean; can_manage?: boolean }, closed: boolean): boolean {
  return v.is_owner && !closed && v.can_manage !== false;
}

/** 非负责人看到的表尾：要加人或移出找谁。纯函数。 */
export function ownerHint(rows: readonly Pick<MatterMemberRow, "matter_role" | "name" | "user_id" | "is_me">[]): string {
  const owners = rows.filter((r) => r.matter_role === "owner" && !r.is_me).map(memberName);
  return owners.length > 0 ? `要加人或移出，请找负责人${owners.slice(0, 2).join("、")}。` : "要加人或移出，请找这个事项的负责人。";
}

/** 移出前原位确认的一句（D-308）。纯函数。 */
export function removeQuestion(name: string): string {
  return `移出${name}？移出后，他的电脑拿不到这个事项此后的新内容；他电脑上已有的内容不会被收回。`;
}
export function removeResult(name: string): string {
  return `已移出${name}：他的电脑拿不到这个事项此后的新内容。`;
}

/**
 * 加人之后的一句（A5 §7.2）：谁的电脑下次同步时收到、谁的电脑还要申请；所内没开通同步时如实说要等开通；没加上的单列原因。纯函数。
 */
export function addResultText(added: readonly { name: string; can_receive: boolean }[], failed: readonly { name: string; why: string }[], sync: MatterSync | null | undefined): string {
  const parts: string[] = [];
  if (added.length > 0) {
    const names = added.map((a) => a.name).join("、");
    const later = added.filter((a) => !a.can_receive).map((a) => a.name);
    const now = added.filter((a) => a.can_receive).map((a) => a.name);
    let tail: string;
    if (sync === "not_allowed" || sync === "not_configured") tail = `所内开通同事之间同步后才会收到${later.length > 0 ? `；${later.join("、")}的电脑还要先申请并经管理员确认` : ""}。`;
    else
      tail = [now.length > 0 ? `${now.join("、")}的电脑下次同步时收到` : "", later.length > 0 ? `${later.join("、")}的电脑还不能接收，申请并经管理员确认后自动收到` : ""].filter(Boolean).join("；") + "。";
    parts.push(`已加入${names}。${tail}`);
  }
  if (failed.length > 0) parts.push(`没有加上：${failed.map((f) => `${f.name}（${f.why}）`).join("；")}。`);
  return parts.join("");
}

/** 个人事项改为和同事一起办（D-307）：二次确认要写清的三件事（不可改回在最后）。纯函数。 */
export function shareMatterLines(): string[] {
  return [
    "加进来的同事在自己的电脑上也能看到这个事项的材料、任务和成果；内容加密后在你们的电脑之间同步，中软打不开。",
    "改为和同事一起办后，正在等你确认的任务需要重新确认一次。",
    "之后不能改回“只有我”：要结束共享，把同事逐个移出，或结案。",
  ];
}

/**
 * “⋯ → 和同事一起办…”出不出现（D-307）：团队空间、个人事项、我是负责人、进行中。能不能做另由 scopeAvailability 判（弹窗里说原因）。纯函数。
 */
export function canOfferShare(kind: WorkspaceKind | null, m: { collab_scope?: string | null; my_role?: string | null; lifecycle?: string | null; is_sample?: boolean | null }): boolean {
  return kind === "team" && m.collab_scope !== "team" && m.my_role === "owner" && (m.lifecycle ?? "active") === "active" && !m.is_sample;
}

/** 事项数据级别 → “怎么处理”三段的值（L3b = 客户要求不上云）。纯函数。 */
export function levelOfMatter(m: { data_level?: string | null; confidentiality?: string | null }): string {
  return m.data_level === "L3b" || m.confidentiality === "strict" ? "strict" : m.data_level === "L3a" || m.confidentiality === "high" ? "high" : "normal";
}

/**
 * 团队共享事项的错误（内核终版，03 第 W2 行 ⑥）：按 `code` + `detail.reason` 分支；四个契约码不在 domain FaultCode 里，是字符串。
 * - team_scope_unavailable：personal_workspace / workspace_unknown / device_not_confirmed / client_no_cloud
 * - member_not_in_team：not_in_roster / disabled / removed / left（另带 user_id）
 * - roster_unavailable：offline（503）/ not_supported（409）
 * - scope_irreversible：team_to_personal
 * - team_scope_conflict：已是团队共享的事项不能再设为客户要求不上云
 * - validation：relay_not_configured / not_enabled（开通 / 续期）、patch_missing（调用方错误，界面不会发）
 */
export type TeamFaultCode = "team_scope_unavailable" | "member_not_in_team" | "roster_unavailable" | "scope_irreversible" | "team_scope_conflict";
export function teamFaultOf(e: unknown): { code: string | null; reason: string | null; userId: string | null; message: string } {
  const x = e as { code?: unknown; detail?: { reason?: unknown; user_id?: unknown }; message?: unknown } | null;
  return {
    code: typeof x?.code === "string" ? x.code : null,
    reason: typeof x?.detail?.reason === "string" ? x.detail.reason : null,
    userId: typeof x?.detail?.user_id === "string" ? x.detail.user_id : null,
    message: typeof x?.message === "string" ? x.message.trim() : "",
  };
}

const SCOPE_UNAVAILABLE_TEXT: Readonly<Record<string, string>> = {
  personal_workspace: "个人空间里的事项只在你自己的电脑上：要和同事一起办，请先切换到团队空间。",
  workspace_unknown: "还没确认当前是团队空间（刚加入团队时要等一会儿）：请联网后稍等再试。",
  device_not_confirmed: "这台电脑还不能接收团队共享事项：请在“设置 → 团队”里申请，管理员确认后就能和同事一起办。",
  client_no_cloud: "客户要求不上云的事项不能和同事一起办：同事之间同步要经中软转送加密内容，与客户的要求不符。",
};
/** 某位同事加不进来的原因（短语，放在“没有加上：某某（原因）”里）。 */
const MEMBER_REASON_TEXT: Readonly<Record<string, string>> = { not_in_roster: "不在团队同事名单里", disabled: "已停用", removed: "已被移出团队", left: "已离开团队" };
const ROSTER_REASON_TEXT: Readonly<Record<string, string>> = { offline: "联不上 Kimi Work 服务，也没有上次的同事名单", not_supported: "Kimi Work 服务还不支持同事名单" };
export const TEAM_SCOPE_CONFLICT_TEXT = "团队共享事项不能记为客户要求不上云：同事之间同步要经中软转送加密内容，与客户的要求不符。";

/** 内核原句兜底：换掉研发用语；内部错误、讲加密细节的原句不搬给律师。纯函数。 */
function lawyerize(code: string | null, m: string): string {
  if (!m || code === "internal" || /密钥|纪元|包裹/.test(m)) return "没有完成：请稍后重试；仍不行请联系 Kimi Work 客服";
  return m
    .replace(/(?:在)?中软共享中继上的控制成员|中继上的控制成员|控制成员/g, "负责同步的那位负责人")
    .replace(/经中软共享中继同步|经中继同步/g, "在同事之间同步")
    .replace(/中软共享中继|共享中继|中继/g, "同步服务")
    .replace(/律所策略/g, "律所规则");
}

/** 整句说明（改范围、建事项、开通 / 续期、记为不上云等）。纯函数。 */
export function teamFaultText(e: unknown): string {
  const f = teamFaultOf(e);
  if (f.code === "team_scope_unavailable" && f.reason && SCOPE_UNAVAILABLE_TEXT[f.reason]) return SCOPE_UNAVAILABLE_TEXT[f.reason]!;
  if (f.code === "scope_irreversible") return "团队共享事项不能改回只有我：要结束共享请移出同事或结案。";
  if (f.code === "team_scope_conflict") return TEAM_SCOPE_CONFLICT_TEXT;
  if (f.code === "member_not_in_team") return `这位同事${MEMBER_REASON_TEXT[f.reason ?? ""] ?? "不在团队名单里（可能已离开团队）"}：不能加进事项。`;
  if (f.code === "roster_unavailable") return `${ROSTER_REASON_TEXT[f.reason ?? ""] ?? "暂时取不到同事名单"}：${f.reason === "not_supported" ? "请联系 Kimi Work 客服。" : "联网后再试。"}`;
  if (f.reason === "relay_not_configured") return "中软还没为本所开通同事之间同步的服务：请联系 Kimi Work 客服。";
  if (f.reason === "not_enabled") return "同事之间同步还没开通：请先开通。";
  return lawyerize(f.code, f.message);
}

/** 某位同事没加上 / 改角色 / 移出没成功的原因：名单类给短语，其余给整句。纯函数。 */
export function memberErrorText(e: unknown): string {
  const f = teamFaultOf(e);
  if (f.code === "member_not_in_team") return MEMBER_REASON_TEXT[f.reason ?? ""] ?? "不在团队名单里（可能已离开团队）";
  if (f.code === "roster_unavailable") return f.reason === "not_supported" ? "Kimi Work 服务还不支持同事名单" : "暂时取不到同事名单，联网后再试";
  return teamFaultText(e);
}

/** 建事项（带同事）没成功的一句：整体失败、不留“建了一半”（契约 02 §2.2），说清要怎么做；nameOf 用来写出是哪位同事。纯函数。 */
export function createErrorText(e: unknown, nameOf: (userId: string) => string | null = () => null): string {
  const f = teamFaultOf(e);
  if (f.code === "member_not_in_team") {
    const who = (f.userId && nameOf(f.userId)) || "选的同事里有人";
    return `${who}${MEMBER_REASON_TEXT[f.reason ?? ""] ?? "已不在团队名单里"}，事项没有建：请重新选同事后再建。`;
  }
  if (f.code === "roster_unavailable") return `${ROSTER_REASON_TEXT[f.reason ?? ""] ?? "暂时取不到同事名单"}，事项没有建：可以先选“只有我”建好，之后在事项里加同事。`;
  return teamFaultText(e);
}

/**
 * 工作空间类型（D-307 与内核终版注意事项 ①）：已知就用；不知道（null：刚接受邀请切到的团队档案，内核约 2 分钟内补记）时看同事名单——
 * 取得到或有离线缓存按团队处理（入口照常给，最终由内核判断并如实显示原因）；名单说是个人空间按个人；名单不支持（开发形态、试用版）仍不出现。纯函数。
 */
export function effectiveKind(kind: WorkspaceKind | null, roster: Pick<TeamRoster, "available" | "reason"> | null | undefined): WorkspaceKind | null {
  if (kind) return kind;
  if (!roster) return null;
  if (roster.available || roster.reason === "offline") return "team";
  return roster.reason === "personal_workspace" ? "personal" : null;
}

/** “记为客户要求不上云”（开始前确认里的出口）在团队共享事项上置灰的原因（内核 team_scope_conflict 同一说法）；不是团队共享事项为 null。纯函数。 */
export function localOnlyBlocked(m: { collab_scope?: string | null }): string | null {
  return m.collab_scope === "team" ? "团队共享事项不能记为客户要求不上云（同事之间同步要经中软转送加密内容）：可以先只用本机功能；客户确实不同意上云的，请另建一个“只有我”的事项。" : null;
}

/**
 * 设置 → 团队 → 团队策略首行“同事之间同步”（D-309）：三态（需中软开通 / 未开通 / 已开通至某日）+ 待第二位管理员确认、已过期。纯函数。
 * action：这台电脑能做的一步（开通 / 发起开通 / 续期 / 去确认）；can_manage 为 false（合伙人等）时只读。
 */
export function shareRelayRow(s: ShareRelayStatus | null, now = Date.now()): { state: "configure" | "off" | "on" | "expiring" | "pending" | "expired" | "unknown"; text: string; action: { kind: "enable" | "renew" | "review"; label: string } | null; warn: boolean } {
  if (!s) return { state: "unknown", text: "暂时读不到同事之间同步的状态", action: null, warn: false };
  if (!s.relay_configured) return { state: "configure", text: "未开通 · 需要中软为本所开通同事之间同步的服务，请联系 Kimi Work 客服", action: null, warn: false };
  const manage = s.can_manage;
  const more = Math.max(0, (s.threshold || 1) - (s.signatures || 0));
  if (s.state === "pending_second_signature") {
    const what = s.pending?.kind === "renew" ? "续期" : "开通";
    const text = `已发起${what} · 还需 ${more || 1} 位管理员在自己的电脑上确认`;
    // 发起的是别人、我还没确认：在这台电脑上点一下即确认同一份（内核找一致的待签草稿）；是我发起的：只等
    if (manage && s.pending && !s.pending.signed_by_me) return { state: "pending", text: `另一位管理员已发起${what} · 还需你确认`, action: { kind: s.pending.kind, label: `确认${what}…` }, warn: false };
    // 旧内核不给 pending：退回到下面“待确认的规则草稿”里确认
    return { state: "pending", text, action: manage && !s.pending ? { kind: "review", label: "去确认 ↓" } : null, warn: false };
  }
  if (s.state === "expired") return { state: "expired", text: "已过期 · 同事之间同步已暂停，事项内容不受影响", action: manage ? { kind: "renew", label: "续期…" } : null, warn: true };
  if (s.state === "allowed") {
    const left = s.days_left;
    const until = s.expires_at ? `${dueLabel(s.expires_at, now)} 前有效` : "已开通";
    if (typeof left === "number" && left <= 7)
      return { state: "expiring", text: `已开通 · ${until}（还有 ${Math.max(0, left)} 天）`, action: manage ? { kind: "renew", label: "续期…" } : null, warn: true };
    // 离到期还早：只说状态，不给按钮（到期前 7 天才提醒续期）
    return { state: "on", text: `已开通 · ${until}`, action: null, warn: false };
  }
  return { state: "off", text: "未开通 · 团队共享事项暂时不会在同事电脑之间同步", action: manage ? { kind: "enable", label: (s.threshold || 1) > 1 ? "发起开通…" : "开通…" } : null, warn: false };
}

/** 开通弹窗的后果（A5 §5.2；沿用起草表单原句）。threshold > 1 时补一句还需另一位管理员；signsPending = 我是第二位、确认后即生效。纯函数。 */
export function shareRelayEnableLines(threshold: number, signsPending = false): string[] {
  return [
    "团队共享事项的内容加密后经中软在同事电脑之间转送，中软打不开。",
    "本机删除事项不会删除中软上的加密副本；关闭后已存的副本保留到律所停止使用。",
    "没更新软件的电脑会暂时按最严规则运行，直到更新。",
    ...(threshold > 1 && !signsPending ? [`本所规则要 ${threshold} 位管理员分别确认：你确认后，还需另一位管理员在自己的电脑上确认才生效。`] : []),
    "只改这一项：本所规则的其他各项保持现在生效的样子；有效期 30 天，到期前 7 天会提醒续期。",
  ];
}

/** 续期弹窗：本所规则原样再确认一次（新有效期）；已过期时是按最后一份规则原样恢复。带上的其它放宽项另行逐条写出（carriedLine，所见即所签）。纯函数。 */
export function shareRelayRenewLines(threshold: number, signsPending = false, expired = false): string[] {
  return [
    expired ? "按过期前最后一份本所规则原样恢复，有效期从今天起算 30 天；规则内容与过期前一样。" : "按现在的本所规则原样再确认一次，有效期从今天起算 30 天；规则内容不变。",
    expired ? "续期之前，团队共享事项暂停在同事电脑之间同步，事项内容不受影响。" : "到期不续，团队共享事项会暂停在同事电脑之间同步，事项内容不受影响。",
    ...(threshold > 1 && !signsPending ? [`本所规则要 ${threshold} 位管理员分别确认：你确认后，还需另一位管理员在自己的电脑上确认才生效。`] : []),
  ];
}

/** 律所规则的放宽项代码 → 人话（签名前给管理员看清楚同时确认了什么；设置 → 团队策略同一套说法）。纯函数。 */
const RELAX_MODE_TEXT: Readonly<Record<string, string>> = { chat: "只问答", manual: "每步问我", default: "标准", auto: "放手做" };
export function relaxationText(r: string): string {
  const [k, ...rest] = r.split(":");
  const v = rest.join(":");
  if (k === "max_mode") return `AI 最高档位放宽到“${RELAX_MODE_TEXT[v] ?? v}”`;
  if (k === "auto_preauthorization") return v === "search_generalized" ? "“放手做”可以事先同意：去掉当事人名称后的检索" : `“放手做”可以事先同意：${v}`;
  if (k === "fetch_allowlist") return `官方网站之外还可打开的网站：${v}`;
  if (k === "l3a_standard_model") return "敏感事项可以用通用 AI 服务（全部化名）";
  if (k === "support_upload") return "律师可以把问题报告直接发给客服（每次确认；保存 7 天）";
  if (k === "share_relay") return "同事之间可以经中软同步团队事项（加密，中软打不开）";
  if (k === "connector") return `登记律所系统接入：${v}`;
  return r;
}

/**
 * 开通 / 续期时一并确认的其它放宽项（内核 carry_relaxations；没有时 null）。纯函数。
 * mode：enable = 开通（“同时仍允许”）；renew = 生效中续期（“续期后仍允许”）；restore = 已过期续期（“一并恢复”——过期期间按最严运行，续期会把它们恢复）。
 */
export function carriedLine(codes: readonly string[] | null | undefined, mode: "enable" | "renew" | "restore" = "enable"): string | null {
  const list = (codes ?? []).filter((c) => !c.startsWith("share_relay")).map(relaxationText);
  if (list.length === 0) return null;
  const head = mode === "restore" ? "续期会一并恢复这些放宽项" : mode === "renew" ? "续期后仍允许" : "这次确认的规则里同时仍允许";
  return `${head}：${list.join("；")}。`;
}

/** 到期提醒（侧栏、团队页顶部）：7 天内。纯函数。 */
export function relayExpiringText(daysLeft: number | null | undefined): string | null {
  if (typeof daysLeft !== "number" || !Number.isFinite(daysLeft) || daysLeft > 7) return null;
  return daysLeft <= 0 ? "同事之间同步今天到期" : `同事之间同步 ${daysLeft} 天后到期`;
}

/**
 * 上手清单团队版底注（D-310，A5 §6.3）：按事项范围如实说——只有我的在你电脑上，一起办的也在加进来的同事电脑上。纯函数。
 */
export function guideScopeNote(): string {
  return "“只有我”的事项只在你的电脑上；“和同事一起办”的也在加进来的同事电脑上。团队管理员都看不到内容。";
}
