/**
 * 成果文件的引用核验（第 13 批；评审 Z1 P0-5）：Agent 任务（研究备忘录、起诉状、律师函、审查意见等）产出的成果，
 * 签发前按成果文件自身的文字做一次离线核验——此前只有 S1 默认路径在运行中核验材料，A1 成果里的引用不受签发门禁约束。
 *
 * 判定（与 citations.verify 四态一致，生成器无权标“律师已确认”）：
 * - 定性错误（条号超出范围、已改号、适用时点无有效版本）→ 不得签发，须先改引；
 * - 案号（离线一律未核实）→ 不得签发（沿用 S1 规则：联网补核或改引）；
 * - 本机法规库未收录的法源（unknown_source）→ 系统核对不了：律师在复核页勾选“已逐条人工核对”后才可签发——
 *   如实承认法规库覆盖有限，不把“没查到”说成“没问题”，也不让演示法规库把所有成果卡死。
 * 只读：不改成果、不写事件；签发时由调用方把结果摘要写进签发记录的完整性单。
 */
import { CitationState } from "@zr-legal/domain";
import { extractParagraphs } from "@zr-legal/docx-engine";
import type { Lawdb } from "@zr-legal/lawdb";
import { citationsVerify, type CitationVerdict } from "../tools/tools/citations.ts";

export interface ArtifactCitationCheck {
  /** 能取到文字的成果才核验（xlsx、图片等为 false）。 */
  checked: boolean;
  total: number;
  /** 定性错误：条号不存在、已改号、无适用版本。 */
  wrong: number;
  /** 案号：离线未核实。 */
  unverified_offline: number;
  /** 本机法规库未收录的法源（须人工核对）。 */
  outside_registry: number;
  /** 已核到来源或版本的条数。 */
  verified: number;
  items: { raw: string; state: CitationVerdict["state"]; reason: string | null; kind: "wrong" | "case" | "outside" | "ok" }[];
  registry_coverage: string;
  as_of: string;
}

/** 成果文件 → 可见文字（docx 取段落可见文字；md/txt/csv 直接按 UTF-8）；取不到即 null。 */
export function artifactText(filename: string, bytes: Buffer): string | null {
  const name = filename.toLowerCase();
  try {
    if (name.endsWith(".docx")) return extractParagraphs(bytes).map((p) => p.text).join("\n");
    if (/\.(md|txt|csv|markdown)$/.test(name)) return bytes.toString("utf8");
  } catch {
    return null;
  }
  return null;
}

function classify(v: CitationVerdict): ArtifactCitationCheck["items"][number]["kind"] {
  if (v.state === CitationState.unverifiedOffline) return "case";
  if (v.state !== CitationState.intercepted) return "ok";
  return v.reasons.some((r) => r.startsWith("unknown_source:")) ? "outside" : "wrong";
}

export function checkArtifactCitations(lawdb: Lawdb, filename: string, bytes: Buffer, asOf: string): ArtifactCitationCheck {
  const text = artifactText(filename, bytes);
  const base: ArtifactCitationCheck = { checked: false, total: 0, wrong: 0, unverified_offline: 0, outside_registry: 0, verified: 0, items: [], registry_coverage: lawdb.packageVersion, as_of: asOf };
  if (text === null) return base;
  const r = citationsVerify(lawdb, { text: text.slice(0, 2_000_000), as_of: asOf });
  const items = r.verdicts.map((v) => ({ raw: v.raw, state: v.state, reason: v.reasons[0]?.split(":").slice(1).join(":") || null, kind: classify(v) }));
  return {
    ...base,
    checked: true,
    total: items.length,
    wrong: items.filter((i) => i.kind === "wrong").length,
    unverified_offline: items.filter((i) => i.kind === "case").length,
    outside_registry: items.filter((i) => i.kind === "outside").length,
    verified: items.filter((i) => i.kind === "ok").length,
    items: items.slice(0, 200),
    registry_coverage: r.registry_coverage,
  };
}

/** 复核清单里律师“已逐条人工核对法规库未收录的引用”的勾选键。 */
export const CITATIONS_MANUAL_CHECK_KEY = "citations_outside_registry_checked";

/** 签发门禁：返回阻止签发的理由（null = 可以签发）。 */
export function artifactCitationBlock(c: ArtifactCitationCheck, checklist: Record<string, unknown>): { code: "wrong" | "case" | "outside"; message: string } | null {
  if (!c.checked) return null;
  if (c.wrong > 0) return { code: "wrong", message: `成果里有 ${c.wrong} 条引用核对不通过（条号不存在、已改号或当时没有有效版本）：请先改正引用再签发` };
  if (c.unverified_offline > 0) return { code: "case", message: `成果里有 ${c.unverified_offline} 个案号离线无法核实：联网补核或改用可核对的引用后再签发` };
  if (c.outside_registry > 0 && checklist[CITATIONS_MANUAL_CHECK_KEY] !== true) {
    return { code: "outside", message: `成果里有 ${c.outside_registry} 条引用不在本机法规库里，系统没法自动核对：请逐条人工核对，在复核清单勾选“已逐条人工核对”后再签发` };
  }
  return null;
}
