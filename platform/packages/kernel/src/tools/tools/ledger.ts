/**
 * calc.ledger — 债权台账（第 57 批，D-228；第 58 批补违约金、分段、待核日期与调减参照）：一次算完“分段计息 + 还款抵充 + 汇总”，模型只给事实与口径，不做任何算术。
 *
 * 为什么要有它（第 56 批十三卡真实验收的根因）：calc.interest 只算“一段本金 × 一个期间”，段与段之间的事——
 * 本金随还款变动怎么分段、每笔还款先冲什么后冲什么、冲完还剩多少、各项怎么合计——全靠模型自己在脑子里算、再手敲进表格。
 * 这些都不是法律判断，是记账。记账交给确定性代码：起止日的含与不含、付款当日计不计、抵充顺序、舍入、勾稽，都在这里一处定义。
 *
 * 口径（全部写进返回的 assumptions，随表交付）：
 * - due_date 是“最后履行日”（当日仍在履行期内），次日起算；accrue_from 是“起算日（含当日）”。两者给一个。accrue_to 是“计至日（含当日）”，不给的计到暂计截止日。
 * - as_of 是“暂计截止日（含当日）”。
 * - 付款当日：缺省不计（付款当日起按付款后的余额计）；payment_day = "counted" 时付款当日仍按付款前余额计。
 * - 款项类别（kind）：principal 本金（主债务，可按 rate 计利息或违约金，accrual 说明计得的是哪一种）；cost 实现债权的有关费用；
 *   interest 数额已确定的利息；penalty 违约金的计算基数（如逾期交付货物的价款）——基数本身不是欠款，不计入未清偿合计、不参与抵充，
 *   只按 rate 计出违约金；penalty_fixed 数额已确定的违约金。
 * - 抵充（民法典第五百六十一条：债务人在履行主债务外还应当支付利息和实现债权的有关费用，给付不足以清偿全部债务的，
 *   除当事人另有约定外，按“实现债权的有关费用 → 利息 → 主债务”的顺序履行）：
 *   cost_interest_principal（缺省）按此顺序；数笔本金之间按第五百六十条第二款的末位规则“已到期的优先、按到期先后”冲
 *   （该款在此之前还有“担保最少”“负担较重”的优先规则，本工具不区分担保与负担轻重，各笔不同的须律师另行判断；第一款债务人清偿时指定的，按指定）；
 *   principal_only（只冲本金，利息与违约金另行全额主张——双方对账确认余额、或约定付款即还本的口径）；principal_first（本金 → 利息 → 违约金 → 费用）。
 * - 违约金的冲抵：第五百六十一条列的是费用、利息、主债务，没有列违约金；违约金能否当然按“利息”的顺序优先于本金冲抵，实务有争议，
 *   主流做法不当然适用。缺省 penalty_order = "after_principal"：违约金排在本金之后（付款先冲本金，违约金另行主张）；
 *   penalty_order = "as_interest" 是律师明确选择的有争议口径：违约金与利息同序、先于本金冲抵。
 * - 迟延履行期间的加倍部分债务利息（doubled）：基数是“尚未清偿的生效法律文书确定的除一般债务利息之外的金钱债务”
 *   （法释〔2014〕8 号第一条；各笔债务 in_doubled_base 标注，缺省本金、费用、已确定的违约金计入，一般债务利息不计入），日万分之一点七五；
 *   财产不足以清偿全部债务的，先清偿生效法律文书确定的金钱债务、再清偿加倍部分债务利息（同解释第四条），所以排在最后冲。
 * - 分段：每笔款项只在它自己的计算基数或利率变化时分段——别的款项的起算日、付款日不切开这一笔（V31 企业催告函一单写出“×6 日＋×3 日”）。
 * - 待核日期：付款日或起算日只知道区间的（date_range、due_date_range、accrue_from_range），calcLedgerScenarios 按最早、最晚各算一个口径并列，
 *   两端相同的分段是确定的，其余分段标“依赖待核日期”（V31 答辩状一单因一笔到账日不明放弃了之前确定逾期的各段）。
 * - 违约金调减参照：合同编通则解释（法释〔2023〕13 号）第六十五条第二款“约定的违约金超过造成损失的百分之三十的，人民法院一般可以认定为过分高于造成的损失”。
 *   给了损失数额（loss_yuan）或损失的计算标准（loss_rate）才测算“损失 × 130%”参照值；都没给只列需要的证据，不编数。
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

export type LedgerDebtKind = "principal" | "cost" | "interest" | "penalty" | "penalty_fixed";
export type LedgerAccrual = "interest" | "penalty";

/** 只知道区间的日期（待核）：最早、最晚两端各算一个口径。 */
export interface LedgerDateRange {
  earliest: string;
  latest: string;
  note?: string;
}

export interface LedgerDebt {
  label: string;
  amount_yuan: number;
  /** 缺省 principal。penalty 的 amount_yuan 是违约金的计算基数（不是欠款）。 */
  kind?: LedgerDebtKind;
  /** 最后履行日（含当日仍可履行）：次日起算。 */
  due_date?: string;
  /** 起算日（含当日）。与 due_date 给一个；都不给的不计息（只参与抵充与合计）。 */
  accrue_from?: string;
  /** 最后履行日只知道区间（待核）。 */
  due_date_range?: LedgerDateRange;
  /** 起算日只知道区间（待核）。 */
  accrue_from_range?: LedgerDateRange;
  /** 计至日（含当日）：如逾期交货的违约金计到实际交付的前一日；不给的计到暂计截止日。 */
  accrue_to?: string;
  /** principal 按 rate 计得的是利息还是违约金；缺省取顶层 accrual，再缺省 interest。 */
  accrual?: LedgerAccrual;
  /** 这一笔自己的利率；不给用顶层 rate。 */
  rate?: LedgerRate;
  /** 是否计入加倍部分债务利息的基数；缺省 principal、cost、penalty_fixed 计入，interest 不计入（penalty 基数不是债务，不能计入）。 */
  in_doubled_base?: boolean;
  /** 这一笔计得的利息或违约金的约定上限（元）。 */
  cap_yuan?: number;
}

export interface LedgerPayment {
  date?: string;
  /** 付款日只知道区间（待核），与 date 给一个。 */
  date_range?: LedgerDateRange;
  amount_yuan: number;
  note?: string;
}

export interface LedgerPenaltyCheck {
  /** 律师给出或材料载明的损失数额（元）。 */
  loss_yuan?: number;
  /** 损失的计算标准（如资金占用损失按一年期 LPR）：按违约金的同一基数与期间计算损失。与 loss_yuan 给一个。 */
  loss_rate?: LedgerRate;
  /** 损失数额或标准的出处。 */
  loss_basis?: string;
}

export interface LedgerParams {
  /** 口径名称（如“口径一：付款冲本金”），写进表头与返回。 */
  name?: string;
  /** 这个口径成立的前提（第 58 批）：写进汇总表“口径前提”一行，读表的人不必翻参数表就知道每一列靠什么成立。 */
  premise?: string;
  as_of: string;
  debts: LedgerDebt[];
  payments?: LedgerPayment[];
  rate?: LedgerRate;
  /** principal 按 rate 计得的缺省是利息还是违约金。 */
  accrual?: LedgerAccrual;
  year_days?: 360 | 365;
  payment_day?: "not_counted" | "counted";
  allocation?: "cost_interest_principal" | "principal_only" | "principal_first";
  /** 违约金的冲抵顺序：after_principal（缺省，排在本金之后）；as_interest（与利息同序，有争议的口径）。 */
  penalty_order?: "after_principal" | "as_interest";
  /** 利息或违约金的约定上限（元）：累计超过的按上限计（有违约金的口径用于违约金，否则用于利息）。 */
  cap_yuan?: number;
  doubled?: { due_date?: string; accrue_from?: string; per_10k?: number };
  penalty_check?: LedgerPenaltyCheck;
}

export interface LedgerSegment {
  item: string;
  kind: "interest" | "penalty" | "doubled";
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
  /** 这一段随待核日期变化（另一端没有完全相同的一段）。 */
  pending?: boolean;
}

export interface LedgerPaymentRow {
  date: string;
  amount_yuan: number;
  note: string;
  to_cost_yuan: number;
  to_interest_yuan: number;
  to_principal_yuan: number;
  to_penalty_yuan: number;
  to_doubled_yuan: number;
  unallocated_yuan: number;
  principal_after_yuan: number;
  interest_unpaid_after_yuan: number;
  penalty_unpaid_after_yuan: number;
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
  /** 违约金计算基数之和（不是欠款，不计入合计）。 */
  penalty_base_yuan: number;
  penalty_fixed_yuan: number;
  penalty_accrued_yuan: number;
  penalty_paid_yuan: number;
  penalty_outstanding_yuan: number;
  cost_original_yuan: number;
  cost_paid_yuan: number;
  cost_outstanding_yuan: number;
  doubled_accrued_yuan: number;
  doubled_paid_yuan: number;
  doubled_outstanding_yuan: number;
  payments_total_yuan: number;
  unallocated_yuan: number;
  total_outstanding_yuan: number;
  /**
   * 第 65 批（V39，D-280）：履行期尚未届满的本金余额（最后履行日在暂计截止日当日或之后、起算日在截止日之后的本金）与已届满部分合计。
   * V35 三张卡（争点矩阵、管辖与时效、保全）把未到期的质保金混进“未清偿合计”当起诉标的，只靠旁注提醒——拆成两段小计后起诉类方法引用已届满部分。
   */
  principal_not_due_yuan: number;
  total_due_outstanding_yuan: number;
}

export interface LedgerPenaltyCheckResult {
  /** 参与比较的违约金（元）。 */
  penalty_yuan: number;
  loss_yuan: number | null;
  loss_basis: string | null;
  /** 损失 × 130%。 */
  reference_yuan: number | null;
  exceeds: boolean | null;
  /** 一句话结论（可照抄进内部意见）；没有损失数据时说明需要什么证据。 */
  conclusion: string;
  needs: string[];
}

export interface LedgerResult {
  name: string;
  /** 这个口径成立的前提（律师或助手写明的，如“超期修复属卖方原因、质保金顺延 29 日”）；没写为 null。第 58 批。 */
  premise: string | null;
  as_of: string;
  segments: LedgerSegment[];
  payments: LedgerPaymentRow[];
  per_debt: { label: string; kind: string; accrued_as: "利息" | "违约金" | null; original_yuan: number; paid_yuan: number; outstanding_yuan: number; interest_accrued_yuan: number; interest_paid_yuan: number; interest_outstanding_yuan: number; accrue_from: string | null; accrue_to: string | null }[];
  totals: LedgerTotals;
  cap: { cap_yuan: number; applies_to: "利息" | "违约金"; accrued_yuan: number; applied: boolean; reached_on: string | null; projected: boolean } | null;
  penalty_check: LedgerPenaltyCheckResult | null;
  /** 有待核日期时：本口径按哪一端算、哪些日期待核、依赖待核日期的分段数、另一端的合计。 */
  pending_dates: { end: "earliest" | "latest"; items: string[]; dependent_segments: number; other_name: string; other_total_outstanding_yuan: number } | null;
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
const min = (a: bigint, b: bigint | null): bigint => (b !== null && b < a ? b : a);

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

/** 利率口径的说法（参数表与说明用；LPR 按各期报价，不写某一期的数）。 */
export function rateLabel(r: LedgerRate | undefined): string {
  if (!r || r.kind === "none") return "不计息";
  if (r.kind === "daily") return `日万分之${trim(r.per_10k)}`;
  if (r.kind === "fixed") return `年利率 ${trim(r.annual_pct)}%`;
  if (r.kind === "lpr_plus") return `一年期 LPR 加 ${trim(r.plus_bp)} 基点（按各期报价）`;
  return `一年期 LPR 的 ${trim(r.multiple)} 倍（按各期报价）`;
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

const KINDS: readonly LedgerDebtKind[] = ["principal", "cost", "interest", "penalty", "penalty_fixed"];

interface Line {
  label: string;
  kind: LedgerDebtKind;
  original: bigint;
  out: bigint;
  paid: bigint;
  start: string | null;
  /** 计到这一天之前（不含）；null 计到截止日 */
  stop: string | null;
  rate: LedgerRate;
  /** 按 rate 计得的是什么；null 不计 */
  accrual: LedgerAccrual | null;
  inDoubled: boolean;
  order: number;
  accrued: bigint;
  intPaid: bigint;
  cap: bigint | null;
  seg: { from: string; base: bigint; r: RateAt } | null;
}

const ALLOCATION_TEXT = {
  cost_interest_principal: "实现债权的有关费用 → 利息 → 本金（民法典第五百六十一条）；数笔本金之间已到期的先冲、按到期先后（第五百六十条第二款；各笔担保或负担轻重不同的，另行判断）",
  principal_only: "只冲本金；利息、违约金不因付款减少，另行全额计",
  principal_first: "本金 → 利息 → 违约金 → 费用",
} as const;

const PENALTY_AFTER = "违约金排在本金之后冲抵（付款先冲本金，违约金另行主张）：民法典第五百六十一条列的是实现债权的有关费用、利息、主债务，没有列违约金，违约金是否当然按利息的顺序优先于本金冲抵，实务有争议，本口径不当然适用";
const PENALTY_AS_INTEREST = "违约金与利息同序、先于本金冲抵：这是有争议的口径——民法典第五百六十一条没有列违约金，违约金是否当然适用该顺序实务有争议，采用前应有当事人约定或其他依据";

/** 合同编通则解释第六十五条（条文经法规库核对）。 */
const ART65 = "违约金调减参照：《最高人民法院关于适用〈中华人民共和国民法典〉合同编通则若干问题的解释》第六十五条第二款——约定的违约金超过造成损失的百分之三十的，人民法院一般可以认定为过分高于造成的损失。这是“一般可以认定”的参照，不是确定结论：法院以民法典第五百八十四条规定的损失为基础，兼顾合同主体、交易类型、合同的履行情况、当事人的过错程度、履约背景等因素衡量（第一款）；恶意违约的一方请求减少的，一般不予支持（第三款）；违约方主张过高的，应当承担举证责任（第六十四条第二款）";
const LOSS_NEEDS = [
  "违约造成损失的证据（民法典第五百八十四条：实际损失与可以获得的利益）：如资金占用损失的计算依据、为补救或替代采购支出的费用、转售差价、停工损失等",
  "或者确定损失的计算标准（如资金占用损失按一年期 LPR 计），按违约金的同一基数与期间测算",
];

export function calcLedger(p: LedgerParams): LedgerResult {
  if (!p || typeof p !== "object") throw new DomainError("validation", "calc.ledger 需要参数", 422);
  if (!validDay(p.as_of)) throw new DomainError("validation", "as_of（暂计截止日，含当日）格式 YYYY-MM-DD", 422);
  const yearDays = p.year_days ?? 365;
  if (yearDays !== 360 && yearDays !== 365) throw new DomainError("validation", "year_days 仅支持 360/365", 422);
  const allocation = p.allocation ?? "cost_interest_principal";
  if (!(allocation in ALLOCATION_TEXT)) throw new DomainError("validation", "allocation 须为 cost_interest_principal、principal_only 或 principal_first", 422);
  const penaltyOrder = p.penalty_order ?? "after_principal";
  if (penaltyOrder !== "after_principal" && penaltyOrder !== "as_interest") throw new DomainError("validation", "penalty_order 须为 after_principal 或 as_interest", 422);
  if (p.accrual !== undefined && p.accrual !== "interest" && p.accrual !== "penalty") throw new DomainError("validation", "accrual 须为 interest 或 penalty", 422);
  const counted = p.payment_day === "counted";
  if (p.payment_day !== undefined && p.payment_day !== "counted" && p.payment_day !== "not_counted") throw new DomainError("validation", "payment_day 须为 not_counted 或 counted", 422);
  if (!Array.isArray(p.debts) || p.debts.length === 0 || p.debts.length > 60) throw new DomainError("validation", "debts 须为 1～60 笔", 422);
  checkRate(p.rate, "顶层");
  if (hasPending(p)) throw new DomainError("validation", "有待核日期（区间）的口径须经 calcLedgerScenarios 按最早、最晚两端展开后计算", 422);
  const end = addDays(p.as_of, 1); // 不含

  const warnings: string[] = [];
  const lines: Line[] = p.debts.map((d, i) => {
    const where = `第 ${i + 1} 笔债务`;
    if (!d || typeof d.label !== "string" || !d.label.trim()) throw new DomainError("validation", `${where} 需要 label（款项名称）`, 422);
    const kind = d.kind ?? "principal";
    if (!KINDS.includes(kind)) throw new DomainError("validation", `${where} 的 kind 须为 principal、cost、interest、penalty 或 penalty_fixed`, 422);
    if (d.due_date !== undefined && d.accrue_from !== undefined) throw new DomainError("validation", `${where} 的 due_date（最后履行日，次日起算）与 accrue_from（起算日，含当日）只给一个`, 422);
    if (d.due_date !== undefined && !validDay(d.due_date)) throw new DomainError("validation", `${where} 的 due_date 格式 YYYY-MM-DD`, 422);
    if (d.accrue_from !== undefined && !validDay(d.accrue_from)) throw new DomainError("validation", `${where} 的 accrue_from 格式 YYYY-MM-DD`, 422);
    if (d.accrue_to !== undefined && !validDay(d.accrue_to)) throw new DomainError("validation", `${where} 的 accrue_to 格式 YYYY-MM-DD`, 422);
    if (d.accrual !== undefined && kind !== "principal") throw new DomainError("validation", `${where}（${d.label}）：accrual 只用于 principal（说明本金计得的是利息还是违约金）；penalty 计得的本来就是违约金`, 422);
    if (d.accrual !== undefined && d.accrual !== "interest" && d.accrual !== "penalty") throw new DomainError("validation", `${where} 的 accrual 须为 interest 或 penalty`, 422);
    checkRate(d.rate, where);
    const start = d.accrue_from ?? (d.due_date ? addDays(d.due_date, 1) : null);
    const accruing = kind === "principal" || kind === "penalty";
    const rate: LedgerRate = accruing ? (d.rate ?? p.rate ?? { kind: "none" }) : (d.rate ?? { kind: "none" });
    if (kind === "penalty" && (rate.kind === "none" || !start)) throw new DomainError("validation", `${where}（${d.label}）是违约金的计算基数：需要 rate（违约金比例）与 due_date 或 accrue_from`, 422);
    if (kind === "principal" && rate.kind !== "none" && !start) throw new DomainError("validation", `${where}（${d.label}）要计息但没有给 due_date 或 accrue_from`, 422);
    // 第 58 批（主会话）：没写 accrual、但款项名写明是违约金、滞纳金的，按违约金计（口径名不算：“口径二：先冲违约金”说的是抵充顺序）（不当作第五百六十一条的“利息”先于本金冲抵）——
    // 模型漏写 accrual 时，违约金不至于回到有争议的缺省口径；推断写进 warnings 随表交付
    const inferredPenalty = d.accrual === undefined && p.accrual === undefined && /违约金|滞纳金/.test(d.label);
    const accrual: LedgerAccrual | null = kind === "penalty" ? "penalty" : kind === "principal" && rate.kind !== "none" ? (d.accrual ?? p.accrual ?? (inferredPenalty ? "penalty" : "interest")) : null;
    // 第 61 批（真实验收 m08：这句随表交付，原先带着参数名 accrual 写进了律师看的计算表）：表里只写律师的话；按利息计的写法见工具说明
    if (inferredPenalty && accrual === "penalty") warnings.push(`“${d.label}”按款项名称计为违约金（不作为利息先于本金冲抵）`);
    if (d.accrue_to !== undefined && !accrual) throw new DomainError("validation", `${where}（${d.label}）：accrue_to 只用于计利息或违约金的款项`, 422);
    if (d.accrue_to !== undefined && start && d.accrue_to < start) throw new DomainError("validation", `${where}（${d.label}）的计至日 ${d.accrue_to} 早于起算日 ${start}`, 422);
    if (d.cap_yuan !== undefined && !accrual) throw new DomainError("validation", `${where}（${d.label}）：cap_yuan 只用于计利息或违约金的款项`, 422);
    if (kind === "penalty" && d.in_doubled_base === true) throw new DomainError("validation", `${where}（${d.label}）是违约金的计算基数，不是欠款，不能计入加倍部分债务利息的基数`, 422);
    if (start && start >= end && accrual) warnings.push(`“${d.label}”的起算日 ${start} 晚于暂计截止日 ${p.as_of}：这一笔在本口径下尚未起算，${accrual === "penalty" ? "违约金" : "利息"}为 0`);
    // V31 企业催告函一单：为了不让基数计入合计，把基数原额填成 0，表里的基数与分段对不上
    if ((kind === "principal" || kind === "penalty") && d.amount_yuan === 0) warnings.push(`“${d.label}”的金额为 0：不计利息或违约金，也不计入合计；它若是违约金的计算基数，应按实际基数填写并标为违约金计算基数`);
    const stop = d.accrue_to ? addDays(d.accrue_to, 1) : null;
    return {
      label: d.label.trim().slice(0, 60),
      kind,
      original: cents(d.amount_yuan, `${where} 的 amount_yuan`),
      out: 0n,
      paid: 0n,
      start,
      stop,
      rate,
      accrual,
      inDoubled: kind === "penalty" ? false : (d.in_doubled_base ?? kind !== "interest"),
      order: i,
      accrued: 0n,
      intPaid: 0n,
      cap: d.cap_yuan === undefined ? null : cents(d.cap_yuan, `${where} 的 cap_yuan`),
      seg: null,
    };
  });
  for (const l of lines) l.out = l.kind === "penalty" ? 0n : l.original;
  const labels = new Set<string>();
  for (const l of lines) {
    if (labels.has(l.label)) throw new DomainError("validation", `债务名称“${l.label}”重复：每笔用不同的名称`, 422);
    labels.add(l.label);
  }

  const pays = (p.payments ?? []).map((x, i) => {
    if (!x || !validDay(x.date)) throw new DomainError("validation", `第 ${i + 1} 笔付款的 date 格式 YYYY-MM-DD`, 422);
    const amount = cents(x.amount_yuan, `第 ${i + 1} 笔付款的 amount_yuan`);
    if (amount === 0n) throw new DomainError("validation", `第 ${i + 1} 笔付款金额为 0`, 422);
    return { date: x.date, amount, note: typeof x.note === "string" ? x.note.slice(0, 120) : "", order: i };
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
  let dSeg: { from: string; base: bigint } | null = null;

  // 时间轴上的分界点：各笔起算日与计至日次日、付款生效日、LPR 报价日、截止日次日（只用来推进时间；每笔款项只在自己的基数或利率变化时分段）
  const payAt = (x: { date: string }) => (counted ? addDays(x.date, 1) : x.date);
  const cuts = new Set<string>([end]);
  for (const l of lines) {
    if (!l.accrual) continue;
    if (l.start && l.start < end) cuts.add(l.start);
    if (l.stop && l.stop < end) cuts.add(l.stop);
  }
  if (doubledStart && doubledStart < end) cuts.add(doubledStart);
  for (const x of usable) cuts.add(payAt(x));
  const usesLpr = lines.some((l) => l.accrual && (l.rate.kind === "lpr_plus" || l.rate.kind === "lpr_times"));
  const firstStart = [...lines.filter((l) => l.accrual).map((l) => l.start).filter((s): s is string => !!s), ...(doubledStart ? [doubledStart] : [])].sort()[0] ?? end;
  if (usesLpr) for (const row of LPR_1Y) if (row.effective > firstStart && row.effective < end) cuts.add(row.effective);
  const points = [...cuts].filter((c) => c <= end).sort();

  const byStart = (a: Line, b: Line) => ((a.start ?? "9999") < (b.start ?? "9999") ? -1 : (a.start ?? "9999") > (b.start ?? "9999") ? 1 : a.order - b.order);
  const tier = (kind: LedgerDebtKind) => lines.filter((l) => l.kind === kind).sort(byStart);
  const accruing = (as: LedgerAccrual) => lines.filter((l) => l.accrual === as).sort(byStart);
  const baseOf = (l: Line) => (l.kind === "penalty" ? l.original : l.out);
  const provisional = (l: Line, at: string) => (l.seg ? divRound(l.seg.base * l.seg.r.num * BigInt(daysBetween(l.seg.from, at)), l.seg.r.den) : 0n);
  /** 到 at 为止计得、尚未冲抵的利息或违约金（受这一笔的上限约束）。 */
  const payable = (l: Line, at: string) => {
    const o = min(l.accrued + provisional(l, at), l.cap) - l.intPaid;
    return o > 0n ? o : 0n;
  };
  const principalOut = () => lines.filter((l) => l.kind === "principal").reduce((n, l) => n + l.out, 0n);
  const unpaidOf = (as: LedgerAccrual, at: string) => lines.reduce((n, l) => n + (l.kind === (as === "interest" ? "interest" : "penalty_fixed") ? l.out : 0n) + (l.accrual === as ? payable(l, at) : 0n), 0n);

  const segs: (LedgerSegment & { _order: number })[] = [];
  const paymentRows: LedgerPaymentRow[] = [];
  let unallocated = 0n;
  const cap = p.cap_yuan === undefined ? null : cents(p.cap_yuan, "cap_yuan");
  const capOn: LedgerAccrual = lines.some((l) => l.accrual === "penalty") || lines.some((l) => l.kind === "penalty_fixed") ? "penalty" : "interest";
  let capReachedOn: string | null = null;
  let capRunning = 0; // 分，按日均摊的累计（只用来推到具体哪一天）
  let lastDaily = 0;

  const close = (l: Line, at: string) => {
    const s = l.seg!;
    const days = daysBetween(s.from, at);
    const amount = divRound(s.base * s.r.num * BigInt(days), s.r.den);
    l.accrued += amount;
    segs.push({ item: l.label, kind: l.accrual!, from: s.from, to: addDays(at, -1), days, base_yuan: yuan(s.base), rate_text: s.r.text, daily_rate: s.r.daily, formula: `${fmt(s.base)} × ${s.r.text} × ${days} 日`, amount_yuan: yuan(amount), _order: l.order });
    l.seg = null;
  };
  const closeDoubled = (at: string) => {
    const s = dSeg!;
    const days = daysBetween(s.from, at);
    const amount = divRound(s.base * doubledRate!.num * BigInt(days), doubledRate!.den);
    doubledAccrued += amount;
    segs.push({ item: "加倍部分债务利息", kind: "doubled", from: s.from, to: addDays(at, -1), days, base_yuan: yuan(s.base), rate_text: doubledRate!.text, daily_rate: doubledRate!.daily, formula: `${fmt(s.base)} × ${doubledRate!.text} × ${days} 日`, amount_yuan: yuan(amount), _order: Number.MAX_SAFE_INTEGER });
    dSeg = null;
  };

  const applyPayments = (at: string) => {
    for (const x of usable) {
      if (payAt(x) !== at) continue;
      let left = x.amount;
      const row = { cost: 0n, interest: 0n, principal: 0n, penalty: 0n, doubled: 0n };
      const parts: string[] = [];
      const take = (avail: bigint): bigint => {
        const t = avail < left ? avail : left;
        left -= t;
        return t;
      };
      const payFixed = (kind: LedgerDebtKind, into: "cost" | "interest" | "penalty") => {
        for (const l of tier(kind)) {
          const t = take(l.out);
          if (t > 0n) {
            l.out -= t;
            l.paid += t;
            row[into] += t;
            parts.push(`${l.label} ${fmt(t)}`);
          }
        }
      };
      const payAccrued = (as: LedgerAccrual) => {
        for (const l of accruing(as)) {
          const t = take(payable(l, at));
          if (t > 0n) {
            l.intPaid += t;
            row[as] += t;
            parts.push(`${l.label}的${as === "penalty" ? "违约金" : "利息"} ${fmt(t)}`);
          }
        }
      };
      const payInterest = () => {
        payFixed("interest", "interest");
        payAccrued("interest");
        if (penaltyOrder === "as_interest") payPenalty();
      };
      const payPenalty = () => {
        payFixed("penalty_fixed", "penalty");
        payAccrued("penalty");
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
        const t = take(doubledAccrued + (dSeg ? divRound(dSeg.base * doubledRate!.num * BigInt(daysBetween(dSeg.from, at)), doubledRate!.den) : 0n) - doubledPaid);
        if (t > 0n) {
          doubledPaid += t;
          row.doubled += t;
          parts.push(`加倍部分债务利息 ${fmt(t)}`);
        }
      };
      if (allocation === "cost_interest_principal") {
        payFixed("cost", "cost");
        payInterest();
        payPrincipal();
        if (penaltyOrder === "after_principal") payPenalty();
        payDoubled();
      } else if (allocation === "principal_first") {
        payPrincipal();
        payInterest();
        if (penaltyOrder === "after_principal") payPenalty();
        payFixed("cost", "cost");
        payDoubled();
      } else {
        payPrincipal();
      }
      if (left > 0n) {
        unallocated += left;
        warnings.push(
          allocation === "principal_only"
            ? `${x.date} 的付款 ${fmt(x.amount)} 元冲完全部本金后还多 ${fmt(left)} 元：只冲本金的口径下没有再冲利息或违约金，多出的部分单列，由律师决定怎么处理`
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
        to_penalty_yuan: yuan(row.penalty),
        to_doubled_yuan: yuan(row.doubled),
        unallocated_yuan: yuan(left),
        principal_after_yuan: yuan(principalOut()),
        interest_unpaid_after_yuan: yuan(unpaidOf("interest", at)),
        penalty_unpaid_after_yuan: yuan(unpaidOf("penalty", at)),
        detail: parts.join("；") || "（没有可冲的款项）",
      });
    }
  };

  // 按时间顺序推进：每个分界点先冲当天生效的付款，再看每笔款项的基数或利率变没变——变了才结束这一段、另起一段
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    applyPayments(a);
    const atEnd = a >= end;
    for (const l of lines) {
      if (!l.accrual) continue;
      const active = !atEnd && !!l.start && l.start <= a && (l.stop === null || a < l.stop) && baseOf(l) > 0n;
      const r = active ? rateAt(l.rate, a, yearDays)! : null;
      if (l.seg && (!r || l.seg.base !== baseOf(l) || l.seg.r.text !== r.text)) close(l, a);
      if (r && !l.seg) l.seg = { from: a, base: baseOf(l), r };
    }
    if (doubledRate && doubledStart) {
      const base = lines.filter((l) => l.inDoubled).reduce((n, l) => n + l.out, 0n);
      const active = !atEnd && doubledStart <= a && base > 0n;
      if (dSeg && (!active || dSeg.base !== base)) closeDoubled(a);
      if (active && !dSeg) dSeg = { from: a, base };
    }
    const b = points[i + 1];
    if (!b) break;
    // 约定上限在哪一天达到：按日均摊推到具体日期
    const days = daysBetween(a, b);
    const daily = lines.reduce((n, l) => n + (l.seg && l.accrual === capOn ? (Number(l.seg.base) * Number(l.seg.r.num)) / Number(l.seg.r.den) : 0), 0);
    lastDaily = daily;
    if (cap !== null && capReachedOn === null && daily > 0 && capRunning + daily * days >= Number(cap)) {
      capReachedOn = addDays(a, Math.min(days - 1, Math.max(0, Math.ceil((Number(cap) - capRunning) / daily) - 1)));
    }
    capRunning += daily * days;
  }
  const segments: LedgerSegment[] = segs
    .sort((x, y) => x._order - y._order || (x.from < y.from ? -1 : x.from > y.from ? 1 : 0))
    .map(({ _order, ...s }) => s);

  // 汇总与勾稽
  const sum = (f: (l: Line) => bigint, pick: (l: Line) => boolean) => lines.filter(pick).reduce((n, l) => n + f(l), 0n);
  const claimOf = (l: Line) => min(l.accrued, l.cap);
  const acc = {
    interest: sum(claimOf, (l) => l.accrual === "interest"),
    penalty: sum(claimOf, (l) => l.accrual === "penalty"),
  };
  let capInfo: LedgerResult["cap"] = null;
  const claim = { ...acc };
  if (cap !== null) {
    const accrued = acc[capOn];
    const applied = accrued > cap;
    if (applied) claim[capOn] = cap;
    let reached = capReachedOn;
    let projected = false;
    if (!applied && accrued < cap) {
      // 按截止日当天的日累计额往后推
      if (lastDaily > 0) {
        reached = addDays(p.as_of, Math.ceil(Number(cap - accrued) / lastDaily));
        projected = true;
      } else reached = null;
    }
    capInfo = { cap_yuan: yuan(cap), applies_to: capOn === "penalty" ? "违约金" : "利息", accrued_yuan: yuan(accrued), applied, reached_on: reached, projected };
  }
  const fixed = { interest: sum((l) => l.original, (l) => l.kind === "interest"), penalty: sum((l) => l.original, (l) => l.kind === "penalty_fixed") };
  const paidOf = (as: LedgerAccrual) => sum((l) => l.paid, (l) => l.kind === (as === "interest" ? "interest" : "penalty_fixed")) + sum((l) => l.intPaid, (l) => l.accrual === as);
  const paid = { interest: paidOf("interest"), penalty: paidOf("penalty") };
  const outstandingOf = (as: LedgerAccrual) => {
    const o = fixed[as] + claim[as] - paid[as];
    return o < 0n ? 0n : o;
  };
  const outstanding = { interest: outstandingOf("interest"), penalty: outstandingOf("penalty") };
  const isKind = (k: LedgerDebtKind) => (l: Line) => l.kind === k;
  const totals = {
    principal_original: sum((l) => l.original, isKind("principal")),
    principal_paid: sum((l) => l.paid, isKind("principal")),
    principal_outstanding: sum((l) => l.out, isKind("principal")),
    cost_original: sum((l) => l.original, isKind("cost")),
    cost_paid: sum((l) => l.paid, isKind("cost")),
    cost_outstanding: sum((l) => l.out, isKind("cost")),
    payments_total: usable.reduce((n, x) => n + x.amount, 0n),
  };
  // 勾稽：付款合计 = 冲费用 + 冲利息 + 冲违约金 + 冲本金 + 冲加倍利息 + 未冲
  const allocated = totals.cost_paid + paid.interest + paid.penalty + totals.principal_paid + doubledPaid + unallocated;
  if (allocated !== totals.payments_total) throw new DomainError("internal", "calc.ledger 内部勾稽不平（付款合计与各项抵充之和不等），未出结果", 500);
  const doubledOutstanding = doubledAccrued - doubledPaid;
  const totalOutstanding = totals.principal_outstanding + outstanding.interest + outstanding.penalty + totals.cost_outstanding + doubledOutstanding;
  // 履行期未届满的本金（起算日在暂计截止日之后）：利息、违约金在本口径下为 0，只把本金余额拆出来
  const notDueLines = lines.filter((l) => l.kind === "principal" && l.start !== null && l.start >= end && l.out > 0n);
  const principalNotDue = notDueLines.reduce((n, l) => n + l.out, 0n);

  if (usesLpr && p.as_of > LPR_CHECKED_THROUGH) warnings.push(`${LPR_CHECKED_THROUGH} 之后的 LPR 报价没有收录，这之后按最后一次报价计：请到全国银行间同业拆借中心核对后再定稿`);

  // 违约金调减参照（第六十五条）
  const penaltyTotal = fixed.penalty + claim.penalty;
  let penaltyCheck: LedgerPenaltyCheckResult | null = null;
  const hasPenalty = lines.some((l) => l.accrual === "penalty" || l.kind === "penalty_fixed");
  if (p.penalty_check !== undefined && (!p.penalty_check || typeof p.penalty_check !== "object")) throw new DomainError("validation", "penalty_check 格式不对", 422);
  const pc = p.penalty_check ?? {};
  if (pc.loss_yuan !== undefined && pc.loss_rate !== undefined) throw new DomainError("validation", "penalty_check 的 loss_yuan（损失数额）与 loss_rate（损失的计算标准）只给一个", 422);
  if (hasPenalty) {
    let loss: bigint | null = null;
    let compared = penaltyTotal;
    let basis = typeof pc.loss_basis === "string" && pc.loss_basis.trim() ? pc.loss_basis.trim().slice(0, 200) : null;
    if (pc.loss_yuan !== undefined) loss = cents(pc.loss_yuan, "penalty_check.loss_yuan");
    else if (pc.loss_rate !== undefined) {
      checkRate(pc.loss_rate, "penalty_check");
      if (pc.loss_rate.kind === "none") throw new DomainError("validation", "penalty_check.loss_rate 不能是 none", 422);
      const { cap_yuan: _cap, penalty_check: _pc, ...rest } = p;
      const altDebts = p.debts.map((d): LedgerDebt => {
        const k = d.kind ?? "principal";
        if (!(k === "penalty" || (k === "principal" && (d.accrual ?? p.accrual) === "penalty"))) return d;
        const { cap_yuan: _c, ...dr } = d;
        return { ...dr, rate: pc.loss_rate! };
      });
      const alt = calcLedger({ ...rest, debts: altDebts });
      loss = cents(alt.totals.penalty_accrued_yuan, "loss");
      compared = claim.penalty;
      basis = `按${rateLabel(pc.loss_rate)}对违约金的同一基数与期间计算${basis ? `；${basis}` : ""}${fixed.penalty > 0n ? "；已确定数额的违约金不在比较之内" : ""}`;
    }
    if (loss === null) {
      penaltyCheck = { penalty_yuan: yuan(penaltyTotal), loss_yuan: null, loss_basis: null, reference_yuan: null, exceeds: null, conclusion: `违约金 ${fmt(penaltyTotal)} 元：没有损失数额，未测算调减参照`, needs: LOSS_NEEDS };
    } else {
      const ref = divRound(loss * 13n, 10n);
      const exceeds = compared > ref;
      penaltyCheck = {
        penalty_yuan: yuan(compared),
        loss_yuan: yuan(loss),
        loss_basis: basis,
        reference_yuan: yuan(ref),
        exceeds,
        conclusion: exceeds
          ? `违约金 ${fmt(compared)} 元超过损失 ${fmt(loss)} 元的 130%（${fmt(ref)} 元）：对方请求调减的，按第六十五条第二款一般可以认定为过分高于造成的损失，存在被调减的风险（参照，不是确定结论）`
          : `违约金 ${fmt(compared)} 元未超过损失 ${fmt(loss)} 元的 130%（${fmt(ref)} 元）：按第六十五条第二款的参照，一般不认定为过分高于造成的损失`,
        needs: [],
      };
    }
  }

  const T: LedgerTotals = {
    principal_original_yuan: yuan(totals.principal_original),
    principal_paid_yuan: yuan(totals.principal_paid),
    principal_outstanding_yuan: yuan(totals.principal_outstanding),
    interest_fixed_yuan: yuan(fixed.interest),
    interest_accrued_yuan: yuan(claim.interest),
    interest_paid_yuan: yuan(paid.interest),
    interest_outstanding_yuan: yuan(outstanding.interest),
    penalty_base_yuan: yuan(sum((l) => l.original, isKind("penalty"))),
    penalty_fixed_yuan: yuan(fixed.penalty),
    penalty_accrued_yuan: yuan(claim.penalty),
    penalty_paid_yuan: yuan(paid.penalty),
    penalty_outstanding_yuan: yuan(outstanding.penalty),
    cost_original_yuan: yuan(totals.cost_original),
    cost_paid_yuan: yuan(totals.cost_paid),
    cost_outstanding_yuan: yuan(totals.cost_outstanding),
    doubled_accrued_yuan: yuan(doubledAccrued),
    doubled_paid_yuan: yuan(doubledPaid),
    doubled_outstanding_yuan: yuan(doubledOutstanding),
    payments_total_yuan: yuan(totals.payments_total),
    unallocated_yuan: yuan(unallocated),
    total_outstanding_yuan: yuan(totalOutstanding),
    principal_not_due_yuan: yuan(principalNotDue),
    total_due_outstanding_yuan: yuan(totalOutstanding - principalNotDue),
  };
  const name = (typeof p.name === "string" && p.name.trim() ? p.name.trim() : "测算").slice(0, 40);
  const pieces: string[] = [];
  const hasInterest = lines.some((l) => l.accrual === "interest" || l.kind === "interest");
  if (totals.principal_original > 0n || (!hasInterest && !hasPenalty && totals.cost_original === 0n)) pieces.push(`本金余额 ${fmt(totals.principal_outstanding)} 元`);
  const piece = (as: LedgerAccrual, word: string) => {
    const total = fixed[as] + claim[as];
    const capped = capInfo?.applied && capOn === as;
    pieces.push(`${word}未付 ${fmt(outstanding[as])} 元（累计 ${fmt(total)} 元${paid[as] > 0n ? `，已冲 ${fmt(paid[as])} 元` : ""}${capped ? `，已按约定上限 ${fmt(cap!)} 元计` : ""}）`);
  };
  if (hasInterest && fixed.interest + acc.interest > 0n) piece("interest", "利息");
  if (hasPenalty) piece("penalty", "违约金");
  if (totals.cost_original > 0n) pieces.push(`费用未付 ${fmt(totals.cost_outstanding)} 元`);
  if (doubledRate) pieces.push(`加倍部分债务利息未付 ${fmt(doubledOutstanding)} 元`);
  const notDueText = principalNotDue > 0n ? `；其中履行期尚未届满的本金 ${fmt(principalNotDue)} 元（${notDueLines.map((l) => l.label).join("、").slice(0, 80)}），已届满部分合计 ${fmt(totalOutstanding - principalNotDue)} 元` : "";
  const summary = `${name}：截至 ${p.as_of}（含当日），${pieces.join("，")}，合计 ${fmt(totalOutstanding)} 元${notDueText}。`;
  if (principalNotDue > 0n) warnings.push(`未清偿合计里有履行期尚未届满的本金 ${fmt(principalNotDue)} 元（${notDueLines.map((l) => l.label).join("、").slice(0, 80)}）：起诉、申请仲裁或保全的请求金额一般以已届满部分（${fmt(totalOutstanding - principalNotDue)} 元）为准；要一并主张未届满部分的，须有约定的加速到期或解除等依据，并写明这一前提`);

  const anyPenaltyLike = hasPenalty && allocation !== "principal_only" && usable.length > 0;
  const lineCaps = lines.filter((l) => l.cap !== null);
  const assumptions = [
    `暂计截止日 ${p.as_of}，含当日`,
    "起算：按最后履行日给的，自次日起算；按起算日给的，含当日",
    ...(lines.some((l) => l.stop) ? ["计至日：写明计至日的计到该日（含当日）为止"] : []),
    ...(usable.length > 0 ? [counted ? "付款当日：仍按付款前的余额计，次日起按付款后的余额计" : "付款当日：不计（当日起按付款后的余额计）", `抵充顺序：${ALLOCATION_TEXT[allocation]}`] : []),
    ...(anyPenaltyLike ? [penaltyOrder === "as_interest" ? PENALTY_AS_INTEREST : PENALTY_AFTER] : []),
    ...(lines.some((l) => l.kind === "penalty") ? ["违约金计算基数（如逾期交付货物的价款）只用来计违约金，本身不是欠款，不计入未清偿合计、不参与抵充"] : []),
    "分段：每笔款项只在自己的计算基数或利率变化时分段，其他款项的起算、付款不切开这一笔",
    "舍入：每段四舍五入到分，合计为各段之和",
    ...(usesLpr ? [`LPR 为一年期公开报价，按报价生效日分段，核至 ${LPR_CHECKED_THROUGH}`] : []),
    ...(lines.some((l) => l.accrual && (l.rate.kind === "fixed" || l.rate.kind === "lpr_plus" || l.rate.kind === "lpr_times")) ? [`年利率折算到日按年 ${yearDays} 日`] : []),
    ...(doubledRate ? [`加倍部分债务利息：基数为${lines.filter((l) => l.inDoubled).map((l) => l.label).join("、") || "（无）"}的未清偿部分，${doubledRate.text}，自 ${doubledStart} 起（含当日）；清偿时排在生效法律文书确定的金钱债务之后`] : []),
    ...(cap !== null ? [`${capOn === "penalty" ? "违约金" : "利息"}约定上限 ${fmt(cap)} 元：累计超过的按上限计`] : []),
    ...lineCaps.map((l) => `“${l.label}”的${l.accrual === "penalty" ? "违约金" : "利息"}约定上限 ${fmt(l.cap!)} 元：${l.accrued > l.cap! ? `累计 ${fmt(l.accrued)} 元已超过，按上限计` : "尚未达到"}`),
    ...(penaltyCheck ? [ART65] : []),
  ];

  return {
    name,
    premise: typeof p.premise === "string" && p.premise.trim() ? p.premise.trim().slice(0, 300) : null,
    as_of: p.as_of,
    segments,
    payments: paymentRows,
    per_debt: lines.map((l) => ({
      label: l.label,
      kind: l.kind,
      accrued_as: l.accrual === "penalty" ? "违约金" : l.accrual === "interest" ? "利息" : null,
      original_yuan: yuan(l.original),
      paid_yuan: yuan(l.paid),
      outstanding_yuan: yuan(l.out),
      interest_accrued_yuan: yuan(claimOf(l)),
      interest_paid_yuan: yuan(l.intPaid),
      interest_outstanding_yuan: yuan(claimOf(l) - l.intPaid > 0n ? claimOf(l) - l.intPaid : 0n),
      accrue_from: l.start,
      accrue_to: l.stop ? addDays(l.stop, -1) : null,
    })),
    totals: T,
    cap: capInfo,
    penalty_check: penaltyCheck,
    pending_dates: null,
    summary,
    assumptions,
    warnings,
  };
}

// ---- 待核日期：按最早、最晚两端展开 ----

function hasPending(p: LedgerParams): boolean {
  return (p.payments ?? []).some((x) => x && x.date_range !== undefined) || p.debts.some((d) => d && (d.due_date_range !== undefined || d.accrue_from_range !== undefined));
}

function checkRange(r: unknown, where: string): LedgerDateRange {
  const x = r as LedgerDateRange;
  if (!x || typeof x !== "object" || !validDay(x.earliest) || !validDay(x.latest)) throw new DomainError("validation", `${where}：区间写 earliest（最早）与 latest（最晚），格式 YYYY-MM-DD`, 422);
  if (x.earliest >= x.latest) throw new DomainError("validation", `${where}：earliest 须早于 latest（同一天的直接写确定日期）`, 422);
  return x;
}

/** 有待核日期的口径展开成“按最早”“按最晚”两个确定口径；没有的返回 null。 */
export function expandPendingDates(p: LedgerParams): { ends: [LedgerParams, LedgerParams]; items: string[] } | null {
  if (!p || typeof p !== "object" || !Array.isArray(p.debts) || !hasPending(p)) return null;
  const items: string[] = [];
  const debts = (pick: "earliest" | "latest") =>
    p.debts.map((d, i) => {
      if (d.due_date_range === undefined && d.accrue_from_range === undefined) return d;
      const where = `第 ${i + 1} 笔债务（${d.label}）`;
      if (d.due_date_range !== undefined && d.accrue_from_range !== undefined) throw new DomainError("validation", `${where}：due_date_range 与 accrue_from_range 只给一个`, 422);
      if (d.due_date !== undefined || d.accrue_from !== undefined) throw new DomainError("validation", `${where}：给了日期区间就不再写 due_date 或 accrue_from`, 422);
      const { due_date_range, accrue_from_range, ...rest } = d;
      const r = checkRange(due_date_range ?? accrue_from_range, where);
      if (pick === "earliest") items.push(`“${d.label}”的${due_date_range ? "最后履行日" : "起算日"}（待核：最早 ${r.earliest}，最晚 ${r.latest}${r.note ? `；${String(r.note).slice(0, 60)}` : ""}）`);
      return due_date_range ? { ...rest, due_date: r[pick] } : { ...rest, accrue_from: r[pick] };
    });
  const payments = (pick: "earliest" | "latest") =>
    (p.payments ?? []).map((x, i) => {
      if (!x || x.date_range === undefined) return x;
      const where = `第 ${i + 1} 笔付款`;
      if (x.date !== undefined) throw new DomainError("validation", `${where}：date 与 date_range 只给一个`, 422);
      const r = checkRange(x.date_range, where);
      const amount = typeof x.amount_yuan === "number" ? x.amount_yuan.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(x.amount_yuan);
      if (pick === "earliest") items.push(`${amount} 元付款的日期（待核：最早 ${r.earliest}，最晚 ${r.latest}${r.note ? `；${String(r.note).slice(0, 60)}` : ""}）`);
      const { date_range, ...rest } = x;
      const tag = `日期待核（${r.earliest}～${r.latest}），本口径按${pick === "earliest" ? "最早" : "最晚"}日计`;
      return { ...rest, date: r[pick], note: x.note ? `${x.note}；${tag}` : tag };
    });
  const e = { ...p, debts: debts("earliest"), payments: payments("earliest") };
  const l = { ...p, debts: debts("latest"), payments: payments("latest") };
  return { ends: [e, l], items };
}

/** 两端对照：另一端没有完全相同的一段，就标为依赖待核日期。 */
function markPending(a: LedgerResult, b: LedgerResult, items: string[]): void {
  const key = (s: LedgerSegment) => [s.item, s.kind, s.from, s.to, s.base_yuan, s.rate_text, s.amount_yuan].join("|");
  const ka = new Set(a.segments.map(key));
  const kb = new Set(b.segments.map(key));
  for (const s of a.segments) if (!kb.has(key(s))) s.pending = true;
  for (const s of b.segments) if (!ka.has(key(s))) s.pending = true;
  const note = (self: LedgerResult, end: "earliest" | "latest", other: LedgerResult) => {
    const dep = self.segments.filter((s) => s.pending).length;
    self.pending_dates = { end, items, dependent_segments: dep, other_name: other.name, other_total_outstanding_yuan: other.totals.total_outstanding_yuan };
    self.assumptions.push(`待核日期：${items.join("；")}。本口径一律按${end === "earliest" ? "最早" : "最晚"}日计，并列的“${other.name}”按${end === "earliest" ? "最晚" : "最早"}日计；两端完全相同的分段是确定的，其余 ${dep} 段标“依赖待核日期”，核实日期后按实际日期重算`);
  };
  note(a, "earliest", b);
  note(b, "latest", a);
}

/** 展开待核日期后最多几个口径（每个口径一列、两张表）。 */
export const LEDGER_MAX_EXPANDED = 6;

/**
 * 一次算几个口径（工具入口与用例共用）：缺省口径名；有待核日期的口径按最早、最晚各算一个并列，标出依赖待核日期的分段。
 * 返回的 params 与 results 一一对应（展开后的确定口径）。
 */
export function calcLedgerScenarios(list: LedgerParams[], maxScenarios = 4): { params: LedgerParams[]; results: LedgerResult[] } {
  const scenarios = Array.isArray(list) ? list : [];
  if (scenarios.length === 0 || scenarios.length > maxScenarios) throw new DomainError("validation", `scenarios 须为 1～${maxScenarios} 个口径`, 422);
  const params: LedgerParams[] = [];
  const results: LedgerResult[] = [];
  scenarios.forEach((s, i) => {
    const name = typeof s?.name === "string" && s.name.trim() ? s.name.trim() : scenarios.length > 1 ? `口径${i + 1}` : "测算";
    try {
      const ex = expandPendingDates(s);
      if (!ex) {
        const q = { ...s, name };
        params.push(q);
        results.push(calcLedger(q));
        return;
      }
      const base = name.slice(0, 28);
      const pe = { ...ex.ends[0], name: `${base}（待核日期按最早）` };
      const pl = { ...ex.ends[1], name: `${base}（待核日期按最晚）` };
      const re = calcLedger(pe);
      const rl = calcLedger(pl);
      markPending(re, rl, ex.items);
      params.push(pe, pl);
      results.push(re, rl);
    } catch (e) {
      if (e instanceof DomainError && scenarios.length > 1) throw new DomainError("validation", `第 ${i + 1} 个口径：${e.message}`, 422);
      throw e;
    }
  });
  if (results.length > LEDGER_MAX_EXPANDED) throw new DomainError("validation", `有待核日期的口径按最早、最晚各算一个，展开后共 ${results.length} 个口径，超过 ${LEDGER_MAX_EXPANDED} 个：减少并列口径`, 422);
  const names = new Set(results.map((r) => r.name));
  if (names.size !== results.length) throw new DomainError("validation", "各口径的 name 不能相同", 422);
  return { params, results };
}
