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

/** 表头一行的计数：共几格、已核几格、有冲突几格、引文找不到几格。纯函数。 */
export function tableCounts(t: Pick<TableView, "columns" | "document_version_ids">, cells: readonly CellView[]): { total: number; done: number; conflict: number; quoteMissing: number; empty: number } {
  const total = t.columns.length * t.document_version_ids.length;
  return {
    total,
    done: cells.filter((c) => c.state === "verified" || c.state === "edited").length,
    conflict: cells.filter((c) => c.state === "conflict").length,
    quoteMissing: cells.filter((c) => c.anchor_status === "not_found" && (c.state === "ai" || c.state === "conflict")).length,
    empty: total - cells.length,
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
