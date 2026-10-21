/**
 * S1 交付件构建（第 3 篇 S1：修订稿/清洁稿/审查意见书；共同约定 §2.2 manifest、§2.3 格式、§2.6 降级）。
 * 修订操作的确定性来源 v0：引用核验拦截项的改引建议（规则 CITE-RENUMBER）；
 * 规则包驱动的条款级修订在 W12 接入后扩充（findings 结构不变）。
 * v5：工具调用为内核进程内直接调用（原 tool-gateway HTTP 通道）。
 */
import { sha256Hex, newId } from "@zr-legal/domain";
import { createXlsx } from "@zr-legal/docx-engine";
import type { KernelDb } from "../db.ts";
import type { BlobStore } from "../blobs.ts";
import { docxApplyRevisions, docxRenderReport, docxSanitize } from "../tools/tools/docx.ts";
import { parseDocument } from "../services/parser.ts";
import { fileDay } from "./casefile.ts";

export interface ToolIdentity {
  tid: string;
  uid: string;
  mid?: string;
  rid?: string;
  aid?: string;
}

export interface BuiltArtifacts {
  artifacts: {
    kind: string;
    filename: string;
    sha256: string;
    storage_uri: string;
    manifest: Record<string, unknown>;
    open_items: unknown[];
  }[];
  revisionPlanOps: unknown[];
  degraded: string[];
}

interface InterceptedCitation {
  raw: string;
  suggestion: string | null;
  reasons: string[];
  historical_note: string | null;
}

/** 从拦截裁决构建修订操作（仅对可解析出改引目标的条目）。 */
export function buildCitationRevisionOps(intercepted: InterceptedCitation[]): {
  opId: string;
  anchor: { originalText: string };
  originalHash: string;
  newText: string;
  comment: string;
  ruleId: string;
  riskLevel: "high";
  author: string;
}[] {
  const ops = [];
  let i = 0;
  for (const item of intercepted) {
    if (!item.suggestion) continue;
    const m = item.suggestion.match(/改引(《[^》]+》第[零一二三四五六七八九十百千]+条)/);
    if (!m) continue;
    i++;
    ops.push({
      opId: `cite-renumber-${i}`,
      anchor: { originalText: item.raw },
      originalHash: sha256Hex(item.raw),
      newText: m[1]!,
      comment: `${item.reasons.join("；")}${item.historical_note ? `（${item.historical_note}）` : ""}`,
      ruleId: "CITE-RENUMBER-001",
      riskLevel: "high" as const,
      author: "Kimi Work 法律发行版（AI 建议）",
    });
  }
  return ops;
}

export function registerDerivedDocument(
  db: KernelDb,
  blobs: BlobStore,
  args: { tenantId: string; matterId: string; filename: string; bytes: Buffer; supersedes?: string | null; uploadedBy: string },
): { document_version_id: string; parse_version_id: string } {
  const stored = blobs.put(args.bytes, args.matterId);
  const docId = newId("documentVersion");
  const parsed = parseDocument(args.filename, "application/octet-stream", args.bytes);
  db.run(
    `INSERT INTO document_versions (document_version_id, matter_id, tenant_id, filename, sha256, size_bytes, mime, storage_mode, storage_uri, supersedes, uploaded_by)
     VALUES (?,?,?,?,?,?,?,'import',?,?,?)`,
    [docId, args.matterId, args.tenantId, args.filename, stored.sha256, args.bytes.length, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", stored.storage_uri, args.supersedes ?? null, args.uploadedBy],
  );
  const psvId = newId("parseVersion");
  db.run(
    `INSERT INTO parse_versions (parse_version_id, document_version_id, parser, parser_version, page_count, quality_flags, text_uri)
     VALUES (?,?,?,?,?,?,?)`,
    [psvId, docId, parsed.parser, parsed.parserVersion, parsed.pageCount, JSON.stringify(parsed.qualityFlags), `db://parse_texts/${psvId}`],
  );
  db.run(`INSERT INTO parse_texts (parse_version_id, content) VALUES (?,?)`, [psvId, parsed.text]);
  return { document_version_id: docId, parse_version_id: psvId };
}

export function buildS1Deliverables(
  db: KernelDb,
  blobs: BlobStore,
  identity: ToolIdentity,
  args: {
    runId: string;
    matterId: string;
    tenantId: string;
    createdBy: string;
    primaryDoc: { document_version_id: string; filename: string; sha256: string };
    citations: { total: number; intercepted: number; verdicts: unknown[]; intercepted_items: InterceptedCitation[] };
    reviewText: string;
    modelMeta: { request_id: string; route: string; cost_microcny: number | null };
  },
): BuiltArtifacts {
  const degraded: string[] = [];
  const artifacts: BuiltArtifacts["artifacts"] = [];
  const ops = buildCitationRevisionOps(args.citations.intercepted_items);
  const isDocx = args.primaryDoc.filename.toLowerCase().endsWith(".docx");

  // 1. 修订稿（DOCX 原生修订；非 DOCX 降级为意见书内标注）
  if (isDocx && ops.length > 0) {
    const applied = docxApplyRevisions(db, blobs, args.matterId, {
      document_version_id: args.primaryDoc.document_version_id,
      baseline_hash: args.primaryDoc.sha256,
      ops,
    });
    artifacts.push({
      kind: "s1_redline",
      filename: `修订稿-${args.primaryDoc.filename}`,
      sha256: applied.sha256,
      storage_uri: applied.storage_uri,
      manifest: {
        baseline: args.primaryDoc.sha256,
        ops_count: ops.length,
        applied: applied.applied,
        revision_ops: ops,
        note: "原生修订（w:ins/w:del）+ 批注；作者标记 AI 建议，复核后由律师批准",
      },
      open_items: [],
    });
    // 2. 清洁稿：由同一批准内容派生（接受修订后的定稿文本）
    const revisedDoc = registerDerivedDocument(db, blobs, {
      tenantId: args.tenantId,
      matterId: args.matterId,
      filename: `修订稿-${args.primaryDoc.filename}`,
      bytes: blobs.read(applied.storage_uri),
      supersedes: args.primaryDoc.document_version_id,
      uploadedBy: args.createdBy,
    });
    const clean = docxSanitize(db, blobs, args.matterId, { document_version_id: revisedDoc.document_version_id });
    artifacts.push({
      kind: "s1_clean",
      filename: `清洁稿-${args.primaryDoc.filename}`,
      sha256: clean.sha256,
      storage_uri: clean.storage_uri,
      manifest: { derived_from: applied.sha256, removed: clean.removed, note: "预览派生：接受全部修订（含未被律师接受的建议）；批准流接入后改由批准内容派生（§2.4）" },
      open_items: [],
    });
  } else if (!isDocx) {
    degraded.push("主材料非 DOCX：降级为仅在意见书中列出改引建议（§S1 失败与降级）");
  } else {
    degraded.push("无需要改引的拦截项：不出修订稿");
  }

  // 3. 审查意见书（DOCX）
  const opinion = docxRenderReport(blobs, {
    title: "合同审查意见书（内部稿）",
    sections: [
      {
        heading: "一、审查范围与假设",
        paragraphs: [
          `主合同：${args.primaryDoc.filename}（hash 前 12 位 ${args.primaryDoc.sha256.slice(0, 12)}）`,
          "本意见书为 AI 辅助起草的内部草稿，未经律师复核签发不得对外使用（§2.5）。",
          `引用核验：共 ${args.citations.total} 条，拦截 ${args.citations.intercepted} 条（拦截不静默删除，见风险清单）。`,
        ],
      },
      {
        heading: "二、总体结论",
        paragraphs: [args.citations.intercepted > 0 ? "修改后可签：存在需改引/核实的引用与风险项，详见风险清单。" : "可签（在已核验范围内未发现阻断问题）。"],
      },
      {
        heading: "三、风险清单（红/橙/黄）",
        paragraphs:
          args.citations.intercepted_items.length > 0
            ? args.citations.intercepted_items.map(
                (c, i) => `[红] R-${i + 1} 引用失效风险：${c.raw}。${c.suggestion ?? "需人工核实"}。${c.historical_note ?? ""}`,
              )
            : ["（本次未发现需列示的风险项）"],
      },
      {
        heading: "四、模型分析摘要（模型路由留痕）",
        paragraphs: [
          `路由 ${args.modelMeta.route}，请求 ${args.modelMeta.request_id}，成本 ${((args.modelMeta.cost_microcny ?? 0) / 1e6).toFixed(4)} 元`,
          args.reviewText.slice(0, 1500),
        ],
      },
      {
        heading: "五、未决项与限制声明",
        paragraphs: [
          ...degraded,
          "本意见书不构成对未审附件、未提供材料的意见；签发绑定最终文件 hash，批准后任何实质编辑生成新版本。",
        ],
      },
    ],
  }, args.matterId);
  artifacts.push({
    kind: "s1_opinion",
    filename: `审查意见书（内部稿）-${fileDay()}.docx`,
    sha256: opinion.sha256,
    storage_uri: opinion.storage_uri,
    manifest: { audience: "internal", note: "内部稿；客户版经受众净化与签发后生成" },
    open_items: args.citations.intercepted > 0 ? [{ kind: "citation_intercepted", count: args.citations.intercepted }] : [],
  });

  // 4. 条款问题表（XLSX）
  const issueRows: (string | number | null)[][] = [
    ["问题ID", "原文锚点", "风险等级", "规则", "建议", "依据状态", "处理人", "状态"],
    ...args.citations.intercepted_items.map((c, i) => [
      `Q-${i + 1}`,
      c.raw,
      "高",
      "CITE-RENUMBER-001",
      c.suggestion ?? "人工核实",
      "已拦截（来源已核/版本不适用）",
      "",
      "待处理",
    ] as (string | number | null)[]),
  ];
  const xlsxStored = blobs.put(createXlsx([{ name: "条款问题表", rows: issueRows }]), args.matterId);
  artifacts.push({
    kind: "s1_issue_table",
    filename: `条款问题表-${fileDay()}.xlsx`,
    sha256: xlsxStored.sha256,
    storage_uri: xlsxStored.storage_uri,
    manifest: { rows: issueRows.length - 1 },
    open_items: [],
  });

  return { artifacts, revisionPlanOps: ops, degraded };
}
