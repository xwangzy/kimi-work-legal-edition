/**
 * 没勾材料的任务实际读了哪几份（第 71 批 D1）。
 *
 * D-183：开始面板一份材料都不勾 = 本事项的现行材料都可读，助手用 materials.read_excerpt 按需读取。此前复核页“系统已核对 · 材料读取”
 * 只看发起时的勾选（materials.loaded 的 loaded / requested），没勾就写成“已读 0/0 份”并打绿勾——助手明明读了 3 份，
 * 给律师的读材料证据与事实相反。现在：
 * - 发起时把本事项的现行材料（未隔离、未被新版本取代）记进 materials.loaded 的 on_demand（份数与编号）——分母；
 * - 助手每次成功读取材料片段，工具账本（tool_operations.result_summary）记下读的是哪份材料的编号——分子按去重后的份数算；
 * - 老任务没有这两样记录的，如实写“没有逐份读取记录”，不推算。
 */
import type { KernelDb } from "../db.ts";
import { MATERIAL_READ_TOOL } from "../tools/result-summary.ts";

/** 发起时记下的本事项现行材料（编号最多记 500 份，份数照实）。 */
export interface OnDemandMaterials {
  total: number;
  ids: string[];
}

const MAX_IDS = 500;

/** 本事项的现行材料：未隔离、没有被新版本取代（与 materials.list 给助手的“本事项全部现行材料”同一口径）。 */
export function onDemandMaterialsOf(db: KernelDb, matterId: string): OnDemandMaterials {
  const rows = db.all<{ document_version_id: string }>(
    `SELECT dv.document_version_id FROM document_versions dv
      WHERE dv.matter_id = ? AND dv.quarantined_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM document_versions n WHERE n.supersedes = dv.document_version_id)
      ORDER BY dv.created_at`,
    [matterId],
  );
  return { total: rows.length, ids: rows.slice(0, MAX_IDS).map((r) => r.document_version_id) };
}

/** 这几次运行里助手成功读过的材料编号（去重；工具账本里没记编号的老记录不算）。 */
export function materialIdsRead(db: KernelDb, runIds: readonly string[]): Set<string> {
  const out = new Set<string>();
  if (runIds.length === 0) return out;
  const rows = db.all<{ result_summary: string | null }>(
    `SELECT result_summary FROM tool_operations WHERE tool = ? AND status = 'succeeded' AND run_id IN (${runIds.map(() => "?").join(",")})`,
    [MATERIAL_READ_TOOL, ...runIds],
  );
  for (const r of rows) {
    try {
      const doc = r.result_summary ? (JSON.parse(r.result_summary) as { doc?: unknown }).doc : undefined;
      if (typeof doc === "string" && doc) out.add(doc);
    } catch {
      // 摘要坏了不影响别的行
    }
  }
  return out;
}

/** 复核页“材料读取”一项的数据（内核完整性单 completeness.materials）。 */
export type MaterialsCheck =
  | { note: string }
  | { loaded: number; requested: number; failed: number }
  | { on_demand: true; total: number; read: number; unread_files: string[]; tracked: true }
  | { on_demand: true; tracked: false };

/**
 * 由 materials.loaded 的记录与实际读取记录得出“材料读取”一项。纯函数（文件名由调用方按编号查好传入）。
 * - 勾了材料：照旧按发起时载入的份数（loaded / requested / failed）；
 * - 没勾、有 on_demand 记录：分母是发起时本事项的现行材料份数，分子是其中实际读过的份数，另列没读的文件名（最多 5 个）；
 * - 没勾、老任务没有 on_demand 记录：tracked=false，界面如实写“没有逐份读取记录”。
 */
export function materialsCheckOf(loaded: Record<string, unknown> | null, readIds: ReadonlySet<string>, nameOf: (id: string) => string | null): MaterialsCheck {
  if (!loaded) return { note: "非任务产出" };
  const requested = Number(loaded.requested ?? 0) || 0;
  if (requested > 0) return { loaded: Number(loaded.loaded ?? 0) || 0, requested, failed: Number(loaded.failed ?? 0) || 0 };
  const od = loaded.on_demand as { total?: unknown; ids?: unknown } | undefined;
  if (!od || typeof od !== "object" || !Array.isArray(od.ids)) return { on_demand: true, tracked: false };
  const ids = (od.ids as unknown[]).map(String);
  const total = Math.max(Number(od.total ?? ids.length) || 0, ids.length);
  const readList = ids.filter((id) => readIds.has(id));
  const unread = ids.filter((id) => !readIds.has(id));
  return {
    on_demand: true,
    tracked: true,
    total,
    read: readList.length,
    unread_files: unread
      .slice(0, 5)
      .map((id) => nameOf(id))
      .filter((n): n is string => !!n),
  };
}
