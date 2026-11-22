/**
 * calc.ledger — 债权台账（第 57 批，D-228）：一次算完“分段计息 + 还款抵充 + 汇总”，模型只给事实与口径，不做任何算术。
 *
 * 为什么要有它（第 56 批十三卡真实验收的根因）：calc.interest 只算“一段本金 × 一个期间”，段与段之间的事——
 * 本金随还款变动怎么分段、每笔还款先冲什么后冲什么、冲完还剩多少、各项怎么合计——全靠模型自己在脑子里算、再手敲进表格：
 * - 金额测算：备选抵充口径把已经冲掉的违约金又加回未清金额，多列 28,109.67 元；
 * - 答辩状：反诉违约金从逾期首日就按最终余额 31 万元计，少算两段；
 * - 强制执行：加倍部分债务利息从履行期最后一日（而不是次日）起算，多一天；
 * - “暂计至 X 日（含当日）”要模型自己把截止日加一天再传给 calc.interest，传错就差一天。
 * 这些都不是法律判断，是记账。记账交给确定性代码：起止日的含与不含、付款当日计不计、抵充顺序、舍入、勾稽，都在这里一处定义。
 *
 * 口径（全部写进返回的 assumptions，随表交付）：
 * - due_date 是“最后履行日”（当日仍在履行期内），次日起算；accrue_from 是“起算日（含当日）”。两者给一个。
 * - as_of 是“暂计截止日（含当日）”。
 * - 付款当日：缺省不计（付款当日起按付款后的余额计）；payment_day = "counted" 时付款当日仍按付款前余额计。
 * - 抵充：cost_interest_principal（缺省；实现债权的费用 → 利息 → 主债务，民法典第五百六十一条；同一层内先到期的先冲，第五百六十条）、
 *   principal_only（只冲本金，利息与违约金另行全额主张——双方对账确认余额、或约定付款即还本的口径）、principal_first（本金 → 利息 → 费用）。
 * - 迟延履行期间的加倍部分债务利息（doubled）：基数是“除一般债务利息之外的金钱债务”的未清偿部分（各笔债务 in_doubled_base 标注，
 *   缺省本金与费用计入、利息不计入），日万分之一点七五；清偿时排在生效法律文书确定的金钱债务之后（法释〔2014〕8 号第四条）。
 * - 舍入：每段四舍五入到分，合计为各段之和；金额内部按“分”的整数算，利率按整数比例算，不经过浮点。
 */
import { DomainError } from "@zr-legal/domain";
import { LPR_1Y, LPR_CHECKED_THROUGH } from "./calc.ts";

export type LedgerRate =
  | { kind: "daily"; per_10k: number }
  | { kind: "fixed"; annual_pct: number }
  | { kind: "lpr_plus"; lpr_term?: "1Y"; plus_bp: number }
  | { kind: "lpr_times"; lpr_term?: "1Y"; multiple: number }
  | { kind: "none" };

export interface LedgerDebt {
  label: string;
  amount_yuan: number;
  /** principal 本金（主债务）；cost 实现债权的费用、应由对方负担的诉讼费等；interest 已经确定数额的利息或违约金（不再生息）。缺省 principal。 */
  kind?: "principal" | "cost" | "interest";
  /** 最后履行日（含当日仍可履行）：次日起算。 */
  due_date?: string;
  /** 起算日（含当日）。与 due_date 给一个；都不给的不计息（只参与抵充与合计）。 */
  accrue_from?: string;
  /** 这一笔自己的利率；不给用顶层 rate。 */
  rate?: LedgerRate;
  /** 是否计入加倍部分债务利息的基数；缺省 principal 与 cost 计入、interest 不计入。 */
  in_doubled_base?: boolean;
}

export interface LedgerParams {
  /** 口径名称（如“口径一：付款冲本金”），写进表头与返回。 */
  name?: string;
  as_of: string;
  debts: LedgerDebt[];
  payments?: { date: string; amount_yuan: number; note?: string }[];
  rate?: LedgerRate;
  year_days?: 360 | 365;
  payment_day?: "not_counted" | "counted";
  allocation?: "cost_interest_principal" | "principal_only" | "principal_first";
  /** 利息或违约金的约定上限（元）：累计超过的按上限计。 */
  cap_yuan?: number;
  doubled?: { due_date?: string; accrue_from?: string; per_10k?: number };
}

export interface LedgerSegment {
  item: string;
  kind: "interest" | "doubled";
  from: string;
  /** 含当日 */
  to: string;
  days: number;
  base_yuan: number;
  rate_text: string;
  /** 日利率（小数），供表格公式使用：金额 = 基数 × 日利率 × 日数 */
  daily_rate: number;
  formula: string;
  amount_yuan: number;
}

export interface LedgerPaymentRow {
  date: string;
  amount_yuan: number;
  note: string;
  to_cost_yuan: number;
  to_interest_yuan: number;
  to_principal_yuan: number;
  to_doubled_yuan: number;
  unallocated_yuan: number;
  principal_after_yuan: number;
  interest_unpaid_after_yuan: number;
  detail: string;
}

export interface LedgerTotals {
  principal_original_yuan: number;
  principal_paid_yuan: number;
  principal_outstanding_yuan: number;
  interest_fixed_yuan: number;
  interest_accrued_yuan: number;
  interest_paid_yuan: number;
  interest_outstanding_yuan: number;
  cost_original_yuan: number;
  cost_paid_yuan: number;
  cost_outstanding_yuan: number;
  doubled_accrued_yuan: number;
  doubled_paid_yuan: number;
  doubled_outstanding_yuan: number;
  payments_total_yuan: number;
  unallocated_yuan: number;
  total_outstanding_yuan: number;
}

export interface LedgerResult {
  name: string;
  as_of: string;
  segments: LedgerSegment[];
  payments: LedgerPaymentRow[];
  per_debt: { label: string; kind: string; original_yuan: number; paid_yuan: number; outstanding_yuan: number; interest_accrued_yuan: number; interest_paid_yuan: number; interest_outstanding_yuan: number; accrue_from: string | null }[];
  totals: LedgerTotals;
  cap: { cap_yuan: number; accrued_yuan: number; applied: boolean; reached_on: string | null; projected: boolean } | null;
  /** 一句话结论，可直接写进文书（数字与 totals 相同）。 */
  summary: string;
  assumptions: string[];
  warnings: string[];
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_DAY = 86_400_000;
const RATE_SCALE = 1_000_000n; // 利率数值放大到整数的倍数

const validDay = (d: unknown): d is string => typeof d === "string" && DAY_RE.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const addDays = (d: string, n: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + n * MS_DAY).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / MS_DAY);

/** 元（至多两位小数）转成“分”的整数；超过两位小数或不是有限数的拒收。 */
function cents(v: unknown, name: string): bigint {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new DomainError("validation", `${name} 须为非负数字（元）`, 422);
  const c = Math.round(v * 100);
  if (Math.abs(v * 100 - c) > 1e-6) throw new DomainError("validation", `${name} 最多两位小数（元）`, 422);
  if (!Number.isSafeInteger(c)) throw new DomainError("validation", `${name} 过大`, 422);
  return BigInt(c);
}
const yuan = (c: bigint): number => Number(c) / 100;
const fmt = (c: bigint): string => yuan(c).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** 四舍五入的整数除法（被除数、除数均非负）。 */
const divRound = (n: bigint, d: bigint): bigint => (2n * n + d) / (2n * d);
const scaled = (x: number): bigint => BigInt(Math.round(x * Number(RATE_SCALE)));
const trim = (x: number): string => String(Number(x.toFixed(6)));

interface RateAt {
  /** 利息（分）= 基数（分）× num × 日数 ÷ den */
  num: bigint;
  den: bigint;
  text: string;
  daily: number;
}

function lprAt(date: string): { effective: string; pct: number } {
  let chosen: { effective: string; pct: number } | null = null;
  for (const row of LPR_1Y) if (row.effective <= date && (!chosen || row.effective > chosen.effective)) chosen = row;
  if (!chosen) throw new DomainError("validation", `calc.ledger: ${date} 之前没有收录 LPR 报价`, 422);
  return chosen;
}

function rateAt(spec: LedgerRate, date: string, yearDays: number): RateAt | null {
  if (spec.kind === "none") return null;
  if (spec.kind === "daily") {
    return { num: scaled(spec.per_10k), den: 10_000n * RATE_SCALE, text: `日万分之${trim(spec.per_10k)}`, daily: spec.per_10k / 10_000 };
  }
  if (spec.kind === "fixed") {
    return { num: scaled(spec.annual_pct), den: 100n * RATE_SCALE * BigInt(yearDays), text: `年利率 ${trim(spec.annual_pct)}%（年 ${yearDays} 日）`, daily: spec.annual_pct / 100 / yearDays };
  }
  const lpr = lprAt(date);
  const pct = spec.kind === "lpr_times" ? Math.round(lpr.pct * spec.multiple * 10_000) / 10_000 : lpr.pct + spec.plus_bp / 100;
  const how = spec.kind === "lpr_times" ? `一年期 LPR ${trim(lpr.pct)}% × ${trim(spec.multiple)}` : `一年期 LPR ${trim(lpr.pct)}% + ${trim(spec.plus_bp)} 基点`;
  return { num: scaled(pct), den: 100n * RATE_SCALE * BigInt(yearDays), text: `${how} = 年 ${trim(pct)}%（${lpr.effective} 报价，年 ${yearDays} 日）`, daily: pct / 100 / yearDays };
}

function checkRate(r: LedgerRate | undefined, where: string): void {
  if (r === undefined) return;
  const bad = (m: string) => new DomainError("validation", `${where} 的 rate ${m}`, 422);
  if (!r || typeof r !== "object") throw bad("格式不对");
  if (r.kind === "none") return;
  if (r.kind === "daily") {
    if (!(Number.isFinite(r.per_10k) && r.per_10k > 0 && r.per_10k <= 100)) throw bad("per_10k 须在 0～100 之间（日万分之几：日万分之五写 5，日千分之一写 10）");
    return;
  }
  if (r.kind === "fixed") {
    if (!(Number.isFinite(r.annual_pct) && r.annual_pct > 0 && r.annual_pct <= 100)) throw bad("annual_pct 须在 0～100 之间（年利率百分数）");
    return;
  }
  if (r.kind === "lpr_plus") {
    if (!Number.isFinite(r.plus_bp)) throw bad("plus_bp 须为数字（基点）");
    return;
  }
  if (r.kind === "lpr_times") {
    if (!(Number.isFinite(r.multiple) && r.multiple > 0 && r.multiple <= 4)) throw bad("multiple 须在 0～4 之间");
    return;
  }
  throw bad("kind 须为 daily、fixed、lpr_plus、lpr_times 或 none");
}

interface Line {
  label: string;
  kind: "principal" | "cost" | "interest";
  original: bigint;
  out: bigint;
  paid: bigint;
  start: string | null;
  rate: LedgerRate;
  inDoubled: boolean;
  order: number;
  accrued: bigint;
  intPaid: bigint;
}

const ALLOCATION_TEXT = {
  cost_interest_principal: "实现债权的费用 → 利息（违约金）→ 本金；同一层内先到期的先冲",
  principal_only: "只冲本金；利息、违约金不因付款减少，另行全额计",
  principal_first: "本金 → 利息（违约金）→ 费用",
} as const;

export function calcLedger(p: LedgerParams): LedgerResult {
  if (!p || typeof p !== "object") throw new DomainError("validation", "calc.ledger 需要参数", 422);
  if (!validDay(p.as_of)) throw new DomainError("validation", "as_of（暂计截止日，含当日）格式 YYYY-MM-DD", 422);
  const yearDays = p.year_days ?? 365;
  if (yearDays !== 360 && yearDays !== 365) throw new DomainError("validation", "year_days 仅支持 360/365", 422);
  const allocation = p.allocation ?? "cost_interest_principal";
  if (!(allocation in ALLOCATION_TEXT)) throw new DomainError("validation", "allocation 须为 cost_interest_principal、principal_only 或 principal_first", 422);
  const counted = p.payment_day === "counted";
  if (p.payment_day !== undefined && p.payment_day !== "counted" && p.payment_day !== "not_counted") throw new DomainError("validation", "payment_day 须为 not_counted 或 counted", 422);
  if (!Array.isArray(p.debts) || p.debts.length === 0 || p.debts.length > 60) throw new DomainError("validation", "debts 须为 1～60 笔", 422);
  checkRate(p.rate, "顶层");
  const end = addDays(p.as_of, 1); // 不含

  const warnings: string[] = [];
  const lines: Line[] = p.debts.map((d, i) => {
    const where = `第 ${i + 1} 笔债务`;
    if (!d || typeof d.label !== "string" || !d.label.trim()) throw new DomainError("validation", `${where} 需要 label（款项名称）`, 422);
    const kind = d.kind ?? "principal";
    if (kind !== "principal" && kind !== "cost" && kind !== "interest") throw new DomainError("validation", `${where} 的 kind 须为 principal、cost 或 interest`, 422);
    if (d.due_date !== undefined && d.accrue_from !== undefined) throw new DomainError("validation", `${where} 的 due_date（最后履行日，次日起算）与 accrue_from（起算日，含当日）只给一个`, 422);
    if (d.due_date !== undefined && !validDay(d.due_date)) throw new DomainError("validation", `${where} 的 due_date 格式 YYYY-MM-DD`, 422);
    if (d.accrue_from !== undefined && !validDay(d.accrue_from)) throw new DomainError("validation", `${where} 的 accrue_from 格式 YYYY-MM-DD`, 422);
    checkRate(d.rate, where);
    const start = d.accrue_from ?? (d.due_date ? addDays(d.due_date, 1) : null);
    const rate: LedgerRate = kind === "principal" ? (d.rate ?? p.rate ?? { kind: "none" }) : (d.rate ?? { kind: "none" });
    if (kind === "principal" && rate.kind !== "none" && !start) throw new DomainError("validation", `${where}（${d.label}）要计息但没有给 due_date 或 accrue_from`, 422);
    if (start && start >= end && rate.kind !== "none") warnings.push(`“${d.label}”的起算日 ${start} 晚于暂计截止日 ${p.as_of}：这一笔在本口径下尚未起算，利息为 0`);
    return { label: d.label.trim().slice(0, 60), kind, original: cents(d.amount_yuan, `${where} 的 amount_yuan`), out: 0n, paid: 0n, start, rate, inDoubled: d.in_doubled_base ?? kind !== "interest", order: i, accrued: 0n, intPaid: 0n };
  });
  for (const l of lines) l.out = l.original;
  const labels = new Set<string>();
  for (const l of lines) {
    if (labels.has(l.label)) throw new DomainError("validation", `债务名称“${l.label}”重复：每笔用不同的名称`, 422);
    labels.add(l.label);
  }

  const pays = (p.payments ?? []).map((x, i) => {
    if (!x || !validDay(x.date)) throw new DomainError("validation", `第 ${i + 1} 笔付款的 date 格式 YYYY-MM-DD`, 422);
    const amount = cents(x.amount_yuan, `第 ${i + 1} 笔付款的 amount_yuan`);
    if (amount === 0n) throw new DomainError("validation", `第 ${i + 1} 笔付款金额为 0`, 422);
    return { date: x.date, amount, note: typeof x.note === "string" ? x.note.slice(0, 80) : "", order: i };
  });
  pays.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));
  const usable = pays.filter((x) => {
    if (x.date > p.as_of) {
      warnings.push(`${x.date} 的付款 ${fmt(x.amount)} 元晚于暂计截止日 ${p.as_of}，本口径没有计入`);
      return false;
    }
    return true;
  });

  // 加倍部分债务利息
  let doubledStart: string | null = null;
  let doubledRate: RateAt | null = null;
  if (p.doubled) {
    const d = p.doubled;
    if ((d.due_date === undefined) === (d.accrue_from === undefined)) throw new DomainError("validation", "doubled 的 due_date（履行期间最后一日，次日起算）与 accrue_from（起算日，含当日）给且只给一个", 422);
    const day = d.due_date ?? d.accrue_from;
    if (!validDay(day)) throw new DomainError("validation", "doubled 的日期格式 YYYY-MM-DD", 422);
    doubledStart = d.due_date ? addDays(d.due_date, 1) : d.accrue_from!;
    const per = d.per_10k ?? 1.75;
    if (!(Number.isFinite(per) && per > 0 && per <= 100)) throw new DomainError("validation", "doubled.per_10k 须在 0～100 之间（缺省 1.75，即日万分之一点七五）", 422);
    doubledRate = rateAt({ kind: "daily", per_10k: per }, doubledStart, yearDays);
  }
  let doubledAccrued = 0n;
  let doubledPaid = 0n;

  // 时间轴上的分界点：各笔起算日、付款生效日、LPR 报价日、截止日次日
  const payAt = (x: { date: string }) => (counted ? addDays(x.date, 1) : x.date);
  const cuts = new Set<string>([end]);
  for (const l of lines) if (l.start && l.start < end) cuts.add(l.start);
  if (doubledStart && doubledStart < end) cuts.add(doubledStart);
  for (const x of usable) cuts.add(payAt(x));
  const usesLpr = lines.some((l) => l.rate.kind === "lpr_plus" || l.rate.kind === "lpr_times");
  const firstStart = [...lines.map((l) => l.start).filter((s): s is string => !!s), ...(doubledStart ? [doubledStart] : [])].sort()[0] ?? end;
  if (usesLpr) for (const row of LPR_1Y) if (row.effective > firstStart && row.effective < end) cuts.add(row.effective);
  const points = [...cuts].filter((c) => c <= end).sort();

  const tier = (kind: Line["kind"]) => lines.filter((l) => l.kind === kind).sort((a, b) => ((a.start ?? "9999") < (b.start ?? "9999") ? -1 : (a.start ?? "9999") > (b.start ?? "9999") ? 1 : a.order - b.order));
  const principalOut = () => lines.filter((l) => l.kind === "principal").reduce((n, l) => n + l.out, 0n);
  const interestUnpaid = () => lines.reduce((n, l) => n + (l.kind === "interest" ? l.out : 0n) + (l.accrued - l.intPaid), 0n);

  const segments: LedgerSegment[] = [];
  const paymentRows: LedgerPaymentRow[] = [];
  let unallocated = 0n;
  let capReachedOn: string | null = null;
  const cap = p.cap_yuan === undefined ? null : cents(p.cap_yuan, "cap_yuan");
  const runningAccrued = () => lines.reduce((n, l) => n + l.accrued, 0n);

  const applyPayments = (at: string) => {
    for (const x of usable) {
      if (payAt(x) !== at) continue;
      let left = x.amount;
      const row = { cost: 0n, interest: 0n, principal: 0n, doubled: 0n };
      const parts: string[] = [];
      const take = (avail: bigint): bigint => {
        const t = avail < left ? avail : left;
        left -= t;
        return t;
      };
      const payCost = () => {
        for (const l of tier("cost")) {
          const t = take(l.out);
          if (t > 0n) {
            l.out -= t;
            l.paid += t;
            row.cost += t;
            parts.push(`${l.label} ${fmt(t)}`);
          }
        }
      };
      const payInterest = () => {
        for (const l of tier("interest")) {
          const t = take(l.out);
          if (t > 0n) {
            l.out -= t;
            l.paid += t;
            row.interest += t;
            parts.push(`${l.label} ${fmt(t)}`);
          }
        }
        for (const l of tier("principal")) {
          const t = take(l.accrued - l.intPaid);
          if (t > 0n) {
            l.intPaid += t;
            row.interest += t;
            parts.push(`${l.label}的利息（违约金）${fmt(t)}`);
          }
        }
      };
      const payPrincipal = () => {
        // 已到期（已起算或没有起算日）的先冲，未到期的后冲
        const due = tier("principal");
        for (const pass of [0, 1]) {
          for (const l of due) {
            const isDue = !l.start || l.start <= at;
            if ((pass === 0) !== isDue) continue;
            const t = take(l.out);
            if (t > 0n) {
              l.out -= t;
              l.paid += t;
              row.principal += t;
              parts.push(`${l.label}本金 ${fmt(t)}`);
            }
          }
        }
      };
      const payDoubled = () => {
        const t = take(doubledAccrued - doubledPaid);
        if (t > 0n) {
          doubledPaid += t;
          row.doubled += t;
          parts.push(`加倍部分债务利息 ${fmt(t)}`);
        }
      };
      if (allocation === "cost_interest_principal") {
        payCost();
        payInterest();
        payPrincipal();
        payDoubled();
      } else if (allocation === "principal_first") {
        payPrincipal();
        payInterest();
        payCost();
        payDoubled();
      } else {
        payPrincipal();
      }
      if (left > 0n) {
        unallocated += left;
        warnings.push(
          allocation === "principal_only"
            ? `${x.date} 的付款 ${fmt(x.amount)} 元冲完全部本金后还多 ${fmt(left)} 元：只冲本金的口径下没有再冲利息，多出的部分单列，由律师决定怎么处理`
            : `${x.date} 的付款 ${fmt(x.amount)} 元冲完当时全部应付款项后还多 ${fmt(left)} 元，单列为多付`,
        );
      }
      paymentRows.push({
        date: x.date,
        amount_yuan: yuan(x.amount),
        note: x.note,
        to_cost_yuan: yuan(row.cost),
        to_interest_yuan: yuan(row.interest),
        to_principal_yuan: yuan(row.principal),
        to_doubled_yuan: yuan(row.doubled),
        unallocated_yuan: yuan(left),
        principal_after_yuan: yuan(principalOut()),
        interest_unpaid_after_yuan: yuan(interestUnpaid()),
        detail: parts.join("；") || "（没有可冲的款项）",
      });
    }
  };

  // 每笔付款的生效日都在分界点里（含起算前的付款），按时间顺序逐段推进
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    applyPayments(a);
    const b = points[i + 1];
    if (!b) break;
    const days = daysBetween(a, b);
    for (const l of lines) {
      if (l.kind !== "principal" || l.rate.kind === "none" || !l.start || l.start > a || l.out === 0n) continue;
      const r = rateAt(l.rate, a, yearDays)!;
      const amount = divRound(l.out * r.num * BigInt(days), r.den);
      const before = runningAccrued();
      l.accrued += amount;
      if (cap !== null && capReachedOn === null && before + amount >= cap && amount > 0n) {
        // 上限在这一段内达到：按日均摊推到具体哪一天
        const perDay = Number(amount) / days;
        capReachedOn = addDays(a, Math.min(days - 1, Math.max(0, Math.ceil(Number(cap - before) / perDay) - 1)));
      }
      segments.push({ item: l.label, kind: "interest", from: a, to: addDays(b, -1), days, base_yuan: yuan(l.out), rate_text: r.text, daily_rate: r.daily, formula: `${fmt(l.out)} × ${r.text} × ${days} 日`, amount_yuan: yuan(amount) });
    }
    if (doubledRate && doubledStart && doubledStart <= a) {
      const base = lines.filter((l) => l.inDoubled).reduce((n, l) => n + l.out, 0n);
      if (base > 0n) {
        const amount = divRound(base * doubledRate.num * BigInt(days), doubledRate.den);
        doubledAccrued += amount;
        segments.push({ item: "加倍部分债务利息", kind: "doubled", from: a, to: addDays(b, -1), days, base_yuan: yuan(base), rate_text: doubledRate.text, daily_rate: doubledRate.daily, formula: `${fmt(base)} × ${doubledRate.text} × ${days} 日`, amount_yuan: yuan(amount) });
      }
    }
  }

  // 汇总与勾稽
  const sum = (f: (l: Line) => bigint, kind?: Line["kind"]) => lines.filter((l) => !kind || l.kind === kind).reduce((n, l) => n + f(l), 0n);
  const accrued = runningAccrued();
  const runningPaid = sum((l) => l.intPaid);
  const fixedInterest = sum((l) => l.original, "interest");
  const fixedInterestPaid = sum((l) => l.paid, "interest");
  let capInfo: LedgerResult["cap"] = null;
  let claimAccrued = accrued;
  if (cap !== null) {
    const applied = accrued > cap;
    if (applied) claimAccrued = cap;
    let reached = capReachedOn;
    let projected = false;
    if (!applied && accrued < cap) {
      // 按截止日当天的日累计额往后推
      const daily = lines.reduce((n, l) => {
        if (l.kind !== "principal" || l.rate.kind === "none" || !l.start || l.start > p.as_of || l.out === 0n) return n;
        const r = rateAt(l.rate, p.as_of, yearDays)!;
        return n + Number(l.out * r.num) / Number(r.den);
      }, 0);
      if (daily > 0) {
        reached = addDays(p.as_of, Math.ceil(Number(cap - accrued) / daily));
        projected = true;
      } else reached = null;
    }
    capInfo = { cap_yuan: yuan(cap), accrued_yuan: yuan(accrued), applied, reached_on: reached, projected };
  }
  const interestOutstanding = (() => {
    const o = fixedInterest - fixedInterestPaid + claimAccrued - runningPaid;
    return o < 0n ? 0n : o;
  })();
  const totals = {
    principal_original: sum((l) => l.original, "principal"),
    principal_paid: sum((l) => l.paid, "principal"),
    principal_outstanding: sum((l) => l.out, "principal"),
    cost_original: sum((l) => l.original, "cost"),
    cost_paid: sum((l) => l.paid, "cost"),
    cost_outstanding: sum((l) => l.out, "cost"),
    payments_total: usable.reduce((n, x) => n + x.amount, 0n),
  };
  // 勾稽：付款合计 = 冲费用 + 冲利息 + 冲本金 + 冲加倍利息 + 未冲
  const allocated = totals.cost_paid + fixedInterestPaid + runningPaid + totals.principal_paid + doubledPaid + unallocated;
  if (allocated !== totals.payments_total) throw new DomainError("internal", "calc.ledger 内部勾稽不平（付款合计与各项抵充之和不等），未出结果", 500);
  const doubledOutstanding = doubledAccrued - doubledPaid;
  const totalOutstanding = totals.principal_outstanding + interestOutstanding + totals.cost_outstanding + doubledOutstanding;

  if (usesLpr && p.as_of > LPR_CHECKED_THROUGH) warnings.push(`${LPR_CHECKED_THROUGH} 之后的 LPR 报价没有收录，这之后按最后一次报价计：请到全国银行间同业拆借中心核对后再定稿`);

  const T: LedgerTotals = {
    principal_original_yuan: yuan(totals.principal_original),
    principal_paid_yuan: yuan(totals.principal_paid),
    principal_outstanding_yuan: yuan(totals.principal_outstanding),
    interest_fixed_yuan: yuan(fixedInterest),
    interest_accrued_yuan: yuan(claimAccrued),
    interest_paid_yuan: yuan(fixedInterestPaid + runningPaid),
    interest_outstanding_yuan: yuan(interestOutstanding),
    cost_original_yuan: yuan(totals.cost_original),
    cost_paid_yuan: yuan(totals.cost_paid),
    cost_outstanding_yuan: yuan(totals.cost_outstanding),
    doubled_accrued_yuan: yuan(doubledAccrued),
    doubled_paid_yuan: yuan(doubledPaid),
    doubled_outstanding_yuan: yuan(doubledOutstanding),
    payments_total_yuan: yuan(totals.payments_total),
    unallocated_yuan: yuan(unallocated),
    total_outstanding_yuan: yuan(totalOutstanding),
  };
  const name = (typeof p.name === "string" && p.name.trim() ? p.name.trim() : "测算").slice(0, 40);
  const pieces = [`本金余额 ${fmt(totals.principal_outstanding)} 元`];
  if (fixedInterest + accrued > 0n) pieces.push(`利息（违约金）未付 ${fmt(interestOutstanding)} 元（累计 ${fmt(fixedInterest + claimAccrued)} 元${fixedInterestPaid + runningPaid > 0n ? `，已冲 ${fmt(fixedInterestPaid + runningPaid)} 元` : ""}${capInfo?.applied ? `，已按约定上限 ${fmt(cap!)} 元计` : ""}）`);
  if (totals.cost_original > 0n) pieces.push(`费用未付 ${fmt(totals.cost_outstanding)} 元`);
  if (doubledRate) pieces.push(`加倍部分债务利息未付 ${fmt(doubledOutstanding)} 元`);
  const summary = `${name}：截至 ${p.as_of}（含当日），${pieces.join("，")}，合计 ${fmt(totalOutstanding)} 元。`;

  const assumptions = [
    `暂计截止日 ${p.as_of}，含当日`,
    "起算：按最后履行日给的，自次日起算；按起算日给的，含当日",
    counted ? "付款当日：仍按付款前的余额计，次日起按付款后的余额计" : "付款当日：不计（当日起按付款后的余额计）",
    `抵充顺序：${ALLOCATION_TEXT[allocation]}`,
    "舍入：每段四舍五入到分，合计为各段之和",
    ...(usesLpr ? [`LPR 为一年期公开报价，按报价生效日分段，核至 ${LPR_CHECKED_THROUGH}`] : []),
    ...(lines.some((l) => l.rate.kind === "fixed" || l.rate.kind === "lpr_plus" || l.rate.kind === "lpr_times") ? [`年利率折算到日按年 ${yearDays} 日`] : []),
    ...(doubledRate ? [`加倍部分债务利息：基数为${lines.filter((l) => l.inDoubled).map((l) => l.label).join("、") || "（无）"}的未清偿部分，${doubledRate.text}，自 ${doubledStart} 起（含当日）；清偿时排在生效法律文书确定的金钱债务之后`] : []),
    ...(cap !== null ? [`利息（违约金）约定上限 ${fmt(cap)} 元：累计超过的按上限计`] : []),
  ];

  return {
    name,
    as_of: p.as_of,
    segments,
    payments: paymentRows,
    per_debt: lines.map((l) => ({
      label: l.label,
      kind: l.kind,
      original_yuan: yuan(l.original),
      paid_yuan: yuan(l.paid),
      outstanding_yuan: yuan(l.out),
      interest_accrued_yuan: yuan(l.accrued),
      interest_paid_yuan: yuan(l.intPaid),
      interest_outstanding_yuan: yuan(l.accrued - l.intPaid),
      accrue_from: l.start,
    })),
    totals: T,
    cap: capInfo,
    summary,
    assumptions,
    warnings,
  };
}
