/**
 * 表格审阅（v9.4 第 19 批 C-01；评审 C1 §3.3）的界面口径。纯函数，供材料页与用例共用。
 * 格子五态的律师说法与颜色：AI 已提取（待核）、没找到、读取差、有冲突、已核（绿）、已改（蓝，原 AI 值可查）。
 */
export type CellState = "ai" | "not_found" | "unreadable" | "conflict" | "verified" | "edited";

export interface TableColumnView {
  key: string;
  label: string;
  format: "text" | "date" | "money" | "yesno" | "choice";
  options?: string[];
  hint: string;
  /** 条件列（v9.4 第 21 批）：只在同一行 column 列的值等于 equals 时才填。 */
  when?: { column: string; equals: string };
}
export interface TableView {
  table_id: string;
  template: "evidence_list" | "dd_contract_summary" | "contract_ledger";
  title: string;
  columns: TableColumnView[];
  document_version_ids: string[];
  created_at: string;
  cells?: number;
  verified?: number;
}
export interface CellView {
  cell_id: string;
  document_version_id: string;
  col_key: string;
  value: string | null;
  quote: string | null;
  anchor_status: string | null;
  note: string | null;
  state: CellState;
  lawyer_value: string | null;
  /** 最后改动时刻：确认时带回，格子在此后被助手重填过就拒绝（复核 Q2-05）。 */
  updated_at?: string;
  /** 引文在原件里的页码（按页解析的材料；v9.4 第 22 批）。 */
  page?: number;
}

export const CELL_STATE_TEXT: Readonly<Record<CellState, string>> = {
  ai: "待核",
  not_found: "没找到",
  unreadable: "读取差",
  conflict: "有冲突",
  verified: "已核",
  edited: "已改",
};
export const CELL_STATE_CLASS: Readonly<Record<CellState, string>> = {
  ai: "cell-ai",
  not_found: "cell-missing",
  unreadable: "cell-missing",
  conflict: "cell-conflict",
  verified: "cell-verified",
  edited: "cell-edited",
};

/** 格子里显示的值：律师改过的用律师的值；已核但没有值的写“确认没有”。 */
export function cellText(c: CellView | undefined, plain: (s: string | null) => string): string {
  if (!c) return "";
  if (c.state === "edited") return c.lawyer_value ?? "";
  if (c.state === "verified" && !c.value) return "确认没有";
  if (c.state === "not_found" || c.state === "unreadable") return "";
  return plain(c.value);
}

/** “只看未核”：AI 值、冲突与空格都算未核；已核、已改不算。 */
export const isOpen = (c: CellView | undefined) => !c || (c.state !== "verified" && c.state !== "edited");

/**
 * 条件列在这一行是否适用（与内核 columnApplies 同一口径）：yes / no（显示“不适用”，不算未核）/ pending（条件列还没填或有冲突）。
 */
export function columnApplies(col: Pick<TableColumnView, "when">, condition: CellView | undefined): "yes" | "no" | "pending" {
  if (!col.when) return "yes";
  if (!condition || condition.state === "conflict" || condition.state === "unreadable") return "pending";
  if (condition.state === "not_found") return "no";
  const v = condition.state === "edited" ? condition.lawyer_value : condition.value;
  return v === col.when.equals ? "yes" : "no";
}

/** 条件列表头的说明：“只在 有违约金条款 为“是”时填”。 */
export function whenText(col: Pick<TableColumnView, "when">, columns: readonly Pick<TableColumnView, "key" | "label">[]): string {
  if (!col.when) return "";
  return `只在“${columns.find((c) => c.key === col.when!.column)?.label ?? col.when.column}”为“${col.when.equals}”时填`;
}

/** 表头一行的计数：共几格、已核几格、有冲突几格、引文找不到几格；条件不满足（不适用）的格子不计。纯函数。 */
export function tableCounts(t: Pick<TableView, "columns" | "document_version_ids">, cells: readonly CellView[]): { total: number; done: number; conflict: number; quoteMissing: number; empty: number; na: number } {
  const at = new Map(cells.map((c) => [`${c.document_version_id}\u0000${c.col_key}`, c]));
  const naAt = new Set<string>();
  for (const d of t.document_version_ids)
    for (const col of t.columns) if (col.when && columnApplies(col, at.get(`${d}\u0000${col.when.column}`)) === "no") naAt.add(`${d}\u0000${col.key}`);
  const live = cells.filter((c) => !naAt.has(`${c.document_version_id}\u0000${c.col_key}`));
  const total = t.columns.length * t.document_version_ids.length - naAt.size;
  return {
    total,
    done: live.filter((c) => c.state === "verified" || c.state === "edited").length,
    conflict: live.filter((c) => c.state === "conflict").length,
    quoteMissing: live.filter((c) => c.anchor_status === "not_found" && (c.state === "ai" || c.state === "conflict")).length,
    empty: total - live.length,
    na: naAt.size,
  };
}

/** 改值前的格式提示（与内核一致）；返回 null 表示可以提交。 */
export function formatProblem(col: Pick<TableColumnView, "format" | "options">, value: string): string | null {
  const v = value.trim();
  if (!v) return "请填写";
  if (col.format === "date" && !/^\d{4}-\d{2}(?:-\d{2})?$/.test(v)) return "日期写成 2026-03-01，只知年月写 2026-03";
  if (col.format === "yesno" && !["是", "否"].includes(v)) return "只能填“是”或“否”";
  if (col.format === "choice" && col.options && !col.options.includes(v)) return `只能填：${col.options.join(" / ")}`;
  if (col.format === "money" && !/\d/.test(v)) return "金额须含数字";
  return null;
}

// ─── v9.4 第 20 批：C-01 残余（评审 C1 §3.3）───

/** 按列排序：材料名或某列显示的值；空值排后；同值按原顺序。 */
export function sortDocs<D extends { document_version_id: string; filename: string }>(
  docs: readonly D[],
  key: string | null,
  dir: 1 | -1,
  valueOf: (doc: D, key: string) => string,
): D[] {
  if (!key) return [...docs];
  const v = (d: D) => (key === "__doc" ? d.filename : valueOf(d, key));
  return docs
    .map((d, i) => ({ d, i, v: v(d) }))
    .sort((a, b) => (!a.v && b.v ? 1 : a.v && !b.v ? -1 : a.v === b.v ? a.i - b.i : a.v.localeCompare(b.v, "zh-Hans-CN", { numeric: true }) * dir))
    .map((x) => x.d);
}

/** 复核模式（J/K）：从当前格往后（step=1）或往前（-1）找下一个未核的格子，按行优先；没有返回 null。 */
export function nextOpenCell(
  rows: readonly { document_version_id: string }[],
  cols: readonly { key: string }[],
  isOpenAt: (doc: string, col: string) => boolean,
  cur: { doc: string; col: string } | null,
  step: 1 | -1,
): { doc: string; col: string } | null {
  const all = rows.flatMap((r) => cols.map((c) => ({ doc: r.document_version_id, col: c.key })));
  if (all.length === 0) return null;
  const at = cur ? all.findIndex((x) => x.doc === cur.doc && x.col === cur.col) : -1;
  for (let k = 1; k <= all.length; k += 1) {
    const i = at < 0 ? (step === 1 ? k - 1 : all.length - k) : (at + step * k + all.length * k) % all.length;
    const x = all[i]!;
    if (isOpenAt(x.doc, x.col)) return x;
  }
  return null;
}

/** 自建列的格式选项（与内核同一组）。 */
export const COLUMN_FORMATS: readonly { value: TableColumnView["format"]; label: string }[] = [
  { value: "text", label: "文字摘录" },
  { value: "date", label: "日期" },
  { value: "money", label: "金额" },
  { value: "yesno", label: "是 / 否" },
  { value: "choice", label: "分类（给选项）" },
];

/** “据此起草”的按钮文字：证据清单 → 证据目录；尽调摘要 → 尽调发现；台账 → 设提醒。 */
export function draftLabel(template: TableView["template"]): string {
  return template === "evidence_list" ? "据此起草证据目录" : template === "dd_contract_summary" ? "据此起草尽调发现" : "据此设到期提醒";
}
