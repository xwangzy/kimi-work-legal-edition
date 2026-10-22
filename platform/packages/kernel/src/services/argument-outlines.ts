/**
 * 起草前的“论点与依据”确认（v9.4 第 19 批 C-04；评审 C1 §1“起草前先让律师选论点和依据”、§4.1“它撑得住这句话吗”）。
 *
 * - 提交（Agent，经法律工具 outline.submit）：文书类任务（起诉状、答辩状、代理词、研究备忘录等）起草前，把拟写的论点逐条列出，
 *   每条附依据（法名 + 条号 + 怎么支持这个论点）与所用事实；内核逐条离线核验依据（来源与版本），法规库里有正文的附上条文原文，
 *   事实引用核对是否为律师已确认的事实——律师当场比对，不用等文书写完才发现依据撑不住论点；
 * - 确认（律师，在任务页）：逐条“留 / 删”、可改写论点、可去掉不用的依据；确认后 Agent 用 outline.get 读取确认版，只按确认版起草；
 * - 门禁：本任务有待确认的提纲时，docx.render_report 拒绝生成文书（assertOutlineSettled）。没有提纲的任务不受影响。
 *
 * 文字字段按 Agent 提交时的令牌形态保存（同风险卡）；律师改写的论点为原文，交回 Agent 时由本机端点统一令牌化。
 */
import { DomainError, newId, notFound } from "@zr-legal/domain";
import type { Lawdb } from "@zr-legal/lawdb";
import type { KernelDb } from "../db.ts";
import { citationsVerify } from "../tools/tools/citations.ts";
import { lawGetArticle } from "../tools/tools/law.ts";
import { localToday } from "./local-date.ts";

export const OUTLINE_LIMITS = { args: 30, basisPerArg: 8, factsPerArg: 12, field: 2_000, perRun: 10 } as const;

export interface OutlineBasis {
  law: string;
  article: number | null;
  /** 这条依据怎么支持论点（Agent 的说明，令牌形态）。 */
  note: string | null;
  /** 离线核验：version_verified / source_verified / support_pending / intercepted / unverified_offline / unchecked。 */
  check: string;
  matched: string | null;
  /** 法规库里的条文原文（公开法律文本；库外或未采集为空）。 */
  article_text: string | null;
  /** 法规库是演示数据时为 true（不得作为正式引用）。 */
  demo: boolean;
}

export interface OutlineFact {
  fact_id: string | null;
  statement: string;
  /** 律师已确认的事实（事实标签里确认过的）。 */
  confirmed: boolean;
}

export interface OutlineItem {
  arg_id: string;
  claim: string;
  basis: OutlineBasis[];
  facts: OutlineFact[];
  /** 对方可能的反驳与应对（可省略）。 */
  counter: string | null;
}

export interface OutlineDecision {
  arg_id: string;
  keep: boolean;
  /** 律师改写的论点（原文）；没改为空。 */
  claim: string | null;
  /** 保留的依据下标（按 basis 顺序）；缺省全留。 */
  basis_keep: number[] | null;
}

export interface OutlineRow {
  outline_id: string;
  run_id: string | null;
  seq: number;
  doc_kind: string;
  title: string | null;
  items: OutlineItem[];
  status: "proposed" | "confirmed" | "withdrawn";
  decisions: OutlineDecision[] | null;
  lawyer_note: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const optStr = (v: unknown, max: number): string | null => str(v, max) || null;

function asOfFor(db: KernelDb, matterId: string): string {
  try {
    const kd = JSON.parse(db.get<{ key_dates: string | null }>(`SELECT key_dates FROM matters WHERE matter_id = ?`, [matterId])?.key_dates ?? "{}") as { analysis_as_of?: string };
    if (kd.analysis_as_of && /^\d{4}-\d{2}-\d{2}$/.test(kd.analysis_as_of)) return kd.analysis_as_of;
  } catch {
    // 缺省今天
  }
  return localToday();
}

function verifyOutlineBasis(lawdb: Lawdb | undefined, asOf: string, raw: unknown): OutlineBasis[] {
  const items = Array.isArray(raw) ? raw.slice(0, OUTLINE_LIMITS.basisPerArg) : [];
  return items.map((b: any): OutlineBasis => {
    const law = str(b?.law, 80).replace(/^《|》$/g, "");
    const article = Number.isInteger(b?.article) && b.article > 0 ? (b.article as number) : null;
    const note = optStr(b?.note, OUTLINE_LIMITS.field);
    const out: OutlineBasis = { law, article, note, check: "unchecked", matched: null, article_text: null, demo: false };
    if (!law || article === null || !lawdb) return out;
    try {
      const v = (citationsVerify(lawdb, { citations: [{ law, article }], as_of: asOf }) as { verdicts?: { state: string; matched_law_name: string | null }[] }).verdicts?.[0];
      out.check = v?.state ?? "unchecked";
      out.matched = v?.matched_law_name ?? null;
    } catch {
      // 核验失败按未核
    }
    try {
      const a = lawGetArticle(lawdb, { law, article, as_of: asOf });
      if (a.found) {
        out.article_text = a.text ?? null;
        out.demo = a.reliability === "demo_seed";
      }
    } catch {
      // 来源授权不足等：不附原文
    }
    return out;
  });
}

function rowOut(r: any): OutlineRow {
  const parse = <T>(s: string | null, d: T): T => {
    try {
      return s ? (JSON.parse(s) as T) : d;
    } catch {
      return d;
    }
  };
  return {
    outline_id: r.outline_id,
    run_id: r.run_id,
    seq: r.seq,
    doc_kind: r.doc_kind,
    title: r.title,
    items: parse<OutlineItem[]>(r.items, []),
    status: r.status,
    decisions: parse<OutlineDecision[] | null>(r.decisions, null),
    lawyer_note: r.lawyer_note,
    decided_by: r.decided_by,
    decided_at: r.decided_at,
    created_at: r.created_at,
  };
}

/** Agent 提交提纲：同一任务里再次提交即取代前一份待确认的提纲（已确认的保留为记录）。 */
export function submitOutline(
  deps: { db: KernelDb; lawdb?: Lawdb },
  scope: { tenantId: string; matterId: string; runId: string | null },
  input: { doc_kind?: unknown; title?: unknown; arguments?: unknown },
): { outline_id: string; status: "proposed"; arguments: { arg_id: string; basis_checks: string[]; basis_with_text: number; unconfirmed_facts: number }[]; note: string } {
  if (!scope.runId) throw new DomainError("forbidden", "只有任务内的调用可以提交论点提纲", 403);
  const docKind = str(input.doc_kind, 40);
  if (!docKind) throw new DomainError("validation", "doc_kind 不能为空（例如：起诉状、答辩状、代理词、法律研究备忘录）", 422);
  const args = Array.isArray(input.arguments) ? input.arguments : [];
  if (args.length === 0) throw new DomainError("validation", "arguments 不能为空：逐条列出拟写的论点", 422);
  if (args.length > OUTLINE_LIMITS.args) throw new DomainError("validation", `论点最多 ${OUTLINE_LIMITS.args} 条，请合并`, 422);
  const n = deps.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM argument_outlines WHERE run_id = ?`, [scope.runId])!.n;
  if (n >= OUTLINE_LIMITS.perRun) throw new DomainError("validation", `本任务提交提纲已达 ${OUTLINE_LIMITS.perRun} 次`, 422);
  const asOf = asOfFor(deps.db, scope.matterId);
  const items: OutlineItem[] = args.map((a: any, i: number): OutlineItem => {
    const claim = str(a?.claim, OUTLINE_LIMITS.field);
    if (!claim) throw new DomainError("validation", `第 ${i + 1} 条论点缺少 claim`, 422);
    const facts = (Array.isArray(a?.facts) ? a.facts.slice(0, OUTLINE_LIMITS.factsPerArg) : []).map((f: any): OutlineFact => {
      const factId = optStr(f?.fact_id, 80);
      if (factId) {
        const row = deps.db.get<{ matter_id: string; statement: string; status: string }>(`SELECT matter_id, statement, status FROM matter_facts WHERE fact_id = ?`, [factId]);
        if (!row || row.matter_id !== scope.matterId) throw new DomainError("validation", `第 ${i + 1} 条论点引用的事实 ${factId} 不在本事项`, 422);
        return { fact_id: factId, statement: row.statement, confirmed: row.status === "confirmed" };
      }
      return { fact_id: null, statement: str(f?.statement, OUTLINE_LIMITS.field), confirmed: false };
    }).filter((f: OutlineFact) => f.statement);
    return { arg_id: `a${i + 1}`, claim, basis: verifyOutlineBasis(deps.lawdb, asOf, a?.basis), facts, counter: optStr(a?.counter, OUTLINE_LIMITS.field) };
  });
  const id = newId("outline");
  deps.db.tx(() => {
    deps.db.run(`UPDATE argument_outlines SET status = 'withdrawn' WHERE run_id = ? AND status = 'proposed'`, [scope.runId]);
    const seq = deps.db.get<{ s: number }>(`SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM argument_outlines WHERE matter_id = ?`, [scope.matterId])!.s;
    deps.db.run(`INSERT INTO argument_outlines (outline_id, tenant_id, matter_id, run_id, seq, doc_kind, title, items) VALUES (?,?,?,?,?,?,?,?)`, [
      id,
      scope.tenantId,
      scope.matterId,
      scope.runId,
      seq,
      docKind,
      optStr(input.title, 120),
      JSON.stringify(items),
    ]);
  });
  const bad = items.flatMap((x) => x.basis).filter((b) => b.check === "intercepted").length;
  return {
    outline_id: id,
    status: "proposed",
    arguments: items.map((x) => ({ arg_id: x.arg_id, basis_checks: x.basis.map((b) => b.check), basis_with_text: x.basis.filter((b) => b.article_text).length, unconfirmed_facts: x.facts.filter((f) => !f.confirmed).length })),
    note:
      `提纲已提交，等待律师在任务页逐条确认。${bad ? `其中 ${bad} 条依据核验未通过（intercepted），请先改正后重新提交。` : ""}` +
      "下一步：用提问工具请律师确认（问题写“论点与依据已列在任务页，请确认后选择”，第一个选项写“已确认，按确认的论点起草”，第二个写“先不起草”）；" +
      "律师选第一个后用 outline.get 读取确认版，只按确认版起草：律师删掉的论点不写，改写过的论点按律师的写法，去掉的依据不引。确认之前本任务不能生成文书。",
  };
}

/** 本任务最新的提纲（Agent 读确认版用）。 */
export function latestOutline(db: KernelDb, runId: string): OutlineRow | null {
  const r = db.get<any>(`SELECT * FROM argument_outlines WHERE run_id = ? AND status <> 'withdrawn' ORDER BY seq DESC LIMIT 1`, [runId]);
  return r ? rowOut(r) : null;
}

export function listOutlines(db: KernelDb, matterId: string, f: { run_id?: unknown } = {}): OutlineRow[] {
  const byRun = typeof f.run_id === "string" && f.run_id;
  return db
    .all<any>(`SELECT * FROM argument_outlines WHERE matter_id = ? ${byRun ? "AND run_id = ?" : ""} AND status <> 'withdrawn' ORDER BY seq DESC LIMIT 50`, byRun ? [matterId, f.run_id] : [matterId])
    .map(rowOut);
}

/** 确认版：只含律师留下的论点（改写的按律师写法）与留下的依据。 */
export function confirmedView(o: OutlineRow): { arg_id: string; claim: string; lawyer_edited: boolean; basis: OutlineBasis[]; facts: OutlineFact[]; counter: string | null }[] {
  const dec = new Map((o.decisions ?? []).map((d) => [d.arg_id, d]));
  return o.items
    .filter((x) => dec.get(x.arg_id)?.keep !== false)
    .map((x) => {
      const d = dec.get(x.arg_id);
      const keep = d?.basis_keep ? new Set(d.basis_keep) : null;
      return { arg_id: x.arg_id, claim: d?.claim ?? x.claim, lawyer_edited: !!d?.claim, basis: x.basis.filter((_, i) => !keep || keep.has(i)), facts: x.facts, counter: x.counter };
    });
}

/** 律师确认：逐条留 / 删 / 改写、去掉不用的依据。至少留一条；已确认的提纲不能再改（Agent 重新提交新提纲即可）。 */
export function decideOutline(db: KernelDb, matterId: string, userId: string, input: { outline_id?: unknown; decisions?: unknown; note?: unknown }): OutlineRow {
  const id = str(input.outline_id, 80);
  const row = db.get<any>(`SELECT * FROM argument_outlines WHERE outline_id = ?`, [id]);
  if (!row || row.matter_id !== matterId) throw notFound("论点提纲");
  if (row.status !== "proposed") throw new DomainError("conflict", row.status === "confirmed" ? "这份提纲已确认" : "这份提纲已被新的提纲取代", 409);
  const o = rowOut(row);
  const raw = Array.isArray(input.decisions) ? input.decisions : [];
  const byId = new Map(raw.map((d: any) => [String(d?.arg_id ?? ""), d]));
  const decisions: OutlineDecision[] = o.items.map((x) => {
    const d: any = byId.get(x.arg_id) ?? {};
    const keepIdx = Array.isArray(d.basis_keep) ? [...new Set(d.basis_keep.filter((n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) < x.basis.length) as number[])].sort((a, b) => a - b) : null;
    return { arg_id: x.arg_id, keep: d.keep !== false, claim: optStr(d.claim, OUTLINE_LIMITS.field), basis_keep: keepIdx };
  });
  if (!decisions.some((d) => d.keep)) throw new DomainError("validation", "至少留一条论点；都不要的话请让助手停下或重新列", 422);
  db.run(`UPDATE argument_outlines SET status = 'confirmed', decisions = ?, lawyer_note = ?, decided_by = ?, decided_at = ? WHERE outline_id = ? AND status = 'proposed'`, [
    JSON.stringify(decisions),
    optStr(input.note, OUTLINE_LIMITS.field),
    userId,
    new Date().toISOString(),
    id,
  ]);
  return rowOut(db.get<any>(`SELECT * FROM argument_outlines WHERE outline_id = ?`, [id]));
}

/** 材料隔离时（复核 Q2-02）：提纲里抄过来的、来自被删事实的文字换成说明，不留原句。 */
export function scrubOutlineFacts(db: KernelDb, matterId: string, factIds: readonly string[]): void {
  if (factIds.length === 0) return;
  const gone = new Set(factIds);
  for (const r of db.all<{ outline_id: string; items: string }>(`SELECT outline_id, items FROM argument_outlines WHERE matter_id = ?`, [matterId])) {
    let items: OutlineItem[];
    try {
      items = JSON.parse(r.items) as OutlineItem[];
    } catch {
      continue;
    }
    let hit = false;
    for (const x of items)
      for (const f of x.facts)
        if (f.fact_id && gone.has(f.fact_id)) {
          f.statement = "（所依据的材料已隔离，这条事实已删除）";
          f.confirmed = false;
          hit = true;
        }
    if (hit) db.run(`UPDATE argument_outlines SET items = ? WHERE outline_id = ?`, [JSON.stringify(items), r.outline_id]);
  }
}

/**
 * 本任务的论点确认状态（复核 Q2-03）：有待确认的提纲 → pending；文书类方法（快照 skill_requires_outline）却没有已确认的提纲 → missing；
 * 其余 → ok（没有提纲的非文书任务不受影响）。
 */
export function outlineState(db: KernelDb, runId: string | null | undefined): "ok" | "pending" | "missing" {
  if (!runId) return "ok";
  const r = db.get<{ proposed: number; confirmed: number }>(
    `SELECT SUM(status = 'proposed') AS proposed, SUM(status = 'confirmed') AS confirmed FROM argument_outlines WHERE run_id = ?`,
    [runId],
  );
  if ((r?.proposed ?? 0) > 0) return "pending";
  let requires = false;
  try {
    requires = JSON.parse(db.get<{ input_snapshot: string | null }>(`SELECT input_snapshot FROM runs WHERE run_id = ?`, [runId])?.input_snapshot ?? "{}")?.skill_requires_outline === true;
  } catch {
    requires = false;
  }
  return requires && !(r?.confirmed ?? 0) ? "missing" : "ok";
}

/** 门禁：文书工具在论点与依据经律师确认之前拒绝生成文书（C1 §1：先确认论点与依据再写）。 */
export function assertOutlineSettled(db: KernelDb, runId: string | null | undefined): void {
  const st = outlineState(db, runId);
  if (st === "pending") throw new DomainError("conflict", "论点与依据还在等律师确认：请先用提问工具请律师确认，确认后用 outline.get 读取确认版再生成文书", 409);
  if (st === "missing") throw new DomainError("conflict", "这是文书类方法：请先用 outline.submit 提交论点与依据，经律师确认后再生成文书", 409);
}

/** 工作区文件或最终回复登记为成果时，论点没经确认的标一条未决项（复核 Q2-03：文书工具之外的出口；签发前须逐项处理）。 */
export function outlineOpenItems(db: KernelDb, runId: string): { kind: string; note: string }[] {
  return outlineState(db, runId) === "ok" ? [] : [{ kind: "outline_unconfirmed", note: "这份成果产出时，论点与依据还没经你确认：请核对论点与依据后再签发" }];
}
