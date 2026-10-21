/**
 * Agent 可调用的结构化产出与材料目录工具（2026-10-13 审计 D2；历史 Demo 融合方案 §3.3）：
 *   materials.list      本任务的材料目录（解析版本、字数、页数、识别质量、快照序号）——覆盖清单与“未读取”声明的依据
 *   riskcards.submit    提交风险卡（锚点在文档令牌化视图中定位；依据离线核验）→ 审查工作台
 *   riskcards.list      读取风险卡（例如只取律师已接受的卡写修订稿）
 *   facts.submit        提交事实行（材料声称 / 推论 / 待确认；Agent 不能标“律师确认”）
 *   facts.list          读取事实行（文书与汇报只引用律师确认的事实）
 *   xlsx.render_table   按列生成 Excel 表格，登记为本任务的草稿成果（统一格式，不用执行域里拼表）
 *
 * 事项与任务一律取自端点按任务记录派生的身份（claims.mid / claims.rid；local-server toolClaims），不采信参数里的事项。
 * 结果交回 Agent 前由本机端点按事项令牌化（local-server tokenizeToolResult）。
 */
import { DomainError, newId, notFound } from "@zr-legal/domain";
import { createXlsx } from "@zr-legal/docx-engine";
import type { InvokeCtx } from "../registry.ts";
import { changesDocument, listFacts, listRiskCards, submitFacts, submitRiskCards, riskCardProgress } from "../../services/review-cards.ts";

function scopeOf(ctx: InvokeCtx): { tenantId: string; matterId: string; runId: string | null } {
  const mid = ctx.claims.mid;
  if (!mid) throw new DomainError("forbidden", "令牌未绑定事项", 403);
  return { tenantId: String(ctx.claims.tid ?? ""), matterId: mid, runId: typeof ctx.claims.rid === "string" ? ctx.claims.rid : null };
}

/** 本任务的材料目录：任务选定的材料（按快照顺序编号，与工作区 materials/NNN-文件名.txt 对应）+ 事项内其他材料（未随本任务提供）。 */
export function materialsList(ctx: InvokeCtx) {
  const s = scopeOf(ctx);
  let selected: string[] = [];
  if (s.runId) {
    const run = ctx.db.get<{ input_snapshot: string | null; matter_id: string }>(`SELECT input_snapshot, matter_id FROM runs WHERE run_id = ?`, [s.runId]);
    if (run && run.matter_id === s.matterId) {
      try {
        const snap = typeof run.input_snapshot === "string" ? JSON.parse(run.input_snapshot) : run.input_snapshot;
        selected = Array.isArray(snap?.document_version_ids) ? snap.document_version_ids.map(String) : [];
      } catch {
        selected = [];
      }
    }
  }
  const docs = ctx.db.all<{ document_version_id: string; filename: string; mime: string; created_at: string; superseded: number }>(
    `SELECT dv.document_version_id, dv.filename, dv.mime, dv.created_at,
            (SELECT COUNT(*) FROM document_versions n WHERE n.supersedes = dv.document_version_id) AS superseded
       FROM document_versions dv WHERE dv.matter_id = ? AND dv.quarantined_at IS NULL ORDER BY dv.created_at`,
    [s.matterId],
  );
  const latestParse = (docId: string) =>
    ctx.db.get<{ parse_version_id: string; page_count: number | null; quality_flags: string; chars: number }>(
      `SELECT pv.parse_version_id, pv.page_count, pv.quality_flags, LENGTH(pt.content) AS chars
         FROM parse_versions pv JOIN parse_texts pt ON pt.parse_version_id = pv.parse_version_id
        WHERE pv.document_version_id = ? ORDER BY pv.created_at DESC LIMIT 1`,
      [docId],
    );
  let snapshotIndex = 0;
  const index = new Map<string, number>();
  for (const id of selected) if (docs.some((d) => d.document_version_id === id) && latestParse(id)) index.set(id, ++snapshotIndex);
  const out = docs.map((d) => {
    const p = latestParse(d.document_version_id);
    let flags: string[] = [];
    try {
      flags = p ? JSON.parse(p.quality_flags ?? "[]") : [];
    } catch {
      flags = [];
    }
    const low = p
      ? ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM parse_pages WHERE parse_version_id = ? AND quality != 'ok'`, [p.parse_version_id])?.n ?? 0
      : 0;
    const quality = !p ? "unreadable" : low > 0 ? "partial" : flags.some((f) => /ocr/i.test(f)) ? "ocr" : "ok";
    return {
      document_version_id: d.document_version_id,
      parse_version_id: p?.parse_version_id ?? null,
      filename: d.filename,
      in_this_task: index.has(d.document_version_id),
      snapshot_index: index.get(d.document_version_id) ?? null,
      chars: p?.chars ?? 0,
      page_count: p?.page_count ?? null,
      quality,
      pages_with_issues: low,
      superseded: d.superseded > 0,
    };
  });
  return {
    materials: out,
    note:
      "in_this_task=true 的材料已作为快照放在工作区 materials/ 目录（文件名以 snapshot_index 三位序号开头）；其他材料可用 materials.read_excerpt 按 parse_version_id 读取。" +
      "quality 为 partial/unreadable 的材料存在识别不全的页，结论中须如实说明未读取的范围。",
  };
}

export function riskcardsSubmit(ctx: InvokeCtx, p: { document_version_id?: string; cards: unknown[] }) {
  return submitRiskCards({ db: ctx.db, blobs: ctx.blobs, ...(ctx.tokens ? { tokens: ctx.tokens } : {}), lawdb: ctx.lawdb }, scopeOf(ctx), p);
}

export function riskcardsList(ctx: InvokeCtx, p: { document_version_id?: string; status?: string[]; this_task_only?: boolean }) {
  const s = scopeOf(ctx);
  const cards = listRiskCards(ctx.db, s.matterId, {
    ...(p.document_version_id ? { document_version_id: p.document_version_id } : {}),
    ...(p.status ? { status: p.status } : {}),
    ...(p.this_task_only && s.runId ? { run_id: s.runId } : {}),
  });
  return {
    progress: riskCardProgress(cards),
    cards: cards.map((c) => ({
      card_id: c.card_id,
      document_version_id: c.document_version_id,
      clause_ref: c.clause_ref,
      anchor_text: c.anchor_text,
      anchor_status: c.anchor_status,
      severity: c.severity,
      category: c.category,
      issue: c.issue,
      basis: c.basis.map((b) => ({ law: b.law, article: b.article, check: b.check })),
      nature: c.nature,
      nature_inferred: c.nature_inferred,
      suggestion: c.suggestion,
      fallback: c.fallback,
      bottom_line: c.bottom_line,
      needs_client_decision: c.needs_client_decision,
      // 没有建议文本的“接受”是知悉、不改动（复核 C-B07）：单独标出，不能当成“我方提出过的修改”
      lawyer_status: c.status === "accepted" && !(c.suggestion ?? "").trim() ? "acknowledged" : c.status,
      changes_document: changesDocument(c),
      lawyer_text: c.final_text,
    })),
  };
}

export function factsSubmit(ctx: InvokeCtx, p: { facts: unknown[] }) {
  return submitFacts({ db: ctx.db, blobs: ctx.blobs, ...(ctx.tokens ? { tokens: ctx.tokens } : {}) }, scopeOf(ctx), p);
}

export function factsList(ctx: InvokeCtx, p: { confirmed_only?: boolean }) {
  const s = scopeOf(ctx);
  const rows = listFacts(ctx.db, s.matterId, p.confirmed_only ? { status: ["confirmed"] } : { status: ["proposed", "confirmed"] });
  return {
    facts: rows.map((f) => ({
      fact_id: f.fact_id,
      statement: f.statement,
      kind: f.kind,
      occurred_on: f.occurred_on,
      amount_yuan: f.amount_yuan,
      party: f.party,
      document_version_id: f.document_version_id,
      quote: f.quote,
      anchor_status: f.anchor_status,
      lawyer_status: f.status,
    })),
    note: "只有 lawyer_status=confirmed 的事实可以写进文书与汇报；其余须在交付件中标为“待律师确认”。",
  };
}

const MAX_SHEETS = 5;
const MAX_COLS = 40;
const MAX_ROWS = 5_000;
const MAX_CELL = 2_000;

/** 文件名里只保留安全字符（令牌形态的代号保留；导出时还原的是文件内容，文件名按原样）。 */
function safeTitle(t: string): string {
  const s = t.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").trim().slice(0, 60);
  return s || "表格";
}

/** 登记为本任务的草稿成果（版本按 事项+kind+audience 递增；同一任务内同内容去重——别的任务生成同样内容时本任务另有自己的成果行，复核 B3-B03）。 */
export function registerToolArtifact(
  ctx: InvokeCtx,
  art: { kind: string; filename: string; sha256: string; storage_uri: string; manifest: Record<string, unknown> },
): { artifact_version_id: string; filename: string; reused: boolean } {
  const s = scopeOf(ctx);
  if (!s.runId) throw new DomainError("forbidden", "只有任务内的调用可以登记成果", 403);
  const run = ctx.db.get<{ tenant_id: string; created_by: string; matter_id: string }>(`SELECT tenant_id, created_by, matter_id FROM runs WHERE run_id = ?`, [s.runId]);
  if (!run || run.matter_id !== s.matterId) throw notFound("任务");
  const existing = ctx.db.get<{ artifact_version_id: string }>(
    `SELECT artifact_version_id FROM artifact_versions WHERE matter_id = ? AND run_id = ? AND kind = ? AND audience = 'internal' AND sha256 = ?`,
    [s.matterId, s.runId, art.kind, art.sha256],
  );
  if (existing) return { artifact_version_id: existing.artifact_version_id, filename: art.filename, reused: true };
  const id = newId("artifactVersion");
  ctx.db.tx(() => {
    const v = ctx.db.get<{ next: number }>(`SELECT COALESCE(MAX(version), 0) + 1 AS next FROM artifact_versions WHERE matter_id = ? AND kind = ? AND audience = 'internal'`, [s.matterId, art.kind])!;
    ctx.db.run(
      `INSERT INTO artifact_versions (artifact_version_id, tenant_id, matter_id, run_id, kind, version, baseline_id, audience, status, filename, sha256, storage_uri, open_items, manifest, created_by)
       VALUES (?,?,?,?,?,?,NULL,'internal','draft',?,?,?,'[]',?,?)`,
      [id, run.tenant_id, s.matterId, s.runId, art.kind, v.next, art.filename, art.sha256, art.storage_uri, JSON.stringify(art.manifest), run.created_by],
    );
  });
  return { artifact_version_id: id, filename: art.filename, reused: false };
}

export function xlsxRenderTable(ctx: InvokeCtx, p: { title: string; sheets: { name: string; columns: string[]; rows: unknown[][] }[] }) {
  const sheets = Array.isArray(p.sheets) ? p.sheets : [];
  if (sheets.length === 0 || sheets.length > MAX_SHEETS) throw new DomainError("validation", `sheets 须为 1–${MAX_SHEETS} 个`, 422);
  const specs = sheets.map((sh, si) => {
    const cols = Array.isArray(sh.columns) ? sh.columns.map((c) => String(c).slice(0, 200)) : [];
    if (cols.length === 0 || cols.length > MAX_COLS) throw new DomainError("validation", `第 ${si + 1} 个表的列数须为 1–${MAX_COLS}`, 422);
    const rows = Array.isArray(sh.rows) ? sh.rows : [];
    if (rows.length > MAX_ROWS) throw new DomainError("validation", `第 ${si + 1} 个表超过 ${MAX_ROWS} 行，请分表`, 422);
    const body = rows.map((r) =>
      (Array.isArray(r) ? r : []).slice(0, cols.length).map((c): string | number | null => {
        if (c === null || c === undefined) return null;
        if (typeof c === "number" && Number.isFinite(c)) return c;
        return String(typeof c === "object" ? JSON.stringify(c) : c).slice(0, MAX_CELL);
      }),
    );
    return { name: String(sh.name || `表${si + 1}`).replace(/[\\/?*[\]:]/g, "").slice(0, 31) || `表${si + 1}`, rows: [cols, ...body] };
  });
  const buf = createXlsx(specs);
  const stored = ctx.blobs.put(buf, scopeOf(ctx).matterId);
  const filename = `${safeTitle(String(p.title ?? ""))}.xlsx`;
  const reg = registerToolArtifact(ctx, {
    kind: "agent_table",
    filename,
    sha256: stored.sha256,
    storage_uri: stored.storage_uri,
    manifest: { tool: "xlsx.render_table", sheets: specs.map((s) => ({ name: s.name, rows: s.rows.length - 1, columns: s.rows[0]!.length })), note: "Agent 经工具生成的表格（草稿）；导出时按事项令牌表还原代号" },
  });
  return { ...reg, sha256: stored.sha256, sheets: specs.length, rows: specs.reduce((n, s) => n + s.rows.length - 1, 0) };
}
