/**
 * 第 72 批（A1 S3）：出站闸门的随包 Node（约 100 MB）每次应用启动只整份算一次 SHA-256。
 *
 * 此前每次拉起闸门（每次内核重启、闸门崩溃后重拉）都整份重算——路径 B（换账号再登记）一次就算两遍，Windows 上各约 0.3～1.5 秒。
 * 现在：
 * - 主进程启动时本来就按随包清单核对过闸门闭包（它自己的 Node 与入口，main.cjs verifyRuntimeInBackground）。核对前后各取一次文件元数据
 *   （大小、修改时刻、变更时刻〔纳秒〕、inode / 文件编号、所在设备），两次一致才随 kernel.runtime_verified 把“已核对（路径、摘要、元数据）”交给内核；
 * - 内核拉起闸门前：路径与摘要都对得上、此刻的元数据与交来的完全一致 → 不再重算；否则照旧整份重算，**不一致照旧拒绝拉起**；
 * - 内核自己算过一次且算之前与算之后元数据一致时，记在本进程里（闸门崩溃后重拉不再重算）。
 *
 * 安全取舍：核对与拉起之间本来就有窗口（原来也是“算完摘要 → 再拉起进程”）；改为比元数据后，攻击者要在这段时间里换掉文件且保持
 * 大小、修改时刻、变更时刻与 inode 全都不变——变更时刻（ctime）普通进程改不了（POSIX；Windows 的 ChangeTime 需对文件有写权限，
 * 而安装目录对普通用户只读）。能写安装目录的攻击者本来就能改闸门入口以外的随包文件（Agent 宿主、解析进程只在启动时核对一次，从不逐次重算）。
 * 交来的元数据只认主进程（内核本就信任主进程：主密钥、随包核对的放行都来自它）。
 */
import { statSync } from "node:fs";

export interface RuntimeStamp {
  path: string;
  sha256: string;
  size: string;
  mtime_ns: string;
  ctime_ns: string;
  ino: string;
  dev: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const NUM = /^\d{1,30}$/;

/** 文件此刻的元数据（大整数按十进制字符串）；读不了 null。 */
export function runtimeStampOf(path: string): Omit<RuntimeStamp, "path" | "sha256"> | null {
  try {
    const st = statSync(path, { bigint: true });
    if (!st.isFile()) return null;
    return { size: String(st.size), mtime_ns: String(st.mtimeNs), ctime_ns: String(st.ctimeNs), ino: String(st.ino), dev: String(st.dev) };
  } catch {
    return null;
  }
}

function sameMeta(a: Omit<RuntimeStamp, "path" | "sha256">, b: Omit<RuntimeStamp, "path" | "sha256">): boolean {
  return a.size === b.size && a.mtime_ns === b.mtime_ns && a.ctime_ns === b.ctime_ns && a.ino === b.ino && a.dev === b.dev;
}

/** 主进程交来的（只认形状完全合格的）。纯函数。 */
export function sanitizeRuntimeStamp(v: unknown): RuntimeStamp | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== "string" || o.path.length === 0 || o.path.length > 1024) return null;
  if (typeof o.sha256 !== "string" || !HEX64.test(o.sha256)) return null;
  for (const k of ["size", "mtime_ns", "ctime_ns", "ino", "dev"] as const) if (typeof o[k] !== "string" || !NUM.test(o[k] as string)) return null;
  return { path: o.path, sha256: o.sha256, size: o.size as string, mtime_ns: o.mtime_ns as string, ctime_ns: o.ctime_ns as string, ino: o.ino as string, dev: o.dev as string };
}

const known = new Map<string, { stamp: RuntimeStamp; source: "attested" | "cached" }>();

/** 主进程核对过的闸门运行时（kernel.runtime_verified 带来的 gate_node）。 */
export function attestRuntime(v: unknown): boolean {
  const s = sanitizeRuntimeStamp(v);
  if (!s) return false;
  known.set(s.path, { stamp: s, source: "attested" });
  return true;
}

/**
 * 这份可执行文件是否已核对过且此后没有变过：路径、期望摘要都对得上，此刻元数据与核对时完全一致。返回来源（主进程交来 / 本进程算过），否则 null。
 */
export function runtimeAlreadyVerified(path: string, sha256: string): "attested" | "cached" | null {
  const k = known.get(path);
  if (!k || k.stamp.sha256 !== sha256.toLowerCase()) return null;
  const now = runtimeStampOf(path);
  if (!now || !sameMeta(now, k.stamp)) {
    known.delete(path);
    return null;
  }
  return k.source;
}

/** 本进程整份算过且结果相符：算之前取的元数据与此刻一致才记下（算的过程中文件变了就不记）。 */
export function rememberRuntime(path: string, sha256: string, before: Omit<RuntimeStamp, "path" | "sha256"> | null): void {
  if (!before) return;
  const now = runtimeStampOf(path);
  if (!now || !sameMeta(now, before)) return;
  known.set(path, { stamp: { path, sha256: sha256.toLowerCase(), ...now }, source: "cached" });
}

/** 用例用：清空。 */
export function forgetRuntimeStamps(): void {
  known.clear();
}
