/**
 * 点数估算（v0 费率表；§4.3 经济性内建：任务开始前显示预计点数）。
 * 平台失败不扣点（§4.3 交互 9）；点数与真实成本分账（W2 G1 完整实现）。
 */
export interface EstimateInput {
  scenario: string;
  material_count: number;
  total_pages: number | null;
  deliverables?: string[];
}

export interface Estimate {
  scenario: string;
  points: number;
  breakdown: { item: string; points: number }[];
  valid_seconds: number;
  assumptions: string[];
}

/** v0 费率：与第 3 篇规格卡对外点数对齐（S1 30 点起、S1b 10 点起、S2 40 点起、A1 上限 60）。 */
const TABLE: Record<string, { base: number; per_doc: number; per_page: number; cap: number }> = {
  "s1.contract_review": { base: 30, per_doc: 10, per_page: 0.5, cap: 200 },
  "s1b.draft_compare": { base: 10, per_doc: 4, per_page: 0.2, cap: 80 },
  "s2.case_file": { base: 40, per_doc: 2, per_page: 0.3, cap: 300 },
  "s6.redaction": { base: 5, per_doc: 2, per_page: 0.1, cap: 60 },
  "a1.agent_task": { base: 20, per_doc: 5, per_page: 0, cap: 60 }, // A1 默认单任务上限 60 点
};

export function estimatePoints(input: EstimateInput): Estimate {
  const t = TABLE[input.scenario];
  if (!t) {
    return {
      scenario: input.scenario,
      points: 0,
      breakdown: [],
      valid_seconds: 0,
      assumptions: [`场景 ${input.scenario} 不在 v0 费率表（未上架场景不可估价）`],
    };
  }
  const pages = input.total_pages ?? 0;
  const breakdown = [
    { item: "基础", points: t.base },
    { item: `材料 ×${input.material_count}`, points: Math.round(t.per_doc * input.material_count) },
    { item: `页数 ×${pages}`, points: Math.round(t.per_page * pages) },
  ];
  const raw = breakdown.reduce((n, b) => n + b.points, 0);
  return {
    scenario: input.scenario,
    points: Math.min(raw, t.cap),
    breakdown,
    valid_seconds: 900,
    assumptions: [
      `单任务上限 ${t.cap} 点`,
      "页数为解析页数；无页数材料按 0 页计",
      "平台失败不扣点；取消按已发生动作结算",
      "v0 费率表，试点实测后校准",
    ],
  };
}

export function scenarioCap(scenario: string): number {
  return TABLE[scenario]?.cap ?? 0;
}
