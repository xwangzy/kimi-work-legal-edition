/**
 * calc.interest — 确定性利息计算器（方案第 3 篇 S3：本金、利息、LPR 分段用确定性计算器，
 * 保存每段本金、起止日、日数规则、利率单位、年日数、抵扣顺序、舍入与争议假设）。
 *
 * LPR 种子：历史公开报价（1 年期），演示种子，生产接入授权数据源后校准。
 */
import { DomainError } from "@zr-legal/domain";

export interface RateSpecFixed {
  kind: "fixed";
  annual_pct: number;
}
export interface RateSpecLprPlus {
  kind: "lpr_plus";
  lpr_term: "1Y";
  plus_bp: number; // 基点
}
/** LPR 的倍数（v9.4 第 20 批）：如逾期付款违约金按 LPR 上浮 30%～50%（multiple 1.3～1.5）、民间借贷保护上限四倍 LPR。 */
export interface RateSpecLprTimes {
  kind: "lpr_times";
  lpr_term: "1Y";
  multiple: number;
}
export type RateSpec = RateSpecFixed | RateSpecLprPlus | RateSpecLprTimes;

export interface CalcInterestParams {
  principal_yuan: number;
  start_date: string; // YYYY-MM-DD（含当日，算头不算尾）
  end_date: string; // YYYY-MM-DD（不含当日）
  rate: RateSpec;
  year_days?: 360 | 365; // 默认 365
}

/**
 * 1 年期 LPR 历史报价（公开数据）。v9.4 第 20 批核实：2025-05-20 下调至 3.0% 后至 2026-10-20 连续 17 个月未变
 * （中国人民银行授权全国银行间同业拆借中心公布；澎湃新闻、新浪财经 2026-10-20 报道，核实日 2026-10-22）。
 * LPR_CHECKED_THROUGH 之后的报价未收录：计算区间越过它时按最后一次报价计并给警告。
 */
export const LPR_CHECKED_THROUGH = "2026-10-20";
export const LPR_1Y: readonly { effective: string; pct: number }[] = [
  { effective: "2019-08-20", pct: 4.25 },
  { effective: "2019-09-20", pct: 4.2 },
  { effective: "2019-11-20", pct: 4.15 },
  { effective: "2020-02-20", pct: 4.05 },
  { effective: "2020-04-20", pct: 3.85 },
  { effective: "2021-12-20", pct: 3.8 },
  { effective: "2022-01-20", pct: 3.7 },
  { effective: "2022-08-22", pct: 3.65 },
  { effective: "2023-06-20", pct: 3.55 },
  { effective: "2023-08-21", pct: 3.45 },
  { effective: "2024-07-22", pct: 3.35 },
  { effective: "2024-10-21", pct: 3.1 },
  { effective: "2025-05-20", pct: 3.0 },
];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_DAY = 86_400_000;

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / MS_DAY);
}

function round2(n: number): number {
  // 四舍五入到分（half-up，按绝对值）
  return Math.sign(n) * Math.round(Math.abs(n) * 100 + Number.EPSILON) / 100;
}

function rateAt(spec: RateSpec, date: string): { annual_pct: number; lpr_effective: string | null } {
  if (spec.kind === "fixed") return { annual_pct: spec.annual_pct, lpr_effective: null };
  let chosen: { effective: string; pct: number } | null = null;
  for (const row of LPR_1Y) {
    if (row.effective <= date && (!chosen || row.effective > chosen.effective)) chosen = row;
  }
  if (!chosen) throw new DomainError("validation", `calc.interest: ${date} 之前无 LPR 报价种子`, 422);
  // 倍数按 LPR × 倍数，保留四位小数（3.0% × 1.5 = 4.5%）
  const pct = spec.kind === "lpr_times" ? Math.round(chosen.pct * spec.multiple * 10_000) / 10_000 : chosen.pct + spec.plus_bp / 100;
  return { annual_pct: pct, lpr_effective: chosen.effective };
}

export interface InterestSegment {
  from: string;
  to: string;
  days: number;
  annual_pct: number;
  lpr_effective: string | null;
  interest_yuan: number;
}

export interface CalcInterestResult {
  principal_yuan: number;
  segments: InterestSegment[];
  total_interest_yuan: number;
  total_yuan: number;
  assumptions: string[];
  /** 非空时须原样告知律师（如计算区间越过已收录的 LPR 报价）。 */
  warnings: string[];
}

export function calcInterest(params: CalcInterestParams): CalcInterestResult {
  const { principal_yuan: principal, start_date: start, end_date: end, rate } = params;
  const yearDays = params.year_days ?? 365;
  if (!Number.isFinite(principal) || principal < 0) throw new DomainError("validation", "principal_yuan 须为非负数字", 422);
  if (!DAY_RE.test(start ?? "") || !DAY_RE.test(end ?? "")) throw new DomainError("validation", "日期格式 YYYY-MM-DD", 422);
  if (daysBetween(start, end) <= 0) throw new DomainError("validation", "end_date 必须晚于 start_date（算头不算尾）", 422);
  if (yearDays !== 360 && yearDays !== 365) throw new DomainError("validation", "year_days 仅支持 360/365", 422);
  if (rate.kind === "lpr_times" && !(Number.isFinite(rate.multiple) && rate.multiple > 0 && rate.multiple <= 4)) throw new DomainError("validation", "multiple 须在 0～4 之间（四倍 LPR 是民间借贷的司法保护上限）", 422);

  // 分段点：起止日 + 区间内每次 LPR 报价生效日
  const cuts = new Set<string>([start, end]);
  if (rate.kind !== "fixed") {
    for (const row of LPR_1Y) {
      if (row.effective > start && row.effective < end) cuts.add(row.effective);
    }
  }
  const sorted = [...cuts].sort();
  const segments: InterestSegment[] = [];
  let total = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    const from = sorted[i]!;
    const to = sorted[i + 1]!;
    const days = daysBetween(from, to);
    const r = rateAt(rate, from);
    const interest = round2((principal * (r.annual_pct / 100) * days) / yearDays);
    segments.push({ from, to, days, annual_pct: r.annual_pct, lpr_effective: r.lpr_effective, interest_yuan: interest });
    total += interest;
  }
  const totalRounded = round2(total);
  const warnings: string[] = [];
  if (rate.kind !== "fixed" && end > LPR_CHECKED_THROUGH) warnings.push(`${LPR_CHECKED_THROUGH} 之后的 LPR 报价没有收录，这段按最后一次报价计：请到全国银行间同业拆借中心核对后再定稿`);
  return {
    warnings,
    principal_yuan: principal,
    segments,
    total_interest_yuan: totalRounded,
    total_yuan: round2(principal + totalRounded),
    assumptions: [
      "日数口径：算头不算尾（含起算日、不含截止日）",
      `年日数：${yearDays}`,
      "舍入：每段四舍五入至分（0.01 元），合计为分段之和",
      rate.kind === "lpr_plus"
        ? `利率：1 年期 LPR + ${rate.plus_bp}bp，分段按报价生效日切换`
        : rate.kind === "lpr_times"
          ? `利率：1 年期 LPR × ${rate.multiple}，分段按报价生效日切换`
          : `利率：固定年利率 ${rate.annual_pct}%`,
      `LPR 为公开历史报价，核至 ${LPR_CHECKED_THROUGH}`,
      "未含抵扣、复利、罚息上浮与司法保护上限校验（另行规则）",
    ],
  };
}
