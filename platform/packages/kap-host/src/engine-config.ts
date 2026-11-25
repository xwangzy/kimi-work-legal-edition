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
/** 模型别名（云端模型目录的 id；第 66 批）。 */
export const MODEL_ID_RE = /^[a-z0-9][a-z0-9._/-]{1,47}$/;

/**
 * 任务所选模型（第 66 批，V40）：内核按云端模型目录核过（可用、入口含 task、能力含 tool_use）后随 startRun 下发。
 * 引擎配置的 models 段按它动态加一项；上游型号不在客户端（provider 仍是闸门，网关按别名路由）。
 */
export interface TaskModelSpec {
  id: string;
  /** 目录里的能力（tool_use / thinking / long_context）。 */
  capabilities: readonly string[];
  /** 目录里的上下文窗口；null = 缺省 262144。 */
  max_context: number | null;
  /** 目录里的思考控制方式：只有 effort（始终思考、调强度，K3 系列）给引擎声明 thinking 能力——与内置 K3 / K2.6 的现状一致。 */
  thinking?: "effort" | "toggle" | "none";
}

/** 目录能力 → 引擎能力：tool_use 照给；thinking 只给“调强度”的模型（K2.6 这类开关型现状不声明）；long_context 引擎不认，不给。 */
export function engineCapabilitiesOf(spec: TaskModelSpec): string[] {
  const caps = ["tool_use"];
  if (spec.thinking === "effort" && spec.capabilities.includes("thinking")) caps.push("thinking");
  return caps;
}

/** 下发的模型规格是否合格（宿主不信任意形态；不合格按“没有规格”处理：只给 tool_use、缺省上下文）。 */
export function sanitizeTaskModel(id: unknown, spec: unknown): TaskModelSpec | null {
  if (typeof id !== "string" || !MODEL_ID_RE.test(id)) return null;
  const s = (spec && typeof spec === "object" && !Array.isArray(spec) ? spec : {}) as Record<string, unknown>;
  const caps = Array.isArray(s.capabilities) ? s.capabilities.filter((c): c is string => c === "tool_use" || c === "thinking" || c === "long_context") : ["tool_use"];
  const ctx = typeof s.max_context === "number" && Number.isSafeInteger(s.max_context) && s.max_context >= 4096 && s.max_context <= 2_000_000 ? s.max_context : null;
  const thinking = s.thinking === "effort" || s.thinking === "toggle" || s.thinking === "none" ? s.thinking : "none";
  return { id, capabilities: caps, max_context: ctx, thinking };
}
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
  /** 第 66 批：内置两项之外、本事项任务选用的模型（按目录能力生成 models 段的一项）。 */
  taskModels?: readonly TaskModelSpec[];
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

/** 一步模型请求遇到可重试错误（限流、网关错误）时最多试几次（含第一次）。 */
export const STEP_MAX_ATTEMPTS = 20;

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
      // 第 66 批：任务所选的其他模型（云端目录里的别名；provider 仍是闸门，上游型号由网关按别名决定）
      ...Object.fromEntries(
        (spec.taskModels ?? [])
          .filter((m) => MODEL_ID_RE.test(m.id) && m.id !== MAIN_MODEL && m.id !== SECONDARY_MODEL)
          .map((m) => [m.id, { provider: "kwl-gate", model: m.id, max_context_size: spec.testMaxContextSize && ctx !== 262144 ? ctx : (m.max_context ?? 262144), capabilities: engineCapabilitiesOf(m) }]),
      ),
    },
    // 子 Agent 一律用 K2.6 级（需要 K3 的子任务由宿主策略按预算审批；能力账本“子 Agent”行）
    secondary_model: { default_model: SECONDARY_MODEL, force: true },
    identity: { name: "Kimi Work 法律发行版助手", slug: "kimi-work-legal" },
    tools: { disabled },
    // 上游限流的耐心（第 57 批，D-230）：引擎对 429 / 5xx 逐步退避重试（0.5 秒起翻倍、封顶 32 秒），缺省 10 次，合计约两分半就放弃、整单失败。
    // 真实运行：两波并行时答辩状一单在第一步遇到限流，2 分 21 秒后失败；11-12 上游曾连续拒绝约 11 分钟。律师的任务一单二十多分钟，
    // 多等几分钟远好过从头再来——放宽到 20 次（约 8 分钟），界面这段时间如实显示“正在重试”。
    loop_control: { max_attempts_per_step: STEP_MAX_ATTEMPTS },
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
