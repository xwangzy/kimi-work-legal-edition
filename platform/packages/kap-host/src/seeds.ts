/**
 * kap-server 种子（v9 第 04 篇 §3.2 `seeds` 行；ZP-5/6/12/16 与 ZP-4 的宿主策略提供者）。
 *
 * 每个事项一份引擎实例、一份种子：
 * - `IHostProcessService` → 执行域路由（Bash → 执行域；Grep/Glob → 宿主内检索（审计 S3 第 2 步：不再拉起原生 rg）；其余一律拒绝）；
 * - `IHostFileSystem` → 事项文件 broker（材料快照只读 + 工作区可写；引擎自身的 homeDir 不在其中，Agent 的文件工具够不到配置与会话存储）；
 * - `IHostTerminalService` → 拒绝（ZP-12：终端关闭）；
 * - `IHostEnvironment` → 固定值（执行域占位 shell；不探测、不起登录 shell、不找 cygpath——ZP-16）；
 * - `IHostPolicyProvider` → 宿主策略（ZP-4：策略链首位、永不弃权）；
 * - `IProjectLocalConfigService` → 只读空实现（项目级附加目录不加载；“扩大材料范围”是跨边界动作⑩，只经业务 API）；
 * - `IAtomicTomlDocumentStore` → 内存只读可信配置（审查 R-13；engine-config.ts）；mcp.json 由文件系统包装层从内存返回；
 * - `ITelemetryService` → 空实现（遥测关闭）。
 *
 * 种子数组后写覆盖先写（`start.ts:120,198-211`），App 作用域的默认注册被跳过。
 */
import { resolve } from "node:path";
import {
  IAtomicTomlDocumentStore,
  IFileSystemStorageService,
  IQueryStore,
  IHostEnvironment,
  IHostFileSystem,
  IHostPolicyProvider,
  IHostProcessService,
  IHostTerminalService,
  IProjectLocalConfigService,
  ITelemetryService,
  noopTelemetryService,
  type ScopeSeed,
} from "../vendor/kap-embed/kap-embed.mjs";
import type { FileBroker } from "@zr-legal/file-broker";
import type { ExecRouter } from "./exec-router.ts";
import type { HostPolicy, HostPolicyRequest } from "./policy.ts";

export interface FixedEnvironment {
  osKind: string;
  osArch: string;
  osVersion: string;
  shellPath: string;
  pathClass: "posix" | "win32";
  /** 引擎 homeDir（不在任何 broker 区域内：`~` 展开后的路径一律不可达）。 */
  homeDir: string;
}

/** 执行域占位 shell（不存在的路径；只被执行域路由按字面匹配，从不交给操作系统执行）。 */
export function placeholderShellPath(pathClass: "posix" | "win32"): string {
  return pathClass === "win32" ? "C:\\KimiWorkLegal\\exec-domain\\bash.exe" : "/opt/kimi-work-legal/exec-domain/bash";
}

export function hostEnvironment(env: FixedEnvironment): Record<string, unknown> {
  return Object.freeze({
    _serviceBrand: undefined,
    osKind: env.osKind,
    osArch: env.osArch,
    osVersion: env.osVersion,
    shellName: "bash",
    shellPath: env.shellPath,
    pathClass: env.pathClass,
    homeDir: env.homeDir,
    ready: Promise.resolve(),
  });
}

export function deniedTerminalService(): Record<string, unknown> {
  return {
    _serviceBrand: undefined,
    async spawn(): Promise<never> {
      throw Object.assign(new Error("终端已关闭（Kimi Work 法律发行版不提供交互式终端）"), { code: "terminal_disabled" });
    },
  };
}

export function readOnlyProjectLocalConfig(): Record<string, unknown> {
  return {
    _serviceBrand: undefined,
    async readAdditionalDirs(workDir: string) {
      return { projectRoot: workDir, configPath: "", additionalDirs: [] };
    },
    async resolveAdditionalDirs(): Promise<string[]> {
      return [];
    },
    async appendAdditionalDir(): Promise<never> {
      throw Object.assign(new Error("扩大材料范围须经业务界面确认（跨边界动作⑩），引擎内不可追加目录"), { code: "additional_dirs_disabled" });
    },
  };
}

export function hostPolicyProvider(policy: HostPolicy): Record<string, unknown> {
  return {
    _serviceBrand: undefined,
    evaluate: (req: HostPolicyRequest) => policy.evaluateAsync(req),
  };
}

function eperm(path: string): Error {
  return Object.assign(new Error(`EPERM: 可信配置只读：${path}`), { code: "EPERM" });
}

/**
 * 事项文件系统：broker（材料只读 + 工作区可写 + 可信区只读）之上叠加**内存只读文件**（如 `<home>/mcp.json`）。
 * 内存文件不在任何 broker 区域内：Agent 的文件工具既读不到也写不了；引擎按固定路径读取时由这里应答。
 */
export function matterHostFileSystem(broker: FileBroker, virtualFiles: ReadonlyMap<string, string>): Record<string, unknown> {
  const base = broker.asHostFileSystem() as Record<string, (...a: never[]) => unknown>;
  const files = new Map([...virtualFiles].map(([p, c]) => [resolve(p), Buffer.from(c, "utf8")] as const));
  const hit = (p: string) => files.get(resolve(p));
  const stat = (buf: Buffer) => ({ isFile: true, isDirectory: false, isSymbolicLink: false, size: buf.length, mtimeMs: 0, ino: 0 });
  const call = (name: string, ...args: unknown[]) => (base[name] as (...a: unknown[]) => unknown)(...args);
  return {
    _serviceBrand: undefined,
    readText: async (p: string, o?: unknown) => {
      const v = hit(p);
      return v ? v.toString("utf8") : call("readText", p, o);
    },
    readBytes: async (p: string, n?: number, offset?: number) => {
      const v = hit(p);
      if (!v) return call("readBytes", p, n, offset);
      const start = offset ?? 0;
      return new Uint8Array(v.subarray(start, n === undefined ? undefined : start + n));
    },
    readLines: (p: string, o?: unknown) => {
      const v = hit(p);
      if (!v) return call("readLines", p, o);
      return (async function* () {
        for (const line of v.toString("utf8").split(/\r?\n/)) yield line;
      })();
    },
    stat: async (p: string) => {
      const v = hit(p);
      return v ? stat(v) : call("stat", p);
    },
    lstat: async (p: string) => {
      const v = hit(p);
      return v ? stat(v) : call("lstat", p);
    },
    realpath: async (p: string) => (hit(p) ? resolve(p) : call("realpath", p)),
    readdir: async (p: string) => {
      if (hit(p)) throw Object.assign(new Error(`ENOTDIR: ${p}`), { code: "ENOTDIR" });
      return call("readdir", p);
    },
    writeText: async (p: string, d: string) => {
      if (hit(p)) throw eperm(p);
      return call("writeText", p, d);
    },
    appendText: async (p: string, d: string) => {
      if (hit(p)) throw eperm(p);
      return call("appendText", p, d);
    },
    writeBytes: async (p: string, d: Uint8Array) => {
      if (hit(p)) throw eperm(p);
      return call("writeBytes", p, d);
    },
    createExclusive: async (p: string, d: Uint8Array) => {
      if (hit(p)) throw eperm(p);
      return call("createExclusive", p, d);
    },
    mkdir: async (p: string, o?: unknown) => {
      if (hit(p)) throw eperm(p);
      return call("mkdir", p, o);
    },
    remove: async (p: string) => {
      if (hit(p)) throw eperm(p);
      return call("remove", p);
    },
  };
}

export interface MatterSeedDeps {
  router: ExecRouter;
  broker: FileBroker;
  policy: HostPolicy;
  environment: FixedEnvironment;
  /** 内存只读的可信配置存储（engine-config.ts `trustedConfigStore`）。 */
  configStore: Record<string, unknown>;
  /** 引擎按固定路径读取、但不应落盘或暴露给 Agent 的内存文件（绝对路径 → 内容），如 `<home>/mcp.json`。 */
  virtualFiles: ReadonlyMap<string, string>;
  /** 落盘加密（审计 S3 第 1 步）：引擎持久化存储与查询库的替换实现（给出即注入）。 */
  storage?: unknown;
  queryStore?: unknown;
}

export function matterSeeds(d: MatterSeedDeps): ScopeSeed {
  return [
    ...(d.storage ? ([[IFileSystemStorageService, d.storage]] as const) : []),
    ...(d.queryStore ? ([[IQueryStore, d.queryStore]] as const) : []),
    [IHostProcessService, d.router],
    [IHostFileSystem, matterHostFileSystem(d.broker, d.virtualFiles)],
    [IHostTerminalService, deniedTerminalService()],
    [IHostEnvironment, hostEnvironment(d.environment)],
    [IHostPolicyProvider, hostPolicyProvider(d.policy)],
    [IProjectLocalConfigService, readOnlyProjectLocalConfig()],
    [IAtomicTomlDocumentStore, d.configStore],
    [ITelemetryService, noopTelemetryService],
  ];
}
