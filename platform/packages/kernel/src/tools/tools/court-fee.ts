/**
 * calc.court_fee — 诉讼费用（v9.4 第 21 批；V9.4 主文 §6.4“金额可复算：诉讼费缺”）。
 * 确定性计算，按国务院《诉讼费用交纳办法》（2007-04-01 施行；原文对照最高人民法院网站转载本）逐段写出过程：
 * - 财产案件受理费（第十三条第（一）项）：分段累计，1 万元以下每件 50 元，其上 2.5% / 2% / 1.5% / 1% / 0.9% / 0.8% / 0.7% / 0.6% / 0.5%；
 * - 申请执行费（第十四条第（一）项）：1 万元以下每件 50 元，其上 1.5% / 1% / 0.5% / 0.1%；
 * - 保全申请费（第十四条第（二）项）：1000 元以下每件 30 元，其上 1% / 0.5%，最多 5000 元；
 * - 支付令申请费（第十四条第（三）项）：财产案件受理费标准的 1/3；
 * - 劳动争议案件（第十三条第（四）项）：每件 10 元；
 * - 减半（第十五、十六、十八条）：调解结案或撤诉、简易程序、反诉或有独立请求权第三人的请求合并审理；
 *   几种减半能否叠加各地做法不一，本工具只减半一次并警告。
 * 上诉按不服一审判决部分的上诉请求数额计（第十七条）——调用方传上诉请求数额即可。非财产案件、知识产权无争议金额等
 * “每件 X 元至 Y 元”的幅度由省级政府定具体标准（第十三条末款），本工具不算，只说明幅度。结果是预估，以法院通知为准。
 */
import { DomainError } from "@zr-legal/domain";

export type CourtFeeKind = "case_property" | "enforcement" | "preservation" | "payment_order" | "labor";
export type CourtFeeReduction = "mediation_or_withdrawal" | "simple_procedure" | "counterclaim";

export interface CalcCourtFeeParams {
  kind: CourtFeeKind;
  amount_yuan?: number;
  reductions?: CourtFeeReduction[];
}

export interface CalcCourtFeeResult {
  kind: CourtFeeKind;
  amount_yuan: number | null;
  segments: { from_yuan: number; to_yuan: number | null; rule: string; fee_yuan: number }[];
  full_fee_yuan: number;
  fee_yuan: number;
  steps: string[];
  basis: string[];
  warnings: string[];
}

const BASIS_ROOT = "《诉讼费用交纳办法》";
const WAN = 10_000;

/** 分段累计表：[上限（元，null 为无上限）, 比例]；第一段为定额。 */
const CASE_PROPERTY: readonly [number | null, number][] = [
  [WAN, 0],
  [10 * WAN, 0.025],
  [20 * WAN, 0.02],
  [50 * WAN, 0.015],
  [100 * WAN, 0.01],
  [200 * WAN, 0.009],
  [500 * WAN, 0.008],
  [1000 * WAN, 0.007],
  [2000 * WAN, 0.006],
  [null, 0.005],
];
const ENFORCEMENT: readonly [number | null, number][] = [
  [WAN, 0],
  [50 * WAN, 0.015],
  [500 * WAN, 0.01],
  [1000 * WAN, 0.005],
  [null, 0.001],
];
const PRESERVATION: readonly [number | null, number][] = [
  [1000, 0],
  [10 * WAN, 0.01],
  [null, 0.005],
];

const round2 = (n: number) => Math.round(n * 100 + Number.EPSILON) / 100;
const pct = (r: number) => `${Math.round(r * 10000) / 100}%`;
const yuan = (n: number) => (n >= WAN && n % WAN === 0 ? `${n / WAN} 万元` : `${n} 元`);

function tiered(amount: number, table: readonly [number | null, number][], flat: number): CalcCourtFeeResult["segments"] {
  const out: CalcCourtFeeResult["segments"] = [];
  let lower = 0;
  for (const [upper, rate] of table) {
    if (rate === 0) {
      out.push({ from_yuan: 0, to_yuan: upper, rule: `不超过 ${yuan(upper!)} 的，每件 ${flat} 元`, fee_yuan: flat });
    } else if (amount > lower) {
      const top = upper === null ? amount : Math.min(amount, upper);
      out.push({
        from_yuan: lower,
        to_yuan: upper,
        rule: `超过 ${yuan(lower)}${upper === null ? "" : `至 ${yuan(upper)}`}的部分（${round2(top - lower)} 元）× ${pct(rate)}`,
        fee_yuan: round2((top - lower) * rate),
      });
    }
    if (upper === null || amount <= upper) break;
    lower = upper;
  }
  return out;
}

export function calcCourtFee(p: CalcCourtFeeParams): CalcCourtFeeResult {
  const kinds: CourtFeeKind[] = ["case_property", "enforcement", "preservation", "payment_order", "labor"];
  if (!kinds.includes(p.kind)) throw new DomainError("validation", `kind 须为 ${kinds.join(" / ")}`, 422);
  const reductions = [...new Set(p.reductions ?? [])];
  const allowedRed: CourtFeeReduction[] = ["mediation_or_withdrawal", "simple_procedure", "counterclaim"];
  for (const r of reductions) if (!allowedRed.includes(r)) throw new DomainError("validation", `reductions 只能是 ${allowedRed.join(" / ")}`, 422);
  const needsAmount = p.kind !== "labor";
  const amount = p.amount_yuan;
  if (needsAmount && (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0)) {
    throw new DomainError("validation", "amount_yuan 须为非负数字（元）：受理费写诉讼请求金额（上诉写不服一审判决部分的上诉请求数额），执行写执行金额，保全写实际保全的财产数额", 422);
  }
  const steps: string[] = [];
  const warnings: string[] = [];
  const basis: string[] = [];
  let segments: CalcCourtFeeResult["segments"] = [];
  let full = 0;

  switch (p.kind) {
    case "case_property":
      basis.push(`${BASIS_ROOT}第十三条第（一）项`);
      segments = tiered(amount!, CASE_PROPERTY, 50);
      full = round2(segments.reduce((s, x) => s + x.fee_yuan, 0));
      steps.push(`财产案件受理费按诉讼请求金额 ${amount} 元分段累计：`, ...segments.map((s) => `  ${s.rule} = ${s.fee_yuan} 元`), `合计 ${full} 元`);
      break;
    case "payment_order": {
      basis.push(`${BASIS_ROOT}第十四条第（三）项`, `${BASIS_ROOT}第十三条第（一）项`);
      segments = tiered(amount!, CASE_PROPERTY, 50);
      const base = round2(segments.reduce((s, x) => s + x.fee_yuan, 0));
      full = round2(base / 3);
      steps.push(`支付令申请费比照财产案件受理费标准的 1/3：按 ${amount} 元算受理费 ${base} 元`, ...segments.map((s) => `  ${s.rule} = ${s.fee_yuan} 元`), `${base} ÷ 3 = ${full} 元`);
      break;
    }
    case "enforcement":
      basis.push(`${BASIS_ROOT}第十四条第（一）项`);
      if (amount === 0) {
        warnings.push("没有执行金额或者价额的，每件交纳 50 元至 500 元（具体以法院为准），本工具不算幅度内的数额");
        steps.push("没有执行金额：每件 50 元至 500 元，以法院确定为准");
        break;
      }
      segments = tiered(amount!, ENFORCEMENT, 50);
      full = round2(segments.reduce((s, x) => s + x.fee_yuan, 0));
      steps.push(`申请执行费按执行金额 ${amount} 元分段累计：`, ...segments.map((s) => `  ${s.rule} = ${s.fee_yuan} 元`), `合计 ${full} 元`);
      break;
    case "preservation": {
      basis.push(`${BASIS_ROOT}第十四条第（二）项`);
      segments = tiered(amount!, PRESERVATION, 30);
      const raw = round2(segments.reduce((s, x) => s + x.fee_yuan, 0));
      full = Math.min(raw, 5000);
      steps.push(`保全申请费按实际保全的财产数额 ${amount} 元分段累计：`, ...segments.map((s) => `  ${s.rule} = ${s.fee_yuan} 元`), raw > 5000 ? `合计 ${raw} 元，超过最多 5000 元的限额，按 5000 元` : `合计 ${full} 元`);
      warnings.push("保全申请费按实际保全的财产数额计：申请金额与实际保全到的数额不同时，以法院实际保全的为准");
      break;
    }
    case "labor":
      basis.push(`${BASIS_ROOT}第十三条第（四）项`);
      full = 10;
      steps.push("劳动争议案件每件交纳 10 元");
      break;
  }

  let fee = full;
  if (reductions.length > 0) {
    const caseFee = p.kind === "case_property" || p.kind === "labor";
    if (!caseFee) {
      warnings.push("减半交纳只适用于案件受理费（第十五、十六、十八条），申请费不减半，已忽略 reductions");
    } else {
      const label: Record<CourtFeeReduction, string> = {
        mediation_or_withdrawal: "以调解方式结案或者申请撤诉（第十五条）",
        simple_procedure: "适用简易程序（第十六条）",
        counterclaim: "反诉或有独立请求权的第三人请求合并审理（第十八条）",
      };
      for (const r of reductions) basis.push(`${BASIS_ROOT}${label[r].match(/第.+条/)![0]}`);
      fee = round2(full / 2);
      steps.push(`减半交纳：${reductions.map((r) => label[r]).join("；")} → ${full} ÷ 2 = ${fee} 元`);
      if (reductions.length > 1) warnings.push("同时符合几种减半情形时能否再次减半，各地法院做法不一；本工具只减半一次，请律师按受理法院的做法核对");
    }
  }
  if (p.kind === "case_property") warnings.push("上诉的，按不服一审判决部分的上诉请求数额交纳（第十七条）：请把上诉请求数额作为 amount_yuan 另算一次");
  warnings.push("结果是按《诉讼费用交纳办法》的预估，以受理法院的交费通知为准；非财产案件、无争议金额的知识产权案件等按件幅度收费的，由各省规定具体标准，本工具不算");
  return { kind: p.kind, amount_yuan: needsAmount ? amount! : null, segments, full_fee_yuan: full, fee_yuan: fee, steps, basis, warnings };
}
