/**
 * 每个事项引擎的可信配置（v9 第 04 篇 §3.2“每次任务生成配置”行；审查 R-13：可信配置不从磁盘重读）。
 *
 * - config.toml：以**内存只读**的 `IAtomicTomlDocumentStore` 种子提供（上游只有配置服务使用该存储，`get` 返回已解析的
 *   snake_case 对象）；写回一律拒绝（“配置写入不可达”）。`configPath` 指向从不创建的文件名，上游构造期的
 *   `readFileSync(configPath)` 直读落空，随后 `load()` 只读内存。
 * - mcp.json：上游经 `IHostFileSystem` 读取 `<home>/mcp.json`，由宿主文件系统包装层从内存返回（同样不可写、不可删）。
 * - 两份内容的摘要进入能力账本与审计（取证：本事项引擎当时运行的是哪一份配置）。
 */
import { createHash } from "node:crypto";
import { join } from "node:path";

export const MAIN_MODEL = "legal/k3";
export const SECONDARY_MODEL = "legal/k2.6";
/** 上游配置键 = basename(configPath)；该文件从不落盘。 */
export const TRUSTED_CONFIG_KEY = "kwl-trusted-config.toml";

export interface EngineConfigSpec {
  matterId: string;
  /** 执行域是否可用：不可用时 Bash 对模型不可见（宿主策略同样拒绝，双重生效）。 */
  execDomainAvailable: boolean;
  /** 法律 MCP 对本事项开放的工具（服务端原名）；空 = 不配置 MCP。 */
  legalMcpTools: readonly string[];
  /** 闸门 /search、/fetch 已接入时才配置（ZP-11：未配置即不注册 FetchURL；WebSearch 无配置不注册）。 */
  searchConfigured: boolean;
  fetchConfigured: boolean;
  /**
   * 只供测试（上下文压缩验收，Kimi Code 增量核查 K7-3）：把两个模型的上下文窗口改小，以便在合成材料上触发压缩。
   * 宿主只在非安装包形态（落盘加密不是 required）接受该项。
   */
  testMaxContextSize?: number | undefined;
}

export interface EngineConfig {
  /** 上游配置服务读到的已解析对象（snake_case）。 */
  config: Record<string, unknown>;
  mcpJson: string | null;
  /** 引擎进程环境（`createEmbeddedServer({env})`；上游不继承 process.env）。 */
  env: Record<string, string>;
  digest: { config: string; mcp: string | null };
}

/** 实验开关锁定（ZP-13）：Tower、SUBAGENT_FORK、TOOL_SELECT 关；NOTIFY_USER、WAIT_FOR 开。单项环境变量优先级最高，两处同时写。 */
export const EXPERIMENTAL_LOCK: Readonly<Record<string, boolean>> = Object.freeze({
  tower: false,
  subagent_fork: false,
  "tool-select": false,
  notify_user: true,
  wait_for: true,
});

const EXPERIMENTAL_ENV: Readonly<Record<string, string>> = Object.freeze({
  KIMI_CODE_EXPERIMENTAL_TOWER: "0",
  KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK: "0",
  KIMI_CODE_EXPERIMENTAL_TOOL_SELECT: "0",
  KIMI_CODE_EXPERIMENTAL_NOTIFY_USER: "1",
  KIMI_CODE_EXPERIMENTAL_WAIT_FOR: "1",
});

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function buildEngineConfig(spec: EngineConfigSpec): EngineConfig {
  const disabled: string[] = [];
  const ctx = spec.testMaxContextSize && Number.isInteger(spec.testMaxContextSize) && spec.testMaxContextSize >= 4096 && spec.testMaxContextSize < 262144 ? spec.testMaxContextSize : 262144;
  if (!spec.execDomainAvailable) disabled.push("Bash");
  const config: Record<string, unknown> = {
    default_model: MAIN_MODEL,
    // 引擎侧权限模式固定为 manual：运行模式由宿主策略决定；上游 auto 模式会绕过策略链自动批准计划（ExitPlanMode）
    default_permission_mode: "manual",
    default_plan_mode: false,
    builtin_product_skills: false,
    merge_all_available_skills: false,
    providers: {
      "kwl-gate": {
        type: "openai",
        // 宿主出口按会话换上任务令牌（host-egress.ts）；这里的 api_key 只是占位，会被剥离
        base_url: `http://gate.kwl/m/${spec.matterId}/v1`,
        api_key: "host-routed",
      },
    },
    models: {
      [MAIN_MODEL]: {
        provider: "kwl-gate",
        model: MAIN_MODEL,
        max_context_size: ctx,
        capabilities: ["tool_use", "thinking"],
      },
      [SECONDARY_MODEL]: {
        provider: "kwl-gate",
        model: SECONDARY_MODEL,
        max_context_size: ctx,
        capabilities: ["tool_use"],
      },
    },
    // 子 Agent 一律用 K2.6 级（需要 K3 的子任务由宿主策略按预算审批；能力账本“子 Agent”行）
    secondary_model: { default_model: SECONDARY_MODEL, force: true },
    identity: { name: "Kimi Work 法律发行版助手", slug: "kimi-work-legal" },
    tools: { disabled },
    // 联网检索与网页抓取（第 04 篇 §5.1 `/search`、`/fetch`；ZP-11）：只指向出站闸门；宿主出口按工具调用 ID 换上运行令牌，api_key 只是占位
    ...(spec.searchConfigured || spec.fetchConfigured
      ? {
          services: {
            ...(spec.searchConfigured ? { moonshot_search: { base_url: `http://gate.kwl/m/${spec.matterId}/search`, api_key: "host-routed" } } : {}),
            ...(spec.fetchConfigured ? { moonshot_fetch: { base_url: `http://gate.kwl/m/${spec.matterId}/fetch`, api_key: "host-routed" } } : {}),
          },
        }
      : {}),
    // Bash 超时档位（第 04 篇 §4.1 与能力账本）：前台默认 60 秒、最长 5 分钟，超时转后台（上游语义，P2 验收项）；
    // 转入后台后 10 分钟；后台命令最长 60 分钟、禁止 disable_timeout（宿主策略拒绝）；W 执行域另有 60 分钟硬上限
    task: { bash_task_timeout_s: 600, bash_auto_background_on_timeout: true },
    experimental: { ...EXPERIMENTAL_LOCK },
  };
  const mcpJson =
    spec.legalMcpTools.length === 0
      ? null
      : JSON.stringify(
          {
            mcpServers: {
              legal: {
                transport: "http",
                url: `http://tools.kwl/m/${spec.matterId}/mcp`,
                enabledTools: [...spec.legalMcpTools],
                toolTimeoutMs: 60_000,
              },
            },
          },
          null,
          2,
        );
  const env: Record<string, string> = {
    ...EXPERIMENTAL_ENV,
    KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: "3",
    KIMI_CODE_BUILTIN_PRODUCT_SKILLS: "0",
    // 引擎文件日志关闭（审计 S3 1-8：日志在错误路径可能写入内容，且是明文落盘）；诊断走宿主自己的脱敏记录
    KIMI_LOG_LEVEL: "off",
  };
  return { config, mcpJson, env, digest: { config: sha256(canonical(config)), mcp: mcpJson ? sha256(mcpJson) : null } };
}

function frozenClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * 内存只读的配置文档存储（替换上游 `IAtomicTomlDocumentStore`）。只应答可信配置键；写入、删除一律拒绝。
 */
export function trustedConfigStore(config: Record<string, unknown>, configKey = TRUSTED_CONFIG_KEY): Record<string, unknown> {
  const deny = async (): Promise<never> => {
    throw Object.assign(new Error("可信配置只读（由宿主生成；引擎内不可写）"), { code: "EPERM" });
  };
  const text = `# Kimi Work 法律发行版：可信配置由宿主在内存中提供（摘要 ${sha256(canonical(config)).slice(0, 16)}）\n`;
  return {
    _serviceBrand: undefined,
    async get(scope: string, key: string) {
      return scope === "" && key === configKey ? frozenClone(config) : undefined;
    },
    async getText(scope: string, key: string) {
      return scope === "" && key === configKey ? text : undefined;
    },
    set: deny,
    setText: deny,
    delete: deny,
    async list() {
      return [configKey];
    },
    acquire() {
      return { dispose() {} };
    },
  };
}

export function trustedConfigPath(homeDir: string): string {
  return join(homeDir, TRUSTED_CONFIG_KEY);
}
