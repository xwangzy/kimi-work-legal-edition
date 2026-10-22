/**
 * calc.labor — 劳动合同解除或终止的经济补偿与违法解除赔偿金（v9.4 第 20 批；V9.4 主文 §3.2“劳动补偿计算工具”）。
 * 确定性计算，逐步写出过程与所用条文，模型只给事实（入职日、解除日、工资），不自行推算：
 * - 经济补偿 N（劳动合同法第四十七条）：每满一年支付一个月工资；六个月以上不满一年的按一年；不满六个月的支付半个月工资。
 *   2008-01-01 前的工作年限按当时有关规定另算（第九十七条第三款），本工具只算 2008 年以后的部分并给警告；
 * - 违法解除赔偿金 2N（第八十七条）：按经济补偿标准的二倍；计算年限自用工之日起算（劳动合同法实施条例第二十五条）；
 * - 月工资是解除或终止前十二个月的平均工资（第四十七条第三款）；低于当地最低工资的按最低工资（实施条例第二十七条）；
 * - 三倍封顶：月工资高于当地上年度职工月平均工资三倍的，按三倍计、年限最高十二年（第四十七条第二款）——
 *   没给当地平均工资时不核封顶并警告（各地口径不同，不凭记忆填）；
 * - 代通知金（第四十条，额外一个月工资）按上一个月的工资（实施条例第二十条）。
 * “六个月以上”含六个月（民法典第一千二百五十九条：“以上”包括本数）。
 * end_date 是劳动关系的最后一日、含当日（复核 Q3-03：入职 2026-01-01、2026-06-30 解除是满六个月）——按 end_date 次日算整月。
 */
import { DomainError } from "@zr-legal/domain";

export interface CalcLaborParams {
  start_date: string;
  end_date: string;
  kind: "compensation" | "unlawful";
  avg_monthly_wage_yuan: number;
  local_avg_monthly_wage_yuan?: number;
  local_min_wage_yuan?: number;
  notice_in_lieu?: boolean;
  last_month_wage_yuan?: number;
}

export interface CalcLaborResult {
  service: { from: string; to: string; years: number; months: number; days: number };
  months_of_wage: number;
  base_yuan: number;
  capped: boolean;
  compensation_yuan: number;
  notice_pay_yuan: number;
  total_yuan: number;
  steps: string[];
  basis: string[];
  warnings: string[];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const LCL_START = "2008-01-01";

const valid = (d: string) => DAY.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const round2 = (n: number) => Math.round(n * 100 + Number.EPSILON) / 100;

/** 日期加 n 个月：到期月没有对应日取月末（与期间计算同一口径）。 */
function addMonths(d: string, n: number): string {
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

function nextDay(d: string): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** 从 from 到 to（不含 to 当日）的整年、整月与余下天数。 */
export function servicePeriod(from: string, to: string): { years: number; months: number; days: number } {
  let months = 0;
  while (addMonths(from, months + 1) <= to) months += 1;
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${addMonths(from, months)}T00:00:00Z`)) / 86_400_000);
  return { years: Math.floor(months / 12), months: months % 12, days };
}

/** 第四十七条第一款：满一年一个月；六个月以上（含）不满一年按一年；不满六个月半个月。 */
export function monthsOfWage(p: { years: number; months: number; days: number }): number {
  const rest = p.months >= 6 ? 1 : p.months > 0 || p.days > 0 ? 0.5 : 0;
  return p.years + rest;
}

const money = (v: unknown, name: string, required = false): number | undefined => {
  if (v === undefined || v === null) {
    if (required) throw new DomainError("validation", `需要 ${name}`, 422);
    return undefined;
  }
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new DomainError("validation", `${name} 须为非负数字（元）`, 422);
  return v;
};

export function calcLabor(p: CalcLaborParams): CalcLaborResult {
  if (!valid(p.start_date ?? "") || !valid(p.end_date ?? "")) throw new DomainError("validation", "start_date、end_date 须为 YYYY-MM-DD", 422);
  if (p.end_date <= p.start_date) throw new DomainError("validation", "解除或终止日须晚于入职日", 422);
  if (p.kind !== "compensation" && p.kind !== "unlawful") throw new DomainError("validation", "kind 须为 compensation（经济补偿）或 unlawful（违法解除赔偿金）", 422);
  const wage = money(p.avg_monthly_wage_yuan, "avg_monthly_wage_yuan", true)!;
  const localAvg = money(p.local_avg_monthly_wage_yuan, "local_avg_monthly_wage_yuan");
  const minWage = money(p.local_min_wage_yuan, "local_min_wage_yuan");
  const lastMonth = money(p.last_month_wage_yuan, "last_month_wage_yuan");
  const steps: string[] = [];
  const warnings: string[] = [];
  const basis = ["《中华人民共和国劳动合同法》第四十七条"];

  // 1. 计算年限的起点
  let from = p.start_date;
  if (p.kind === "unlawful") {
    basis.push("《中华人民共和国劳动合同法》第八十七条", "《中华人民共和国劳动合同法实施条例》第二十五条");
    steps.push(`违法解除赔偿金的计算年限自用工之日（${p.start_date}）起算`);
  } else if (p.start_date < LCL_START) {
    from = LCL_START;
    basis.push("《中华人民共和国劳动合同法》第九十七条第三款");
    const pre = servicePeriod(p.start_date, LCL_START);
    steps.push(`经济补偿年限自 2008-01-01 起算；${p.start_date} 至 2007-12-31 的部分（${pre.years} 年 ${pre.months} 个月 ${pre.days} 天）按当时有关规定另算，本结果不含`);
    warnings.push("入职早于 2008-01-01：2008 年以前的工作年限是否、如何支付经济补偿按当时有关规定另算，本结果只含 2008 年以后的部分，须律师按当时规定与地方口径核算");
  }
  // end_date 含当日：按次日算整月（servicePeriod 的终点不含当日）
  const sp = servicePeriod(from, nextDay(p.end_date));
  let n = monthsOfWage(sp);
  steps.push(`工作年限 ${from} 至 ${p.end_date}（含当日）：${sp.years} 年 ${sp.months} 个月 ${sp.days} 天 → ${sp.years} 个月${n > sp.years ? ` + ${n - sp.years === 1 ? "1 个月（六个月以上不满一年按一年）" : "0.5 个月（不满六个月）"}` : ""} = ${n} 个月工资`);

  // 2. 月工资基数
  let base = wage;
  if (minWage !== undefined && wage < minWage) {
    base = minWage;
    basis.push("《中华人民共和国劳动合同法实施条例》第二十七条");
    steps.push(`前十二个月平均工资 ${wage} 元低于当地最低工资 ${minWage} 元，按最低工资计`);
  } else steps.push(`月工资按解除或终止前十二个月平均工资 ${wage} 元计`);
  let capped = false;
  if (localAvg === undefined) {
    warnings.push("没有提供当地上年度职工月平均工资：没有核对三倍封顶（月工资高于三倍的，基数按三倍、年限最高十二年），请律师按当地公布的数据核对");
  } else if (base > localAvg * 3) {
    capped = true;
    const was = n;
    base = round2(localAvg * 3);
    n = Math.min(n, 12);
    steps.push(`月工资高于当地上年度职工月平均工资 ${localAvg} 元的三倍：基数按 ${base} 元计${was > 12 ? `，年限按最高十二年（${was} → 12 个月）` : ""}`);
  } else steps.push(`月工资未超过当地上年度职工月平均工资 ${localAvg} 元的三倍，不封顶`);

  const comp = round2(n * base * (p.kind === "unlawful" ? 2 : 1));
  steps.push(p.kind === "unlawful" ? `赔偿金 = ${n} × ${base} × 2 = ${comp} 元（已含经济补偿，不再另付经济补偿）` : `经济补偿 = ${n} × ${base} = ${comp} 元`);

  // 3. 代通知金
  let notice = 0;
  if (p.notice_in_lieu) {
    basis.push("《中华人民共和国劳动合同法》第四十条", "《中华人民共和国劳动合同法实施条例》第二十条");
    if (lastMonth === undefined) warnings.push("代通知金应按上一个月的工资标准：没有提供，暂按前十二个月平均工资计，请律师核对");
    notice = round2(lastMonth ?? wage);
    steps.push(`代通知金（额外一个月工资）按上一个月工资 ${notice} 元${lastMonth === undefined ? "（暂按平均工资）" : ""}`);
    if (p.kind === "unlawful") warnings.push("违法解除时是否另付代通知金各地口径不一，请律师核对");
  }
  if (sp.years >= 1 && p.kind === "compensation") warnings.push("是否应付经济补偿取决于解除或终止的情形（第四十六条），本工具只算数额");
  return {
    service: { from, to: p.end_date, ...sp },
    months_of_wage: n,
    base_yuan: base,
    capped,
    compensation_yuan: comp,
    notice_pay_yuan: notice,
    total_yuan: round2(comp + notice),
    steps,
    basis,
    warnings,
  };
}
