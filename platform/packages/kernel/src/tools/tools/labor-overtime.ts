/**
 * calc.labor kind=overtime — 加班费与加班费差额（第 58 批）：逐月按“小时工资 × 加班小时 × 倍数”算应付，减去已付得差额，小时数与金额都由工具合计。
 * 为什么（V32 真实复测）：劳动卡的加班费是模型手工汇总的，台账 144 小时被加成 152 小时；5 张劳动卡都要算加班费差额。
 *
 * 口径（写进 assumptions）：
 * - 小时工资 = 当月加班费计算基数 ÷ 计薪天数（缺省 21.75）÷ 每日工作小时（缺省 8），不先取整，各类加班费算出后四舍五入到分；
 * - 倍数（劳动法第四十四条，条文经法规库核对）：工作日延长工作时间不低于 150%，休息日安排工作又不能安排补休的不低于 200%，法定休假日不低于 300%；
 *   休息日已安排补休的不付——由调用方不填该月的休息日小时表示；
 * - 每类加班费 = 小时 × 小时工资 × 倍数，四舍五入到分；当月应付 = 各类之和；差额按月计 = 应付 − 已付，已付超过应付的该月差额按 0 计、多付部分不抵其他月份；
 * - 加班费计算基数的口径（是否含奖金、津贴，约定基数是否有效，是否低于最低工资）由调用方声明，工具不判断。
 * 本工具是只读计算；要成表的，把同一组参数交给 xlsx.render_table 的 computed，由内核按同一算法写成带公式的表。
 */
import { DomainError } from "@zr-legal/domain";
import type { SheetSpec } from "@zr-legal/docx-engine";
import { roundHalfUpCents as round2 } from "./court-fee.ts";

export interface OvertimeMonth {
  /** YYYY-MM */
  month: string;
  /** 工作日延长工作时间（小时） */
  workday_hours?: number;
  /** 休息日安排工作又不能安排补休的（小时）；安排了补休的不填 */
  restday_hours?: number;
  /** 法定休假日安排工作（小时） */
  holiday_hours?: number;
  /** 当月加班费计算基数（元，月工资口径由调用方声明） */
  base_yuan: number;
  /** 当月已付加班费（元）；不填的按未付计 */
  paid_yuan?: number;
  note?: string;
}

export interface CalcOvertimeParams {
  kind: "overtime";
  months: OvertimeMonth[];
  divisor_days?: number;
  hours_per_day?: number;
  multiples?: { workday?: number; restday?: number; holiday?: number };
  /** 加班费计算基数的口径说明（如“劳动合同约定月工资”“前十二个月平均应发工资”） */
  base_basis?: string;
}

type Cat = "workday" | "restday" | "holiday";
const CATS: { key: Cat; label: string; def: number; law: string }[] = [
  { key: "workday", label: "工作日延长工作时间", def: 1.5, law: "不低于工资的百分之一百五十" },
  { key: "restday", label: "休息日加班（不能安排补休）", def: 2, law: "不低于工资的百分之二百" },
  { key: "holiday", label: "法定休假日加班", def: 3, law: "不低于工资的百分之三百" },
];

export interface OvertimeMonthResult {
  month: string;
  base_yuan: number;
  hourly_yuan: number;
  workday_hours: number;
  workday_pay_yuan: number;
  restday_hours: number;
  restday_pay_yuan: number;
  holiday_hours: number;
  holiday_pay_yuan: number;
  due_yuan: number;
  paid_yuan: number;
  paid_entered: boolean;
  diff_yuan: number;
  overpaid_yuan: number;
  note: string;
}

export interface CalcOvertimeResult {
  kind: "overtime";
  divisor_days: number;
  hours_per_day: number;
  multiples: Record<Cat, number>;
  months: OvertimeMonthResult[];
  hours_total: { workday: number; restday: number; holiday: number; all: number };
  due_total_yuan: number;
  paid_total_yuan: number;
  diff_total_yuan: number;
  /** 与其他 kind 一致：本次主张的数（差额合计） */
  total_yuan: number;
  steps: string[];
  basis: string[];
  assumptions: string[];
  warnings: string[];
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** 小时数按百分之一小时的整数相加，避免浮点尾差（144 小时不会加成 143.99999）。 */
const sumHours = (xs: number[]) => xs.reduce((n, x) => n + Math.round(x * 100), 0) / 100;

function num(v: unknown, name: string, o: { min?: number; max?: number; positive?: boolean } = {}): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < (o.min ?? 0) || (o.positive && v <= 0) || (o.max !== undefined && v > o.max)) throw new DomainError("validation", `${name} 须为${o.positive ? "正" : "非负"}数字${o.max !== undefined ? `（不超过 ${o.max}）` : ""}`, 422);
  return v;
}

export function calcOvertime(p: CalcOvertimeParams): CalcOvertimeResult {
  if (!p || !Array.isArray(p.months) || p.months.length === 0 || p.months.length > 60) throw new DomainError("validation", "加班费需要 months（逐月 1～60 个月）", 422);
  const divisor = p.divisor_days === undefined ? 21.75 : num(p.divisor_days, "divisor_days", { positive: true, max: 31 });
  const hpd = p.hours_per_day === undefined ? 8 : num(p.hours_per_day, "hours_per_day", { positive: true, max: 24 });
  const multiples = {} as Record<Cat, number>;
  for (const c of CATS) multiples[c.key] = p.multiples?.[c.key] === undefined ? c.def : num(p.multiples[c.key], `multiples.${c.key}`, { positive: true, max: 10 });
  const seen = new Set<string>();
  const anyPaid = p.months.some((m) => m && m.paid_yuan !== undefined);
  const warnings: string[] = [];
  const steps: string[] = [];
  const months: OvertimeMonthResult[] = p.months.map((m, i) => {
    const where = `第 ${i + 1} 个月`;
    if (!m || typeof m.month !== "string" || !MONTH_RE.test(m.month)) throw new DomainError("validation", `${where} 的 month 格式 YYYY-MM`, 422);
    if (seen.has(m.month)) throw new DomainError("validation", `月份 ${m.month} 重复：同一个月的小时合在一行`, 422);
    seen.add(m.month);
    const base = num(m.base_yuan, `${m.month} 的 base_yuan（加班费计算基数）`, { positive: true });
    if (Math.abs(base * 100 - Math.round(base * 100)) > 1e-6) throw new DomainError("validation", `${m.month} 的 base_yuan 最多两位小数`, 422);
    const hours = {} as Record<Cat, number>;
    for (const c of CATS) {
      const h = m[`${c.key}_hours`];
      hours[c.key] = h === undefined ? 0 : num(h, `${m.month} 的 ${c.key}_hours`, { max: 400 });
      if (Math.abs(hours[c.key] * 100 - Math.round(hours[c.key] * 100)) > 1e-6) throw new DomainError("validation", `${m.month} 的 ${c.key}_hours 最多两位小数`, 422);
    }
    const paid = m.paid_yuan === undefined ? 0 : num(m.paid_yuan, `${m.month} 的 paid_yuan`);
    // 第 58 批（主会话）：小时工资不先舍到分，各类加班费按精确小时工资算完再舍到分——先舍会与对方、法院按公式直算的数差几分到几角
    //（真实复测：劳动仲裁申请书 52,368.11 对 52,367.82）；表里的小时工资格显示四位小数
    const hourly = base / divisor / hpd;
    const pay = {} as Record<Cat, number>;
    for (const c of CATS) pay[c.key] = round2(hours[c.key] * hourly * multiples[c.key]);
    const due = round2(pay.workday + pay.restday + pay.holiday);
    const rawDiff = round2(due - paid);
    const diff = rawDiff > 0 ? rawDiff : 0;
    const over = rawDiff < 0 ? round2(-rawDiff) : 0;
    const notes: string[] = [];
    if (over > 0) notes.push(`已付超过应付 ${fmt(over)} 元，本月差额按 0 计（不抵其他月份）`);
    if (anyPaid && m.paid_yuan === undefined) notes.push("本月已付未录入，按 0 计");
    if (typeof m.note === "string" && m.note.trim()) notes.push(m.note.trim().slice(0, 120));
    const parts = CATS.filter((c) => hours[c.key] > 0).map((c) => `${c.label} ${hours[c.key]} 小时 × ${hourly.toFixed(4)} × ${multiples[c.key] * 100}% = ${fmt(pay[c.key])} 元`);
    steps.push(`${m.month}：小时工资 = ${fmt(base)} ÷ ${divisor} ÷ ${hpd} = ${hourly.toFixed(4)} 元（不先取整）；${parts.join("；") || "无加班小时"}；应付 ${fmt(due)} 元，已付 ${fmt(paid)} 元，差额 ${fmt(diff)} 元`);
    return {
      month: m.month,
      base_yuan: base,
      hourly_yuan: hourly,
      workday_hours: hours.workday,
      workday_pay_yuan: pay.workday,
      restday_hours: hours.restday,
      restday_pay_yuan: pay.restday,
      holiday_hours: hours.holiday,
      holiday_pay_yuan: pay.holiday,
      due_yuan: due,
      paid_yuan: paid,
      paid_entered: m.paid_yuan !== undefined,
      diff_yuan: diff,
      overpaid_yuan: over,
      note: notes.join("；"),
    };
  });
  months.sort((a, b) => (a.month < b.month ? -1 : 1));
  const cents = (xs: number[]) => xs.reduce((n, x) => n + Math.round(x * 100), 0) / 100;
  const hoursTotal = { workday: sumHours(months.map((m) => m.workday_hours)), restday: sumHours(months.map((m) => m.restday_hours)), holiday: sumHours(months.map((m) => m.holiday_hours)), all: 0 };
  hoursTotal.all = sumHours([hoursTotal.workday, hoursTotal.restday, hoursTotal.holiday]);
  const due = cents(months.map((m) => m.due_yuan));
  const paid = cents(months.map((m) => m.paid_yuan));
  const diff = cents(months.map((m) => m.diff_yuan));
  if (months.some((m) => m.overpaid_yuan > 0)) warnings.push("有的月份已付超过应付：那几个月差额按 0 计，多付部分没有抵其他月份；能否跨月抵扣由律师判断");
  if (!anyPaid) warnings.push("没有录入已付加班费：差额等于应付全额；已经发过加班费的，录入各月已付后重算");
  warnings.push("加班费计算基数的口径（是否含奖金、津贴，约定基数是否有效，是否低于当地最低工资）各地不一，请律师核对");
  const nondefault = CATS.filter((c) => multiples[c.key] !== c.def);
  const assumptions = [
    `小时工资 = 当月加班费计算基数 ÷ 计薪天数 ${divisor} 天 ÷ 每日 ${hpd} 小时，不先取整，各类加班费算出后四舍五入到分${divisor === 21.75 ? "；计薪天数按 21.75 天（原劳动和社会保障部通知口径）" : ""}`,
    `倍数：${CATS.map((c) => `${c.label} ${multiples[c.key] * 100}%`).join("、")}（劳动法第四十四条：${CATS.map((c) => c.law).join("、")}）${nondefault.length > 0 ? "；与法定最低倍数不同的是调用时声明的口径" : ""}`,
    "休息日安排工作又已安排补休的，不支付加班费：已补休的小时没有计入",
    "每类加班费 = 小时 × 小时工资 × 倍数，四舍五入到分；当月应付为各类之和；差额按月计，已付超过应付的该月按 0 计",
    ...(typeof p.base_basis === "string" && p.base_basis.trim() ? [`加班费计算基数：${p.base_basis.trim().slice(0, 120)}`] : []),
  ];
  return {
    kind: "overtime",
    divisor_days: divisor,
    hours_per_day: hpd,
    multiples,
    months,
    hours_total: hoursTotal,
    due_total_yuan: due,
    paid_total_yuan: paid,
    diff_total_yuan: diff,
    total_yuan: diff,
    steps: [...steps, `合计：加班 ${hoursTotal.all} 小时（${CATS.filter((c) => hoursTotal[c.key] > 0).map((c) => `${c.label} ${hoursTotal[c.key]} 小时`).join("、") || "无"}），应付 ${fmt(due)} 元，已付 ${fmt(paid)} 元，差额 ${fmt(diff)} 元`],
    basis: ["《中华人民共和国劳动法》第四十四条"],
    assumptions,
    warnings,
  };
}

const colName = (i: number): string => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** 加班费计算表：小时工资、各类加班费、应付、差额与合计都带公式；只出用到的类别；末尾附计算口径。 */
export function overtimeSheet(name: string, r: CalcOvertimeResult): SheetSpec {
  type Cell = string | number | null;
  const used = CATS.filter((c) => r.hours_total[c.key] > 0);
  const anyPaid = r.months.some((m) => m.paid_entered);
  const header: string[] = ["月份", "加班费计算基数（元）", "小时工资（元）"];
  const at: Record<string, number> = {};
  for (const c of used) {
    at[`${c.key}_h`] = header.push(`${c.label}（小时）`) - 1;
    at[`${c.key}_p`] = header.push(`${c.label}加班费（元，${r.multiples[c.key] * 100}%）`) - 1;
  }
  at.due = header.push("应付加班费（元）") - 1;
  if (anyPaid) at.paid = header.push("已付加班费（元）") - 1;
  at.diff = header.push("差额（元）") - 1;
  at.note = header.push("说明") - 1;
  const L = (k: string) => colName(at[k]!);
  const rows: Cell[][] = [header];
  const formulas: Record<string, string> = {};
  r.months.forEach((m, i) => {
    const row = i + 2;
    const cells: Cell[] = Array.from({ length: header.length }, () => null);
    cells[0] = m.month;
    cells[1] = m.base_yuan;
    cells[2] = m.hourly_yuan;
    formulas[`C${row}`] = `B${row}/${r.divisor_days}/${r.hours_per_day}`;
    for (const c of used) {
      cells[at[`${c.key}_h`]!] = m[`${c.key}_hours`];
      cells[at[`${c.key}_p`]!] = m[`${c.key}_pay_yuan`];
      formulas[`${L(`${c.key}_p`)}${row}`] = `ROUND(${L(`${c.key}_h`)}${row}*C${row}*${r.multiples[c.key]},2)`;
    }
    cells[at.due!] = m.due_yuan;
    formulas[`${L("due")}${row}`] = used.length > 0 ? used.map((c) => `${L(`${c.key}_p`)}${row}`).join("+") : "0";
    if (anyPaid) cells[at.paid!] = m.paid_yuan;
    cells[at.diff!] = m.diff_yuan;
    formulas[`${L("diff")}${row}`] = anyPaid ? `MAX(0,${L("due")}${row}-${L("paid")}${row})` : `${L("due")}${row}`;
    cells[at.note!] = m.note || null;
    rows.push(cells);
  });
  const last = r.months.length + 1;
  const total: Cell[] = Array.from({ length: header.length }, () => null);
  total[0] = "合计";
  const sumCol = (k: string, v: number) => {
    total[at[k]!] = v;
    formulas[`${L(k)}${last + 1}`] = `SUM(${L(k)}2:${L(k)}${last})`;
  };
  for (const c of used) {
    sumCol(`${c.key}_h`, r.hours_total[c.key]);
    sumCol(`${c.key}_p`, r.months.reduce((n, m) => n + Math.round(m[`${c.key}_pay_yuan`] * 100), 0) / 100);
  }
  sumCol("due", r.due_total_yuan);
  if (anyPaid) sumCol("paid", r.paid_total_yuan);
  sumCol("diff", r.diff_total_yuan);
  rows.push(total);
  rows.push(Array.from({ length: header.length }, () => null));
  for (const a of r.assumptions) rows.push(["计算口径", a, ...Array.from({ length: header.length - 2 }, () => null)]);
  return { name: name.replace(/[\\/?*[\]:]/g, "").slice(0, 31) || "加班费", rows, formulas };
}
