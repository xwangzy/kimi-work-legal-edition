/**
 * 第 72 批（V46，D-304、D-305，契约 02 §3.4）：团队管理（管理员层）的纯函数与文案——成员、席位、邀请、新电脑策略、危险操作的后果说明。
 * 这里是管理员看的内容，允许“席位”这类管理用语（律师层另见 lib/workspace.ts）。
 */
import { teamErrorText, WS_ROLE_LABEL, type WorkspaceRole } from "./workspace.ts";

/** 角色说明（邀请、改角色时写在选项旁）：只写能做什么，不写内部权限名。 */
export const ROLE_HINT: Readonly<Record<WorkspaceRole, string>> = {
  admin: "可以邀请、移出成员，分配席位，改团队设置",
  partner: "可以查看成员与用量，不能修改",
  lawyer: "办自己的事项，以及同事共享给他的事项",
  assistant: "同律师；适合协助整理材料的同事",
};
export const ROLE_ORDER: readonly WorkspaceRole[] = ["lawyer", "partner", "assistant", "admin"];

/** 管理员“移出团队”的后果说明。纯函数。 */
export function removeLines(who: string): string[] {
  return [
    `${who}不再是团队成员：他的所有电脑在 2 分钟内退出这个团队，席位释放。`,
    "他电脑上的事项和成果留在他的电脑上，不会被删除，管理员也看不到。",
    `移出前，请先请${who}在自己电脑的“设置 · 团队 · 离所交接”里把负责的事项交接好。`,
    "他的个人空间和他加入的其他团队不受影响。之后要回来，需要重新邀请。",
  ];
}

/** 管理员“停用”的后果说明（可随时启用，区别于移出）。纯函数。 */
export function disableLines(who: string): string[] {
  return [`停用后${who}的所有电脑立即退出这个团队，席位释放；他电脑上的事项和成果不动。`, "可以随时重新启用（有空席位时自动分回席位）。"];
}

/** 释放席位的后果。纯函数。 */
export function releaseSeatLine(who: string): string {
  return `释放后${who}暂时不能用 AI（本机的事项和文件照常可用），直到再给他分配席位。`;
}

/** 改角色的确认句。纯函数。 */
export function roleChangeLine(who: string, role: WorkspaceRole): string {
  return `把${who}改为${WS_ROLE_LABEL[role]}？${WS_ROLE_LABEL[role]}${ROLE_HINT[role]}。`;
}

/** 团队成员行（云端 /v1/firm/members 每行，C-2）。 */
export interface TeamMemberRow {
  aid: string;
  name: string | null;
  email?: string | null;
  role: string;
  status: string;
  disabled_by?: "platform" | "team" | null;
  person_phone_masked?: string | null;
  seat?: { sid: string; assigned_at: string } | null;
  seat_used?: boolean;
  devices_summary?: { signed_in: number; limit: number | null } | null;
  last_login_at?: string | null;
  created_via?: string | null;
}

/** 成员状态（人话 + 色调）。移出与停用在云端是同一状态（都停用了这个成员身份），界面不硬分。纯函数。 */
export function memberStatus(m: Pick<TeamMemberRow, "status" | "disabled_by">): { text: string; tone: "ok" | "off" | "bad" } {
  if (m.status === "active") return { text: "正常", tone: "ok" };
  if (m.disabled_by === "platform") return { text: "被中软停用", tone: "bad" };
  return { text: "已停用或移出", tone: "off" };
}

/** 成员行的“电脑”一格：“1 / 3 台”（同时登录 / 上限）。纯函数。 */
export function devicesCell(d: TeamMemberRow["devices_summary"]): string {
  if (!d) return "—";
  return d.limit ? `${d.signed_in} / ${d.limit} 台` : `${d.signed_in} 台`;
}

/** 成员行的可用操作（管理员）。不能对自己移出 / 停用；被中软停用的不能启用。纯函数。 */
export function memberActions(m: TeamMemberRow, myAid: string | null): { role: boolean; seat: "assign" | "release" | null; disable: boolean; enable: boolean; remove: boolean } {
  const me = !!myAid && m.aid === myAid;
  const active = m.status === "active";
  const seated = m.seat ? true : m.seat_used === true;
  return {
    role: active,
    seat: active ? (seated ? "release" : "assign") : null,
    disable: active && !me,
    enable: !active && m.disabled_by !== "platform",
    remove: active && !me,
  };
}

/** 团队席位一句话（只读摘要）。纯函数。 */
export function seatSummary(seats: { total: number; used: number } | null | undefined): string | null {
  if (!seats || !Number.isFinite(seats.total)) return null;
  const free = Math.max(0, seats.total - seats.used);
  return `席位 ${seats.used} / ${seats.total} 已分配${free > 0 ? `，空 ${free} 个` : "，已满"}`;
}

/** 团队邀请（云端 teamInviteView）。 */
export interface TeamInviteRow {
  id: string;
  name: string;
  role: string;
  status: "open" | "accepted" | "revoked" | "expired" | string;
  created_at: string;
  expires_at: string;
  accepted_at?: string | null;
}
export const INVITE_STATUS: Readonly<Record<string, string>> = { open: "未使用", accepted: "已加入", revoked: "已撤回", expired: "已过期" };

/** 邀请分两组：未使用的在前（可撤回），其余收进“已处理”。纯函数。 */
export function splitInvites(list: readonly TeamInviteRow[]): { open: TeamInviteRow[]; done: TeamInviteRow[] } {
  return { open: list.filter((x) => x.status === "open"), done: list.filter((x) => x.status !== "open") };
}

/** 成员新电脑策略的说明（D-304）。纯函数。 */
export const MEMBER_DEVICE_POLICY: Readonly<Record<"auto" | "approve", { label: string; hint: string }>> = {
  // 第 72 批（U-2，如实）：直接登录的电脑暂不能接收团队共享事项，本批还没有“事后确认”这一步——要用团队共享事项的团队选“须确认”
  auto: { label: "直接登录", hint: "成员在新电脑上用手机号验证码登录后即可使用（推荐）。这样登录的电脑暂不能接收团队共享事项；团队要共享事项，请选“须管理员确认”。" },
  approve: { label: "须管理员确认", hint: "成员的新电脑要等你在“电脑待确认”里确认后才能登录使用，确认过的电脑可以接收团队共享事项。已登录的电脑不受影响。" },
};

/** 管理员操作的错误补充（内核没有映射的原因码）。 */
const ADMIN_ERROR_TEXT: Readonly<Record<string, string>> = {
  cannot_remove_self: "不能移出自己：要离开请用“退出团队”",
  cannot_disable_self: "不能停用自己",
  seats_full: "席位已用满：请先释放一个席位，或联系中软增加席位",
  seat_assigned: "这名成员已经有席位",
  seat_unknown: "这名成员没有在用的席位",
  invite_not_open: "这份邀请已被接受、撤回或已过期",
  invites_too_many: "未使用的邀请太多：请先撤回不用的邀请",
  device_limit_over_plan: "电脑上限不能超过套餐设定：需要更多请联系中软",
  phone_hint_invalid: "手机号提示只填手机号或后四位",
};
export function adminErrorText(e: unknown): string {
  return teamErrorText(e, ADMIN_ERROR_TEXT);
}

