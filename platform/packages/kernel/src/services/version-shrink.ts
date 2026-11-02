/**
 * 版本缩水检查（第 35 批真实走查 R1）：同一任务里重出的同名文书或表格比上一版明显变短时，随工具结果提示助手核对是否漏了内容。
 *
 * 《起草说明与待定事项》同一任务里重出 5 次，“起草说明”表从 21 行减到 10 行、“一致性检查”从 24 行减到 12 行，界面只列最新一版——
 * 律师拿到的恰恰是内容最少的一份；修复前 N1 的《股权转让协议》第 4、5 版同样把“定义与解释”从 9 款压成 6 款。
 * 只比字数（文书：标题与各节段落、表格格子的文字；表格：全部格子的文字），比上一版少 20% 以上才提示；纯查询，不拦截生成。
 */
import type { KernelDb } from "../db.ts";

/** 缩水阈值：新版字数低于上一版的 80% 时提示。 */
const SHRINK_RATIO = 0.8;

/** 文书各节（heading、paragraphs、table）的文字总字数。 */
export function sectionChars(sections: unknown): number {
  if (!Array.isArray(sections)) return 0;
  let n = 0;
  for (const s of sections as { heading?: unknown; paragraphs?: unknown; table?: { columns?: unknown; rows?: unknown } }[]) {
    n += String(s?.heading ?? "").length;
    if (Array.isArray(s?.paragraphs)) for (const p of s.paragraphs) n += String(p ?? "").length;
    if (s?.table && typeof s.table === "object") n += cellChars([s.table.columns, ...(Array.isArray(s.table.rows) ? s.table.rows : [])]);
  }
  return n;
}

/** 表格行（每行一个数组）的格子文字总字数。 */
export function cellChars(rows: unknown): number {
  if (!Array.isArray(rows)) return 0;
  let n = 0;
  for (const r of rows) if (Array.isArray(r)) for (const c of r) n += c === null || c === undefined ? 0 : String(c).length;
  return n;
}

export interface ShrinkNote {
  previous_artifact_version_id: string;
  previous_chars: number;
  current_chars: number;
  note: string;
}

/** 本版字数不到同一任务里同名、同类的上一版（按登记时间）的 80% 时，返回提示；否则 null。 */
export function shrinkCheck(db: KernelDb, runId: string | undefined | null, kind: string, filename: string, currentId: string, currentChars: number): ShrinkNote | null {
  if (!runId || currentChars <= 0) return null;
  const prev = db.get<{ artifact_version_id: string; manifest: string | null }>(
    `SELECT artifact_version_id, manifest FROM artifact_versions WHERE run_id = ? AND kind = ? AND filename = ? AND artifact_version_id <> ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    [runId, kind, filename, currentId],
  );
  if (!prev) return null;
  let prevChars = 0;
  try {
    prevChars = Number(JSON.parse(prev.manifest ?? "{}")?.text_chars ?? 0);
  } catch {
    prevChars = 0;
  }
  if (!(prevChars > 0) || currentChars >= prevChars * SHRINK_RATIO) return null;
  const pct = Math.round((1 - currentChars / prevChars) * 100);
  return {
    previous_artifact_version_id: prev.artifact_version_id,
    previous_chars: prevChars,
    current_chars: currentChars,
    note: `这一版比本任务上一版《${filename.replace(/\.(docx|xlsx)$/i, "")}》少了约 ${pct}%（上一版约 ${prevChars} 字，这一版约 ${currentChars} 字）。重新生成时应保留上一版的全部内容、只改要改的地方：核对是否漏了条款、款项、表格行或说明，漏了的补回；确属有意删减的，在最终答复里写明删了什么、为什么。界面只列最新一版，律师拿到的就是这一版`,
  };
}
