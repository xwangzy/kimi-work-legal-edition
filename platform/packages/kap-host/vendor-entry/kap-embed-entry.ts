/**
 * kap-embed 制品入口（scripts/build-kap-embed.mjs 打包为 vendor/kap-embed/kap-embed.mjs）。
 * 只导出 Agent 宿主需要的面：无端口嵌入（ZP-19）与注入点 DI 标识（ZP-4/5/6/12/16/18）。
 * DI 标识必须与引擎同一制品实例（按对象身份匹配），所以从这里统一导出。
 */
export { createEmbeddedServer } from "@moonshot-ai/kap-server/embed";
export {
  IHostProcessService,
  HostProcessError,
  IHostFileSystem,
  IHostTerminalService,
  IHostEnvironment,
  IHostPolicyProvider,
  HOST_POLICY_NAME,
  IProjectLocalConfigService,
  IAgentPermissionPolicyService,
  IAgentToolRegistryService,
  resumeSessionById,
  getLiveSessionById,
  MAIN_AGENT_ID,
  configureTrustedRipgrep,
  IAtomicTomlDocumentStore,
  ITelemetryService,
  noopTelemetryService,
} from "@moonshot-ai/agent-core-v2";

// 落盘加密（审计 S3 / ZP-9；第 1 步）：宿主以种子替换引擎的持久化存储与查询库（与引擎同一模块实例，按对象身份匹配）
export { IFileSystemStorageService, StorageError, toStorageIoError } from "@moonshot-ai/agent-core-v2/storage";
export { IQueryStore, QueryStoreRebuiltError } from "@moonshot-ai/agent-core-v2/query-store";
// 内存查询库的过滤语义与 minidb 一致（直接复用其纯函数）
export { match as minidbMatch, getPath as minidbGetPath } from "@moonshot-ai/minidb/query";
// ZP-9a：事件日志 I/O 类型
export type { JournalIo } from "@moonshot-ai/kap-server/journal";
