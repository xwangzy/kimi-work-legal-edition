/**
 * 工具结果的状态摘要（第 42 批）：只有状态词、计数与布尔值，不含任何正文、文件名、当事人信息。
 *
 * 此前工具调用在账本里只留“成功 / 失败”与结果摘要值：V16 两轮 57 张卡跑完，回答不了“修改草稿有多少次锚点找不到”
 * “交付前检查报了几处、报的是哪一类”“表格整份重出了几次”——每轮都靠评分子代理读事件流人工数。摘要随工具操作记进账本
 * （tool_operations.result_summary），验收脚本 eval/ledger-summary.mjs 直接汇总。
 *
 * 只收白名单里的字段，值只取：数字、布尔、[a-z_]{1,24} 的状态词；数组只记长度；按类别计数的只记类别（枚举词）与次数。纯函数。
 */

const STATUS_RE = /^[a-z][a-z_]{0,23}$/;
const COUNT_FIELDS = ["applied", "patches", "sheets", "rows", "sections", "tables", "total", "count", "pages", "version"] as const;
const BOOL_FIELDS = ["written", "reused", "ok", "verified", "found", "truncated", "dry_run"] as const;
const ARRAY_FIELDS = ["results", "items", "hits", "versions", "articles", "conflicts", "problems", "changes", "warnings", "steps", "facts", "cards", "missing", "not_found"] as const;
const MAX_KINDS = 12;

function tally(list: unknown, key: string): Record<string, number> | null {
  if (!Array.isArray(list)) return null;
  const out: Record<string, number> = {};
  for (const x of list) {
    const k = (x as Record<string, unknown> | null)?.[key];
    if (typeof k !== "string" || !STATUS_RE.test(k)) continue;
    if (!(k in out) && Object.keys(out).length >= MAX_KINDS) continue;
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function toolResultSummary(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return Array.isArray(result) ? { n: result.length } : null;
  const r = result as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof r.status === "string" && STATUS_RE.test(r.status)) out.status = r.status;
  for (const k of COUNT_FIELDS) if (typeof r[k] === "number" && Number.isFinite(r[k])) out[k] = r[k];
  for (const k of BOOL_FIELDS) if (typeof r[k] === "boolean") out[k] = r[k];
  for (const k of ARRAY_FIELDS) if (Array.isArray(r[k])) out[`n_${k}`] = (r[k] as unknown[]).length;
  // 逐条退回的原因分布（docx.edit_draft、docx.revise、xlsx.edit_cells）
  const reasons = tally(r.conflicts, "reason") ?? tally(r.problems, "reason");
  if (reasons) out.conflict_reasons = reasons;
  // 交付前检查：是否通过、各类问题几处
  const qc = r.quality_check as { ok?: unknown; issues?: unknown } | undefined;
  if (qc && typeof qc === "object") {
    if (typeof qc.ok === "boolean") out.quality_ok = qc.ok;
    if (Array.isArray(qc.issues)) {
      out.quality_issues = qc.issues.length;
      const kinds = tally(qc.issues, "kind");
      if (kinds) out.quality_kinds = kinds;
    }
  }
  // 系统直接处理掉的、版本缩水提示：只记有没有
  if (r.auto_cleaned) out.auto_cleaned = true;
  if (r.shrink) out.shrink = true;
  return Object.keys(out).length > 0 ? out : null;
}

/** 写库用：摘要转成不超过 800 字符的 JSON；没有可记的返回 null。 */
export function toolResultSummaryJson(result: unknown): string | null {
  try {
    const s = toolResultSummary(result);
    if (!s) return null;
    const j = JSON.stringify(s);
    return j.length <= 800 ? j : JSON.stringify({ status: s.status ?? null, truncated_summary: true });
  } catch {
    return null;
  }
}
