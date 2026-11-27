/**
 * 第 72 批（V46，D-305，契约 02 §2～§4、§7）：一个人、多个工作空间（个人空间 + 团队空间）在内核这一侧的纯函数与本机小记录。
 *
 * - 工作空间 = 这个人在某个租户里的成员身份（云端一个账号记录）；这台电脑上每个工作空间各自一个账号档案（第 68 批 profiles.ts），
 *   切换 = 用当前会话向云端换目标工作空间的会话（应答与登录同形），之后与“换账号登录”完全同一条路（同档案直接进 / 新档案开通 / 满额选择卡）。
 * - 本机只记两样不含秘密的东西（工作区里的 account-meta.json）：当前工作空间是个人还是团队、账号级上手状态的两个时间戳。
 *   都取自登录 / me 应答，界面据此显示团队功能（替换 inFirm / isAdmin 推断）。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type WorkspaceKind = "personal" | "team";
export type WorkspaceRole = "admin" | "partner" | "lawyer" | "assistant";
export const WORKSPACE_ROLES: readonly WorkspaceRole[] = ["admin", "partner", "lawyer", "assistant"];

export interface WorkspaceItem {
  aid: string;
  tid: string;
  kind: WorkspaceKind;
  name: string;
  role: WorkspaceRole | null;
  status: "active" | "disabled";
  /** 第 72 批（设计评分 C12 / C16）：停用的方式——disabled 停用 / removed 被团队移出 / left 本人退出；云端没给或未停用时为 null */
  disabled_kind: "disabled" | "removed" | "left" | null;
  current: boolean;
  /** 这台电脑上已有这个工作空间的账号档案（切过去不用再登记这台电脑）。 */
  local_profile: boolean;
}

export interface AccountMeta {
  v: 1;
  workspace_kind: WorkspaceKind | null;
  onboarding: { completed_at: string | null; dismissed_at: string | null } | null;
  fetched_at: string;
}

const AID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TID_RE = /^ten_[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, "").trim().slice(0, max) : "");
const isoOrNull = (v: unknown): string | null => (typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : null);

export function validAid(v: unknown): v is string {
  return typeof v === "string" && AID_RE.test(v);
}

export function kindOf(v: unknown): WorkspaceKind | null {
  return v === "personal" || v === "team" ? v : null;
}

/**
 * 云端的工作空间列表 → 界面用的列表（纯函数）。只取已知字段；不合格的项丢掉。
 * local_profile：云端项带 member_slug 时按（律所编号 + 成员标识）精确对；不带时按律所编号对（同一个人在一个租户里只有一个成员身份；
 * 共用电脑上同一律所的另一位同事的档案会被误认——云端补上 member_slug 后即精确）。
 */
export function workspaceItems(raw: unknown, profiles: readonly { tid: string; member_slug: string }[], cur: { tid: string; member_slug: string } | null): WorkspaceItem[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkspaceItem[] = [];
  const seen = new Set<string>();
  for (const w of raw.slice(0, 50)) {
    if (!isObj(w) || !validAid(w.aid) || typeof w.tid !== "string" || !TID_RE.test(w.tid) || seen.has(w.aid)) continue;
    const kind = kindOf(w.kind);
    if (!kind) continue;
    seen.add(w.aid);
    const slug = typeof w.member_slug === "string" && SLUG_RE.test(w.member_slug) ? w.member_slug : null;
    const current = w.current === true;
    const local = slug
      ? profiles.some((p) => p.tid === w.tid && p.member_slug === slug)
      : current
        ? true
        : profiles.some((p) => p.tid === w.tid && !(cur && p.tid === cur.tid && p.member_slug === cur.member_slug));
    out.push({
      aid: w.aid,
      tid: w.tid,
      kind,
      name: text(w.name, 80) || (kind === "personal" ? "个人工作室" : "团队"),
      role: WORKSPACE_ROLES.includes(w.role as WorkspaceRole) ? (w.role as WorkspaceRole) : null,
      status: w.status === "disabled" ? "disabled" : "active",
      disabled_kind: w.status === "disabled" && (w.disabled_kind === "disabled" || w.disabled_kind === "removed" || w.disabled_kind === "left") ? w.disabled_kind : null,
      current,
      local_profile: local,
    });
  }
  // 个人在前，其余按名称
  return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, "zh") : a.kind === "personal" ? -1 : 1));
}

/** 应答里的“人”（主账号）：只取显示用的三项。纯函数。 */
export function personOf(raw: unknown): { aid: string; name: string; phone_masked: string | null } | null {
  if (!isObj(raw) || !validAid(raw.aid)) return null;
  const phone = typeof raw.phone_masked === "string" && /^[0-9*+ ]{7,20}$/.test(raw.phone_masked) && raw.phone_masked.includes("*") ? raw.phone_masked : null;
  return { aid: raw.aid, name: text(raw.name, 80), phone_masked: phone };
}

/**
 * 从登录 / me / 切换应答里取本机要记的两样（纯函数；都没有 = null）：
 * - 工作空间类型：`workspace.kind`（契约 §2.1）；
 * - 账号级上手状态：契约 §4 `onboarding: { completed_at, dismissed_at }`。登录应答里 `onboarding` 同时是“这台电脑的登记状态”（state…），
 *   两者可能放在同一个对象里，也可能分开（`account_onboarding`）——两处都认，只取两个时间戳。
 */
export function accountMetaOf(j: unknown): { workspace_kind?: WorkspaceKind; onboarding?: { completed_at: string | null; dismissed_at: string | null } } | null {
  if (!isObj(j)) return null;
  const out: { workspace_kind?: WorkspaceKind; onboarding?: { completed_at: string | null; dismissed_at: string | null } } = {};
  const k = isObj(j.workspace) ? kindOf(j.workspace.kind) : null;
  if (k) out.workspace_kind = k;
  for (const src of [j.account_onboarding, j.onboarding, isObj(j.person) ? j.person.onboarding : undefined]) {
    if (isObj(src) && ("completed_at" in src || "dismissed_at" in src)) {
      out.onboarding = { completed_at: isoOrNull(src.completed_at), dismissed_at: isoOrNull(src.dismissed_at) };
      break;
    }
  }
  return out.workspace_kind || out.onboarding ? out : null;
}

const META_FILE = "account-meta.json";

export function readAccountMeta(workspaceDir: string): AccountMeta | null {
  try {
    const m = JSON.parse(readFileSync(join(workspaceDir, META_FILE), "utf8")) as Partial<AccountMeta>;
    if (m.v !== 1) return null;
    const ob = isObj(m.onboarding) ? { completed_at: isoOrNull(m.onboarding.completed_at), dismissed_at: isoOrNull(m.onboarding.dismissed_at) } : null;
    return { v: 1, workspace_kind: kindOf(m.workspace_kind), onboarding: ob, fetched_at: isoOrNull(m.fetched_at) ?? new Date(0).toISOString() };
  } catch {
    return null;
  }
}

/** 合并写（原子改名）；写不进去不影响调用方（下次从云端再取）。 */
export function writeAccountMeta(workspaceDir: string, prev: AccountMeta | null, next: NonNullable<ReturnType<typeof accountMetaOf>>): AccountMeta {
  const m: AccountMeta = {
    v: 1,
    workspace_kind: next.workspace_kind ?? prev?.workspace_kind ?? null,
    onboarding: next.onboarding ?? prev?.onboarding ?? null,
    fetched_at: new Date().toISOString(),
  };
  try {
    mkdirSync(workspaceDir, { recursive: true });
    const tmp = join(workspaceDir, `${META_FILE}.tmp-${process.pid}`);
    writeFileSync(tmp, JSON.stringify(m), { mode: 0o600 });
    renameSync(tmp, join(workspaceDir, META_FILE));
  } catch {
    // 只影响重启后的首屏（之后从云端再取）
  }
  return m;
}

/** 团队邀请码：16 位（人读格式 XXXX-XXXX-XXXX-XXXX）；去掉空白、统一大写，横线可省。不合格 null。纯函数。 */
export function inviteCodeOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, "").toUpperCase();
  const bare = s.replace(/-/g, "");
  if (!/^[A-Z0-9]{16}$/.test(bare)) return null;
  return `${bare.slice(0, 4)}-${bare.slice(4, 8)}-${bare.slice(8, 12)}-${bare.slice(12)}`;
}

/** 团队名称：2～40 字（与机构名同一校验口径的粗查；云端再精确核对）。 */
export function teamNameOf(v: unknown): string | null {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  const n = [...s].length;
  return n >= 2 && n <= 40 && !/[\u0000-\u001f<>]/.test(s) ? s : null;
}
