/**
 * 增量备份（第 14 批；设计 docs/design/恢复与备份设计-v1.md §3.3）：律师选一个备份位置（移动硬盘、律所 NAS、同步盘），
 * 内核每天把工作区复制过去——复制的全是**密文**（账本 SQLCipher 页级密文、块按事项密钥加密、工作区 KWE1、密钥文件按主密钥封装），
 * 备份位置本身不需要可信；没有恢复包与恢复码，备份打不开。
 *
 * - 账本：先 WAL 检查点（TRUNCATE），再同步复制主库文件（内核是单连接同步驱动，复制期间不会有写入）→ 一致快照；
 * - 其余文件：按相对路径 + 大小 + 修改时间增量复制（块是内容寻址、只增不改）；不复制日志、运行期套接字与临时文件；
 * - 清单：每次备份写 manifest.json（文件、大小、sha256、序号、时刻）并由设备签名私钥签名（manifest.sig）；恢复时先验清单再复制；
 * - 目标目录：<备份位置>/KimiWorkLegal-backup/<律所>/<设备编号>/（同一位置可放多台设备、多个律所）。
 * 删除事项后的密码学擦除在备份里同样成立：事项密钥已删，备份里的块与工作区解不开；删除回执写明“备份里的副本不可读、不立即删除”。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";
import { canonicalJson } from "@zr-legal/keys";
import { DomainError } from "@zr-legal/domain";
import type { KernelDb } from "../db.ts";

export const BACKUP_DIRNAME = "KimiWorkLegal-backup";
/** 不进备份的路径（相对工作区，前缀匹配）。 */
const SKIP = [/^logs(\/|$)/, /^run(\/|$)/, /^\.kwl-tmp/, /\.tmp-\d+$/, /^ledger\.db(-wal|-shm)?$/, /^\.log-salt$/, /^keys\/(join-pending|join-approved|activation-claim|recovery-staged)\.json$/];

export interface BackupState {
  dir: string | null;
  seq: number;
  last_ok_at: string | null;
  last_error: string | null;
  last_files: number;
  last_bytes: number;
}

export interface BackupManifest {
  kind: "kwl-backup-manifest";
  v: 1;
  tid: string;
  device_id: string;
  seq: number;
  at: string;
  ledger: { file: string; size: number; sha256: string };
  files: { path: string; size: number; sha256: string }[];
}

const sha256File = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const posix = (p: string) => p.split(sep).join("/");

function walk(root: string, base = root, out: string[] = []): string[] {
  if (!existsSync(root)) return out;
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, e.name);
    const rel = posix(relative(base, p));
    if (SKIP.some((re) => re.test(rel))) continue;
    if (e.isDirectory()) walk(p, base, out);
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

export function backupTargetOf(dir: string, firmSlug: string, deviceId: string): string {
  return join(dir, BACKUP_DIRNAME, firmSlug, deviceId);
}

export function manifestBytes(m: BackupManifest): Buffer {
  return Buffer.from(`kwl-backup-manifest/1\n${canonicalJson(m)}`, "utf8");
}

export interface BackupDeps {
  db: KernelDb;
  workspaceDir: string;
  dbFile: string;
  tenantId: string;
  firmSlug: string;
  deviceId: string;
  sign: (bytes: Uint8Array) => string;
  stateFile: string;
}

export function readBackupState(stateFile: string): BackupState {
  try {
    const s = JSON.parse(readFileSync(stateFile, "utf8")) as BackupState;
    return { dir: typeof s.dir === "string" ? s.dir : null, seq: Number(s.seq) || 0, last_ok_at: s.last_ok_at ?? null, last_error: s.last_error ?? null, last_files: Number(s.last_files) || 0, last_bytes: Number(s.last_bytes) || 0 };
  } catch {
    return { dir: null, seq: 0, last_ok_at: null, last_error: null, last_files: 0, last_bytes: 0 };
  }
}

function writeState(stateFile: string, s: BackupState): void {
  const tmp = `${stateFile}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  renameSync(tmp, stateFile);
}

export function configureBackup(d: BackupDeps, dir: string, insideDataRoot: (p: string) => boolean): BackupState {
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) throw new DomainError("validation", "备份位置不存在或不是文件夹", 400);
  if (insideDataRoot(dir)) throw new DomainError("validation", "备份位置不能放在本应用自己的数据目录里，请选移动硬盘或律所共享盘", 400);
  const s = { ...readBackupState(d.stateFile), dir, last_error: null };
  writeState(d.stateFile, s);
  return s;
}

/** 执行一次增量备份；失败记在状态里（只记错误代码）并抛出。 */
export function runBackup(d: BackupDeps): BackupState & { copied: number } {
  const st = readBackupState(d.stateFile);
  if (!st.dir) throw new DomainError("conflict", "还没有选备份位置", 409);
  const target = backupTargetOf(st.dir, d.firmSlug, d.deviceId);
  try {
    mkdirSync(target, { recursive: true, mode: 0o700 });
    // 1. 账本一致快照（检查点后同步复制；单连接同步驱动，复制期间无写入）
    d.db.checkpointTruncate();
    const ledgerTmp = join(target, "ledger.db.tmp");
    copyFileSync(d.dbFile, ledgerTmp);
    renameSync(ledgerTmp, join(target, "ledger.db"));
    const ledger = { file: "ledger.db", size: statSync(join(target, "ledger.db")).size, sha256: sha256File(join(target, "ledger.db")) };
    // 2. 其余文件增量
    const files: BackupManifest["files"] = [];
    let copied = 0;
    let bytes = ledger.size;
    for (const rel of walk(d.workspaceDir)) {
      const src = join(d.workspaceDir, rel);
      const dst = join(target, "files", rel);
      const ss = statSync(src);
      const same = existsSync(dst) && (() => {
        const ds = statSync(dst);
        return ds.size === ss.size && ds.mtimeMs >= ss.mtimeMs;
      })();
      if (!same) {
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(src, `${dst}.tmp`);
        renameSync(`${dst}.tmp`, dst);
        copied += 1;
      }
      files.push({ path: rel, size: ss.size, sha256: sha256File(dst) });
      bytes += ss.size;
    }
    // 3. 备份里有、本机已没有的文件（事项删除后的块等）：从清单里去掉并删除副本
    const keep = new Set(files.map((f) => f.path));
    for (const rel of walk(join(target, "files"))) if (!keep.has(rel)) rmSync(join(target, "files", rel), { force: true });
    // 4. 签名清单
    const m: BackupManifest = { kind: "kwl-backup-manifest", v: 1, tid: d.tenantId, device_id: d.deviceId, seq: st.seq + 1, at: new Date().toISOString(), ledger, files };
    writeFileSync(join(target, "manifest.json.tmp"), JSON.stringify(m), { mode: 0o600 });
    writeFileSync(join(target, "manifest.sig.tmp"), d.sign(manifestBytes(m)), { mode: 0o600 });
    renameSync(join(target, "manifest.json.tmp"), join(target, "manifest.json"));
    renameSync(join(target, "manifest.sig.tmp"), join(target, "manifest.sig"));
    const next: BackupState = { ...st, seq: m.seq, last_ok_at: m.at, last_error: null, last_files: files.length + 1, last_bytes: bytes };
    writeState(d.stateFile, next);
    return { ...next, copied };
  } catch (e) {
    const code = e instanceof DomainError ? e.code : String((e as NodeJS.ErrnoException)?.code ?? "backup_failed");
    writeState(d.stateFile, { ...st, last_error: code });
    throw e instanceof DomainError ? e : new DomainError("internal", `备份没有完成（${code}）：请检查备份位置是否可写、空间是否够`, 500);
  }
}

/**
 * 从备份恢复（待激活模式）：先验清单签名与每个文件的摘要，再复制到 <数据根>/<律所>/。
 * verifySig：调用方用恢复包里的设备证书公钥核对。
 */
export function restoreFromBackup(o: { backupDir: string; firmSlug: string; deviceId: string; workspaceDir: string; verifySig: (bytes: Uint8Array, sig: string) => boolean }): { manifest: BackupManifest; files: number } {
  const src = backupTargetOf(o.backupDir, o.firmSlug, o.deviceId);
  if (!existsSync(join(src, "manifest.json"))) throw new DomainError("validation", "这个位置没有这台电脑的备份（找不到备份清单）", 400);
  const m = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8")) as BackupManifest;
  const sig = readFileSync(join(src, "manifest.sig"), "utf8").trim();
  if (m.kind !== "kwl-backup-manifest" || m.device_id !== o.deviceId || !o.verifySig(manifestBytes(m), sig)) throw new DomainError("validation", "备份清单核对不通过（不是这台电脑的备份，或被改动过）", 400);
  if (sha256File(join(src, "ledger.db")) !== m.ledger.sha256) throw new DomainError("validation", "备份里的账本被改动过或不完整", 400);
  for (const f of m.files) {
    if (f.path.includes("..") || f.path.startsWith("/")) throw new DomainError("validation", "备份清单含不合法的路径", 400);
    if (sha256File(join(src, "files", f.path)) !== f.sha256) throw new DomainError("validation", `备份里的文件被改动过或不完整：${f.path.split("/").pop()}`, 400);
  }
  if (existsSync(o.workspaceDir) && readdirSync(o.workspaceDir).length > 0) throw new DomainError("conflict", "这台电脑上已经有这个律所的数据，不能覆盖恢复", 409);
  mkdirSync(o.workspaceDir, { recursive: true, mode: 0o700 });
  for (const f of m.files) {
    const dst = join(o.workspaceDir, f.path);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(join(src, "files", f.path), dst);
  }
  copyFileSync(join(src, "ledger.db"), join(o.workspaceDir, "ledger.db"));
  return { manifest: m, files: m.files.length + 1 };
}
