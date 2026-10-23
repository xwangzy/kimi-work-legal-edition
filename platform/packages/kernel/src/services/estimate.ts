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
  /** 不调用 AI 的本机流程（10-23 拍板：不计点）：预计与实扣都是 0 点。 */
  local?: true;
}

/** v0 费率：与第 3 篇规格卡对外点数对齐（S1 30 点起、A1 上限 60）。 */
const TABLE: Record<string, { base: number; per_doc: number; per_page: number; cap: number }> = {
  "s1.contract_review": { base: 30, per_doc: 10, per_page: 0.5, cap: 200 },
  "a1.agent_task": { base: 20, per_doc: 5, per_page: 0, cap: 60 }, // A1 默认单任务上限 60 点
};

/** 不调用 AI 的本机流程（回稿比对、整理案卷、对外脱敏件）：10-23 拍板不计点（原 S1b 10、S2 40、S6 5 点起）。 */
const LOCAL = new Set(["s1b.draft_compare", "s2.case_file", "s6.redaction"]);

export function estimatePoints(input: EstimateInput): Estimate {
  if (LOCAL.has(input.scenario)) {
    return { scenario: input.scenario, points: 0, breakdown: [], valid_seconds: 900, assumptions: [], local: true };
  }
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
    // 律师看得懂的两句（v9.4：原来的“v0 费率表，试点实测后校准”“页数为解析页数”是研发口径，不再显示）
    assumptions: [`这类任务最多 ${t.cap} 点`, "因软件或服务出错没做完的不扣点；你中途取消的，只扣已经做完的部分"],
  };
}

/** 单任务点数上限；本机流程为 0（不计点）。 */
export function scenarioCap(scenario: string): number {
  return TABLE[scenario]?.cap ?? 0;
}
