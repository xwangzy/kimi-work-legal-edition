/**
 * 每任务 homeDir 配置（方案 v5.0 第 4 篇 §4.3 配置与接入示意，按锁定提交逐项核对）。
 *
 * 铁律：
 * - 只连本机模型代理（broker.kwl / tools.kwl 由宿主内全局调度器路由到内核命名管道，
 *   不走回环网络；§4.2 网络层）；不持有 MaaS 席位令牌；
 * - [tools] enabled 只放行法律工具与四个交互工具（计划/待办/提问），其余内置工具与
 *   子代理派发不可见（模型可见层与执行层同时生效）；
 * - 不设置 KIMI_CODE_TRUST_WORKSPACE；homeDir 内不存在项目级 .kimi-code/mcp.json（ZP-1/2 写死）；
 * - 遥测关闭；skills 只挂签发目录（skillDirs 由 createKimiHarness 传入）；
 * - 白标 [identity]。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LEGAL_MCP_TOOLS } from "@zr-legal/domain";

/** 同源再导出（单一出处 @zr-legal/domain legal-tool-names.ts；本文件维持既有引用点不变）。 */
export { LEGAL_MCP_TOOLS } from "@zr-legal/domain";

export interface WorkerHomeSpec {
  homeDir: string;
  /** 模型代理伪主机名（宿主内调度器路由到内核管道；见 host.ts）。 */
  brokerHost?: string;
  toolsHost?: string;
  enabledMcpTools: string[];
}

/** [tools] enabled 白名单（探针 2：内置工具在模型可见层与执行层都不存在——精确等于此表）。 */
export const LEGAL_TOOLS_ENABLED = ["mcp__legal__*", "EnterPlanMode", "ExitPlanMode", "TodoList", "AskUserQuestion"] as const;

export function prepareWorkerHome(spec: WorkerHomeSpec): void {
  mkdirSync(spec.homeDir, { recursive: true });
  writeFileSync(join(spec.homeDir, "config.toml"), configToml(spec), "utf8");
  writeFileSync(join(spec.homeDir, "mcp.json"), mcpJson(spec), "utf8");
}

function configToml(spec: WorkerHomeSpec): string {
  const broker = spec.brokerHost ?? "broker.kwl";
  return `default_model = "legal/k3"
default_permission_mode = "manual"
telemetry = false
merge_all_available_skills = false
builtin_product_skills = false

[providers.local-broker]
type = "openai"
base_url = "http://${broker}/v1"
api_key_env = "KWL_TASK_TOKEN"

[models."legal/k3"]
provider = "local-broker"
model = "legal/k3"
max_context_size = 1048576
capabilities = ["thinking", "always_thinking", "tool_use"]
support_efforts = ["low", "high", "max"]
default_effort = "high"

[identity]
name = "Kimi Work 法律发行版助手"

[tools]
enabled = [${LEGAL_TOOLS_ENABLED.map((t) => `"${t}"`).join(", ")}]
`;
}

function mcpJson(spec: WorkerHomeSpec): string {
  const tools = spec.toolsHost ?? "tools.kwl";
  return JSON.stringify(
    {
      mcpServers: {
        legal: {
          transport: "http",
          url: `http://${tools}/mcp`,
          bearerTokenEnvVar: "KWL_TOOL_TOKEN",
          enabledTools: spec.enabledMcpTools,
        },
      },
    },
    null,
    2,
  );
}
