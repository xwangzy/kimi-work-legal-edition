/**
 * 风险卡的建议性质与谈判梯度（v9.3 P2 / Astra M-1，评审 Z3 §6.2）。纯函数，供工作台与用例共用。
 * 非诉律师最要紧的是分清“必须改”（法律硬伤、律所红线）与“可以谈”（商业条件）：卡片标题行给性质胶囊，正文按“首选 → 可退让 → 底线”三行。
 */
export type RiskNature = "must" | "should" | "negotiable";

export const NATURE_LABEL: Readonly<Record<RiskNature, string>> = { must: "必须修改", should: "建议修改", negotiable: "可谈判" };
/** 胶囊配色：必须修改红、建议修改橙、可谈判蓝。 */
export const NATURE_PILL: Readonly<Record<RiskNature, string>> = { must: "pill-red", should: "pill-orange", negotiable: "pill-blue" };

/** 没有标性质的卡（第 15 批之前生成的）按类别与严重程度推定，与内核 defaultNature 同一口径。 */
export function natureOf(c: { nature?: RiskNature | null; category: string; severity: string }): RiskNature {
  if (c.nature === "must" || c.nature === "should" || c.nature === "negotiable") return c.nature;
  if (c.category === "commercial") return "negotiable";
  return c.category === "legal" && c.severity === "high" ? "must" : "should";
}

/**
 * 正文的梯度行：律师改写过的显示“你的修改”替代首选；只有一级时仍叫“建议改为”（不硬造梯度）；
 * 有可退让或底线时首行叫“首选”。
 */
export function ladderRows(c: { status: string; suggestion: string | null; final_text: string | null; fallback: string | null; bottom_line?: string | null }): { key: "mine" | "first" | "fallback" | "bottom"; label: string; text: string }[] {
  const rows: { key: "mine" | "first" | "fallback" | "bottom"; label: string; text: string }[] = [];
  const graded = !!(c.fallback?.trim() || c.bottom_line?.trim());
  if (c.status === "modified" && c.final_text) rows.push({ key: "mine", label: "你的修改", text: c.final_text });
  else if (c.suggestion?.trim()) rows.push({ key: "first", label: graded ? "首选" : "建议改为", text: c.suggestion });
  if (c.fallback?.trim()) rows.push({ key: "fallback", label: "可退让", text: c.fallback });
  if (c.bottom_line?.trim()) rows.push({ key: "bottom", label: "底线", text: c.bottom_line });
  return rows;
}
