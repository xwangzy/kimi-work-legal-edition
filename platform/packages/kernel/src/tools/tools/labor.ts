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
  /** 解除或终止前十二个月平均工资；与 monthly_wages_yuan 给一个。 */
  avg_monthly_wage_yuan?: number;
  /** 解除或终止前各月的应得工资（最多十二个月，工作不满十二个月的按实际月数）：给了就由工具求平均（第 57 批）。 */
  monthly_wages_yuan?: number[];
  /** 工资台账逐月各项目 + 本口径计入哪些项目：由工具按口径求和、求平均（工资构成有争议时用它，各口径只改 include）。 */
  wage_table?: WageTable;
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
// 第 57 批全量验收：按十进制四舍五入到分。原先 Math.round(n * 100 + Number.EPSILON) 在 x.xx5 上约 4.6% 舍错（1.005→1.00、2.675→2.67），
// 先按 15 位有效数字取整消掉浮点尾差再四舍五入
const round2 = (n: number) => (Math.sign(n) * Math.round(Number((Math.abs(n) * 100).toPrecision(15)))) / 100;

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

/**
 * 月工资：直接给平均数，或给各月应得工资由这里求平均（第 57 批：第 56 批真实运行里十二个月合计与月均由模型在命令行手算，
 * 把旷工扣款加回了两次，月均 35,162.36 / 35,438.22 / 35,771.55 三个数都不对，再传进本工具）。
 */
export interface WageTable {
  /** 工资台账逐月原样抄录：每月各项目的金额（扣款写负数）。最多十二个月。 */
  months: { month: string; items: Record<string, number> }[];
  /** 本口径计入月工资的项目名（与台账项目名逐字一致）。不计入的不写——不要自己把数加回或剔除后改台账。 */
  include: string[];
}

/**
 * 按工资台账与“计入哪些项目”求月平均工资（第 57 批第二波真实复验，劳动者应对一单）：
 * 给了 monthly_wages_yuan 之后，各口径的逐月数字仍由模型手工调整——“剔除加班费并加回扣款”那一组把 8 月写成 27,310.34（应为 24,000），
 * 扣款被加回了两次，2N 多算 3,310.32 元，命中金额否决。同一份台账只抄一次，各口径只改 include，就不存在“调整后的数”。
 */
export function wageFromTable(t: WageTable): { wage: number; total: number; steps: string[] } {
  if (!t || !Array.isArray(t.months) || t.months.length === 0 || t.months.length > 12) throw new DomainError("validation", "wage_table.months 须为 1～12 个月的工资台账", 422);
  if (!Array.isArray(t.include) || t.include.length === 0) throw new DomainError("validation", "wage_table.include 须写明本口径计入月工资的项目名", 422);
  const known = new Set<string>();
  const seenMonth = new Set<string>();
  for (const [i, m] of t.months.entries()) {
    if (!m || typeof m.month !== "string" || !m.month.trim()) throw new DomainError("validation", `wage_table.months 第 ${i + 1} 项需要 month（如 2026-08）`, 422);
    if (seenMonth.has(m.month)) throw new DomainError("validation", `wage_table.months 里 ${m.month} 出现了两次`, 422);
    seenMonth.add(m.month);
    if (!m.items || typeof m.items !== "object" || Array.isArray(m.items)) throw new DomainError("validation", `wage_table.months 第 ${i + 1} 项需要 items（项目名 → 金额）`, 422);
    for (const [k, v] of Object.entries(m.items)) {
      if (typeof v !== "number" || !Number.isFinite(v)) throw new DomainError("validation", `wage_table：${m.month} 的“${k}”须为数字（元；扣款写负数）`, 422);
      known.add(k);
    }
  }
  const unknown = t.include.filter((k) => !known.has(k));
  if (unknown.length > 0) throw new DomainError("validation", `wage_table.include 里的${unknown.map((k) => `“${k}”`).join("、")}不在台账项目里；台账项目有：${[...known].join("、")}`, 422);
  const include = new Set(t.include);
  const cents = t.months.map((m) => Object.entries(m.items).reduce((n, [k, v]) => n + (include.has(k) ? Math.round(v * 100) : 0), 0));
  const sum = cents.reduce((a, b) => a + b, 0);
  if (sum < 0) throw new DomainError("validation", "wage_table：按 include 相加的工资合计为负数，请核对台账", 422);
  const total = round2(sum / 100);
  const wage = round2(sum / 100 / t.months.length);
  const excluded = [...known].filter((k) => !include.has(k));
  return {
    wage,
    total,
    steps: [
      `工资口径：计入 ${t.include.join("、")}${excluded.length > 0 ? `；不计入 ${excluded.join("、")}` : ""}`,
      `月平均工资 = ${t.months.length} 个月（${t.months[0]!.month} 至 ${t.months.at(-1)!.month}）按上述口径的合计 ${total} 元 ÷ ${t.months.length} = ${wage} 元`,
    ],
  };
}

export function wageOf(p: { avg_monthly_wage_yuan?: number; monthly_wages_yuan?: number[]; wage_table?: WageTable }): { wage: number; steps: string[] } {
  if (p.wage_table !== undefined) {
    if (p.avg_monthly_wage_yuan !== undefined || p.monthly_wages_yuan !== undefined) throw new DomainError("validation", "wage_table、monthly_wages_yuan、avg_monthly_wage_yuan 只给一个", 422);
    return wageFromTable(p.wage_table);
  }
  if (p.monthly_wages_yuan !== undefined) {
    if (p.avg_monthly_wage_yuan !== undefined) throw new DomainError("validation", "avg_monthly_wage_yuan 与 monthly_wages_yuan 只给一个：给了各月工资就由工具求平均", 422);
    const list = p.monthly_wages_yuan;
    if (!Array.isArray(list) || list.length === 0 || list.length > 12) throw new DomainError("validation", "monthly_wages_yuan 须为 1～12 个月的应得工资（元）", 422);
    const cents = list.map((v, i) => Math.round(money(v, `monthly_wages_yuan 第 ${i + 1} 个月`, true)! * 100));
    const sum = cents.reduce((a, b) => a + b, 0);
    const wage = round2(sum / 100 / list.length);
    return { wage, steps: [`月平均工资 = ${list.length} 个月应得工资合计 ${round2(sum / 100)} 元 ÷ ${list.length} = ${wage} 元`] };
  }
  return { wage: money(p.avg_monthly_wage_yuan, "avg_monthly_wage_yuan（或 monthly_wages_yuan）", true)!, steps: [] };
}

export interface CalcAnnualLeaveParams {
  kind: "annual_leave";
  avg_monthly_wage_yuan?: number;
  monthly_wages_yuan?: number[];
  wage_table?: WageTable;
  unused_days: number;
  /** 2：只算差额（正常工资已发，另付 200%，缺省）；3：按 300% 全额。 */
  leave_multiple?: 2 | 3;
}

export interface CalcAnnualLeaveResult {
  daily_wage_yuan: number;
  unused_days: number;
  multiple: number;
  compensation_yuan: number;
  total_yuan: number;
  steps: string[];
  basis: string[];
  warnings: string[];
}

/** 未休年休假工资报酬：日工资 = 月工资 ÷ 21.75（先取到分），再 × 未休天数 × 倍数——写出来的算式逐分可复算。 */
export function calcAnnualLeave(p: CalcAnnualLeaveParams): CalcAnnualLeaveResult {
  const w = wageOf(p);
  const days = p.unused_days;
  if (typeof days !== "number" || !Number.isFinite(days) || days <= 0 || days > 60 || Math.abs(days * 2 - Math.round(days * 2)) > 1e-9) throw new DomainError("validation", "unused_days（应休未休天数）须在 0～60 之间，可带半天", 422);
  const multiple = p.leave_multiple ?? 2;
  if (multiple !== 2 && multiple !== 3) throw new DomainError("validation", "leave_multiple 须为 2（差额 200%，正常工资已发）或 3（300% 全额）", 422);
  const daily = round2(w.wage / 21.75);
  const pay = round2(daily * days * multiple);
  return {
    daily_wage_yuan: daily,
    unused_days: days,
    multiple,
    compensation_yuan: pay,
    total_yuan: pay,
    steps: [...w.steps, `日工资 = 月工资 ${w.wage} 元 ÷ 21.75 = ${daily} 元`, `未休年休假工资报酬 = ${daily} × ${days} 天 × ${multiple}00% = ${pay} 元${multiple === 2 ? "（正常工作期间的工资已发，另付 200%）" : "（按 300% 全额，含正常工作期间的工资）"}`],
    basis: ["《职工带薪年休假条例》第五条", "《企业职工带薪年休假实施办法》第十条、第十一条"],
    warnings: ["月工资应是前十二个月剔除加班工资后的月平均工资：给的数含加班费的请剔除后重算", "应休未休天数的折算、跨年度安排与仲裁时效各地口径不一，请律师核对"],
  };
}

export function calcLabor(p: CalcLaborParams): CalcLaborResult {
  if (!valid(p.start_date ?? "") || !valid(p.end_date ?? "")) throw new DomainError("validation", "start_date、end_date 须为 YYYY-MM-DD", 422);
  if (p.end_date <= p.start_date) throw new DomainError("validation", "解除或终止日须晚于入职日", 422);
  if (p.kind !== "compensation" && p.kind !== "unlawful") throw new DomainError("validation", "kind 须为 compensation（经济补偿）或 unlawful（违法解除赔偿金）", 422);
  const w = wageOf(p);
  const wage = w.wage;
  const localAvg = money(p.local_avg_monthly_wage_yuan, "local_avg_monthly_wage_yuan");
  const minWage = money(p.local_min_wage_yuan, "local_min_wage_yuan");
  const lastMonth = money(p.last_month_wage_yuan, "last_month_wage_yuan");
  const steps: string[] = [...w.steps];
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
  if (sp.years >= 1 && p.kind === "compensation") warnings.push("是否应付经济补偿取决于解除或终止的情形（第四十六条），此处只算数额");
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
