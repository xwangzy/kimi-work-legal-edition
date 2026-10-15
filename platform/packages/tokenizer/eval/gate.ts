/**
 * S8 锁定测试集与发布门禁（调研 Y5 §4.4“切分”“门禁”）：
 * - 锁定集清单：金标准文件的 SHA-256、文书数、按来源与类别的提及数——清单可以入库，锁定集原文不入库、规则作者不接触；
 * - 门禁：按来源分别检查（不合并成一个数），召回取 95% 区间**下界**、人级泄露取**上界**与阈值比较；阈值由产品与法务拍板，
 *   本文件不内置任何“已批准”的数值，阈值文件必须写明 status。
 */
import { createHash } from "node:crypto";
import { GOLD_CATEGORIES, type EvalReport, type GoldDoc } from "./evaluate.ts";

export interface LockedManifest {
  format: "kwl-s8-locked/1";
  /** 金标准 JSONL 文件字节的 SHA-256（十六进制）。 */
  sha256: string;
  docs: number;
  sources: Record<string, number>;
  /** 类别 → 标注提及数。 */
  mentions: Record<string, number>;
  /** 版本说明（例如“2026Q4-v1”），由评测负责人填写。 */
  version: string;
  created_at: string;
}

export function lockManifest(fileBytes: Uint8Array, docs: GoldDoc[], version: string, now = new Date()): LockedManifest {
  const sources: Record<string, number> = {};
  const mentions: Record<string, number> = {};
  for (const d of docs) {
    sources[d.source] = (sources[d.source] ?? 0) + 1;
    for (const s of d.spans) mentions[s.category] = (mentions[s.category] ?? 0) + 1;
  }
  const order = (r: Record<string, number>) => Object.fromEntries(Object.entries(r).sort((a, b) => a[0].localeCompare(b[0])));
  return { format: "kwl-s8-locked/1", sha256: createHash("sha256").update(fileBytes).digest("hex"), docs: docs.length, sources: order(sources), mentions: order(mentions), version, created_at: now.toISOString() };
}

/** 核对金标准文件与锁定清单一致（字节摘要 + 文书数）；返回问题列表（空 = 一致）。 */
export function verifyLocked(fileBytes: Uint8Array, docs: GoldDoc[], m: LockedManifest): string[] {
  const problems: string[] = [];
  if (m?.format !== "kwl-s8-locked/1") problems.push("清单格式不是 kwl-s8-locked/1");
  const sha = createHash("sha256").update(fileBytes).digest("hex");
  if (sha !== m?.sha256) problems.push("金标准文件与锁定清单的摘要不一致（锁定集被改动或不是这份清单对应的文件）");
  if (docs.length !== m?.docs) problems.push(`文书数 ${docs.length} 与清单 ${m?.docs} 不一致`);
  return problems;
}

export interface GateThresholds {
  /** 必填：阈值的审批状态。只有 "approved" 的阈值才能作为发布门禁；"draft" 只做提示（产品与法务未拍板前一律 draft）。 */
  status: "draft" | "approved";
  /** 类别 → 召回 95% 区间下界的最低值。 */
  recall_lower_bound: Partial<Record<string, number>>;
  /** 人级泄露率 95% 区间上界的最高值。 */
  person_leak_upper_bound?: number;
  /** 适用的来源（缺省：除 synthetic 之外的全部来源；合成集不作门禁依据）。 */
  sources?: string[];
  /** 有该类别提及的文书少于此数时判“样本不足”（缺省 30）。 */
  min_docs?: number;
}

export interface GateFinding {
  source: string;
  metric: string;
  verdict: "pass" | "fail" | "insufficient";
  /** 用于比较的区间端点。 */
  bound: number | null;
  threshold: number;
}

/**
 * 阈值文件的格式问题（复核 S6A-06：配置失误不得静默放行）：status 必须恰为 draft / approved；类别名必须登记；
 * 阈值在 0–1 之间；合成来源不得作为门禁对象。返回问题列表（空 = 合格）。
 */
export function validateThresholds(t: unknown): string[] {
  const p: string[] = [];
  const o = (t ?? {}) as Record<string, unknown>;
  if (o.status !== "draft" && o.status !== "approved") p.push("status 必须是 draft 或 approved");
  const rl = o.recall_lower_bound as Record<string, unknown> | undefined;
  if (!rl || typeof rl !== "object" || Object.keys(rl).length === 0) p.push("recall_lower_bound 至少给一个类别");
  for (const [k, v] of Object.entries(rl ?? {})) {
    if (!GOLD_CATEGORIES.includes(k as never) || k === "negative") p.push(`未登记的类别：${k}`);
    if (typeof v !== "number" || !(v >= 0 && v <= 1)) p.push(`${k} 的阈值须在 0–1 之间`);
  }
  if (o.person_leak_upper_bound !== undefined && !(typeof o.person_leak_upper_bound === "number" && o.person_leak_upper_bound >= 0 && o.person_leak_upper_bound <= 1)) p.push("person_leak_upper_bound 须在 0–1 之间");
  if (Array.isArray(o.sources) && o.sources.includes("synthetic")) p.push("合成来源（synthetic）不得作为门禁对象");
  return p;
}

/** 按来源逐项比较；不足样本的项判 insufficient（门禁视同未过）。 */
export function checkGate(bySource: Record<string, EvalReport>, t: GateThresholds): { ok: boolean; approved: boolean; findings: GateFinding[] } {
  const findings: GateFinding[] = [];
  const minDocs = t.min_docs ?? 30;
  const sources = (t.sources ?? Object.keys(bySource)).filter((s) => s !== "synthetic");
  for (const src of sources) {
    const r = bySource[src];
    for (const [cat, th] of Object.entries(t.recall_lower_bound ?? {})) {
      if (typeof th !== "number" || !GOLD_CATEGORIES.includes(cat as never)) continue;
      const m = r?.recallByCategory[cat];
      if (!m || m.ci95 === null || m.docsWithData < minDocs) {
        findings.push({ source: src, metric: `recall.${cat}`, verdict: "insufficient", bound: m?.ci95?.[0] ?? null, threshold: th });
        continue;
      }
      findings.push({ source: src, metric: `recall.${cat}`, verdict: m.ci95[0] >= th ? "pass" : "fail", bound: m.ci95[0], threshold: th });
    }
    if (typeof t.person_leak_upper_bound === "number") {
      const m = r?.personLeakRate;
      if (!m || m.ci95 === null || m.docsWithData < minDocs) findings.push({ source: src, metric: "person_leak", verdict: "insufficient", bound: m?.ci95?.[1] ?? null, threshold: t.person_leak_upper_bound });
      else findings.push({ source: src, metric: "person_leak", verdict: m.ci95[1] <= t.person_leak_upper_bound ? "pass" : "fail", bound: m.ci95[1], threshold: t.person_leak_upper_bound });
    }
  }
  return { ok: findings.length > 0 && findings.every((f) => f.verdict === "pass"), approved: t.status === "approved", findings };
}
