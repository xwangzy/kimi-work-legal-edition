/**
 * 结构化产出：风险卡与事实行（2026-10-13 审计 D2 / UIUX P0-3；v9 第 03 篇 §6.1 合同链、§6.2 材料链）。
 *
 * 原则（历史 Demo 融合方案 §3.1 第 3 条）：风险卡、事实行一律经工具提交，由内核核对后落盘，再渲染到审查工作台——
 * 不允许模型在正文里自由拼表格充当交付件。
 *
 * - 提交（Agent，经法律工具 riskcards.submit / facts.submit）：文字为事项令牌形态（Agent 只见代号）；锚点（引用的合同原文）在
 *   该文档的令牌化视图里定位——定位到 1 处 = located、多处 = ambiguous、找不到 = not_found（如实保留，律师可见）；
 *   法律依据按离线法规库逐条核验（来源与版本），核验结论随卡保存；
 * - 决定（律师，在审查工作台）：接受 / 修改后接受（改写的文本为原文）/ 不采纳 / 撤回决定；事实行：确认 / 不采纳；
 * - 修订稿：只把“接受”与“修改后接受”的卡交给结构化补丁引擎（structured-patch.ts）在原件副本上写原生修订——
 *   任一条不能定位即整体返回预览并逐卡说明原因，律师可选择跳过这些卡后再生成（不做模糊替换、不写半个文件）。
 */
import { localToday } from "./local-date.ts";
import { DomainError, newId, notFound, sha256Hex } from "@zr-legal/domain";
import { extractParagraphs } from "@zr-legal/docx-engine";
import type { Lawdb } from "@zr-legal/lawdb";
import type { KernelDb } from "../db.ts";
import type { BlobStore } from "../blobs.ts";
import type { MatterTokenStore } from "../egress/matter-tokens.ts";
import { citationsVerify } from "../tools/tools/citations.ts";
import { applyStructuredPatches, type PatchConflict, type PatchResult, type StructuredPatch } from "./structured-patch.ts";

export const RISK_CARD_LIMITS = { perCall: 60, perRun: 300, field: 4_000, anchor: 2_000 } as const;
export const FACT_LIMITS = { perCall: 120, perRun: 600, field: 2_000 } as const;

export interface ReviewDeps {
  db: KernelDb;
  blobs: BlobStore;
  tokens?: MatterTokenStore;
  lawdb?: Lawdb;
}

export interface ToolScope {
  tenantId: string;
  matterId: string;
  runId: string | null;
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const optStr = (v: unknown, max: number): string | null => {
  const s = str(v, max);
  return s ? s : null;
};

/** 文档的令牌化视图（Agent 看到的文本形态）。DOCX 用段落文本（与结构化补丁一致），其他用最新解析文本。 */
function documentView(deps: ReviewDeps, matterId: string, documentVersionId: string): { view: string; filename: string } {
  const doc = deps.db.get<{ document_version_id: string; matter_id: string; filename: string; storage_uri: string }>(
    `SELECT document_version_id, matter_id, filename, storage_uri FROM document_versions WHERE document_version_id = ? AND quarantined_at IS NULL`,
    [documentVersionId],
  );
  if (!doc || doc.matter_id !== matterId) throw notFound("文档");
  let plain: string | null = null;
  if (doc.filename.toLowerCase().endsWith(".docx")) {
    try {
      plain = extractParagraphs(deps.blobs.read(doc.storage_uri)).map((x) => x.text).join("\n");
    } catch {
      plain = null;
    }
  }
  if (plain === null) {
    plain =
      deps.db.get<{ content: string }>(
        `SELECT pt.content FROM parse_versions pv JOIN parse_texts pt ON pt.parse_version_id = pv.parse_version_id
          WHERE pv.document_version_id = ? ORDER BY pv.created_at DESC LIMIT 1`,
        [documentVersionId],
      )?.content ?? "";
  }
  const view = deps.tokens ? deps.tokens.tokenizer(matterId).tokenize(plain).text : plain;
  return { view, filename: doc.filename };
}

/**
 * 风险卡没写 document_version_id 时（复核 B3-B19）：本任务只涉及一份材料、或本事项只有一份可用材料，就绑定它；
 * 有多份可选时拒绝并要求指定；事项里没有材料时照常提交（工作台单列“未关联合同的意见”，律师同样能逐张决定）。
 */
function soleDocument(db: KernelDb, scope: ToolScope): string | null {
  const usable = (ids: string[]) =>
    ids.filter((id) => db.get(`SELECT 1 AS x FROM document_versions WHERE document_version_id = ? AND matter_id = ? AND quarantined_at IS NULL`, [id, scope.matterId]));
  let fromRun: string[] = [];
  if (scope.runId) {
    try {
      const snap = JSON.parse(db.get<{ input_snapshot: string | null }>(`SELECT input_snapshot FROM runs WHERE run_id = ?`, [scope.runId])?.input_snapshot ?? "{}");
      fromRun = Array.isArray(snap?.document_version_ids) ? usable(snap.document_version_ids.map(String)) : [];
    } catch {
      fromRun = [];
    }
  }
  if (fromRun.length === 1) return fromRun[0]!;
  const all = db.all<{ document_version_id: string }>(`SELECT document_version_id FROM document_versions WHERE matter_id = ? AND quarantined_at IS NULL`, [scope.matterId]).map((r) => r.document_version_id);
  if (fromRun.length === 0 && all.length === 1) return all[0]!;
  // 事项里没有任何材料（例如律师在任务说明里贴了条款）：卡照常提交，工作台单列为“未关联合同的意见”
  if (fromRun.length === 0 && all.length === 0) return null;
  throw new DomainError("validation", "本事项有多份材料：请为风险卡指定 document_version_id（用 materials.list 查看各材料的编号）；同一批卡只对应一份合同", 422);
}

/** 在视图中定位引文：先精确，再忽略空白（Agent 常把换行写成空格）。 */
export function locateQuote(view: string, quote: string): { status: "located" | "ambiguous" | "not_found"; start: number | null; end: number | null } {
  if (!quote) return { status: "not_found", start: null, end: null };
  const first = view.indexOf(quote);
  if (first >= 0) {
    const second = view.indexOf(quote, first + 1);
    return { status: second >= 0 ? "ambiguous" : "located", start: first, end: first + quote.length };
  }
  // 忽略空白与表格分隔符比较：建立去空白视图 → 原位置映射（复核 R15B-07：材料快照里表格按行写成“| 单元格 | 单元格 |”，
  // 单元格里原有的“|”写成“｜”；定位视图里每格各占一段——两边的分隔都不计）
  const SKIP = /[\s|｜]/;
  const map: number[] = [];
  let compact = "";
  for (let i = 0; i < view.length; i++) {
    if (SKIP.test(view[i]!)) continue;
    compact += view[i];
    map.push(i);
  }
  const q = quote.replace(/[\s|｜]+/g, "");
  if (!q) return { status: "not_found", start: null, end: null };
  const at = compact.indexOf(q);
  if (at < 0) return { status: "not_found", start: null, end: null };
  const again = compact.indexOf(q, at + 1);
  return { status: again >= 0 ? "ambiguous" : "located", start: map[at]!, end: map[at + q.length - 1]! + 1 };
}

function asOfFor(db: KernelDb, matterId: string): string {
  const m = db.get<{ key_dates: string | null }>(`SELECT key_dates FROM matters WHERE matter_id = ?`, [matterId]);
  try {
    const kd = JSON.parse(m?.key_dates ?? "{}") as { analysis_as_of?: string };
    if (kd.analysis_as_of && /^\d{4}-\d{2}-\d{2}$/.test(kd.analysis_as_of)) return kd.analysis_as_of;
  } catch {
    // 缺省今天
  }
  return localToday();
}

interface BasisItem {
  law: string;
  article: number | null;
  note: string | null;
  /** 离线法规库核验：版本已核 / 来源已核 / 拦截 / 未核（缺条号或无法规库）。 */
  check: string;
  matched: string | null;
}

function verifyBasis(deps: ReviewDeps, matterId: string, raw: unknown): BasisItem[] {
  const items = Array.isArray(raw) ? raw.slice(0, 12) : [];
  const asOf = asOfFor(deps.db, matterId);
  return items.map((b: any): BasisItem => {
    const law = str(b?.law, 80).replace(/^《|》$/g, "");
    const article = Number.isInteger(b?.article) && b.article > 0 ? (b.article as number) : null;
    const note = optStr(b?.note, 400);
    if (!law || article === null || !deps.lawdb) return { law, article, note, check: "unchecked", matched: null };
    try {
      const r = citationsVerify(deps.lawdb, { citations: [{ law, article }], as_of: asOf });
      const v = (r as { verdicts?: { state: string; matched_law_name: string | null }[] }).verdicts?.[0];
      return { law, article, note, check: v?.state ?? "unchecked", matched: v?.matched_law_name ?? null };
    } catch {
      return { law, article, note, check: "unchecked", matched: null };
    }
  });
}

function runSeqBase(db: KernelDb, table: "risk_cards" | "matter_facts", matterId: string, runId: string | null): { next: number; count: number } {
  const r = db.get<{ mx: number | null; n: number }>(
    `SELECT MAX(seq) AS mx, COUNT(*) AS n FROM ${table} WHERE matter_id = ? AND ${runId ? "run_id = ?" : "run_id IS NULL"}`,
    runId ? [matterId, runId] : [matterId],
  )!;
  return { next: (r.mx ?? 0) + 1, count: r.n };
}

// ─── 风险卡 ───

/**
 * 没有标性质的卡（Agent 没给、或第 15 批之前的卡）按类别与严重程度推定——只在读出时推定、标 nature_inferred，库里不存推定值（复核 RB16B-03）。
 * 没有建议文本的提示性卡（只提示、不建议改动）不推定为“必须修改”（复核 RB16B-04）。
 */
export function defaultNature(category: string, severity: string, hasSuggestion = true): "must" | "should" | "negotiable" {
  if (category === "commercial") return "negotiable";
  return category === "legal" && severity === "high" && hasSuggestion ? "must" : "should";
}

export function submitRiskCards(deps: ReviewDeps, scope: ToolScope, input: { document_version_id?: unknown; cards?: unknown }) {
  const cards = Array.isArray(input.cards) ? input.cards : [];
  if (cards.length === 0) throw new DomainError("validation", "cards 不能为空", 422);
  if (cards.length > RISK_CARD_LIMITS.perCall) throw new DomainError("validation", `一次最多提交 ${RISK_CARD_LIMITS.perCall} 张风险卡，请分批`, 422);
  const docId = optStr(input.document_version_id, 80) ?? soleDocument(deps.db, scope);
  const view = docId ? documentView(deps, scope.matterId, docId) : null;
  const base = runSeqBase(deps.db, "risk_cards", scope.matterId, scope.runId);
  if (base.count + cards.length > RISK_CARD_LIMITS.perRun) throw new DomainError("validation", `本任务风险卡已达上限 ${RISK_CARD_LIMITS.perRun}`, 422);
  const out: { card_id: string; seq: number; anchor_status: string; basis_checks: string[]; duplicate_of?: string; updated?: string }[] = [];
  let seqOffset = 0;
  deps.db.tx(() => {
    cards.forEach((c: any, i: number) => {
      const anchor = str(c?.anchor_text, RISK_CARD_LIMITS.anchor);
      const issue = str(c?.issue, RISK_CARD_LIMITS.field);
      if (!anchor || !issue) throw new DomainError("validation", `第 ${i + 1} 张卡缺少 anchor_text 或 issue`, 422);
      const severity = ["high", "mid", "low"].includes(c?.severity) ? (c.severity as string) : null;
      if (!severity) throw new DomainError("validation", `第 ${i + 1} 张卡 severity 须为 high/mid/low`, 422);
      const category = ["legal", "commercial", "both"].includes(c?.category) ? (c.category as string) : "legal";
      // 建议的性质（Astra M-1）：只存 Agent 给的；没给的读出时再推定（nature_inferred）
      const nature = ["must", "should", "negotiable"].includes(c?.nature) ? (c.nature as string) : null;
      const found = view ? locateQuote(view.view, anchor) : { status: "no_document" as const, start: null, end: null };
      // 规范锚点（复核 B3-B04）：定位到的视图原文（空白与 Agent 原话可能不同），修订稿一律用它；Agent 原话另存
      const canonical = view && found.start !== null && found.end !== null ? view.view.slice(found.start, found.end) : anchor;
      const loc = found.status === "located" && canonical.includes("\n") ? { ...found, status: "cross_paragraph" as const } : found;
      const storedAnchor = loc.status === "located" || loc.status === "cross_paragraph" ? canonical : anchor;
      const suggestion = typeof c?.suggestion === "string" ? c.suggestion.slice(0, RISK_CARD_LIMITS.field) : null;
      // 跨任务去重（复核 C-B05）：同一合同上锚点、问题与建议都相同、且仍有效（未被不采纳）的卡不再新增，回报已有的卡
      const dup = docId
        ? deps.db.get<{ card_id: string; seq: number; anchor_status: string }>(
            `SELECT card_id, seq, anchor_status FROM risk_cards WHERE matter_id = ? AND document_version_id = ? AND anchor_text = ? AND issue = ? AND COALESCE(suggestion, '') = ? AND status <> 'rejected' LIMIT 1`,
            [scope.matterId, docId, storedAnchor, issue, suggestion ?? ""],
          )
        : undefined;
      if (dup) {
        // 为补全梯度或改判性质重新提交（复核 RB16B-02）：旧卡仍待处理时补写这几项；律师已处理的卡不改
        const old = deps.db.get<{ status: string; nature: string | null; fallback: string | null; bottom_line: string | null }>(`SELECT status, nature, fallback, bottom_line FROM risk_cards WHERE card_id = ?`, [dup.card_id])!;
        const upd = {
          nature: nature ?? old.nature,
          fallback: optStr(c?.fallback, RISK_CARD_LIMITS.field) ?? old.fallback,
          bottom_line: optStr(c?.bottom_line, RISK_CARD_LIMITS.field) ?? old.bottom_line,
        };
        const changed = upd.nature !== old.nature || upd.fallback !== old.fallback || upd.bottom_line !== old.bottom_line;
        if (changed && old.status === "proposed") deps.db.run(`UPDATE risk_cards SET nature = ?, fallback = ?, bottom_line = ? WHERE card_id = ?`, [upd.nature, upd.fallback, upd.bottom_line, dup.card_id]);
        out.push({ card_id: dup.card_id, seq: dup.seq, anchor_status: dup.anchor_status, basis_checks: [], duplicate_of: dup.card_id, ...(changed ? { updated: old.status === "proposed" ? "ladder_or_nature" : "lawyer_decided_not_updated" } : {}) });
        seqOffset--;
        return;
      }
      const basis = verifyBasis(deps, scope.matterId, c?.basis);
      const id = newId("riskCard");
      const seq = base.next + i + seqOffset;
      deps.db.run(
        `INSERT INTO risk_cards (card_id, tenant_id, matter_id, run_id, document_version_id, seq, clause_ref, anchor_text, anchor_quote, anchor_start, anchor_end, anchor_status,
           severity, category, issue, basis, suggestion, fallback, needs_client_decision, assumptions, nature, bottom_line)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          scope.tenantId,
          scope.matterId,
          scope.runId,
          docId,
          seq,
          optStr(c?.clause_ref, 60),
          storedAnchor,
          anchor,
          loc.start,
          loc.end,
          loc.status,
          severity,
          category,
          issue,
          JSON.stringify(basis),
          suggestion,
          optStr(c?.fallback, RISK_CARD_LIMITS.field),
          c?.needs_client_decision === true ? 1 : 0,
          optStr(c?.assumptions, RISK_CARD_LIMITS.field),
          nature,
          optStr(c?.bottom_line, RISK_CARD_LIMITS.field),
        ],
      );
      out.push({ card_id: id, seq, anchor_status: loc.status, basis_checks: basis.map((b) => b.check) });
    });
  });
  const notFound = out.filter((x) => x.anchor_status === "not_found").length;
  const ambiguous = out.filter((x) => x.anchor_status === "ambiguous").length;
  const cross = out.filter((x) => x.anchor_status === "cross_paragraph").length;
  const dups = out.filter((x) => x.duplicate_of).length;
  const notes: string[] = [];
  const updated = out.filter((x) => x.updated === "ladder_or_nature").length;
  const locked = out.filter((x) => x.updated === "lawyer_decided_not_updated").length;
  if (dups > 0) notes.push(`${dups} 张卡的锚点、问题与首选与已有卡相同，未重复新增（回报的是已有卡的编号）${updated ? `；其中 ${updated} 张已补写性质或梯度` : ""}${locked ? `；${locked} 张律师已处理，未更新` : ""}`);
  if (notFound + ambiguous > 0) notes.push(`${notFound} 张卡的引文在文档中找不到、${ambiguous} 张出现多处：请改为逐字摘录（可附条款号 clause_ref），找不到的卡律师只能手工处理`);
  if (cross > 0) notes.push(`${cross} 张卡的引文跨了段落：修订按段落写入，请把这些卡按段落拆开重新提交（每张卡的引文只取一段之内）`);
  return {
    submitted: out.length,
    document_version_id: docId,
    cards: out,
    note: notes.length > 0 ? notes.join("；") : "已提交，律师将在审查工作台逐张决定是否采纳",
  };
}

export interface RiskCardRow {
  card_id: string;
  run_id: string | null;
  document_version_id: string | null;
  seq: number;
  clause_ref: string | null;
  /** 规范锚点：文档视图中定位到的原文（令牌形态）。 */
  anchor_text: string;
  /** Agent 提交时的原话。 */
  anchor_quote: string | null;
  anchor_status: string;
  anchor_start: number | null;
  anchor_end: number | null;
  severity: string;
  category: string;
  issue: string;
  basis: BasisItem[];
  /** 首选（替换锚点的建议条款）。 */
  suggestion: string | null;
  /** 可退让。 */
  fallback: string | null;
  /** 底线（Astra M-1）。 */
  bottom_line: string | null;
  /** must 必须修改 / should 建议修改 / negotiable 可谈判（没标的按类别推定，见 nature_inferred）。 */
  nature: "must" | "should" | "negotiable";
  /** 性质是推定的（Agent 没给、律师也没改过）。 */
  nature_inferred: boolean;
  needs_client_decision: boolean;
  assumptions: string | null;
  status: string;
  final_text: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

function cardOut(r: any): RiskCardRow {
  let basis: BasisItem[] = [];
  try {
    basis = JSON.parse(r.basis ?? "[]");
  } catch {
    basis = [];
  }
  return {
    card_id: r.card_id,
    run_id: r.run_id,
    document_version_id: r.document_version_id,
    seq: r.seq,
    clause_ref: r.clause_ref,
    anchor_text: r.anchor_text,
    anchor_quote: r.anchor_quote ?? null,
    anchor_status: r.anchor_status,
    anchor_start: r.anchor_start ?? null,
    anchor_end: r.anchor_end ?? null,
    severity: r.severity,
    category: r.category,
    issue: r.issue,
    basis,
    suggestion: r.suggestion,
    fallback: r.fallback,
    bottom_line: r.bottom_line ?? null,
    nature: ["must", "should", "negotiable"].includes(r.nature) ? r.nature : defaultNature(r.category, r.severity, !!(r.suggestion ?? "").trim()),
    nature_inferred: !["must", "should", "negotiable"].includes(r.nature),
    needs_client_decision: r.needs_client_decision === 1,
    assumptions: r.assumptions,
    status: r.status,
    final_text: r.final_text,
    decided_by: r.decided_by,
    decided_at: r.decided_at,
    created_at: r.created_at,
  };
}

const SEVERITY_ORDER = "CASE severity WHEN 'high' THEN 0 WHEN 'mid' THEN 1 ELSE 2 END";

/**
 * 卡片在原件里的页码（Z3 M-5 / 余项续复核 RC-B-18）：PDF 等按页解析的材料，解析文本以换页符分隔，锚点起点之前有几个换页符即第几页；
 * Word 没有版面页码，返回空（卡片只显示条款号）。纯读，不改卡。
 */
export function cardPages(deps: ReviewDeps, matterId: string, documentVersionId: string, cards: readonly Pick<RiskCardRow, "card_id" | "anchor_start" | "anchor_status">[]): Map<string, number> {
  const out = new Map<string, number>();
  const doc = deps.db.get<{ filename: string }>(`SELECT filename FROM document_versions WHERE document_version_id = ?`, [documentVersionId]);
  if (!doc || doc.filename.toLowerCase().endsWith(".docx")) return out;
  let view: string;
  try {
    view = documentView(deps, matterId, documentVersionId).view;
  } catch {
    return out;
  }
  if (!view.includes("\f")) return out;
  for (const c of cards) {
    if (c.anchor_status !== "located" || c.anchor_start === null || c.anchor_start === undefined) continue;
    let page = 1;
    for (let i = view.indexOf("\f"); i >= 0 && i < c.anchor_start; i = view.indexOf("\f", i + 1)) page++;
    out.set(c.card_id, page);
  }
  return out;
}

export function listRiskCards(db: KernelDb, matterId: string, f: { run_id?: unknown; document_version_id?: unknown; status?: unknown } = {}): RiskCardRow[] {
  const where = ["matter_id = ?"];
  const args: unknown[] = [matterId];
  if (typeof f.run_id === "string" && f.run_id) {
    where.push("run_id = ?");
    args.push(f.run_id);
  }
  if (typeof f.document_version_id === "string" && f.document_version_id) {
    where.push("document_version_id = ?");
    args.push(f.document_version_id);
  } else if (f.document_version_id === null) {
    // 未关联合同的意见（复核 B3-B19）：工作台单列，可逐张决定
    where.push("document_version_id IS NULL");
  }
  const statuses = (Array.isArray(f.status) ? f.status : typeof f.status === "string" ? [f.status] : []).filter((s) => ["proposed", "accepted", "modified", "rejected"].includes(String(s)));
  if (statuses.length > 0) {
    where.push(`status IN (${statuses.map(() => "?").join(",")})`);
    args.push(...statuses);
  }
  return db.all<any>(`SELECT * FROM risk_cards WHERE ${where.join(" AND ")} ORDER BY ${SEVERITY_ORDER}, COALESCE(anchor_start, 1e12), seq LIMIT 1000`, args).map(cardOut);
}

export function decideRiskCard(db: KernelDb, matterId: string, userId: string, input: { card_id?: unknown; decision?: unknown; final_text?: unknown }): RiskCardRow {
  const id = str(input.card_id, 80);
  const row = db.get<any>(`SELECT * FROM risk_cards WHERE card_id = ?`, [id]);
  if (!row || row.matter_id !== matterId) throw notFound("风险卡");
  const decision = String(input.decision ?? "");
  const status = decision === "accept" ? "accepted" : decision === "modify" ? "modified" : decision === "reject" ? "rejected" : decision === "reset" ? "proposed" : null;
  if (!status) throw new DomainError("validation", "decision 须为 accept / modify / reject / reset", 422);
  const finalText = status === "modified" ? str(input.final_text, RISK_CARD_LIMITS.field) : null;
  if (status === "modified" && !finalText) throw new DomainError("validation", "修改后接受需要填写修改后的条款文本", 422);
  const now = new Date().toISOString();
  db.run(`UPDATE risk_cards SET status = ?, final_text = ?, decided_by = ?, decided_at = ? WHERE card_id = ?`, [
    status,
    finalText,
    status === "proposed" ? null : userId,
    status === "proposed" ? null : now,
    id,
  ]);
  return cardOut(db.get<any>(`SELECT * FROM risk_cards WHERE card_id = ?`, [id]));
}

/** 律师改性质（复核 RB16B-03：推定或 Agent 判错的，律师能纠正；只改性质，不动状态与文本）。 */
export function setRiskCardNature(db: KernelDb, matterId: string, input: { card_id?: unknown; nature?: unknown }): RiskCardRow {
  const id = str(input.card_id, 80);
  const row = db.get<any>(`SELECT * FROM risk_cards WHERE card_id = ?`, [id]);
  if (!row || row.matter_id !== matterId) throw notFound("风险卡");
  const nature = String(input.nature ?? "");
  if (!["must", "should", "negotiable"].includes(nature)) throw new DomainError("validation", "nature 须为 must / should / negotiable", 422);
  db.run(`UPDATE risk_cards SET nature = ? WHERE card_id = ?`, [nature, id]);
  return cardOut(db.get<any>(`SELECT * FROM risk_cards WHERE card_id = ?`, [id]));
}

/** 接受后会写进修订稿的卡：修改后接受，或接受且有建议文本。没有建议文本的“接受”是知悉、不改动（复核 B3-B25）。 */
export function changesDocument(c: Pick<RiskCardRow, "status" | "suggestion">): boolean {
  return c.status === "modified" || (c.status === "accepted" && !!(c.suggestion ?? "").trim());
}

/** 审查进度（工作台顶部）：总数、已处理、待处理中的重大风险数、会写进修订稿的项数、知悉不改的项数。 */
export function riskCardProgress(cards: readonly RiskCardRow[]): { total: number; decided: number; high_open: number; accepted: number; acknowledged: number } {
  return {
    total: cards.length,
    decided: cards.filter((c) => c.status !== "proposed").length,
    high_open: cards.filter((c) => c.status === "proposed" && c.severity === "high").length,
    accepted: cards.filter(changesDocument).length,
    acknowledged: cards.filter((c) => c.status === "accepted" && !changesDocument(c)).length,
  };
}

/** 律师在工作台接受后生成的修订：作者标明经律师审定（区别于 Agent 直接提出的“AI 建议”）。 */
export const LAWYER_APPROVED_AUTHOR = "律师审定（Kimi Work 辅助起草）";

const TOKEN_SPAN = /〔[^〔〕]{1,12}·[0-9A-Z]{6,10}〕/g;

/**
 * 最小修改范围：去掉原文与新文本的公共前缀与后缀，只把真正变化的部分写成修订（律师在 Word 里看到“万分之一 → 千分之三”，
 * 而不是整句删除再插入）。切点不落在代号中间；范围过短或在文档视图中不唯一时向两侧扩展，直到唯一或回到整句。
 */
export function minimalEdit(anchor: string, proposed: string, view: string): { anchor: string; proposed: string } {
  if (!proposed || anchor === proposed) return { anchor, proposed };
  let p = 0;
  while (p < anchor.length && p < proposed.length && anchor[p] === proposed[p]) p++;
  let s = 0;
  while (s < anchor.length - p && s < proposed.length - p && anchor[anchor.length - 1 - s] === proposed[proposed.length - 1 - s]) s++;
  // 不切开代号：切点落在代号内部时退到代号边界
  const tokenSpans = [...anchor.matchAll(TOKEN_SPAN)].map((m) => [m.index!, m.index! + m[0].length] as const);
  const fix = () => {
    for (const [a, b] of tokenSpans) {
      if (p > a && p < b) p = a;
      const end = anchor.length - s;
      if (end > a && end < b) s = anchor.length - b;
    }
  };
  fix();
  const occurrences = (needle: string) => {
    let n = 0;
    for (let at = view.indexOf(needle); at >= 0 && n < 2; at = view.indexOf(needle, at + 1)) n++;
    return n;
  };
  for (;;) {
    const a = anchor.slice(p, anchor.length - s);
    if (a.length >= 4 && occurrences(a) === 1) return { anchor: a, proposed: proposed.slice(p, proposed.length - s) };
    if (p === 0 && s === 0) return { anchor, proposed };
    // 两侧各扩一字（先扩短的一侧），再修正代号边界
    if (p > 0) p--;
    if (s > 0) s--;
    fix();
  }
}

/**
 * 卡上存的锚点在当前视图里找不到时重新定位（复核 C-B08）：当事人词典变了（新增别名等）会让同一段原文的代号形态变化；
 * 迁移 0022 之前的存量卡存的是 Agent 原话。先把锚点还原成原文再按当前词典令牌化，仍找不到就按忽略空白的口径定位，取视图里的原文。
 */
function currentAnchor(deps: ReviewDeps & { tokens: MatterTokenStore }, matterId: string, anchor: string, view: string): string {
  if (view.includes(anchor)) return anchor;
  const retokenized = deps.tokens.tokenize(matterId, deps.tokens.restore(matterId, anchor).text).text;
  if (view.includes(retokenized)) return retokenized;
  const loc = locateQuote(view, retokenized);
  return loc.status === "located" && loc.start !== null && loc.end !== null ? view.slice(loc.start, loc.end) : anchor;
}

/**
 * 修订稿：接受与修改后接受的卡 → 结构化补丁 → 原件副本上的原生修订（草稿成果）。
 * 有卡不能定位时整体返回预览，逐卡给出原因；律师可带 skip_card_ids 跳过后再生成。
 */
/**
 * 修订稿与“接受后”预览共用的计划（余项续复核 RC-B-01：两处同一口径）：取接受与修改后接受的卡，按位置排序，
 * 逐张求当前锚点与最小修改范围；改后文本与原文相同的卡（例如没有建议时“修改后接受”只确认了一下原文）不进修订稿（RC-B-02）。
 */
function planRedline(
  deps: ReviewDeps & { tokens: MatterTokenStore },
  input: { matter_id: string; document_version_id: string; run_id?: string | null; skip_card_ids?: readonly string[] },
): { cards: RiskCardRow[]; patches: StructuredPatch[]; unchanged: RiskCardRow[] } {
  const skip = new Set(input.skip_card_ids ?? []);
  const all = listRiskCards(deps.db, input.matter_id, {
    document_version_id: input.document_version_id,
    status: ["accepted", "modified"],
    ...(input.run_id ? { run_id: input.run_id } : {}),
  })
    .filter((c) => !skip.has(c.card_id))
    // 知悉、不改动的卡不进修订稿——否则空的建议文本会被当成“删除这段原文”
    .filter(changesDocument);
  // 按文档中的位置排序（结构化补丁对重叠另行检查）
  all.sort((a, b) => (a.anchor_start ?? 1e12) - (b.anchor_start ?? 1e12));
  const view = all.length > 0 ? documentView(deps, input.matter_id, input.document_version_id).view : "";
  const cards: RiskCardRow[] = [];
  const patches: StructuredPatch[] = [];
  const unchanged: RiskCardRow[] = [];
  for (const c of all) {
    const basis = c.basis.length > 0 ? `（依据：${c.basis.map((b) => `《${b.law}》${b.article ? `第${b.article}条` : ""}`).join("、")}）` : "";
    // 律师改写的文本是原文：先按本事项令牌化成与视图同一形态，再与引文比出最小修改范围（结构化补丁引擎会把代号还原回原文）
    const full = c.status === "modified" ? deps.tokens.tokenize(input.matter_id, c.final_text ?? "").text : (c.suggestion ?? "");
    const anchor = currentAnchor(deps, input.matter_id, c.anchor_text, view);
    if (full === anchor) {
      unchanged.push(c);
      continue;
    }
    const m = minimalEdit(anchor, full, view);
    cards.push(c);
    patches.push({
      anchor: m.anchor,
      expected_text_hash: sha256Hex(m.anchor),
      proposed_text: m.proposed,
      ...(c.clause_ref ? { paragraph_hint: c.clause_ref } : {}),
      comment: `${c.severity === "high" ? "【重大】" : c.severity === "mid" ? "【一般】" : "【提示】"}${c.issue}${basis}${c.status === "modified" ? "（律师已修改）" : ""}`,
    });
  }
  return { cards, patches, unchanged };
}

/** 预览里每张会改动合同的卡的结果：落点（原文坐标）或不能写进修订稿的原因。 */
export type RedlinePreviewCard =
  | { card_id: string; ok: true; para: number; start: number; end: number; old: string; new: string }
  | { card_id: string; ok: false; reason: "unchanged" | PatchConflict["reason"] };

/**
 * 工作台“接受后”预览（余项续复核 RC-B-01）：与生成修订稿同一套计划、定位、最小修改范围与重叠检查，但不写文件、不登记成果。
 * 返回原件段落（原文）与逐卡落点；文档层面不能生成（不是 Word、已有新版本、没有要改的）时给出原因。
 */
export function previewRedlineFromCards(
  deps: ReviewDeps & { tokens: MatterTokenStore },
  input: { matter_id: string; document_version_id: string; run_id?: string | null },
): { status: "ok" | "conflicts" | "not_docx" | "document_version_superseded" | "no_patches"; paragraphs: string[]; cards: RedlinePreviewCard[] } {
  const plan = planRedline(deps, input);
  const unchanged: RedlinePreviewCard[] = plan.unchanged.map((c) => ({ card_id: c.card_id, ok: false, reason: "unchanged" }));
  if (plan.cards.length === 0) return { status: "no_patches", paragraphs: [], cards: unchanged };
  const r = applyStructuredPatches(
    { db: deps.db, blobs: deps.blobs, tokens: deps.tokens },
    { matter_id: input.matter_id, document_version_id: input.document_version_id, patches: plan.patches, created_by: "preview", run_id: null, author: LAWYER_APPROVED_AUTHOR, dryRun: true },
  );
  if (r.status !== "preview" || r.reason === "not_docx" || r.reason === "document_version_superseded" || r.reason === "no_patches") {
    return { status: r.status === "preview" && r.reason !== "conflicts" && r.reason !== "dry_run" ? r.reason : "no_patches", paragraphs: [], cards: unchanged };
  }
  const conflict = new Map(r.conflicts.map((c) => [c.index, c.reason]));
  const spans = new Map((r.spans ?? []).map((x) => [x.index, x]));
  const cards: RedlinePreviewCard[] = plan.cards.map((c, i) => {
    const bad = conflict.get(i);
    const sp = spans.get(i);
    if (bad || !sp) return { card_id: c.card_id, ok: false, reason: bad ?? "anchor_not_found" };
    return { card_id: c.card_id, ok: true, para: sp.para, start: sp.start, end: sp.end, old: sp.old, new: sp.new };
  });
  return { status: r.reason === "conflicts" ? "conflicts" : "ok", paragraphs: r.paragraphs ?? [], cards: [...cards, ...unchanged] };
}

export function buildRedlineFromCards(
  deps: ReviewDeps & { tokens: MatterTokenStore },
  input: { matter_id: string; document_version_id: string; run_id?: string | null; skip_card_ids?: readonly string[]; created_by: string },
): { result: PatchResult; cards: { card_id: string; index: number }[]; skipped: string[] } {
  const skip = new Set(input.skip_card_ids ?? []);
  const { cards, patches } = planRedline(deps, input);
  if (cards.length === 0) throw new DomainError("validation", "没有需要写进修订稿的修改：请先在工作台接受有建议文本的卡，或修改后接受（改后与原文相同的不算）", 422);
  // 修订稿归哪次任务（复核 RB16B-10）：没指定时，写进去的卡都来自同一次任务就挂到那次任务（交付件按任务分组时与意见书、清单在一组）
  const runs = new Set(cards.map((c) => c.run_id));
  const attributedRun = input.run_id ?? (runs.size === 1 ? ([...runs][0] ?? null) : null);
  // 成果登记与决定快照同一事务（复核 C-B09）：不会出现没有决定记录的“律师审定”修订稿
  return deps.db.tx(() => {
    const result = applyStructuredPatches(
      { db: deps.db, blobs: deps.blobs, tokens: deps.tokens },
      { matter_id: input.matter_id, document_version_id: input.document_version_id, patches, created_by: input.created_by, run_id: attributedRun, author: LAWYER_APPROVED_AUTHOR },
    );
    if (result.status === "applied") {
      // 修订稿绑定生成时律师的逐卡决定（复核 B3-B05）：“律师审定”的作者标注有可核对的依据；之后改了决定，这份修订稿的记录不变
      const decisions = cards.map((c) => ({
        card_id: c.card_id,
        run_id: c.run_id,
        status: c.status,
        final_text_sha256: c.final_text ? sha256Hex(c.final_text) : null,
        decided_by: c.decided_by,
        decided_at: c.decided_at,
      }));
      const row = deps.db.get<{ manifest: string }>(`SELECT manifest FROM artifact_versions WHERE artifact_version_id = ?`, [result.artifact_version_id]);
      let manifest: Record<string, unknown> = {};
      try {
        manifest = JSON.parse(row?.manifest ?? "{}") as Record<string, unknown>;
      } catch {
        manifest = {};
      }
      deps.db.run(`UPDATE artifact_versions SET manifest = ? WHERE artifact_version_id = ?`, [
        JSON.stringify({ ...manifest, lawyer_decisions: decisions, lawyer_decisions_sha256: sha256Hex(JSON.stringify(decisions)), skipped_card_ids: [...skip] }),
        result.artifact_version_id,
      ]);
    }
    return { result, cards: cards.map((c, index) => ({ card_id: c.card_id, index })), skipped: [...skip] };
  });
}

// ─── 事实行 ───

export function submitFacts(deps: ReviewDeps, scope: ToolScope, input: { facts?: unknown }) {
  const facts = Array.isArray(input.facts) ? input.facts : [];
  if (facts.length === 0) throw new DomainError("validation", "facts 不能为空", 422);
  if (facts.length > FACT_LIMITS.perCall) throw new DomainError("validation", `一次最多提交 ${FACT_LIMITS.perCall} 条事实，请分批`, 422);
  const base = runSeqBase(deps.db, "matter_facts", scope.matterId, scope.runId);
  if (base.count + facts.length > FACT_LIMITS.perRun) throw new DomainError("validation", `本任务事实行已达上限 ${FACT_LIMITS.perRun}`, 422);
  const views = new Map<string, string>();
  const out: { fact_id: string; seq: number; anchor_status: string }[] = [];
  deps.db.tx(() => {
    facts.forEach((f: any, i: number) => {
      const statement = str(f?.statement, FACT_LIMITS.field);
      if (!statement) throw new DomainError("validation", `第 ${i + 1} 条事实缺少 statement`, 422);
      // Agent 不能把事实标为“律师确认”
      const kind = ["claimed", "inferred", "to_confirm"].includes(f?.kind) ? (f.kind as string) : "to_confirm";
      const occurredOn = typeof f?.occurred_on === "string" && /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(f.occurred_on) ? (f.occurred_on as string) : null;
      const amount = typeof f?.amount_yuan === "number" && Number.isFinite(f.amount_yuan) ? f.amount_yuan : null;
      const docId = optStr(f?.document_version_id, 80);
      const quote = optStr(f?.quote, FACT_LIMITS.field);
      let loc: { status: string; start: number | null; end: number | null } = { status: "no_document", start: null, end: null };
      if (docId) {
        if (!views.has(docId)) views.set(docId, documentView(deps, scope.matterId, docId).view);
        loc = quote ? locateQuote(views.get(docId)!, quote) : { status: "not_found", start: null, end: null };
      }
      const id = newId("fact");
      const seq = base.next + i;
      deps.db.run(
        `INSERT INTO matter_facts (fact_id, tenant_id, matter_id, run_id, seq, statement, kind, occurred_on, amount_yuan, party, document_version_id, quote, anchor_start, anchor_end, anchor_status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, scope.tenantId, scope.matterId, scope.runId, seq, statement, kind, occurredOn, amount, optStr(f?.party, 200), docId, quote, loc.start, loc.end, loc.status],
      );
      out.push({ fact_id: id, seq, anchor_status: loc.status });
    });
  });
  const unanchored = out.filter((x) => x.anchor_status !== "located").length;
  return {
    submitted: out.length,
    facts: out,
    note: unanchored > 0 ? `${unanchored} 条事实没有在材料中定位到逐字引文：律师确认前不会被文书与汇报引用` : "已提交，律师确认后才可被文书与汇报引用",
  };
}

export interface FactRow {
  fact_id: string;
  run_id: string | null;
  seq: number;
  statement: string;
  kind: string;
  occurred_on: string | null;
  amount_yuan: number | null;
  party: string | null;
  document_version_id: string | null;
  quote: string | null;
  anchor_status: string;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
}

export function listFacts(db: KernelDb, matterId: string, f: { run_id?: unknown; status?: unknown; kind?: unknown } = {}): FactRow[] {
  const where = ["matter_id = ?"];
  const args: unknown[] = [matterId];
  if (typeof f.run_id === "string" && f.run_id) {
    where.push("run_id = ?");
    args.push(f.run_id);
  }
  const statuses = (Array.isArray(f.status) ? f.status : typeof f.status === "string" ? [f.status] : []).filter((s) => ["proposed", "confirmed", "rejected"].includes(String(s)));
  if (statuses.length > 0) {
    where.push(`status IN (${statuses.map(() => "?").join(",")})`);
    args.push(...statuses);
  }
  return db
    .all<any>(
      `SELECT fact_id, run_id, seq, statement, kind, occurred_on, amount_yuan, party, document_version_id, quote, anchor_status, status, decided_by, decided_at
         FROM matter_facts WHERE ${where.join(" AND ")} ORDER BY COALESCE(occurred_on, '9999'), seq LIMIT 2000`,
      args,
    )
    .map((r) => ({ ...r }));
}

export function decideFact(db: KernelDb, matterId: string, userId: string, input: { fact_id?: unknown; decision?: unknown; statement?: unknown }): FactRow {
  const id = str(input.fact_id, 80);
  const row = db.get<any>(`SELECT * FROM matter_facts WHERE fact_id = ?`, [id]);
  if (!row || row.matter_id !== matterId) throw notFound("事实");
  const decision = String(input.decision ?? "");
  const now = new Date().toISOString();
  if (decision === "confirm") {
    const statement = optStr(input.statement, FACT_LIMITS.field);
    db.run(`UPDATE matter_facts SET status = 'confirmed', kind = 'confirmed', statement = COALESCE(?, statement), decided_by = ?, decided_at = ? WHERE fact_id = ?`, [statement, userId, now, id]);
  } else if (decision === "reject") {
    db.run(`UPDATE matter_facts SET status = 'rejected', decided_by = ?, decided_at = ? WHERE fact_id = ?`, [userId, now, id]);
  } else if (decision === "reset") {
    db.run(`UPDATE matter_facts SET status = 'proposed', kind = CASE kind WHEN 'confirmed' THEN 'to_confirm' ELSE kind END, decided_by = NULL, decided_at = NULL WHERE fact_id = ?`, [id]);
  } else throw new DomainError("validation", "decision 须为 confirm / reject / reset", 422);
  return listFacts(db, matterId).find((f) => f.fact_id === id)!;
}
