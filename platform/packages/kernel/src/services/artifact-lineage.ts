/**
 * 成果的“同一份文件”（v9.4 第 25 批走查发现）：版本原来按（事项、种类、受众）编号与比较——同一事项里两次 Agent 任务各出一份 Word，
 * 种类都是 agent_report，后一份就成了前一份的“新版本”：前一份不能签发（“已有更新版本”），已签发的验签变成无效，交付包也把它算作被取代。
 * 改为按 lineage 判断“有没有更新版本”：
 * - 任务产出的文件：同一事项里同名（去掉日期）的是同一份文件的各版——重审同一份合同、重新起草起诉状是新版，起诉状与证据目录各算各的；
 * - 任务的最终回复草稿（都叫“草稿-日期.md”）：按追问链（追问沿 followup_of 回到最初那次任务），不同任务的回复不是同一份；
 * - 审查工作台导出的意见表、修订建议：按所审的那份合同；
 * - 表格审阅导出的表与文书：按那张审阅表；
 * - 没有 lineage 的（告知书、周报等每个事项一份的种类）照旧按种类。
 * 版本号仍按种类递增（库里的唯一约束不变）；界面显示的“第 n 版”是这份文件里的第几版。
 */
import type { KernelDb } from "../db.ts";

/** 文件名里的日期（fileDay 写的 2026-10-23）与“部分完成”不算文件身份：追问隔天再出、先部分后完整，仍是同一份。 */
export function docNameKey(filename: string): string {
  return filename.replace(/[-_ ]?\d{4}-\d{2}-\d{2}/g, "").replace(/-部分完成/g, "").trim();
}

/** 追问链的第一次任务（沿 input_snapshot.followup_of 回溯；防环，至多 100 步）。 */
export function chainRoot(db: KernelDb, runId: string): string {
  let cur = runId;
  const seen = new Set<string>();
  for (let i = 0; i < 100 && !seen.has(cur); i++) {
    seen.add(cur);
    const raw = db.get<{ input_snapshot: string | null }>(`SELECT input_snapshot FROM runs WHERE run_id = ?`, [cur])?.input_snapshot;
    let prev: unknown = null;
    try {
      prev = JSON.parse(raw ?? "{}")?.followup_of;
    } catch {
      prev = null;
    }
    if (typeof prev !== "string" || !prev) break;
    cur = prev;
  }
  return cur;
}

/** 最终回复草稿的种类：按追问链区分（文件名都一样）。 */
export const REPLY_DRAFT_KINDS: ReadonlySet<string> = new Set(["a1_agent_draft", "a1_agent_draft_partial"]);
export const runLineage = (db: KernelDb, runId: string, kind: string, filename: string): string =>
  REPLY_DRAFT_KINDS.has(kind) ? `run:${chainRoot(db, runId)}` : `name:${docNameKey(filename)}`;
export const docLineage = (documentVersionId: string | null | undefined): string | null => (documentVersionId ? `doc:${documentVersionId}` : null);
export const tableLineage = (tableId: string): string => `table:${tableId}`;

type ArtKey = { matter_id: string; kind: string; audience: string; lineage?: string | null };

/** 这份文件的最新版本号（同一 lineage；没有 lineage 的按种类）。 */
export function latestVersionOf(db: KernelDb, a: ArtKey): number {
  return db.get<{ v: number }>(
    `SELECT COALESCE(MAX(version), 0) AS v FROM artifact_versions WHERE matter_id = ? AND kind = ? AND audience = ? AND lineage IS ?`,
    [a.matter_id, a.kind, a.audience, a.lineage ?? null],
  )!.v;
}

/**
 * 给界面的版本信息：version 换成这份文件里的第几版、kind_version 留原编号、is_latest 是不是这份文件的最新版。
 * 一次查出同一事项里的全部版本按 lineage 分组，不逐行查库。
 */
export function withFileVersions<T extends { artifact_version_id: string; matter_id?: string; kind: string; audience?: string | null; version: number; lineage?: string | null }>(
  db: KernelDb,
  matterId: string,
  rows: readonly T[],
): (T & { kind_version: number; is_latest: boolean })[] {
  const all = db.all<{ artifact_version_id: string; kind: string; audience: string; version: number; lineage: string | null }>(
    `SELECT artifact_version_id, kind, audience, version, lineage FROM artifact_versions WHERE matter_id = ? ORDER BY version`,
    [matterId],
  );
  const groups = new Map<string, number[]>();
  const keyOf = (r: { kind: string; audience?: string | null; lineage?: string | null }) => `${r.kind}\u0000${r.audience ?? "internal"}\u0000${r.lineage ?? ""}`;
  for (const r of all) {
    const k = keyOf(r);
    const g = groups.get(k) ?? [];
    g.push(r.version);
    groups.set(k, g);
  }
  const lin = new Map(all.map((r) => [r.artifact_version_id, r.lineage]));
  return rows.map((r) => {
    const g = groups.get(keyOf({ ...r, lineage: r.lineage !== undefined ? r.lineage : (lin.get(r.artifact_version_id) ?? null) })) ?? [r.version];
    const ordinal = g.indexOf(r.version) + 1 || g.length;
    return { ...r, kind_version: r.version, version: ordinal, is_latest: r.version === g[g.length - 1] };
  });
}
