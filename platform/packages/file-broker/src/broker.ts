/**
 * 文件 broker（v9 第 04 篇 §4.4；F2 修复，含阶段 1 对抗式审查 R-11/R-12/R-19 处置）：Agent 能碰到的每一个文件都经这里。
 *
 * 区域（zone）：
 * - 原件区（originals）：只读；执行域只见本任务所需原件的只读快照；
 * - 工作区（work）：读写；文件历史与快照可回滚；
 * - 交付区（deliver）：Agent 只读（或不挂载），写入只能由人经业务 API 发布；
 * - 引擎状态（home）与可信配置（trusted，只读）按需登记。
 *
 * 强制方式（不是字符串前缀，也不按名字判断对象）：
 * 1. 语法层（paths.ts）：平台感知的规范化、危险形态拒绝（UNC、设备名、ADS、8.3 短名、超长路径……）、按分量判断区域归属；
 * 2. 逐级 lstat：区域根以下每一级都必须是真实目录，遇符号链接 / junction / 重解析点即拒绝，并记下各级 inode；
 * 3. 读：O_RDONLY|O_NOFOLLOW 打开（打开本身无副作用）→ 复核父级 inode 与句柄身份 → 才读取；
 * 4. 写：**不再以 O_TRUNC 打开既有路径**。在已校验的父目录内以 O_CREAT|O_EXCL|O_NOFOLLOW 建临时文件 → 写入并 fsync →
 *    复核父级 inode 与临时文件身份 → rename 原子替换（rename 替换的是目录项本身：既不跟随目标处的链接，也不触碰
 *    硬链接指向的区域外 inode）→ 事后核对目标身份；独占创建用 link(tmp, target)（目标已存在即 EEXIST）；
 * 5. 删：先把目标 rename 进区域内回收目录，核对移入对象的 dev/ino 与校验时一致（不一致即移回并拒绝）后才递归删除；
 * 6. 建目录：逐级创建，创建后核对新目录的 `..` 正是校验过的父目录，否则删除并拒绝；
 * 7. 只读文件按**对象身份**（dev, ino）保护，而不是按名字：别名（大小写、Unicode 折叠如 `ſ`→`s`、8.3 短名）、
 *    rename 覆盖、删除其祖先目录，都会在身份比对处被拒（EPERM）；
 * 8. 保留名 `.kwl-*`（回收目录、临时文件）对 Agent 不可见、不可寻址。
 *
 * 如实的残余：Node 没有 openat/renameat 等按目录句柄的操作，“父级复核”到“rename/link”之间仍有一次系统调用的窗口；
 * 窗口内父目录被换成链接时，临时文件可能短暂出现在区域外（随即被清理），但不会截断、改写区域外已有文件。
 * Windows 无 O_NOFOLLOW，依赖逐级 lstat（libuv 把 symlink 与 junction 报告为链接）+ 打开后身份核对；其他名称代理类
 * 重解析标签、网络盘与 SUBST 盘符需原生扩展判定（GetFileInformationByHandleEx / GetDriveTypeW），列入 Windows 实机探针。
 * 同用户恶意进程（不经 broker 直接改盘）不在本层防护范围（第 02 篇 §3.4“被篡改的客户端”如实口径）。
 */
import { constants as FS, lstatSync, realpathSync, type Stats } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, rm, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { posix, win32 } from "node:path";
import { CHUNK_BYTES, chunkSpan, HEADER_BYTES, isChunkedHeader, isValidChunkedSize, lastChunkSpan, plainSizeOf } from "@zr-legal/at-rest";
import { currentFlavor, foldName, maxPathBytes, relativeUnder, splitAbsolute, splitRelative, type PathFlavor } from "./paths.ts";

export type AgentAccess = "ro" | "rw";

export interface ZoneSpec {
  /** 区域名（originals / work / deliver / home / trusted / skills …）。 */
  name: string;
  /** 区域根（绝对路径；可信配置，不由 Agent 决定）。 */
  root: string;
  /** Agent 对该区域的权限。 */
  access: AgentAccess;
  /**
   * 落盘加密（审计 S3 / ZP-9）：给出即本区内容以 KWE1 密文落盘（@zr-legal/at-rest ZoneCodec）——写入前封装、读出时解封（分块格式按区间只解所需分块），
   * stat 的 size 报告明文长度、diskSize 报告盘上长度；文件名、目录结构与时间不加密（如实残余）。
   * 第 1 步对引擎状态区启用；第 2 步对工作区与材料区启用（检索改为宿主内检索、执行域读层解密）。
   */
  codec?: ZoneCodecLike;
  /**
   * 严格形态（复核 B3-A18；第 2 步）：存量明文已在引擎打开前迁移，此后本区出现的非空明文文件只可能来自外部写入或漏网的写盘路径——
   * 读取一律拒绝（EIO），不当作可信内容；覆盖写入照常（写回即加密）。未给出 = 兼容形态（明文原样读出）。
   */
  strict?: boolean;
  /**
   * 只接受分块格式（复核 S3B-A04）：工作区与材料快照只由 broker 与宿主以分块格式写入；追加日志格式（引擎状态区才用）在这两区
   * 一律拒读——否则无需密钥就能伪造一个“只有头的空日志”被所有读者当成空文件。
   */
  chunkedOnly?: boolean;
}

/** 区级编解码器（结构类型，与 @zr-legal/at-rest 的 ZoneCodec 一致）。 */
export interface ZoneCodecLike {
  seal(plain: Uint8Array): Buffer;
  open(disk: Uint8Array): Buffer;
  plainSize(disk: Uint8Array): number;
  /** 分块格式的随机读（可选；没有时整文件解封后取区间）。 */
  openChunks?(header: Uint8Array, first: number, total: number, boxed: Uint8Array): Buffer;
}

const KWE1 = Buffer.from("KWE1", "ascii");
function sealedBytes(b: Uint8Array): boolean {
  return b.length >= 64 && Buffer.from(b.buffer, b.byteOffset, 4).equals(KWE1);
}

export interface Located {
  zone: ZoneSpec;
  /** 区域内相对分量。 */
  rel: string[];
  /** 用于实际文件系统调用的绝对路径（以区域根的真实路径为基）。 */
  real: string;
  /** 返回给调用方的规范路径（以调用方使用的根表示为基）。 */
  display: string;
}

export interface BrokerStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  /** 内容长度（加密区为明文长度）。 */
  size: number;
  /** 盘上长度（加密区为密文长度；未加密区同 size）。比较—替换的期望状态（ExpectedState）一律用盘上长度。 */
  diskSize: number;
  mtimeMs: number;
  ino: number;
}

export class BrokerError extends Error {
  readonly code: string;
  /** 比较不符而移回时，原路径已被占用：对象改放到的可见路径（恢复副本；第二轮复核 7.3 残余）。 */
  recoveredAt?: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "BrokerError";
    this.code = code;
  }
}

const enoent = (p: string) => new BrokerError("ENOENT", `no such file or directory (file broker): ${p}`);
const eperm = (p: string) => new BrokerError("EPERM", `operation not permitted (file broker): ${p}`);
const eloop = (p: string) => new BrokerError("ELOOP", `symbolic link, junction, reparse point or concurrent replacement rejected (file broker): ${p}`);
const emlink = (p: string) => new BrokerError("EMLINK", `hard-linked file rejected (file broker): ${p}`);
const econflict = (p: string) => new BrokerError("ECONFLICT", `target changed since it was examined (file broker): ${p}`);

/** 写入时调用方期望的目标状态（审查 S3-03：比较—替换）：对象身份 + **盘上**大小 + 修改时间；"absent" = 目标必须不存在。 */
export type ExpectedState = { ino: number; size: number; mtimeMs: number } | "absent";

/** 恢复副本名：`名称（恢复副本 YYYYMMDD-HHMMSS[-n]）.扩展名`。 */
function recoveryName(name: string, d: Date, n: number): string {
  const p = (x: number) => String(x).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  return `${stem}（恢复副本 ${stamp}${n > 1 ? `-${n}` : ""}）${ext}`;
}

function matchesExpected(st: Stats | null, expect: ExpectedState): boolean {
  if (expect === "absent") return st === null;
  return st !== null && st.isFile() && Number(st.ino) === expect.ino && Number(st.size) === expect.size && Number(st.mtimeMs) === expect.mtimeMs;
}


interface RootRepr {
  spec: ZoneSpec;
  /** 调用方使用的根表示（可能含平台符号链接，如 macOS /var → /private/var）。 */
  given: { root: string; parts: string[] };
  /** 根的真实路径（构造时一次性解析；根本身由可信配置决定）。 */
  real: { root: string; parts: string[] };
  realPath: string;
}

interface Identity {
  dev: number;
  ino: number;
}

const O_NOFOLLOW = (FS as Record<string, number>).O_NOFOLLOW ?? 0;

/** 读取 fh 的 [pos, pos + len) 字节（读到文件尾为止）。 */
async function readAt(fh: FileHandle, pos: number, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(Math.max(0, len));
  let read = 0;
  while (read < buf.length) {
    const r = await fh.read(buf, read, buf.length - read, pos + read);
    if (r.bytesRead === 0) break;
    read += r.bytesRead;
  }
  return buf.subarray(0, read);
}

const eio = (p: string, why: string) => new BrokerError("EIO", `${why} (file broker): ${p}`);

/**
 * Windows 上杀软、索引器、备份软件常在 rename/link/unlink 前后短暂持有句柄（EPERM/EBUSY/EACCES）：有界重试（5 次，20–200 ms 退避；
 * 设计 §5.2 2-10）。身份复核不变——重试的只是同一个系统调用。其他平台原样执行。
 */
export async function retryWin<T>(fn: () => Promise<T>): Promise<T> {
  if (process.platform !== "win32") return fn();
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 4 || !(code === "EPERM" || code === "EBUSY" || code === "EACCES")) throw e;
      await new Promise((r) => setTimeout(r, Math.min(200, 20 * 2 ** i)));
    }
  }
}
/** 保留名前缀：回收目录与临时文件；对 Agent 不可见、不可寻址。 */
export const RESERVED_PREFIX = ".kwl-";

export interface FileBrokerOptions {
  flavor?: PathFlavor;
  /**
   * 可写区域内对 Agent 只读的文件（绝对路径，构造时必须已存在）：按对象身份 (dev, ino) 保护，
   * 例如引擎只能从 homeDir 读取的 config.toml / mcp.json（上游约束）。
   */
  readOnlyFiles?: readonly string[];
}

function sameIdentity(a: Identity, b: { dev: number | bigint; ino: number | bigint }): boolean {
  return a.dev === Number(b.dev) && a.ino === Number(b.ino);
}

export class FileBroker {
  private readonly roots: RootRepr[];
  private readonly flavor: PathFlavor;
  /** 受保护对象身份。 */
  private readonly protectedIds: Identity[] = [];
  /** 受保护对象在区域内的祖先目录身份（删除这些目录等于删除受保护对象）。 */
  private readonly protectedAncestors: Identity[] = [];
  /** 写入临界区（审查 S3-03）：执行域的整批提交与引擎经 IHostFileSystem 的写入互斥，冲突判定与写入之间不再被插入。 */
  private exclusiveTail: Promise<void> = Promise.resolve();

  constructor(zones: readonly ZoneSpec[], opts: FileBrokerOptions = {}) {
    this.flavor = opts.flavor ?? currentFlavor();
    this.roots = zones.map((spec) => {
      const given = splitAbsolute(spec.root, this.flavor);
      let realPath: string;
      try {
        realPath = realpathSync.native(spec.root);
      } catch {
        realPath = spec.root; // 根尚不存在（调用方稍后创建）：按给定表示
      }
      return { spec, given, real: splitAbsolute(realPath, this.flavor), realPath };
    });
    // 区域不得互相包含（否则同一文件会有两种权限）
    for (const a of this.roots) {
      for (const b of this.roots) {
        if (a === b) continue;
        const contains = [a.given, a.real].some((ra) => [b.given, b.real].some((rb) => relativeUnder(ra, rb, this.flavor) !== null));
        if (contains) throw new Error(`文件 broker 区域重叠：${b.spec.name} 位于 ${a.spec.name} 之内`);
      }
    }
    for (const f of opts.readOnlyFiles ?? []) {
      const loc = this.locate(f);
      if (!loc || loc.rel.length === 0) throw new Error(`只读文件不在任何区域内：${f}`);
      const st = lstatSync(loc.real);
      if (!st.isFile() || st.isSymbolicLink()) throw new Error(`只读文件必须是已存在的普通文件：${f}`);
      this.protectedIds.push({ dev: st.dev, ino: st.ino });
      const root = this.rootOf(loc);
      const rootSt = lstatSync(root.realPath);
      this.protectedAncestors.push({ dev: rootSt.dev, ino: rootSt.ino });
      for (let i = 1; i < loc.rel.length; i++) {
        const a = lstatSync(this.join(root.real, loc.rel.slice(0, i)));
        this.protectedAncestors.push({ dev: a.dev, ino: a.ino });
      }
    }
  }

  zones(): ZoneSpec[] {
    return this.roots.map((r) => r.spec);
  }

  /**
   * 在写入临界区内执行 fn（FIFO，不可重入）。执行域提交整批改动时持有它；`asHostFileSystem()` 暴露给引擎的写类方法
   * （Write/Edit、计划文件、会话状态）也经它排队——同一 broker 的“判定—写入”不会被另一个写入者插进来。
   * fn 内只能调用 broker 的核心方法，不得再调 `asHostFileSystem()` 的写类方法（会死锁）。
   */
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.exclusiveTail;
    let release!: () => void;
    this.exclusiveTail = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private join(root: { root: string; parts: string[] }, parts: string[]): string {
    if (this.flavor === "win32") return `${root.root}\\${[...root.parts, ...parts].join("\\")}`;
    return `/${[...root.parts, ...parts].join("/")}`;
  }

  /** 定位绝对宿主路径所属区域；不属于任何区域、或寻址保留名时返回 null。 */
  locate(absPath: string): Located | null {
    let target: { root: string; parts: string[] };
    try {
      target = splitAbsolute(absPath, this.flavor);
    } catch {
      return null;
    }
    for (const r of this.roots) {
      for (const base of [r.given, r.real]) {
        const rel = relativeUnder(base, target, this.flavor);
        if (rel !== null) {
          if (rel.some((c) => c.toLowerCase().startsWith(RESERVED_PREFIX))) return null;
          const loc = { zone: r.spec, rel, real: this.join(r.real, rel), display: this.join(base, rel) };
          return this.withinOsLimits(loc) ? loc : null;
        }
      }
    }
    return null;
  }

  /** 按区域名 + 区域内相对路径定位（业务 API 与执行域提交使用）。 */
  locateIn(zoneName: string, relPath: string): Located {
    const r = this.roots.find((x) => x.spec.name === zoneName);
    if (!r) throw new BrokerError("ENOENT", `unknown zone ${zoneName}`);
    const rel = splitRelative(relPath, this.flavor);
    if (rel.some((c) => c.toLowerCase().startsWith(RESERVED_PREFIX))) throw enoent(relPath);
    const loc = { zone: r.spec, rel, real: this.join(r.real, rel), display: this.join(r.given, rel) };
    if (!this.withinOsLimits(loc)) throw new BrokerError("ENAMETOOLONG", `path exceeds the operating system limit (file broker): ${relPath.slice(0, 120)}…`);
    return loc;
  }

  /** 实际系统调用用的路径（真实根 + 分量）不得超过操作系统上限（POSIX 按字节；Windows 由 splitAbsolute 按 MAX_PATH 判定）。 */
  private withinOsLimits(loc: Located): boolean {
    if (this.flavor === "win32") return loc.real.length <= 259;
    // 临时文件名（.kwl-tmp-<16 hex>，26 字节）放在同一父目录：给它留出余量
    return Buffer.byteLength(loc.real, "utf8") + 32 <= maxPathBytes() && Buffer.byteLength(loc.display, "utf8") <= maxPathBytes();
  }

  private rootOf(loc: Located): RootRepr {
    return this.roots.find((r) => r.spec === loc.zone)!;
  }

  /**
   * 区域外与语法不合法（UNC、保留名……）的路径一律按“不存在”处理（引擎的 pathExists 探测特判 ENOENT），
   * 不暴露原因细节；只读区域内的写入为 EPERM。
   */
  private locateOrThrow(absPath: string, forWrite: boolean): Located {
    const loc = this.locate(absPath);
    if (!loc) throw enoent(absPath);
    if (forWrite && loc.zone.access !== "rw") throw eperm(absPath);
    return loc;
  }

  private isProtected(st: { dev: number | bigint; ino: number | bigint }): boolean {
    return this.protectedIds.some((p) => sameIdentity(p, st));
  }

  private isProtectedAncestor(st: { dev: number | bigint; ino: number | bigint }): boolean {
    return this.protectedAncestors.some((p) => sameIdentity(p, st));
  }

  private parentPath(loc: Located): string {
    const root = this.rootOf(loc);
    return loc.rel.length <= 1 ? root.realPath : this.join(root.real, loc.rel.slice(0, -1));
  }

  /**
   * 逐级 lstat：区域根以下（不含最后一级）每一级必须是真实目录。返回各级 inode（供复核），以及最后一级的 lstat（不存在为 null）。
   */
  private async walk(loc: Located): Promise<{ chain: { path: string; id: Identity }[]; leaf: Stats | null }> {
    const root = this.rootOf(loc);
    const chain: { path: string; id: Identity }[] = [];
    const rootSt = await lstat(root.realPath).catch(() => null);
    if (!rootSt) throw enoent(loc.display);
    if (rootSt.isSymbolicLink() || !rootSt.isDirectory()) throw eloop(loc.display);
    chain.push({ path: root.realPath, id: { dev: rootSt.dev, ino: rootSt.ino } });
    for (let i = 0; i < loc.rel.length - 1; i++) {
      const p = this.join(root.real, loc.rel.slice(0, i + 1));
      const st = await lstat(p).catch(() => null);
      if (!st) throw enoent(loc.display);
      if (st.isSymbolicLink()) throw eloop(loc.display);
      if (!st.isDirectory()) throw new BrokerError("ENOTDIR", `not a directory (file broker): ${loc.display}`);
      chain.push({ path: p, id: { dev: st.dev, ino: st.ino } });
    }
    if (loc.rel.length === 0) return { chain: chain.slice(0, -1), leaf: rootSt };
    const leaf = await lstat(loc.real).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT" || e.code === "ENOTDIR") return null;
      throw e;
    });
    if (leaf?.isSymbolicLink()) throw eloop(loc.display);
    return { chain, leaf };
  }

  /** 复核父级链：每一级仍是同一个真实目录。 */
  private async recheckChain(loc: Located, chain: { path: string; id: Identity }[]): Promise<void> {
    for (const c of chain) {
      const st = await lstat(c.path).catch(() => null);
      if (!st || st.isSymbolicLink() || !sameIdentity(c.id, st)) throw eloop(loc.display);
    }
  }

  private tmpName(): string {
    return `${RESERVED_PREFIX}tmp-${randomBytes(8).toString("hex")}`;
  }

  /** 在已校验的父目录内建临时文件并写入；返回临时路径与身份。调用方负责 rename/link 或清理。durable=false 时不 fsync（只用于新建文件）。 */
  private async writeTemp(loc: Located, chain: { path: string; id: Identity }[], plain: Uint8Array, durable = true): Promise<{ tmp: string; id: Identity }> {
    const data = loc.zone.codec ? loc.zone.codec.seal(plain) : plain;
    const parent = this.parentPath(loc);
    const tmp = this.flavor === "win32" ? `${parent}\\${this.tmpName()}` : `${parent}/${this.tmpName()}`;
    let fh: FileHandle;
    try {
      fh = await open(tmp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | O_NOFOLLOW, 0o644);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") throw enoent(loc.display);
      throw e;
    }
    let id: Identity;
    try {
      await fh.writeFile(data);
      if (durable) await fh.sync();
      const st = await fh.stat();
      id = { dev: st.dev, ino: st.ino };
      if (!st.isFile() || st.nlink !== 1) throw eloop(loc.display);
    } catch (e) {
      await fh.close().catch(() => {});
      await unlink(tmp).catch(() => {});
      throw e;
    }
    await fh.close();
    try {
      await this.recheckChain(loc, chain);
      const tst = await lstat(tmp);
      if (tst.isSymbolicLink() || !sameIdentity(id, tst)) throw eloop(loc.display);
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
    return { tmp, id };
  }

  private async openForRead(absPath: string): Promise<{ fh: FileHandle; loc: Located }> {
    const loc = this.locateOrThrow(absPath, false);
    if (loc.rel.length === 0) throw new BrokerError("EISDIR", `is a directory: ${absPath}`);
    const { chain, leaf } = await this.walk(loc);
    if (!leaf) throw enoent(loc.display);
    if (leaf.isDirectory()) throw new BrokerError("EISDIR", `is a directory (file broker): ${loc.display}`);
    if (!leaf.isFile()) throw eperm(loc.display);
    // 区域内文件都由 broker 创建（nlink=1）；硬链接意味着同一 inode 还挂在别处，读它等于越界读
    if (leaf.nlink > 1) throw emlink(loc.display);
    let fh: FileHandle;
    try {
      fh = await open(loc.real, FS.O_RDONLY | O_NOFOLLOW);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ELOOP" || code === "EMLINK") throw eloop(loc.display);
      if (code === "ENOENT") throw enoent(loc.display);
      throw e;
    }
    try {
      await this.recheckChain(loc, chain);
      const [fst, lst] = await Promise.all([fh.stat(), lstat(loc.real).catch(() => null)]);
      if (!lst || lst.isSymbolicLink() || lst.ino !== fst.ino || lst.dev !== fst.dev || !fst.isFile()) throw eloop(loc.display);
      if (fst.nlink > 1) throw emlink(loc.display);
    } catch (e) {
      await fh.close().catch(() => {});
      throw e;
    }
    return { fh, loc };
  }

  // ─── IHostFileSystem 形状（Kimi Code 引擎经种子注入；agent-host 与 kap-host 共用） ───

  async readBytes(absPath: string, n?: number, offset?: number): Promise<Uint8Array> {
    const { fh, loc } = await this.openForRead(absPath);
    if (loc.zone.codec) {
      try {
        return await this.readSealed(fh, loc, n, offset);
      } finally {
        await fh.close();
      }
    }
    try {
      const st = await fh.stat();
      const start = Math.max(0, offset ?? 0);
      const end = n === undefined ? st.size : Math.min(st.size, start + n);
      const len = Math.max(0, end - start);
      const buf = Buffer.alloc(len);
      let read = 0;
      while (read < len) {
        const r = await fh.read(buf, read, len - read, start + read);
        if (r.bytesRead === 0) break;
        read += r.bytesRead;
      }
      return new Uint8Array(buf.subarray(0, read));
    } finally {
      await fh.close();
    }
  }

  /**
   * 加密区读取：分块格式按明文区间只读、只解所需分块（区间不含末块时另认证末块：截断不会被当成“文件更短”）；追加日志格式整读；
   * 明文旧文件在兼容形态原样读出，严格形态拒绝（复核 B3-A18）。
   */
  private async readSealed(fh: FileHandle, loc: Located, n: number | undefined, offset: number | undefined): Promise<Uint8Array> {
    const codec = loc.zone.codec!;
    const size = Number((await fh.stat()).size);
    const head = await readAt(fh, 0, Math.min(HEADER_BYTES, size));
    const start = Math.max(0, offset ?? 0);
    if (!sealedBytes(head)) {
      if (loc.zone.strict && size > 0) throw eio(loc.display, "file in an encrypted zone is not encrypted (refused)");
      const end = n === undefined ? size : Math.min(size, start + n);
      return new Uint8Array(await readAt(fh, start, Math.max(0, end - start)));
    }
    if (!isChunkedHeader(head) && loc.zone.chunkedOnly) throw eio(loc.display, "file in this encrypted zone has an unexpected format (refused)");
    const whole = n === undefined && start === 0;
    if (!isChunkedHeader(head) || !codec.openChunks || whole) {
      const plain = codec.open(await readAt(fh, 0, size));
      const end = n === undefined ? plain.length : Math.min(plain.length, start + n);
      return new Uint8Array(plain.subarray(Math.min(start, plain.length), Math.max(Math.min(start, plain.length), end)));
    }
    // 结构校验 + 末块认证（复核 S3B-A03）：截断（含只剩文件头）报“分块残缺”；区间不含末块时另认证第 total−1 块
    const span = chunkSpan(size, start, n === undefined ? Number.MAX_SAFE_INTEGER : start + n);
    if (span.count === 0 || span.first + span.count < span.total) {
      const tail = lastChunkSpan(size);
      codec.openChunks(head, tail.index, tail.total, await readAt(fh, tail.diskStart, tail.diskEnd - tail.diskStart));
    }
    if (span.count === 0) return new Uint8Array(0);
    const plain = codec.openChunks(head, span.first, span.total, await readAt(fh, span.diskStart, span.diskEnd - span.diskStart));
    const from = start - span.first * CHUNK_BYTES;
    const limit = Math.min(plain.length, span.plainSize - span.first * CHUNK_BYTES);
    const end = n === undefined ? limit : Math.min(limit, from + n);
    return new Uint8Array(plain.subarray(from, Math.max(from, end)));
  }

  async readText(absPath: string): Promise<string> {
    return Buffer.from(await this.readBytes(absPath)).toString("utf8");
  }

  async *readLines(absPath: string): AsyncGenerator<string> {
    const text = await this.readText(absPath);
    for (const line of text.split(/\r?\n/)) yield line;
  }

  /**
   * 写：临时文件 + 复核 + rename 原子替换；目标若是受保护对象（任何别名）即 EPERM。
   * `durable: false`（执行域批量提交用）：目标原本不存在时跳过 fsync——崩溃只会丢失新产物，不会截断已有文件；
   * 目标已存在时一律 fsync 后再 rename。
   */
  async writeBytes(absPath: string, data: Uint8Array, opts: { durable?: boolean; expect?: ExpectedState } = {}): Promise<void> {
    const loc = this.locateOrThrow(absPath, true);
    if (loc.rel.length === 0) throw eperm(absPath);
    const { chain, leaf } = await this.walk(loc);
    if (leaf) {
      if (this.isProtected(leaf)) throw eperm(loc.display);
      if (!leaf.isFile()) throw eperm(loc.display);
    }
    if (opts.expect && !matchesExpected(leaf, opts.expect)) throw econflict(loc.display);
    const { tmp, id } = await this.writeTemp(loc, chain, data, opts.durable !== false || leaf !== null);
    try {
      // rename 前最后复核：目标若在此期间变成受保护对象的别名（或目录），拒绝；调用方给出期望身份时，盘上状态不符即冲突（审查 S3-03）
      const now = await lstat(loc.real).catch(() => null);
      if (now && (this.isProtected(now) || !now.isFile() || now.isSymbolicLink())) throw eperm(loc.display);
      if (opts.expect && !matchesExpected(now, opts.expect)) throw econflict(loc.display);
      await retryWin(() => rename(tmp, loc.real));
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
    const after = await lstat(loc.real).catch(() => null);
    if (!after || !sameIdentity(id, after)) throw eloop(loc.display);
  }

  async writeText(absPath: string, data: string): Promise<void> {
    await this.writeBytes(absPath, Buffer.from(data, "utf8"));
  }

  /** 追加：既有文件以 O_APPEND（不建、不截断）打开，复核身份后才写；不存在则走“临时文件 + rename”新建。 */
  async appendText(absPath: string, data: string): Promise<void> {
    const loc = this.locateOrThrow(absPath, true);
    if (loc.rel.length === 0) throw eperm(absPath);
    const { chain, leaf } = await this.walk(loc);
    if (!leaf) {
      await this.writeBytes(absPath, Buffer.from(data, "utf8"));
      return;
    }
    if (this.isProtected(leaf)) throw eperm(loc.display);
    if (!leaf.isFile()) throw eperm(loc.display);
    if (leaf.nlink > 1) throw emlink(loc.display);
    if (loc.zone.codec) {
      // 加密区：读出明文、拼接、整文件重写（原子替换；以读到的盘上身份作比较—替换，期间被改动即冲突）
      const before = await this.readBytes(absPath);
      await this.writeBytes(absPath, Buffer.concat([before, Buffer.from(data, "utf8")]), { expect: { ino: Number(leaf.ino), size: Number(leaf.size), mtimeMs: Number(leaf.mtimeMs) } });
      return;
    }
    let fh: FileHandle;
    try {
      fh = await open(loc.real, FS.O_WRONLY | FS.O_APPEND | O_NOFOLLOW);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ELOOP") throw eloop(loc.display);
      if (code === "ENOENT") throw enoent(loc.display);
      throw e;
    }
    try {
      await this.recheckChain(loc, chain);
      const [fst, lst] = await Promise.all([fh.stat(), lstat(loc.real).catch(() => null)]);
      if (!lst || lst.isSymbolicLink() || lst.ino !== fst.ino || lst.dev !== fst.dev) throw eloop(loc.display);
      if (this.isProtected(fst)) throw eperm(loc.display);
      if (fst.nlink > 1) throw emlink(loc.display);
      await fh.appendFile(data, "utf8");
    } finally {
      await fh.close();
    }
  }

  /** 独占创建：临时文件 + link(tmp, target)（目标已存在即 EEXIST → false）。 */
  async createExclusive(absPath: string, data: Uint8Array): Promise<boolean> {
    const loc = this.locateOrThrow(absPath, true);
    if (loc.rel.length === 0) throw eperm(absPath);
    const { chain, leaf } = await this.walk(loc);
    if (leaf) return false;
    const { tmp, id } = await this.writeTemp(loc, chain, data);
    try {
      await retryWin(() => link(tmp, loc.real));
    } catch (e) {
      await unlink(tmp).catch(() => {});
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
    await unlink(tmp).catch(() => {});
    const after = await lstat(loc.real).catch(() => null);
    if (!after || !sameIdentity(id, after)) throw eloop(loc.display);
    return true;
  }

  /**
   * 大小写/Unicode 别名更名（审查 S3-13：`mv draft.md DRAFT.md` 在大小写不敏感的卷上）：两个路径必须在同一区域、同一父目录，
   * 名字在折叠后相等，且盘上是**同一个对象**（大小写不敏感的卷上两种写法指向同一目录项）。只改目录项的写法，不动内容。
   */
  async renameAlias(fromAbs: string, toAbs: string): Promise<void> {
    const a = this.locateOrThrow(fromAbs, true);
    const b = this.locateOrThrow(toAbs, true);
    if (a.zone !== b.zone || a.rel.length === 0 || a.rel.length !== b.rel.length) throw eperm(b.display);
    if (a.rel.slice(0, -1).join("\u0000") !== b.rel.slice(0, -1).join("\u0000")) throw eperm(b.display);
    if (foldName(a.rel.at(-1)!) !== foldName(b.rel.at(-1)!)) throw eperm(b.display);
    const { chain, leaf } = await this.walk(a);
    if (!leaf || !leaf.isFile() || this.isProtected(leaf)) throw eperm(a.display);
    const other = await lstat(b.real).catch(() => null);
    if (!other || !sameIdentity({ dev: Number(leaf.dev), ino: Number(leaf.ino) }, other)) throw econflict(b.display);
    await this.recheckChain(a, chain);
    await retryWin(() => rename(a.real, b.real));
    const after = await lstat(b.real).catch(() => null);
    if (!after || !sameIdentity({ dev: Number(leaf.dev), ino: Number(leaf.ino) }, after)) throw eloop(b.display);
  }

  private toStat(st: Stats): BrokerStat {
    return {
      isFile: st.isFile(),
      isDirectory: st.isDirectory(),
      isSymbolicLink: st.isSymbolicLink(),
      size: Number(st.size),
      diskSize: Number(st.size),
      mtimeMs: Number(st.mtimeMs),
      ino: Number(st.ino),
    };
  }

  /** stat：不跟随链接——路径上或终点是链接即 ELOOP（区域内本就不允许链接）。 */
  async stat(absPath: string): Promise<BrokerStat> {
    const loc = this.locateOrThrow(absPath, false);
    const { leaf } = await this.walk(loc);
    if (!leaf) throw enoent(loc.display);
    return this.plainStat(loc, this.toStat(leaf));
  }

  /**
   * 加密区的文件报告明文长度：分块格式只读 64 字节文件头、按盘上长度闭式算出；追加日志格式扫描记录头；明文旧文件报告盘上长度。
   * 读不了时报告盘上长度（读取本身会如实报错）。diskSize 始终是盘上长度。
   */
  private async plainStat(loc: Located, st: BrokerStat): Promise<BrokerStat> {
    if (!loc.zone.codec || !st.isFile || st.isSymbolicLink) return st;
    try {
      const fh = await open(loc.real, FS.O_RDONLY | O_NOFOLLOW);
      try {
        const size = Number((await fh.stat()).size);
        const head = await readAt(fh, 0, Math.min(HEADER_BYTES, size));
        if (!sealedBytes(head)) return { ...st, size, diskSize: size };
        // 结构不合法（被截断）的分块文件：报告盘上长度（读取会如实报错），不报一个推算出来的“更短”的长度
        if (isChunkedHeader(head)) return { ...st, size: isValidChunkedSize(size) ? plainSizeOf(size) : size, diskSize: size };
        if (loc.zone.chunkedOnly) return { ...st, size, diskSize: size };
        return { ...st, size: loc.zone.codec.plainSize(await readAt(fh, 0, size)), diskSize: size };
      } finally {
        await fh.close();
      }
    } catch {
      return st;
    }
  }

  /** lstat：终点是链接时如实报告 isSymbolicLink（可见、不可跟随）；路径中间有链接仍拒绝。 */
  async lstat(absPath: string): Promise<BrokerStat> {
    const loc = this.locateOrThrow(absPath, false);
    const root = this.rootOf(loc);
    if (loc.rel.length > 1) {
      const parent: Located = { ...loc, rel: loc.rel.slice(0, -1), real: this.join(root.real, loc.rel.slice(0, -1)) };
      const { leaf } = await this.walk(parent);
      if (!leaf || !leaf.isDirectory()) throw enoent(loc.display);
    }
    const st = await lstat(loc.real).catch(() => null);
    if (!st) throw enoent(loc.display);
    return this.plainStat(loc, this.toStat(st));
  }

  async readdir(absPath: string): Promise<{ name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }[]> {
    const loc = this.locateOrThrow(absPath, false);
    const { leaf } = await this.walk(loc);
    if (!leaf) throw enoent(loc.display);
    if (!leaf.isDirectory()) throw new BrokerError("ENOTDIR", `not a directory (file broker): ${loc.display}`);
    const entries = await readdir(loc.real, { withFileTypes: true });
    return entries
      .filter((e) => !e.name.toLowerCase().startsWith(RESERVED_PREFIX))
      .map((e) => ({ name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory(), isSymbolicLink: e.isSymbolicLink() }));
  }

  /** 建目录：逐级创建；创建后核对新目录的 `..` 正是校验过的父目录（防父级被替换），否则删除并拒绝。 */
  async mkdir(absPath: string, options?: { readonly recursive?: boolean }): Promise<void> {
    const loc = this.locateOrThrow(absPath, true);
    if (loc.rel.length === 0) return; // 区域根已存在由宿主负责
    const root = this.rootOf(loc);
    const rootSt = await lstat(root.realPath).catch(() => null);
    if (!rootSt || rootSt.isSymbolicLink() || !rootSt.isDirectory()) throw eloop(loc.display);
    let parentId: Identity = { dev: rootSt.dev, ino: rootSt.ino };
    for (let i = 0; i < loc.rel.length; i++) {
      const p = this.join(root.real, loc.rel.slice(0, i + 1));
      const st = await lstat(p).catch(() => null);
      const isLast = i === loc.rel.length - 1;
      if (st) {
        if (st.isSymbolicLink()) throw eloop(loc.display);
        if (!st.isDirectory()) throw new BrokerError("ENOTDIR", `not a directory (file broker): ${loc.display}`);
        if (isLast && !options?.recursive) throw new BrokerError("EEXIST", `file exists (file broker): ${loc.display}`);
        parentId = { dev: st.dev, ino: st.ino };
        continue;
      }
      if (!isLast && !options?.recursive) throw enoent(loc.display);
      let created = false;
      await mkdir(p).then(
        () => {
          created = true;
        },
        (e: NodeJS.ErrnoException) => {
          if (e.code !== "EEXIST") throw e;
        },
      );
      const after = await lstat(p);
      const dotdot = await lstat(this.flavor === "win32" ? `${p}\\..` : `${p}/..`).catch(() => null);
      if (after.isSymbolicLink() || !after.isDirectory() || !dotdot || !sameIdentity(parentId, dotdot)) {
        if (created) await rmdir(p).catch(() => {});
        throw eloop(loc.display);
      }
      parentId = { dev: after.dev, ino: after.ino };
    }
  }

  /**
   * 删除：先 rename 进区域内回收目录，核对移入对象的身份与校验时一致（不一致即移回并拒绝），再递归删除。
   * 受保护对象本身、或其任一祖先目录，一律 EPERM。不存在时为空操作（与 rm force 语义一致）。
   * `expect`（复核 S3-17：删除的比较—替换）：只有移入回收目录的对象与期望身份（ino、大小、修改时间）一致才删除；
   * 不符即移回原处并报 ECONFLICT——rename 之后再比较，路径上的保存（Word 安全保存、原地覆盖）都无法插进来。
   */
  async remove(absPath: string, opts: { expect?: ExpectedState } = {}): Promise<void> {
    const loc = this.locateOrThrow(absPath, true);
    if (loc.rel.length === 0) throw eperm(absPath); // 不允许删除区域根
    const { chain, leaf } = await this.walk(loc);
    if (!leaf) {
      if (opts.expect && opts.expect !== "absent") throw econflict(loc.display);
      return;
    }
    if (this.isProtected(leaf) || (leaf.isDirectory() && this.isProtectedAncestor(leaf))) throw eperm(loc.display);
    if (opts.expect && !matchesExpected(leaf, opts.expect)) throw econflict(loc.display);
    const dest = await this.moveToReserved(loc, chain, leaf, "trash");
    if (opts.expect) {
      const moved = await lstat(dest).catch(() => null);
      if (!matchesExpected(moved, opts.expect)) {
        const err = econflict(loc.display);
        const at = await this.putBack(dest, loc).catch(() => dest);
        if (at) err.recoveredAt = at;
        throw err;
      }
    }
    await rm(dest, { recursive: true, force: true });
  }

  /** 把对象 rename 进区域根下的保留目录（`.kwl-trash` / `.kwl-stage`），核对移入的仍是 walk 到的那个对象。返回移入后的路径。 */
  private async moveToReserved(loc: Located, chain: { path: string; id: Identity }[], leaf: Stats, area: "trash" | "stage"): Promise<string> {
    const dir = await this.reservedDir(loc, area);
    await this.recheckChain(loc, chain);
    const dest = this.flavor === "win32" ? `${dir}\\${randomBytes(8).toString("hex")}` : `${dir}/${randomBytes(8).toString("hex")}`;
    await retryWin(() => rename(loc.real, dest));
    const moved = await lstat(dest).catch(() => null);
    if (!moved || moved.dev !== leaf.dev || moved.ino !== leaf.ino) {
      // walk 之后、rename 之前路径上换成了别的对象（例如安全保存的新版本）：不覆盖地放回，按“目标已变”报告（第二轮复核 E2）
      if (!moved) throw econflict(loc.display);
      if (moved.isSymbolicLink()) {
        // 区外放进来的链接：只删链接本身（不触及其指向），不放回
        await unlink(dest).catch(() => {});
        throw eloop(loc.display);
      }
      const err = econflict(loc.display);
      const at = await this.putBack(dest, loc).catch(() => dest);
      if (at) err.recoveredAt = at;
      throw err;
    }
    return dest;
  }

  private async reservedDir(loc: Located, area: "trash" | "stage"): Promise<string> {
    const root = this.rootOf(loc);
    const dir = this.flavor === "win32" ? `${root.realPath}\\${RESERVED_PREFIX}${area}` : `${root.realPath}/${RESERVED_PREFIX}${area}`;
    await mkdir(dir).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "EEXIST") throw e;
    });
    const tst = await lstat(dir);
    if (tst.isSymbolicLink() || !tst.isDirectory()) throw eloop(loc.display);
    return dir;
  }

  /**
   * 不覆盖地把保留区里的对象放回 loc（第二轮复核 7.3：移回不得覆盖期间新保存的文件）：文件用 link + unlink（目标已存在即失败），
   * 目录只在目标不存在时 rename。原路径已被占用 → 改放到同一目录下的可见恢复副本（`名称（恢复副本 时间）.扩展名`），返回其显示路径；
   * 放回原处返回 null；两处都放不下则留在保留区并返回保留区路径（内容不丢）。
   */
  private async putBack(fromReal: string, loc: Located): Promise<string | null> {
    if (await this.placeNoClobber(fromReal, loc.real)) return null;
    const parentDisplay = loc.display.slice(0, loc.display.length - loc.rel[loc.rel.length - 1]!.length);
    const parentReal = loc.real.slice(0, loc.real.length - loc.rel[loc.rel.length - 1]!.length);
    const name = loc.rel[loc.rel.length - 1]!;
    for (let n = 1; n <= 20; n++) {
      const alt = recoveryName(name, new Date(), n);
      if (await this.placeNoClobber(fromReal, `${parentReal}${alt}`)) return `${parentDisplay}${alt}`;
    }
    return fromReal;
  }

  /** 不覆盖地移动（文件：link + unlink；目录：目标不存在时 rename）。目标已存在返回 false；其他错误抛出。 */
  private async placeNoClobber(fromReal: string, toReal: string): Promise<boolean> {
    const st = await lstat(fromReal);
    if (st.isSymbolicLink()) throw eloop(toReal);
    if (st.isFile()) {
      try {
        await retryWin(() => link(fromReal, toReal));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw e;
      }
      await retryWin(() => unlink(fromReal));
      return true;
    }
    const there = await lstat(toReal).catch(() => null);
    if (there) return false;
    await retryWin(() => rename(fromReal, toReal));
    return true;
  }

  /** 删除空目录（rmdir：目录里有任何内容即 ENOTEMPTY，原子判定——不会连带删掉运行期间新出现的文件；复核 S3-17）。 */
  async removeEmptyDir(absPath: string): Promise<void> {
    const loc = this.locateOrThrow(absPath, true);
    if (loc.rel.length === 0) throw eperm(absPath);
    const { chain, leaf } = await this.walk(loc);
    if (!leaf) return;
    if (!leaf.isDirectory()) throw new BrokerError("ENOTDIR", `not a directory (file broker): ${loc.display}`);
    if (this.isProtectedAncestor(leaf)) throw eperm(loc.display);
    await this.recheckChain(loc, chain);
    try {
      await rmdir(loc.real);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOTEMPTY" || code === "EEXIST") throw new BrokerError("ENOTEMPTY", `directory not empty (file broker): ${loc.display}`);
      throw e;
    }
  }

  /**
   * 暂存（复核 S3-19：类型变化先暂存后删除）：把对象 rename 进区域内 `.kwl-stage`（核对期望身份），返回暂存句柄；
   * 新内容全部写成后 `discardStaged` 删除，任何失败 `restoreStaged` 移回原处（原处须已不存在）。
   */
  async stageAside(absPath: string, opts: { expect?: ExpectedState } = {}): Promise<{ staged: string; display: string }> {
    const loc = this.locateOrThrow(absPath, true);
    if (loc.rel.length === 0) throw eperm(absPath);
    const { chain, leaf } = await this.walk(loc);
    if (!leaf) throw enoent(loc.display);
    if (this.isProtected(leaf) || (leaf.isDirectory() && this.isProtectedAncestor(leaf))) throw eperm(loc.display);
    if (opts.expect && !matchesExpected(leaf, opts.expect)) throw econflict(loc.display);
    const staged = await this.moveToReserved(loc, chain, leaf, "stage");
    if (opts.expect) {
      const moved = await lstat(staged).catch(() => null);
      if (!matchesExpected(moved, opts.expect)) {
        const err = econflict(loc.display);
        const at = await this.putBack(staged, loc).catch(() => staged);
        if (at) err.recoveredAt = at;
        throw err;
      }
    }
    return { staged, display: loc.display };
  }

  /**
   * 把暂存对象移回原处（不覆盖）。原处已被占用时改放到同一目录下的可见恢复副本；返回其显示路径（放回原处返回 null）。
   * 两处都放不下时对象留在保留区，返回保留区路径（内容不丢，调用方须在说明中给出位置）。
   */
  async restoreStaged(h: { staged: string; display: string }): Promise<string | null> {
    const loc = this.locateOrThrow(h.display, true);
    const { chain } = await this.walk(loc);
    await this.recheckChain(loc, chain);
    return this.putBack(h.staged, loc);
  }

  /**
   * 把内容写进区域保留区（`.kwl-stage`），返回暂存句柄——供“先写成、后落位”的提交步骤使用（第二轮复核 S3-25：
   * 目录换文件的新内容在删除之前写成）。落位用 `placeStaged`（不覆盖）。
   */
  async stageContent(absPath: string, data: Uint8Array): Promise<{ staged: string; display: string }> {
    const loc = this.locateOrThrow(absPath, true);
    if (loc.rel.length === 0) throw eperm(absPath);
    const dir = await this.reservedDir(loc, "stage");
    const staged = this.flavor === "win32" ? `${dir}\\${randomBytes(8).toString("hex")}` : `${dir}/${randomBytes(8).toString("hex")}`;
    const fh = await open(staged, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | O_NOFOLLOW, 0o644);
    try {
      await fh.writeFile(loc.zone.codec ? loc.zone.codec.seal(data) : data);
      await fh.sync();
    } catch (e) {
      await fh.close().catch(() => {});
      await unlink(staged).catch(() => {});
      throw e;
    }
    await fh.close();
    return { staged, display: loc.display };
  }

  /** 把暂存对象放到 absPath（不覆盖：目标已存在即 EEXIST）。 */
  async placeStaged(h: { staged: string }, absPath: string): Promise<void> {
    const loc = this.locateOrThrow(absPath, true);
    if (loc.rel.length === 0) throw eperm(absPath);
    const { chain, leaf } = await this.walk(loc);
    if (leaf) throw new BrokerError("EEXIST", `target exists (file broker): ${loc.display}`);
    await this.recheckChain(loc, chain);
    if (!(await this.placeNoClobber(h.staged, loc.real))) throw new BrokerError("EEXIST", `target exists (file broker): ${loc.display}`);
  }

  async discardStaged(h: { staged: string }): Promise<void> {
    await rm(h.staged, { recursive: true, force: true });
  }

  /**
   * 链接预检（审查 S2-14、S3-02）：absPath 自身及其下（不跟随链接）出现符号链接、硬链接（nlink > 1）或非常规文件即列出。
   * 供不经 broker 逐文件打开的读取者使用（可信原生 rg 的遍历、执行域的读盘层）：区内文件都由 broker 创建（nlink = 1），
   * 出现链接说明有区外写入者，按“不读”处理。**保留名 `.kwl-*` 之下同样检查**——Agent 的文件工具看不到它们，但原生 rg
   * （--hidden）与执行域的读盘层看得到。broker 独占创建（link 后 unlink）有一瞬 nlink = 2：发现后隔 100 ms 复核，只报告持续存在的。
   * 超过 maxEntries 即 truncated（调用方按拒绝处理）。
   */
  async findLinks(absPath: string, opts: { maxEntries?: number } = {}): Promise<{ links: string[]; truncated: boolean }> {
    const maxEntries = opts.maxEntries ?? 200_000;
    const loc = this.locateOrThrow(absPath, false);
    const { leaf } = await this.walk(loc); // 路径上或终点是符号链接即 ELOOP
    if (!leaf) throw enoent(loc.display);
    const sep = this.flavor === "win32" ? "\\" : "/";
    const isLink = (st: Stats) => st.isSymbolicLink() || (!st.isDirectory() && !st.isFile()) || (st.isFile() && st.nlink > 1);
    const found: { real: string; display: string }[] = [];
    if (!leaf.isDirectory()) {
      if (isLink(leaf)) found.push({ real: loc.real, display: loc.display });
    } else {
      let seen = 0;
      const stack: { real: string; display: string }[] = [{ real: loc.rel.length === 0 ? this.rootOf(loc).realPath : loc.real, display: loc.display }];
      while (stack.length > 0) {
        const dir = stack.pop()!;
        const entries = await readdir(dir.real, { withFileTypes: true }).catch(() => []);
        for (const e of entries) {
          if (++seen > maxEntries) return { links: found.map((f) => f.display).sort(), truncated: true };
          const real = `${dir.real}${sep}${e.name}`;
          const display = `${dir.display}${sep}${e.name}`;
          const st = await lstat(real).catch(() => null);
          if (!st) continue;
          if (isLink(st)) found.push({ real, display });
          else if (st.isDirectory()) stack.push({ real, display });
        }
      }
    }
    if (found.length === 0) return { links: [], truncated: false };
    await new Promise((r) => setTimeout(r, 100));
    const links: string[] = [];
    for (const f of found) {
      const st = await lstat(f.real).catch(() => null);
      if (st && isLink(st)) links.push(f.display);
    }
    return { links: links.sort(), truncated: false };
  }

  /** realpath：区域内不允许链接，规范路径即“调用方使用的根 + 相对分量”。 */
  async realpath(absPath: string): Promise<string> {
    const loc = this.locateOrThrow(absPath, false);
    const { leaf } = await this.walk(loc);
    if (!leaf) throw enoent(loc.display);
    return loc.display;
  }

  /** 供宿主把 broker 作为 Kimi Code `IHostFileSystem` 种子注入。 */
  asHostFileSystem(): Record<string, unknown> {
    return {
      _serviceBrand: undefined,
      readText: (p: string) => this.readText(p),
      // 写类方法经写入临界区（与执行域的整批提交互斥：审查 S3-03）
      writeText: (p: string, d: string) => this.exclusive(() => this.writeText(p, d)),
      appendText: (p: string, d: string) => this.exclusive(() => this.appendText(p, d)),
      readBytes: (p: string, n?: number, o?: number) => this.readBytes(p, n, o),
      writeBytes: (p: string, d: Uint8Array) => this.exclusive(() => this.writeBytes(p, d)),
      readLines: (p: string) => this.readLines(p),
      createExclusive: (p: string, d: Uint8Array) => this.exclusive(() => this.createExclusive(p, d)),
      stat: (p: string) => this.stat(p),
      lstat: (p: string) => this.lstat(p),
      readdir: (p: string) => this.readdir(p),
      mkdir: (p: string, o?: { readonly recursive?: boolean }) => this.exclusive(() => this.mkdir(p, o)),
      remove: (p: string) => this.exclusive(() => this.remove(p)),
      realpath: (p: string) => this.realpath(p),
    };
  }
}

export function pathModuleFor(flavor: PathFlavor) {
  return flavor === "win32" ? win32 : posix;
}
