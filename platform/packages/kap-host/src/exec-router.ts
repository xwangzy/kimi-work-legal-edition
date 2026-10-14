/**
 * 执行域路由（v9 第 04 篇 §4.1 路由规则；作为 Kimi Code `IHostProcessService` 的种子注入）。
 *
 * 锁版中经进程服务的调用方与路由：
 * | 调用方 | 请求 | 路由 |
 * | Bash 工具、用户直接 shell | spawn(shellPath, ['-c', cmd]) | 执行域（默认 W-core）；执行域不可用 → 拒绝。解析并校验上游拼接的 `cd '<shell 形式路径>' &&`
 * |                         |                              | 前缀：目录必须在本事项工作区内（broker 逐级校验），否则拒绝 |
 * | Grep / Glob | spawn(rg, args) | 宿主内检索（审计 S3 第 2 步：工作区与材料快照是密文，原生 rg 读不了）：经文件 broker 遍历与解封，
 * |             |                 | 输出与 ripgrep 一致（search/engine.ts）；拒绝 -L/--follow/--pre/--search-zip 等；cwd 与路径参数必须落在本事项
 * |             |                 | 工具可寻址区（broker 校验），相对路径按上游给出的 cwd 解析（Glob 以搜索根为 cwd）；不再拉起任何原生进程 |
 * | git 上下文、MCP stdio、外部 hooks、插件守护进程、其他 | 任意可执行文件 | 拒绝并记审计 |
 *
 * 不可降级：任何情况下不在执行域之外运行模型生成的代码；执行域不可用时代码执行关闭，只运行可信工具（第 02 篇 §9.10）。
 */
import { isAbsolute, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { ZoneKeysOfPurpose } from "@zr-legal/at-rest";
import type { FileBroker } from "@zr-legal/file-broker";
import { spawnHostSearch, type SearchZoneSpec } from "./search/host-search.ts";
import { TOOL_ZONES } from "./tool-table.ts";

export type PathClass = "posix" | "win32";

export interface HostProcessLike {
  readonly _serviceBrand: undefined;
  readonly pid: number;
  readonly exitCode: number | null;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  wait(): Promise<number>;
  kill(signal?: NodeJS.Signals): Promise<void>;
  dispose(): void | Promise<void>;
}

export interface SpawnOptionsLike {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
}

/** 执行域（W-core = just-bash + 零 JS 桥 CPython；N = MXC）。 */
export interface ExecutionDomain {
  readonly id: "W-core" | "W-data" | "N" | "none";
  /** 设备页与能力账本上的如实标注。 */
  readonly label: string;
  run(command: string, opts: { cwd: string; env: Record<string, string> }): Promise<HostProcessLike>;
  /** 终止本事项全部在途执行（运行取消、超时、失败时的取消传播）。 */
  abortAll?(reason: string): void;
  /** 执行域健康：null = 可用；否则为最近一次不可用的原因（W 进程拉起或自检失败；复核 S3-23）。 */
  health?(): string | null;
  /** 同一事项可同时运行的命令数（模型可见说明按此如实给出）。 */
  readonly concurrency?: number;
  close?(): Promise<void>;
}

/** 按事项创建执行域（W 的挂载与授权随事项目录而定）；创建或自检失败即保持“不可用”（失败关闭，不降级）。 */
export interface ExecDomainContext {
  matterId: string;
  broker: FileBroker;
  /** 工作区在 broker 中的区域名与宿主根目录。 */
  workZone: string;
  workDir: string;
  /** 只读挂载：材料快照、（可选）可信区。 */
  readOnlyRoots: string[];
  /** 落盘加密（审计 S3 第 2 步）：工作区与只读挂载（按根目录）的区密钥；执行域读层据此解封。 */
  sealed?: { work?: ZoneKeysOfPurpose; readOnly?: Record<string, ZoneKeysOfPurpose>; strict: boolean };
  /** 引擎 homeDir（宿主私有；执行域的任务临时目录放在这里）。 */
  homeDir: string;
  pathClass: PathClass;
  onEvent?: (e: { type: string } & Record<string, unknown>) => void;
}

export interface ExecDomainFactory {
  readonly id: ExecutionDomain["id"];
  readonly label: string;
  create(ctx: ExecDomainContext): Promise<ExecutionDomain>;
}

/** shell 形式路径 → 宿主路径（上游 shellPathBridge.fromShellPath 的盘符形式；POSIX 原样）。 */
export function fromShellPath(p: string, pathClass: PathClass): string {
  if (pathClass !== "win32") return p;
  if (p.startsWith("//")) return p.replaceAll("/", "\\");
  const m = /^\/([a-zA-Z])(?:\/|$)/.exec(p);
  if (m) {
    const rest = p.slice(2).replaceAll("/", "\\");
    return `${m[1]!.toUpperCase()}:${rest === "" ? "\\" : rest}`;
  }
  return p;
}

/** 上游 Bash 工具拼接的前缀：`cd '<shellCwd>' && <command>`（shellQuote：单引号内的 ' 写作 '\''）。 */
const CD_PREFIX = /^cd '((?:[^']|'\\'')*)' && /;

export function parseCdPrefix(script: string, pathClass: PathClass): { shellCwd: string; hostPath: string } | null {
  const m = CD_PREFIX.exec(script);
  if (!m) return null;
  const shellCwd = m[1]!.replaceAll("'\\''", "'");
  return { shellCwd, hostPath: fromShellPath(shellCwd, pathClass) };
}

/** 执行域不可用时的写死退路（第 04 篇 §11 P2 退路）：代码执行关闭，只运行可信工具。 */
export const UNAVAILABLE_DOMAIN: ExecutionDomain = {
  id: "none",
  label: "未隔离：不运行代码（只运行可信工具）",
  async run(): Promise<HostProcessLike> {
    throw routerError("execution_domain_unavailable", "代码运行不可用：执行域未就绪。不会在执行域之外运行模型生成的代码。");
  },
};

export interface RouterAudit {
  at: string;
  caller: "bash" | "rg" | "denied";
  command: string;
  argsSummary: string;
  outcome: "routed" | "denied";
  reason?: string;
}

const RG_FORBIDDEN = [
  /^-L$/,
  /^--follow$/,
  /^--pre(=|$)/,
  /^--pre-glob(=|$)/,
  /^-z$/,
  /^--search-zip$/,
  /^--ignore-file(=|$)/,
  /^--no-config$/, // 无害但不需要（我们不透传 RIPGREP_CONFIG_PATH）
  /^--hostname-bin(=|$)/,
  /^--debug$/,
  /^--trace$/,
];

/** 只接受这些短/长选项“带一个值”（值不是路径）；其余未知选项在 rg 自身校验中处理。 */
const RG_VALUE_FLAGS = new Set([
  "-e", "--regexp", "-g", "--glob", "--iglob", "-t", "--type", "-T", "--type-not", "-m", "--max-count",
  "-A", "--after-context", "-B", "--before-context", "-C", "--context", "-M", "--max-columns",
  "--max-filesize", "--sort", "--sortr", "--field-context-separator", "--field-match-separator",
  "--color", "--colors", "--engine", "-j", "--threads", "--max-depth", "-d", "--path-separator",
  "--type-add", "--encoding", "-E", "--context-separator", "-r", "--replace",
]);

function routerError(code: string, message: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

export interface ExecRouterDeps {
  broker: FileBroker;
  workDir: string;
  /** 执行域占位 shell 路径（种子化环境服务返回的 shellPath；Bash 工具以它为 command）。 */
  shellPath: string;
  /**
   * 检索入口（审计 S3 第 2 步）：上游 Grep/Glob 以它为 rg 的 command（ZP-20 rgLocator 只认宿主登记的这一个路径，须是已存在的普通文件）；
   * 路由按字面匹配后交宿主内检索，**从不交给操作系统执行**。null = Grep/Glob 不可用（失败关闭）。
   */
  trustedRgPath: string | null;
  pathClass?: PathClass;
  /**
   * 运行 fencing（审查 S3-07）：返回 null 表示本事项有进行中的运行、允许启动进程；否则返回拒绝原因。
   * 宿主策略在运行终态时已解绑会话，但在此之前已获批、spawn 晚到的调用只有这里拦得住。
   */
  execAllowed?: () => string | null;
}

export class ExecRouter {
  readonly _serviceBrand = undefined;
  readonly audit: RouterAudit[] = [];
  private domain: ExecutionDomain = UNAVAILABLE_DOMAIN;
  private readonly deps: ExecRouterDeps;

  constructor(deps: ExecRouterDeps) {
    this.deps = deps;
  }

  setDomain(domain: ExecutionDomain): void {
    this.domain = domain;
  }

  currentDomain(): ExecutionDomain {
    return this.domain;
  }

  private log(entry: Omit<RouterAudit, "at">): void {
    this.audit.push({ at: new Date().toISOString(), ...entry });
    if (this.audit.length > 2000) this.audit.splice(0, 500);
  }

  async spawn(command: string, args: readonly string[] = [], options: SpawnOptionsLike = {}): Promise<HostProcessLike> {
    const fence = this.deps.execAllowed?.() ?? null;
    if (fence !== null && (command === this.deps.shellPath || command === this.deps.trustedRgPath)) {
      this.log({ caller: "denied", command: basenameOf(command), argsSummary: `${args.length} args`, outcome: "denied", reason: fence });
      throw routerError("spawn_denied", `进程启动被拒绝：本事项没有进行中的运行（${fence}）`);
    }
    if (command === this.deps.shellPath) {
      if (args.length !== 2 || args[0] !== "-c" || typeof args[1] !== "string") {
        this.log({ caller: "denied", command, argsSummary: `${args.length} args`, outcome: "denied", reason: "shell_form" });
        throw routerError("spawn_denied", "执行域只接受 `shell -c <命令>` 形式");
      }
      // 上游以 `cd '<cwd>' && ` 开头；cwd 必须在本事项工作区内（与宿主策略的 cwd 检查一致，这里是第二道）
      const parsed = parseCdPrefix(args[1], this.deps.pathClass ?? (process.platform === "win32" ? "win32" : "posix"));
      const cwd = parsed ? parsed.hostPath : this.deps.workDir;
      const loc = this.deps.broker.locate(cwd);
      let reason: string | null = !loc || loc.zone.name !== "work" ? "bash_cwd_outside_workspace" : null;
      if (!reason) {
        try {
          await this.deps.broker.realpath(cwd);
        } catch {
          reason = "bash_cwd_unavailable";
        }
      }
      if (reason) {
        this.log({ caller: "denied", command: "shell -c", argsSummary: `${args[1].length} chars`, outcome: "denied", reason });
        throw routerError("spawn_denied", `执行域拒绝：命令的工作目录必须在本事项工作区内（${reason}）`);
      }
      this.log({ caller: "bash", command: "shell -c", argsSummary: `${args[1].length} chars`, outcome: "routed" });
      return this.domain.run(args[1], { cwd, env: {} });
    }
    if (this.deps.trustedRgPath && command === this.deps.trustedRgPath) {
      const reason = await this.checkRgArgs(args, options.cwd);
      if (reason) {
        this.log({ caller: "denied", command: "rg", argsSummary: args.filter((a) => a.startsWith("-")).join(" "), outcome: "denied", reason: reason.split(" ")[0]! });
        throw routerError(
          "spawn_denied",
          reason.startsWith("link_present")
            ? `搜索被拒绝：事项区内存在链接文件（${reason.slice("link_present ".length)}），不读取可能指向事项外的内容；请移除该链接后重试`
            : `可信 ripgrep 参数被拒绝：${reason}`,
        );
      }
      this.log({ caller: "rg", command: "rg", argsSummary: args.filter((a) => a.startsWith("-")).join(" "), outcome: "routed" });
      const pathClass = this.deps.pathClass ?? (process.platform === "win32" ? "win32" : "posix");
      return spawnHostSearch(args, { cwd: this.searchCwd(options.cwd), zones: this.searchZones(), pathClass });
    }
    this.log({ caller: "denied", command: basenameOf(command), argsSummary: `${args.length} args`, outcome: "denied", reason: "not_routable" });
    throw routerError("spawn_denied", `进程启动被拒绝（执行域路由白名单外）：${basenameOf(command)}`);
  }

  /**
   * 检索 worker 重建只读 broker 用的区描述：只取工具可寻址区（work、materials、trusted），区密钥取自各区编解码器（宿主本就持有）。
   * 区编解码器不能导出（非 @zr-legal/at-rest 的实现）即不交给检索——宁可读不到也不在 worker 里明文直读密文区。
   */
  private searchZones(): SearchZoneSpec[] {
    const out: SearchZoneSpec[] = [];
    for (const z of this.deps.broker.zones()) {
      if (!TOOL_ZONES.has(z.name)) continue;
      const wire = z.codec ? (z.codec as { toWire?: () => SearchZoneSpec["keys"] }).toWire?.() : undefined;
      if (z.codec && !wire) continue;
      out.push({ name: z.name, root: z.root, ...(z.strict ? { strict: true } : {}), ...(z.chunkedOnly ? { chunkedOnly: true } : {}), ...(wire ? { keys: wire } : {}) });
    }
    return out;
  }

  /** 检索的 cwd：上游给出的 cwd（Glob = 搜索根）按工作区解析；未给出即事项工作区。区域校验在 checkRgArgs。 */
  private searchCwd(cwd: string | undefined): string {
    if (cwd === undefined) return this.deps.workDir;
    return isAbsolute(cwd) ? cwd : resolve(this.deps.workDir, cwd);
  }

  /**
   * 可信 rg 参数检查（审查 S2-06）：
   * 1) 先完整切分：长选项（含 `--x=v`）、合并短选项（如 `-ie <模式>`、`-eroot`：遇到取值字母时，余下字符或下一个参数是它的值）、
   *    `--` 之后一律是位置参数；任何位置出现 `-e/--regexp` 都使全部位置参数成为路径；
   * 2) 禁止跟随链接、预处理器、压缩包、模式文件；
   * 3) cwd 与每个路径参数都经 broker 逐级 lstat（与文件读写同一实现）：必须落在工具可寻址区，任何一级是链接即拒（ripgrep 会跟随命令行上给出的链接）。
   * 上游 Grep/Glob 以绝对路径传搜索路径，所以区内绝对路径放行（经逐级校验）；`..` 一律拒绝。
   */
  private async checkRgArgs(args: readonly string[], cwd: string | undefined): Promise<string | null> {
    const positional: string[] = [];
    let explicitPattern = false;
    let filesMode = false;
    let endOfOptions = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (endOfOptions) {
        positional.push(a);
        continue;
      }
      if (a === "--") {
        endOfOptions = true;
        continue;
      }
      if (a.startsWith("--")) {
        if (RG_FORBIDDEN.some((re) => re.test(a))) return `forbidden_flag ${a}`;
        const name = a.split("=")[0]!;
        if (name === "--file") return "pattern_file_not_allowed";
        if (name === "--files" || name === "--type-list") filesMode = true;
        if (name === "--regexp") explicitPattern = true;
        if (RG_VALUE_FLAGS.has(name) && !a.includes("=")) i += 1; // 值在下一个参数
        continue;
      }
      if (a.startsWith("-") && a.length > 1) {
        if (RG_FORBIDDEN.some((re) => re.test(a))) return `forbidden_flag ${a}`;
        const letters = a.slice(1);
        for (let k = 0; k < letters.length; k++) {
          const ch = letters[k]!;
          if (ch === "L") return "forbidden_flag -L";
          if (ch === "z") return "forbidden_flag -z";
          if (ch === "f") return "pattern_file_not_allowed";
          if (ch === "e") explicitPattern = true;
          if (RG_VALUE_FLAGS.has(`-${ch}`)) {
            if (k === letters.length - 1) i += 1; // 值是下一个参数
            break; // 否则余下字符就是值
          }
        }
        continue;
      }
      positional.push(a);
    }
    const paths = !filesMode && !explicitPattern ? positional.slice(1) : positional;
    const base = this.searchCwd(cwd);
    const candidates: string[] = [base];
    const searchRoots: string[] = [];
    for (const p of paths) {
      if (p.split(/[\\/]+/).includes("..")) return "parent_traversal";
      // 相对路径按检索的 cwd 解析（Glob 以搜索根为 cwd、路径为 "."；复核发现旧实现固定按工作区解析，Glob 在材料区列出的是工作区）
      const abs = isAbsolute(p) ? p : resolve(base, p);
      candidates.push(abs);
      searchRoots.push(abs);
    }
    if (searchRoots.length === 0) searchRoots.push(base);
    const missing = new Set<string>();
    for (const abs of candidates) {
      const loc = this.deps.broker.locate(abs);
      if (!loc || !TOOL_ZONES.has(loc.zone.name)) return "path_outside_matter";
      try {
        await this.deps.broker.realpath(abs); // 逐级 lstat：链接一律拒绝
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "ELOOP") return "symlink_not_allowed";
        // 区内但不存在的搜索路径交给检索按 ripgrep 的形状报“No such file or directory”（复核 S3B-B20）；cwd 不存在仍拒绝
        if (code === "ENOENT" && abs !== candidates[0]) {
          missing.add(abs);
          continue;
        }
        return "path_unavailable";
      }
    }
    // 审查 S2-14：搜索范围内出现任何链接即拒绝（与 broker、执行域的处理一致；宿主内检索本身经 broker 读取，链接也读不到——
    // 这里整体拒绝是为了如实告诉律师“有区外写入者放了链接”）
    for (const abs of searchRoots) {
      if (missing.has(abs)) continue;
      try {
        const { links, truncated } = await this.deps.broker.findLinks(abs);
        if (truncated) return "too_many_entries";
        if (links.length > 0) return `link_present ${links[0]}`;
      } catch {
        return "path_unavailable";
      }
    }
    return null;
  }
}

function basenameOf(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}
