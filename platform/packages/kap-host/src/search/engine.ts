/**
 * 宿主内检索（审计 S3 第 2 步；设计 docs/audit-2026-10-13/设计-工作区与会话落盘加密.md §5.2 2-5、2-6）。
 *
 * 工作区与材料快照在盘上是 KWE1 密文，原生 ripgrep 直接读盘只能读到密文——Grep/Glob 改由宿主在进程内检索：经文件 broker 遍历与读取
 * （逐级校验、解封、保留名不可见），输出与 ripgrep 15 在上游 Grep/Glob 实际生成的参数组合下逐字节一致（差分测试 search-diff.test.ts）。
 *
 * 支持的参数（只接受上游 grepTool.ts / globTool.ts 会生成的组合；其余报 ripgrep 风格的错误、退出码 2）：
 *   -j/--threads N（忽略）、--hidden、--max-columns N（只在不输出行内容的模式里出现，无影响）、--null、-g/--glob G、
 *   -l/--files-with-matches、--count-matches、-H/--with-filename、-i/--ignore-case、-n/--line-number、--field-context-separator S、
 *   -A/-B/-C N、-t/--type T、-U/--multiline、--multiline-dotall、--no-ignore、--files、--sortr=modified、--sort=path、--version、`--`。
 * 语义：忽略规则（.rgignore > .ignore > .gitignore〔仅在 git 仓库内〕> .git/info/exclude，含搜索路径的上级目录）、`--glob` 覆盖（最高优先）、
 *   文件类型、二进制检测（遍历到的文件：前 64 KiB 内有 NUL 即跳过，更靠后的 NUL 只检索其前的行；命令行直接给出的文件：NUL 当换行、
 *   行内容模式输出“binary file matches”）、BOM 与 UTF-16 转码、非多行模式逐行匹配（模式不能跨行）、上下文分组分隔 `--`（跨文件同样）。
 * 如实的差异：输出顺序按路径排序（ripgrep 多线程时顺序不定，上游自行排序）；正则差异见 regex.ts；单个文件超过 MAX_FILE_BYTES 不读、以错误结束
 * （检索不完整，上游显示说明）；忽略文件只读前 1 MiB、最多 1 万条规则；上级目录的忽略文件只读到区域根（ripgrep 读到文件系统根与全局 gitignore）。
 *
 * 宿主形态在 worker_thread 内运行（host-search.ts：kill 即 terminate）；在本线程运行时（测试）每个文件、每 2000 行让出一次事件循环，kill 在下一个让出点生效。
 */
import { posix, win32 } from "node:path";
import { basenameGlob, matchRules, parseGitignore, parseGitignoreLine, type GitignoreRule, type GlobMatch, type GlobTester } from "./glob.ts";
import { compilePattern, RegexSyntaxError, type CompiledPattern } from "./regex.ts";
import { typeGlobs } from "./types.ts";

export const HOST_SEARCH_VERSION = "ripgrep 15.0.0 (kwl host search)";
/** 单个文件的检索上限（明文）：更大的文件不检索。 */
export const MAX_FILE_BYTES = 256 * 1024 * 1024;
/** 输出上限：上游只读 10 MiB（MAX_OUTPUT_BYTES），超出即判截断——略多写一点后停止检索。 */
export const MAX_OUTPUT_BYTES = 10 * 1024 * 1024 + 64 * 1024;
const BINARY_SNIFF = 64 * 1024;
const MAX_IGNORE_FILE_BYTES = 1024 * 1024;

export interface SearchDirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

/** 检索所用的文件访问（宿主：文件 broker；测试：明文目录）。路径为宿主绝对路径。 */
export interface SearchFs {
  readdir(path: string): Promise<SearchDirEntry[]>;
  /** size 为内容（明文）长度。 */
  stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; mtimeMs: number; size: number }>;
  /** 读内容；给出 n 时只读 [offset, offset + n)（加密区只解所需分块）。 */
  read(path: string, n?: number, offset?: number): Promise<Uint8Array>;
  /** 搜索根在其所在区域内的上级目录（由外到内，不含自身）：读取其中的忽略文件。 */
  parentsWithinZone(path: string): string[];
}

export interface SearchIo {
  out(s: string): void;
  err(s: string): void;
  aborted(): boolean;
}

export interface SearchSpec {
  mode: "files" | "files_with_matches" | "count_matches" | "content";
  pattern: string | null;
  paths: string[];
  ignoreCase: boolean;
  lineNumber: boolean;
  withFilename: boolean;
  nullSep: boolean;
  before: number;
  after: number;
  globs: string[];
  types: string[];
  hidden: boolean;
  noIgnore: boolean;
  multiline: boolean;
  dotall: boolean;
  sortrModified: boolean;
  version: boolean;
}

export class ArgError extends Error {}

const VALUE_FLAGS: Record<string, string> = {
  "-j": "threads",
  "--threads": "threads",
  "--max-columns": "max-columns",
  "-M": "max-columns",
  "-g": "glob",
  "--glob": "glob",
  "--field-context-separator": "fcs",
  "-A": "after",
  "--after-context": "after",
  "-B": "before",
  "--before-context": "before",
  "-C": "context",
  "--context": "context",
  "-t": "type",
  "--type": "type",
  "--sortr": "sortr",
  "--sort": "sort",
  "-e": "regexp",
  "--regexp": "regexp",
};
const BOOL_FLAGS: Record<string, string> = {
  "--hidden": "hidden",
  "--null": "null",
  "-0": "null",
  "-l": "l",
  "--files-with-matches": "l",
  "--count-matches": "count-matches",
  "-H": "with-filename",
  "--with-filename": "with-filename",
  "-i": "i",
  "--ignore-case": "i",
  "-n": "n",
  "--line-number": "n",
  "-U": "U",
  "--multiline": "U",
  "--multiline-dotall": "dotall",
  "--no-ignore": "no-ignore",
  "--files": "files",
  "--version": "version",
  "-V": "version",
};

const num = (flag: string, v: string): number => {
  if (!/^\d+$/.test(v)) throw new ArgError(`invalid value '${v}' for '${flag}': invalid digit found in string`);
  return Number(v);
};

/** 解析参数（上游 Grep/Glob 生成的子集）。 */
export function parseArgs(argv: readonly string[]): SearchSpec {
  const spec: SearchSpec = {
    mode: "content",
    pattern: null,
    paths: [],
    ignoreCase: false,
    lineNumber: false,
    withFilename: false,
    nullSep: false,
    before: 0,
    after: 0,
    globs: [],
    types: [],
    hidden: false,
    noIgnore: false,
    multiline: false,
    dotall: false,
    sortrModified: false,
    version: false,
  };
  const positional: string[] = [];
  const explicit: string[] = [];
  let l = false;
  let countMatches = false;
  let files = false;
  const setValue = (flag: string, key: string, v: string) => {
    switch (key) {
      case "threads":
      case "max-columns":
        num(flag, v);
        return;
      case "glob":
        spec.globs.push(v);
        return;
      case "fcs":
        return; // 只影响行号与内容之间的分隔；不输出行号时无字段
      case "after":
        spec.after = num(flag, v);
        return;
      case "before":
        spec.before = num(flag, v);
        return;
      case "context":
        spec.before = spec.after = num(flag, v);
        return;
      case "type":
        if (!typeGlobs().has(v)) throw new ArgError(`unrecognized file type: ${v}`);
        spec.types.push(v);
        return;
      case "sortr":
        if (v !== "modified") throw new ArgError(`unsupported sort criterion for host search: ${v}`);
        spec.sortrModified = true;
        return;
      case "sort":
        if (v !== "path" && v !== "none") throw new ArgError(`unsupported sort criterion for host search: ${v}`);
        return;
      case "regexp":
        explicit.push(v);
        return;
    }
  };
  const setBool = (key: string) => {
    switch (key) {
      case "hidden":
        spec.hidden = true;
        break;
      case "null":
        spec.nullSep = true;
        break;
      case "l":
        l = true;
        break;
      case "count-matches":
        countMatches = true;
        break;
      case "with-filename":
        spec.withFilename = true;
        break;
      case "i":
        spec.ignoreCase = true;
        break;
      case "n":
        spec.lineNumber = true;
        break;
      case "U":
        spec.multiline = true;
        break;
      case "dotall":
        spec.dotall = true;
        break;
      case "no-ignore":
        spec.noIgnore = true;
        break;
      case "files":
        files = true;
        break;
      case "version":
        spec.version = true;
        break;
    }
  };
  let endOfOptions = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (endOfOptions || a === "-" || !a.startsWith("-")) {
      positional.push(a);
      continue;
    }
    if (a === "--") {
      endOfOptions = true;
      continue;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(0, eq) : a;
      if (VALUE_FLAGS[name]) {
        const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
        if (v === undefined) throw new ArgError(`a value is required for '${name}' but none was supplied`);
        setValue(name, VALUE_FLAGS[name]!, v);
        continue;
      }
      if (BOOL_FLAGS[name] && eq < 0) {
        setBool(BOOL_FLAGS[name]!);
        continue;
      }
      throw new ArgError(`unrecognized flag ${a}`);
    }
    // 短选项（可合并：-in；取值字母的值是余下字符或下一个参数）
    for (let k = 1; k < a.length; k++) {
      const f = `-${a[k]!}`;
      if (VALUE_FLAGS[f]) {
        const rest = a.slice(k + 1);
        const v = rest !== "" ? rest : argv[++i];
        if (v === undefined) throw new ArgError(`a value is required for '${f}' but none was supplied`);
        setValue(f, VALUE_FLAGS[f]!, v);
        break;
      }
      if (BOOL_FLAGS[f]) {
        setBool(BOOL_FLAGS[f]!);
        continue;
      }
      throw new ArgError(`unrecognized flag ${f}`);
    }
  }
  if (spec.version) return spec;
  if (files) {
    spec.mode = "files";
    spec.paths = positional;
  } else if (explicit.length > 0) {
    // -e/--regexp：全部位置参数都是路径；多个模式任一命中即可
    spec.pattern = explicit.length === 1 ? explicit[0]! : explicit.map((p) => `(?:${p})`).join("|");
    spec.paths = positional;
    spec.mode = l ? "files_with_matches" : countMatches ? "count_matches" : "content";
  } else {
    if (positional.length === 0) throw new ArgError("ripgrep requires at least one pattern to execute a search");
    spec.pattern = positional[0]!;
    spec.paths = positional.slice(1);
    spec.mode = l ? "files_with_matches" : countMatches ? "count_matches" : "content";
  }
  if (spec.dotall && !spec.multiline) spec.dotall = false;
  return spec;
}

interface IgNode {
  dir: string;
  custom: GitignoreRule[] | null;
  ignore: GitignoreRule[] | null;
  git: GitignoreRule[] | null;
  exclude: GitignoreRule[] | null;
  hasGit: boolean;
  parent: IgNode | null;
}

/** 文本解码：BOM（UTF-8 去除、UTF-16LE/BE 转码），其余按 UTF-8（非法序列替换为 U+FFFD）。 */
function decodeText(b: Uint8Array): string {
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder("utf-8").decode(b.subarray(3));
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b.subarray(2));
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b.subarray(2));
  return new TextDecoder("utf-8").decode(b);
}

const isUtf16Bom = (b: Uint8Array) => b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff));

export interface RunSearchContext {
  cwd: string;
  pathClass: "posix" | "win32";
  fs: SearchFs;
  io: SearchIo;
}

/** 运行一次检索；返回退出码（0 有结果、1 无结果、2 出错）。 */
export async function runSearch(argv: readonly string[], ctx: RunSearchContext): Promise<number> {
  const { io } = ctx;
  let spec: SearchSpec;
  try {
    spec = parseArgs(argv);
  } catch (e) {
    io.err(`rg: ${(e as Error).message}\n`);
    return 2;
  }
  if (spec.version) {
    io.out(`${HOST_SEARCH_VERSION}\n`);
    return 0;
  }
  let pat: CompiledPattern | null = null;
  if (spec.pattern !== null) {
    try {
      pat = compilePattern(spec.pattern, { ignoreCase: spec.ignoreCase, multiline: spec.multiline, dotall: spec.dotall });
    } catch (e) {
      io.err(`rg: ${e instanceof RegexSyntaxError ? e.message : String((e as Error)?.message ?? e)}\n`);
      return 2;
    }
  }
  let searcher: Searcher;
  try {
    searcher = new Searcher(spec, pat, ctx);
  } catch (e) {
    io.err(`rg: ${String((e as Error)?.message ?? e)}\n`);
    return 2;
  }
  return searcher.run();
}

class Searcher {
  private readonly p: typeof posix;
  private readonly sep: string;
  private readonly overrides: GitignoreRule[];
  private readonly whitelistOverrides: number;
  private readonly typeRes: GlobTester[];
  private outBytes = 0;
  private stopped = false;
  private matched = false;
  private error = false;
  private printedGroup = false;
  private lastSlice = Date.now();

  private readonly spec: SearchSpec;
  private readonly pat: CompiledPattern | null;
  private readonly ctx: RunSearchContext;

  constructor(spec: SearchSpec, pat: CompiledPattern | null, ctx: RunSearchContext) {
    this.spec = spec;
    this.pat = pat;
    this.ctx = ctx;
    this.p = ctx.pathClass === "win32" ? (win32 as unknown as typeof posix) : posix;
    this.sep = ctx.pathClass === "win32" ? "\\" : "/";
    this.overrides = [];
    let wl = 0;
    for (const g of spec.globs) {
      // --glob 与忽略文件同一语法；覆盖规则里“普通 glob”= 白名单、“!glob”= 忽略（与忽略文件相反）；语法错误由 runSearch 预检报出
      const r = parseGitignoreLine(g);
      if (!r) continue;
      this.overrides.push({ ...r, whitelist: !r.whitelist });
      if (!r.whitelist) wl += 1;
    }
    this.whitelistOverrides = wl;
    this.typeRes = spec.types.flatMap((t) => (typeGlobs().get(t) ?? []).map((g) => basenameGlob(g)));
  }

  private write(s: string): void {
    if (this.stopped) return;
    this.outBytes += Buffer.byteLength(s, "utf8");
    this.ctx.io.out(s);
    if (this.outBytes > MAX_OUTPUT_BYTES) this.stopped = true;
  }

  private async slice(): Promise<void> {
    if (Date.now() - this.lastSlice < 8) return;
    await new Promise((r) => setImmediate(r));
    this.lastSlice = Date.now();
  }

  private halted(): boolean {
    return this.stopped || this.ctx.io.aborted();
  }

  private absOf(display: string): string {
    return this.p.isAbsolute(display) ? display : this.p.resolve(this.ctx.cwd, display);
  }

  private joinDisplay(base: string, name: string): string {
    if (base === "") return name;
    return base.endsWith("/") || base.endsWith(this.sep) ? `${base}${name}` : `${base}${this.sep}${name}`;
  }

  /** 覆盖规则匹配用的路径：去掉开头的 ./；在 cwd 之下的绝对路径改为相对 cwd；分隔符统一为 /。 */
  private overridePath(display: string, abs: string): string {
    let p = display.replace(/^\.[\\/]/, "");
    if (this.p.isAbsolute(p)) {
      const rel = this.p.relative(this.ctx.cwd, abs);
      if (rel !== "" && !rel.startsWith("..") && !this.p.isAbsolute(rel)) p = rel;
    }
    return p.split("\\").join("/");
  }

  async run(): Promise<number> {
    const roots = this.spec.paths.length > 0 ? this.spec.paths : [""];
    const files: { display: string; abs: string; explicit: boolean }[] = [];
    for (const root of roots) {
      if (this.halted()) break;
      const display = root;
      const abs = root === "" ? this.ctx.cwd : this.absOf(root);
      let st: { isFile: boolean; isDirectory: boolean };
      try {
        st = await this.ctx.fs.stat(abs);
      } catch (e) {
        const shown = root === "" ? "." : root;
        this.ctx.io.err(`rg: ${shown}: IO error for operation on ${shown}: ${describeFsError(e)}\n`);
        this.error = true;
        continue;
      }
      if (st.isFile) {
        if (this.spec.mode === "files") files.push({ display, abs, explicit: true });
        else await this.searchFile(abs, display, true);
        continue;
      }
      if (!st.isDirectory) continue;
      const parentNode = await this.parentChain(abs);
      const node = await this.loadNode(abs, parentNode);
      await this.walk(abs, display, node, files);
    }
    if (this.spec.mode === "files") await this.listFiles(files);
    if (this.ctx.io.aborted()) return 143;
    return this.error ? 2 : this.matched ? 0 : 1;
  }

  private async listFiles(files: { display: string; abs: string }[]): Promise<void> {
    let list = files;
    if (this.spec.sortrModified) {
      const withTime: { f: (typeof files)[number]; t: number }[] = [];
      for (const f of files) {
        if (this.halted()) return;
        let t = 0;
        try {
          t = (await this.ctx.fs.stat(f.abs)).mtimeMs;
        } catch {
          // 读不到修改时间：排在最后
        }
        withTime.push({ f, t });
        await this.slice();
      }
      withTime.sort((a, b) => b.t - a.t || (a.f.display < b.f.display ? -1 : a.f.display > b.f.display ? 1 : 0));
      list = withTime.map((x) => x.f);
    }
    for (const f of list) {
      if (this.halted()) return;
      this.matched = true;
      this.write(`${f.display}${this.spec.nullSep ? "\0" : "\n"}`);
    }
  }

  /** 搜索根在区域内的上级目录：读其中的忽略文件（ripgrep 默认读取上级目录的忽略文件）。 */
  private async parentChain(abs: string): Promise<IgNode | null> {
    if (this.spec.noIgnore) return null;
    let node: IgNode | null = null;
    for (const dir of this.ctx.fs.parentsWithinZone(abs)) node = await this.loadNode(dir, node);
    return node;
  }

  private async readRules(path: string): Promise<GitignoreRule[] | null> {
    try {
      // 只读前 1 MiB（复核 S3B-B14：模型可写入超大忽略文件；规则数另有 1 万条上限）；截断时最后一行可能残缺，丢弃
      const bytes = await this.ctx.fs.read(path, MAX_IGNORE_FILE_BYTES, 0);
      return parseGitignore(decodeText(bytes), {
        truncated: bytes.length >= MAX_IGNORE_FILE_BYTES,
        onError: (line, msg) => this.ctx.io.err(`rg: ${path}: line ${line}: ${msg}\n`),
      });
    } catch {
      return null;
    }
  }

  private async loadNode(dir: string, parent: IgNode | null): Promise<IgNode> {
    if (this.spec.noIgnore) return { dir, custom: null, ignore: null, git: null, exclude: null, hasGit: false, parent };
    let names: SearchDirEntry[] = [];
    try {
      names = await this.ctx.fs.readdir(dir);
    } catch {
      names = [];
    }
    const has = (n: string, file: boolean) => names.some((e) => e.name === n && (file ? e.isFile : true));
    const gitEntry = names.find((e) => e.name === ".git" && !e.isSymbolicLink);
    return {
      dir,
      custom: has(".rgignore", true) ? await this.readRules(this.p.join(dir, ".rgignore")) : null,
      ignore: has(".ignore", true) ? await this.readRules(this.p.join(dir, ".ignore")) : null,
      git: has(".gitignore", true) ? await this.readRules(this.p.join(dir, ".gitignore")) : null,
      exclude: gitEntry?.isDirectory ? await this.readRules(this.p.join(dir, ".git", "info", "exclude")) : null,
      hasGit: !!gitEntry,
      parent,
    };
  }

  /** 忽略文件的判定（ignore crate matched_ignore）：由近及远，各类规则取第一个命中；.rgignore > .ignore > .gitignore > exclude。 */
  private matchIgnoreFiles(abs: string, isDir: boolean, node: IgNode): GlobMatch {
    let anyGit = false;
    for (let n: IgNode | null = node; n; n = n.parent) if (n.hasGit) anyGit = true;
    let custom: GlobMatch = null;
    let ignore: GlobMatch = null;
    let git: GlobMatch = null;
    let exclude: GlobMatch = null;
    let sawGit = false;
    for (let n: IgNode | null = node; n; n = n.parent) {
      const rel = this.p.relative(n.dir, abs).split("\\").join("/");
      if (custom === null && n.custom) custom = matchRules(n.custom, rel, isDir);
      if (ignore === null && n.ignore) ignore = matchRules(n.ignore, rel, isDir);
      if (anyGit && !sawGit && git === null && n.git) git = matchRules(n.git, rel, isDir);
      if (anyGit && !sawGit && exclude === null && n.exclude) exclude = matchRules(n.exclude, rel, isDir);
      sawGit = sawGit || n.hasGit;
    }
    return custom ?? ignore ?? git ?? exclude;
  }

  /** 遍历时的判定（ignore crate Ignore::matched）：覆盖规则最先；再忽略文件；再文件类型；再隐藏文件。返回是否跳过。 */
  private skipped(display: string, abs: string, isDir: boolean, node: IgNode): boolean {
    if (this.overrides.length > 0) {
      const m = matchRules(this.overrides, this.overridePath(display, abs), isDir);
      if (m === "ignore") return true;
      if (m === "whitelist") return false;
      if (m === null && !isDir && this.whitelistOverrides > 0) return true;
    }
    let whitelisted = false;
    if (!this.spec.noIgnore) {
      const m = this.matchIgnoreFiles(abs, isDir, node);
      if (m === "ignore") return true;
      if (m === "whitelist") whitelisted = true;
    }
    if (this.typeRes.length > 0 && !isDir) {
      const base = this.p.basename(abs);
      if (!this.typeRes.some((re) => re.test(base))) return true;
      whitelisted = true;
    }
    if (!whitelisted && !this.spec.hidden && this.p.basename(abs).startsWith(".")) return true;
    return false;
  }

  private async walk(dirAbs: string, dirDisplay: string, node: IgNode, files: { display: string; abs: string; explicit: boolean }[]): Promise<void> {
    let entries: SearchDirEntry[];
    try {
      entries = await this.ctx.fs.readdir(dirAbs);
    } catch (e) {
      const shown = dirDisplay === "" ? "." : dirDisplay;
      this.ctx.io.err(`rg: ${shown}: ${describeFsError(e)}\n`);
      this.error = true;
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (this.halted()) return;
      // 链接不跟随、不检索（与 ripgrep 默认一致；搜索范围内有链接时执行域路由已整体拒绝）
      if (e.isSymbolicLink || (!e.isFile && !e.isDirectory)) continue;
      const abs = this.p.join(dirAbs, e.name);
      const display = this.joinDisplay(dirDisplay, e.name);
      if (this.skipped(display, abs, e.isDirectory, node)) continue;
      if (e.isDirectory) {
        const child = await this.loadNode(abs, node);
        await this.walk(abs, display, child, files);
        continue;
      }
      if (this.spec.mode === "files") files.push({ display, abs, explicit: false });
      else await this.searchFile(abs, display, false);
      await this.slice();
    }
  }

  private async searchFile(abs: string, display: string, explicit: boolean): Promise<void> {
    if (this.halted()) return;
    // 先看大小再读（复核 S3B-B05）：超限的文件不整读整解；超限即“检索不完整”，以错误退出让上游显示（不静默漏检）
    let size: number;
    try {
      size = (await this.ctx.fs.stat(abs)).size;
    } catch (e) {
      this.ctx.io.err(`rg: ${display}: ${describeFsError(e)}\n`);
      this.error = true;
      return;
    }
    if (size > MAX_FILE_BYTES) {
      this.ctx.io.err(`rg: ${display}: 文件超过 ${MAX_FILE_BYTES / 1048576} MiB，宿主内检索未读取，结果不完整（请缩小搜索范围，或在 Bash 中逐行或分块处理）\n`);
      this.error = true;
      return;
    }
    let bytes: Uint8Array;
    try {
      if (!explicit && size > BINARY_SNIFF) {
        // 遍历到的文件：前 64 KiB 有 NUL 即整份跳过（与 ripgrep 的首块检测一致）——只解首块，不整读
        const head = await this.ctx.fs.read(abs, BINARY_SNIFF, 0);
        if (!isUtf16Bom(head) && head.indexOf(0) >= 0) return;
      }
      bytes = await this.ctx.fs.read(abs);
    } catch (e) {
      this.ctx.io.err(`rg: ${display}: ${describeFsError(e)}\n`);
      this.error = true;
      return;
    }
    // 二进制检测（与 ripgrep 一致）：遍历到的文件按 64 KiB 滚动读取，读到含 NUL 的那一块即停止——之前的完整行照常检索，
    // 行内容模式在末尾附“stopped searching binary file after match”，计数模式整份不输出；命令行直接给出的文件 NUL 当换行检索，
    // 行内容模式只输出“binary file matches”
    let binaryOffset = -1;
    let implicitBinary = -1;
    if (!isUtf16Bom(bytes)) {
      const nul = bytes.indexOf(0);
      if (nul >= 0) {
        if (explicit) binaryOffset = nul;
        else {
          implicitBinary = nul;
          // 多行模式整份读入：首 64 KiB 有 NUL 已在上面跳过；更靠后的 NUL 之前的完整行全部检索、行内容模式不附警告（实测 rg 15；复核 B 处置复核 N-03）
          bytes = bytes.subarray(0, this.spec.multiline ? bytes.lastIndexOf(0x0a, nul) + 1 : searchableBeforeNul(bytes, nul));
        }
      }
    }
    let text = decodeText(bytes);
    bytes = new Uint8Array(0);
    if (binaryOffset >= 0) text = text.split("\0").join("\n");
    const pat = this.pat!;
    if (!this.spec.multiline && !pat.mayMatch(text)) return;
    const lines = text.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const name = this.spec.withFilename || this.spec.mode === "files_with_matches" ? display : null;
    const nameSep = this.spec.nullSep ? "\0" : ":";
    if (this.spec.mode === "files_with_matches") {
      if (await this.anyMatch(lines, text)) {
        this.matched = true;
        this.write(`${display}${this.spec.nullSep ? "\0" : "\n"}`);
      }
      return;
    }
    if (this.spec.mode === "count_matches") {
      if (implicitBinary >= 0) return;
      let count = 0;
      const lastUnterminated = text.length > 0 && !text.endsWith("\n");
      if (this.spec.multiline) count = pat.count(text, lastUnterminated);
      else {
        for (let i = 0; i < lines.length; i++) {
          if (pat.test(lines[i]!)) count += pat.count(lines[i]!, lastUnterminated && i === lines.length - 1);
          if (i % 2000 === 1999) {
            if (this.halted()) return;
            await this.slice();
          }
        }
      }
      if (count > 0) {
        this.matched = true;
        this.write(name === null ? `${count}\n` : `${name}${nameSep}${count}\n`);
      }
      return;
    }
    // 行内容模式：命中行（可多行区间）+ 上下文
    const hit = new Uint8Array(lines.length);
    let any = false;
    if (this.spec.multiline) {
      // 匹配按位置递增给出：行指针单调前进，边找边标记（不物化全部匹配区间：复核 S3B-B03）
      let line = 0;
      let lineStart = 0;
      const advanceTo = (pos: number) => {
        while (line < lines.length - 1 && lineStart + lines[line]!.length + 1 <= pos) {
          lineStart += lines[line]!.length + 1;
          line += 1;
        }
      };
      pat.each(text, (s, e) => {
        if (lines.length === 0) return false;
        advanceTo(s);
        const a = line;
        let b = a;
        if (e > s) {
          let ls = lineStart;
          while (b < lines.length - 1 && ls + lines[b]!.length + 1 <= e - 1) {
            ls += lines[b]!.length + 1;
            b += 1;
          }
        }
        for (let k = a; k <= b && k < lines.length; k++) hit[k] = 1;
        any = true;
      });
    } else {
      for (let i = 0; i < lines.length; i++) {
        if (pat.test(lines[i]!)) {
          hit[i] = 1;
          any = true;
        }
        if (i % 2000 === 1999) {
          if (this.halted()) return;
          await this.slice();
        }
      }
    }
    if (!any) return;
    // 命令行直接给出的二进制文件 + 前置上下文（-B/-C）：ripgrep 不输出任何内容、不算命中（实测 15.0.0；只有 -A 时照常报告）
    if (binaryOffset >= 0 && this.spec.before > 0) return;
    this.matched = true;
    if (binaryOffset >= 0) {
      this.write(`${display}: binary file matches (found "\\0" byte around offset ${binaryOffset})\n`);
      return;
    }
    // 上下文线性判定（复核 S3B-B04）：倒序求“下一个命中行”，正序记“上一个命中行”，每行 O(1)
    const contextOn = this.spec.before > 0 || this.spec.after > 0;
    const next = contextOn ? new Int32Array(lines.length + 1) : null;
    if (next) {
      next[lines.length] = 2 ** 31 - 1;
      for (let i = lines.length - 1; i >= 0; i--) next[i] = hit[i] ? i : next[i + 1]!;
    }
    let lastHit = -1;
    let last = -2;
    let printed = false;
    for (let i = 0; i < lines.length; i++) {
      if (i % 2000 === 1999) {
        if (this.halted()) return;
        await this.slice();
      }
      let show = hit[i] === 1;
      if (show) lastHit = i;
      let ctxLine = false;
      if (!show && next) {
        show = (lastHit >= 0 && i - lastHit <= this.spec.after) || next[i]! - i <= this.spec.before;
        ctxLine = show;
      }
      if (!show) continue;
      if (contextOn && this.printedGroup && i !== last + 1) this.write("--\n");
      this.printedGroup = true;
      last = i;
      const num = this.spec.lineNumber ? `${i + 1}${ctxLine ? "-" : ":"}` : "";
      const prefix = name === null ? "" : `${name}${this.spec.nullSep ? "\0" : ctxLine ? "-" : ":"}`;
      this.write(`${prefix}${num}${lines[i]!}\n`);
      printed = true;
      if (this.halted()) return;
    }
    if (printed && implicitBinary >= 0 && !this.spec.multiline) this.write(`${display}: WARNING: stopped searching binary file after match (found "\\0" byte around offset ${implicitBinary})\n`);
  }

  private async anyMatch(lines: string[], text: string): Promise<boolean> {
    if (this.spec.multiline) return this.pat!.any(text);
    for (let i = 0; i < lines.length; i++) {
      if (this.pat!.test(lines[i]!)) return true;
      if (i % 2000 === 1999) {
        if (this.halted()) return false;
        await this.slice();
      }
    }
    return false;
  }
}

/**
 * ripgrep 的二进制检测位置（遍历到的文件，“遇 NUL 即停”）：缓冲容量 64 KiB，每次检索缓冲里的完整行、把不完整的行留到下一次，
 * 下一次读入填满剩余容量；新读入的一块里有 NUL 即停止。返回已检索部分的字节长度（总在行尾）。一行超过缓冲时缓冲加倍。
 */
function searchableBeforeNul(bytes: Uint8Array, nul: number): number {
  let searched = 0;
  let readPos = 0;
  let cap = BINARY_SNIFF;
  for (;;) {
    const readEnd = Math.min(bytes.length, searched + cap);
    if (readEnd <= readPos) {
      cap *= 2;
      continue;
    }
    if (nul < readEnd) return searched;
    readPos = readEnd;
    const nl = bytes.lastIndexOf(0x0a, readPos - 1);
    if (nl >= searched) searched = nl + 1;
    else cap *= 2;
  }
}

function describeFsError(e: unknown): string {
  const code = (e as { code?: string })?.code;
  if (code === "ENOENT") return "No such file or directory (os error 2)";
  // 加密区里读不出的文件（复核 S3B-B11）：给出能直接指导处置的说明
  if (code === "EIO" || (e as { name?: string })?.name === "AtRestError") {
    return `无法解密读取（工作区或材料里出现了外部写入的明文、已损坏或格式不符的文件；请移除或重新生成该文件后再检索）：${String((e as Error)?.message ?? e)}`;
  }
  return String((e as Error)?.message ?? e);
}
