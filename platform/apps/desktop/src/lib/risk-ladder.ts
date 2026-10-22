/**
 * 风险卡的建议性质与谈判梯度（v9.3 P2 / Astra M-1，评审 Z3 §6.2）。纯函数，供工作台与用例共用。
 * 非诉律师最要紧的是分清“必须改”（法律硬伤、律所红线）与“可以谈”（商业条件）：卡片标题行给性质胶囊，正文按“首选 → 可退让 → 底线”三行。
 */
export type RiskNature = "must" | "should" | "negotiable";

export const NATURE_LABEL: Readonly<Record<RiskNature, string>> = { must: "必须修改", should: "建议修改", negotiable: "可谈判" };
/** 胶囊配色：必须修改红、建议修改橙、可谈判蓝。 */
export const NATURE_PILL: Readonly<Record<RiskNature, string>> = { must: "pill-red", should: "pill-orange", negotiable: "pill-blue" };

/** 卡的类型（v9.4 第 19 批 C-02，评审 C1 §2.2）：风险卡不另标胶囊，其余三类在标题行标出。 */
export type RiskKind = "risk" | "missing" | "deviation" | "consistency";
export const KIND_LABEL: Readonly<Record<RiskKind, string>> = { risk: "风险", missing: "缺失", deviation: "偏离规则", consistency: "前后不一致" };
/** 判断依据来源（三分，C1 §2.2 第 3 条）：律师据此分清哪些能和对方硬谈、哪些只是商业偏好。 */
export const RULE_SOURCE_LABEL: Readonly<Record<"law" | "firm_rule" | "general", string>> = { law: "法律强制", firm_rule: "本所或客户规则", general: "通用建议，须你判断" };

export const kindOf = (c: { kind?: RiskKind | null }): RiskKind => (c.kind === "missing" || c.kind === "deviation" || c.kind === "consistency" ? c.kind : "risk");

/** 接受时写进修订稿的那一级（与内核 acceptedText 一致）：选了可退让且有可退让就用它，否则首选。 */
export function adoptedText(c: { suggestion: string | null; fallback: string | null; chosen_level?: "suggestion" | "fallback" | null }): string {
  return (c.chosen_level === "fallback" && c.fallback?.trim() ? c.fallback : c.suggestion) ?? "";
}

/** 内核已按类别推定好（nature_inferred 标明）；旧版本内核没给性质时按同一口径推定（没有建议文本的不推定为“必须修改”）。 */
export function natureOf(c: { nature?: RiskNature | null; category: string; severity: string; suggestion?: string | null }): RiskNature {
  if (c.nature === "must" || c.nature === "should" || c.nature === "negotiable") return c.nature;
  if (c.category === "commercial") return "negotiable";
  return c.category === "legal" && c.severity === "high" && !!(c.suggestion ?? "").trim() ? "must" : "should";
}

/** 性质胶囊的文字：推定的加“（推定）”，律师一眼分得清是谁判断的（复核 RB16B-03）。 */
export function natureText(c: { nature?: RiskNature | null; nature_inferred?: boolean; category: string; severity: string; suggestion?: string | null }): string {
  return `${NATURE_LABEL[natureOf(c)]}${c.nature_inferred || !c.nature ? "（推定）" : ""}`;
}

/**
 * 正文的梯度行：律师改写过的显示“你的修改”替代首选；只有一级时仍叫“建议改为”（不硬造梯度）；
 * 有可退让或底线时首行叫“首选”。
 */
export function ladderRows(c: {
  status: string;
  suggestion: string | null;
  final_text: string | null;
  fallback: string | null;
  bottom_line?: string | null;
  kind?: RiskKind | null;
  chosen_level?: "suggestion" | "fallback" | null;
}): { key: "mine" | "first" | "fallback" | "bottom"; label: string; text: string; chosen?: boolean }[] {
  const rows: { key: "mine" | "first" | "fallback" | "bottom"; label: string; text: string; chosen?: boolean }[] = [];
  const graded = !!(c.fallback?.trim() || c.bottom_line?.trim());
  // 已接受时标出写进修订稿的那一级（C-05）
  const fallbackChosen = c.status === "accepted" && c.chosen_level === "fallback" && !!c.fallback?.trim();
  if (c.status === "modified" && c.final_text) rows.push({ key: "mine", label: "你的修改", text: c.final_text });
  else if (c.suggestion?.trim())
    rows.push({ key: "first", label: kindOf(c) === "missing" ? "建议补充" : graded ? "首选" : "建议改为", text: c.suggestion, ...(c.status === "accepted" && !fallbackChosen && graded ? { chosen: true } : {}) });
  if (c.fallback?.trim()) rows.push({ key: "fallback", label: "可退让", text: c.fallback, ...(fallbackChosen ? { chosen: true } : {}) });
  // 底线是给律师与客户商定的参考，最终由客户决定（复核 RB16B-01）
  if (c.bottom_line?.trim()) rows.push({ key: "bottom", label: "建议底线（待客户定）", text: c.bottom_line });
  return rows;
}
