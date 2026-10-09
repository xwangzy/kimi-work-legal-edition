/**
 * 工具注册表：内核内模块（方案 v5.0 §15：tool-gateway 从独立服务改为内核内模块；
 * MCP 端点保留供 Agent 使用；确定性工作流进程内直接调用）。
 * “平台对工具 schema 校验严格”（§4.1）——inputSchema 一律 additionalProperties:false。
 * 外发、签发、删除类工具根本不在注册表内（§6.2）。
 */
import type { CapabilityClaims } from "@zr-legal/service-auth";
import { DomainError } from "@zr-legal/domain";
import type { Lawdb } from "@zr-legal/lawdb";
import type { KernelDb } from "../db.ts";
import type { BlobStore } from "../blobs.ts";
import { lawGetVersion, lawSearch } from "./tools/law.ts";
import { citationsVerify } from "./tools/citations.ts";
import { calcInterest } from "./tools/calc.ts";
import { redactScan } from "./tools/redact.ts";
import { materialsReadExcerpt } from "./tools/materials.ts";
import { docxApplyRevisions, docxCompare, docxRenderReport, docxSanitize, redactApply } from "./tools/docx.ts";

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  invoke: (params: any, ctx: InvokeCtx) => Promise<unknown> | unknown;
}

export interface InvokeCtx {
  claims: CapabilityClaims;
  db: KernelDb;
  blobs: BlobStore;
  lawdb: Lawdb;
}

const dateSchema = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };

export const TOOLS: readonly ToolDef[] = [
  {
    name: "law.get_version",
    title: "法规版本查询",
    description: "按法名与适用时点返回适用版本（现行与历史适用分开）；注册库没有的法源如实返回 found=false，不伪造。",
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
    description: "按标题与段落结构生成 DOCX（意见书/报告/清单）。",
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
    invoke: async (p, ctx) => docxRenderReport(ctx.blobs, p, ctx.claims.mid),
  },
  {
    name: "redact.apply",
    title: "生成脱敏件与脱敏报告",
    description: "按确定性扫描结果遮盖直接标识符，产出脱敏件（不留修订痕迹）与替换统计；未覆盖类别如实声明。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["document_version_id"],
      properties: { document_version_id: { type: "string" } },
    },
    invoke: async (p, ctx) => redactApply(ctx.db, ctx.blobs, ctx.claims.mid, p),
  },
];

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
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
