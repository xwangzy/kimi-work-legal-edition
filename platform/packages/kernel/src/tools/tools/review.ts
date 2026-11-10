/**
 * Agent 可调用的结构化产出与材料目录工具（2026-10-13 审计 D2；历史 Demo 融合方案 §3.3）：
 *   materials.list      本任务的材料目录（解析版本、字数、页数、识别质量、快照序号）——覆盖清单与“未读取”声明的依据
 *   riskcards.submit    提交风险卡（锚点在文档令牌化视图中定位；依据离线核验）→ 审查工作台
 *   riskcards.list      读取风险卡（例如只取律师已接受的卡写修订稿）
 *   facts.submit        提交事实行（材料声称 / 推论 / 待确认；Agent 不能标“律师确认”）
 *   facts.list          读取事实行（文书与汇报只引用律师确认的事实）
 *   xlsx.render_table   按列生成 Excel 表格，登记为本任务的草稿成果（统一格式，不用执行域里拼表）
 *   xlsx.edit_cells     在本任务已生成的表格上逐格修改，登记为同名表格的新版本（V16 第 41 批）
 *
 * 事项与任务一律取自端点按任务记录派生的身份（claims.mid / claims.rid；local-server toolClaims），不采信参数里的事项。
 * 结果交回 Agent 前由本机端点按事项令牌化（local-server tokenizeToolResult）。
 */
import { DomainError, newId, notFound, sha256Hex } from "@zr-legal/domain";
import { createXlsx, readCreatedXlsx, type SheetSpec } from "@zr-legal/docx-engine";
import { slog } from "@zr-legal/safe-log";
import type { InvokeCtx } from "../registry.ts";
import { confirmedView, latestOutline, submitOutline } from "../../services/argument-outlines.ts";
import { proposeDraft } from "../../services/review-rules.ts";
import { fillCells, tableForAgent } from "../../services/review-tables.ts";
import { acceptedText, changesDocument, listFacts, listRiskCards, submitFacts, submitRiskCards, riskCardProgress } from "../../services/review-cards.ts";
import { runLineage } from "../../services/artifact-lineage.ts";
import { checkDeliverable } from "../../services/deliverable-check.ts";
import { cellChars, shrinkCheck } from "../../services/version-shrink.ts";
import { amountWordsConflicts, extractFacts, payDayConflicts, type FactRow } from "../../executor/casefile.ts";

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
  // 金额比对（V16 第 41 批：调用 AI 的精读、争点、管辖时效任务拿不到整理案卷的确定性比对，三个真实任务都漏了催款函
  // “大写肆拾伍万伍仟元整 / 小写 ¥445,000.00”，其中一个还写了“金额一致”）：与整理案卷同一套规则、同一来源的材料文字
  // （最新解析文字的前 5 万字）。本任务选了材料的只比这几份，没选的比本事项全部现行材料
  const scope = out.filter((m) => m.parse_version_id && (index.size > 0 ? m.in_this_task : !m.superseded));
  const texts = scope.map((m) => ({
    document_version_id: m.document_version_id,
    parse_version_id: m.parse_version_id!,
    filename: m.filename,
    text: (ctx.db.get<{ content: string }>(`SELECT content FROM parse_texts WHERE parse_version_id = ?`, [m.parse_version_id])?.content ?? "").slice(0, 50_000),
  }));
  let facts: FactRow[] = [];
  try {
    facts = texts.flatMap((t) => extractFacts(t));
  } catch {
    facts = [];
  }
  const words = amountWordsConflicts(facts);
  const pay = payDayConflicts(texts, facts).conflicts;
  const materials = out.map((m) => {
    const mine = words.filter((w) => w.document_version_id === m.document_version_id);
    return mine.length === 0
      ? m
      : { ...m, amount_conflicts: mine.map((w) => ({ upper: { text: w.upper.text, amount_yuan: w.upper.amount_yuan }, lower: { text: w.lower.text, amount_yuan: w.lower.amount_yuan } })) };
  });
  return {
    materials,
    ...(pay.length > 0 ? { cross_material_conflicts: pay.map((c) => ({ date: c.date, amounts: c.amounts })) } : {}),
    note:
      "in_this_task=true 的材料已作为快照放在工作区 materials/ 目录（文件名以 snapshot_index 三位序号开头）；其他材料可用 materials.read_excerpt 按 parse_version_id 读取。" +
      "quality 为 partial/unreadable 的材料存在识别不全的页，结论中须如实说明未读取的范围。" +
      "amount_conflicts（这份材料里大写与小写金额对不上的各处）与 cross_material_conflicts（不同材料对同一天的付款写了不同金额）是系统按规则比出来的，只覆盖这两类：" +
      "有的要列进交付件的矛盾或缺口里，写明两处原文与数额，请律师核对原件；没有列出不等于金额都一致，不要写“金额一致”“未发现冲突”。" +
      "这些字段名和取值（snapshot_index、quality=ok 等）是系统内部的，交付件里用“序号”“能否读清”等律师的说法，不照抄。",
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
      kind: c.kind,
      rule_source: c.rule_source,
      rule_ref: c.rule_ref,
      ...(c.kind === "missing" ? { searched_terms: c.searched_terms, searched_found: c.searched_found.map((f) => f.term) } : {}),
      chosen_level: c.status === "accepted" ? c.chosen_level : null,
      adopted_text: c.status === "modified" ? null : changesDocument(c) ? acceptedText(c) : null,
      // 没有建议文本的“接受”是知悉、不改动（复核 C-B07）：单独标出，不能当成“我方提出过的修改”
      lawyer_status: c.status === "accepted" && !acceptedText(c).trim() ? "acknowledged" : c.status,
      changes_document: changesDocument(c),
      lawyer_text: c.final_text,
    })),
  };
}

export function tableGet(ctx: InvokeCtx, p: { table_id?: string }) {
  return tableForAgent(ctx.db, scopeOf(ctx).matterId, String(p.table_id ?? ""));
}

export function tableFill(ctx: InvokeCtx, p: { table_id?: string; cells?: unknown[] }) {
  // 问这张表的任务不改表（v9.4 第 21 批，复核 Q3-08：方法写了“不改表”，内核同样把关）
  const s = scopeOf(ctx);
  if (s.runId) {
    const snap = ctx.db.get<{ input_snapshot: string | null }>(`SELECT input_snapshot FROM runs WHERE run_id = ?`, [s.runId])?.input_snapshot;
    let mode: unknown = null;
    try {
      mode = JSON.parse(snap ?? "{}")?.skill_args?.mode;
    } catch {
      mode = null;
    }
    if (mode === "问表") throw new DomainError("forbidden", "这是“问这张表”的任务：只依据表里的格子回答，不改表（要填表请律师点“让助手填表”）", 403);
  }
  return fillCells({ db: ctx.db, blobs: ctx.blobs, ...(ctx.tokens ? { tokens: ctx.tokens } : {}) }, scopeOf(ctx), p);
}

export function outlineSubmit(ctx: InvokeCtx, p: { doc_kind?: string; title?: string; arguments?: unknown[] }) {
  return submitOutline({ db: ctx.db, lawdb: ctx.lawdb }, scopeOf(ctx), p);
}

/** 从本所或客户的范本起草审查要点（v9.4 第 22 批，C1 #22）：只存为草稿，律师审定启用后才用于审查。 */
export function rulesPropose(ctx: InvokeCtx, p: { title?: string; rules?: unknown[] }) {
  // 只在“从范本整理审查要点”的任务里接受（复核 Q4 建议 1：否则材料里的指令可让审合同任务也交草稿、占满草稿上限）
  const s = scopeOf(ctx);
  const skill = s.runId ? parseSkill(ctx.db.get<{ input_snapshot: string | null }>(`SELECT input_snapshot FROM runs WHERE run_id = ?`, [s.runId])?.input_snapshot ?? null) : null;
  if (skill !== "review-rules-draft") throw new DomainError("forbidden", "只有“从范本整理审查要点”的任务可以起草审查要点", 403);
  const checked = checkRedLineSources(ctx, s.matterId, p.rules);
  const r = proposeDraft(ctx.db, s, { title: p.title, rules: checked.rules });
  if (checked.dropped.length === 0) return r;
  return {
    ...r,
    red_lines_dropped: checked.dropped,
    note: `${r.note}。有 ${checked.dropped.length} 条的“不可谈”没有写入（见 red_lines_dropped）：范本里找不到写明这条底线的原句。范本没有写明不能接受的，不要替律师或客户定底线——在会话说明里把这几条列为“待律师补底线”；确有原句的，red_line_quote 逐字照抄那一句后重新提交`,
  };
}

/** 认作“写明了底线”的原句用词：范本自己说了不能接受、不得、必须、红线之类才算。 */
const RED_LINE_WORDS = /不可谈|不得|不能|不接受|不予接受|不可接受|不同意|拒绝|禁止|严禁|必须|务必|红线|底线|一律不|否决|不允许|不可以/;

/**
 * 审查要点里的“不可谈”要有范本原句为证（V16 第 41 批）。
 * V14 真实走查 I1-B：范本“属性”栏为“—”的责任上限条款被写成不可谈——方法早就写了“范本没写的不补”，但没有任何环节核对。
 * 这里按助手给的 red_line_quote（范本里写明这条底线的原句，代号形态）在本事项材料的文字视图里逐字找：
 * 没给原句、原句不在材料里、或原句里没有任何表示“不能接受 / 必须”的字眼的，这一条的 red_line 不写入（其余照常存），并告诉助手原因。
 * 律师自己在界面上写的不可谈不经这里（saveRules），不受影响。
 */
export function checkRedLineSources(ctx: Pick<InvokeCtx, "db" | "tokens">, matterId: string, rules: unknown): { rules: unknown; dropped: { no: number; topic: string; reason: string }[] } {
  if (!Array.isArray(rules)) return { rules, dropped: [] };
  let view: string | null = null;
  const materialView = (): string => {
    if (view !== null) return view;
    const rows = ctx.db.all<{ content: string }>(
      `SELECT pt.content FROM document_versions dv
         JOIN parse_versions pv ON pv.parse_version_id = (SELECT p2.parse_version_id FROM parse_versions p2 WHERE p2.document_version_id = dv.document_version_id ORDER BY p2.created_at DESC LIMIT 1)
         JOIN parse_texts pt ON pt.parse_version_id = pv.parse_version_id
        WHERE dv.matter_id = ? AND dv.quarantined_at IS NULL`,
      [matterId],
    );
    const plain = rows.map((r) => r.content).join("\n");
    view = squash(ctx.tokens ? ctx.tokens.tokenizer(matterId).tokenize(plain).text : plain);
    return view;
  };
  const dropped: { no: number; topic: string; reason: string }[] = [];
  const out = rules.map((r: any, i: number) => {
    if (!r || typeof r !== "object" || Array.isArray(r)) return r;
    const { red_line_quote: q, ...rest } = r as Record<string, unknown>;
    const red = typeof rest.red_line === "string" ? rest.red_line.trim() : "";
    if (!red) return rest;
    const quote = typeof q === "string" ? q.trim() : "";
    const drop = (reason: string) => {
      dropped.push({ no: i + 1, topic: String(rest.topic ?? "").slice(0, 40), reason });
      const { red_line: _omit, ...kept } = rest;
      return kept;
    };
    if ([...quote].length < 6) return drop("没有给出范本里写明这条底线的原句（red_line_quote）");
    if (!materialView().includes(squash(quote))) return drop("red_line_quote 不是范本里逐字出现的句子");
    if (!RED_LINE_WORDS.test(quote)) return drop("这句原文只写了我方的一般标准，没有写明不能接受或必须如此");
    return rest;
  });
  return { rules: out, dropped };
}

/** 比对用：去掉全部空白与条款编号后的换行差异（材料文字视图里一段可能断成几行）。 */
const squash = (t: string): string => t.replace(/\s+/g, "");

export function outlineGet(ctx: InvokeCtx) {
  const s = scopeOf(ctx);
  if (!s.runId) throw new DomainError("forbidden", "只有任务内的调用可以读取论点提纲", 403);
  const o = latestOutline(ctx.db, s.runId);
  if (!o) return { status: "none", note: "本任务还没有提交论点提纲：文书类任务请先用 outline.submit 提交" };
  if (o.status !== "confirmed") return { status: o.status, outline_id: o.outline_id, note: "律师还没确认：请用提问工具请律师在任务页确认后再读取；确认之前不要起草" };
  return {
    status: "confirmed",
    outline_id: o.outline_id,
    doc_kind: o.doc_kind,
    confirmed_arguments: confirmedView(o).map((a) => ({ ...a, basis: a.basis.map((b) => ({ law: b.law, article: b.article, note: b.note, check: b.check })) })),
    dropped: (o.decisions ?? []).filter((d) => !d.keep).map((d) => d.arg_id),
    lawyer_note: o.lawyer_note,
    note: "只按 confirmed_arguments 起草；dropped 里的论点不写；事实中 confirmed=false 的在文书里标“待律师确认”。",
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
      ref: `事实 ${f.no}`,
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
    note:
      "只有 lawyer_status=confirmed 的事实可以写进文书与汇报；其余须在交付件中标为“待律师确认”。" +
      "交付件里引用事实写 ref（如“事实 12”，律师在事项的事实页按同一序号可以查到），不写 fact_id；fact_id 只在调用工具时用。",
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
      `INSERT INTO artifact_versions (artifact_version_id, tenant_id, matter_id, run_id, kind, version, baseline_id, audience, status, filename, sha256, storage_uri, open_items, manifest, created_by, lineage)
       VALUES (?,?,?,?,?,?,NULL,'internal','draft',?,?,?,'[]',?,?,?)`,
      [id, run.tenant_id, s.matterId, s.runId, art.kind, v.next, art.filename, art.sha256, art.storage_uri, JSON.stringify(art.manifest), run.created_by, runLineage(ctx.db, s.runId!, art.kind, art.filename)],
    );
  });
  return { artifact_version_id: id, filename: art.filename, reused: false };
}

/**
 * 单元格归一（xlsx.render_table 与 xlsx.edit_cells 共用）：null/undefined 为空格；有限数字照写；
 * 长整数（第 35 批，文档工程审查 E-02）：身份证号、银行账号按数字传时，超过双精度的整数在到这里之前已经变了（…4517 成了 …4500），
 * 写进去就是错号——lost=true 由调用方拒收并说明改按文字传；16 位账号虽未失真，但 Excel 只保留 15 位有效数字、显示成科学计数，按文字写；
 * 其余转文字并截到 MAX_CELL 字。
 */
function normalizeCell(c: unknown): { value: string | number | null; lost: boolean } {
  if (c === null || c === undefined) return { value: null, lost: false };
  if (typeof c === "number" && Number.isFinite(c)) {
    if (Number.isInteger(c) && Math.abs(c) >= 1e11) return { value: String(c), lost: !Number.isSafeInteger(c) };
    return { value: c, lost: false };
  }
  return { value: String(typeof c === "object" ? JSON.stringify(c) : c).slice(0, MAX_CELL), lost: false };
}

export function xlsxRenderTable(ctx: InvokeCtx, p: { title: string; sheets: { name: string; columns: string[]; rows: unknown[][] }[] }) {
  const sheets = Array.isArray(p.sheets) ? p.sheets : [];
  if (sheets.length === 0 || sheets.length > MAX_SHEETS) throw new DomainError("validation", `sheets 须为 1–${MAX_SHEETS} 个`, 422);
  // 长数字见 normalizeCell
  const lost: string[] = [];
  const usedNames = new Set<string>();
  const specs = sheets.map((sh, si) => {
    const cols = Array.isArray(sh.columns) ? sh.columns.map((c) => String(c).slice(0, 200)) : [];
    if (cols.length === 0 || cols.length > MAX_COLS) throw new DomainError("validation", `第 ${si + 1} 个表的列数须为 1–${MAX_COLS}`, 422);
    const rows = Array.isArray(sh.rows) ? sh.rows : [];
    if (rows.length > MAX_ROWS) throw new DomainError("validation", `第 ${si + 1} 个表超过 ${MAX_ROWS} 行，请分表`, 422);
    const body = rows.map((r, ri) =>
      (Array.isArray(r) ? r : []).slice(0, cols.length).map((c, ci): string | number | null => {
        const n = normalizeCell(c);
        if (n.lost) lost.push(`第 ${si + 1} 个表第 ${ri + 1} 行“${cols[ci] ?? `第 ${ci + 1} 列`}”`);
        return n.value;
      }),
    );
    // 表名去重（文档工程审查 E-03：同名工作表 Excel 打开要修复）
    const base = String(sh.name || `表${si + 1}`).replace(/[\\/?*[\]:]/g, "").slice(0, 31) || `表${si + 1}`;
    let name = base;
    for (let k = 2; usedNames.has(name.toLowerCase()); k++) name = `${base.slice(0, 31 - String(k).length - 2)}（${k}）`;
    usedNames.add(name.toLowerCase());
    return { name, rows: [cols, ...body] };
  });
  if (lost.length > 0) throw new DomainError("validation", `表格有误，未生成：${lost.slice(0, 8).join("、")}是超长的数字（身份证号、账号一类），按数字传已失真，请改成文字（加引号）后重新提交`, 422, { problems: lost });
  return finishTable(ctx, String(p.title ?? ""), specs, "xlsx.render_table");
}

/**
 * 写出表格并登记为本任务的草稿成果（xlsx.render_table 与 xlsx.edit_cells 共用）：存文件、登记成果、版本缩水检查、交付前检查。
 * 同一任务里同名的表格串成同一份文件的各个版本。
 */
function finishTable(ctx: InvokeCtx, title: string, specs: SheetSpec[], tool: "xlsx.render_table" | "xlsx.edit_cells", extraManifest: Record<string, unknown> = {}) {
  const buf = createXlsx(specs);
  const stored = ctx.blobs.put(buf, scopeOf(ctx).matterId);
  const filename = `${safeTitle(title)}.xlsx`;
  const textChars = specs.reduce((n, sh) => n + cellChars(sh.rows), 0);
  const reg = registerToolArtifact(ctx, {
    kind: "agent_table",
    filename,
    sha256: stored.sha256,
    storage_uri: stored.storage_uri,
    manifest: { tool, sheets: specs.map((s) => ({ name: s.name, rows: s.rows.length - 1, columns: s.rows[0]!.length })), text_chars: textChars, note: "Agent 经工具生成的表格（草稿）；导出时按事项令牌表还原代号", ...extraManifest },
  });
  // 版本缩水检查（第 35 批）：同一任务里重出的同名表格比上一版明显变短，提示助手核对是否漏了行
  const shrink = reg.reused ? null : shrinkCheck(ctx.db, scopeOf(ctx).runId, "agent_table", reg.filename, reg.artifact_version_id, textChars);
  // 交付前检查（第 35 批）：附件表格同样不该有工具用语、参数名、夹杂英文、Markdown 符号与大小写不一致的金额
  let quality_check: ReturnType<typeof checkDeliverable> | null = null;
  try {
    quality_check = checkDeliverable(title, specs.map((s) => ({ heading: s.name, paragraphs: [], table: { columns: s.rows[0] ?? [], rows: s.rows.slice(1) as unknown[][] } })));
  } catch {
    quality_check = null;
  }
  return { ...reg, sha256: stored.sha256, sheets: specs.length, rows: specs.reduce((n, s) => n + s.rows.length - 1, 0), ...(quality_check ? { quality_check } : {}), ...(shrink ? { shrink } : {}) };
}

/** 一次逐格修改的操作总数上限（逐格改、替换、追加行、删除行合计）。 */
export const EDIT_CELLS_MAX_OPS = 500;

type CellOp = "edits" | "replace" | "append_rows" | "delete_rows";

/**
 * xlsx.edit_cells（V16 第 41 批）：在本任务已生成的表格上逐格修改，交出同名表格的新版本（旧版本保留）。
 *
 * 真实走查（争点与证据分析）：助手用 xlsx.render_table 生成 5 张工作表、97 行的 Excel（一次约 1.5 万 token、4～5 分钟），
 * 交付前检查报了“事实编号”列里的内部编号和几处用语，只能整份重出；前后 4 次，撞上 40 分钟时限只交出半成品。
 *
 * - 只改本事项、本任务里表格工具生成的表格（agent_table，.xlsx）；律师上传的 Excel 不能改；
 * - 行号是数据行号（从 1 起、不含表头），与交付前检查报的“××表格第 N 行”一致；列按表头文字定位；
 * - 执行顺序：逐格改 → 替换文字 → 删除行（从大到小）→ 追加行；行号一律按修改前这份表格的行号；
 * - 语义照 docx.edit_draft：能定位的先改，定位不到的逐条退回原因；一处都没改成时不登记新版本。
 */
export function xlsxEditCells(
  ctx: InvokeCtx,
  p: {
    artifact_version_id?: unknown;
    edits?: unknown;
    replace?: unknown;
    append_rows?: unknown;
    delete_rows?: unknown;
  },
) {
  const s = scopeOf(ctx);
  if (!s.runId) throw new DomainError("forbidden", "只有任务内的调用可以修改表格", 403);
  const id = String(p.artifact_version_id ?? "");
  const art = ctx.db.get<{ kind: string; filename: string; storage_uri: string; sha256: string; run_id: string | null; manifest: string | null }>(
    `SELECT kind, filename, storage_uri, sha256, run_id, manifest FROM artifact_versions WHERE artifact_version_id = ? AND matter_id = ?`,
    [id, s.matterId],
  );
  if (!art) throw new DomainError("not_found", "找不到这份表格：artifact_version_id 用 xlsx.render_table（或上一次 xlsx.edit_cells）返回的那个", 404);
  if (art.run_id !== s.runId) throw new DomainError("forbidden", "只能修改本任务里生成的表格；别的任务的表格与律师上传的 Excel 材料不能用本工具", 403);
  if (art.kind !== "agent_table" || !art.filename.toLowerCase().endsWith(".xlsx")) {
    throw new DomainError("validation", "只能修改 xlsx.render_table 生成的表格；Word 文书用 docx.edit_draft", 422);
  }
  if ((art.manifest ?? "").includes('"system_generated":true')) {
    throw new DomainError("validation", "这份是系统按本事项事实生成的事实时间线，不能逐格改：事实有误的用 facts.submit 重新提交，由律师在事实页确认", 422);
  }
  const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
  const edits = arr(p.edits);
  const replaces = arr(p.replace);
  const appends = arr(p.append_rows);
  const deletes = arr(p.delete_rows);
  if (edits.length + replaces.length + appends.length + deletes.length === 0) {
    throw new DomainError("validation", "edits、replace、append_rows、delete_rows 至少给一类", 422);
  }
  const total = edits.length + replaces.length + appends.reduce((n, a) => n + arr(a?.rows).length, 0) + deletes.reduce((n, d) => n + arr(d?.rows).length, 0);
  if (total > EDIT_CELLS_MAX_OPS) throw new DomainError("validation", `一次最多 ${EDIT_CELLS_MAX_OPS} 处修改；改动更多时说明这份表格要重做，用 xlsx.render_table 重新生成`, 422);
  const buf = ctx.blobs.read(art.storage_uri);
  if (sha256Hex(buf) !== art.sha256) throw new DomainError("hash_mismatch", "表格内容已变化（读取时复算 hash 不符），已停止", 412);
  const read = readCreatedXlsx(buf);
  if (!read) throw new DomainError("validation", "这份表格不是用表格工具生成的，不能逐格改，请用 xlsx.render_table 重新生成", 422);
  // 每行补齐到表头列数（写入时末尾的空格不写，读回会短）
  const specs: SheetSpec[] = read.map((sh) => {
    const width = sh.rows[0]?.length ?? 0;
    return { name: sh.name, rows: sh.rows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? null)) };
  });

  const rejected: { op: CellOp; index: number; reason: string }[] = [];
  const replaced: { index: number; find: string; count: number }[] = [];
  let applied = 0;
  const sheetNames = () => specs.map((x) => `“${x.name}”`).join("、");
  const sheetOf = (op: CellOp, index: number, name: unknown): SheetSpec | null => {
    const n = String(name ?? "");
    const hit = specs.find((x) => x.name === n) ?? specs.find((x) => x.name === n.trim());
    if (!hit) rejected.push({ op, index, reason: `没有名为“${n}”的工作表；这份表格的工作表：${sheetNames()}` });
    return hit ?? null;
  };
  const dataRows = (sh: SheetSpec) => sh.rows.length - 1;
  const rowOk = (op: CellOp, index: number, sh: SheetSpec, row: unknown): number | null => {
    const r = typeof row === "number" ? row : Number(row);
    if (!Number.isInteger(r) || r < 1 || r > dataRows(sh)) {
      rejected.push({ op, index, reason: `行号 ${String(row)} 超出范围：“${sh.name}”共 ${dataRows(sh)} 行数据（行号从 1 起，不含表头，与交付前检查报的“第 N 行”一致）` });
      return null;
    }
    return r;
  };
  const lostReason = "是超长的数字（身份证号、账号一类），按数字传已失真，请改成文字（加引号）后重交";

  // 1. 逐格改
  edits.forEach((e, index) => {
    const sh = sheetOf("edits", index, e?.sheet);
    if (!sh) return;
    const r = rowOk("edits", index, sh, e?.row);
    if (r === null) return;
    const col = String(e?.column ?? "");
    const header = sh.rows[0]!.map((c) => String(c ?? ""));
    let ci = header.indexOf(col);
    if (ci < 0) ci = header.findIndex((h) => h.trim() === col.trim());
    if (ci < 0) {
      rejected.push({ op: "edits", index, reason: `“${sh.name}”没有“${col}”这一列（列名逐字照抄表头）；该表的列：${header.map((h) => `“${h}”`).join("、")}` });
      return;
    }
    const v = normalizeCell(e?.value);
    if (v.lost) {
      rejected.push({ op: "edits", index, reason: `新值${lostReason}` });
      return;
    }
    sh.rows[r]![ci] = v.value;
    applied += 1;
  });

  // 2. 替换文字（不含表头）
  replaces.forEach((x, index) => {
    const find = String(x?.find ?? "");
    const to = String(x?.with ?? "");
    if ([...find].length < 2) {
      rejected.push({ op: "replace", index, reason: "find 至少 2 个字（太短容易误改别处）" });
      return;
    }
    let targets = specs;
    if (x?.sheet !== undefined && x?.sheet !== null && x?.sheet !== "") {
      const sh = sheetOf("replace", index, x.sheet);
      if (!sh) return;
      targets = [sh];
    }
    let count = 0;
    for (const sh of targets) {
      for (let ri = 1; ri < sh.rows.length; ri++) {
        const row = sh.rows[ri]!;
        row.forEach((c, ci) => {
          if (typeof c !== "string" || !c.includes(find)) return;
          const parts = c.split(find);
          count += parts.length - 1;
          const next = parts.join(to).slice(0, MAX_CELL);
          row[ci] = next === "" ? null : next;
        });
      }
    }
    if (count === 0) {
      rejected.push({ op: "replace", index, reason: `在${targets.length === 1 ? `“${targets[0]!.name}”` : "这份表格"}的文字格子里没有找到“${find}”（表头不在替换范围内；逐字照抄格子里的文字）` });
      return;
    }
    replaced.push({ index, find, count });
    applied += 1;
  });

  // 3. 删除行：同一张表的行号去重后从大到小删，行号按修改前的表
  const toDelete = new Map<SheetSpec, Set<number>>();
  deletes.forEach((d, index) => {
    const sh = sheetOf("delete_rows", index, d?.sheet);
    if (!sh) return;
    const rows = arr(d?.rows);
    if (rows.length === 0) {
      rejected.push({ op: "delete_rows", index, reason: "rows 里没有行号" });
      return;
    }
    const set = toDelete.get(sh) ?? new Set<number>();
    for (const row of rows) {
      const r = rowOk("delete_rows", index, sh, row);
      if (r !== null && !set.has(r)) {
        set.add(r);
        applied += 1;
      }
    }
    toDelete.set(sh, set);
  });
  for (const [sh, set] of toDelete) for (const r of [...set].sort((a, b) => b - a)) sh.rows.splice(r, 1);

  // 4. 追加行
  appends.forEach((a, index) => {
    const sh = sheetOf("append_rows", index, a?.sheet);
    if (!sh) return;
    const width = sh.rows[0]!.length;
    const rows = arr(a?.rows);
    if (rows.length === 0) {
      rejected.push({ op: "append_rows", index, reason: "rows 里没有要追加的行" });
      return;
    }
    rows.forEach((row, k) => {
      const cells = Array.isArray(row) ? row : [];
      if (cells.length > width) {
        rejected.push({ op: "append_rows", index, reason: `第 ${k + 1} 行有 ${cells.length} 格，多于“${sh.name}”的 ${width} 列：按表头的列依次给值；要加列请用 xlsx.render_table 重新生成` });
        return;
      }
      if (dataRows(sh) >= MAX_ROWS) {
        rejected.push({ op: "append_rows", index, reason: `“${sh.name}”已到 ${MAX_ROWS} 行上限，请分表` });
        return;
      }
      const norm = cells.map(normalizeCell);
      if (norm.some((n) => n.lost)) {
        rejected.push({ op: "append_rows", index, reason: `第 ${k + 1} 行里有格子${lostReason}` });
        return;
      }
      sh.rows.push(Array.from({ length: width }, (_, i) => norm[i]?.value ?? null));
      applied += 1;
    });
  });

  const notFound = rejected.length;
  slog.event("TOOLS_DOCX_EDIT_OUTCOME", { tool: "xlsx_edit_cells", status: applied === 0 ? "not_applied" : notFound > 0 ? "partial" : "applied", patches: total, applied, not_found: notFound, ambiguous: 0, unknown_token: 0, other: 0 });
  if (applied === 0) {
    return {
      status: "not_applied" as const,
      applied: 0,
      rejected,
      note: "一处都没有改成，没有登记新版本：按 rejected 里的原因改正后重交（artifact_version_id 仍用这一个）",
    };
  }
  const title = art.filename.replace(/\.xlsx$/i, "");
  const done = finishTable(ctx, title, specs, "xlsx.edit_cells", { edited_from: id });
  return {
    status: notFound > 0 ? ("partial" as const) : ("applied" as const),
    applied,
    ...(replaced.length > 0 ? { replaced } : {}),
    ...(notFound > 0 ? { rejected } : {}),
    previous_artifact_version_id: id,
    ...done,
    note:
      (notFound > 0
        ? `能定位的 ${applied} 处已写入新版本，${notFound} 处退回（见 rejected）：按原因改正后，用新的 artifact_version_id 只重交这几处。`
        : `${applied} 处已写入同名表格的新版本（旧版本保留）。`) +
      "后续再改用新的 artifact_version_id；quality_check 通过后不要为润色整份重新生成。",
  };
}

function parseSkill(snap: string | null): string | null {
  try {
    const v = JSON.parse(snap ?? "{}")?.skill;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}
