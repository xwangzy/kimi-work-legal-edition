/**
 * 路径语法检查与区域归属（v9 第 04 篇 §4.4 路径安全；F2 修复）。
 *
 * 旧实现（`apps/agent-host/src/sandbox.ts` 的 `under()`）用字符串前缀 + 固定 `/` 判断“是否在根下”：
 * 符号链接可逃逸；Windows 合法子路径（`C:\…\work\a.txt`）因分隔符不同被误拒。
 * 本模块只做“语法层”的事：按平台规范化、拒绝危险形态、按**路径分量**（不是字符串前缀）判断属于哪个区域，
 * 得到区域内相对分量；文件系统层的逐级 lstat、O_NOFOLLOW 打开与句柄身份核对在 broker.ts。
 */
import { posix, win32 } from "node:path";

export type PathFlavor = "posix" | "win32";

export class PathRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PathRejected";
    this.code = code;
  }
}

/** Windows 保留设备名（不区分大小写，带扩展名同样保留，如 `CON.txt`）。 */
const WIN_RESERVED = new Set([
  "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "COM¹", "COM²", "COM³",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9", "LPT¹", "LPT²", "LPT³",
]);

export const MAX_PATH_CHARS = 4096;
/** Windows：超过 MAX_PATH（260，含结尾 NUL）的路径 Office 与资源管理器打不开，一律拒绝（第 04 篇 §4.4“长路径”）。 */
export const MAX_WIN32_PATH_CHARS = 259;
export const MAX_COMPONENT_CHARS = 255;
/** POSIX 的分量上限按 UTF-8 字节计（NAME_MAX = 255；一个汉字 3 字节）。 */
export const MAX_COMPONENT_BYTES = 255;

/**
 * 操作系统对整条路径的字节上限（PATH_MAX 含结尾 NUL）：macOS 1024、Linux 4096。超过即 ENAMETOOLONG——
 * 必须在执行任何写入或删除之前判定（审查 S3-01：提交时路径过长导致“源已删、目标未写”）。Windows 另按字符数（MAX_PATH）判定。
 */
export function maxPathBytes(): number {
  return process.platform === "darwin" ? 1023 : 4095;
}
/** Windows 8.3 短名形态（如 `MCP~1.JSO`、`CONFIG~1.TOM`）：同一文件的别名，拒绝寻址。 */
const WIN_SHORT_NAME = /^[^~\\/]{1,6}~\d{1,6}(\.[^.]{0,3})?$/;

export function currentFlavor(): PathFlavor {
  return process.platform === "win32" ? "win32" : "posix";
}

/**
 * 校验并拆分一个**绝对**宿主路径为分量：
 * - 拒绝 NUL、控制字符、过长路径/分量；
 * - Windows：拒绝 UNC（`\\server\share`）、设备命名空间（`\\?\`、`\\.\`）、盘符相对（`C:foo`）、
 *   备用数据流（分量含 `:`）、分量结尾的点或空格、保留设备名；
 * - 规范化后的 `..` 不会残留（normalize 已消解）；残留即拒绝。
 * 返回 { root, parts }：root 为盘符或 `/`，parts 为分量（Windows 保留原大小写，比较时另行折叠）。
 */
export function splitAbsolute(input: string, flavor: PathFlavor = currentFlavor()): { root: string; parts: string[] } {
  if (typeof input !== "string" || input.length === 0) throw new PathRejected("empty", "路径为空");
  if (input.length > MAX_PATH_CHARS) throw new PathRejected("too_long", "路径过长");
  if (/[\u0000-\u001f]/.test(input)) throw new PathRejected("control_char", "路径含控制字符");
  if (flavor === "win32") {
    if (/^[\\/]{2}/.test(input)) throw new PathRejected("unc_or_device", "拒绝 UNC 或设备命名空间路径");
    if (/^[A-Za-z]:(?![\\/])/.test(input)) throw new PathRejected("drive_relative", "拒绝盘符相对路径");
    if (!win32.isAbsolute(input) || !/^[A-Za-z]:[\\/]/.test(input)) throw new PathRejected("not_absolute", "须为带盘符的绝对路径");
    const norm = win32.normalize(input);
    if (norm.length > MAX_WIN32_PATH_CHARS) throw new PathRejected("too_long", "路径超过 Windows MAX_PATH");
    const root = norm.slice(0, 2).toUpperCase();
    const parts = norm.slice(3).split("\\").filter((p) => p.length > 0);
    for (const p of parts) checkWinComponent(p);
    return { root, parts };
  }
  if (!posix.isAbsolute(input)) throw new PathRejected("not_absolute", "须为绝对路径");
  const norm = posix.normalize(input);
  const parts = norm.split("/").filter((p) => p.length > 0);
  for (const p of parts) checkPosixComponent(p);
  return { root: "/", parts };
}

function checkPosixComponent(p: string): void {
  if (p === "." || p === "..") throw new PathRejected("traversal", "路径含 . 或 ..");
  if (p.length > MAX_COMPONENT_CHARS || Buffer.byteLength(p, "utf8") > MAX_COMPONENT_BYTES) throw new PathRejected("component_too_long", "路径分量过长");
}

function checkWinComponent(p: string): void {
  if (p === "." || p === "..") throw new PathRejected("traversal", "路径含 . 或 ..");
  if (p.length > MAX_COMPONENT_CHARS) throw new PathRejected("component_too_long", "路径分量过长");
  if (WIN_SHORT_NAME.test(p)) throw new PathRejected("short_name", `拒绝 8.3 短名别名 ${p}`);
  if (p.includes(":")) throw new PathRejected("alternate_stream", "拒绝备用数据流或盘符混入");
  if (/[<>"|?*]/.test(p)) throw new PathRejected("illegal_char", "路径含 Windows 非法字符");
  if (/[. ]$/.test(p)) throw new PathRejected("trailing_dot_space", "拒绝以点或空格结尾的分量（Windows 会静默去除）");
  const stem = p.split(".")[0]!.toUpperCase().trimEnd();
  if (WIN_RESERVED.has(stem)) throw new PathRejected("reserved_name", `拒绝保留设备名 ${p}`);
}

/**
 * 同一分量比较（只用于判断“属于哪个区域”；真正的 I/O 总是落在“区域真实根 + 相对分量”上，
 * 受保护对象按身份而不是名字判断——所以这里的折叠只影响能否寻址，不影响越界）。
 * Windows 与 macOS 默认卷不区分大小写：NFKC 兼容折叠（如 `ſ`→`s`、开尔文符号 → `K`）后转大写比较，
 * 近似 NTFS 大写表与 APFS 的 Unicode 折叠；Linux 区分大小写。
 */
export function sameComponent(a: string, b: string, flavor: PathFlavor = currentFlavor()): boolean {
  if (flavor === "win32" || process.platform === "darwin") return foldName(a) === foldName(b);
  return a === b;
}

export function foldName(s: string): string {
  return s.normalize("NFKC").toUpperCase().normalize("NFC");
}

/**
 * 判断绝对路径属于哪个根（按分量逐个比较，不是字符串前缀）。
 * 返回该根下的相对分量；不属于返回 null。
 */
export function relativeUnder(
  root: { root: string; parts: string[] },
  target: { root: string; parts: string[] },
  flavor: PathFlavor = currentFlavor(),
): string[] | null {
  if (!sameComponent(root.root, target.root, flavor)) return null;
  if (target.parts.length < root.parts.length) return null;
  for (let i = 0; i < root.parts.length; i++) {
    if (!sameComponent(root.parts[i]!, target.parts[i]!, flavor)) return null;
  }
  return target.parts.slice(root.parts.length);
}

/** 拒绝调用方传入的相对路径中的危险形态（区域相对路径接口用）。 */
export function splitRelative(rel: string, flavor: PathFlavor = currentFlavor()): string[] {
  if (typeof rel !== "string") throw new PathRejected("empty", "路径为空");
  if (rel.length > MAX_PATH_CHARS) throw new PathRejected("too_long", "路径过长");
  if (/[\u0000-\u001f]/.test(rel)) throw new PathRejected("control_char", "路径含控制字符");
  if (rel.startsWith("/") || rel.startsWith("\\") || /^[A-Za-z]:/.test(rel)) throw new PathRejected("absolute", "须为区域内相对路径");
  const parts = rel.split(/[\\/]+/).filter((p) => p.length > 0 && p !== ".");
  for (const p of parts) (flavor === "win32" ? checkWinComponent : checkPosixComponent)(p);
  return parts;
}
