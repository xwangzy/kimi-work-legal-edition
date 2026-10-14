// kap-embed 制品的类型声明（手写最小面；与 vendor-entry/kap-embed-entry.ts 的导出一一对应）。
// 引擎内部类型很深，这里只声明 Agent 宿主实际使用的形状。

export type ScopeSeed = ReadonlyArray<readonly [unknown, unknown]>;

export interface EventEnvelope {
  readonly type: string;
  readonly seq: number;
  readonly epoch?: string;
  readonly volatile?: boolean;
  readonly offset?: number;
  readonly session_id?: string;
  readonly timestamp: string;
  readonly payload: unknown;
}

export type EmbeddedMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface EmbeddedServerOptions {
  readonly homeDir: string;
  readonly hostIdentity: { productName: string; version: string; platform: string; displayName?: string; replyStyleGuide?: string };
  readonly env?: Record<string, string | undefined>;
  readonly configPath?: string;
  readonly skillDirs?: readonly string[];
  readonly agentFiles?: readonly string[];
  readonly trustedInstructionsDir?: string;
  readonly seeds?: ScopeSeed;
  readonly eventsDir?: string;
  /** ZP-9a：事件日志 I/O（宿主注入，例如落盘加密；缺省 node fs）。 */
  readonly eventJournalIo?: JournalIo;
  readonly logLevel?: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
}

export interface EmbeddedServer {
  readonly core: { accessor: { get<T>(id: unknown): T } };
  readonly listening: false;
  inject(method: EmbeddedMethod, url: string, payload?: unknown): Promise<{ statusCode: number; body: any }>;
  subscribe(sessionId: string, onEvent: (envelope: EventEnvelope) => void): Promise<() => void>;
  registeredRoutes(): readonly string[];
  close(): Promise<void>;
}

export function createEmbeddedServer(opts: EmbeddedServerOptions): Promise<EmbeddedServer>;

export const IHostProcessService: unknown;
export const IHostFileSystem: unknown;
export const IHostTerminalService: unknown;
export const IHostEnvironment: unknown;
export const IHostPolicyProvider: unknown;
export const IProjectLocalConfigService: unknown;
export const IAgentPermissionPolicyService: unknown;
export const IAgentToolRegistryService: unknown;
export const HOST_POLICY_NAME: "host-policy";
export const MAIN_AGENT_ID: string;
export class HostProcessError extends Error {
  constructor(code: string, message: string, options?: unknown);
}
export function resumeSessionById(accessor: unknown, sessionId: string): Promise<any>;
export function getLiveSessionById(accessor: unknown, sessionId: string): any;
/** ZP-20：登记 Grep/Glob 使用的可信 ripgrep（未登记即不可用；不在 PATH 查找、不下载）。 */
export function configureTrustedRipgrep(path: string | undefined): void;
/** 配置文档存储（只有配置服务使用；宿主以内存只读实现替换：可信配置不从磁盘重读——审查 R-13）。 */
export const IAtomicTomlDocumentStore: unknown;
export const ITelemetryService: unknown;
export const noopTelemetryService: unknown;

/** ZP-9a：事件日志 I/O。 */
export interface JournalIo {
  appendText(filePath: string, text: string): Promise<void>;
  readLines(filePath: string): AsyncIterable<string>;
  remove(filePath: string): Promise<void>;
}

// 落盘加密（审计 S3 第 1 步）：持久化存储与查询库的注入点
export const IFileSystemStorageService: unknown;
export const IQueryStore: unknown;
export class StorageError extends Error {
  readonly code: string;
}
export function toStorageIoError(error: unknown, ctx: { path: string; op: string }): StorageError;
export class QueryStoreRebuiltError extends Error {}
export function minidbMatch(doc: unknown, filter?: Record<string, unknown> | null): boolean;
export function minidbGetPath(doc: unknown, path: string): unknown;
