/**
 * 表格审阅（v9.4 第 19 批 C-01 最小版；评审 C1 §3.3，借鉴 Harvey Review Table / Legora Tabular Review）：
 * 行 = 一份材料，列 = 一个问题，格 = 带原文出处的答案 + 复核状态。先结构化、再综合——解决律师最怕的“漏看一份”。
 *
 * - 三个固定模板：诉讼证据清单、合同尽调摘要、合同台账（列可在模板内选用，首期不自由建列）；
 * - 填表（Agent，经法律工具 table.fill）：每格给值与逐字引文（quote），内核在该材料的令牌化视图里定位引文；
 *   找不到的照收但标“引文找不到”；没有引文的“找到”拒收；读不出文字的材料整行标“读取差”，不让 AI 猜；
 * - 状态五态：ai 已提取 / not_found 文件里没有 / unreadable 读取差 / conflict 同一份材料两处说法不一 / verified 律师已核 / edited 律师已改（原 AI 值保留可查）；
 * - 锁定：律师已核、已改的格子重跑不覆盖（table.fill 跳过并回报 locked）；律师撤回后才可再填；
 * - 导出 Excel：未核的 AI 值标“【待核】”，没找到、读取差如实写。
 *
 * 文字按 Agent 提交时的令牌形态保存（同风险卡）；律师改写的值为原文（lawyer_value）。
 */
import { DomainError, newId, notFound, sha256Hex } from "@zr-legal/domain";
import { createStyledDocx, createXlsx, extractParagraphs, type DocBlock } from "@zr-legal/docx-engine";
import type { KernelDb } from "../db.ts";
import type { BlobStore } from "../blobs.ts";
import type { MatterTokenStore } from "../egress/matter-tokens.ts";
import { locateQuote } from "./review-cards.ts";

export type ColumnFormat = "text" | "date" | "money" | "yesno" | "choice";
export interface TableColumn {
  key: string;
  label: string;
  format: ColumnFormat;
  /** choice 的选项。 */
  options?: readonly string[];
  /** 给 Agent 的填写说明。 */
  hint: string;
  /** 条件列（v9.4 第 21 批，C1 §3.3）：只在同一行的另一列（是否列或分类列）等于 equals 时才填，例如“违约金比例”只在“有违约金条款 = 是”时填。 */
  when?: { column: string; equals: string };
}
export interface TableTemplate {
  id: "evidence_list" | "dd_contract_summary" | "contract_ledger";
  title: string;
  line: "诉讼" | "非诉" | "企业法务";
  columns: readonly TableColumn[];
}

/** 首期三个模板（C1 §3.3 表）。列的 key 是给 Agent 的稳定编号，label 是律师看到的列名。 */
export const TABLE_TEMPLATES: readonly TableTemplate[] = [
  {
    id: "evidence_list",
    title: "证据清单",
    line: "诉讼",
    columns: [
      { key: "evidence_name", label: "证据名称", format: "text", hint: "按材料内容起的名称，如“《采购合同》”“2026-03-01 签收单”" },
      { key: "formed_on", label: "形成时间", format: "date", hint: "材料上写明的形成或签署日期；只知年月的写 YYYY-MM，不补日" },
      { key: "provider", label: "提供方", format: "text", hint: "这份材料由谁出具或提供" },
      { key: "original", label: "原件/复印件", format: "choice", options: ["原件", "复印件", "电子数据", "待核"], hint: "材料能看出的形态；看不出写“待核”" },
      { key: "pages", label: "页码", format: "text", hint: "页数或页码范围" },
      { key: "fact_to_prove", label: "拟证明事实", format: "text", hint: "这份材料能证明的事实，一句话" },
      { key: "issue", label: "相关争点", format: "text", hint: "与哪个争点相关；律师未给争点时写“待律师归类”" },
      { key: "risk", label: "三性风险", format: "text", hint: "真实性、合法性、关联性可能被质疑之处；看不出写“未发现”" },
    ],
  },
  {
    id: "dd_contract_summary",
    title: "合同尽调摘要",
    line: "非诉",
    columns: [
      { key: "contract_name", label: "合同名称", format: "text", hint: "合同标题" },
      { key: "counterparty", label: "相对方", format: "text", hint: "目标公司以外的签约方" },
      { key: "amount", label: "金额", format: "money", hint: "合同总价或年金额，写数字（元）；外币写币种" },
      { key: "term", label: "期限与续约", format: "text", hint: "起止日期与续约方式" },
      { key: "change_of_control", label: "控制权变更", format: "text", hint: "控制权变更时对方是否有解除、同意或通知权" },
      { key: "exclusivity", label: "排他/竞业", format: "text", hint: "排他、竞业、最惠条款" },
      { key: "assignment", label: "转让限制", format: "text", hint: "合同权利义务转让是否须对方同意" },
      { key: "liability_cap", label: "违约责任上限", format: "text", hint: "责任上限或违约金约定" },
      { key: "dispute", label: "争议解决", format: "text", hint: "诉讼或仲裁、管辖地或仲裁机构" },
    ],
  },
  {
    id: "contract_ledger",
    title: "合同台账",
    line: "企业法务",
    columns: [
      { key: "contract_name", label: "合同名称", format: "text", hint: "合同标题" },
      { key: "counterparty", label: "相对方", format: "text", hint: "我方以外的签约方" },
      { key: "signed_on", label: "签署日", format: "date", hint: "签署日期；只知年月写 YYYY-MM" },
      { key: "expires_on", label: "到期日", format: "date", hint: "到期日期；按期限推算的不写，写在“通知期限”里说明" },
      { key: "auto_renew", label: "自动续约", format: "yesno", hint: "是 / 否" },
      { key: "payment_milestones", label: "付款节点", format: "text", hint: "付款条件与期限" },
      { key: "notice_period", label: "通知期限", format: "text", hint: "不续约、解除须提前通知的期限" },
      { key: "owner", label: "负责人", format: "text", hint: "合同写明的我方联系人或负责人；没有写“未写明”" },
    ],
  },
];

export const TABLE_LIMITS = { docs: 200, cellsPerCall: 400, value: 1_000, quote: 1_000, tablesPerMatter: 50, columns: 15 } as const;

export type CellState = "ai" | "not_found" | "unreadable" | "conflict" | "verified" | "edited";
const LOCKED: ReadonlySet<CellState> = new Set(["verified", "edited"]);

export interface TableRow {
  table_id: string;
  matter_id: string;
  template: TableTemplate["id"];
  title: string;
  columns: TableColumn[];
  document_version_ids: string[];
  created_at: string;
}
export interface CellRow {
  cell_id: string;
  document_version_id: string;
  col_key: string;
  /** Agent 填的值（令牌形态；律师改过后仍保留可查）。 */
  value: string | null;
  quote: string | null;
  anchor_status: string | null;
  note: string | null;
  state: CellState;
  /** 律师改写的值（原文）。 */
  lawyer_value: string | null;
  run_id: string | null;
  decided_by: string | null;
  decided_at: string | null;
  /** 最后一次改动时刻：律师确认时带回，格子在此后被助手重填过就拒绝（复核 Q2-05）。 */
  updated_at: string;
}

const CELL_COLS = "cell_id, document_version_id, col_key, value, quote, anchor_status, note, state, lawyer_value, run_id, decided_by, decided_at, updated_at";

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function templateOf(id: unknown): TableTemplate {
  const t = TABLE_TEMPLATES.find((x) => x.id === id);
  if (!t) throw new DomainError("validation", `template 须为 ${TABLE_TEMPLATES.map((x) => x.id).join(" / ")}`, 422);
  return t;
}

function tableOut(r: any): TableRow {
  return {
    table_id: r.table_id,
    matter_id: r.matter_id,
    template: r.template,
    title: r.title,
    columns: JSON.parse(r.columns),
    document_version_ids: JSON.parse(r.document_version_ids),
    created_at: r.created_at,
  };
}

/** 最新解析是否读不出文字（读取差的材料整行不让 AI 猜）。 */
function unreadable(db: KernelDb, documentVersionId: string): boolean {
  const p = db.get<{ chars: number }>(
    `SELECT LENGTH(pt.content) AS chars FROM parse_versions pv JOIN parse_texts pt ON pt.parse_version_id = pv.parse_version_id WHERE pv.document_version_id = ? ORDER BY pv.created_at DESC LIMIT 1`,
    [documentVersionId],
  );
  return !p || p.chars < 20;
}

/** 新建表：选模板（可选用其中几列）与材料；读不出文字的材料整行先标“读取差”。 */
export function createTable(db: KernelDb, input: { tenant_id: string; matter_id: string; template?: unknown; columns?: unknown; document_version_ids?: unknown; title?: unknown; created_by: string }): TableRow {
  const t = templateOf(input.template);
  const pick = Array.isArray(input.columns) ? new Set(input.columns.map(String)) : null;
  const columns = t.columns.filter((c) => !pick || pick.has(c.key));
  if (columns.length === 0) throw new DomainError("validation", "至少选一列", 422);
  const ids = Array.isArray(input.document_version_ids) ? [...new Set(input.document_version_ids.map(String))] : [];
  if (ids.length === 0) throw new DomainError("validation", "至少选一份材料", 422);
  if (ids.length > TABLE_LIMITS.docs) throw new DomainError("validation", `一张表至多 ${TABLE_LIMITS.docs} 份材料，请分表`, 422);
  for (const id of ids) {
    const d = db.get<{ matter_id: string; quarantined_at: string | null }>(`SELECT matter_id, quarantined_at FROM document_versions WHERE document_version_id = ?`, [id]);
    if (!d || d.matter_id !== input.matter_id) throw notFound("材料");
    if (d.quarantined_at) throw new DomainError("conflict", "所选材料中有已隔离的材料（带国家秘密标志），不能用于表格审阅", 409);
  }
  const n = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM review_tables WHERE matter_id = ?`, [input.matter_id])!.n;
  if (n >= TABLE_LIMITS.tablesPerMatter) throw new DomainError("validation", `一个事项至多 ${TABLE_LIMITS.tablesPerMatter} 张表`, 422);
  const id = newId("reviewTable");
  db.tx(() => {
    db.run(`INSERT INTO review_tables (table_id, tenant_id, matter_id, template, title, columns, document_version_ids, created_by) VALUES (?,?,?,?,?,?,?,?)`, [
      id,
      input.tenant_id,
      input.matter_id,
      t.id,
      str(input.title, 60) || t.title,
      JSON.stringify(columns),
      JSON.stringify(ids),
      input.created_by,
    ]);
    for (const doc of ids.filter((d) => unreadable(db, d)))
      for (const c of columns)
        db.run(`INSERT INTO review_cells (cell_id, table_id, document_version_id, col_key, state, note) VALUES (?,?,?,?, 'unreadable', '这份材料读不出文字，未读取')`, [newId("reviewCell"), id, doc, c.key]);
  });
  return getTable(db, input.matter_id, id).table;
}

export function listTables(db: KernelDb, matterId: string): (TableRow & { cells: number; verified: number })[] {
  return db
    .all<any>(
      `SELECT t.*, (SELECT COUNT(*) FROM review_cells c WHERE c.table_id = t.table_id) AS n_cells,
              (SELECT COUNT(*) FROM review_cells c WHERE c.table_id = t.table_id AND c.state IN ('verified','edited')) AS n_ver
         FROM review_tables t WHERE t.matter_id = ? ORDER BY t.created_at DESC`,
      [matterId],
    )
    .map((r) => ({ ...tableOut(r), cells: r.n_cells, verified: r.n_ver }));
}

export function getTable(db: KernelDb, matterId: string, tableId: string): { table: TableRow; cells: CellRow[]; docs: { document_version_id: string; filename: string }[] } {
  const r = db.get<any>(`SELECT * FROM review_tables WHERE table_id = ?`, [tableId]);
  if (!r || r.matter_id !== matterId) throw notFound("表格");
  const table = tableOut(r);
  const cells = db.all<CellRow>(`SELECT ${CELL_COLS} FROM review_cells WHERE table_id = ?`, [tableId]);
  // 已隔离（国家秘密标志）的材料整行不显示、不导出、不能再填（复核 Q2-02；隔离时格子已删除）
  const docs = table.document_version_ids
    .map((id) => db.get<{ document_version_id: string; filename: string; quarantined_at: string | null }>(`SELECT document_version_id, filename, quarantined_at FROM document_versions WHERE document_version_id = ?`, [id]))
    .filter((d): d is { document_version_id: string; filename: string; quarantined_at: string | null } => !!d && !d.quarantined_at)
    .map((d) => ({ document_version_id: d.document_version_id, filename: d.filename }));
  return { table, cells, docs };
}

/** 材料的令牌化视图（与风险卡同一口径：DOCX 用段落文本，其他用最新解析文本）。 */
function viewOf(deps: { db: KernelDb; blobs: BlobStore; tokens?: MatterTokenStore }, matterId: string, documentVersionId: string): string {
  const doc = deps.db.get<{ filename: string; storage_uri: string }>(`SELECT filename, storage_uri FROM document_versions WHERE document_version_id = ?`, [documentVersionId])!;
  let plain: string | null = null;
  if (doc.filename.toLowerCase().endsWith(".docx")) {
    try {
      plain = extractParagraphs(deps.blobs.read(doc.storage_uri)).map((x) => x.text).join("\n");
    } catch {
      plain = null;
    }
  }
  plain ??=
    deps.db.get<{ content: string }>(`SELECT pt.content FROM parse_versions pv JOIN parse_texts pt ON pt.parse_version_id = pv.parse_version_id WHERE pv.document_version_id = ? ORDER BY pv.created_at DESC LIMIT 1`, [documentVersionId])?.content ??
    "";
  return deps.tokens ? deps.tokens.tokenizer(matterId).tokenize(plain).text : plain;
}

/** 格子的有效值：律师改过的用律师的值，已核用 AI 值，没找到、读取差没有值。 */
function effectiveValue(c: { state: CellState; value: string | null; lawyer_value: string | null } | undefined): string | null {
  if (!c) return null;
  if (c.state === "edited") return c.lawyer_value;
  if (c.state === "not_found" || c.state === "unreadable") return null;
  return c.value;
}

/**
 * 条件列在这一行是否适用（v9.4 第 21 批）：yes 适用；no 条件列的值不等于 equals（含没找到）——这一格不填、显示“不适用”；
 * pending 条件列还没填或还是冲突——先填条件列。
 */
export function columnApplies(col: TableColumn, condition: { state: CellState; value: string | null; lawyer_value: string | null } | undefined): "yes" | "no" | "pending" {
  if (!col.when) return "yes";
  if (!condition || condition.state === "conflict") return "pending";
  if (condition.state === "not_found") return "no";
  if (condition.state === "unreadable") return "pending";
  return effectiveValue(condition) === col.when.equals ? "yes" : "no";
}

/**
 * 条件不满足（不适用）的格子编号集合（复核 Q3-05：待核清单、推为事实、台账提醒、导出与起草同一口径）。
 * 键为“材料编号 \u0000 列编号”。
 */
export function notApplicableKeys(table: Pick<TableRow, "columns">, cells: readonly Pick<CellRow, "document_version_id" | "col_key" | "state" | "value" | "lawyer_value">[]): Set<string> {
  const out = new Set<string>();
  const conds = table.columns.filter((c) => c.when);
  if (conds.length === 0) return out;
  const at = new Map(cells.map((c) => [`${c.document_version_id}\u0000${c.col_key}`, c]));
  const docs = new Set(cells.map((c) => c.document_version_id));
  for (const d of docs) for (const col of conds) if (columnApplies(col, at.get(`${d}\u0000${col.when!.column}`)) === "no") out.add(`${d}\u0000${col.key}`);
  return out;
}

/** 按列格式核对值：日期 YYYY-MM-DD 或 YYYY-MM；金额为数字（可带币种与单位）；是否为“是 / 否”；选项须在列表里。 */
function checkFormat(c: TableColumn, value: string): string | null {
  if (c.format === "date" && !/^\d{4}-\d{2}(?:-\d{2})?$/.test(value)) return "日期写 YYYY-MM-DD，只知年月写 YYYY-MM";
  if (c.format === "yesno" && !["是", "否"].includes(value)) return "只能填“是”或“否”";
  if (c.format === "choice" && c.options && !c.options.includes(value)) return `只能填：${c.options.join(" / ")}`;
  if (c.format === "money" && !/\d/.test(value)) return "金额须含数字";
  return null;
}

/**
 * Agent 填表：逐格写值与引文。律师已核、已改的格子不覆盖（locked）；读取差的材料不收（unreadable）；
 * “找到”必须有引文，引文在该材料里定位（找不到照收、标出）；格式不对的格子拒收并说明。不整批失败：逐格回报结果。
 */
export function fillCells(
  deps: { db: KernelDb; blobs: BlobStore; tokens?: MatterTokenStore },
  scope: { matterId: string; runId: string | null },
  input: { table_id?: unknown; cells?: unknown },
): { written: number; locked: number; rejected: { document_version_id: string; column: string; reason: string }[]; quote_not_found: number; note: string } {
  const tableId = str(input.table_id, 80);
  const { table, docs: liveDocs } = getTable(deps.db, scope.matterId, tableId);
  const cells = Array.isArray(input.cells) ? input.cells : [];
  if (cells.length === 0) throw new DomainError("validation", "cells 不能为空", 422);
  if (cells.length > TABLE_LIMITS.cellsPerCall) throw new DomainError("validation", `一次至多 ${TABLE_LIMITS.cellsPerCall} 格，请分批`, 422);
  const cols = new Map(table.columns.map((c) => [c.key, c]));
  const docs = new Set(liveDocs.map((d) => d.document_version_id));
  const views = new Map<string, string>();
  const rejected: { document_version_id: string; column: string; reason: string }[] = [];
  let written = 0;
  let locked = 0;
  let notFoundQuotes = 0;
  deps.db.tx(() => {
    for (const raw of cells as any[]) {
      const doc = str(raw?.document_version_id, 80);
      const key = str(raw?.column, 40);
      const col = cols.get(key);
      const reject = (reason: string) => rejected.push({ document_version_id: doc, column: key, reason });
      if (!docs.has(doc)) {
        reject("这份材料不在表里");
        continue;
      }
      if (!col) {
        reject("没有这一列");
        continue;
      }
      const status = ["found", "not_found", "conflict"].includes(raw?.status) ? (raw.status as string) : "found";
      const value = str(raw?.value, TABLE_LIMITS.value);
      const quote = str(raw?.quote, TABLE_LIMITS.quote);
      const note = str(raw?.note, 400) || null;
      const existing = deps.db.get<{ cell_id: string; state: CellState }>(`SELECT cell_id, state FROM review_cells WHERE table_id = ? AND document_version_id = ? AND col_key = ?`, [tableId, doc, key]);
      if (existing && LOCKED.has(existing.state)) {
        locked++;
        continue;
      }
      if (col.when) {
        // 条件列：按同一行条件列的当前值判断（同一批里先填的条件格也算）
        const cond = deps.db.get<{ state: CellState; value: string | null; lawyer_value: string | null }>(`SELECT state, value, lawyer_value FROM review_cells WHERE table_id = ? AND document_version_id = ? AND col_key = ?`, [tableId, doc, col.when.column]);
        const ok = columnApplies(col, cond);
        const condLabel = cols.get(col.when.column)?.label ?? col.when.column;
        if (ok === "pending") {
          reject(`这一列只在“${condLabel}”为“${col.when.equals}”时填：先填“${condLabel}”（同一批里放在前面）`);
          continue;
        }
        if (ok === "no") {
          reject(`“${condLabel}”不是“${col.when.equals}”，这一格不适用，不用填`);
          continue;
        }
      }
      if (existing?.state === "unreadable") {
        // 材料重新识别后能读了（复核 Q2-10）：解锁这一格；仍读不出的照旧不收
        if (unreadable(deps.db, doc)) {
          reject("这份材料读不出文字：不填，留给律师看原件");
          continue;
        }
      }
      let state: CellState;
      let anchor: string | null = null;
      if (status === "not_found") {
        state = "not_found";
      } else {
        if (!value) {
          reject("找到的格子要写值");
          continue;
        }
        const bad = checkFormat(col, value);
        if (bad) {
          reject(bad);
          continue;
        }
        if (!quote) {
          reject("找到的格子要附逐字引文（quote），律师据此回原文核对");
          continue;
        }
        if (!views.has(doc)) views.set(doc, viewOf(deps, scope.matterId, doc));
        anchor = locateQuote(views.get(doc)!, quote).status;
        if (anchor === "not_found") notFoundQuotes++;
        state = status === "conflict" ? "conflict" : "ai";
      }
      const args = [status === "not_found" ? null : value, status === "not_found" ? null : quote, anchor, note, state, state, scope.runId];
      if (existing)
        deps.db.run(`UPDATE review_cells SET value = ?, quote = ?, anchor_status = ?, note = ?, state = ?, ai_state = ?, run_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE cell_id = ?`, [...args, existing.cell_id]);
      else
        deps.db.run(`INSERT INTO review_cells (cell_id, table_id, document_version_id, col_key, value, quote, anchor_status, note, state, ai_state, run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [newId("reviewCell"), tableId, doc, key, ...args]);
      written++;
    }
  });
  const notes = [`写入 ${written} 格`];
  if (locked) notes.push(`${locked} 格律师已核或已改，未覆盖`);
  if (rejected.length) notes.push(`${rejected.length} 格未收（见 rejected，按原因改正后重填）`);
  if (notFoundQuotes) notes.push(`${notFoundQuotes} 格的引文在材料里找不到：请改为逐字摘录后重填，否则律师只能手工核对`);
  return { written, locked, rejected: rejected.slice(0, 100), quote_not_found: notFoundQuotes, note: notes.join("；") };
}

/** 律师核格：确认（verify）/ 改值（edit，原 AI 值保留）/ 撤回（reset，回到 AI 值，可被重跑覆盖）。 */
export function decideCell(db: KernelDb, matterId: string, userId: string, input: { table_id?: unknown; cell_id?: unknown; document_version_id?: unknown; column?: unknown; decision?: unknown; value?: unknown; expected_updated_at?: unknown }): CellRow {
  const tableId = str(input.table_id, 80);
  const { table, docs } = getTable(db, matterId, tableId);
  let cell = input.cell_id ? db.get<any>(`SELECT * FROM review_cells WHERE cell_id = ? AND table_id = ?`, [str(input.cell_id, 80), tableId]) : null;
  const decision = String(input.decision ?? "");
  if (!cell && decision === "edit") {
    // 律师直接填一个空格子（AI 还没填或没找到）
    const doc = str(input.document_version_id, 80);
    const key = str(input.column, 40);
    if (!docs.some((d) => d.document_version_id === doc) || !table.columns.some((c) => c.key === key)) throw notFound("格子");
    cell = db.get<any>(`SELECT * FROM review_cells WHERE table_id = ? AND document_version_id = ? AND col_key = ?`, [tableId, doc, key]);
    if (!cell) {
      const id = newId("reviewCell");
      db.run(`INSERT INTO review_cells (cell_id, table_id, document_version_id, col_key, state) VALUES (?,?,?,?, 'not_found')`, [id, tableId, doc, key]);
      cell = db.get<any>(`SELECT * FROM review_cells WHERE cell_id = ?`, [id]);
    }
  }
  if (!cell) throw notFound("格子");
  if (!docs.some((d) => d.document_version_id === cell.document_version_id)) throw notFound("格子");
  // 律师看着的是哪一版（复核 Q2-05）：这格在律师打开后被助手重填过，就不能把没看到的新值标成“已核”
  if (typeof input.expected_updated_at === "string" && input.expected_updated_at && input.expected_updated_at !== cell.updated_at)
    throw new DomainError("conflict", "这一格刚被助手更新过，请重新核对后再确认", 409);
  const now = new Date().toISOString();
  if (decision === "verify") {
    if (cell.state === "unreadable" || cell.state === "not_found") {
      // “确认没有”：律师核过原件，确实没有这一项
      db.run(`UPDATE review_cells SET state = 'verified', lawyer_value = NULL, decided_by = ?, decided_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE cell_id = ?`, [userId, now, cell.cell_id]);
    } else db.run(`UPDATE review_cells SET state = 'verified', decided_by = ?, decided_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE cell_id = ?`, [userId, now, cell.cell_id]);
  } else if (decision === "edit") {
    const value = str(input.value, TABLE_LIMITS.value);
    if (!value) throw new DomainError("validation", "改值要填写新的值", 422);
    const col = table.columns.find((c) => c.key === cell.col_key)!;
    const bad = checkFormat(col, value);
    if (bad) throw new DomainError("validation", bad, 422);
    db.run(`UPDATE review_cells SET state = 'edited', lawyer_value = ?, decided_by = ?, decided_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE cell_id = ?`, [value, userId, now, cell.cell_id]);
  } else if (decision === "reset") {
    // 回到助手最后一次填写时的状态（“有冲突”不丢，复核 Q2-09）；助手没填过的按材料能否读取判断
    const back: CellState = cell.ai_state ?? (cell.value ? "ai" : unreadable(db, cell.document_version_id) ? "unreadable" : "not_found");
    db.run(`UPDATE review_cells SET state = ?, lawyer_value = NULL, decided_by = NULL, decided_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE cell_id = ?`, [back, cell.cell_id]);
  } else throw new DomainError("validation", "decision 须为 verify / edit / reset", 422);
  return db.get<CellRow>(`SELECT ${CELL_COLS} FROM review_cells WHERE cell_id = ?`, [cell.cell_id])!;
}

/** Agent 读表：列与填写说明、材料、每格状态（锁定的给出律师的值，便于综合时引用）。 */
export function tableForAgent(db: KernelDb, matterId: string, tableId: string) {
  const { table, cells, docs } = getTable(db, matterId, tableId);
  return {
    table_id: table.table_id,
    title: table.title,
    columns: table.columns.map((c) => ({ column: c.key, label: c.label, format: c.format, ...(c.options ? { options: c.options } : {}), hint: c.hint, ...(c.when ? { only_when: c.when } : {}) })),
    documents: docs.map((d) => ({ document_version_id: d.document_version_id, filename: d.filename, unreadable: cells.some((c) => c.document_version_id === d.document_version_id && c.state === "unreadable") })),
    cells: cells.map((c) => ({
      document_version_id: c.document_version_id,
      column: c.col_key,
      state: c.state,
      locked: LOCKED.has(c.state),
      value: c.state === "edited" ? c.lawyer_value : c.value,
      // 问表模式（v9.4 第 21 批）按格子的引文作答；律师改过的值没有引文
      ...(c.quote && c.state !== "edited" ? { quote: c.quote } : {}),
    })),
    note: "locked=true 的格子律师已核或已改，不要重填；unreadable 的材料不填。每格写 value 与逐字 quote（摘自该材料，含代号原样）；文件里确实没有的写 status=not_found；同一份材料两处说法不一的写 status=conflict 并在 note 写明两处。带 only_when 的是条件列：只在同一行 only_when.column 的值等于 only_when.equals 时填，先填条件列（同一批里放在前面），条件不满足的不填。",
  };
}

const STATE_TEXT: Readonly<Record<CellState, string>> = { ai: "【待核】", not_found: "未找到", unreadable: "读取差，未读", conflict: "【有冲突，待核】", verified: "", edited: "" };

/** 导出 Excel（草稿成果，下载时还原代号）：律师已核、已改的照写；AI 值标“【待核】”。 */
export function exportTable(deps: { db: KernelDb; blobs: BlobStore; tokens: MatterTokenStore }, matterId: string, tableId: string, createdBy: string): { artifact_version_id: string; filename: string; rows: number } {
  const { table, cells, docs } = getTable(deps.db, matterId, tableId);
  const at = new Map(cells.map((c) => [`${c.document_version_id}\u0000${c.col_key}`, c]));
  const header = ["材料", ...table.columns.map((c) => c.label)];
  const rows = docs.map((d) => [
    d.filename,
    ...table.columns.map((c) => {
      const cell = at.get(`${d.document_version_id}\u0000${c.key}`);
      if (c.when && columnApplies(c, at.get(`${d.document_version_id}\u0000${c.when.column}`)) === "no") return "不适用";
      if (!cell) return "未填";
      if (cell.state === "edited") return deps.tokens.tokenize(matterId, cell.lawyer_value ?? "").text;
      if (cell.state === "verified") return cell.value ?? "（律师确认：没有）";
      if (cell.state === "not_found" || cell.state === "unreadable") return STATE_TEXT[cell.state];
      return `${cell.value ?? ""}${STATE_TEXT[cell.state]}`;
    }),
  ]);
  const verified = cells.filter((c) => LOCKED.has(c.state)).length;
  const buf = createXlsx([{ name: table.title.slice(0, 31) || "表格", rows: [header, ...rows] }]);
  const matter = deps.db.get<{ tenant_id: string }>(`SELECT tenant_id FROM matters WHERE matter_id = ?`, [matterId])!;
  const stored = deps.blobs.put(buf, matterId);
  const id = newId("artifactVersion");
  const filename = `${table.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").slice(0, 40) || "表格"}（表格审阅）.xlsx`;
  deps.db.tx(() => {
    const v = deps.db.get<{ next: number }>(`SELECT COALESCE(MAX(version), 0) + 1 AS next FROM artifact_versions WHERE matter_id = ? AND kind = 'review_grid' AND audience = 'internal'`, [matterId])!;
    deps.db.run(
      `INSERT INTO artifact_versions (artifact_version_id, tenant_id, matter_id, run_id, kind, version, baseline_id, audience, status, filename, sha256, storage_uri, open_items, manifest, created_by)
       VALUES (?,?,?,NULL,'review_grid',?,NULL,'internal','draft',?,?,?,'[]',?,?)`,
      [id, matter.tenant_id, matterId, v.next, filename, stored.sha256, stored.storage_uri, JSON.stringify({ table_id: tableId, template: table.template, documents: docs.length, columns: table.columns.length, verified_cells: verified, cells_sha256: sha256Hex(JSON.stringify(cells.map((c) => [c.cell_id, c.state]))) }), createdBy],
    );
  });
  return { artifact_version_id: id, filename, rows: docs.length };
}

// ─── v9.4 第 20 批：C-01 残余（评审 C1 §3.3）──────────────────────────────────────────────

const FORMATS: readonly ColumnFormat[] = ["text", "date", "money", "yesno", "choice"];

/**
 * 律师自己加一列（C1 §1 #12：用一句话建列，列有格式）：列名、填写说明（给助手看，必填）、格式（日期 / 金额 / 是否 / 分类 / 文字），分类要给选项。
 * 至多 15 列；列编号 custom_n。新列对已有材料都是空格，“让助手填表”时一并填。
 */
export function addColumn(db: KernelDb, matterId: string, tableId: string, input: { label?: unknown; hint?: unknown; format?: unknown; options?: unknown; when?: unknown }): TableRow {
  const { table } = getTable(db, matterId, tableId);
  const label = str(input.label, 20);
  const hint = str(input.hint, 200);
  const format = String(input.format ?? "text") as ColumnFormat;
  if (!label) throw new DomainError("validation", "请写列名", 422);
  if (!hint) throw new DomainError("validation", "请写这一列要助手找什么、找不到时写什么（填写说明）", 422);
  if (!FORMATS.includes(format)) throw new DomainError("validation", `格式须为 ${FORMATS.join(" / ")}`, 422);
  if (table.columns.some((c) => c.label === label)) throw new DomainError("validation", "已有同名的列", 422);
  if (table.columns.length >= TABLE_LIMITS.columns) throw new DomainError("validation", `一张表至多 ${TABLE_LIMITS.columns} 列`, 422);
  let options: string[] | undefined;
  if (format === "choice") {
    options = (Array.isArray(input.options) ? input.options : []).map((o) => str(o, 20)).filter(Boolean);
    options = [...new Set(options)];
    if (options.length < 2 || options.length > 10) throw new DomainError("validation", "分类列要给 2～10 个选项", 422);
  }
  // 条件列（v9.4 第 21 批）：条件只能挂在本表的是否列或分类列上，且条件列本身不能再带条件（不做连环条件）
  let when: TableColumn["when"];
  if (input.when !== undefined && input.when !== null) {
    const w = input.when as { column?: unknown; equals?: unknown };
    const on = table.columns.find((c) => c.key === str(w?.column, 40));
    const equals = str(w?.equals, 20);
    if (!on) throw new DomainError("validation", "条件里的列不在这张表里", 422);
    if (on.format !== "yesno" && on.format !== "choice") throw new DomainError("validation", "条件只能按“是 / 否”列或分类列来定", 422);
    if (on.when) throw new DomainError("validation", "条件列本身带条件：请按不带条件的列来定", 422);
    const allowed = on.format === "yesno" ? ["是", "否"] : [...(on.options ?? [])];
    if (!allowed.includes(equals)) throw new DomainError("validation", `条件的值只能是：${allowed.join(" / ")}`, 422);
    when = { column: on.key, equals };
  }
  const n = Math.max(0, ...table.columns.map((c) => (/^custom_(\d+)$/.exec(c.key) ? Number(/^custom_(\d+)$/.exec(c.key)![1]) : 0))) + 1;
  const col: TableColumn = { key: `custom_${n}`, label, format, hint, ...(options ? { options } : {}), ...(when ? { when } : {}) };
  db.run(`UPDATE review_tables SET columns = ? WHERE table_id = ?`, [JSON.stringify([...table.columns, col]), tableId]);
  return getTable(db, matterId, tableId).table;
}

/** 去掉律师自己加的列（模板列不能去）；这一列已核、已改的格子一并删除——须明确确认。 */
export function removeColumn(db: KernelDb, matterId: string, tableId: string, key: string, confirm: boolean): TableRow {
  const { table } = getTable(db, matterId, tableId);
  if (!/^custom_\d+$/.test(key) || !table.columns.some((c) => c.key === key)) throw new DomainError("validation", "只能去掉自己加的列", 422);
  const dependent = table.columns.filter((c) => c.when?.column === key);
  if (dependent.length > 0) throw new DomainError("conflict", `“${dependent.map((c) => c.label).join("、")}”按这一列定是否适用：先去掉那几列`, 409);
  const locked = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM review_cells WHERE table_id = ? AND col_key = ? AND state IN ('verified','edited')`, [tableId, key])!.n;
  if (locked > 0 && !confirm) throw new DomainError("conflict", `这一列有 ${locked} 格你已核或已改：确认后一并删除`, 409, { locked });
  db.tx(() => {
    db.run(`DELETE FROM review_cells WHERE table_id = ? AND col_key = ?`, [tableId, key]);
    db.run(`UPDATE review_tables SET columns = ? WHERE table_id = ?`, [JSON.stringify(table.columns.filter((c) => c.key !== key)), tableId]);
  });
  return getTable(db, matterId, tableId).table;
}

/**
 * 格子点开看原文（C1 §3.3“角标：点开在右侧预览原文并高亮那一段”）：引文在材料里的前后各约 200 字（令牌形态，界面还原）；
 * 找不到引文时 located=false，只给引文本身。
 */
export function cellContext(deps: { db: KernelDb; blobs: BlobStore; tokens?: MatterTokenStore }, matterId: string, tableId: string, cellId: string): { located: boolean; before: string; quote: string; after: string; filename: string } {
  const { docs } = getTable(deps.db, matterId, tableId);
  const cell = deps.db.get<any>(`SELECT * FROM review_cells WHERE cell_id = ? AND table_id = ?`, [cellId, tableId]);
  if (!cell || !docs.some((d) => d.document_version_id === cell.document_version_id)) throw notFound("格子");
  const filename = docs.find((d) => d.document_version_id === cell.document_version_id)!.filename;
  const quote = String(cell.quote ?? "");
  if (!quote) return { located: false, before: "", quote: "", after: "", filename };
  const view = viewOf(deps, matterId, cell.document_version_id);
  const loc = locateQuote(view, quote);
  if (loc.start === null || loc.end === null) return { located: false, before: "", quote, after: "", filename };
  const a = Math.max(0, loc.start - 200);
  const b = Math.min(view.length, loc.end + 200);
  return { located: true, before: (a > 0 ? "…" : "") + view.slice(a, loc.start), quote: view.slice(loc.start, loc.end), after: view.slice(loc.end, b) + (b < view.length ? "…" : ""), filename };
}

/** 格子写成一句事实：“《采购合同》签署日：2026-03-01”；律师改过的用律师的值（令牌化后存，与事实行同一形态）。 */
function cellStatement(deps: { tokens?: MatterTokenStore }, matterId: string, col: TableColumn, filename: string, cell: any): string {
  const v = cell.state === "edited" ? (deps.tokens ? deps.tokens.tokenize(matterId, cell.lawyer_value ?? "").text : (cell.lawyer_value ?? "")) : (cell.value ?? "确认没有");
  return `${filename.replace(/\.[^.]+$/, "")}：${col.label}为${v}`.slice(0, 1000);
}

/**
 * 推为事实（C1 §3.3）：只推律师已核、已改的格子，作为律师已确认的事实行进“事实”标签（与事实确认流同一张表，不另起一套）；
 * 日期列的值写进事实日期（只到月的照写）；已推过的不重复推。返回新推的条数与跳过的原因。
 */
export function pushCellsToFacts(deps: { db: KernelDb; blobs: BlobStore; tokens?: MatterTokenStore }, scope: { tenantId: string; matterId: string; userId: string }, tableId: string, cellIds?: unknown): { pushed: number; already: number; not_verified: number } {
  const { table, cells, docs } = getTable(deps.db, scope.matterId, tableId);
  const want = Array.isArray(cellIds) ? new Set(cellIds.map(String)) : null;
  // 不适用的格子（条件不满足）不推（复核 Q3-05）
  const na = notApplicableKeys(table, cells);
  const picked = cells.filter((c) => (!want || want.has(c.cell_id)) && !na.has(`${c.document_version_id}\u0000${c.col_key}`));
  let pushed = 0;
  let already = 0;
  let notVerified = 0;
  deps.db.tx(() => {
    const base = deps.db.get<{ mx: number | null }>(`SELECT MAX(seq) AS mx FROM matter_facts WHERE matter_id = ? AND run_id IS NULL`, [scope.matterId])!.mx ?? 0;
    for (const c of picked) {
      const row = deps.db.get<any>(`SELECT * FROM review_cells WHERE cell_id = ?`, [c.cell_id])!;
      if (row.state !== "verified" && row.state !== "edited") {
        notVerified += 1;
        continue;
      }
      if (row.fact_id && deps.db.get(`SELECT 1 AS x FROM matter_facts WHERE fact_id = ?`, [row.fact_id])) {
        already += 1;
        continue;
      }
      const col = table.columns.find((x) => x.key === row.col_key);
      const doc = docs.find((d) => d.document_version_id === row.document_version_id);
      if (!col || !doc) continue;
      const value = row.state === "edited" ? String(row.lawyer_value ?? "") : String(row.value ?? "");
      const occurredOn = col.format === "date" && /^\d{4}-\d{2}(?:-\d{2})?$/.test(value) ? value : null;
      const loc = row.quote ? locateQuote(viewOf(deps, scope.matterId, row.document_version_id), row.quote) : { status: "not_found", start: null, end: null };
      const id = newId("fact");
      const now = new Date().toISOString();
      pushed += 1;
      deps.db.run(
        `INSERT INTO matter_facts (fact_id, tenant_id, matter_id, run_id, seq, statement, kind, occurred_on, amount_yuan, party, document_version_id, quote, anchor_start, anchor_end, anchor_status, status, decided_by, decided_at)
         VALUES (?,?,?,NULL,?,?, 'confirmed', ?, NULL, NULL, ?,?,?,?,?, 'confirmed', ?, ?)`,
        [id, scope.tenantId, scope.matterId, base + pushed, cellStatement(deps, scope.matterId, col, doc.filename, row), occurredOn, row.document_version_id, row.quote ?? null, loc.start, loc.end, row.quote ? loc.status : "not_found", scope.userId, now],
      );
      deps.db.run(`UPDATE review_cells SET fact_id = ? WHERE cell_id = ?`, [id, row.cell_id]);
    }
  });
  return { pushed, already, not_verified: notVerified };
}

/**
 * 据此起草（C1 §3.3）：证据清单 → 证据目录（Word）；合同尽调摘要 → 尽调发现草稿（Word）。只用律师已核、已改的格子，
 * 没核的照写但标“【待核】”，没找到、读取差如实写；成果是草稿，按普通成果复核签发。合同台账见 ledgerReminderCandidates。
 */
export function draftFromTable(deps: { db: KernelDb; blobs: BlobStore; tokens: MatterTokenStore }, matterId: string, tableId: string, createdBy: string): { artifact_version_id: string; filename: string; open: number } {
  const { table, cells, docs } = getTable(deps.db, matterId, tableId);
  if (table.template === "contract_ledger") throw new DomainError("validation", "合同台账用“据此设提醒”：逐条确认后创建期限提醒", 422);
  const at = new Map(cells.map((c) => [`${c.document_version_id}\u0000${c.col_key}`, c]));
  let open = 0;
  const text = (docId: string, key: string): string => {
    const col = table.columns.find((x) => x.key === key);
    if (col?.when && columnApplies(col, at.get(`${docId}\u0000${col.when.column}`)) === "no") return "不适用";
    const c = at.get(`${docId}\u0000${key}`);
    if (!c) {
      open += 1;
      return "【未填】";
    }
    if (c.state === "edited") return deps.tokens.tokenize(matterId, c.lawyer_value ?? "").text;
    if (c.state === "verified") return c.value ?? "（经核没有）";
    if (c.state === "not_found") {
      open += 1;
      return "【没找到，待核】";
    }
    if (c.state === "unreadable") {
      open += 1;
      return "【读取差，待核原件】";
    }
    open += 1;
    return `${c.value ?? ""}${STATE_TEXT[c.state]}`;
  };
  const blocks: DocBlock[] = [];
  let title: string;
  if (table.template === "evidence_list") {
    title = "证据目录";
    blocks.push({ kind: "title", text: title });
    const head = ["序号", ...table.columns.map((c) => c.label)];
    blocks.push({ kind: "table", rows: [head.map((h) => [{ text: h, bold: true }]), ...docs.map((d, i) => [[{ text: String(i + 1) }], ...table.columns.map((c) => [{ text: text(d.document_version_id, c.key) }])])] });
  } else {
    title = "尽职调查发现（合同部分，内部稿）";
    blocks.push({ kind: "title", text: title });
    docs.forEach((d, i) => {
      blocks.push({ kind: "h1", text: `${i + 1}. ${d.filename.replace(/\.[^.]+$/, "")}` });
      for (const c of table.columns) blocks.push({ kind: "p", runs: [{ text: `${c.label}：`, bold: true }, { text: text(d.document_version_id, c.key) }] });
    });
  }
  blocks.push({ kind: "p", runs: [{ text: open > 0 ? `说明：本稿依据审阅表《${table.title}》生成，其中 ${open} 处律师尚未核对，已标“待核”，签发前须逐项核对。` : `说明：本稿依据审阅表《${table.title}》生成，所列内容均经律师逐格核对。` }] });
  const buf = createStyledDocx(blocks);
  const matter = deps.db.get<{ tenant_id: string }>(`SELECT tenant_id FROM matters WHERE matter_id = ?`, [matterId])!;
  const stored = deps.blobs.put(buf, matterId);
  const id = newId("artifactVersion");
  const kind = table.template === "evidence_list" ? "evidence_index" : "dd_findings";
  const filename = `${title.replace(/（.*）/, "")}（${table.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").slice(0, 30)}）.docx`;
  const openItems = open > 0 ? [{ kind: "table_cells_unverified", count: open, note: `${open} 处来自审阅表的内容律师尚未核对` }] : [];
  deps.db.tx(() => {
    const v = deps.db.get<{ next: number }>(`SELECT COALESCE(MAX(version), 0) + 1 AS next FROM artifact_versions WHERE matter_id = ? AND kind = ? AND audience = 'internal'`, [matterId, kind])!;
    deps.db.run(
      `INSERT INTO artifact_versions (artifact_version_id, tenant_id, matter_id, run_id, kind, version, baseline_id, audience, status, filename, sha256, storage_uri, open_items, manifest, created_by)
       VALUES (?,?,?,NULL,?,?,NULL,'internal','draft',?,?,?,?,?,?)`,
      [id, matter.tenant_id, matterId, kind, v.next, filename, stored.sha256, stored.storage_uri, JSON.stringify(openItems), JSON.stringify({ table_id: tableId, template: table.template, documents: docs.length, open_cells: open }), createdBy],
    );
  });
  return { artifact_version_id: id, filename, open };
}

/**
 * 合同台账 → 期限提醒的候选（C1 §3.3“逐条确认后创建”）：到期日列每份一条（律师已核、已改的才可勾选创建；
 * 只到月或已过的不给日期，律师自己填）。不在这里创建：界面逐条确认后经 reminders.create 创建。
 */
export function ledgerReminderCandidates(db: KernelDb, matterId: string, tableId: string, today: string): { document_version_id: string; filename: string; column: string; label: string; date: string | null; verified: boolean; note: string }[] {
  const { table, cells, docs } = getTable(db, matterId, tableId);
  if (table.template !== "contract_ledger") throw new DomainError("validation", "只有合同台账可以据此设提醒", 422);
  const dateCols = table.columns.filter((c) => c.format === "date" && c.key !== "signed_on");
  const out: ReturnType<typeof ledgerReminderCandidates> = [];
  const na = notApplicableKeys(table, cells);
  for (const d of docs)
    for (const col of dateCols) {
      if (na.has(`${d.document_version_id}\u0000${col.key}`)) continue;
      const c = cells.find((x) => x.document_version_id === d.document_version_id && x.col_key === col.key);
      const v = c ? (c.state === "edited" ? c.lawyer_value : c.value) : null;
      if (!c || !v) continue;
      const full = /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
      out.push({
        document_version_id: d.document_version_id,
        filename: d.filename,
        column: col.key,
        label: col.label,
        date: full && full > today ? full : null,
        verified: c.state === "verified" || c.state === "edited",
        note: !full ? "只到月：请自己填具体日期" : full <= today ? "已经过了" : "",
      });
    }
  return out;
}
