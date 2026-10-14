/**
 * 引擎持久化的落盘加密（审计 S3 第 1 步 1-6、1-9；设计 docs/audit-2026-10-13/设计-工作区与会话落盘加密.md §5.1）。
 *
 * - `SealedFileStorageService`：替换引擎的 `IFileSystemStorageService`（经种子注入，零引擎补丁）。会话转录 `wire.jsonl`、会话与计划状态、
 *   文件历史快照块、后台任务输出、会话索引脏标记都经它写盘——一律是 KWE1 密文：整文件写入为单条记录的追加日志（原子：临时文件 + fsync + rename），
 *   追加为逐条认证的记录（断电残尾在下次追加前截断）；读出时解封。未加密的旧文件按原样读出，下一次写入即加密（迁移见 migrateHomeDir）。
 * - `sealedJournalIo`：ZP-9a 注入点——kap-server 的 WS 事件日志 `server/events/*.jsonl` 同样以追加日志密文落盘。
 * - 同一路径的读改写按路径串行（追加与整文件写入不交错）。
 * 文件名、目录结构、文件数量、精确明文长度（分块格式可由盘上长度算出；追加日志可见每条记录的长度与条数）与时间不加密（如实残余）。
 */
import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, truncate, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AtRestError, HEADER_BYTES, isSealed, type ZoneCodec } from "@zr-legal/at-rest";
import { retryWin } from "@zr-legal/file-broker";
import { toStorageIoError, type JournalIo } from "../vendor/kap-embed/kap-embed.mjs";

const isEnoent = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";

/** 追加日志文件的写入器：缓存每个路径的记录数与盘上长度（避免每次追加都整文件扫描），同一路径串行。 */
export class SealedLogFiles {
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly cache = new Map<string, { diskSize: number; records: number; header: Buffer }>();

  private readonly codec: ZoneCodec;
  private readonly modes: { dir: number; file: number };
  /** 严格（复核 B3-A18）：存量迁移完成后，盘上出现的明文文件只可能来自外部写入或漏网的写盘路径——拒绝读取与沿用，不当作可信数据。 */
  private readonly strict: boolean;

  constructor(codec: ZoneCodec, o: { modes?: { dir: number; file: number }; strict?: boolean } = {}) {
    this.codec = codec;
    this.modes = o.modes ?? { dir: 0o700, file: 0o600 };
    this.strict = o.strict ?? false;
  }

  private plaintextRefused(path: string): never {
    throw new AtRestError("not_sealed", `引擎数据目录里出现未加密的文件（${path.split(/[\\/]/).slice(-2).join("/")}）：已拒绝读取（可能是外部写入）`);
  }

  /** 按路径串行执行。 */
  serial<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(path) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.chains.set(path, tail);
    void tail.then(() => {
      if (this.chains.get(path) === tail) this.chains.delete(path);
    });
    return next;
  }

  /** 读出明文（密文解封；旧的明文文件原样返回；不存在返回 undefined）。 */
  async read(path: string): Promise<Buffer | undefined> {
    let disk: Buffer;
    try {
      disk = await readFile(path);
    } catch (e) {
      if (isEnoent(e)) return undefined;
      throw e;
    }
    if (isSealed(disk)) return this.codec.open(disk);
    if (this.strict && disk.length > 0) this.plaintextRefused(path);
    return disk;
  }

  async plainSize(path: string): Promise<number | undefined> {
    const c = this.cache.get(path);
    let st;
    try {
      st = await stat(path);
    } catch (e) {
      if (isEnoent(e)) return undefined;
      throw e;
    }
    if (c && c.diskSize === st.size) return this.codec.plainSize(await readFile(path));
    const disk = await readFile(path);
    if (isSealed(disk)) return this.codec.plainSize(disk);
    if (this.strict && disk.length > 0) this.plaintextRefused(path);
    return disk.length;
  }

  /** 整文件原子写入：单条记录的新日志（临时文件 + fsync + rename；同目录）。 */
  async write(path: string, plain: Uint8Array): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: this.modes.dir });
    const header = this.codec.newLog();
    const body = plain.length > 0 ? this.codec.record(header, 0, plain) : Buffer.alloc(0);
    const tmp = `${path}.kwl-tmp-${randomBytes(6).toString("hex")}`;
    let fh: FileHandle | null = null;
    try {
      fh = await open(tmp, "wx", this.modes.file);
      await fh.writeFile(Buffer.concat([header, body]));
      await fh.sync();
      await fh.close();
      fh = null;
      await retryWin(() => rename(tmp, path));
    } catch (e) {
      await fh?.close().catch(() => {});
      await unlink(tmp).catch(() => {});
      throw e;
    }
    this.cache.set(path, { diskSize: HEADER_BYTES + body.length, records: plain.length > 0 ? 1 : 0, header });
  }

  /** 追加一条记录（必要时先截断残尾；旧格式或旧代的文件先整体按当前格式重写）。 */
  async append(path: string, plain: Uint8Array, durable = true): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: this.modes.dir });
    let c = this.cache.get(path);
    let size: number | null = null;
    try {
      size = (await stat(path)).size;
    } catch (e) {
      if (!isEnoent(e)) throw e;
    }
    if (size === null) {
      await this.write(path, plain);
      return;
    }
    if (!c || c.diskSize !== size) {
      const disk = await readFile(path);
      if (!isSealed(disk) && this.strict && disk.length > 0) this.plaintextRefused(path);
      if (!isSealed(disk) || disk[5] !== 0x02 || !this.codec.isCurrentGen(disk)) {
        // 明文旧文件、分块格式或旧代：读出明文后整体重写为当前代的追加日志，再追加
        const prior = isSealed(disk) ? this.codec.open(disk) : disk;
        await this.write(path, Buffer.concat([prior, plain]));
        return;
      }
      let r: ReturnType<ZoneCodec["readLog"]>;
      try {
        r = this.codec.readLog(disk);
      } catch (e) {
        if (!(e instanceof AtRestError) || e.code !== "corrupt") throw e;
        // 中段损坏（复核 B3-A17）：不截断——原文件整份另存为隔离副本（仍是密文，供排查），本条写入新日志
        const quarantine = `${path}.kwl-corrupt-${Date.now()}`;
        await rename(path, quarantine);
        console.warn(`[kap-host] 追加日志中段损坏，已隔离为 ${quarantine.split(/[\\/]/).pop()}；新记录写入新文件`);
        this.cache.delete(path);
        await this.write(path, plain);
        return;
      }
      if (r.torn) await truncate(path, r.validLength);
      c = { diskSize: r.validLength, records: r.records, header: Buffer.from(disk.subarray(0, HEADER_BYTES)) };
    }
    if (plain.length === 0) return;
    const rec = this.codec.record(c.header, c.records, plain);
    const fh = await open(path, "a", this.modes.file);
    try {
      await fh.writeFile(rec);
      if (durable) await fh.sync();
    } finally {
      await fh.close();
    }
    this.cache.set(path, { diskSize: c.diskSize + rec.length, records: c.records + 1, header: c.header });
  }

  async remove(path: string): Promise<void> {
    this.cache.delete(path);
    await rm(path, { force: true });
  }

  forget(path: string): void {
    this.cache.delete(path);
  }
}

/** 引擎持久化存储（实现 IFileSystemStorageService 的 12 个方法；语义对齐上游 node-fs 实现）。 */
export class SealedFileStorageService {
  declare readonly _serviceBrand: undefined;
  private readonly files: SealedLogFiles;
  private readonly baseDir: string;

  constructor(baseDir: string, codec: ZoneCodec, o: { strict?: boolean } = {}) {
    this.baseDir = baseDir;
    this.files = new SealedLogFiles(codec, { strict: o.strict ?? false });
  }

  pathFor(scope: string, key: string): string {
    return join(this.baseDir, scope, key);
  }

  async read(scope: string, key: string): Promise<Uint8Array | undefined> {
    const p = this.pathFor(scope, key);
    try {
      return await this.files.serial(p, () => this.files.read(p));
    } catch (e) {
      throw toStorageIoError(e, { path: p, op: "read" });
    }
  }

  async *readStream(scope: string, key: string, range?: { start: number; end: number }): AsyncIterable<Uint8Array> {
    const all = await this.read(scope, key);
    if (!all) return;
    // 与 fs.createReadStream 的 {start, end} 一致：end 为闭区间
    yield range === undefined ? all : all.subarray(range.start, range.end + 1);
  }

  async write(scope: string, key: string, data: Uint8Array, options: { signal?: AbortSignal } = {}): Promise<void> {
    const p = this.pathFor(scope, key);
    try {
      options.signal?.throwIfAborted();
      await this.files.serial(p, () => this.files.write(p, data));
    } catch (e) {
      options.signal?.throwIfAborted();
      throw toStorageIoError(e, { path: p, op: "write" });
    }
  }

  async writeStream(scope: string, key: string, source: AsyncIterable<Uint8Array>, options: { signal?: AbortSignal } = {}): Promise<void> {
    const parts: Uint8Array[] = [];
    for await (const c of source) parts.push(c);
    await this.write(scope, key, Buffer.concat(parts), options);
  }

  async append(scope: string, key: string, data: Uint8Array, options: { durable?: boolean } = {}): Promise<void> {
    const p = this.pathFor(scope, key);
    try {
      await this.files.serial(p, () => this.files.append(p, data, options.durable !== false));
    } catch (e) {
      throw toStorageIoError(e, { path: p, op: "append" });
    }
  }

  async list(scope: string, prefix?: string): Promise<readonly string[]> {
    const dir = join(this.baseDir, scope);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (e) {
      if (isEnoent(e)) return [];
      throw toStorageIoError(e, { path: dir, op: "list" });
    }
    entries = entries.filter((e) => !e.includes(".kwl-tmp-"));
    return prefix === undefined ? entries : entries.filter((e) => e.startsWith(prefix));
  }

  async delete(scope: string, key: string): Promise<void> {
    const p = this.pathFor(scope, key);
    try {
      await this.files.serial(p, async () => {
        this.files.forget(p);
        await unlink(p).catch((e) => {
          if (!isEnoent(e)) throw e;
        });
      });
    } catch (e) {
      throw toStorageIoError(e, { path: p, op: "delete" });
    }
  }

  async size(scope: string, key: string): Promise<number | undefined> {
    const p = this.pathFor(scope, key);
    try {
      return await this.files.serial(p, () => this.files.plainSize(p));
    } catch (e) {
      throw toStorageIoError(e, { path: p, op: "stat" });
    }
  }

  async mtime(scope: string, key: string): Promise<number | undefined> {
    const p = this.pathFor(scope, key);
    try {
      return (await stat(p)).mtimeMs;
    } catch (e) {
      if (isEnoent(e)) return undefined;
      throw toStorageIoError(e, { path: p, op: "stat" });
    }
  }

  async flush(): Promise<void> {}

  async close(): Promise<void> {}
}

/** ZP-9a：kap-server 事件日志的加密 I/O（追加日志密文；按行读出明文）。 */
export function sealedJournalIo(codec: ZoneCodec, o: { strict?: boolean } = {}): JournalIo {
  const files = new SealedLogFiles(codec, { strict: o.strict ?? false });
  return {
    appendText: (path, text) => files.serial(path, () => files.append(path, Buffer.from(text, "utf8"), false)),
    async *readLines(path) {
      const all = await files.serial(path, () => files.read(path));
      if (!all) {
        const e = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
        e.code = "ENOENT";
        throw e;
      }
      const text = all.toString("utf8");
      const lines = text.split("\n");
      if (lines.at(-1) === "") lines.pop();
      for (const l of lines) yield l;
    },
    remove: (path) => files.serial(path, () => files.remove(path)),
  };
}

/**
 * 存量迁移（第 1 步 1-14）：引擎状态目录里的明文文件就地改写为密文（引擎打开前执行）；可丢弃的明文（引擎文件日志、minidb 查询库）直接删除。
 * 返回改写与删除的文件数。只处理常规文件，不跟随链接；已是密文的跳过。
 */
export async function migrateHomeDir(homeDir: string, codecs: { engineFs: ZoneCodec; journal: ZoneCodec }): Promise<{ sealed: number; removed: number }> {
  let sealed = 0;
  let removed = 0;
  for (const dead of [join(homeDir, "logs"), join(homeDir, "cache", "query-store")]) {
    try {
      await stat(dead);
      await rm(dead, { recursive: true, force: true });
      removed++;
    } catch {
      // 不存在
    }
  }
  const walk = async (dir: string, codec: ZoneCodec): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (e.name === "logs") {
          await rm(p, { recursive: true, force: true });
          removed++;
          continue;
        }
        await walk(p, codec);
        continue;
      }
      if (!e.isFile()) continue;
      if (e.name.includes(".kwl-tmp-")) {
        await rm(p, { force: true });
        removed++;
        continue;
      }
      const disk = await readFile(p);
      if (isSealed(disk)) continue;
      // 明文 → 当前代的追加日志（单条记录），原子替换
      await new SealedLogFiles(codec).write(p, disk);
      sealed++;
    }
  };
  await walk(join(homeDir, "sessions"), codecs.engineFs);
  await walk(join(homeDir, "server", "events"), codecs.journal);
  // 其余由存储服务写入的顶层文件（workspaces.json、session_index.jsonl、device_id 等）
  let top: string[] = [];
  try {
    top = await readdir(homeDir);
  } catch {
    top = [];
  }
  for (const name of top) {
    const p = join(homeDir, name);
    const st = await stat(p).catch(() => null);
    if (!st) continue;
    if (st.isDirectory()) {
      if (["sessions", "server", "w-tmp", "kwl-instructions", "logs"].includes(name)) continue;
      await walk(p, codecs.engineFs);
      continue;
    }
    if (!st.isFile() || name === "mcp.json") continue;
    const disk = await readFile(p);
    if (isSealed(disk)) continue;
    await new SealedLogFiles(codecs.engineFs).write(p, disk);
    sealed++;
  }
  return { sealed, removed };
}

/**
 * 工作区存量明文迁移（审计 S3 第 2 步；设计 §7）：引擎打开前把工作区里的明文文件就地改写为分块 KWE1（区编解码器封装 → 同目录临时文件
 * → fsync → rename 原子替换）；已是 KWE1 的跳过（幂等，可在任意点中断后重入）。broker 的临时文件（`.kwl-tmp-*`）与回收区
 * （`.kwl-trash`）删除；暂存区（`.kwl-stage`，崩溃时可能留有待落位的内容）里的文件同样加密。链接不跟随、不改写（执行域与检索遇到即拒绝）。
 * 被替换的明文：只有就地改写的文件，POSIX 上 rename 前先打开原文件，rename 之后经该句柄以零覆写并 fsync——尽力而为（SSD 磨损均衡、
 * 写时复制文件系统、快照与备份中的旧版本无法由应用清除，如实口径见设计 §7.4）；Windows 上不做（rename 替换被打开的文件会失败）。
 * 直接删除的存量（回收区、临时文件）不做零覆写。两遍遍历（复核 S3B-A11）：先删 broker 的临时文件与回收区——明文时代 link 之后、
 * unlink 之前崩溃留下的硬链接对随之只剩一个目录项，第二遍才能就地加密。
 */
export async function migrateWorkDir(root: string, codec: ZoneCodec): Promise<{ sealed: number; removed: number }> {
  let sealed = 0;
  let removed = 0;
  const sweep = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (e.name.toLowerCase() === ".kwl-trash") {
          await rm(p, { recursive: true, force: true });
          removed++;
        } else await sweep(p);
        continue;
      }
      if (e.isFile() && e.name.toLowerCase().startsWith(".kwl-tmp-")) {
        await rm(p, { force: true });
        removed++;
      }
    }
  };
  await sweep(root);
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (e.name.toLowerCase() === ".kwl-trash") {
          await rm(p, { recursive: true, force: true });
          removed++;
          continue;
        }
        await walk(p);
        continue;
      }
      if (!e.isFile()) continue;
      if (e.name.toLowerCase().startsWith(".kwl-tmp-")) {
        await rm(p, { force: true });
        removed++;
        continue;
      }
      if (await sealFileInPlace(p, codec)) sealed++;
    }
  };
  await walk(root);
  return { sealed, removed };
}

/** 把一个明文文件就地改写为分块 KWE1（已是密文返回 false）。 */
async function sealFileInPlace(path: string, codec: ZoneCodec): Promise<boolean> {
  const st = await stat(path);
  if (st.nlink > 1) return false; // 硬链接：不改写（另一处目录项仍指向同一明文；遇到即被 broker 与执行域拒绝）
  const head = Buffer.alloc(HEADER_BYTES);
  const fh0 = await open(path, "r");
  let n = 0;
  try {
    n = (await fh0.read(head, 0, HEADER_BYTES, 0)).bytesRead;
  } finally {
    await fh0.close();
  }
  if (n === HEADER_BYTES && isSealed(head)) return false;
  const plain = await readFile(path);
  // 临时文件用 broker 的保留名（Agent 不可见；中断后重入时删除）
  const tmp = join(dirname(path), `.kwl-tmp-${randomBytes(8).toString("hex")}`);
  let fh: FileHandle | null = null;
  try {
    fh = await open(tmp, "wx", 0o600);
    await fh.writeFile(codec.seal(plain));
    await fh.sync();
    await fh.close();
    fh = null;
  } catch (e) {
    await fh?.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw e;
  }
  // 尽力而为的零覆写：rename 前打开原文件（rename 后该句柄仍指向原 inode）
  const old = process.platform === "win32" ? null : await open(path, "r+").catch(() => null);
  try {
    await retryWin(() => rename(tmp, path));
  } catch (e) {
    await old?.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw e;
  }
  if (old) {
    try {
      const zeros = Buffer.alloc(Math.min(plain.length, 1 << 20));
      for (let at = 0; at < plain.length; at += zeros.length) await old.write(zeros, 0, Math.min(zeros.length, plain.length - at), at);
      await old.sync();
    } catch {
      // 尽力而为
    } finally {
      await old.close().catch(() => {});
    }
  }
  plain.fill(0);
  return true;
}
