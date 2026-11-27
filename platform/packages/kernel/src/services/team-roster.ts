/**
 * 第 73 批（V47，D-308，契约 02 §2.1）：团队成员可读的同事名单（云端 GET /v1/team/roster）在内核这一侧的纯函数与本机缓存。
 *
 * - 名单只有显示用的几项：成员标识、姓名、角色、状态（不含邮箱、手机号、账号编号与设备信息）；本机按成员标识算出内核成员编号
 *   （usr_<租户去 ten_>_<成员标识>，与控制面 uidOfAccount 同式）。
 * - 最近一次成功取到的名单存进 <工作区>/keys/team-roster.json（kwl-sealed/1 封装，与会话、设备私钥同一封装；没有主密钥的开发形态为明文），
 *   离线时用它判断“加的人在不在团队里”和“已离开团队”；切到别的工作空间是另一份档案、另一个工作区，不串用。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readSecretFile, writeStagedSecret } from "../devices.ts";

export type RosterStatus = "active" | "disabled" | "removed" | "left";
export const ROSTER_STATUSES: readonly RosterStatus[] = ["active", "disabled", "removed", "left"];

export interface RosterMember {
  user_id: string;
  member_slug: string;
  name: string;
  role: string;
  status: RosterStatus;
  /** 第 73 批（P2-1）：这位成员有没有席位（没有席位时 AI 与同事之间同步都用不了）；旧云端不给为 null。 */
  seat: boolean | null;
}

export interface RosterCache {
  v: 1;
  tid: string;
  fetched_at: string;
  members: RosterMember[];
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const TID_RE = /^ten_[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const ROLE_RE = /^[a-z][a-z_]{0,19}$/;
const FILE = "team-roster.json";
/** 名单上限（团队版席位远到不了；超出的不收，防止异常答复撑大缓存）。 */
const MAX_MEMBERS = 2000;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, max) : "");

/** 内核成员编号（与控制面 uidOfAccount 同式）。纯函数。 */
export function rosterUserId(tenantId: string, memberSlug: string): string {
  return `usr_${tenantId.slice(4)}_${memberSlug}`;
}

/**
 * 云端答复 → 名单（纯函数）。答复不是本租户的、格式不对 → null（调用方按“取不到”处理）；单项不合格的丢掉；
 * 同一成员标识只取第一项；不认识的状态按“已停用”（不当作在用——宁可让负责人看到“已离开团队”，也不把不明状态的人当成同事）。
 */
export function rosterFromReply(raw: unknown, tenantId: string): RosterMember[] | null {
  if (!isObj(raw) || raw.ok === false || !Array.isArray(raw.members)) return null;
  if (raw.tid !== undefined && raw.tid !== tenantId) return null;
  if (!TID_RE.test(tenantId)) return null;
  const out: RosterMember[] = [];
  const seen = new Set<string>();
  for (const m of raw.members.slice(0, MAX_MEMBERS)) {
    if (!isObj(m) || typeof m.member_slug !== "string" || !SLUG_RE.test(m.member_slug) || seen.has(m.member_slug)) continue;
    seen.add(m.member_slug);
    const status = (ROSTER_STATUSES as readonly unknown[]).includes(m.status) ? (m.status as RosterStatus) : "disabled";
    out.push({
      user_id: rosterUserId(tenantId, m.member_slug),
      member_slug: m.member_slug,
      name: text(m.name, 40) || m.member_slug,
      role: typeof m.role === "string" && ROLE_RE.test(m.role) ? m.role : "lawyer",
      status,
      seat: typeof m.seat === "boolean" ? m.seat : null,
    });
  }
  // 按姓名排序（云端已排，本机再排一次，缓存与现取一致）
  return out.sort((a, b) => a.name.localeCompare(b.name, "zh") || a.member_slug.localeCompare(b.member_slug));
}

/** 取名单失败的原因是不是“连不上”（用本机缓存）：闸门不可用、超时、连不上、证书类、云端 5xx。纯函数。 */
export function rosterOfflineCode(code: string): boolean {
  if (code === "cp_path_not_allowed" || code === "cp_not_configured") return false;
  return /^cp_(?:timeout|unreachable|tls_|response_too_large|reply_not_json)|^gate_|^http_5\d\d$|timeout|unreachable|ECONN/.test(code);
}

/** 云端还没有这项能力（旧云端 404、闸门白名单没放行这条路径的安装包）。纯函数。 */
export function rosterUnsupportedCode(code: string): boolean {
  return code === "cp_path_not_allowed" || code === "cp_not_configured" || code === "not_found" || code === "http_404" || code === "route_not_found";
}

export function rosterCachePath(keysDir: string): string {
  return join(keysDir, FILE);
}

/** 读本机缓存（不是本租户的、格式不对、解封失败 → null）。 */
export function readRosterCache(keysDir: string, tenantId: string): RosterCache | null {
  const p = rosterCachePath(keysDir);
  if (!existsSync(p)) return null;
  try {
    const c = readSecretFile<RosterCache>(p);
    if (!c || c.v !== 1 || c.tid !== tenantId || !Array.isArray(c.members) || typeof c.fetched_at !== "string" || !Number.isFinite(Date.parse(c.fetched_at))) return null;
    const members = rosterFromReply({ ok: true, tid: tenantId, members: c.members }, tenantId);
    return members ? { v: 1, tid: tenantId, fetched_at: c.fetched_at, members } : null;
  } catch {
    return null;
  }
}

/** 写本机缓存（封装、临时文件改名落位）；写不进去抛错，由调用方记事件码，不影响本次答复。 */
export function writeRosterCache(keysDir: string, tenantId: string, members: RosterMember[], at = new Date()): RosterCache {
  const c: RosterCache = { v: 1, tid: tenantId, fetched_at: at.toISOString(), members: members.map((m) => ({ ...m })) };
  writeStagedSecret(rosterCachePath(keysDir), c);
  return c;
}
