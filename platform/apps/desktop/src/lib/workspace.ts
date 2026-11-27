import { momentLabel } from "./account.ts";
/**
 * 第 72 批（V46，D-304、D-305，契约 02 §7）：个人 / 团队工作空间在界面这一侧的纯函数。
 *
 * - 显示哪些功能只看工作空间类型（内核状态 workspace_kind，其次 workspaces.list 的当前一项），不再按“有没有律所名”“证书角色是不是管理员”推断
 *   （A3 2.5：个人账号在内核里就是“只有自己、角色为管理员的律所”，按旧推断个人用户会看到“团队与离所”“管理”）。
 * - 四个动作语义分清：退出登录（这台电脑暂停用 AI，可再登录）/ 移除电脑（那台电脑不再能用这个账号）/
 *   移出团队（管理员把成员移出）/ 退出团队（成员自己离开）。
 * - 文案不出现内部术语（律所根、签发钥、租户、证书）。
 */

export type WorkspaceKind = "personal" | "team";
export type WorkspaceRole = "admin" | "partner" | "lawyer" | "assistant";

export interface WorkspaceLike {
  aid: string;
  kind: WorkspaceKind;
  name: string;
  role: WorkspaceRole | null;
  status?: "active" | "disabled";
  /** 停用的来由（云端 0c91ce19、内核 ac641d4c 转交）：停用 / 被团队移出 / 本人退出。 */
  disabled_kind?: "disabled" | "removed" | "left" | null;
  current?: boolean;
  local_profile?: boolean;
}

/** 内核证书角色（firm_admin / partner / lawyer …）→ 工作空间角色。纯函数。 */
export function roleOfMember(memberRole: string | null | undefined): WorkspaceRole | null {
  if (memberRole === "firm_admin" || memberRole === "admin") return "admin";
  if (memberRole === "partner" || memberRole === "lawyer" || memberRole === "assistant") return memberRole;
  return null;
}

/** 工作空间类型：内核状态优先（登录 / me / 升级时记下），其次列表的当前一项；都没有 = null（开发形态、试用版、还没登录）。纯函数。 */
export function resolveKind(statusKind: unknown, listCurrent: { kind?: unknown } | null | undefined): WorkspaceKind | null {
  if (statusKind === "personal" || statusKind === "team") return statusKind;
  const k = listCurrent?.kind;
  return k === "personal" || k === "team" ? k : null;
}

export interface WorkspaceFeatures {
  kind: WorkspaceKind | null;
  role: WorkspaceRole | null;
  /** 设置里的“团队”页签（团队空间的所有成员）。 */
  teamTab: boolean;
  /** 团队管理：成员、邀请、待确认电脑、新电脑策略（管理员可改；合伙人只读成员）。 */
  teamAdmin: boolean;
  teamRead: boolean;
  /** 设置里的“管理”页签（团队策略、操作记录、技术支持、代号准确度）：只给团队的管理员、合伙人；个人空间没有。 */
  adminTab: boolean;
  /** 个人空间：设置 · 账号里有“升级为团队”。 */
  upgrade: boolean;
  /** 个人空间的技术支持（原来在“管理”里）收进“备份与安全”页底的折叠。 */
  supportInBackup: boolean;
}

/**
 * 按工作空间类型与角色给出界面要显示的功能。kind = null（开发形态、试用版）时保留旧行为里与团队无关的部分：
 * 证书角色是管理员时仍有“管理”（技术支持等），没有团队页签、没有升级入口。纯函数。
 */
export function workspaceFeatures(kind: WorkspaceKind | null, role: WorkspaceRole | null): WorkspaceFeatures {
  const team = kind === "team";
  const admin = role === "admin";
  const partner = role === "partner";
  return {
    kind,
    role,
    teamTab: team,
    teamAdmin: team && admin,
    teamRead: team && (admin || partner),
    adminTab: kind === "personal" ? false : admin || partner,
    upgrade: kind === "personal",
    supportInBackup: kind === "personal",
  };
}

export const KIND_LABEL: Readonly<Record<WorkspaceKind, string>> = { personal: "个人", team: "团队" };
export const WS_ROLE_LABEL: Readonly<Record<WorkspaceRole, string>> = { admin: "管理员", partner: "合伙人", lawyer: "律师", assistant: "助理" };

/** 侧栏与菜单里的一行：“王律师的工作室 · 个人”“某某律师事务所 · 团队”。纯函数。 */
export function workspaceLabel(w: Pick<WorkspaceLike, "kind" | "name"> | null | undefined): string {
  if (!w) return "";
  const name = (w.name ?? "").trim() || (w.kind === "personal" ? "个人工作室" : "团队");
  return `${name} · ${KIND_LABEL[w.kind]}`;
}

/** 团队空间的角色小字（个人空间不写角色：个人工作室里你就是唯一的成员）。纯函数。 */
export function workspaceRoleTag(w: Pick<WorkspaceLike, "kind" | "role"> | null | undefined): string | null {
  return w && w.kind === "team" && w.role ? WS_ROLE_LABEL[w.role] : null;
}

/** 范本库名称：个人空间“我的范本”，团队空间“本所范本”（都存在这台电脑上，不同步）。纯函数。 */
export function templatesLabel(kind: WorkspaceKind | null): { short: string; library: string; owner: string } {
  return kind === "personal" ? { short: "我的范本", library: "我的范本库", owner: "我" } : { short: "本所范本", library: "本所范本库", owner: "本所" };
}

/** 邀请码输入：去空白、转大写、只留字母数字，按 4 位一组加横线（最多 16 位）。纯函数。 */
export function formatInviteCode(v: string): string {
  const bare = v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
  return bare.replace(/(.{4})(?=.)/g, "$1-");
}
export function inviteCodeComplete(v: string): boolean {
  return /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(v);
}

/** 团队名称（升级时）：2～40 个字。纯函数。 */
export function teamNameOk(v: string): boolean {
  const n = [...v.replace(/\s+/g, " ").trim()].length;
  return n >= 2 && n <= 40;
}

/** “把工作室升级为团队”的二次确认要写清的五件事（D-305 第 3 条）。纯函数。 */
export function upgradeLines(name: string): string[] {
  return [
    `还是同一个工作空间，名称改为「${name.trim() || "新的团队名"}」；事项、材料、成果和电脑都原地不动。`,
    // 第 72 批（补测 D6，主会话决定）：事项级“开启团队共享 / 把同事加进事项”的界面本批不做——不承诺入口
    "你原有的事项仍只属于你，同事看不到；团队共享事项需要所内先配置共享通道。",
    "升级后可以邀请同事加入；同事的事项内容只在他们自己的电脑上，你也看不到。",
    "升级不能撤回：之后不能再变回个人工作室。",
  ];
}

/** 退出团队（成员自己）的后果说明。纯函数。 */
export function leaveLines(team: string, back: string | null, handover = true): string[] {
  return [
    `退出后你不再是「${team}」的成员：你在团队里的 AI 使用名额随即释放，团队共享给你的事项此后收不到新内容。`,
    // 没有要交接的事项时不再重复“先交接”（评分 C15：交接说明只讲一次）
    handover ? "这台电脑上团队空间里的事项和成果不会被删除；你负责的事项请先交接给同事。" : "这台电脑上团队空间里的事项和成果不会被删除。",
    back ? `退出后这台电脑切到「${back}」，那里的事项不受影响。` : "退出后这台电脑切到你的另一个工作空间。",
    "不能自己撤回：要回来，需要团队管理员在成员列表里重新启用，或重新邀请你。",
  ];
}

/**
 * 日期时刻的产品通用写法（第 72 批评分 C10 第 4 条）：“12 月 4 日 12:49”，跨年才写年份（北京时间，与 lib/account.ts dayLabel 同口径）。纯函数。
 */
export function dueLabel(iso: string | null | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "—";
  const d = new Date(t + 8 * 3600_000);
  const y = new Date(now + 8 * 3600_000).getUTCFullYear();
  const hm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return `${d.getUTCFullYear() !== y ? `${d.getUTCFullYear()} 年 ` : ""}${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日 ${hm}`;
}

/**
 * 被移出 / 退出团队后的一次性提示（C16 第 5 条）：重新登录落到另一个工作空间后，侧栏账号区上方说一句。
 * 记在本机（重新登录页记下离开的团队名；落到新空间后显示一次即清）。纯函数部分：文案。
 */
export const LEFT_NOTICE_KEY = "kwl.ws.left-notice";
export function leftNoticeText(n: { team: string; how: "removed" | "left" }, now: string | null): string {
  const to = now ? `，已切到「${now}」` : "";
  return `${n.how === "left" ? "你已退出" : "你已不在"}「${n.team}」${to}。团队空间里的事项仍在这台电脑上。`;
}
export function parseLeftNotice(raw: string | null): { team: string; how: "removed" | "left"; at: number } | null {
  try {
    const j = raw ? JSON.parse(raw) : null;
    if (!j || typeof j.team !== "string" || !j.team.trim() || (j.how !== "removed" && j.how !== "left") || typeof j.at !== "number") return null;
    // 一天内有效：过时的不再提
    return Date.now() - j.at < 86_400_000 ? { team: j.team.slice(0, 80), how: j.how, at: j.at } : null;
  } catch {
    return null;
  }
}

/**
 * 团队共享处的一句提示（D-304）：这台电脑由账号直接登记（没有经过团队确认），能登录、用 AI、处理自己的事项，
 * 但还不能接收团队共享事项。非阻塞。管理员自己的电脑要在团队开通时的那台电脑上确认。纯函数。
 */
export function shareIssuerNote(issuer: unknown, kind: WorkspaceKind | null, admin: boolean): string | null {
  if (kind !== "team" || issuer !== "account_ca") return null;
  // 第 72 批（U-2b）：已有“事后确认”——申请一次、管理员在团队开通时用的那台电脑上核对确认一次即可接收
  return admin
    ? "这台电脑是直接登录的，还不能接收团队共享事项，其它功能不受影响。申请后，在团队开通时用的那台电脑上“团队设置 · 电脑待确认”里核对确认一次即可接收。"
    : "这台电脑是直接登录的，还不能接收团队共享事项，其它功能不受影响。申请后请管理员确认一次即可接收。";
}

/**
 * 第 72 批（U-2b）：“申请接收团队共享事项”各状态的一句话（团队共享处）。pending 时另显示核对码。纯函数。
 * state 取自内核 team.deviceShare.*；不支持（旧云端 / 旧内核）返回 null，界面只留上面那句提示。
 */
export function shareConfirmLine(s: { supported?: boolean; state?: string; restart?: boolean; problem?: string; offline?: boolean; decided_at?: string | null } | null, now = Date.now()): string | null {
  if (!s || s.supported !== true) return null;
  const at = s.decided_at ? momentLabel(s.decided_at, now) : "";
  switch (s.state) {
    case "confirmed":
      return s.restart ? "这台电脑已可接收团队共享事项，正在刷新…" : "这台电脑已可接收团队共享事项";
    case "pending":
      return s.problem ? "收到的确认结果核对不通过，没有采用：请管理员拒绝后你重新申请；仍不行请联系 Kimi Work 客服" : "已申请：请管理员在团队设置 · 电脑待确认里核对下面的入组核对码后确认";
    case "rejected":
      return `管理员没有确认这次申请${at ? `（${at}）` : ""}。需要时可以重新申请`;
    case "expired":
      return `申请 7 天没有处理，已过期${at ? `（${at}）` : ""}。需要时可以重新申请`;
    case "withdrawn":
      return s.offline ? "已撤回（联不上云端：云端那份申请 7 天后自动过期）" : "已撤回申请";
    default:
      return null;
  }
}

/**
 * 第 72 批（补测 D2 / D9）：团队共享处的橙色“还不能接收”什么时候显示——还没申请、已撤回、旧云端不支持时显示（带“申请”按钮）；
 * 已申请、被拒、已过期、已可接收时不显示（由申请状态那一块单独说明，两条提示不同时出现）。纯函数。
 */
export function shareNoteVisible(s: { supported?: boolean; state?: string } | null): boolean {
  if (!s || s.supported !== true) return true;
  return s.state === "none" || s.state === "withdrawn" || s.state === undefined;
}

/**
 * 工作空间与团队接口的错误换成人话：内核已映射的原样用；内核没有映射的几种按原因码补上（律师层，管理员操作另见 lib/team-admin.ts）。纯函数。
 */
const WS_ERROR_TEXT: Readonly<Record<string, string>> = {
  no_other_workspace: "这是你唯一的工作空间，不能自己退出：请联系团队管理员把你移出",
  not_sole_member: "工作室里还有别的成员，不能这样升级：请联系中软客服",
  not_personal: "这个工作空间已经是团队",
  team_name_invalid: "团队名称须为 2～40 个字",
};
export function teamErrorText(e: unknown, extra: Readonly<Record<string, string>> = {}): string {
  const reason = (e as { detail?: { reason?: unknown } })?.detail?.reason;
  if (typeof reason === "string" && (extra[reason] || WS_ERROR_TEXT[reason])) return extra[reason] ?? WS_ERROR_TEXT[reason]!;
  const m = (e as Error)?.message;
  return typeof m === "string" && m ? m : "没有完成，请稍后重试";
}

/** 工作空间切换菜单里一项的小字：首次在这台电脑打开要先登记这台电脑；停用的不能进。纯函数。 */
export function workspaceMenuMeta(w: WorkspaceLike): string | null {
  if (w.status === "disabled") return w.disabled_kind === "removed" ? "已移出" : w.disabled_kind === "left" ? "已退出" : w.disabled_kind === "disabled" ? "已停用" : "已停用或已移出";
  if (!w.current && w.local_profile === false) return "首次在这台电脑打开";
  return null;
}
