/**
 * 导出直写（v9.2 §3.7；调研 Y5 P1-4、W3、F6）：成果、诊断包与结案归档由内核直接写到律师在主进程系统对话框里选定的位置——
 * 不经渲染进程内存、不经 Chromium 下载（不产生 .crdownload 临时文件、不进“最近使用”、不加网络标记）。
 *
 * 写法：同目录临时文件（独占创建、0600）→ 写入并 fsync → 改名为目标名（覆盖已由系统对话框确认）；任何失败删除临时文件。
 * 约束：目标须为绝对路径、父目录须已存在且不是符号链接、目标本身不得是目录或符号链接、不得位于本机数据根之内（防止覆盖账本与密钥文件）。
 */
import { closeSync, fsyncSync, lstatSync, openSync, readdirSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { randomBytes } from "node:crypto";
import { DomainError } from "@zr-legal/domain";

function inside(child: string, parent: string): boolean {
  // Windows 与 macOS（APFS 缺省）大小写不敏感：比较前一律转小写（复核 S5A-04）
  const norm = (p: string) => (process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p);
  const rel = relative(norm(parent), norm(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function writeExportFile(target: string, bytes: Uint8Array, dataRoot: string): { name: string; bytes: number } {
  const bad = (m: string) => new DomainError("validation", m, 422);
  if (typeof target !== "string" || !isAbsolute(target)) throw bad("保存位置无效，请重新选择");
  const dir = dirname(target);
  let realDir: string;
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw bad("保存位置的文件夹无效，请重新选择");
    realDir = realpathSync.native(dir);
  } catch (e) {
    if (e instanceof DomainError) throw e;
    throw bad("保存位置的文件夹不存在，请重新选择");
  }
  let realRoot = dataRoot;
  try {
    realRoot = realpathSync.native(dataRoot);
  } catch {
    // 数据根尚不存在：按原值比较
  }
  if (inside(realDir, realRoot) || inside(dir, dataRoot)) throw bad("不能保存到 Kimi Work 的数据目录里，请换一个位置");
  const final = join(realDir, basename(target));
  try {
    const st = lstatSync(final);
    if (st.isSymbolicLink() || st.isDirectory()) throw bad("目标是文件夹或链接，请换一个文件名");
  } catch (e) {
    if (e instanceof DomainError) throw e;
    // 不存在：正常
  }
  // 上次中断留下的本应用临时文件（超过 1 小时）顺手清掉（复核 S5A-11）
  try {
    for (const n of readdirSync(realDir)) {
      if (!/^\..*\.kwl-[0-9a-f]{12}\.part$/.test(n)) continue;
      const p = join(realDir, n);
      const st = lstatSync(p);
      if (st.isFile() && Date.now() - st.mtimeMs > 3600_000) rmSync(p, { force: true });
    }
  } catch {
    // 读不到目录：不影响本次写入
  }
  const tmp = join(realDir, `.${basename(target).slice(0, 60)}.kwl-${randomBytes(6).toString("hex")}.part`);
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "wx", 0o600);
    let off = 0;
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, final);
  } catch (e) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // 已关闭
      }
    }
    rmSync(tmp, { force: true });
    if (e instanceof DomainError) throw e;
    const code = (e as NodeJS.ErrnoException)?.code;
    throw new DomainError("validation", code === "EACCES" || code === "EPERM" ? "没有权限写入这个位置，请换一个位置" : code === "ENOSPC" ? "磁盘空间不足" : "保存失败，请换一个位置再试", 422);
  }
  return { name: basename(final), bytes: bytes.length };
}
