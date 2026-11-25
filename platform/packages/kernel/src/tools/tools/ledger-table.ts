/**
 * calc.ledger 的工具入口（第 57 批，D-228；第 58 批改成表）：一次调用算一到四个口径；给了 title 就把结果直接写成《计算明细》类 Excel 并登记为本任务成果。
 * 表里的数字由内核从计算结果直接写入，模型不经手、不转抄——第 56 批真实运行里，抵充、余额、各口径合计都是模型心算后手敲进 xlsx.render_table 的。
 *
 * 第 58 批（V31 全量验收的评分）：
 * - 汇总的累计、已冲、已付合计、余额、未清偿合计全部引用分段表与付款表（公式）；日期是日期格；日数 = 止日 − 起日 + 1；
 *   截止日落在暂计截止日的末段引用汇总表的“暂计截止日”——律师改截止日，末段日数、金额、汇总跟着重算。
 * - 只出本案用到的行与列：没有付款不出付款表，没有计息期间不出分段表，全为 0 的抵充列不出；违约金与利息分开写，不再一律写“利息（违约金）”。
 * - “参数与假设”里各口径相同的计算口径只写一次（“全部口径”）。
 */
import { DomainError } from "@zr-legal/domain";
import { excelSerial, type SheetSpec } from "@zr-legal/docx-engine";
import type { InvokeCtx } from "../registry.ts";
import { calcLedgerScenarios, rateLabel, type LedgerParams, type LedgerResult } from "./ledger.ts";
import { finishTable } from "./review.ts";

export const LEDGER_MAX_SCENARIOS = 4;
const MAX_NOTE_ROWS = 200;
const MAX_EXTRA_SHEETS = 3;
const SUMMARY = "汇总";

type Cell = string | number | null;

const col = (i: number): string => {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};
const quote = (n: string) => `'${n.replace(/'/g, "''")}'`;
const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toCents = (n: number) => Math.round(n * 100);
const KIND_LABEL = { interest: "利息", penalty: "违约金", doubled: "加倍部分债务利息" } as const;
const hasInterest = (r: LedgerResult) => r.per_debt.some((d) => d.kind === "interest" || d.accrued_as === "利息");
const hasPenalty = (r: LedgerResult) => r.per_debt.some((d) => d.kind === "penalty_fixed" || d.accrued_as === "违约金");

/** 分段计算表：日期格、日数公式、金额 = 基数 × 利率 × 日数（年利率的再除以年日数）；末行合计。 */
function segmentSheet(name: string, r: LedgerResult, yearDays: number, asOfRef: string): SheetSpec {
  const pendingAny = r.segments.some((s) => s.pending);
  const header = ["序号", "款项", "类别", "起算日（含）", "截止日（含）", "日数", "计算基数（元）", "利率数值", "利率口径", "金额（元）", ...(pendingAny ? ["说明"] : [])];
  const rows: Cell[][] = [header];
  const formulas: Record<string, string> = {};
  const dates: string[] = [];
  r.segments.forEach((s, i) => {
    const row = i + 2;
    const annual = !/^日万分之/.test(s.rate_text);
    const rateValue = annual ? Number((s.daily_rate * yearDays).toFixed(10)) : s.daily_rate;
    rows.push([i + 1, s.item, KIND_LABEL[s.kind], excelSerial(s.from), excelSerial(s.to), s.days, s.base_yuan, rateValue, s.rate_text, s.amount_yuan, ...(pendingAny ? [s.pending ? "依赖待核日期" : null] : [])]);
    dates.push(`D${row}`, `E${row}`);
    formulas[`F${row}`] = `E${row}-D${row}+1`;
    if (s.to === r.as_of) formulas[`E${row}`] = asOfRef;
    // 公式只在浮点重算与精确结果一致时才写（极少数恰好落在半分上的不写公式，保留算好的数）
    const float = Math.round((annual ? (s.base_yuan * rateValue * s.days) / yearDays : s.base_yuan * rateValue * s.days) * 100 + 1e-7) / 100;
    if (Math.abs(float - s.amount_yuan) < 0.005) formulas[`J${row}`] = annual ? `ROUND(G${row}*H${row}*F${row}/${yearDays},2)` : `ROUND(G${row}*H${row}*F${row},2)`;
  });
  const last = r.segments.length + 1;
  rows.push(["合计", null, null, null, null, null, null, null, null, r.segments.reduce((n, s) => n + toCents(s.amount_yuan), 0) / 100]);
  formulas[`J${last + 1}`] = `SUM(J2:J${last})`;
  return { name, rows, formulas, dates };
}

interface PayRef {
  name: string;
  totalRow: number;
  colOf: Record<string, string>;
}

/** 付款与抵扣表：只出本口径用到的抵充列；抵扣后本金余额 = 本金原额 − 累计冲本金（公式）。 */
function paymentSheet(name: string, r: LedgerResult, p0Ref: string | null): { spec: SheetSpec; ref: PayRef } {
  type Row = LedgerResult["payments"][number];
  type Col = { key: string; title: string; pick: (x: Row) => Cell; sum?: true };
  const nz = (f: (x: Row) => number) => r.payments.some((x) => f(x) !== 0);
  const alloc: [string, string, (x: Row) => number][] = [
    ["cost", "冲费用", (x) => x.to_cost_yuan],
    ["interest", "冲利息", (x) => x.to_interest_yuan],
    ["principal", "冲本金", (x) => x.to_principal_yuan],
    ["penalty", "冲违约金", (x) => x.to_penalty_yuan],
    ["doubled", "冲加倍部分债务利息", (x) => x.to_doubled_yuan],
    ["free", "未冲（多付）", (x) => x.unallocated_yuan],
  ];
  const cols: Col[] = [
    { key: "date", title: "付款日", pick: (x) => excelSerial(x.date) },
    { key: "amount", title: "付款金额（元）", pick: (x) => x.amount_yuan, sum: true },
    ...alloc.filter(([, , f]) => nz(f)).map(([key, title, f]): Col => ({ key, title, pick: f, sum: true })),
    ...(r.totals.principal_original_yuan > 0 ? [{ key: "p_after", title: "抵扣后本金余额", pick: (x: Row) => x.principal_after_yuan }] : []),
    ...(hasInterest(r) ? [{ key: "i_after", title: "抵扣后未付利息", pick: (x: Row) => x.interest_unpaid_after_yuan }] : []),
    ...(hasPenalty(r) ? [{ key: "n_after", title: "抵扣后未付违约金", pick: (x: Row) => x.penalty_unpaid_after_yuan }] : []),
    { key: "detail", title: "抵充明细", pick: (x) => x.detail },
    ...(r.payments.some((x) => x.note) ? [{ key: "note", title: "备注", pick: (x: Row) => x.note || null }] : []),
  ];
  const colOf: Record<string, string> = {};
  cols.forEach((c, i) => (colOf[c.key] = col(i + 1)));
  const rows: Cell[][] = [["序号", ...cols.map((c) => c.title)]];
  const formulas: Record<string, string> = {};
  const dates: string[] = [];
  r.payments.forEach((x, i) => {
    const row = i + 2;
    rows.push([i + 1, ...cols.map((c) => c.pick(x))]);
    dates.push(`${colOf.date}${row}`);
    if (p0Ref && colOf.p_after && colOf.principal) formulas[`${colOf.p_after}${row}`] = `${p0Ref}-SUM(${colOf.principal}$2:${colOf.principal}${row})`;
  });
  const last = r.payments.length + 1;
  const totalRow = last + 1;
  rows.push(["合计", ...cols.map((c): Cell => (c.sum ? r.payments.reduce((n, x) => n + toCents(Number(c.pick(x))), 0) / 100 : null))]);
  for (const c of cols) if (c.sum) formulas[`${colOf[c.key]}${totalRow}`] = `SUM(${colOf[c.key]}2:${colOf[c.key]}${last})`;
  return { spec: { name, rows, formulas, dates }, ref: { name, totalRow, colOf } };
}

interface Layout {
  at: Record<string, number>;
  keys: { key: string; label: string }[];
}

/** 汇总表的行：只出本次各口径用到的项目。 */
function summaryLayout(results: LedgerResult[]): Layout {
  const any = (f: (r: LedgerResult) => boolean) => results.some(f);
  const keys: { key: string; label: string }[] = [{ key: "as_of", label: "暂计截止日（含当日）" }];
  // 口径前提（第 58 批：金额测算卡复核判“需要留意”一行三列都写“无”，掩盖了每个口径靠什么成立——这一行是工具生成的，模型改不了）
  if (any((r) => !!r.premise)) keys.push({ key: "premise", label: "口径前提" });
  if (any((r) => r.totals.principal_original_yuan > 0)) keys.push({ key: "p0", label: "本金原额（元）" }, { key: "pp", label: "已冲本金（元）" }, { key: "po", label: "本金余额（元）" });
  if (any(hasInterest)) keys.push({ key: "ia", label: "利息累计（元）" }, { key: "ip", label: "已冲利息（元）" }, { key: "io", label: "利息未付（元）" });
  if (any(hasPenalty)) keys.push({ key: "na", label: "违约金累计（元）" }, { key: "np", label: "已冲违约金（元）" }, { key: "no", label: "违约金未付（元）" });
  if (any((r) => r.totals.cost_original_yuan > 0)) keys.push({ key: "c0", label: "费用原额（元）" }, { key: "cp", label: "已冲费用（元）" }, { key: "co", label: "费用未付（元）" });
  if (any((r) => r.totals.doubled_accrued_yuan > 0 || r.assumptions.some((a) => a.startsWith("加倍部分债务利息")))) keys.push({ key: "da", label: "加倍部分债务利息累计（元）" }, { key: "dp", label: "已冲加倍部分债务利息（元）" }, { key: "do", label: "加倍部分债务利息未付（元）" });
  // 没有录入付款的写“未录入”（V31 答辩状一单：材料里有付款、参数没录，表里写“没有付款”有误导）
  // “已付款合计”被读成案件里的全部已付款（第 58 批：表里只录了冲抵本笔款项的两笔，材料累计已付更多）
  keys.push({ key: "pay", label: "本表录入的付款合计（元）" });
  if (any((r) => r.totals.unallocated_yuan > 0)) keys.push({ key: "free", label: "未冲（多付）（元）" });
  keys.push({ key: "total", label: "未清偿合计（元）" });
  // 第 65 批（D-280）：有履行期未届满的本金时拆成两段小计，起诉类文书引用“已届满部分合计”
  if (any((r) => r.totals.principal_not_due_yuan > 0)) keys.push({ key: "nd", label: "其中：履行期未届满的本金（元）" }, { key: "due", label: "已届满部分合计（元）" });
  if (any((r) => !!r.cap)) keys.push({ key: "cap", label: "约定上限" });
  if (any((r) => !!r.penalty_check)) keys.push({ key: "loss", label: "损失数额（元）" }, { key: "ref", label: "损失的 130%（元）" }, { key: "check", label: "违约金调减参照" });
  if (any((r) => r.payments.length > 0)) keys.push({ key: "order", label: "抵充顺序" });
  if (any((r) => !!r.pending_dates)) keys.push({ key: "pending", label: "待核日期" });
  if (any((r) => r.warnings.length > 0)) keys.push({ key: "warn", label: "需要留意" });
  const at: Record<string, number> = {};
  keys.forEach((k, i) => (at[k.key] = i + 2));
  return { at, keys };
}

/** 汇总表：每个口径一列；累计、已冲、已付、余额、合计都引用分段表与付款表。 */
function summarySheet(results: LedgerResult[], layout: Layout, refs: { seg: string | null; pay: PayRef | null }[]): SheetSpec {
  const { at, keys } = layout;
  const rows: Cell[][] = [["项目", ...results.map((r) => r.name)], ...keys.map((k) => [k.label, ...results.map((): Cell => null)])];
  const formulas: Record<string, string> = {};
  const dates: string[] = [];
  results.forEach((r, i) => {
    const c = col(i + 1);
    const ref = refs[i]!;
    const T = r.totals;
    const put = (key: string, v: Cell, f?: string) => {
      if (at[key] === undefined) return;
      rows[at[key]! - 1]![i + 1] = v;
      if (f && typeof v === "number") formulas[`${c}${at[key]}`] = f;
    };
    const cell = (key: string) => `${c}${at[key]}`;
    const payCell = (k: string) => (ref.pay && ref.pay.colOf[k] ? `${quote(ref.pay.name)}!${ref.pay.colOf[k]}${ref.pay.totalRow}` : undefined);
    const segSum = (kind: keyof typeof KIND_LABEL) => (ref.seg && r.segments.some((s) => s.kind === kind) ? `SUMIF(${quote(ref.seg)}!C:C,"${KIND_LABEL[kind]}",${quote(ref.seg)}!J:J)` : undefined);
    const segCents = (kind: keyof typeof KIND_LABEL) => r.segments.filter((s) => s.kind === kind).reduce((n, s) => n + toCents(s.amount_yuan), 0);
    /** 累计 = 已确定数额 + 分段合计（有总上限的取较小者）；有单笔上限截断的与分段合计不等，不写公式。 */
    const accruedFormula = (kind: "interest" | "penalty", fixed: number, claimed: number) => {
      const s = segSum(kind);
      const capHere = r.cap && r.cap.applies_to === KIND_LABEL[kind] ? r.cap.cap_yuan : null;
      const expect = toCents(fixed) + (capHere !== null ? Math.min(toCents(capHere), segCents(kind)) : segCents(kind));
      if (expect !== toCents(fixed + claimed)) return undefined;
      const body = s ? (capHere !== null ? `MIN(${capHere},${s})` : s) : undefined;
      if (!body) return undefined;
      return fixed > 0 ? `${fixed}+${body}` : body;
    };
    put("as_of", excelSerial(r.as_of));
    dates.push(cell("as_of"));
    put("p0", T.principal_original_yuan);
    put("pp", T.principal_paid_yuan, payCell("principal"));
    put("po", T.principal_outstanding_yuan, at.p0 ? `${cell("p0")}-${cell("pp")}` : undefined);
    const ii = Number((T.interest_fixed_yuan + T.interest_accrued_yuan).toFixed(2));
    put("ia", ii, accruedFormula("interest", T.interest_fixed_yuan, T.interest_accrued_yuan));
    put("ip", T.interest_paid_yuan, payCell("interest"));
    put("io", T.interest_outstanding_yuan, at.ia && toCents(ii - T.interest_paid_yuan) === toCents(T.interest_outstanding_yuan) ? `${cell("ia")}-${cell("ip")}` : undefined);
    const nn = Number((T.penalty_fixed_yuan + T.penalty_accrued_yuan).toFixed(2));
    put("na", nn, accruedFormula("penalty", T.penalty_fixed_yuan, T.penalty_accrued_yuan));
    put("np", T.penalty_paid_yuan, payCell("penalty"));
    put("no", T.penalty_outstanding_yuan, at.na && toCents(nn - T.penalty_paid_yuan) === toCents(T.penalty_outstanding_yuan) ? `${cell("na")}-${cell("np")}` : undefined);
    put("c0", T.cost_original_yuan);
    put("cp", T.cost_paid_yuan, payCell("cost"));
    put("co", T.cost_outstanding_yuan, at.c0 ? `${cell("c0")}-${cell("cp")}` : undefined);
    put("da", T.doubled_accrued_yuan, segSum("doubled"));
    put("dp", T.doubled_paid_yuan, payCell("doubled"));
    put("do", T.doubled_outstanding_yuan, at.da ? `${cell("da")}-${cell("dp")}` : undefined);
    put("pay", r.payments.length > 0 ? T.payments_total_yuan : "未录入", payCell("amount"));
    put("free", T.unallocated_yuan, payCell("free"));
    put("total", T.total_outstanding_yuan, ["po", "io", "no", "co", "do"].filter((k) => at[k] !== undefined).map(cell).join("+"));
    put("nd", T.principal_not_due_yuan);
    put("due", T.total_due_outstanding_yuan, at.nd !== undefined ? `${cell("total")}-${cell("nd")}` : undefined);
    put("cap", r.cap ? `${r.cap.applies_to} ${money(r.cap.cap_yuan)} 元；${r.cap.applied ? `各段累计已超过，按上限计（${r.cap.reached_on ?? ""} 达到）` : r.cap.reached_on ? `尚未达到，按现有日累计额推算约 ${r.cap.reached_on} 达到（推算）` : "尚未达到"}` : "无");
    const pc = r.penalty_check;
    if (pc) {
      put("loss", pc.loss_yuan ?? "未提供");
      put("ref", pc.reference_yuan ?? "未测算", pc.loss_yuan !== null && toCents(Math.round(pc.loss_yuan * 130) / 100) === toCents(pc.reference_yuan!) ? `ROUND(${cell("loss")}*1.3,2)` : undefined);
      put("check", pc.loss_yuan === null ? `${pc.conclusion}。需要：${pc.needs.join("；")}` : `${pc.conclusion}${pc.loss_basis ? `（损失：${pc.loss_basis}）` : ""}`);
    }
    if (at.order !== undefined) {
      const order = r.assumptions.find((a) => a.startsWith("抵充顺序："))?.slice(5);
      const pen = r.assumptions.find((a) => a.startsWith("违约金排在本金之后") || a.startsWith("违约金与利息同序"));
      put("order", order ? `${order}${pen ? `；${pen.startsWith("违约金排在") ? "违约金排在本金之后" : "违约金与利息同序（有争议的口径）"}` : ""}` : "（本口径没有付款）");
    }
    if (at.pending !== undefined) put("pending", r.pending_dates ? `${r.pending_dates.items.join("；")}；本列按${r.pending_dates.end === "earliest" ? "最早" : "最晚"}日计，${r.pending_dates.dependent_segments} 段依赖待核日期` : "无");
    put("warn", r.warnings.length > 0 ? r.warnings.join("；") : "—");
    put("premise", r.premise ?? "—");
  });
  return { name: SUMMARY, rows, formulas, dates };
}

/** 一笔款项在参数表里的说明。 */
function debtLine(d: LedgerParams["debts"][number], p: LedgerParams): Cell[] {
  const kind = d.kind ?? "principal";
  const kindText = { principal: "本金", cost: "费用", interest: "已确定数额的利息", penalty: "违约金计算基数，不计入欠款合计", penalty_fixed: "已确定数额的违约金" }[kind] ?? kind;
  const start = d.accrue_from ? `起算日 ${d.accrue_from}（含当日）` : d.due_date ? `最后履行日 ${d.due_date}，次日起算` : "不计息";
  const accrues = kind === "penalty" || (kind === "principal" && (d.rate ?? p.rate) && (d.rate ?? p.rate)!.kind !== "none");
  const bits = [
    start,
    ...(accrues && d.accrue_to ? [`计至 ${d.accrue_to}（含当日）`] : []),
    ...(kind === "principal" && accrues ? [`计${(d.accrual ?? p.accrual) === "penalty" ? "违约金" : "利息"}`] : []),
    ...(d.rate ? [`${kind === "penalty" || (d.accrual ?? p.accrual) === "penalty" ? "违约金比例" : "利率"} ${rateLabel(d.rate)}`] : []),
    ...(d.cap_yuan !== undefined ? [`约定上限 ${money(d.cap_yuan)} 元`] : []),
    ...(d.in_doubled_base !== undefined ? [d.in_doubled_base ? "计入加倍部分债务利息的基数" : "不计入加倍部分债务利息的基数"] : []),
  ];
  // 第 61 批（真实验收 m08：“货款（本金）（本金）”）：款项名自己已带同一括注的不再追加
  const label = d.label.trim().endsWith(`（${kindText}）`) || d.label.trim().endsWith(`(${kindText})`) ? d.label.trim() : `${d.label}（${kindText}）`;
  return [label, d.amount_yuan, bits.join("；")];
}

function paramSheet(scenarios: LedgerParams[], results: LedgerResult[], notes: unknown): SheetSpec {
  const rows: Cell[][] = [["口径", "项目", "取值", "来源或说明", "状态"]];
  const per: Cell[][][] = scenarios.map((p, i) => {
    const out: Cell[][] = p.debts.map((d) => debtLine(d, p));
    const accruing = p.debts.filter((d) => d.kind === "penalty" || ((d.kind ?? "principal") === "principal" && (d.rate ?? p.rate) && (d.rate ?? p.rate)!.kind !== "none"));
    const penaltyOnly = accruing.length > 0 && accruing.every((d) => d.kind === "penalty" || (d.accrual ?? p.accrual) === "penalty");
    if (p.rate) out.push([penaltyOnly ? "违约金比例" : "利率", rateLabel(p.rate), null]);
    for (const x of p.payments ?? []) out.push([`付款 ${x.date}`, x.amount_yuan, x.note ?? null]);
    const pc = p.penalty_check;
    if (pc?.loss_yuan !== undefined) out.push(["损失数额", pc.loss_yuan, pc.loss_basis ?? null]);
    if (pc?.loss_rate !== undefined) out.push(["损失的计算标准", rateLabel(pc.loss_rate), pc.loss_basis ?? null]);
    for (const a of results[i]!.assumptions) out.push(["计算口径", a, null]);
    return out;
  });
  // 各口径都相同的行只写一次（V31：同样的计算口径在三个口径下各抄一遍）
  const key = (r: Cell[]) => JSON.stringify(r);
  const common = per.length > 1 ? new Set(per[0]!.map(key).filter((k) => per.every((list) => list.some((x) => key(x) === k)))) : new Set<string>();
  if (common.size > 0) for (const r of per[0]!) if (common.has(key(r))) rows.push(["全部口径", ...r, null]);
  per.forEach((list, i) => {
    for (const r of list) if (!common.has(key(r))) rows.push([results[i]!.name, ...r, null]);
  });
  rows.push([per.length > 1 ? "全部口径" : results[0]!.name, "改截止日", "汇总表的“暂计截止日”可以直接改：末段的截止日、日数、金额和汇总跟着重算；期间另有付款、利率调整或改到末段起算日之前的，须重新计算", null, null]);
  const list = Array.isArray(notes) ? notes.slice(0, MAX_NOTE_ROWS) : [];
  for (const n of list) {
    if (!n || typeof n !== "object") continue;
    const o = n as Record<string, unknown>;
    const s = (v: unknown): Cell => (v === undefined || v === null || v === "" ? null : typeof v === "number" && Number.isFinite(v) ? v : String(v).slice(0, 1_000));
    rows.push([s(o.scenario) ?? "全部口径", s(o.item), s(o.value), s(o.source), s(o.status)]);
  }
  return { name: "参数与假设", rows };
}

export interface CalcLedgerToolParams {
  title?: string;
  scenarios: LedgerParams[];
  notes?: unknown;
  extra_sheets?: { name: string; columns: string[]; rows: unknown[][] }[];
}

/** 把一组口径的计算结果排成工作簿（纯函数，供工具入口与用例共用）。scenarios 与 results 一一对应（待核日期已展开）。 */
export function ledgerWorkbook(scenarios: LedgerParams[], results: LedgerResult[], notes?: unknown): SheetSpec[] {
  const single = results.length === 1;
  const layout = summaryLayout(results);
  const detail: SheetSpec[] = [];
  const refs: { seg: string | null; pay: PayRef | null }[] = [];
  results.forEach((r, i) => {
    const tag = single ? "" : String(i + 1);
    const c = col(i + 1);
    const asOfRef = `${quote(SUMMARY)}!$${c}$${layout.at.as_of}`;
    const p0Ref = layout.at.p0 !== undefined ? `${quote(SUMMARY)}!$${c}$${layout.at.p0}` : null;
    const seg = r.segments.length > 0 ? segmentSheet(`分段计算${tag}`, r, scenarios[i]!.year_days ?? 365, asOfRef) : null;
    const pay = r.payments.length > 0 ? paymentSheet(`付款与抵扣${tag}`, r, p0Ref) : null;
    if (seg) detail.push(seg);
    if (pay) detail.push(pay.spec);
    refs.push({ seg: seg?.name ?? null, pay: pay?.ref ?? null });
  });
  return [summarySheet(results, layout, refs), ...detail, paramSheet(scenarios, results, notes)];
}

export function calcLedgerTool(ctx: InvokeCtx, p: CalcLedgerToolParams) {
  const { params: scenarios, results } = calcLedgerScenarios(Array.isArray(p?.scenarios) ? p.scenarios : [], LEDGER_MAX_SCENARIOS);
  const out: Record<string, unknown> = {
    scenarios: results,
    how_to_use:
      "文书、表格、答复里用到这些金额的，逐字照抄上面的数（含 summary），不要自己再加减乘除；口径或事实变了，改参数重新调用本工具。" +
      (results.some((r) => r.pending_dates) ? "有日期待核的口径已按最早、最晚各算了一个并列（pending_dates）：两端的结果都写进答复并说明哪个日期待核实，不要只取其中一段。" : "") +
      (results.some((r) => r.penalty_check) ? "penalty_check 是合同编通则解释第六十五条的调减参照：exceeds 为 true 时写明被调减的风险与参照值，是“一般可以认定”的参照、不是结论；needs 非空表示没有损失数据，照它向律师说明还需要哪些证据，不要自己编损失数额（律师给了数额或计算标准后，填 penalty_check 重新调用）。" : ""),
  };
  const title = typeof p.title === "string" ? p.title.trim() : "";
  if (title) {
    const sheets = ledgerWorkbook(scenarios, results, p.notes);
    const extra = Array.isArray(p.extra_sheets) ? p.extra_sheets : [];
    if (extra.length > MAX_EXTRA_SHEETS) throw new DomainError("validation", `extra_sheets 最多 ${MAX_EXTRA_SHEETS} 张`, 422);
    const used = new Set(sheets.map((s) => s.name));
    for (const [i, sh] of extra.entries()) {
      const cols = Array.isArray(sh?.columns) ? sh.columns.map((c) => String(c).slice(0, 200)) : [];
      const name = String(sh?.name ?? "").replace(/[\\/?*[\]:]/g, "").slice(0, 31);
      if (!name || cols.length === 0 || cols.length > 40) throw new DomainError("validation", `extra_sheets 第 ${i + 1} 张需要 name 与 1～40 个 columns`, 422);
      if (used.has(name)) throw new DomainError("validation", `extra_sheets 的表名“${name}”与计算表重名，换一个`, 422);
      used.add(name);
      const body = (Array.isArray(sh.rows) ? sh.rows : []).slice(0, 2_000).map((r) => (Array.isArray(r) ? r : []).slice(0, cols.length).map((c): Cell => (c === null || c === undefined ? null : typeof c === "number" && Number.isFinite(c) ? c : String(c).slice(0, 2_000))));
      sheets.push({ name, rows: [cols, ...body] });
    }
    out.workbook = finishTable(ctx, title, sheets, "calc.ledger", { computed: true });
    out.workbook_note =
      "计算表已生成并登记为本任务成果：汇总、分段计算、付款与抵扣（有付款时）、参数与假设各表的数字由系统写入并带公式（日期是日期格，改汇总表的暂计截止日会重算末段）。要改数字就改参数、用同一个 title 重新调用本工具（成为这份表格的新版本）；不要另用 xlsx.render_table 把这些数重抄一遍。" +
      "这份表含各口径的比较与确认状态，是给律师的内部测算底稿：不要把它列为起诉状、申请书、律师函的附件；要递交或发出的计算明细，只取律师选定的那一个口径，在文书里画成附页（按每笔款项自己的分段写算式，不要把一段拆成几段）。";
  }
  return out;
}
