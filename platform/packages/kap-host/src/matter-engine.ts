/**
 * 事项引擎（v9 第 04 篇 §3.2）：每个事项一份 kap-server 嵌入实例与一份种子。
 *
 * 目录（全部由宿主给定，不由 Agent 决定）：
 * - homeDir：引擎自身状态（会话存储、事件日志、索引）。其中引擎经 IHostFileSystem 读写的会话内部目录（`<home>/sessions`）
 *   是 broker 的 engine 区，**只供引擎内部使用**——宿主策略与执行域路由不把它当作工具可寻址区，Agent 的文件工具够不到；
 * - materials（只读）：本事项授权材料的快照；work（可写）：事项工作区 = 会话 cwd；trusted（只读，可选）：签名方法包、
 *   律所批准技能与工作区指令（ZP-18 trustedInstructionsDir 指向这里）；
 * - 可信配置（config.toml / mcp.json）只在内存中（engine-config.ts）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { arch, release } from "node:os";
import { join } from "node:path";
import { FileBroker, type ZoneSpec } from "@zr-legal/file-broker";
import type { ManifestRegistry } from "@zr-legal/host-policy";
import { createEmbeddedServer, type EmbeddedServer, type EventEnvelope } from "../vendor/kap-embed/kap-embed.mjs";
import type { MatterKeyRing } from "@zr-legal/at-rest";
import { MemoryQueryStore } from "./memory-query-store.ts";
import { migrateHomeDir, migrateWorkDir, SealedFileStorageService, sealedJournalIo } from "./sealed-storage.ts";
import { buildEngineConfig, trustedConfigPath, trustedConfigStore, type EngineConfig } from "./engine-config.ts";
import { ExecRouter, type ExecDomainFactory, type ExecutionDomain } from "./exec-router.ts";
import { KapClient } from "./kap-client.ts";
import { HostPolicy, type HostPolicyDeps, type PolicyDecisionRecord } from "./policy.ts";
import { matterSeeds, placeholderShellPath } from "./seeds.ts";

export interface MatterEngineOptions {
  matterId: string;
  /** 引擎 homeDir（宿主私有；不在 broker 区域内）。 */
  homeDir: string;
  materialsDir: string;
  workDir: string;
  /** 签名方法包与只读可信配置区（可选）。 */
  trustedDir?: string | undefined;
  manifests: ManifestRegistry;
  /** 法律 MCP 对本事项开放的工具（服务端原名）；空 = 不配置 MCP。 */
  legalMcpTools?: readonly string[];
  trustedRgPath: string | null;
  /** 固定执行域（测试用）；与 execDomainFactory 二选一。 */
  execDomain?: ExecutionDomain | undefined;
  /** 按事项创建执行域（W-core 默认）；创建或自检失败即保持不可用（失败关闭）。 */
  execDomainFactory?: ExecDomainFactory | undefined;
  onExecEvent?: (e: { type: string } & Record<string, unknown>) => void;
  /** 运行 fencing（审查 S3-07）：null = 本事项有进行中的运行。 */
  execAllowed?: () => string | null;
  searchConfigured?: boolean;
  fetchConfigured?: boolean;
  /** 只供测试：上下文窗口（见 EngineConfigSpec.testMaxContextSize）。 */
  testMaxContextSize?: number | undefined;
  onDecision?: (r: PolicyDecisionRecord) => void;
  /** 检索式预筛（内核提供；见 HostPolicyDeps.screenSearch）。 */
  screenSearch?: HostPolicyDeps["screenSearch"];
  logLevel?: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  /**
   * 落盘加密（审计 S3 第 1、2 步）：事项工作区密钥环（内核下发的区密钥）。给出即引擎会话、事件日志、引擎状态区、**工作区与材料快照**
   * 以密文落盘（严格形态：存量明文在打开前迁移，此后区内出现的明文一律拒读）；Grep/Glob 经宿主内检索解密读取，执行域读层解密。
   * 未给出 = 开发形态（明文，内核以 atRest="off" 声明；安装包形态必须给出，否则宿主拒绝运行）。
   */
  keyring?: MatterKeyRing | undefined;
}

const HOST_IDENTITY = Object.freeze({
  productName: "KimiWorkLegal",
  version: "9.0.0-g0",
  platform: "kwl_kap_host",
  displayName: "Kimi Work 法律发行版",
});

function osKind(): string {
  return process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : process.platform === "linux" ? "Linux" : process.platform;
}

export class MatterEngine {
  readonly matterId: string;
  readonly homeDir: string;
  readonly workDir: string;
  readonly materialsDir: string;
  readonly broker: FileBroker;
  readonly router: ExecRouter;
  readonly policy: HostPolicy;
  readonly config: EngineConfig;
  readonly kap: KapClient;
  /** 可信区里已验签的方法模板名（过程快照只记录这些名字的加载）。 */
  readonly skillNames: ReadonlySet<string>;
  /** 执行域创建失败的原因（null = 未配置或已就绪）。 */
  private readonly initialExecDomainError: string | null;
  private readonly server: EmbeddedServer;
  private readonly ownedDomain: ExecutionDomain | null;

  private constructor(o: {
    matterId: string;
    homeDir: string;
    workDir: string;
    materialsDir: string;
    broker: FileBroker;
    router: ExecRouter;
    policy: HostPolicy;
    config: EngineConfig;
    server: EmbeddedServer;
    ownedDomain: ExecutionDomain | null;
    execDomainError: string | null;
    skillNames: ReadonlySet<string>;
  }) {
    this.matterId = o.matterId;
    this.homeDir = o.homeDir;
    this.workDir = o.workDir;
    this.materialsDir = o.materialsDir;
    this.broker = o.broker;
    this.router = o.router;
    this.policy = o.policy;
    this.config = o.config;
    this.server = o.server;
    this.kap = new KapClient(o.server);
    this.ownedDomain = o.ownedDomain;
    this.initialExecDomainError = o.execDomainError;
    this.skillNames = o.skillNames;
  }

  static async open(o: MatterEngineOptions): Promise<MatterEngine> {
    for (const d of [o.homeDir, o.materialsDir, o.workDir]) mkdirSync(d, { recursive: true });
    const homeDir = realpathSync.native(o.homeDir);
    const materialsDir = realpathSync.native(o.materialsDir);
    const workDir = realpathSync.native(o.workDir);
    // 引擎自身经 IHostFileSystem 读写的会话内部状态（例如计划文件 sessions/<wd>/<session>/agents/main/plans）：
    // 单独一个区，供引擎内部使用；宿主策略与执行域路由把它判为工具不可寻址（TOOL_ZONES 之外），Agent 的文件工具够不到
    const engineStateDir = join(homeDir, "sessions");
    mkdirSync(engineStateDir, { recursive: true });
    // 落盘加密（审计 S3 第 1、2 步）：引擎打开前先把引擎状态目录与工作区里的存量明文改写为密文、删除可丢弃的明文（日志、查询库、
    // broker 临时文件与回收区）；材料快照由宿主每次运行以密文重写、运行结束即删除
    if (o.keyring) {
      await migrateHomeDir(homeDir, { engineFs: o.keyring.zone("engine_fs"), journal: o.keyring.zone("engine_journal") });
      await migrateWorkDir(workDir, o.keyring.zone("work"));
    }
    // 工作区与材料快照只接受分块格式（复核 S3B-A04）；引擎状态区另有存储服务写的追加日志
    const sealedZone = (p: "materials" | "work" | "engine_fs") => (o.keyring ? { codec: o.keyring.zone(p), strict: true, ...(p === "engine_fs" ? {} : { chunkedOnly: true }) } : {});
    const zones: ZoneSpec[] = [
      { name: "materials", root: materialsDir, access: "ro", ...sealedZone("materials") },
      { name: "work", root: workDir, access: "rw", ...sealedZone("work") },
      { name: "engine", root: realpathSync.native(engineStateDir), access: "rw", ...sealedZone("engine_fs") },
    ];
    if (o.trustedDir) zones.push({ name: "trusted", root: realpathSync.native(o.trustedDir), access: "ro" });
    const broker = new FileBroker(zones);
    const pathClass = process.platform === "win32" ? "win32" : "posix";
    const shellPath = placeholderShellPath(pathClass);
    const router = new ExecRouter({ broker, workDir, shellPath, trustedRgPath: o.trustedRgPath, pathClass, ...(o.execAllowed ? { execAllowed: o.execAllowed } : {}) });
    const trustedRoot = o.trustedDir ? realpathSync.native(o.trustedDir) : null;
    let ownedDomain: ExecutionDomain | null = null;
    let execDomainError: string | null = null;
    if (o.execDomain) router.setDomain(o.execDomain);
    else if (o.execDomainFactory) {
      try {
        ownedDomain = await o.execDomainFactory.create({
          matterId: o.matterId,
          broker,
          workZone: "work",
          workDir,
          readOnlyRoots: [materialsDir, ...(trustedRoot ? [trustedRoot] : [])],
          // 执行域读层解密（审计 S3 第 2 步）：只给工作区与材料两把区密钥（可信区是签名公开的方法包，不加密）
          ...(o.keyring ? { sealed: { work: o.keyring.zone("work").toWire(), readOnly: { [materialsDir]: o.keyring.zone("materials").toWire() }, strict: true } } : {}),
          homeDir,
          pathClass,
          ...(o.onExecEvent ? { onEvent: o.onExecEvent } : {}),
        });
        router.setDomain(ownedDomain);
      } catch (e) {
        // 失败关闭：Bash 不可见、宿主策略拒绝；不在执行域之外运行代码
        execDomainError = (e as Error)?.message ?? String(e);
      }
    }
    const policy = new HostPolicy({
      broker,
      workDir,
      manifests: o.manifests,
      // 复核 S3-23：执行域在运行中变得不可用（W 进程拉起或自检失败）时，宿主策略随之拒绝 Bash（失败关闭）
      execDomainAvailable: () => router.currentDomain().id !== "none" && !router.currentDomain().health?.(),
      ...(o.onDecision ? { onDecision: o.onDecision } : {}),
      ...(o.screenSearch ? { screenSearch: o.screenSearch } : {}),
    });
    const config = buildEngineConfig({
      matterId: o.matterId,
      execDomainAvailable: router.currentDomain().id !== "none",
      legalMcpTools: o.legalMcpTools ?? [],
      searchConfigured: o.searchConfigured ?? false,
      fetchConfigured: o.fetchConfigured ?? false,
      testMaxContextSize: o.testMaxContextSize,
    });
    const virtualFiles = new Map<string, string>();
    if (config.mcpJson) virtualFiles.set(join(homeDir, "mcp.json"), config.mcpJson);
    // 模型可见的执行环境说明（第 04 篇 §4.1：系统提示中的 shell 说明改为“受限 bash”）：经可信指令通道（ZP-18）以内存文件提供；
    // 有签名可信区时与其 AGENTS.md 合并
    const domainNow = router.currentDomain();
    let trustedInstructionsDir = trustedRoot;
    if (domainNow.id === "W-core") {
      trustedInstructionsDir ??= join(homeDir, "kwl-instructions");
      mkdirSync(trustedInstructionsDir, { recursive: true });
      const realAgents = join(trustedInstructionsDir, "AGENTS.md");
      const firm = trustedRoot && existsSync(realAgents) ? readFileSync(realAgents, "utf8").trim() : "";
      virtualFiles.set(realAgents, [restrictedBashNote({ workDir, materialsDir, concurrency: domainNow.concurrency ?? 2 }), firm].filter(Boolean).join("\n\n"));
    }
    const seeds = matterSeeds({
      router,
      broker,
      policy,
      environment: { osKind: osKind(), osArch: arch(), osVersion: release(), shellPath, pathClass, homeDir },
      configStore: trustedConfigStore(config.config),
      virtualFiles,
      // 存量明文已在打开前迁移：此后盘上的明文一律拒绝（复核 B3-A18）
      ...(o.keyring ? { storage: new SealedFileStorageService(homeDir, o.keyring.zone("engine_fs"), { strict: true }), queryStore: new MemoryQueryStore() } : {}),
    });
    let server: EmbeddedServer;
    try {
      server = await createEmbeddedServer({
        homeDir,
        hostIdentity: HOST_IDENTITY,
        env: config.env,
        configPath: trustedConfigPath(homeDir),
        skillDirs: trustedRoot ? [join(trustedRoot, "skills")] : [],
        agentFiles: [],
        ...(trustedInstructionsDir ? { trustedInstructionsDir } : {}),
        seeds,
        logLevel: o.logLevel ?? "error",
        ...(o.keyring ? { eventJournalIo: sealedJournalIo(o.keyring.zone("engine_journal"), { strict: true }) } : {}),
      });
    } catch (e) {
      // 引擎起不来时不遗留执行域进程
      await ownedDomain?.close?.().catch(() => {});
      throw e;
    }
    let skillNames: ReadonlySet<string> = new Set();
    if (trustedRoot) {
      try {
        skillNames = new Set(readdirSync(join(trustedRoot, "skills"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name));
      } catch {
        skillNames = new Set();
      }
    }
    return new MatterEngine({ matterId: o.matterId, homeDir, workDir, materialsDir, broker, router, policy, config, server, ownedDomain, execDomainError, skillNames });
  }

  /** 执行域不可用的原因（创建失败，或运行中 W 进程拉起/自检失败——复核 S3-23）；设备页与能力账本如实显示。null = 可用或未配置。 */
  get execDomainError(): string | null {
    return this.initialExecDomainError ?? this.router.currentDomain().health?.() ?? null;
  }

  /** 已注册的 kap-server 路由（取证：与宿主白名单比对）。 */
  registeredRoutes(): readonly string[] {
    return this.server.registeredRoutes();
  }

  subscribe(sessionId: string, onEvent: (e: EventEnvelope) => void): Promise<() => void> {
    return this.kap.subscribe(sessionId, onEvent);
  }

  async close(): Promise<void> {
    await this.server.close();
    await this.ownedDomain?.close?.().catch(() => {});
  }
}

/** 受限 bash 的环境说明（W-core 实测事实；随包纯 Python 包落地后在此列出）。 */
export function restrictedBashNote(p: { workDir: string; materialsDir: string; concurrency?: number }): string {
  return [
    "# 执行环境说明（宿主提供）",
    "",
    "本机的 Bash 工具运行在受限 bash 中（执行域 W-core，运行时隔离），不是完整的 Linux，也不是律师电脑本身的终端：",
    "- 没有网络：curl、wget、pip install、npm install 等都不可用，也不能安装任何软件；需要检索法规或网页时使用对应的专用工具。",
    "- python3 是 Python 3.13，只有标准库（csv、json、decimal、datetime、statistics、re、zipfile、xml 等）；pandas、numpy 只在数据分析增强环境中可用，当前不可用；Python 的 sqlite3 模块不可用，需要 SQL 时用 shell 的 sqlite3 命令。",
    "- 可用命令：常见文本与文件命令（ls、cat、head、tail、wc、sort、uniq、cut、tr、diff、find、xargs 等）、grep、sed、awk、jq、yq、xan（CSV）、sqlite3、tar、gzip。没有 git、node、docker。",
    "- Word/Excel：交付律师的 Word 文书与表格优先用法律工具 docx.render_report、xlsx.render_table 生成（自动登记为草稿成果）；在命令行里处理时，DOCX 用可信命令 kwl-docx（text 读段落；create 由标准输入生成，\"## \" 开头为小节标题；compare 段落比对），XLSX 用 kwl-xlsx（create / from-csv）；运行 kwl-docx --help 查看用法。没有 python-docx、openpyxl。修改律师上传的 Word 原件用法律工具 docx.revise（在原件副本上出修订稿与清洁稿）；kwl-docx 不能写修订。",
    "- 数据规模：单个文件超过 128 MB 不能读入；经 python3 读写、或经 awk 等把内容整体处理的命令，单个文件约 64 MB 为限（超出即报错并按执行域资源上限处理，本次改动不写回）；含大量中文的数据在 20～30 MB 以上用 python3 整体读入就可能内存不足，请逐行处理、先用 split 分块，或导入 sqlite3。cat、awk 等把输出整体拼接的命令，单条输出约 64 MB 为限。回给你的命令输出超过 16 MB 会被截断，大量结果请写入文件再分段查看。",
    "- 写法提示：jq/yq 中的中文键写成 .[\"键名\"]；awk 以竖线分隔时写 -F'[|]'；Python 写 CSV 默认是 \\r\\n 换行。",
    `- 文件：事项工作区 ${p.workDir} 可读写；材料快照 ${p.materialsDir} 只读。命令结束后对工作区的改动才写回磁盘；若运行期间同一文件被其他操作修改或建立，命令的结果会另存为“执行冲突副本”。`,
    "- 退出码：75 表示命令本身已执行完毕，但对工作区的改动没有完整写回（冲突副本、保留未删、被拒绝或写入失败），输出末尾的［执行域］说明列出了具体文件；124 表示超过执行时限（命令自身返回的 124，例如 timeout 命令，按普通退出码处理、改动照常写回）；触及执行域资源上限时退出码为 126（命令本身已以非 0 退出时保持原值，输出末尾有［执行域］说明）；137 表示被强制终止；143 表示被停止（TaskStop 先在语句边界协作停止，已执行完的语句的改动照常写回；5 秒内没停下即强制终止）。超过执行时限、强制终止或触及执行域资源上限（命令输出与读入的规模、内存层与文件系统容量、时长）时，本次命令对工作区的改动一律不写回。",
    "- 只改大小写的更名（mv a.txt A.txt）在本机磁盘上不生效，请经临时名两步更名；只用 touch 改时间而内容不变的文件不会写回。",
    `- 每次调用都是全新的 shell；/tmp 只在本次调用内有效。前台命令最长 5 分钟，超时自动转入后台；后台命令最长 60 分钟，不支持 disable_timeout；同一事项最多同时运行 ${p.concurrency ?? 2} 条命令，其余排队。`,
  ].join("\n");
}
