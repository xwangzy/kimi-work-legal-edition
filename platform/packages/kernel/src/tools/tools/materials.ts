/**
 * materials.read_excerpt — 读取事项材料的锚定片段。
 * 约束：令牌 claims 中的 mid 必须与材料所属事项一致；不泄露无权对象是否存在（§15.2 runs.events 同款纪律）。
 */
import { DomainError, notFound, sha256Hex } from "@zr-legal/domain";
import type { KernelDb } from "../../db.ts";

export interface MaterialsReadParams {
  parse_version_id: string;
  char_start?: number;
  char_end?: number;
  anchor_id?: string;
}

export interface MaterialsReadResult {
  parse_version_id: string;
  document_version_id: string;
  text: string;
  char_start: number;
  char_end: number;
  total_chars: number;
  text_hash: string;
}

export function materialsReadExcerpt(db: KernelDb, claimsMatterId: string | undefined, params: MaterialsReadParams): MaterialsReadResult {
  if (!claimsMatterId) throw new DomainError("forbidden", "令牌未绑定事项", 403);
  if (!params.parse_version_id) throw new DomainError("validation", "需要 parse_version_id", 422);

  const row = db.get<{ parse_version_id: string; document_version_id: string; matter_id: string }>(
    `SELECT pv.parse_version_id, pv.document_version_id, dv.matter_id
       FROM parse_versions pv JOIN document_versions dv ON dv.document_version_id = pv.document_version_id
      WHERE pv.parse_version_id = ?`,
    [params.parse_version_id],
  );
  // 无权/不存在统一 404：不泄露对象是否存在
  if (!row || row.matter_id !== claimsMatterId) throw notFound("材料");

  let start = params.char_start ?? 0;
  let end = params.char_end ?? Number.MAX_SAFE_INTEGER;
  if (params.anchor_id) {
    const a = db.get<{ char_start: number; char_end: number }>(
      `SELECT char_start, char_end FROM evidence_anchors WHERE anchor_id = ? AND parse_version_id = ?`,
      [params.anchor_id, params.parse_version_id],
    );
    if (!a) throw notFound("锚点");
    start = a.char_start;
    end = a.char_end;
  }
  const t = db.get<{ content: string }>(`SELECT content FROM parse_texts WHERE parse_version_id = ?`, [params.parse_version_id]);
  if (!t) throw notFound("解析文本");
  const content = t.content;
  const s = Math.max(0, Math.min(start, content.length));
  const e = Math.max(s, Math.min(end, content.length));
  return {
    parse_version_id: params.parse_version_id,
    document_version_id: row.document_version_id,
    text: content.slice(s, e),
    char_start: s,
    char_end: e,
    total_chars: content.length,
    text_hash: sha256Hex(content.slice(s, e)),
  };
}
