/**
 * 工具注册表：内核内模块（方案 v5.0 §15：tool-gateway 从独立服务改为内核内模块；
 * MCP 端点保留供 Agent 使用；确定性工作流进程内直接调用）。
 * “平台对工具 schema 校验严格”（§4.1）——inputSchema 一律 additionalProperties:false。
 * 外发、签发、删除类工具根本不在注册表内（§6.2）。
 */
import type { CapabilityClaims } from "@zr-legal/service-auth";
import { DomainError } from "@zr-legal/domain";
import { ManifestRegistry, type SideEffect, type ToolManifest, type ToolResource } from "@zr-legal/host-policy";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSignedToolLock, registryFromLock, verifyToolsAgainstLock, type ToolLock } from "./manifest-lock.ts";
import type { Lawdb } from "@zr-legal/lawdb";
import type { KernelDb } from "../db.ts";
import type { BlobStore } from "../blobs.ts";
import { lawGetVersion, lawSearch } from "./tools/law.ts";
import { citationsVerify } from "./tools/citations.ts";
import { calcInterest } from "./tools/calc.ts";
import { redactScan } from "./tools/redact.ts";
import { materialsReadExcerpt } from "./tools/materials.ts";
import { docxApplyRevisions, docxCompare, docxRenderReport, docxSanitize, redactApply } from "./tools/docx.ts";
import { factsList, factsSubmit, materialsList, registerToolArtifact, riskcardsList, riskcardsSubmit, xlsxRenderTable } from "./tools/review.ts";
import type { MatterTokenStore } from "../egress/matter-tokens.ts";

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** 副作用类别（v9 第 04 篇 §9 F3：授权依据之一；非 read 的调用走 outbox 与幂等键，F6）。 */
  sideEffect: SideEffect;
  /** 作用资源（事项绑定检查）。 */
  resource: ToolResource;
  /** 工具版本（语义变化即升版本；schema hash 由清单自动计算）。 */
  version: string;
  invoke: (params: any, ctx: InvokeCtx) => Promise<unknown> | unknown;
}

/** 锁文件生成时的默认用途（--regenerate 草稿用；正式用途以评审后的锁文件为准）。 */
export const LEGAL_TOOL_PURPOSES = ["legal_analysis"] as const;

export interface InvokeCtx {
  claims: CapabilityClaims;
  db: KernelDb;
  blobs: BlobStore;
  lawdb: Lawdb;
  /** 事项令牌存储（结构化产出核对锚点用；结果令牌化在本机端点统一做）。 */
  tokens?: MatterTokenStore;
}

const dateSchema = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };

export const TOOLS: readonly ToolDef[] = [
  {
    name: "law.get_version",
    title: "法规版本查询",
    description: "按法名与适用时点返回适用版本（现行与历史适用分开）；注册库没有的法源如实返回 found=false，不伪造。",
    sideEffect: "read",
    resource: "lawdb",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["law", "as_of"],
      properties: { law: { type: "string" }, as_of: dateSchema, topic: { type: "string" } },
    },
    invoke: (p, ctx) => lawGetVersion(ctx.lawdb, p),
  },
  {
    name: "law.search",
    title: "法规检索（注册库内）",
    description: "在 Source Registry 种子内按名称检索法源版本。",
    sideEffect: "read",
    resource: "lawdb",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: { query: { type: "string" } },
    },
    invoke: (p, ctx) => lawSearch(ctx.lawdb, p),
  },
  {
    name: "citations.verify",
    title: "引用核验",
    description: "抽取文本中的法条引用并做四态核验（来源已核/版本已核/支持待判；无法核实则拦截并可见），支持改引建议。",
    sideEffect: "read",
    resource: "lawdb",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["as_of"],
      properties: {
        text: { type: "string" },
        citations: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["law", "article"],
            properties: { law: { type: "string" }, article: { type: "integer" } },
          },
        },
        as_of: dateSchema,
        topic_hint: { type: "string" },
      },
    },
    invoke: (p, ctx) => citationsVerify(ctx.lawdb, p),
  },
  {
    name: "calc.interest",
    title: "利息计算（LPR 分段）",
    description: "确定性利息计算：分段保存起止日、日数、利率、年日数与舍入假设。",
    sideEffect: "read",
    resource: "pure",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["principal_yuan", "start_date", "end_date", "rate"],
      properties: {
        principal_yuan: { type: "number", minimum: 0 },
        start_date: dateSchema,
        end_date: dateSchema,
        year_days: { type: "integer", enum: [360, 365] },
        rate: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["kind", "annual_pct"],
              properties: { kind: { const: "fixed" }, annual_pct: { type: "number" } },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["kind", "lpr_term", "plus_bp"],
              properties: { kind: { const: "lpr_plus" }, lpr_term: { const: "1Y" }, plus_bp: { type: "number" } },
            },
          ],
        },
      },
    },
    invoke: (p) => calcInterest(p),
  },
  {
    name: "redact.scan",
    title: "直接标识符扫描",
    description: "确定性扫描身份证/手机号/银行卡/统一社会信用代码/邮箱/车牌；未覆盖类别如实列出。",
    sideEffect: "read",
    resource: "pure",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: { text: { type: "string" } },
    },
    invoke: (p) => redactScan(p),
  },
  {
    name: "materials.read_excerpt",
    title: "读取材料片段",
    description: "按解析版本与字符区间/锚点读取材料文本；令牌须绑定对应事项。",
    sideEffect: "read",
    resource: "matter_materials",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["parse_version_id"],
      properties: {
        parse_version_id: { type: "string" },
        char_start: { type: "integer", minimum: 0 },
        char_end: { type: "integer", minimum: 0 },
        anchor_id: { type: "string" },
      },
    },
    invoke: async (p, ctx) => materialsReadExcerpt(ctx.db, ctx.claims.mid, p),
  },
  {
    name: "docx.apply_revisions",
    title: "写入原生修订",
    description: "在 DOCX 上按锚点写入 w:ins/w:del 与批注；基线或原文 hash 不符即整体停止，不覆盖原件。",
    sideEffect: "write_draft",
    resource: "matter_documents",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["document_version_id", "baseline_hash", "ops"],
      properties: {
        document_version_id: { type: "string" },
        baseline_hash: { type: "string", pattern: "^[0-9a-f]{64}$" },
        ops: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["opId", "anchor", "originalHash", "newText", "author"],
            properties: {
              opId: { type: "string" },
              anchor: {
                type: "object",
                additionalProperties: false,
                required: ["originalText"],
                properties: {
                  originalText: { type: "string" },
                  occurrence: { type: "integer", minimum: 0 },
                  paragraphHint: { type: "string" },
                },
              },
              originalHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
              newText: { type: "string" },
              comment: { type: "string" },
              ruleId: { type: "string" },
              riskLevel: { type: "string", enum: ["high", "mid", "low"] },
              author: { type: "string" },
            },
          },
        },
      },
    },
    invoke: async (p, ctx) => docxApplyRevisions(ctx.db, ctx.blobs, ctx.claims.mid, p),
  },
  {
    name: "docx.compare",
    title: "整稿比对（含静默改动检出）",
    description: "基线与回稿段落级比对；未被修订标记覆盖的改动判为静默改动。",
    sideEffect: "read",
    resource: "matter_documents",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["baseline_document_version_id", "current_document_version_id"],
      properties: {
        baseline_document_version_id: { type: "string" },
        current_document_version_id: { type: "string" },
      },
    },
    invoke: async (p, ctx) => docxCompare(ctx.db, ctx.blobs, ctx.claims.mid, p),
  },
  {
    name: "docx.sanitize",
    title: "受众净化",
    description: "接受修订、清除批注与作者属性，产出对外版本；保留生成标识。",
    sideEffect: "write_draft",
    resource: "matter_documents",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["document_version_id"],
      properties: { document_version_id: { type: "string" } },
    },
    invoke: async (p, ctx) => docxSanitize(ctx.db, ctx.blobs, ctx.claims.mid, p),
  },
  {
    name: "docx.render_report",
    title: "生成文书（DOCX）",
    description: "按标题与段落结构生成 Word 文书（备忘录、意见书、函件、清单），登记为本任务的草稿成果交律师审阅；导出时按事项令牌表还原代号。",
    sideEffect: "write_draft",
    resource: "matter_work",
    version: "2",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "sections"],
      properties: {
        title: { type: "string" },
        sections: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["heading", "paragraphs"],
            properties: { heading: { type: "string" }, paragraphs: { type: "array", items: { type: "string" } } },
          },
        },
      },
    },
    invoke: async (p, ctx) => {
      const r = docxRenderReport(ctx.blobs, p, ctx.claims.mid);
      // 任务内调用（Agent 经本机端点）：登记为草稿成果，律师在执行态与交付件页可见
      if (!ctx.claims.rid) return r;
      const title = String(p.title ?? "文书").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").trim().slice(0, 60) || "文书";
      return { ...r, ...registerToolArtifact(ctx, { kind: "agent_report", filename: `${title}.docx`, sha256: r.sha256, storage_uri: r.storage_uri, manifest: { tool: "docx.render_report", sections: Array.isArray(p.sections) ? p.sections.length : 0 } }) };
    },
  },
  {
    name: "redact.apply",
    title: "生成脱敏件与脱敏报告",
    description: "按确定性扫描结果遮盖直接标识符，产出脱敏件（不留修订痕迹）与替换统计；未覆盖类别如实声明。",
    sideEffect: "write_draft",
    resource: "matter_documents",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["document_version_id"],
      properties: { document_version_id: { type: "string" } },
    },
    invoke: async (p, ctx) => redactApply(ctx.db, ctx.blobs, ctx.claims.mid, p),
  },
  {
    name: "materials.list",
    title: "材料目录",
    description: "列出本事项的材料：本任务提供的快照序号、解析版本、字数、页数与识别质量（partial/unreadable 表示有页未能识别，须在结论中说明未读取范围）。",
    sideEffect: "read",
    resource: "matter_materials",
    version: "1",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    invoke: (_p, ctx) => materialsList(ctx),
  },
  {
    name: "riskcards.submit",
    title: "提交风险卡",
    description:
      "把合同审查发现的问题作为结构化风险卡提交到律师的审查工作台（不要只写在正文里）。anchor_text 必须逐字摘自合同原文（与材料快照一致，含代号），便于定位与生成原生修订；suggestion 是替换 anchor_text 的建议条款全文（不改则省略）；basis 列法律依据（法名 + 条号，内核离线核验）。",
    sideEffect: "write_draft",
    resource: "matter_work",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["cards"],
      properties: {
        document_version_id: { type: "string" },
        cards: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["anchor_text", "severity", "issue"],
            properties: {
              clause_ref: { type: "string" },
              anchor_text: { type: "string" },
              severity: { type: "string", enum: ["high", "mid", "low"] },
              category: { type: "string", enum: ["legal", "commercial", "both"] },
              issue: { type: "string" },
              basis: {
                type: "array",
                items: { type: "object", additionalProperties: false, required: ["law"], properties: { law: { type: "string" }, article: { type: "integer", minimum: 1 }, note: { type: "string" } } },
              },
              suggestion: { type: "string" },
              fallback: { type: "string" },
              needs_client_decision: { type: "boolean" },
              assumptions: { type: "string" },
            },
          },
        },
      },
    },
    invoke: (p, ctx) => riskcardsSubmit(ctx, p),
  },
  {
    name: "riskcards.list",
    title: "读取风险卡",
    description: "读取本事项的风险卡及律师的处理结果（lawyer_status：proposed 待处理 / accepted 接受 / modified 修改后接受（lawyer_text 为律师改写的条款）/ rejected 不采纳）。写修订稿时只采用 accepted 与 modified。",
    sideEffect: "read",
    resource: "matter_work",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        document_version_id: { type: "string" },
        status: { type: "array", items: { type: "string", enum: ["proposed", "accepted", "modified", "rejected"] } },
        this_task_only: { type: "boolean" },
      },
    },
    invoke: (p, ctx) => riskcardsList(ctx, p),
  },
  {
    name: "facts.submit",
    title: "提交事实",
    description:
      "把从材料中整理出的事实逐条提交到事实时间线（kind：claimed 材料声称 / inferred 推论 / to_confirm 待确认；不能标为已确认——由律师确认）。quote 逐字摘自 document_version_id 对应材料，occurred_on 为 YYYY-MM-DD（可只到年或月），amount_yuan 为金额（元）。",
    sideEffect: "write_draft",
    resource: "matter_work",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["facts"],
      properties: {
        facts: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["statement"],
            properties: {
              statement: { type: "string" },
              kind: { type: "string", enum: ["claimed", "inferred", "to_confirm"] },
              occurred_on: { type: "string" },
              amount_yuan: { type: "number" },
              party: { type: "string" },
              document_version_id: { type: "string" },
              quote: { type: "string" },
            },
          },
        },
      },
    },
    invoke: (p, ctx) => factsSubmit(ctx, p),
  },
  {
    name: "facts.list",
    title: "读取事实",
    description: "读取本事项的事实时间线及律师确认状态；起草文书与汇报时只把 lawyer_status=confirmed 的事实写成确定陈述。",
    sideEffect: "read",
    resource: "matter_work",
    version: "1",
    inputSchema: { type: "object", additionalProperties: false, properties: { confirmed_only: { type: "boolean" } } },
    invoke: (p, ctx) => factsList(ctx, p),
  },
  {
    name: "xlsx.render_table",
    title: "生成表格（XLSX）",
    description: "按列生成 Excel 表格（证据目录、时间线、问题清单、计算明细等），登记为本任务的草稿成果交律师审阅；每个表 1–40 列、最多 5,000 行；单元格为文字或数字。",
    sideEffect: "write_draft",
    resource: "matter_work",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "sheets"],
      properties: {
        title: { type: "string" },
        sheets: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "columns", "rows"],
            properties: {
              name: { type: "string" },
              columns: { type: "array", items: { type: "string" } },
              rows: { type: "array", items: { type: "array", items: {} } },
            },
          },
        },
      },
    },
    invoke: (p, ctx) => xlsxRenderTable(ctx, p),
  },
];

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** 法律工具清单（MCP 服务名 legal；引擎看到的名字为 mcp__legal__<name>）。 */
export const LEGAL_MCP_SERVER = "legal";

let lockState: { lock: ToolLock | null; registry: ManifestRegistry; problems: Map<string, string>; error: string | null } | null = null;

/**
 * 设定（或重设）验签后的工具清单锁文件（内核启动时以配置路径与内容签名公钥调用）。
 * 锁文件不可用时清单为空：任何法律工具都不暴露、不可调用（失败关闭）。
 */
export function setLegalToolLock(file: string | null, signerPub: string): void {
  let lock: ToolLock | null = null;
  let error: string | null = null;
  try {
    if (!file) throw new Error("未配置工具清单锁文件");
    lock = loadSignedToolLock(file, signerPub);
  } catch (e) {
    error = (e as Error).message;
    console.error(`[tools] 工具清单锁文件不可用，法律工具一律不暴露：${error}`);
  }
  const problems = verifyToolsAgainstLock(lock, TOOLS);
  for (const [name, why] of problems) if (lock) console.error(`[tools] ${name}：${why}——不暴露`);
  lockState = { lock, registry: lock ? registryFromLock(lock) : new ManifestRegistry([]), problems, error };
}

/** 开发与测试默认：仓库内签名产物 + 开发内容签名公钥（生产由内核以配置路径显式设定）。 */
function defaultLockState(): NonNullable<typeof lockState> {
  if (!lockState) {
    let here: string | null = null;
    try {
      here = dirname(fileURLToPath(import.meta.url));
    } catch {
      here = typeof __dirname !== "undefined" ? __dirname : null;
    }
    const candidates = [
      process.env.ZR_TOOL_MANIFEST_FILE,
      here ? join(here, "..", "..", "..", "..", "content", "tool-manifest", "dist", "tool-manifest.lock.json") : undefined,
      here ? join(here, "tool-manifest", "tool-manifest.lock.json") : undefined,
    ].filter((p): p is string => !!p);
    const file = candidates.find((p) => existsSync(p)) ?? null;
    let pub = process.env.ZR_LAWDB_SIGNER_PUB ?? "";
    if (!pub && here) {
      const pubFile = [join(here, "..", "..", "..", "..", "content", "keys", "content-signing-dev.pub.json"), join(here, "lawdb", "content-signing.pub.json")].find((p) => existsSync(p));
      if (pubFile) pub = (JSON.parse(readFileSync(pubFile, "utf8")) as { publicKeyPem?: string }).publicKeyPem ?? "";
    }
    setLegalToolLock(file, pub);
  }
  return lockState!;
}

/** 工具清单注册表（来自验签后的锁文件；与实现不一致的工具已剔除）。 */
export function legalToolManifests(): ManifestRegistry {
  const st = defaultLockState();
  return new ManifestRegistry(st.registry.list().filter((m) => !st.problems.has(m.name)));
}

/** 不得暴露的工具（实现与锁文件不一致、锁文件未登记、锁文件不可用）。 */
export function legalToolLockProblems(): ReadonlyMap<string, string> {
  return defaultLockState().problems;
}

export function manifestFor(name: string): ToolManifest | undefined {
  return legalToolManifests().list().find((m) => m.name === name);
}

/** 进程内直接调用（确定性工作流）；MCP 端点见 ../local-server.ts。 */
export async function invokeTool(name: string, params: unknown, ctx: InvokeCtx): Promise<unknown> {
  const tool = findTool(name);
  if (!tool) throw new DomainError("not_found", `工具 ${name} 不存在`, 404);
  validateParams(tool.inputSchema, params ?? {});
  return tool.invoke(params, ctx);
}

/** 简易 JSON Schema 校验（v0：type/required/properties/additionalProperties/enum/const/minimum/pattern）。 */
export function validateParams(schema: Record<string, any>, params: any, path = "params"): void {
  if (schema.type === "object") {
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      throw new DomainError("validation", `${path} 须为对象`, 422);
    }
    for (const req of schema.required ?? []) {
      if (!(req in params)) throw new DomainError("validation", `${path}.${req} 缺失`, 422);
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const k of Object.keys(params)) {
        if (!allowed.has(k)) throw new DomainError("validation", `${path}.${k} 不在 schema 允许范围`, 422);
      }
    }
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      if (k in params) validateParams(sub as Record<string, any>, params[k], `${path}.${k}`);
    }
    return;
  }
  if (schema.oneOf) {
    const errors: string[] = [];
    for (const sub of schema.oneOf) {
      try {
        validateParams(sub, params, path);
        return;
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    throw new DomainError("validation", `${path} 不匹配任一允许形态: ${errors.join("; ")}`, 422);
  }
  if (schema.const !== undefined && params !== schema.const) {
    throw new DomainError("validation", `${path} 须为常量 ${JSON.stringify(schema.const)}`, 422);
  }
  if (schema.enum && !schema.enum.includes(params)) {
    throw new DomainError("validation", `${path} 须为 ${schema.enum.join("/")}`, 422);
  }
  switch (schema.type) {
    case "string":
      if (typeof params !== "string") throw new DomainError("validation", `${path} 须为字符串`, 422);
      if (schema.pattern && !new RegExp(schema.pattern).test(params)) throw new DomainError("validation", `${path} 格式不符`, 422);
      break;
    case "integer":
      if (!Number.isInteger(params)) throw new DomainError("validation", `${path} 须为整数`, 422);
      if (schema.minimum !== undefined && params < schema.minimum) throw new DomainError("validation", `${path} 小于下限`, 422);
      break;
    case "number":
      if (typeof params !== "number" || !Number.isFinite(params)) throw new DomainError("validation", `${path} 须为数字`, 422);
      if (schema.minimum !== undefined && params < schema.minimum) throw new DomainError("validation", `${path} 小于下限`, 422);
      break;
    case "array":
      if (!Array.isArray(params)) throw new DomainError("validation", `${path} 须为数组`, 422);
      if (schema.items) for (let i = 0; i < params.length; i++) validateParams(schema.items, params[i], `${path}[${i}]`);
      break;
    default:
      break;
  }
}
