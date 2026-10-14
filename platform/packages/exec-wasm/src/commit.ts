/**
 * W 执行域的工作区快照提交（v9 第 04 篇 §4.1“工作区并发写”行）。
 *
 * 工作区在 W 内以 OverlayFs 读盘、写入留在内存；执行结束由宿主经**文件 broker** 校验后提交。调用方（domain.ts）在
 * **broker 写入临界区**（`broker.exclusive`）内采集基线、也在临界区内提交——同一事项的并发命令、引擎的 Write/Edit
 * 都排在同一队列里，“判定—写入”之间不会被另一个写入者插进来（审查 S3-03）：
 * 1. 运行前基线（captureBaseline，在命令真正开始时采集：审查 S3-12）：逐级 lstat 遍历事项区（不跟随链接），记下每个文件的
 *    (ino, size, mtime)；同时做链接预检——区内（**含 broker 保留名 `.kwl-*` 之下**）出现符号链接、硬链接（nlink > 1）或非常规
 *    文件即拒绝运行（审查 S2-14、S3-02）。broker 独占创建时有一瞬 nlink = 2，发现链接后隔 100 ms 复核一次；
 * 2. 校验整个改动集（全部通过才开始写）：路径必须能在工作区内定位（拒绝 `..`、保留名、危险形态、超过操作系统长度上限）；
 *    出现链接即整体拒绝（链接投毒）；单文件与总量上限；
 * 3. 冲突判定：目标在盘上的状态与基线不一致（Write/Edit、Office 写回、同步客户端、外部改名）→ 不覆盖，W 的版本另存为冲突副本；
 *    要删除的文件已被改动 → 保留不删；内容与盘上相同 → 跳过。**别名只在一种情形成立**（审查 S3-04）：改动集删除了路径 A、
 *    新写了路径 B，A 与 B 折叠后相同（大小写/Unicode），且盘上是同一个对象——大小写不敏感卷上的 `mv a A`；其余“基线里没有、
 *    盘上却有”的路径一律是冲突（例如律师在命令运行期间把别的文件改名到这里）；
 * 4. 写入点再核对（比较—替换）：覆盖已有文件时把基线身份交给 broker，rename 之前最后一次核对，不符即转冲突副本；新建文件用独占创建
 *    （目标已存在即转冲突副本），不用“判定不存在 → 覆盖”；
 * 5. 应用顺序（审查 S3-01：先写后删，写不全就不删）：建目录 → 写文件与冲突副本 → **全部成功才**删除文件（按基线身份比较—替换，
 *    复核 S3-17）与已空目录（rmdir 原子判定）→ 类型变化（文件换目录：旧文件先暂存、新内容写成后才删除，失败即移回，复核 S3-19；
 *    目录换文件：子树删除后写文件）→ 删后同名重建的目录 → 大小写更名（同一对象只改目录项写法）。
 *    任何写入失败时一个都不删，源文件保留（`mv` 不会丢稿）。
 *
 * 如实的残余：写入阶段已写成的文件不回滚（工作区快照与文件历史可回滚）；broker 的 rename 前核对与 rename 之间仍有一次系统调用的
 * 窗口，只有不经 broker 的区外写入者能利用；基线之后、W 读取之前由区外进程新建的硬链接属于同用户恶意进程（第 02 篇 §3.4）；
 * `touch` 只改时间戳、内容不变时不写回（不制造无谓的修改，偏离登记）。
 */
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { foldName, RESERVED_PREFIX, type FileBroker } from "@zr-legal/file-broker";
import type { ChangeSet } from "./protocol.ts";

export interface BaselineEntry {
  type: "file" | "dir";
  ino: number;
  size: number;
  mtimeMs: number;
}

export interface Baseline {
  /** 区内相对路径（以 / 分隔）→ 状态。 */
  entries: Map<string, BaselineEntry>;
  /** 文件 inode → 相对路径（大小写或 Unicode 别名按对象身份匹配）。 */
  byIno: Map<number, string>;
}

export class LinkPresentError extends Error {
  readonly code = "link_present";
  readonly paths: string[];
  constructor(paths: string[]) {
    super(`事项区内存在链接文件（${paths.slice(0, 5).join("、")}${paths.length > 5 ? " 等" : ""}），执行域拒绝运行：请移除这些链接后重试`);
    this.paths = paths;
  }
}

export class TooManyEntriesError extends Error {
  readonly code = "too_many_entries";
  constructor(limit: number) {
    super(`事项区文件数超过 ${limit}，执行域拒绝运行（请清理工作区或分目录处理）`);
  }
}

const isReserved = (name: string) => name.toLowerCase().startsWith(RESERVED_PREFIX);

/** 运行前基线 + 链接预检（不跟随链接）。保留名之下只做链接预检，不进基线（它们不可提交）。 */
export async function captureBaseline(root: string, opts: { maxEntries?: number } = {}): Promise<Baseline> {
  const maxEntries = opts.maxEntries ?? 200_000;
  const entries = new Map<string, BaselineEntry>();
  const byIno = new Map<number, string>();
  const links: { rel: string; abs: string }[] = [];
  const stack: { rel: string; reserved: boolean }[] = [{ rel: "", reserved: false }];
  // 保留名之下（broker 的回收与临时文件）单独计数：它们不计入律师可见的条目上限，但遍历仍有界（审查 S3-14）
  let seen = 0;
  let seenReserved = 0;
  while (stack.length > 0) {
    const { rel, reserved } = stack.pop()!;
    const abs = rel === "" ? root : join(root, ...rel.split("/"));
    let dirents;
    try {
      dirents = await readdir(abs, { withFileTypes: true });
    } catch {
      continue; // 运行前目录被删：按缺失处理
    }
    for (const d of dirents) {
      const childRel = rel === "" ? d.name : `${rel}/${d.name}`;
      const childAbs = join(abs, d.name);
      const inReserved = reserved || isReserved(d.name);
      const st = await lstat(childAbs).catch(() => null);
      if (!st) continue;
      if (inReserved ? ++seenReserved > maxEntries : ++seen > maxEntries) throw new TooManyEntriesError(maxEntries);
      if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile()) || (st.isFile() && st.nlink > 1)) {
        links.push({ rel: childRel, abs: childAbs }); // 符号链接、硬链接、FIFO/设备/套接字：一律拒绝
        continue;
      }
      if (st.isDirectory()) {
        if (!inReserved) entries.set(childRel, { type: "dir", ino: Number(st.ino), size: 0, mtimeMs: Number(st.mtimeMs) });
        stack.push({ rel: childRel, reserved: inReserved });
      } else if (!inReserved) {
        entries.set(childRel, { type: "file", ino: Number(st.ino), size: Number(st.size), mtimeMs: Number(st.mtimeMs) });
        byIno.set(Number(st.ino), childRel);
      }
    }
  }
  if (links.length > 0) {
    // broker 的独占创建（link(tmp, target) 后 unlink(tmp)）有一瞬 nlink = 2：复核一次，只报告持续存在的
    await new Promise((r) => setTimeout(r, 100));
    const persistent: string[] = [];
    for (const l of links) {
      const st = await lstat(l.abs).catch(() => null);
      if (st && (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile()) || (st.isFile() && st.nlink > 1))) persistent.push(l.rel);
      else if (st?.isFile() && !l.rel.split("/").some(isReserved)) {
        entries.set(l.rel, { type: "file", ino: Number(st.ino), size: Number(st.size), mtimeMs: Number(st.mtimeMs) });
        byIno.set(Number(st.ino), l.rel);
      }
    }
    if (persistent.length > 0) throw new LinkPresentError(persistent.sort());
  }
  return { entries, byIno };
}

export interface CommitLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
}

export interface CommitReport {
  written: string[];
  deleted: string[];
  dirs: string[];
  /** 大小写/Unicode 更名（同一对象只改目录项写法）。 */
  renamed: { from: string; to: string }[];
  /** W 的版本因冲突另存（path = 原路径，copy = 冲突副本路径；at：另存不了时内容所在的保留区位置）。 */
  conflicts: { path: string; copy: string | null; reason: string; at?: string }[];
  /** 因冲突保留未删的路径（at：原路径已被占用时，原文件改放到的可见恢复副本或保留区位置）。 */
  kept: { path: string; reason: string; at?: string }[];
  unchanged: number;
  /** 整体拒绝的原因（非空 = 改动集一项都没有提交）。 */
  rejected: { path: string; reason: string }[];
  failed: { path: string; reason: string }[];
}

function emptyReport(): CommitReport {
  return { written: [], deleted: [], dirs: [], renamed: [], conflicts: [], kept: [], unchanged: 0, rejected: [], failed: [] };
}

/** 本次提交是否没有完整写回（冲突副本、保留未删、被拒绝或写入失败）——Bash 据此返回非零退出码（审查 S3-06）。 */
export function commitIncomplete(r: CommitReport | null): boolean {
  return !!r && (r.rejected.length > 0 || r.failed.length > 0 || r.conflicts.length > 0 || r.kept.length > 0);
}

interface Current {
  isFile: boolean;
  isDirectory: boolean;
  /** 盘上长度（与基线、比较—替换的期望状态同一口径；加密区为密文长度）。 */
  size: number;
  /** 内容长度（加密区为明文长度）：只用于“内容未变则跳过”的快速判断。 */
  plainSize: number;
  mtimeMs: number;
  ino: number;
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function conflictName(rel: string, d: Date, n: number): string {
  const slash = rel.lastIndexOf("/");
  const dir = slash >= 0 ? rel.slice(0, slash + 1) : "";
  const base = slash >= 0 ? rel.slice(slash + 1) : rel;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  return `${dir}${stem}（执行冲突副本 ${stamp(d)}${n > 1 ? `-${n}` : ""}）${ext}`;
}

const foldPath = (rel: string) => rel.split("/").map(foldName).join("/");
const parentOf = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
const isUnder = (rel: string, dir: string) => rel.startsWith(`${dir}/`);

type FilePlan = {
  rel: string;
  content: Uint8Array;
  action: "write" | "create" | "copy" | "skip";
  /** write：覆盖已有文件时的期望身份（比较—替换）。 */
  expect?: { ino: number; size: number; mtimeMs: number };
  reason?: string;
  /** 目录换文件：子树删除之后再写。 */
  replacesDir?: boolean;
  /** 文件换目录：父路径上的旧文件回收之后再写。 */
  underReplacedFile?: string;
};

/**
 * 校验并提交一个改动集。`zone` 为工作区在 broker 中的区域名。调用方应在 `broker.exclusive` 内调用（与基线采集、引擎写入互斥）。
 */
export async function commitChanges(
  broker: FileBroker,
  zone: string,
  cs: ChangeSet,
  baseline: Baseline,
  limits: CommitLimits,
  now: Date = new Date(),
): Promise<CommitReport> {
  const report = emptyReport();
  if (cs.files.length === 0 && cs.dirs.length === 0 && cs.deleted.length === 0 && cs.links.length === 0) return report;

  // ── 2. 整体校验 ──
  const abs = (rel: string) => broker.locateIn(zone, rel).display;
  for (const l of cs.links) report.rejected.push({ path: l, reason: "link_not_allowed" });
  let total = 0;
  for (const f of cs.files) {
    total += f.content.byteLength;
    if (f.content.byteLength > limits.maxFileBytes) report.rejected.push({ path: f.path, reason: "file_too_large" });
  }
  if (total > limits.maxTotalBytes) report.rejected.push({ path: "*", reason: "changes_too_large" });
  for (const p of [...cs.files.map((f) => f.path), ...cs.dirs, ...cs.deleted]) {
    try {
      const loc = broker.locateIn(zone, p);
      if (loc.rel.length === 0) report.rejected.push({ path: p, reason: "zone_root" });
    } catch {
      report.rejected.push({ path: p, reason: "path_not_allowed" });
    }
  }
  if (report.rejected.length > 0) return report;

  const current = async (rel: string): Promise<Current | null> => {
    try {
      const st = await broker.lstat(abs(rel));
      if (st.isSymbolicLink) return { isFile: false, isDirectory: false, size: 0, plainSize: 0, mtimeMs: 0, ino: -1 };
      // 身份比较一律用盘上长度（基线由 lstat 直接采集，加密区为密文长度；审计 S3 第 2 步）
      return { isFile: st.isFile, isDirectory: st.isDirectory, size: st.diskSize, plainSize: st.size, mtimeMs: st.mtimeMs, ino: st.ino };
    } catch {
      return null;
    }
  };
  const deletedSet = new Set(cs.deleted);
  const dirsSet = new Set(cs.dirs);
  /**
   * 别名（审查 S3-04）：路径 rel 不在基线里、盘上有对象 cur；只有当基线中与 cur 同一对象的路径 A 被本改动集删除、
   * 且 A 与 rel 折叠后相同（大小写/Unicode 写法不同的同一目录项）时，才把 A 的基线当作 rel 的基线。
   */
  const aliasOf = (rel: string, cur: Current | null): string | null => {
    if (baseline.entries.has(rel) || !cur || cur.ino < 0) return null;
    const a = baseline.byIno.get(cur.ino);
    if (a === undefined || a === rel || !deletedSet.has(a) || foldPath(a) !== foldPath(rel)) return null;
    return a;
  };
  const baselineFor = (rel: string, cur: Current | null): BaselineEntry | undefined => {
    const b = baseline.entries.get(rel);
    if (b) return b;
    const a = aliasOf(rel, cur);
    return a === null ? undefined : baseline.entries.get(a);
  };
  const unchangedFile = (b: BaselineEntry | undefined, cur: Current | null): boolean =>
    !!b && b.type === "file" && !!cur && cur.isFile && cur.ino === b.ino && cur.size === b.size && cur.mtimeMs === b.mtimeMs;
  /** 目录 dir 在基线中的全部条目是否都被本改动集删除（W 删掉了整棵子树）。 */
  const subtreeDeleted = (dir: string): boolean => {
    for (const k of baseline.entries.keys()) if (isUnder(k, dir) && !deletedSet.has(k)) return false;
    return true;
  };

  // ── 3. 计划（写入任何东西之前） ──
  /** 文件换目录：盘上仍是基线里那个未变的文件、改动集要在这里建目录。 */
  const replacedFiles = new Map<string, BaselineEntry>();
  const blockedDirs = new Set<string>();
  for (const dir of [...cs.dirs].sort((a, b) => a.split("/").length - b.split("/").length)) {
    if ([...replacedFiles.keys()].some((r) => isUnder(dir, r)) || [...blockedDirs].some((r) => dir === r || isUnder(dir, r))) continue;
    const cur = await current(dir);
    if (!cur || cur.isDirectory) continue;
    const b = baseline.entries.get(dir);
    if (unchangedFile(b, cur)) replacedFiles.set(dir, b!);
    else blockedDirs.add(dir); // 盘上是一个运行期间新出现或已被改动的文件：不覆盖
  }
  const filePlans: FilePlan[] = [];
  const renames: { from: string; to: string }[] = [];
  /** 本次提交写成或保持（内容相同而跳过）的对象：删除阶段不得删到它们的别名。 */
  const keepIno = new Set<number>();
  for (const f of cs.files) {
    const blocked = [...blockedDirs].find((d) => isUnder(f.path, d));
    if (blocked) {
      report.failed.push({ path: f.path, reason: "parent_is_file_changed_during_execution" });
      continue;
    }
    const replaced = [...replacedFiles.keys()].find((d) => isUnder(f.path, d));
    if (replaced) {
      filePlans.push({ rel: f.path, content: f.content, action: "create", underReplacedFile: replaced });
      continue;
    }
    const cur = await current(f.path);
    if (cur?.isFile && cur.plainSize === f.content.byteLength) {
      const disk = await broker.readBytes(abs(f.path)).catch(() => null);
      if (disk && Buffer.from(disk).equals(Buffer.from(f.content))) {
        keepIno.add(cur.ino);
        filePlans.push({ rel: f.path, content: f.content, action: "skip" });
        const a = aliasOf(f.path, cur);
        if (a !== null && a !== f.path) renames.push({ from: a, to: f.path }); // 大小写更名：只改目录项写法
        continue;
      }
    }
    const b = baselineFor(f.path, cur);
    if (b?.type === "dir") {
      // 目录换文件（W 内 rm -rf d; echo > d）：盘上仍是目录、W 删掉了基线里的整棵子树 → 子树删除之后写入；否则冲突
      if (cur?.isDirectory && subtreeDeleted(f.path)) filePlans.push({ rel: f.path, content: f.content, action: "write", replacesDir: true });
      else filePlans.push({ rel: f.path, content: f.content, action: "copy", reason: "modified_during_execution" });
      continue;
    }
    if (b) {
      if (unchangedFile(b, cur)) filePlans.push({ rel: f.path, content: f.content, action: "write", expect: { ino: b.ino, size: b.size, mtimeMs: b.mtimeMs } });
      else filePlans.push({ rel: f.path, content: f.content, action: "copy", reason: cur ? "modified_during_execution" : "deleted_during_execution" });
      continue;
    }
    // 基线里没有：盘上也没有才新建（独占创建）；盘上已有 = 运行期间被别人建立或改名到这里 → 冲突副本
    if (cur) filePlans.push({ rel: f.path, content: f.content, action: "copy", reason: "created_during_execution" });
    else filePlans.push({ rel: f.path, content: f.content, action: "create" });
  }
  const deletePlans: { rel: string; action: "delete" | "keep" | "noop"; reason?: string }[] = [];
  for (const rel of [...cs.deleted].sort((a, b) => b.split("/").length - a.split("/").length || (a < b ? 1 : -1))) {
    if (replacedFiles.has(rel)) continue; // 文件换目录：旧文件在类型变化阶段回收
    const cur = await current(rel);
    if (!cur) deletePlans.push({ rel, action: "noop" });
    else if (cur.isDirectory) deletePlans.push({ rel, action: "delete" }); // 目录：应用时只删已空的
    else if (unchangedFile(baseline.entries.get(rel), cur)) deletePlans.push({ rel, action: "delete" });
    else deletePlans.push({ rel, action: "keep", reason: "modified_during_execution" });
  }

  // ── 4. 应用：先写后删，写不全就不删 ──
  const copyOut = async (p: FilePlan, reason: string): Promise<void> => {
    let copy: string | null = null;
    for (let n = 1; n <= 20 && copy === null; n++) {
      const name = conflictName(p.rel, now, n);
      const parent = parentOf(name);
      if (parent) await broker.mkdir(abs(parent), { recursive: true });
      if (await broker.createExclusive(abs(name), p.content)) copy = name;
    }
    report.conflicts.push({ path: p.rel, copy, reason });
    if (copy === null) report.failed.push({ path: p.rel, reason: "conflict_copy_unavailable" });
  };
  const writeOne = async (p: FilePlan): Promise<void> => {
    try {
      const parent = parentOf(p.rel);
      if (p.action === "write") {
        if (parent) await broker.mkdir(abs(parent), { recursive: true });
        try {
          // 比较—替换：rename 前最后一次核对基线身份（S3-03）；新建文件不逐个 fsync（覆盖已有文件仍 fsync）
          await broker.writeBytes(abs(p.rel), p.content, { durable: false, ...(p.expect ? { expect: p.expect } : {}) });
        } catch (e) {
          if ((e as { code?: string }).code === "ECONFLICT") return copyOut(p, "modified_during_commit");
          throw e;
        }
        report.written.push(p.rel);
        const st = await broker.lstat(abs(p.rel)).catch(() => null);
        if (st) keepIno.add(st.ino);
        return;
      }
      if (p.action === "create") {
        if (parent) await broker.mkdir(abs(parent), { recursive: true });
        if (!(await broker.createExclusive(abs(p.rel), p.content))) return copyOut(p, "created_during_execution");
        report.written.push(p.rel);
        const st = await broker.lstat(abs(p.rel)).catch(() => null);
        if (st) keepIno.add(st.ino);
        return;
      }
      await copyOut(p, p.reason ?? "conflict");
    } catch (e) {
      report.failed.push({ path: p.rel, reason: (e as { code?: string }).code ?? "write_failed" });
    }
  };
  // 4a 建目录（不破坏任何已有内容；类型变化与删后重建的目录随后处理）
  for (const dir of [...cs.dirs].sort((a, b) => a.split("/").length - b.split("/").length)) {
    if (deletedSet.has(dir) || replacedFiles.has(dir) || [...replacedFiles.keys()].some((r) => isUnder(dir, r))) continue;
    if ([...blockedDirs].some((r) => dir === r || isUnder(dir, r))) continue;
    try {
      const cur = await current(dir);
      if (cur?.isDirectory) continue;
      await broker.mkdir(abs(dir), { recursive: true });
      report.dirs.push(dir);
    } catch (e) {
      report.failed.push({ path: dir, reason: (e as { code?: string }).code ?? "mkdir_failed" });
    }
  }
  for (const d of blockedDirs) report.failed.push({ path: d, reason: "file_changed_during_execution_not_replaced" });
  for (const p of filePlans) if (p.action === "skip") report.unchanged += 1;
  // 4b 写文件与冲突副本：互不依赖，有界并发
  await eachLimit(
    filePlans.filter((p) => p.action !== "skip" && !p.replacesDir && !p.underReplacedFile),
    COMMIT_CONCURRENCY,
    writeOne,
  );
  // 4c 写入有任何失败：一个都不删（源文件保留——`mv` 时目标没写成，源不能先没了）；类型变化也不做
  if (report.failed.length > 0) {
    for (const d of deletePlans) if (d.action !== "noop") report.kept.push({ path: d.rel, reason: "commit_incomplete" });
    for (const p of filePlans) if (p.replacesDir || p.underReplacedFile) report.failed.push({ path: p.rel, reason: "commit_incomplete" });
    for (const r of replacedFiles.keys()) report.kept.push({ path: r, reason: "commit_incomplete" });
    report.written.sort();
    return report;
  }
  const keptAt = (e: unknown): { at?: string } => {
    const at = (e as { recoveredAt?: string }).recoveredAt;
    return at ? { at } : {};
  };
  /** 暂存内容另存为冲突副本（不覆盖）。另存不了时内容留在保留区，说明给出位置；返回是否已另存到可见位置。 */
  const placeAsCopy = async (rel: string, staged: { staged: string; display: string }, reason: string): Promise<boolean> => {
    for (let n = 1; n <= 20; n++) {
      const name = conflictName(rel, now, n);
      try {
        const parent = parentOf(name);
        if (parent) await broker.mkdir(abs(parent), { recursive: true });
        await broker.placeStaged(staged, abs(name));
        report.conflicts.push({ path: rel, copy: name, reason });
        return true;
      } catch (e) {
        if ((e as { code?: string }).code !== "EEXIST") break;
      }
    }
    report.conflicts.push({ path: rel, copy: null, reason, at: staged.staged });
    report.failed.push({ path: rel, reason: "conflict_copy_unavailable" });
    return false;
  };
  // 4d 类型变化，全部在删除之前完成（第二轮复核 S3-25：写不全就不删）：
  //    文件换目录：旧文件暂存到保留区（核对仍是基线那个对象）→ 建新目录与子目录 → 写子文件；任何失败即删掉已写部分并把旧文件不覆盖地移回。
  //    成功者的暂存句柄留到删除阶段之后才丢弃。
  const stagedOld: { dir: string; staged: { staged: string; display: string } }[] = [];
  for (const [dir, b] of replacedFiles) {
    let staged: { staged: string; display: string } | null = null;
    const created: string[] = [];
    try {
      staged = await broker.stageAside(abs(dir), { expect: { ino: b.ino, size: b.size, mtimeMs: b.mtimeMs } });
    } catch (e) {
      report.kept.push({ path: dir, reason: (e as { code?: string }).code === "ECONFLICT" ? "modified_during_commit" : "type_change_failed", ...keptAt(e) });
      for (const p of filePlans.filter((x) => x.underReplacedFile === dir)) report.failed.push({ path: p.rel, reason: "parent_is_file_changed_during_execution" });
      continue;
    }
    const failedBefore = report.failed.length;
    try {
      await broker.mkdir(abs(dir), { recursive: true });
      created.push(dir);
      for (const sub of [...cs.dirs].filter((x) => isUnder(x, dir)).sort((a, c) => a.split("/").length - c.split("/").length)) {
        await broker.mkdir(abs(sub), { recursive: true });
        created.push(sub);
      }
      for (const p of filePlans.filter((x) => x.underReplacedFile === dir)) {
        await writeOne(p);
        if (report.written.includes(p.rel)) created.push(p.rel);
      }
      if (report.failed.length > failedBefore) throw Object.assign(new Error("type change incomplete"), { code: "commit_incomplete" });
      stagedOld.push({ dir, staged });
      report.dirs.push(...created.filter((x) => x === dir || cs.dirs.includes(x)));
    } catch (e) {
      // 回滚：删掉本次在新目录下写成的文件与目录（深者先），再把旧文件不覆盖地移回原处（原处被占用则另存为可见恢复副本）
      for (const rel of [...created].reverse()) {
        const st = await current(rel);
        if (!st) continue;
        await (st.isDirectory ? broker.removeEmptyDir(abs(rel)) : broker.remove(abs(rel))).catch(() => {});
        const wi = report.written.indexOf(rel);
        if (wi >= 0) report.written.splice(wi, 1);
      }
      try {
        const at = await broker.restoreStaged(staged);
        report.kept.push({ path: dir, reason: "commit_incomplete", ...(at ? { at } : {}) });
      } catch {
        report.kept.push({ path: dir, reason: "commit_incomplete", at: staged.staged });
      }
      if (report.failed.length === failedBefore) report.failed.push({ path: dir, reason: (e as { code?: string }).code ?? "type_change_failed" });
    }
  }
  //    目录换文件：新内容先写进保留区（子树删除之后再落位）
  const stagedNew: { plan: FilePlan; staged: { staged: string; display: string } }[] = [];
  for (const p of filePlans.filter((x) => x.replacesDir)) {
    try {
      stagedNew.push({ plan: p, staged: await broker.stageContent(abs(p.rel), p.content) });
    } catch (e) {
      report.failed.push({ path: p.rel, reason: (e as { code?: string }).code ?? "stage_failed" });
    }
  }
  // 4e 类型变化有失败：一个都不删。已完成的文件换目录保留新目录（命令的结果），旧文件放到可见恢复副本；暂存的新内容另存为冲突副本
  if (report.failed.length > 0) {
    for (const d of deletePlans) if (d.action !== "noop") report.kept.push({ path: d.rel, reason: "commit_incomplete" });
    for (const so of stagedOld) {
      const at = await broker.restoreStaged(so.staged).catch(() => so.staged.staged);
      report.kept.push({ path: so.dir, reason: "commit_incomplete", ...(at ? { at } : {}) });
    }
    for (const sn of stagedNew) await placeAsCopy(sn.plan.rel, sn.staged, "commit_incomplete");
    report.written.sort();
    return report;
  }
  // 4f 删除：深者先；文件若与本次写成或保持的对象相同（大小写/Unicode 别名）则不删；
  //    文件一律要求基线为文件并按基线身份比较—替换删除（复核 S3-17、第二轮复核 S3-24：基线缺失或类型不符即保留）；
  //    目录只用 rmdir 删已空的（原子判定）。
  //    先只删目录换文件的那几棵子树（落位需要），其余删除推迟到落位之后（抽查 S3-31：被移成这个名字的源文件不能先没了）。
  const runDelete = async (d: (typeof deletePlans)[number]): Promise<void> => {
    if (d.action === "noop") return;
    if (d.action === "keep") {
      report.kept.push({ path: d.rel, reason: d.reason ?? "conflict" });
      return;
    }
    try {
      const cur = await current(d.rel);
      if (!cur) return;
      if (!cur.isDirectory && keepIno.has(cur.ino)) return;
      if (cur.isDirectory && dirsSet.has(d.rel)) return; // 删后同名重建：最终仍是目录
      if (cur.isDirectory) {
        if (filePlans.some((p) => p.replacesDir && p.rel === d.rel)) return; // 目录换文件：在 4h 处理
        try {
          await broker.removeEmptyDir(abs(d.rel));
          report.deleted.push(d.rel);
        } catch (e) {
          if ((e as { code?: string }).code === "ENOTEMPTY") report.kept.push({ path: d.rel, reason: "directory_not_empty" });
          else throw e;
        }
        return;
      }
      const b = baseline.entries.get(d.rel);
      if (!b || b.type !== "file") {
        // 基线是目录（或不在基线里）而现在是文件：是写回期间别人放到这里的，不删
        report.kept.push({ path: d.rel, reason: "modified_during_commit" });
        return;
      }
      try {
        await broker.remove(abs(d.rel), { expect: { ino: b.ino, size: b.size, mtimeMs: b.mtimeMs } });
        report.deleted.push(d.rel);
      } catch (e) {
        if ((e as { code?: string }).code === "ECONFLICT") report.kept.push({ path: d.rel, reason: "modified_during_commit", ...keptAt(e) });
        else throw e;
      }
    } catch (e) {
      report.failed.push({ path: d.rel, reason: (e as { code?: string }).code ?? "remove_failed" });
    }
  };
  const inReplacedDir = (rel: string) => stagedNew.some(({ plan }) => rel === plan.rel || isUnder(rel, plan.rel));
  for (const d of deletePlans) if (inReplacedDir(d.rel)) await runDelete(d);
  // 4h 目录换文件：子树已删空后以 rmdir 删除空目录（原子判定），再把暂存的新内容不覆盖地落位；目录未空或已被占用 → 另存冲突副本；
  //    连冲突副本都放不下时内容留在保留区（说明给出位置），其余删除一律不做
  let stranded = false;
  for (const { plan: p, staged } of stagedNew) {
    try {
      const cur = await current(p.rel);
      if (cur?.isDirectory) {
        try {
          await broker.removeEmptyDir(abs(p.rel));
        } catch (e) {
          if ((e as { code?: string }).code === "ENOTEMPTY") {
            if (!(await placeAsCopy(p.rel, staged, "directory_not_empty"))) stranded = true;
            continue;
          }
          throw e;
        }
      }
      try {
        await broker.placeStaged(staged, abs(p.rel));
      } catch (e) {
        if ((e as { code?: string }).code === "EEXIST") {
          if (!(await placeAsCopy(p.rel, staged, "created_during_execution"))) stranded = true;
          continue;
        }
        throw e;
      }
      report.written.push(p.rel);
      const st = await broker.lstat(abs(p.rel)).catch(() => null);
      if (st) keepIno.add(st.ino);
    } catch (e) {
      report.failed.push({ path: p.rel, reason: (e as { code?: string }).code ?? "type_change_failed" });
      if (!(await placeAsCopy(p.rel, staged, "type_change_failed"))) stranded = true;
    }
  }
  // 4f（续）其余删除：落位后才做；有内容滞留保留区时一个都不删（源文件保留）
  for (const d of deletePlans) {
    if (inReplacedDir(d.rel)) continue;
    if (stranded && d.action !== "noop") {
      report.kept.push({ path: d.rel, reason: "commit_incomplete" });
      continue;
    }
    await runDelete(d);
  }
  // 4g 文件换目录已完成：丢弃暂存的旧文件（新目录与子文件已全部写成）
  for (const so of stagedOld) {
    await broker.discardStaged(so.staged).catch(() => {});
    report.deleted.push(so.dir);
  }
  // 4i 删后同名重建的目录
  for (const dir of [...cs.dirs].filter((x) => deletedSet.has(x)).sort((a, b) => a.split("/").length - b.split("/").length)) {
    try {
      const cur = await current(dir);
      if (cur?.isDirectory) continue;
      await broker.mkdir(abs(dir), { recursive: true });
      report.dirs.push(dir);
    } catch (e) {
      report.failed.push({ path: dir, reason: (e as { code?: string }).code ?? "mkdir_failed" });
    }
  }
  // 4j 大小写/Unicode 更名：同一对象，只改目录项写法
  for (const r of renames) {
    try {
      await broker.renameAlias(abs(r.from), abs(r.to));
      report.renamed.push(r);
    } catch (e) {
      report.failed.push({ path: r.to, reason: (e as { code?: string }).code ?? "rename_failed" });
    }
  }
  report.written.sort();
  return report;
}

const COMMIT_CONCURRENCY = 16;

async function eachLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(lanes);
}

/** 退出码：命令本身执行完毕，但对工作区的改动没有完整写回（冲突副本、保留未删、被拒绝或写入失败）。 */
export const EXIT_COMMIT_INCOMPLETE = 75;

const CONFLICT_TEXT: Record<string, string> = {
  modified_during_execution: "在命令运行期间已被修改",
  deleted_during_execution: "在命令运行期间已被删除",
  created_during_execution: "在命令运行期间已由其他操作建立（或改名到这里）",
  modified_during_commit: "在写回时刚被其他操作修改",
  type_change_failed: "无法完成类型变化",
  directory_not_empty: "是一个仍有内容的目录",
  commit_incomplete: "因其他改动写入失败未能落位",
};

/** 给模型看的简短说明（只在有冲突、拒绝、失败或更名时出现）。 */
export function describeReport(r: CommitReport, displayRoot: string): string {
  const lines: string[] = [];
  const show = (p: string) => (p === "*" ? "（全部改动）" : `${displayRoot}/${p}`);
  if (r.rejected.length > 0) {
    lines.push(`[执行域] 本次命令对工作区的改动未提交（${r.rejected.map((x) => `${show(x.path)}：${x.reason}`).join("；")}）。链接文件不可创建；单文件与总量有上限。`);
  }
  for (const c of r.conflicts) {
    const why = CONFLICT_TEXT[c.reason] ?? "与命令开始时的状态不一致";
    lines.push(
      c.copy
        ? `[执行域] ${show(c.path)} ${why}，未覆盖；本命令的结果另存为 ${show(c.copy)}。`
        : c.at
          ? `[执行域] ${show(c.path)} ${why}，本命令的结果未能另存，暂存在工作区保留区 ${c.at}（Agent 的文件工具看不到，须由律师处理）。`
          : `[执行域] ${show(c.path)} ${why}，本命令的结果未能另存。`,
    );
  }
  for (const k of r.kept) {
    const where = !k.at ? "" : /[\\/]\.kwl-/i.test(k.at) ? `原文件暂存在工作区保留区 ${k.at}（Agent 的文件工具看不到，须由律师处理）` : `原文件已另存为 ${k.at}`;
    lines.push(
      k.reason === "directory_not_empty"
        ? `[执行域] 目录 ${show(k.path)} 在命令运行期间有新内容，未删除。`
        : k.reason === "commit_incomplete"
          ? `[执行域] 部分改动写入失败，${show(k.path)} 未删除（避免移动或改名时丢失原文件）${where ? `；${where}` : ""}。`
          : `[执行域] ${show(k.path)} ${CONFLICT_TEXT[k.reason] ?? "与命令开始时的状态不一致"}，未删除${where ? `；${where}` : ""}。`,
    );
  }
  for (const f of r.failed) lines.push(`[执行域] ${show(f.path)} 提交失败（${f.reason}）。`);
  for (const m of r.renamed) lines.push(`[执行域] 已把 ${show(m.from)} 更名为 ${show(m.to)}。`);
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}
