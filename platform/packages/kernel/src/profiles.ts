/**
 * 同一台电脑上的多个账号（第 68 批，D-294）。
 *
 * 根因：此前一台电脑的数据根下只有一份 activation.json、一个工作区（`<数据根>/<律所标识>`）、一份数据库主密钥，
 * 设备证书又绑在成员上——于是“这台电脑 = 这位成员”：退出登录后换另一个账号，控制面按本机设备签名认出“这台电脑是别的成员的”，
 * 回 device_mismatch（“这台电脑已登记为本所另一位成员：请用那位成员的账号登录”），内核也只认同一租户的账号。
 *
 * 新模型：**账号档案**（profile）。每个在这台电脑上登录过的账号各有一个工作区（账本、材料、成果、密钥、会话、日志全在里面），
 * 各有一把数据库密钥（主进程按 key_slot 分别包裹保存）；activation.json 只是“当前打开的档案”的指针。换账号 = 打开该账号自己的档案；
 * 这台电脑上还没有该账号的档案 = 按云端对这个账号的设备策略登记一台新设备（个人账号直接登记、团队成员等管理员批准、设备数按云端上限）。
 * 一个档案的内核进程只打开自己的工作区、只持有自己的密钥：别的账号的事项、材料、会话一律不可见。
 *
 * 目录名：第一个档案（以及升级前的旧工作区）沿用 `<律所标识>`；同一律所的另一位成员用 `<律所标识>.<成员标识>`（“.” 不在律所标识的字符集里，
 * 不会与任何律所目录重名）。每个工作区里有一份 profile.json（与 activation.json 同一格式的明文记录：编号、律所名称、本人显示名，不含秘密）。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { activationFilePath, PENDING_WORKSPACE_SLUG, validActivation, WORKSPACE_NAME_PATTERN, type ActivationFile } from "./config.ts";

export const PROFILE_FILE = "profile.json";

/** 档案的工作区目录名（没有 workspace 字段 = 律所标识，第 68 批之前的写法）。 */
export function workspaceNameOf(a: Pick<ActivationFile, "firm_slug" | "workspace">): string {
  return a.workspace ?? a.firm_slug;
}

/** 档案标识：律所编号 + 成员标识的摘要（16 位十六进制）。界面按它分开本机偏好、判断“已切换到别的账号”；不含可读身份。 */
export function profileScopeId(a: Pick<ActivationFile, "tid" | "member_slug">): string {
  return createHash("sha256").update(`kwl-profile/1\n${a.tid}\n${a.member_slug}`).digest("hex").slice(0, 16);
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

/** 读一个工作区里的档案记录；格式不对、或记录里的目录名与所在目录不一致（被挪过、被拷贝过）一律不认。 */
export function readProfile(dataRoot: string, workspace: string): ActivationFile | null {
  if (!WORKSPACE_NAME_PATTERN.test(workspace) || workspace === PENDING_WORKSPACE_SLUG) return null;
  const p = join(dataRoot, workspace, PROFILE_FILE);
  if (!existsSync(p)) return null;
  try {
    const a = validActivation(JSON.parse(readFileSync(p, "utf8")));
    return a && workspaceNameOf(a) === workspace ? a : null;
  } catch {
    return null;
  }
}

/** 写（或补写）档案记录到它自己的工作区里。 */
export function writeProfile(dataRoot: string, a: ActivationFile): void {
  const dir = join(dataRoot, workspaceNameOf(a));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeJsonAtomic(join(dir, PROFILE_FILE), a);
}

/**
 * 这台电脑上的全部档案：各工作区里的 profile.json，加上当前 activation.json（升级前的旧工作区还没有 profile.json）。
 * 同一账号（律所编号 + 成员标识）只取一个（当前打开的优先）。
 */
export function listProfiles(dataRoot: string): ActivationFile[] {
  const out: ActivationFile[] = [];
  const seen = new Set<string>();
  const add = (a: ActivationFile | null) => {
    if (!a) return;
    const k = `${a.tid}\n${a.member_slug}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(a);
  };
  try {
    if (existsSync(activationFilePath(dataRoot))) add(validActivation(JSON.parse(readFileSync(activationFilePath(dataRoot), "utf8"))));
  } catch {
    // 当前记录读不了：只按各工作区里的记录列
  }
  let names: string[] = [];
  try {
    names = readdirSync(dataRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== PENDING_WORKSPACE_SLUG)
      .map((e) => e.name)
      .sort();
  } catch {
    names = [];
  }
  for (const n of names) add(readProfile(dataRoot, n));
  return out;
}

/** 这台电脑上某个账号的档案（没有 = null）。 */
export function findProfile(dataRoot: string, tid: string, memberSlug: string): ActivationFile | null {
  return listProfiles(dataRoot).find((a) => a.tid === tid && a.member_slug === memberSlug) ?? null;
}

/** 目录是否已被占用：有账本、有档案记录，或有任何内容（暂存的密钥等）。 */
function occupied(dataRoot: string, name: string): boolean {
  const d = join(dataRoot, name);
  if (!existsSync(d)) return false;
  try {
    return readdirSync(d).length > 0;
  } catch {
    return true;
  }
}

/**
 * 给一个账号分配工作区目录名：已有档案 → 沿用；`<律所标识>` 空着 → 用它（第一个档案与以前一致）；
 * 否则 `<律所标识>.<成员标识>`，再被占用（极少：同名目录里是别的东西）依次加 -2…-9。
 * 只有同一账号自己留下的暂存（入组中途放弃）才会复用非空目录。纯目录判断，不建目录。
 */
export function allocateWorkspace(dataRoot: string, tid: string, firmSlug: string, memberSlug: string): string {
  const mine = findProfile(dataRoot, tid, memberSlug);
  if (mine) return workspaceNameOf(mine);
  if (!occupied(dataRoot, firmSlug)) return firmSlug;
  const base = `${firmSlug}.${memberSlug}`;
  const ownedBy = (name: string) => {
    const p = readProfile(dataRoot, name);
    return p ? p.tid === tid && p.member_slug === memberSlug : null;
  };
  for (let i = 1; i <= 9; i++) {
    const name = i === 1 ? base : `${base}-${i}`;
    if (!WORKSPACE_NAME_PATTERN.test(name)) break;
    const owner = ownedBy(name);
    // 没有档案记录的目录：只有不含账本时才复用（同一账号放弃的入组暂存）；有别人档案的跳过
    if (owner === true) return name;
    if (owner === null && (!occupied(dataRoot, name) || !existsSync(join(dataRoot, name, "ledger.db")))) return name;
  }
  throw new Error("这台电脑上的账号工作区太多，无法再为这个账号建立工作区：请联系客服");
}

/** 本机有没有别的档案或带账本的工作区（主进程据此决定待激活时用哪把密钥：有则另起一把，不动别的档案的密钥）。 */
export function hasOtherWorkspaces(dataRoot: string): boolean {
  try {
    return readdirSync(dataRoot, { withFileTypes: true }).some(
      (e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== PENDING_WORKSPACE_SLUG && (existsSync(join(dataRoot, e.name, PROFILE_FILE)) || existsSync(join(dataRoot, e.name, "ledger.db"))),
    );
  } catch {
    return false;
  }
}

/**
 * 切换账号时交给下一个内核的一次性交接（只在内存里：经主进程 kernel.init 传入，不落盘、不进日志）。
 * - session：这台电脑上已有该账号的档案——把刚登录得到的会话写进那个档案（它的密钥封装），打开即已登录；
 * - auth：这台电脑上还没有该账号的档案——待激活内核按这次登录的答复继续登记新设备（个人账号直接登记、团队成员提交批准）。
 */
export type ProfileHandoff =
  | { v: 1; kind: "session"; tid: string; member_slug: string; session: { token: string; aid: string; email: string; name: string; tid: string; role: string } }
  | { v: 1; kind: "auth"; tid: string; member_slug: string; auth: Record<string, unknown> };

/** 主进程转来的交接：只认上面两种形状（别的一律丢弃）。纯函数。 */
export function validHandoff(raw: unknown): ProfileHandoff | null {
  const h = raw as Partial<ProfileHandoff> | null;
  if (!h || typeof h !== "object" || h.v !== 1) return null;
  if (h.kind === "session") {
    const s = (h as { session?: Record<string, unknown> }).session;
    const str = (x: unknown, max: number) => typeof x === "string" && x.length <= max;
    if (!str((h as { tid?: unknown }).tid, 64) || !str((h as { member_slug?: unknown }).member_slug, 64) || !s || !str(s.token, 200) || !str(s.aid, 80) || !str(s.email, 254) || !str(s.name, 80) || !str(s.tid, 64) || !str(s.role, 40)) return null;
    return h as ProfileHandoff;
  }
  if (h.kind === "auth") {
    // 安全复核 P-3：交接绑定到那次登录的账号（律所编号 + 成员标识），与登录答复里的账号一致才认
    const x = h as { tid?: unknown; member_slug?: unknown; auth?: unknown };
    const a = x.auth as { session_token?: unknown; account?: { tid?: unknown; member_slug?: unknown } } | undefined;
    if (!a || typeof a !== "object" || typeof a.session_token !== "string" || typeof x.tid !== "string" || typeof x.member_slug !== "string") return null;
    return a.account?.tid === x.tid && a.account?.member_slug === x.member_slug ? (h as ProfileHandoff) : null;
  }
  return null;
}
