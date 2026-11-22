/**
 * calc.ledger 的工具入口（第 57 批，D-228）：一次调用算一到四个口径；给了 title 就把结果直接写成《计算明细》类 Excel 并登记为本任务成果。
 * 表里的数字由内核从计算结果直接写入（合计与金额带公式，律师改了上游格子会重算），模型不经手、不转抄——
 * 第 56 批真实运行里，抵充、余额、各口径合计都是模型心算后手敲进 xlsx.render_table 的，错就错在这一步。
 */
import { DomainError } from "@zr-legal/domain";
import type { SheetSpec } from "@zr-legal/docx-engine";
import type { InvokeCtx } from "../registry.ts";
import { calcLedger, type LedgerParams, type LedgerResult } from "./ledger.ts";
import { finishTable } from "./review.ts";

export const LEDGER_MAX_SCENARIOS = 4;
const MAX_NOTE_ROWS = 200;
const MAX_EXTRA_SHEETS = 3;

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

/** 分段计算表：金额 = 基数 × 利率 × 日数（年利率的再除以年日数）；末行合计。 */
function segmentSheet(name: string, r: LedgerResult, yearDays: number): SheetSpec {
  const header = ["序号", "款项", "类别", "起算日（含）", "截止日（含）", "日数", "计息基数（元）", "利率数值", "利率口径", "金额（元）"];
  const rows: Cell[][] = [header];
  const formulas: Record<string, string> = {};
  r.segments.forEach((s, i) => {
    const row = i + 2;
    const annual = !/^日万分之/.test(s.rate_text);
    const rateValue = annual ? Number((s.daily_rate * yearDays).toFixed(10)) : s.daily_rate;
    rows.push([i + 1, s.item, s.kind === "doubled" ? "加倍部分债务利息" : "利息（违约金）", s.from, s.to, s.days, s.base_yuan, rateValue, s.rate_text, s.amount_yuan]);
    // 公式只在浮点重算与精确结果一致时才写（极少数恰好落在半分上的不写公式，保留算好的数）
    const float = Math.round((annual ? (s.base_yuan * rateValue * s.days) / yearDays : s.base_yuan * rateValue * s.days) * 100 + 1e-7) / 100;
    if (Math.abs(float - s.amount_yuan) < 0.005) formulas[`J${row}`] = annual ? `ROUND(G${row}*H${row}*F${row}/${yearDays},2)` : `ROUND(G${row}*H${row}*F${row},2)`;
  });
  if (r.segments.length === 0) rows.push([null, "（本口径下没有计息的期间）", null, null, null, null, null, null, null, 0]);
  else {
    const last = r.segments.length + 1;
    const total = Number(r.segments.reduce((n, s) => n + Math.round(s.amount_yuan * 100), 0)) / 100;
    rows.push(["合计", null, null, null, null, null, null, null, null, total]);
    formulas[`J${last + 1}`] = `SUM(J2:J${last})`;
  }
  return { name, rows, formulas };
}

function paymentSheet(name: string, r: LedgerResult): SheetSpec & { totalRow: number | null; colOf: Record<string, string> } {
  // 没有费用、没有加倍部分、没有多付的口径不出对应的列（上诉状一单的计算表带着与本案无关的“冲费用”“冲加倍部分债务利息”两列）
  const hasCost = r.totals.cost_original_yuan > 0;
  const hasDoubled = r.totals.doubled_accrued_yuan > 0;
  const hasFree = r.totals.unallocated_yuan > 0;
  type Col = { key: string; title: string; pick: (x: LedgerResult["payments"][number]) => Cell; sum?: (x: LedgerResult["payments"][number]) => number; empty: Cell };
  const cols: Col[] = [
    { key: "date", title: "付款日", pick: (x) => x.date, empty: "（没有付款）" },
    { key: "amount", title: "付款金额（元）", pick: (x) => x.amount_yuan, sum: (x) => x.amount_yuan, empty: 0 },
    ...(hasCost ? [{ key: "cost", title: "冲费用", pick: (x: LedgerResult["payments"][number]) => x.to_cost_yuan, sum: (x: LedgerResult["payments"][number]) => x.to_cost_yuan, empty: 0 }] : []),
    { key: "interest", title: "冲利息（违约金）", pick: (x) => x.to_interest_yuan, sum: (x) => x.to_interest_yuan, empty: 0 },
    { key: "principal", title: "冲本金", pick: (x) => x.to_principal_yuan, sum: (x) => x.to_principal_yuan, empty: 0 },
    ...(hasDoubled ? [{ key: "doubled", title: "冲加倍部分债务利息", pick: (x: LedgerResult["payments"][number]) => x.to_doubled_yuan, sum: (x: LedgerResult["payments"][number]) => x.to_doubled_yuan, empty: 0 }] : []),
    ...(hasFree ? [{ key: "free", title: "未冲（多付）", pick: (x: LedgerResult["payments"][number]) => x.unallocated_yuan, sum: (x: LedgerResult["payments"][number]) => x.unallocated_yuan, empty: 0 }] : []),
    { key: "p_after", title: "抵扣后本金余额", pick: (x) => x.principal_after_yuan, empty: r.totals.principal_outstanding_yuan },
    { key: "i_after", title: "抵扣后未付利息（违约金）", pick: (x) => x.interest_unpaid_after_yuan, empty: r.totals.interest_outstanding_yuan },
    { key: "detail", title: "抵充明细", pick: (x) => x.detail, empty: null },
    { key: "note", title: "备注", pick: (x) => x.note || null, empty: null },
  ];
  const rows: Cell[][] = [["序号", ...cols.map((c) => c.title)]];
  const formulas: Record<string, string> = {};
  const colOf: Record<string, string> = {};
  cols.forEach((c, i) => (colOf[c.key] = col(i + 1)));
  r.payments.forEach((x, i) => rows.push([i + 1, ...cols.map((c) => c.pick(x))]));
  let totalRow: number | null = null;
  if (r.payments.length === 0) rows.push([null, ...cols.map((c) => c.empty)]);
  else {
    const last = r.payments.length + 1;
    totalRow = last + 1;
    rows.push(["合计", ...cols.map((c): Cell => (c.sum ? Number(r.payments.reduce((n, x) => n + Math.round(c.sum!(x) * 100), 0)) / 100 : null))]);
    cols.forEach((c, i) => {
      if (c.sum) formulas[`${col(i + 1)}${totalRow}`] = `SUM(${col(i + 1)}2:${col(i + 1)}${last})`;
    });
  }
  return { name, rows, formulas, totalRow, colOf };
}

/** 汇总表：每个口径一列；余额与合计带公式，口径说明在金额行之后。 */
function summarySheet(results: LedgerResult[], refs: { seg: string; pay: string; payTotalRow: number | null; payCol: Record<string, string> }[] = []): SheetSpec {
  const anyCost = results.some((r) => r.totals.cost_original_yuan > 0);
  const anyDoubled = results.some((r) => r.totals.doubled_accrued_yuan > 0 || r.assumptions.some((a) => a.startsWith("加倍部分债务利息")));
  const anyFree = results.some((r) => r.totals.unallocated_yuan > 0);
  const rows: Cell[][] = [["项目", ...results.map((r) => r.name)]];
  const formulas: Record<string, string> = {};
  const at: Record<string, number> = {};
  const add = (key: string, label: string, pick: (r: LedgerResult) => Cell) => {
    rows.push([label, ...results.map(pick)]);
    at[key] = rows.length; // 1 起的行号
  };
  add("as_of", "暂计截止日（含当日）", (r) => r.as_of);
  add("p0", "本金原额（元）", (r) => r.totals.principal_original_yuan);
  add("pp", "已冲本金（元）", (r) => r.totals.principal_paid_yuan);
  add("po", "本金余额（元）", (r) => r.totals.principal_outstanding_yuan);
  add("ia", "利息（违约金）累计（元）", (r) => Number((r.totals.interest_fixed_yuan + r.totals.interest_accrued_yuan).toFixed(2)));
  add("ip", "已冲利息（违约金）（元）", (r) => r.totals.interest_paid_yuan);
  add("io", "利息（违约金）未付（元）", (r) => r.totals.interest_outstanding_yuan);
  if (anyCost) {
    add("c0", "费用原额（元）", (r) => r.totals.cost_original_yuan);
    add("cp", "已冲费用（元）", (r) => r.totals.cost_paid_yuan);
    add("co", "费用未付（元）", (r) => r.totals.cost_outstanding_yuan);
  }
  if (anyDoubled) {
    add("da", "加倍部分债务利息累计（元）", (r) => r.totals.doubled_accrued_yuan);
    add("dp", "已冲加倍部分债务利息（元）", (r) => r.totals.doubled_paid_yuan);
    add("do", "加倍部分债务利息未付（元）", (r) => r.totals.doubled_outstanding_yuan);
  }
  add("pay", "已付款合计（元）", (r) => r.totals.payments_total_yuan);
  if (anyFree) add("free", "未冲（多付）（元）", (r) => r.totals.unallocated_yuan);
  add("total", "未清偿合计（元）", (r) => r.totals.total_outstanding_yuan);
  results.forEach((r, i) => {
    const c = col(i + 1);
    // 汇总数引用分段表与抵扣表（上诉状一单的评分：汇总是写死的数，改了分段表合计不跟着变）：累计按“类别”列条件求和，已冲取抵扣表的合计行
    const ref = refs[i];
    if (ref) {
      const q = (n: string) => `'${n.replace(/'/g, "''")}'`;
      const sumif = (label: string) => `SUMIF(${q(ref.seg)}!C:C,"${label}",${q(ref.seg)}!J:J)`;
      const fixed = r.totals.interest_fixed_yuan;
      if (!r.cap?.applied && r.segments.some((x) => x.kind === "interest")) formulas[`${c}${at.ia}`] = fixed > 0 ? `${fixed}+${sumif("利息（违约金）")}` : sumif("利息（违约金）");
      if (anyDoubled && r.segments.some((x) => x.kind === "doubled")) formulas[`${c}${at.da}`] = sumif("加倍部分债务利息");
      if (ref.payTotalRow !== null) {
        const cell = (k: string) => `${q(ref.pay)}!${ref.payCol[k]}${ref.payTotalRow}`;
        formulas[`${c}${at.pp}`] = cell("principal");
        formulas[`${c}${at.ip}`] = cell("interest");
        formulas[`${c}${at.pay}`] = cell("amount");
        if (anyCost && ref.payCol.cost) formulas[`${c}${at.cp}`] = cell("cost");
        if (anyDoubled && ref.payCol.doubled) formulas[`${c}${at.dp}`] = cell("doubled");
      }
    }
    formulas[`${c}${at.po}`] = `${c}${at.p0}-${c}${at.pp}`;
    // 利息未付在有上限截断到 0 的极端情形下不等于“累计 − 已冲”，只在相等时写公式
    const io = Math.round((r.totals.interest_fixed_yuan + r.totals.interest_accrued_yuan - r.totals.interest_paid_yuan) * 100) / 100;
    if (Math.abs(io - r.totals.interest_outstanding_yuan) < 0.005) formulas[`${c}${at.io}`] = `${c}${at.ia}-${c}${at.ip}`;
    if (anyCost) formulas[`${c}${at.co}`] = `${c}${at.c0}-${c}${at.cp}`;
    if (anyDoubled) formulas[`${c}${at.do}`] = `${c}${at.da}-${c}${at.dp}`;
    formulas[`${c}${at.total}`] = [`${c}${at.po}`, `${c}${at.io}`, ...(anyCost ? [`${c}${at.co}`] : []), ...(anyDoubled ? [`${c}${at.do}`] : [])].join("+");
  });
  rows.push(["约定上限", ...results.map((r) => (r.cap ? `${r.cap.cap_yuan.toLocaleString("en-US", { minimumFractionDigits: 2 })} 元；${r.cap.applied ? `各段累计已超过，按上限计（${r.cap.reached_on ?? ""} 达到）` : r.cap.reached_on ? `尚未达到，按现有日累计额推算约 ${r.cap.reached_on} 达到（推算）` : "尚未达到"}` : "无"))]);
  rows.push(["抵充顺序", ...results.map((r) => r.assumptions.find((a) => a.startsWith("抵充顺序："))?.slice(5) ?? "")]);
  rows.push(["需要留意", ...results.map((r) => (r.warnings.length > 0 ? r.warnings.join("；") : "无"))]);
  return { name: "汇总", rows, formulas };
}

function paramSheet(scenarios: LedgerParams[], results: LedgerResult[], notes: unknown): SheetSpec {
  const rows: Cell[][] = [["口径", "参数", "取值", "来源或说明", "状态"]];
  const rateText = (r: LedgerParams["rate"]): string => {
    if (!r || r.kind === "none") return "不计息";
    if (r.kind === "daily") return `日万分之${r.per_10k}`;
    if (r.kind === "fixed") return `固定年利率 ${r.annual_pct}%`;
    if (r.kind === "lpr_plus") return `一年期 LPR 加 ${r.plus_bp} 基点`;
    return `一年期 LPR 的 ${r.multiple} 倍`;
  };
  scenarios.forEach((p, i) => {
    const name = results[i]!.name;
    for (const d of p.debts) {
      const start = d.accrue_from ? `起算日 ${d.accrue_from}（含当日）` : d.due_date ? `最后履行日 ${d.due_date}，次日起算` : "不计息";
      const kind = d.kind === "cost" ? "费用" : d.kind === "interest" ? "已确定数额的利息（违约金）" : "本金";
      rows.push([name, `${d.label}（${kind}）`, d.amount_yuan, `${start}${d.rate ? `；利率 ${rateText(d.rate)}` : ""}`, null]);
    }
    if (p.rate) rows.push([name, "利率口径", rateText(p.rate), null, null]);
    for (const x of p.payments ?? []) rows.push([name, `付款 ${x.date}`, x.amount_yuan, x.note ?? null, null]);
    for (const a of results[i]!.assumptions) rows.push([name, "计算口径", a, "本表固定口径", null]);
  });
  const list = Array.isArray(notes) ? notes.slice(0, MAX_NOTE_ROWS) : [];
  for (const n of list) {
    if (!n || typeof n !== "object") continue;
    const o = n as Record<string, unknown>;
    const s = (v: unknown): Cell => (v === undefined || v === null || v === "" ? null : typeof v === "number" && Number.isFinite(v) ? v : String(v).slice(0, 1_000));
    rows.push([s(o.scenario) ?? "全部", s(o.item), s(o.value), s(o.source), s(o.status)]);
  }
  return { name: "参数与假设", rows };
}

export interface CalcLedgerToolParams {
  title?: string;
  scenarios: LedgerParams[];
  notes?: unknown;
  extra_sheets?: { name: string; columns: string[]; rows: unknown[][] }[];
}

/** 把一组口径的计算结果排成工作簿（纯函数，供工具入口与用例共用）。 */
export function ledgerWorkbook(scenarios: LedgerParams[], results: LedgerResult[], notes?: unknown): SheetSpec[] {
  const single = results.length === 1;
  const detail: SheetSpec[] = [];
  const refs: { seg: string; pay: string; payTotalRow: number | null; payCol: Record<string, string> }[] = [];
  results.forEach((r, i) => {
    const tag = single ? "" : String(i + 1);
    const seg = segmentSheet(`分段计算${tag}`, r, scenarios[i]!.year_days ?? 365);
    const { totalRow, colOf, ...pay } = paymentSheet(`付款与抵扣${tag}`, r);
    detail.push(seg, pay);
    refs.push({ seg: seg.name, pay: pay.name, payTotalRow: totalRow, payCol: colOf });
  });
  return [summarySheet(results, refs), ...detail, paramSheet(scenarios, results, notes)];
}

export function calcLedgerTool(ctx: InvokeCtx, p: CalcLedgerToolParams) {
  const scenarios = Array.isArray(p?.scenarios) ? p.scenarios : [];
  if (scenarios.length === 0 || scenarios.length > LEDGER_MAX_SCENARIOS) throw new DomainError("validation", `scenarios 须为 1～${LEDGER_MAX_SCENARIOS} 个口径`, 422);
  const results = scenarios.map((s, i) => {
    try {
      return calcLedger({ ...s, name: typeof s?.name === "string" && s.name.trim() ? s.name : scenarios.length > 1 ? `口径${i + 1}` : "测算" });
    } catch (e) {
      if (e instanceof DomainError && scenarios.length > 1) throw new DomainError("validation", `第 ${i + 1} 个口径：${e.message}`, 422);
      throw e;
    }
  });
  const names = new Set(results.map((r) => r.name));
  if (names.size !== results.length) throw new DomainError("validation", "各口径的 name 不能相同", 422);
  const out: Record<string, unknown> = {
    scenarios: results,
    how_to_use: "文书、表格、答复里用到这些金额的，逐字照抄上面的数（含 summary），不要自己再加减乘除；口径或事实变了，改参数重新调用本工具。",
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
    out.workbook_note = "计算表已生成并登记为本任务成果：汇总、分段计算、付款与抵扣、参数与假设各表的数字由系统写入并带公式。要改数字就改参数、用同一个 title 重新调用本工具（成为这份表格的新版本）；不要另用 xlsx.render_table 把这些数重抄一遍。这份表含各口径的比较与确认状态，是给律师的内部测算底稿：不要把它列为起诉状、申请书、律师函的附件；要递交或发出的计算明细，只取律师选定的那一个口径，在文书里画成附页。";
  }
  return out;
}
