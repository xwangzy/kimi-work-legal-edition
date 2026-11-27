/**
 * 第 73 批（V47，D-307～D-310，契约 02 §3）：团队共享事项在界面这一侧的纯函数——谁能看到、选同事、事项成员行、同步状态、开通同事之间同步。
 *
 * - 只在团队空间出现（个人空间一处不变）；“和同事一起办”要这台电脑经团队确认（律所根签的证书），且事项不是“客户要求不上云”。
 * - 同事电脑能否接收与第 72 批同一口径（lib/workspace.ts shareReadyText 的 peer 分支），不另起句库。
 * - 所内没开通同事之间同步时允许建团队事项，如实说“开通后才收得到”；这句只在列表上方说一次，不逐行重复。
 * - 律师层不讲中继、证书、密钥、纪元、包裹（用例 b73-team-matters-ui 把这几个词作为本批文案的门禁）。
 */
import type { MatterMemberRow, MatterRole, MatterSync, RelayStatus, ShareRelayStatus, TeamRoster, TeamRosterMember } from "../api.ts";
import { shareReadyText, WS_ROLE_LABEL, type WorkspaceKind, type WorkspaceRole } from "./workspace.ts";

export type CollabScope = "personal" | "team";

/** 新建事项“谁能看到”的两段（A5 §6.3 定稿）。 */
export const SCOPE_OPTIONS: readonly { v: CollabScope; label: string; hint: string }[] = [
  { v: "personal", label: "只有我", hint: "只在你的电脑上；以后可以在事项里加同事。" },
  // 设计评分第一轮（跨页 2）：律师层不讲服务方与加密原理的细节，只说“加密同步”
  { v: "team", label: "团队共享", hint: "加进来的同事在自己的电脑上也能看到、一起办；内容在你们的电脑之间加密同步。" },
];

/** 所内还没开通同事之间同步（规则没允许）。 */
export const RELAY_NOT_ALLOWED_TEXT = "所内还没开通同事之间同步：加进来的同事要等管理员开通后才收得到。";
/** 中软还没为本所开通（服务没部署）。 */
export const RELAY_NOT_CONFIGURED_TEXT = "中软还没为本所开通同事之间同步：加进来的同事要等开通后才收得到。";
/** 第 73 批（验收 P2-1）：我没有 AI 使用名额，同事之间同步用不了（律师层说“AI 使用名额”，不说席位）。 */
export const NO_SEAT_TEXT = "你还没有分配到 AI 使用名额，同事之间同步用不了：请找管理员在“设置 → 团队”里分配。";
/** 第二轮复评 T13（43）：这台电脑已确认、但我没有 AI 使用名额——合成一句，不打对勾。 */
export const NO_SEAT_CONFIRMED_TEXT = "这台电脑已经管理员确认；但你还没有分配到 AI 使用名额，同事之间同步暂时用不了：请找管理员在“设置 → 团队”里分配。";
/** 第 73 批（验收 P2-2）：负责人已把我移出这个事项（本机如实得知）。 */
export const REMOVED_ME_TEXT = "负责人已把你移出这个事项：之后同事的改动你不会再收到，你的改动也不会再同步给同事；你电脑上已有的内容保留，只能查看。";
/** 被移出的成员“从我的电脑移除”（第二轮复评 T13，内核 matters.remove_local_copy）：确认框要写清的三件事。纯函数。 */
export function removeLocalCopyLines(): string[] {
  return [
    "删除这台电脑上这个事项的全部内容（材料副本、代号对照、审查意见、事实、成果正文），删除后在这台电脑上无法恢复。",
    "负责人和其他同事电脑上的这个事项、中软那里的加密副本都不受影响。",
    "删除后生成删除回执，写明删了什么、哪些副本保留；法律保全中的事项不能删除。",
  ];
}
/** 连不上 Kimi Work（离线）时的统一说法开头（第二轮复评 T14：“联 / 连”、服务叫法统一）。 */
export const OFFLINE_HEAD = "暂时连不上 Kimi Work";

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

/** 什么时候值得让内核看一眼所内规则是不是刚放开（team.refresh_share_state）：只在“没开通 / 不知道”时；已开通、没部署都不用。纯函数。 */
export function needsShareRefresh(sync: MatterSync | null | undefined): boolean {
  // 内核在“没有名额”时同样按节流同步一次（管理员刚分配了名额就能马上用上）
  return sync === "not_allowed" || sync === "unknown" || sync === "no_seat";
}

/** relay.status → 事项成员页同一套状态（与内核 matters.members.list 的 sync 同口径）。纯函数。 */
export function relaySyncOf(st: Pick<RelayStatus, "blocked" | "policy_fallback" | "credential_error"> | null | undefined): MatterSync {
  if (!st) return "unknown";
  // 没分配过名额（no_seat）与被收回（seat_revoked，实拍：管理员释放名额后凭据报这个）都是“没有名额”
  if (st.credential_error === "credential_no_seat" || st.credential_error === "credential_seat_revoked") return "no_seat";
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
 * 顺序：云端还没有同事名单能力（整块不出现）→ 客户要求不上云（与这件事项的选择相关，就近说）→ 这台电脑还没经团队确认。
 */
export function scopeAvailability(o: { kind: WorkspaceKind | null; issuer: "firm_root" | "account_ca" | null; level: string; roster?: Pick<TeamRoster, "reason"> | null; /** 这台电脑已申请接收、等管理员确认（team.deviceShare.status = pending）。 */ applied?: boolean }): ScopeAvailability {
  if (o.kind !== "team") return { show: false, team: false, reason: null, apply: false };
  // 云端还没有同事名单能力（team.roster 回 not_supported，如线上 1.6 / 1.7）：团队共享相关入口照旧不出现（协调方口径；团队页那一行另说 CLOUD_UPGRADE_TEXT）
  if (o.roster?.reason === "not_supported") return { show: false, team: false, reason: null, apply: false };
  if (o.level === "strict") return { show: true, team: false, reason: "客户要求不上云的事项只在这台电脑上，不能设为团队共享。", apply: false };
  // 只在确知这台电脑是直接登录、还没经团队确认时置灰；不知道（null）时交给内核判断（device_not_confirmed 如实显示）
  // 端到端验收 P3-2：已申请、等确认时不再给“去申请 →”，如实说在等谁
  if (o.issuer === "account_ca")
    return o.applied
      ? { show: true, team: false, reason: "这台电脑已申请，等管理员确认后就能设为团队共享。", apply: false }
      : { show: true, team: false, reason: "这台电脑还没经管理员确认，不能设为团队共享：申请并确认后就可以。", apply: true };
  return { show: true, team: true, reason: null, apply: false };
}

/** 选中“谁能看到”某一项时下面那一行说明；团队共享且所内没开通同步时换成如实的一句。纯函数。 */
export function scopeHint(scope: CollabScope, relay: boolean | null, configured: boolean | null = null, sync: MatterSync | null = null): string {
  if (scope === "team" && sync === "no_seat") return NO_SEAT_TEXT;
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

/** 选同事列表 6 人及以上时出搜索框（设计评分第一轮跨页 4）；按姓名包含匹配。纯函数。 */
export const PICKER_SEARCH_FROM = 6;
export function filterColleagues(list: readonly TeamRosterMember[], q: string): TeamRosterMember[] {
  const k = q.replace(/\s+/g, "");
  return k ? list.filter((m) => m.name.replace(/\s+/g, "").includes(k)) : [...list];
}

/** 选同事每一行的小字：角色 · 电脑还不能接收。纯函数。 */
export function colleagueMeta(m: Pick<TeamRosterMember, "role" | "can_receive" | "seat">): string {
  const role = m.role in WS_ROLE_LABEL ? WS_ROLE_LABEL[m.role as WorkspaceRole] : "";
  // 没有 AI 使用名额比“电脑还不能接收”更先挡住他（验收 P2-1）
  const why = m.seat === false ? "还没有 AI 使用名额" : shareReadyText({ kind: "peer", confirmed: m.can_receive, relay: null });
  return [role, why].filter(Boolean).join(" · ");
}

/** 名单取不到时选同事处的一句（不是错误：可以先建好，联网后在事项里加）。纯函数。 */
export function rosterNote(r: Pick<TeamRoster, "available" | "reason" | "members"> | null): string | null {
  if (!r) return "正在取同事名单…";
  if (r.available) return null;
  if (r.reason === "offline") return r.members.length > 0 ? `${OFFLINE_HEAD}：下面是上次取到的同事名单。` : `${OFFLINE_HEAD}，取不到同事名单：可以先建好，联网后在事项里加同事。`;
  if (r.reason === "not_supported") return `同事名单${CLOUD_UPGRADE_TEXT}。`;
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
export function memberRowNote(m: Pick<MatterMemberRow, "departed" | "can_receive" | "is_me" | "seat">): { text: string; tone: "off" | "quiet"; /** 没有名额：看页面的人是团队管理员时给“去分配 →”。 */ assign?: boolean } | null {
  // 设计评分第一轮 T10：已离开的行补一句后果（他现在收不到新内容的前提是移出；已有的不收回）
  if (m.departed) return { text: "他已离开团队：建议从事项移出，此后的新内容就不会再给他；他电脑上已有的内容不会被收回。", tone: "off" };
  if (m.is_me) return null;
  if (m.seat === false) return { text: "他还没有分配到 AI 使用名额，收不到这个事项：请管理员在“设置 → 团队”里分配。", tone: "quiet", assign: true };
  if (m.can_receive) return null;
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
      return { text: `${OFFLINE_HEAD}：改动先留在这台电脑上，连上后自动同步给同事。`, enable: false };
    case "pending":
      // 内核：刚建、刚改为团队共享，或有改动还没发出（会自动重试）
      return { text: "这个事项还在等第一次同步：联网时会自动同步给同事。", enable: false };
    case "no_seat":
      return { text: NO_SEAT_TEXT, enable: false };
    case "removed":
      return { text: REMOVED_ME_TEXT, enable: false };
    default:
      return null;
  }
}

/** 事项头胶囊（D-310）：“团队共享 · 3 人”；还没取到人数时只写“团队共享”。读屏另有一句。纯函数。 */
export function teamPillText(n: number | null | undefined): { label: string; aria: string } {
  return typeof n === "number" && n > 0 ? { label: `团队共享 · ${n} 人`, aria: `团队共享，${n} 位事项成员，展开查看` } : { label: "团队共享", aria: "团队共享，展开查看事项成员" };
}

/** 人数口径（设计评分第一轮 T10）：胶囊与“事项成员 n”只数还在团队里的人，已离开的另计。纯函数。 */
export function memberCounts(rows: readonly Pick<MatterMemberRow, "departed">[]): { active: number; departed: number } {
  const departed = rows.filter((r) => r.departed).length;
  return { active: rows.length - departed, departed };
}

/**
 * 这个事项是不是团队共享事项（范围事实）：只在不是个人空间时成立（个人空间不可能有团队共享事项，D-310）。纯函数。
 * 侧栏 / 列表 / 搜索上显示什么记号另看 matterMark（负责人已把我移出的显示“已移出”，不显示团队共享）。
 */
export function isTeamShared(m: { collab_scope?: string | null } | null | undefined, kind: WorkspaceKind | null): boolean {
  return !!m && m.collab_scope === "team" && kind !== "personal";
}
/** 菜单、搜索副标题的前缀（“团队共享 · 客户甲 / 乙公司”）。纯函数。 */
export function teamPrefix(sub: string, shared: boolean): string {
  return shared ? (sub ? `团队共享 · ${sub}` : "团队共享") : sub;
}

/**
 * 侧栏 / 事项列表 / 搜索 / 输入框里的事项记号（协调方口径，第 73 批）：团队共享事项带灰色两人记号；
 * 负责人已把我移出的不再带团队共享记号，改为灰色“已移出”小标（读屏同）；个人空间都不出现。纯函数。
 */
export type MatterMark = "shared" | "removed" | null;
export function matterMark(m: { collab_scope?: string | null; removed_me?: boolean | null } | null | undefined, kind: WorkspaceKind | null): MatterMark {
  if (!m || kind === "personal") return null;
  if (m.removed_me) return "removed";
  return m.collab_scope === "team" ? "shared" : null;
}
/** 菜单、搜索副标题按记号加前缀（团队共享 · / 已移出 ·）。纯函数。 */
export function markPrefix(sub: string, mark: MatterMark): string {
  if (!mark) return sub;
  const head = mark === "removed" ? "已移出" : "团队共享";
  return sub ? `${head} · ${sub}` : head;
}

/** 云端还没有同事名单能力（team.roster 回 not_supported，如连线上 1.6 / 1.7）时团队页那一行的说法（协调方口径）。 */
export const CLOUD_UPGRADE_TEXT = "需要中软把云端升级后才能使用";

/**
 * 我是负责人、但这台电脑现在不能调整成员时的一句（内核 can_manage = false）：最先同步这个事项的是另一位负责人 / 负责人暂时无法确认 / 已结案。纯函数。
 */
export function manageBlockedText(v: { is_owner: boolean; can_manage?: boolean; relay_controller?: string | null; members: readonly Pick<MatterMemberRow, "user_id" | "name" | "is_me">[] }, closed: boolean): string | null {
  if (!v.is_owner) return null;
  if (closed) return "事项已结案（只读）：不能再加同事、改角色或移出。";
  if (v.can_manage !== false) return null;
  const ctl = v.relay_controller ? v.members.find((m) => m.user_id === v.relay_controller && !m.is_me) : null;
  if (ctl) return `这个事项的同事名单由${memberName(ctl)}管理：要加人、改角色或移出，请找他。`;
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
export function addResultText(added: readonly { name: string; can_receive: boolean; /** 第三轮实拍：没有 AI 使用名额的同事单说（不是“电脑经确认后收到”）。 */ seat?: boolean | null }[], failed: readonly { name: string; why: string }[], sync: MatterSync | null | undefined): string {
  const parts: string[] = [];
  if (added.length > 0) {
    const names = added.map((a) => a.name).join("、");
    const noSeat = added.filter((a) => a.seat === false).map((a) => a.name);
    const rest = added.filter((a) => a.seat !== false);
    const later = rest.filter((a) => !a.can_receive).map((a) => a.name);
    const now = rest.filter((a) => a.can_receive).map((a) => a.name);
    const seatPart = noSeat.length > 0 ? `${noSeat.join("、")}还没有分配到 AI 使用名额，分配后才收得到` : "";
    let tail: string;
    // 所内没开通同步：列表上方那句已经说了“要等开通后才收得到”（实拍：同一页说两遍），这里只说各人电脑的情况
    if (sync === "not_allowed" || sync === "not_configured") {
      const segs = [later.length > 0 ? `${later.join("、")}的电脑经管理员确认后才收得到` : "", seatPart].filter(Boolean);
      tail = segs.length > 0 ? `${segs.join("；")}。` : "";
    } else
      tail = [now.length > 0 ? `${now.join("、")}的电脑下次同步时收到` : "", later.length > 0 ? `${later.join("、")}的电脑还不能接收，申请并经管理员确认后自动收到` : "", seatPart].filter(Boolean).join("；") + "。";
    parts.push(`已加入${names}。${tail}`);
  }
  if (failed.length > 0) parts.push(`没有加上：${failed.map((f) => `${f.name}（${f.why}）`).join("；")}。`);
  return parts.join("");
}

/** 个人事项改为和同事一起办（D-307）：二次确认要写清的三件事（不可改回在最后）。纯函数。 */
export function shareMatterLines(): string[] {
  return [
    "加进来的同事在自己的电脑上也能看到这个事项的材料、任务和成果，内容在你们的电脑之间加密同步。",
    "改为团队共享后，正在等你确认的任务需要重新确认一次。",
    "之后不能改回“只有我”：要结束共享，把同事逐个移出，或结案。",
  ];
}

/**
 * “⋯ → 和同事一起办…”出不出现（D-307）：团队空间、个人事项、我是负责人、进行中。能不能做另由 scopeAvailability 判（弹窗里说原因）。纯函数。
 */
export function canOfferShare(kind: WorkspaceKind | null, m: { collab_scope?: string | null; my_role?: string | null; lifecycle?: string | null; is_sample?: boolean | null }, roster?: Pick<TeamRoster, "reason"> | null): boolean {
  // 云端还没有同事名单能力时不出现（与“谁能看到”同一口径）
  if (roster?.reason === "not_supported") return false;
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
export function teamFaultOf(e: unknown): { code: string | null; reason: string | null; userId: string | null; manager: string | null; message: string } {
  const x = e as { code?: unknown; detail?: { reason?: unknown; user_id?: unknown; controller_name?: unknown; manager_name?: unknown; controller_user_id?: unknown }; message?: unknown } | null;
  const d = x?.detail;
  const manager = typeof d?.controller_name === "string" ? d.controller_name : typeof d?.manager_name === "string" ? d.manager_name : null;
  return {
    code: typeof x?.code === "string" ? x.code : null,
    reason: typeof d?.reason === "string" ? d.reason : null,
    userId: typeof d?.user_id === "string" ? d.user_id : null,
    // 内核不认识姓名时给的是编号：律师层不露编号
    manager: manager && manager.trim() && !/^usr_/.test(manager) ? manager.trim() : null,
    message: typeof x?.message === "string" ? x.message.trim() : "",
  };
}

/**
 * 内核终版补的事项成员页拒绝原因（cdd366a0，detail.reason；原句已是律师层的话，另带 controller_name）：
 * 同事名单由别人管理 / 规则要更新 / 正在确认由谁管理 / 状态异常 / 管理人已不是负责人 / 管理人电脑都已停用 / 不能给管理人降角色 /
 * 负责人暂时确认不了 / 成员事件不成立 / 这台电脑还没拿到最新内容。
 */
const KERNEL_LAWYER_REASONS = new Set(["viewer_read_only", "removed_from_matter", "relay_policy_stale", "relay_controller_pending", "relay_state_broken", "relay_controller_not_owner", "relay_controller_departed", "relay_controller_role_change", "owner_unverifiable", "member_event_invalid", "own_wrap_missing", "consent_refused", "strict"]);

const SCOPE_UNAVAILABLE_TEXT: Readonly<Record<string, string>> = {
  personal_workspace: "个人空间里的事项只在你自己的电脑上：要设为团队共享，请先切换到团队空间。",
  workspace_unknown: "还没确认当前是团队空间（刚加入团队时要等一会儿）：请联网后稍等再试。",
  device_not_confirmed: "这台电脑还没经管理员确认，不能设为团队共享：请在“设置 → 团队”里申请，确认后就可以。",
  client_no_cloud: "客户要求不上云的事项不能设为团队共享：团队共享事项要在同事电脑之间加密同步，与客户的要求不符。",
};
/** 某位同事加不进来的原因（短语，放在“没有加上：某某（原因）”里）。 */
const MEMBER_REASON_TEXT: Readonly<Record<string, string>> = { not_in_roster: "不在团队同事名单里", disabled: "已停用", removed: "已被移出团队", left: "已离开团队" };
const ROSTER_REASON_TEXT: Readonly<Record<string, string>> = { offline: "暂时连不上 Kimi Work，也没有上次的同事名单" };
export const TEAM_SCOPE_CONFLICT_TEXT = "这是团队共享事项，要在同事电脑之间加密同步，不能记为客户要求不上云；客户确实不同意上云的，请另建一个“只有我”的事项。";

/** 内核原句兜底：换掉研发用语；内部错误、讲加密细节的原句不搬给律师。纯函数。 */
function lawyerize(code: string | null, m: string): string {
  if (!m || code === "internal" || /密钥|纪元|包裹/.test(m)) return "没有完成：请稍后重试；仍不行请联系 Kimi Work 客服";
  return m
    .replace(/(?:在)?中软共享中继上的控制成员|中继上的控制成员|控制成员/g, "负责同步的那位负责人")
    .replace(/经中软共享中继同步|经中继同步/g, "在同事之间同步")
    .replace(/中软共享中继|共享中继|中继/g, "同步服务")
    .replace(/律所策略/g, "律所规则")
    // 第二轮复评跨页 1：叫法统一为“团队共享”（内核原句里还有“和同事一起办”）
    .replace(/已和同事一起办/g, "已是团队共享")
    .replace(/改为和同事一起办/g, "改为团队共享")
    .replace(/“和同事一起办”的事项|和同事一起办的事项/g, "团队共享事项")
    .replace(/就能和同事一起办/g, "就能设为团队共享")
    .replace(/和同事一起办/g, "设为团队共享");
}

/** 整句说明（改范围、建事项、开通 / 续期、记为不上云等）。纯函数。 */
export function teamFaultText(e: unknown): string {
  const f = teamFaultOf(e);
  if (f.code === "team_scope_unavailable" && f.reason && SCOPE_UNAVAILABLE_TEXT[f.reason]) return SCOPE_UNAVAILABLE_TEXT[f.reason]!;
  if (f.code === "scope_irreversible") return "这个事项已是团队共享，不能改回“只有我”：要结束共享，请移出同事或结案。";
  if (f.code === "team_scope_conflict") return TEAM_SCOPE_CONFLICT_TEXT;
  if (f.code === "member_not_in_team") return `这位同事${MEMBER_REASON_TEXT[f.reason ?? ""] ?? "不在团队名单里（可能已离开团队）"}：不能加进事项。`;
  // 云端还没有同事名单能力：与团队页同一说法（协调方口径）
  if (f.code === "roster_unavailable") return f.reason === "not_supported" ? `同事名单${CLOUD_UPGRADE_TEXT}。` : `${ROSTER_REASON_TEXT[f.reason ?? ""] ?? "暂时取不到同事名单"}：联网后再试。`;
  if (f.reason === "relay_not_configured") return "中软还没为本所开通同事之间同步的服务：请联系 Kimi Work 客服。";
  if (f.reason === "not_enabled") return "同事之间同步还没开通：请先开通。";
  // 同事名单由别人管理（经中软同步的事项，只有最先同步它的负责人能调整成员）：写“由某某管理”，与成员页表尾同一说法
  if (f.reason === "relay_controller_other" && f.manager) return `这个事项的同事名单由${f.manager}管理：要加人、改角色或移出，请找他。`;
  // 其余已知原因：内核原句就是律师层的话（仍过一遍兜底替换）
  if (f.reason && (KERNEL_LAWYER_REASONS.has(f.reason) || f.reason === "relay_controller_other") && f.message) return lawyerize(null, f.message);
  return lawyerize(f.code, f.message);
}

/** 某位同事没加上 / 改角色 / 移出没成功的原因：名单类给短语，其余给整句。纯函数。 */
export function memberErrorText(e: unknown): string {
  const f = teamFaultOf(e);
  if (f.code === "member_not_in_team") return MEMBER_REASON_TEXT[f.reason ?? ""] ?? "不在团队名单里（可能已离开团队）";
  if (f.code === "roster_unavailable") return f.reason === "not_supported" ? `同事名单${CLOUD_UPGRADE_TEXT}` : "暂时取不到同事名单，联网后再试";
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

/**
 * “记为客户要求不上云”（开始前确认里的出口）在团队共享事项上置灰（内核 team_scope_conflict 同一口径）；不是团队共享事项为 null。纯函数。
 * 设计评分第一轮 T3：原因短到与置灰项同一行（short），完整说法放悬停（long）；不再重复左侧已有的“先只用本机功能”。
 */
export function localOnlyBlocked(m: { collab_scope?: string | null }): { short: string; long: string } | null {
  return m.collab_scope === "team" ? { short: "团队共享事项不能选", long: TEAM_SCOPE_CONFLICT_TEXT } : null;
}

/** 旧内核没有 data_flows 时团队共享事项的兜底（与内核 dataFlowsFor 同一说法）：固定列出同事电脑与中软加密副本。 */
const TEAM_FLOWS_FALLBACK: readonly { key: string; label: string; text: string }[] = [
  { key: "colleagues", label: "同事电脑", text: "经加密同步到事项成员的电脑；他们电脑上也有材料与成果" },
  { key: "zr_relay", label: "中软", text: "保存加密副本，打不开内容；本机删除事项不会删除中软上的加密副本" },
];

/** 同事电脑那一条的人数：内核给 count 用 count；否则从“本所同事 n 人”读；“之后加进来的同事”= 0；都没有为 null。纯函数。 */
export function colleaguesCount(f: { text: string; count?: number | null }): number | null {
  if (typeof f.count === "number") return f.count;
  const m = /本所同事 (\d+) 人/.exec(f.text);
  if (m) return Number(m[1]);
  return /之后加进来的同事/.test(f.text) ? 0 : null;
}

/** 同事之间同步还没开通时“同事电脑”一条（第二轮复评 T12：写成开通后会同步到哪里，不说已经同步）。纯函数。 */
export function colleaguesPendingText(n: number | null): string {
  const where = n === 0 ? "之后加进来的同事电脑" : n ? `本事项 ${n} 位同事的电脑` : "本事项同事的电脑";
  return `同事之间同步开通后，会加密同步到${where}；他们电脑上也会有材料与成果`;
}

/**
 * 客户授权卡里“数据去向”怎么写（验收 P2-3；第二轮复评 T12）：按事项范围的 data_flows——只有我的那一条（案卷只存这台电脑）接在“系统另外做到”后面；
 * 团队共享的（同事电脑、中软加密副本）各占一行。开始前确认与事项页“记录授权”同一来源（ai_authorization.get {matter_id}）。
 * team = 事项是团队共享：内核没给 data_flows（旧内核）时也固定列出“同事电脑”，不再写“案卷只存这台电脑”；
 * relay = false（所内还没开通同事之间同步）时“同事电脑”写成“开通后会同步到 n 位同事的电脑”。纯函数。
 */
export function authzFlowRows(
  flows: readonly { key: string; label: string; text: string; count?: number | null }[] | null | undefined,
  o: { team?: boolean; relay?: boolean | null } = {},
): { local: string | null; rows: { key: string; label: string; text: string }[] } {
  const list = flows && flows.length > 0 ? flows : o.team ? TEAM_FLOWS_FALLBACK : null;
  if (!list) return { local: "案卷只存这台电脑", rows: [] };
  const local = list.find((f) => f.key === "local")?.text ?? null;
  const rows = list
    .filter((f) => f.key !== "local")
    .map((f) => (f.key === "colleagues" && o.relay === false ? { key: f.key, label: f.label, text: colleaguesPendingText(colleaguesCount(f)) } : { key: f.key, label: f.label, text: f.text }));
  return { local, rows };
}

/**
 * 授权要重新确认的原因（验收 P2-3）：只有我的事项记过授权后改为和同事一起办——原授权没覆盖同事之间同步，要按新的范围重新记录；
 * 其余是次处理者清单更新。纯函数。
 */
export function reconfirmReason(m: { collab_scope?: string | null; basis_notice_version?: string | null; authorization_history?: readonly { scope?: string }[] | null }, currentVersion?: string | null): "scope" | "list" {
  if (m.collab_scope !== "team") return "list";
  const last = m.authorization_history?.[0];
  if (last?.scope) return last.scope === "personal" ? "scope" : "list";
  // 没有带范围的历史（事项列表里取的事项）：按清单版本判断——现在是团队共享的清单、原来记的不是
  const team = (v: string | null | undefined) => !!v && /-team$/.test(v);
  return team(currentVersion) && !!m.basis_notice_version && !team(m.basis_notice_version) ? "scope" : "list";
}

/** 团队共享事项的材料区说明（设计评分第一轮跨页：收到 / 放进材料的地方写明也会同步给加进来的同事）。纯函数。 */
export function sharedMaterialNote(shared: boolean): string | null {
  return shared ? "也会加密同步到加进来的同事电脑上" : null;
}

/** 日期（不带时刻）：“12 月 27 日”，跨年写年份（北京时间）。纯函数。 */
export function dayOnly(iso: string | null | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "—";
  const d = new Date(t + 8 * 3600_000);
  const y = new Date(now + 8 * 3600_000).getUTCFullYear();
  return `${d.getUTCFullYear() !== y ? `${d.getUTCFullYear()} 年 ` : ""}${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日`;
}

export type ShareRelayAction = { kind: "enable" | "renew" | "review" | "close"; label: string; primary: boolean };
/**
 * 设置 → 团队 → 团队策略首行“同事之间同步”（D-309）。纯函数。
 * 设计评分第一轮 T8：状态行只说一次——“● 未开通 [开通…]”/“● 已开通 · 12 月 27 日前有效 [续期…] [关闭…]”（到期前 7 天“续期…”提为主按钮）；
 * 不复述上方说明；结果另用一次性轻提示。can_manage 为 false（合伙人等）时只读。
 */
export function shareRelayRow(
  s: ShareRelayStatus | null,
  now = Date.now(),
  /** 同事名单（team.roster）：回 not_supported（云端还没有这项能力，如线上 1.6 / 1.7）时整行只说“需要中软把云端升级后才能使用”、不给按钮（协调方口径）。 */
  roster?: Pick<TeamRoster, "reason"> | null,
): { state: "upgrade" | "configure" | "off" | "on" | "expiring" | "pending" | "expired" | "unknown"; text: string; actions: ShareRelayAction[]; warn: boolean } {
  if (roster?.reason === "not_supported") return { state: "upgrade", text: CLOUD_UPGRADE_TEXT, actions: [], warn: false };
  if (!s) return { state: "unknown", text: "暂时读不到状态", actions: [], warn: false };
  if (!s.relay_configured) return { state: "configure", text: "未开通 · 需要中软为本所开通服务，请联系 Kimi Work 客服", actions: [], warn: false };
  const manage = s.can_manage;
  const more = Math.max(0, (s.threshold || 1) - (s.signatures || 0));
  if (s.state === "pending_second_signature") {
    const what = s.pending?.kind === "renew" ? "续期" : "开通";
    // 发起的是别人、我还没确认：在这台电脑上点一下即确认同一份（内核找一致的待签草稿）；是我发起的：只等
    if (manage && s.pending && !s.pending.signed_by_me) return { state: "pending", text: `另一位管理员已发起${what} · 还需你确认`, actions: [{ kind: s.pending.kind, label: `确认${what}…`, primary: true }], warn: false };
    // 旧内核不给 pending：退回到下面“待确认的规则草稿”里确认
    return { state: "pending", text: `已发起${what} · 还需 ${more || 1} 位管理员在自己的电脑上确认`, actions: manage && !s.pending ? [{ kind: "review", label: "去确认 ↓", primary: false }] : [], warn: false };
  }
  if (s.state === "expired") return { state: "expired", text: "已过期 · 同事之间同步已暂停", actions: manage ? [{ kind: "renew", label: "续期…", primary: true }] : [], warn: true };
  if (s.state === "allowed") {
    const left = s.days_left;
    const until = s.expires_at ? `${dayOnly(s.expires_at, now)}前有效` : "";
    const close: ShareRelayAction = { kind: "close", label: "关闭…", primary: false };
    if (typeof left === "number" && left <= 7)
      return { state: "expiring", text: `已开通 · ${until}${until ? " · " : ""}还有 ${Math.max(0, left)} 天`, actions: manage ? [{ kind: "renew", label: "续期…", primary: true }, close] : [], warn: true };
    return { state: "on", text: `已开通${until ? ` · ${until}` : ""}`, actions: manage ? [{ kind: "renew", label: "续期…", primary: false }, close] : [], warn: false };
  }
  // 第二轮复评 T8：这台电脑在按最严规则运行（没收到 / 确认人数不够 / 软件太旧）时，状态行写明原因与去向，不给“开通…”（开了也要先解决这件事）
  const why = s.fallback_reason ? FALLBACK_REASON_TEXT[s.fallback_reason] ?? "这台电脑暂按最严规则运行，联网后自动更新" : null;
  if (why) return { state: "off", text: `未开通 · ${why}`, actions: [], warn: false };
  return { state: "off", text: "未开通", actions: manage ? [{ kind: "enable", label: (s.threshold || 1) > 1 ? "发起开通…" : "开通…", primary: false }] : [], warn: false };
}

/** 本所规则没在这台电脑上生效的原因（内核 effectivePolicy().fallback_reason）→ 状态行后半句。 */
const FALLBACK_REASON_TEXT: Readonly<Record<string, string>> = {
  none_received: "这台电脑还没收到本所规则，联网后自动更新",
  expired: "本所规则已过期，续期后恢复",
  signers_insufficient: "本所规则的确认人数不够，暂按最严规则运行：请另一位管理员在自己的电脑上确认",
  unrecognized_newer: "本所规则比这台电脑上的软件新，暂按最严规则运行：请更新软件",
};

/**
 * 开通弹窗的后果（A5 §5.2）。threshold > 1 时补一句还需另一位管理员；signsPending = 我是第二位、确认后即生效。纯函数。
 * 设计评分第一轮 T8：服务方名字只在第一条出现一次，后面说“服务方”。
 */
export function shareRelayEnableLines(threshold: number, signsPending = false): string[] {
  return [
    "团队共享事项的内容加密后经服务方中软在同事电脑之间转送，服务方打不开。",
    "本机删除事项不会删除服务方那里的加密副本；关闭后，已存的副本保留到律所停止使用。",
    "没更新软件的电脑会暂时按最严规则运行，直到更新。",
    ...(threshold > 1 && !signsPending ? [`本所规则要 ${threshold} 位管理员分别确认：你确认后，还需另一位管理员在自己的电脑上确认才生效。`] : []),
    "只改这一项，本所规则的其他各项不变；有效期 30 天，到期前 7 天提醒续期。",
  ];
}

/** 关闭同事之间同步的确认框（内核没有单独的关闭方法：走起草本所规则，预置“不允许同事之间同步”）。纯函数。 */
export function shareRelayCloseLines(): string[] {
  return [
    "关闭后，团队共享事项暂停在同事电脑之间同步，各人电脑上的内容不受影响。",
    "服务方那里已存的加密副本保留到律所停止使用。",
    "关闭后要再开通，需要联系中软。",
    "关闭要改本所规则：下一步在下面“起草律所策略”里已预置“不允许同事之间同步”，核对后生成草稿、确认并发布。",
  ];
}

/** 续期弹窗：本所规则原样再确认一次（新有效期）；已过期时是按最后一份规则原样恢复。带上的其它放宽项另行逐条写出（carriedLine，所见即所签）。纯函数。 */
export function shareRelayRenewLines(threshold: number, signsPending = false, expired = false): string[] {
  return [
    expired ? "按过期前最后一份本所规则原样恢复，有效期从今天起算 30 天；规则内容与过期前一样。" : "按现在的本所规则原样再确认一次，有效期从今天起算 30 天；规则内容不变。",
    expired ? "续期之前，团队共享事项暂停同步，各人电脑上的内容不受影响。" : "到期不续，团队共享事项会暂停同步，各人电脑上的内容不受影响。",
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
  return "“只有我”的事项只在你的电脑上；“团队共享”的也在加进来的同事电脑上。团队管理员都看不到内容。";
}
