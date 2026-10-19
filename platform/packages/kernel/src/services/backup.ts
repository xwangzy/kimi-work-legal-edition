/**
 * 增量备份（第 14 批；设计 docs/design/恢复与备份设计-v1.md §3.3）：律师选一个备份位置（移动硬盘、律所 NAS、同步盘），
 * 内核每天把工作区复制过去——复制的全是**密文**（账本 SQLCipher 页级密文、块按事项密钥加密、工作区 KWE1、密钥文件按主密钥封装），
 * 备份位置本身不需要可信；没有恢复包与恢复码，备份打不开。
 *
 * 格式 v2（第 14 批第二轮复核 R2A-08/09/11/12 处置）：
 * - 目录：<备份位置>/KimiWorkLegal-backup/<不透明编号>/，编号 = HMAC(由数据库主密钥派生的命名密钥, 租户‖设备编号) 的前 32 位十六进制——
 *   备份位置上看不出是哪家律所、哪台设备；恢复时用恢复包里的主密钥算出同一编号。
 * - 文件按**内容寻址**存放：objects/<sha256>（账本也是一个对象）；文件名与目录结构只写在**加密**的清单里——网盘服务商只看得到文件数量、大小与时间。
 * - 清单 manifest-<序号>.kwlb = { body: AES-256-GCM(清单明文，密钥由主密钥派生，附加数据绑定目录编号), sig: 设备签名(body) }，一个文件、原子改名写入；
 *   **保留最近 7 代**（复核 R2B-03）：对象只增不改、只在不被任何保留的清单引用时删除——源数据损坏或一次备份中断，上一代仍可恢复。
 * - 清单里的摘要一律取自**本机源文件**（本机摘要索引 backup-index.json 只用来免去重复计算）：能写备份位置的人换掉某个对象，
 *   下次恢复按清单核对即失败，不会被本机设备“背书”（R2A-08）。
 * - 备份位置不跟随链接与联接点（逐级 lstat）；临时文件随机命名、独占创建（R2A-11）。
 * - 新清单写好之后才删除不再被保留的清单引用的对象；中途失败或被取消，上一代清单仍完整可用。
 * - 异步执行（复核 R2B-04）：读写用异步文件接口、每处理一批文件让出事件循环，界面与任务照常响应；退出与安装更新前可取消（AbortSignal）。
 * - 恢复：先验签名、解密清单，再逐个读出对象、核对摘要、写进数据根下的暂存目录，全部通过后整体改名就位（读与核同一份字节，R2A-12）；
 *   任何一步失败都删掉暂存，不留残余（R2A-15）。
 * 删除事项后内核立即再备份一次（R2A-10），备份位置上的旧账本快照与该事项的块随之删除；备份位置若保留旧版本（网盘版本历史、NAS 快照），
 * 旧版本连同恢复包与恢复码仍能解开——删除回执如实写明。
 */
import { constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { copyFile, readFile, rename as renameAsync, writeFile } from "node:fs/promises";
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";
import { canonicalJson } from "@zr-legal/keys";
import { DomainError } from "@zr-legal/domain";
import type { KernelDb } from "../db.ts";

export const BACKUP_DIRNAME = "KimiWorkLegal-backup";
const KEEP_GENERATIONS = 7;
const manifestName = (seq: number) => `manifest-${String(seq).padStart(8, "0")}.kwlb`;
const MANIFEST_RE = /^manifest-(\d{8})\.kwlb$/;
const OBJECTS = "objects";
export const RESTORED_MARKER = ".restored-from-backup.json";
/**
 * 不进备份的路径（相对工作区）：运行期日志与套接字、临时文件、账本本体（另行快照）、日志盐、入组/认领/设备恢复暂存、
 * 设备导出（口令包裹，复核 R2A-13）、本机备份状态与摘要索引（含备份位置路径，不随恢复带到新电脑——R2A-08/R2A-17）、恢复标记。
 */
const SKIP = [
  /(^|\/)logs(\/|$)/,
  /^run(\/|$)/,
  /(^|\/)\.kwl-tmp/,
  /\.kwl-tmp-[0-9a-z]+$/,
  /\.\d+\.(reseal\.)?tmp$/,
  /(^|\/)w-tmp(\/|$)/,
  /\.tmp-[0-9a-z-]+$/,
  /\.part$/,
  /^ledger\.db(-wal|-shm|\.tmp.*)?$/,
  /^\.log-salt$/,
  /^keys\/(join-pending|join-approved|activation-claim|recovery-staged)/,
  /^recovery(\/|$)/,
  /^backup(-index)?\.json$/,
  /^\.restored-from-backup\.json$/,
];

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
  v: 2;
  tid: string;
  device_id: string;
  seq: number;
  at: string;
  ledger: { size: number; sha256: string };
  files: { path: string; size: number; sha256: string }[];
}

interface ManifestFile {
  body: { v: 2; iv: string; tag: string; ct: string };
  sig: string;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const posix = (p: string) => p.split(sep).join("/");
const tmpName = (p: string) => `${p}.tmp-${randomBytes(6).toString("hex")}`;

function backupKeys(dbKey: string): { name: Buffer; manifest: Buffer } {
  const ikm = Buffer.from(dbKey, "utf8");
  const k = (info: string) => Buffer.from(hkdfSync("sha256", ikm, Buffer.from("kwl-backup"), Buffer.from(info), 32));
  return { name: k("kwl-backup-name/2"), manifest: k("kwl-backup-manifest/2") };
}

/** 备份目录（不透明编号；恢复时由恢复包里的主密钥、租户与设备编号算出）。 */
export function backupTargetOf(dir: string, dbKey: string, tenantId: string, deviceId: string): string {
  const id = createHmac("sha256", backupKeys(dbKey).name).update(`${tenantId}\n${deviceId}`).digest("hex").slice(0, 32);
  return join(dir, BACKUP_DIRNAME, id);
}

export function manifestSigBytes(body: ManifestFile["body"]): Buffer {
  return Buffer.from(`kwl-backup-manifest/2\n${canonicalJson(body)}`, "utf8");
}

function aadOf(target: string): Buffer {
  return Buffer.from(`kwl-backup-manifest/2\n${target.split(/[\\/]/).pop()}`, "utf8");
}

/** 路径上不得有链接或联接点（逐级 lstat，复核 R2A-11）；不存在则建为目录。 */
function ensureRealDir(p: string): void {
  if (existsSync(p)) {
    const s = lstatSync(p);
    if (s.isSymbolicLink() || !s.isDirectory()) throw new DomainError("validation", "备份位置里有链接、联接点或同名文件，已停止备份：请换一个备份位置，或请所内 IT 检查", 400);
    return;
  }
  mkdirSync(p, { mode: 0o700 });
}

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

export interface BackupDeps {
  db: KernelDb;
  workspaceDir: string;
  dbFile: string;
  /** 数据库主密钥（备份目录名与清单密钥由它派生；开发形态没有主密钥时不能备份）。 */
  dbKey: string | undefined;
  tenantId: string;
  deviceId: string;
  sign: (bytes: Uint8Array) => string;
  stateFile: string;
  /** 本机摘要索引（相对路径 → 大小、修改时间、摘要）：只用来免去重复计算。 */
  indexFile: string;
  insideDataRoot: (p: string) => boolean;
  /** 取消（退出、安装更新）：在两个文件之间检查，取消即不写清单，上一代不受影响。 */
  signal?: AbortSignal;
  onProgress?: (p: { done: number; total: number }) => void;
}

export function readBackupState(stateFile: string): BackupState {
  try {
    const s = JSON.parse(readFileSync(stateFile, "utf8")) as BackupState;
    return { dir: typeof s.dir === "string" ? s.dir : null, seq: Number(s.seq) || 0, last_ok_at: s.last_ok_at ?? null, last_error: s.last_error ?? null, last_files: Number(s.last_files) || 0, last_bytes: Number(s.last_bytes) || 0 };
  } catch {
    return { dir: null, seq: 0, last_ok_at: null, last_error: null, last_files: 0, last_bytes: 0 };
  }
}

function writeJsonFile(file: string, value: unknown): void {
  const tmp = tmpName(file);
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  renameSync(tmp, file);
}

/** 解析成真实路径并核对不在本应用的数据目录里（按解析后的路径，复核 R2A-11）。 */
function realBackupDir(dir: string, insideDataRoot: (p: string) => boolean): string {
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) throw new DomainError("validation", "备份位置不存在或不是文件夹（移动硬盘是否已插好？）", 400);
  const real = realpathSync(dir);
  if (insideDataRoot(dir) || insideDataRoot(real)) throw new DomainError("validation", "备份位置不能放在本应用自己的数据目录里，请选移动硬盘或律所共享盘", 400);
  return real;
}

export function configureBackup(d: BackupDeps, dir: string): BackupState {
  if (!d.dbKey) throw new DomainError("conflict", "开发形态（未加密的开发库）不能设置备份", 409);
  realBackupDir(dir, d.insideDataRoot);
  const s = { ...readBackupState(d.stateFile), dir, last_error: null };
  writeJsonFile(d.stateFile, s);
  return s;
}

type IndexEntry = { size: number; mtimeMs: number; sha256: string };

function readIndex(file: string): Record<string, IndexEntry> {
  try {
    const x = JSON.parse(readFileSync(file, "utf8")) as { v?: number; entries?: Record<string, IndexEntry> };
    return x.v === 1 && x.entries && typeof x.entries === "object" ? x.entries : {};
  } catch {
    return {};
  }
}

const tick = () => new Promise<void>((r) => setImmediate(r));

function decryptManifest(file: string, key: Buffer, target: string, verifySig: ((bytes: Uint8Array, sig: string) => boolean) | null): BackupManifest {
  const mf = JSON.parse(readFileSync(file, "utf8")) as ManifestFile;
  if (!mf?.body || mf.body.v !== 2 || typeof mf.sig !== "string" || (verifySig && !verifySig(manifestSigBytes(mf.body), mf.sig))) throw new Error("sig");
  const dc = createDecipheriv("aes-256-gcm", key, Buffer.from(mf.body.iv, "base64"));
  dc.setAAD(aadOf(target));
  dc.setAuthTag(Buffer.from(mf.body.tag, "base64"));
  return JSON.parse(Buffer.concat([dc.update(Buffer.from(mf.body.ct, "base64")), dc.final()]).toString("utf8")) as BackupManifest;
}

/** 备份目录里的各代清单（新的在前）。 */
function generations(target: string): { seq: number; file: string }[] {
  if (!existsSync(target)) return [];
  return readdirSync(target)
    .map((n) => ({ n, m: MANIFEST_RE.exec(n) }))
    .filter((x) => x.m)
    .map((x) => ({ seq: Number(x.m![1]), file: join(target, x.n) }))
    .sort((a, b) => b.seq - a.seq);
}

/** 执行一次增量备份（异步、可取消）；失败记在状态里（只记错误代码）并抛出。 */
export async function runBackup(d: BackupDeps): Promise<BackupState & { copied: number }> {
  const st = readBackupState(d.stateFile);
  if (!st.dir) throw new DomainError("conflict", "还没有选备份位置", 409);
  if (!d.dbKey) throw new DomainError("conflict", "开发形态（未加密的开发库）不能备份", 409);
  const keys = backupKeys(d.dbKey);
  const aborted = () => {
    if (d.signal?.aborted) throw new DomainError("cancelled", "备份已取消（应用正在退出或更新），下次会继续", 409);
  };
  try {
    const dir = realBackupDir(st.dir, d.insideDataRoot);
    ensureRealDir(join(dir, BACKUP_DIRNAME));
    const target = backupTargetOf(dir, d.dbKey, d.tenantId, d.deviceId);
    ensureRealDir(target);
    const objects = join(target, OBJECTS);
    ensureRealDir(objects);
    let copied = 0;
    const putObject = async (hash: string, write: (tmp: string) => Promise<void>) => {
      const dst = join(objects, hash);
      if (existsSync(dst)) {
        if (lstatSync(dst).isSymbolicLink()) throw new DomainError("validation", "备份位置里有链接或联接点，已停止备份", 400);
        return;
      }
      const tmp = tmpName(dst);
      await write(tmp);
      await renameRetry(tmp, dst);
      copied += 1;
    };
    // 1. 账本一致快照：检查点后同步读入内存（单连接同步驱动，读期间无写入），再异步写出；检查点没有完整完成即不备份（复核 R2B-14）
    if (!d.db.checkpointTruncate()) throw new DomainError("conflict", "案件数据正忙，这次没有备份，稍后会再试", 409);
    const ledgerBytes = readFileSync(d.dbFile);
    const ledger = { size: ledgerBytes.length, sha256: sha256(ledgerBytes) };
    await putObject(ledger.sha256, (tmp) => writeFile(tmp, ledgerBytes, { flag: "wx", mode: 0o600 }));
    // 2. 其余文件：摘要取自本机源文件（索引里大小与修改时间都没变的沿用上次算出的摘要）；列出之后消失的文件（运行中的任务刚删掉的临时文件）跳过
    const prev = readIndex(d.indexFile);
    const next: Record<string, IndexEntry> = {};
    const files: BackupManifest["files"] = [];
    let bytes = ledger.size;
    const list = walk(d.workspaceDir);
    for (let i = 0; i < list.length; i++) {
      aborted();
      const rel = list[i]!;
      const src = join(d.workspaceDir, rel);
      try {
        const ss = statSync(src);
        const p = prev[rel];
        const hash = p && p.size === ss.size && p.mtimeMs === ss.mtimeMs ? p.sha256 : sha256(await readFile(src));
        await putObject(hash, (tmp) => copyFile(src, tmp, constants.COPYFILE_EXCL));
        next[rel] = { size: ss.size, mtimeMs: ss.mtimeMs, sha256: hash };
        files.push({ path: rel, size: ss.size, sha256: hash });
        bytes += ss.size;
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === "ENOENT" && !existsSync(src)) continue;
        throw e;
      }
      if (i % 20 === 19) {
        d.onProgress?.({ done: i + 1, total: list.length });
        await tick();
      }
    }
    aborted();
    // 3. 加密清单 + 设备签名，一个文件原子写入（新一代）
    const m: BackupManifest = { kind: "kwl-backup-manifest", v: 2, tid: d.tenantId, device_id: d.deviceId, seq: Math.max(st.seq, generations(target)[0]?.seq ?? 0) + 1, at: new Date().toISOString(), ledger, files };
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", keys.manifest, iv);
    c.setAAD(aadOf(target));
    const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(m), "utf8")), c.final()]);
    const body: ManifestFile["body"] = { v: 2, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
    const mf: ManifestFile = { body, sig: d.sign(manifestSigBytes(body)) };
    const mfPath = join(target, manifestName(m.seq));
    const tmp = tmpName(mfPath);
    await writeFile(tmp, JSON.stringify(mf), { flag: "wx", mode: 0o600 });
    await renameRetry(tmp, mfPath);
    // 4. 只保留最近几代；删除不再被任何保留的清单引用的对象与残留临时文件
    const gens = generations(target);
    const keep = new Set<string>([ledger.sha256, ...files.map((f) => f.sha256)]);
    for (const g of gens.slice(1, KEEP_GENERATIONS)) {
      try {
        const om = decryptManifest(g.file, keys.manifest, target, null);
        keep.add(om.ledger.sha256);
        for (const f of om.files) keep.add(f.sha256);
      } catch {
        // 解不开的旧清单（损坏）：它引用的对象不再保留
      }
    }
    for (const g of gens.slice(KEEP_GENERATIONS)) rmSync(g.file, { force: true });
    for (const name of readdirSync(objects)) if (!keep.has(name) && (/^[0-9a-f]{64}$/.test(name) || /\.tmp-[0-9a-f]{12}$/.test(name))) rmSync(join(objects, name), { force: true });
    for (const name of readdirSync(target)) if (/\.tmp-[0-9a-f]{12}$/.test(name)) rmSync(join(target, name), { force: true });
    writeJsonFile(d.indexFile, { v: 1, entries: next });
    const out: BackupState = { ...st, seq: m.seq, last_ok_at: m.at, last_error: null, last_files: files.length + 1, last_bytes: bytes };
    writeJsonFile(d.stateFile, out);
    d.onProgress?.({ done: list.length, total: list.length });
    return { ...out, copied };
  } catch (e) {
    const code = e instanceof DomainError ? e.code : String((e as NodeJS.ErrnoException)?.code ?? "backup_failed");
    try {
      writeJsonFile(d.stateFile, { ...st, last_error: code });
    } catch {
      // 状态写不进去：本次备份本来就失败了
    }
    throw e instanceof DomainError ? e : new DomainError("internal", backupErrorText(code), 500, { code });
  }
}

/** 同步盘、杀毒软件、Windows 搜索正打开目标文件时改名会暂时失败：退避重试 3 次（复核 R2B-12）。 */
async function renameRetry(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await renameAsync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (i >= 3 || !(code === "EPERM" || code === "EBUSY" || code === "EACCES")) throw e;
      await new Promise((r) => setTimeout(r, 200 * 2 ** i));
    }
  }
}

/** 备份失败 → 律师话术（复核 R2B-20：错误码只进运行记录与状态文件）。 */
export function backupErrorText(code: string): string {
  if (code === "ENOSPC") return "备份没有完成：备份位置的空间不够了，请清理或换一个更大的位置";
  if (code === "ENOENT" || code === "ENODEV" || code === "EIO" || code === "ENXIO") return "备份没有完成：备份位置不在了（移动硬盘是否已拔出、网络盘是否断开？）插好后会自动再试";
  if (code === "EBUSY" || code === "EPERM") return "备份没有完成：备份位置的文件正被别的程序占用（同步盘或杀毒软件），稍后会自动再试";
  if (code === "EACCES" || code === "EROFS") return "备份没有完成：没有写入备份位置的权限，请换一个位置或请所内 IT 检查";
  return "备份没有完成：请检查备份位置是否插好、可写、空间是否够";
}

/** 清单里的相对路径：只许普通的“/”分隔段（不许空段、“.”“..”、反斜杠、盘符与控制字符）。 */
function safeRel(p: string): boolean {
  if (typeof p !== "string" || p.length === 0 || p.length > 1024 || p.startsWith("/")) return false;
  return p.split("/").every((s) => s.length > 0 && s !== "." && s !== ".." && !/[\\:\0-\x1f]/.test(s));
}

/** 律师可能选的是 U 盘本身、KimiWorkLegal-backup 文件夹或更里层：在所选目录、往上两级与其 KimiWorkLegal-backup 子目录里找（复核 R2B-16）。 */
function findTarget(dir: string, dbKey: string, tenantId: string, deviceId: string): string | null {
  const id = backupTargetOf("/", dbKey, tenantId, deviceId).split(/[\\/]/).pop()!;
  const cands = new Set<string>();
  let cur = dir;
  for (let i = 0; i < 3; i++) {
    cands.add(join(cur, BACKUP_DIRNAME, id));
    cands.add(join(cur, id));
    if (cur.split(/[\\/]/).pop() === id) cands.add(cur);
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  for (const c of cands) if (generations(c).length > 0) return c;
  return null;
}

/**
 * 从备份恢复（待激活模式）：取最新一代清单，验签名、解密，逐个读出对象、核对摘要、写进暂存目录，全部通过后整体改名为 <数据根>/<律所>；
 * 最新一代不完整（签名不对、缺对象、对象被改）就退回上一代（复核 R2B-03），并在结果里写明恢复的是哪一天。
 * beforeCommit 在改名之前调用（写“待生效的激活记录”）；任何一步失败都删掉暂存。
 */
export async function restoreFromBackup(o: {
  backupDir: string;
  dbKey: string;
  tenantId: string;
  deviceId: string;
  dataRoot: string;
  firmSlug: string;
  verifySig: (bytes: Uint8Array, sig: string) => boolean;
  /** 恢复包生成时本机最近一次备份的序号：用来恢复的那一代比它旧（被换回更早的一份、或较新的几代都损坏）时须律师确认（复核 R2A-12）。 */
  minSeq?: number | null;
  olderAck?: boolean;
  beforeCommit?: (m: BackupManifest) => void;
}): Promise<{ manifest: BackupManifest; files: number; skipped_newer: number }> {
  const dir = existsSync(o.backupDir) ? realpathSync(o.backupDir) : o.backupDir;
  const target = findTarget(dir, o.dbKey, o.tenantId, o.deviceId);
  if (!target) throw new DomainError("validation", "这个位置没有原来那台电脑的备份。请选备份所在的 U 盘或文件夹本身（里面应有一个 KimiWorkLegal-backup 文件夹）", 400);
  for (const p of [dirname(target), target, join(target, OBJECTS)]) if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new DomainError("validation", "备份位置里有链接或联接点，不能从这里恢复", 400);
  const ws = join(o.dataRoot, o.firmSlug);
  if (existsSync(ws) && readdirSync(ws).length > 0) throw new DomainError("conflict", "这台电脑上已经有这个律所的数据，不能覆盖恢复", 409);
  const key = backupKeys(o.dbKey).manifest;
  let lastErr: DomainError = new DomainError("validation", "备份清单核对不通过（不是原来那台电脑的备份，或被改动过）", 400);
  const gens = generations(target);
  for (let gi = 0; gi < gens.length; gi++) {
    const g = gens[gi]!;
    let m: BackupManifest;
    try {
      if (lstatSync(g.file).isSymbolicLink()) throw new Error("link");
      m = decryptManifest(g.file, key, target, o.verifySig);
    } catch {
      lastErr = new DomainError("validation", "备份清单核对不通过（不是原来那台电脑的备份，或被改动过）", 400);
      continue;
    }
    if (m.kind !== "kwl-backup-manifest" || m.v !== 2 || m.device_id !== o.deviceId || m.tid !== o.tenantId) continue;
    if (!m.files.every((f) => safeRel(f.path) && /^[0-9a-f]{64}$/.test(f.sha256)) || !/^[0-9a-f]{64}$/.test(m.ledger.sha256)) {
      lastErr = new DomainError("validation", "备份清单含不合法的路径", 400);
      continue;
    }
    const staging = join(o.dataRoot, `.restore-${randomBytes(6).toString("hex")}`);
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    try {
      const copyObject = async (hash: string, dst: string) => {
        const src = join(target, OBJECTS, hash);
        if (!existsSync(src) || lstatSync(src).isSymbolicLink()) throw new DomainError("validation", "备份里缺少文件或文件被改动过", 400);
        const buf = await readFile(src);
        if (sha256(buf) !== hash) throw new DomainError("validation", "备份里的文件被改动过或不完整", 400);
        mkdirSync(dirname(dst), { recursive: true });
        await writeFile(dst, buf, { flag: "wx", mode: 0o600 });
      };
      for (let i = 0; i < m.files.length; i++) {
        await copyObject(m.files[i]!.sha256, join(staging, m.files[i]!.path));
        if (i % 20 === 19) await tick();
      }
      await copyObject(m.ledger.sha256, join(staging, "ledger.db"));
      // 这一代完整可用之后才比较新旧：比恢复包生成时的备份旧（被换回更早的一份、或较新的几代都不完整）须律师确认
      if (o.minSeq && m.seq < o.minSeq && !o.olderAck) {
        throw new DomainError(
          "conflict",
          `能用的备份是 ${localDay(m.at)} 的${gi > 0 ? "（较新的几份不完整）" : ""}，比生成恢复包时的备份还旧，用它恢复会丢掉之后的内容。若确认仍要恢复，请勾选“仍用这份备份恢复”`,
          409,
          { code: "backup_older", backup_at: m.at, backup_seq: m.seq, package_seq: o.minSeq },
        );
      }
      writeFileSync(join(staging, RESTORED_MARKER), JSON.stringify({ v: 1, restored_at: new Date().toISOString(), backup_at: m.at, backup_seq: m.seq }), { mode: 0o600 });
      if (existsSync(ws) && readdirSync(ws).length > 0) throw new DomainError("conflict", "这台电脑上已经有这个律所的数据，不能覆盖恢复", 409);
      o.beforeCommit?.(m);
      if (existsSync(ws)) rmSync(ws, { recursive: true, force: true }); // 只剩空目录（上面已核对不是非空）
      renameSync(staging, ws);
      return { manifest: m, files: m.files.length + 1, skipped_newer: gi };
    } catch (e) {
      rmSync(staging, { recursive: true, force: true });
      if (e instanceof DomainError && e.code === "validation") {
        lastErr = e;
        continue;
      }
      if (e instanceof DomainError) throw e;
      throw new DomainError("validation", "读不了备份里的文件：请确认 U 盘插好、文件没有被移动，再试一次", 400, { code: String((e as NodeJS.ErrnoException)?.code ?? "io") });
    }
  }
  throw lastErr;
}

/** 本地日期（北京时间等本机时区；复核 R2B-22：不按 UTC 截取）。 */
function localDay(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : iso.slice(0, 10);
}

/** 启动时清理恢复中途留下的暂存目录（进程在复制途中被结束）。 */
export function cleanupRestoreStaging(dataRoot: string): void {
  try {
    for (const e of readdirSync(dataRoot, { withFileTypes: true })) if (e.isDirectory() && /^\.restore-[0-9a-f]{12}$/.test(e.name)) rmSync(join(dataRoot, e.name), { recursive: true, force: true });
  } catch {
    // 数据根还不存在
  }
}
