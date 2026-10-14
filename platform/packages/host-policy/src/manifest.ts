/**
 * 工具清单（v9 第 04 篇 §9 F3 修复：授权依据是“工具 ID + 动作 + 资源 + 用途”，清单含 schema hash 与副作用类别；
 * 第 02 篇 §9.4 工具分级）。
 *
 * 一个工具能否被调用，不再看名字前缀（旧实现：`mcp__legal__` 前缀一律自动批准，未来同前缀的写工具会继承），
 * 而是看清单里逐项登记的事实：
 * - 副作用类别（read / write_draft / exec / network / external / irreversible）；
 * - 资源范围（只读本事项材料、写本事项工作区、只读法规库、纯计算……）；
 * - 允许的用途；
 * - 输入 schema 的 hash：工具服务端声明的 schema 变了而清单没跟着改，就视为另一个工具，一律拒绝。
 */
import { createHash } from "node:crypto";

export const SideEffect = {
  read: "read",
  writeDraft: "write_draft",
  exec: "exec",
  network: "network",
  external: "external",
  irreversible: "irreversible",
} as const;
export type SideEffect = (typeof SideEffect)[keyof typeof SideEffect];

/** 工具作用的资源（决定事项绑定与数据级别检查）。 */
export type ToolResource =
  | "matter_materials" // 只读本事项材料（令牌须绑定该事项）
  | "matter_documents" // 读本事项文档版本并产出新版本草稿
  | "matter_work" // 写本事项工作区
  | "lawdb" // 只读离线法规库
  | "pure"; // 纯计算，不读写事项数据

export interface ToolManifest {
  /** 引擎可见的工具 ID（MCP 工具经 qualifyMcpToolName 规范化）。 */
  readonly id: string;
  /** MCP 服务名；内置工具为 null。 */
  readonly server: string | null;
  /** 服务端工具名（如 `law.get_version`）。 */
  readonly name: string;
  readonly version: string;
  readonly sideEffect: SideEffect;
  readonly resource: ToolResource;
  /** 允许的用途（任务意图）；为空表示任何用途都不允许。 */
  readonly purposes: readonly string[];
  /** sha256(canonicalJson(inputSchema))，十六进制。 */
  readonly schemaHash: string;
}

/** 规范化 JSON：对象键按码点排序、无空白；用于 schema hash 与参数摘要（同一输入同一字节）。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("canonicalJson: 非有限数值");
    if (value === undefined) return "null";
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function schemaHash(schema: unknown): string {
  return createHash("sha256").update(canonicalJson(schema), "utf8").digest("hex");
}

/** 参数摘要（审计与批准绑定用；不含明文）。 */
export function argsHash(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args ?? {}), "utf8").digest("hex");
}

const MCP_NAME_PREFIX = "mcp__";
const MCP_NAME_SEPARATOR = "__";
const MAX_QUALIFIED_LENGTH = 64;

function sanitizeMcpNamePart(part: string): string {
  return part.replaceAll(/[^a-zA-Z0-9_-]/g, "_").replaceAll(/_+/g, "_");
}

function stableHash8(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.codePointAt(i)!;
    hash = Math.trunc(Math.imul(hash, 0x01000193));
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * 与 Kimi Code 锁版 `mcpCore/tool-naming.ts` 的 `qualifyMcpToolName` 逐字节一致（引擎看到的工具名）。
 * 上游改变命名规则时，清单查找会整体失败（拒绝），而不是静默放行——单测锁定已知输出。
 */
export function qualifyMcpToolName(serverName: string, toolName: string): string {
  const full = `${MCP_NAME_PREFIX}${sanitizeMcpNamePart(serverName)}${MCP_NAME_SEPARATOR}${sanitizeMcpNamePart(toolName)}`;
  if (full.length <= MAX_QUALIFIED_LENGTH) return full;
  const hash = stableHash8(full);
  const head = full.slice(0, MAX_QUALIFIED_LENGTH - hash.length - 1);
  return `${head}_${hash}`;
}

export interface ToolDefinitionLike {
  name: string;
  inputSchema: Record<string, unknown>;
  sideEffect: SideEffect;
  resource: ToolResource;
  version: string;
  purposes: readonly string[];
}

/** 由工具服务端的定义生成 MCP 工具清单。 */
export function mcpManifest(server: string, def: ToolDefinitionLike): ToolManifest {
  return Object.freeze({
    id: qualifyMcpToolName(server, def.name),
    server,
    name: def.name,
    version: def.version,
    sideEffect: def.sideEffect,
    resource: def.resource,
    purposes: Object.freeze([...def.purposes]),
    schemaHash: schemaHash(def.inputSchema),
  });
}

export class ManifestRegistry {
  private readonly byId = new Map<string, ToolManifest>();

  constructor(manifests: Iterable<ToolManifest>) {
    for (const m of manifests) {
      if (this.byId.has(m.id)) throw new Error(`工具清单重复登记：${m.id}`);
      this.byId.set(m.id, m);
    }
  }

  get(id: string): ToolManifest | undefined {
    return this.byId.get(id);
  }

  list(): ToolManifest[] {
    return [...this.byId.values()];
  }

  /**
   * 服务端自检：对外暴露的每个工具都必须有清单，且 schema hash 一致；返回不一致项（调用方应拒绝暴露这些工具）。
   */
  verifyServerSchemas(server: string, defs: readonly { name: string; inputSchema: Record<string, unknown> }[]): string[] {
    const problems: string[] = [];
    for (const d of defs) {
      const m = this.byId.get(qualifyMcpToolName(server, d.name));
      if (!m) problems.push(`${d.name}: 无清单`);
      else if (m.schemaHash !== schemaHash(d.inputSchema)) problems.push(`${d.name}: schema hash 与清单不一致`);
    }
    return problems;
  }
}
