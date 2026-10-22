/**
 * 事项的统一待核清单（v9.4 第 21 批；V9.4 主文 §6.4“缺口与待核：统一待核清单对象缺”）：
 * 律师要核的东西散在事实、表格审阅、审查工作台、论点提纲、成果未决项里——这里按“还等律师做什么”一处列全，每项给去处。
 * 只读、现算（状态只有一份，不另存一张表）；引用的逐条决定按成果版本由调用方补（要用本机法规库现算）。
 */
import type { KernelDb } from "../db.ts";

export type PendingKind = "facts" | "table_cells" | "risk_cards" | "outlines" | "open_items" | "citations";

export interface PendingCheck {
  kind: PendingKind;
  count: number;
  /** 律师看到的一句话。 */
  text: string;
  /** 去处：事项标签（facts / materials 表格审阅 / 工作台某份合同）、任务或成果。 */
  target:
    | { tab: "facts" }
    | { tab: "materials"; view: "table"; table_id: string }
    | { workbench: string | null }
    | { run_id: string }
    | { artifact_version_id: string };
}

const OPEN_ITEM_TEXT: Record<string, string> = {
  table_cells_unverified: "来自审阅表、还没核的内容",
  outline_unconfirmed: "论点未经确认",
  citation_intercepted: "引用核对没通过",
  quarantined_source: "来源材料已隔离",
};

/** 还没签发的最新版本成果（引用逐条决定由调用方按本机法规库现算）。 */
export function unsignedLatestArtifacts(db: KernelDb, matterId: string, limit = 20): { artifact_version_id: string; matter_id: string; filename: string; storage_uri: string }[] {
  return db.all(
    `SELECT a.artifact_version_id, a.matter_id, a.filename, a.storage_uri FROM artifact_versions a
      WHERE a.matter_id = ? AND a.status IN ('draft','pending_review','pending_verification')
        AND a.version = (SELECT MAX(b.version) FROM artifact_versions b WHERE b.matter_id = a.matter_id AND b.kind = a.kind AND b.audience = a.audience)
      ORDER BY a.created_at DESC LIMIT ?`,
    [matterId, limit],
  );
}

export function pendingChecks(db: KernelDb, matterId: string): PendingCheck[] {
  const out: PendingCheck[] = [];
  const facts = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM matter_facts WHERE matter_id = ? AND status = 'proposed'`, [matterId])!.n;
  if (facts > 0) out.push({ kind: "facts", count: facts, text: `${facts} 条事实等你确认（确认过的才进文书）`, target: { tab: "facts" } });

  for (const t of db.all<{ table_id: string; title: string; n: number }>(
    `SELECT t.table_id, t.title, COUNT(c.cell_id) AS n FROM review_tables t JOIN review_cells c ON c.table_id = t.table_id
      WHERE t.matter_id = ? AND c.state IN ('ai','conflict') GROUP BY t.table_id ORDER BY t.created_at`,
    [matterId],
  ))
    out.push({ kind: "table_cells", count: t.n, text: `审阅表《${t.title}》有 ${t.n} 格没核`, target: { tab: "materials", view: "table", table_id: t.table_id } });

  for (const c of db.all<{ document_version_id: string | null; filename: string | null; n: number; high: number }>(
    `SELECT r.document_version_id, d.filename, COUNT(*) AS n, SUM(CASE WHEN r.severity = 'high' THEN 1 ELSE 0 END) AS high
       FROM risk_cards r LEFT JOIN document_versions d ON d.document_version_id = r.document_version_id
      WHERE r.matter_id = ? AND r.status = 'proposed' AND (d.quarantined_at IS NULL) GROUP BY r.document_version_id ORDER BY high DESC, n DESC`,
    [matterId],
  ))
    out.push({
      kind: "risk_cards",
      count: c.n,
      text: `${c.filename ? `《${c.filename}》` : "未关联合同的意见"}有 ${c.n} 条审查意见没处理${c.high > 0 ? `（其中重大 ${c.high} 条）` : ""}`,
      target: { workbench: c.document_version_id },
    });

  for (const o of db.all<{ run_id: string }>(`SELECT DISTINCT run_id FROM argument_outlines WHERE matter_id = ? AND status = 'proposed' AND run_id IS NOT NULL`, [matterId]))
    out.push({ kind: "outlines", count: 1, text: "起草前的论点与依据等你确认", target: { run_id: o.run_id } });

  // 成果的未决项（只看还没签发的最新版本）：表格内容没核、论点未经确认等
  for (const a of db.all<{ artifact_version_id: string; filename: string; open_items: string | null }>(
    `SELECT a.artifact_version_id, a.filename, a.open_items FROM artifact_versions a
      WHERE a.matter_id = ? AND a.status IN ('draft','pending_review','pending_verification')
        AND a.version = (SELECT MAX(b.version) FROM artifact_versions b WHERE b.matter_id = a.matter_id AND b.kind = a.kind AND b.audience = a.audience)`,
    [matterId],
  )) {
    let items: { kind?: string; count?: number }[] = [];
    try {
      const v = JSON.parse(a.open_items ?? "[]");
      items = Array.isArray(v) ? v : [];
    } catch {
      items = [];
    }
    const known = items.filter((x) => typeof x?.kind === "string" && OPEN_ITEM_TEXT[x.kind]);
    if (known.length === 0) continue;
    const n = known.reduce((k, x) => k + (Number.isFinite(x.count) && (x.count as number) > 0 ? (x.count as number) : 1), 0);
    out.push({ kind: "open_items", count: n, text: `《${a.filename}》有未决项：${[...new Set(known.map((x) => OPEN_ITEM_TEXT[x.kind!]))].join("、")}`, target: { artifact_version_id: a.artifact_version_id } });
  }
  return out;
}
