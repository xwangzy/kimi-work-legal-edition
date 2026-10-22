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
import { createXlsx, extractParagraphs } from "@zr-legal/docx-engine";
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

export const TABLE_LIMITS = { docs: 200, cellsPerCall: 400, value: 1_000, quote: 1_000, tablesPerMatter: 50 } as const;

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
    columns: table.columns.map((c) => ({ column: c.key, label: c.label, format: c.format, ...(c.options ? { options: c.options } : {}), hint: c.hint })),
    documents: docs.map((d) => ({ document_version_id: d.document_version_id, filename: d.filename, unreadable: cells.some((c) => c.document_version_id === d.document_version_id && c.state === "unreadable") })),
    cells: cells.map((c) => ({
      document_version_id: c.document_version_id,
      column: c.col_key,
      state: c.state,
      locked: LOCKED.has(c.state),
      value: c.state === "edited" ? c.lawyer_value : c.value,
    })),
    note: "locked=true 的格子律师已核或已改，不要重填；unreadable 的材料不填。每格写 value 与逐字 quote（摘自该材料，含代号原样）；文件里确实没有的写 status=not_found；同一份材料两处说法不一的写 status=conflict 并在 note 写明两处。",
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
