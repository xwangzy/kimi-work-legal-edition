/**
 * 结构化补丁（v9 第 02 篇 §8.4“修改原文档走结构化补丁”；第 04 篇 §11 P6）：
 *
 *   {document_version, anchor, expected_text_hash, proposed_text}
 *
 * - Agent 只见代号：补丁的锚点与新文本都是事项令牌形态；`expected_text_hash` = sha256(锚点在令牌化视图中的原样)；
 * - 内核核对：文档版本是当前版本（没有被新版本取代）、是 DOCX、每条补丁的 hash 一致、**锚点出现在当前版本的令牌化视图里**
 *   （内核按同一事项令牌化器复算原件全文的视图——把补丁绑定到 Agent 看到的文档内容；审查 S4-16）、锚点与新文本里的代号都在本事项令牌表里；
 *   代号由文书引擎按令牌表还原后，锚点必须在原件里唯一定位（或给出出现序号 / 条款提示）；
 * - **全部成立才写**：在原件的副本上生成原生修订（w:del / w:ins + 批注，作者标“AI 建议”），登记为草稿成果；原件区只读、不覆盖；
 * - 任何一条不成立：整体返回预览（逐条列出原因与还原后的文本），不做模糊替换、不写半个文件。
 */
import { DomainError, newId, sha256Hex } from "@zr-legal/domain";
import { applyRevisionsToDocx, extractParagraphs, type RevisionOp } from "@zr-legal/docx-engine";
import { findTokens } from "@zr-legal/tokenizer";
import type { KernelDb } from "../db.ts";
import type { BlobStore } from "../blobs.ts";
import type { MatterTokenStore } from "../egress/matter-tokens.ts";
import { docLineage } from "./artifact-lineage.ts";

export interface StructuredPatch {
  /** 锚点：原件中要修改的原文（事项令牌形态，与 Agent 看到的一致）。 */
  anchor: string;
  /** sha256(anchor)：补丁完整性。 */
  expected_text_hash: string;
  /** 新文本（令牌形态；空串 = 删除）。 */
  proposed_text: string;
  /** 第几次出现（从 0 起；缺省 0）。 */
  occurrence?: number;
  /** 条款号提示（锚点多处出现时用于定位）。 */
  paragraph_hint?: string;
  /** 批注（令牌形态）。 */
  comment?: string;
  /** 段后插入（v9.4 第 19 批 C-02 缺失条款）：不改锚点，在锚点所在段落之后插入 proposed_text（按换行分段）。 */
  insert_after?: boolean;
}

export interface PatchConflict {
  index: number;
  reason:
    | "anchor_hash_mismatch"
    | "anchor_not_in_view"
    | "unknown_token"
    | "anchor_not_found"
    | "anchor_ambiguous"
    | "anchor_empty"
    | "overlap"
    | "apply_failed";
  detail?: string;
}

export interface PatchPreviewItem {
  index: number;
  /** 还原后的锚点与新文本（只给可信界面看；不进日志）。 */
  anchor_restored: string;
  proposed_restored: string;
  ok: boolean;
}

export type PatchResult =
  | {
      status: "applied";
      artifact_version_id: string;
      filename: string;
      sha256: string;
      applied: number;
      tokens_restored: number;
      preview: PatchPreviewItem[];
    }
  | {
      status: "preview";
      /** dry_run：只试定位、全部成立（不写文件，见 dryRun）。 */
      reason: "document_version_superseded" | "not_docx" | "conflicts" | "no_patches" | "dry_run";
      conflicts: PatchConflict[];
      preview: PatchPreviewItem[];
      /** 只在 dryRun 时给出：原件的段落（原文）与每条补丁在段落里的落点（与生成修订稿同一套定位）。 */
      paragraphs?: string[];
      spans?: PatchSpan[];
    };

/** 补丁在原件段落里的落点（段落序号、起止位置，均按原文计）。 */
export interface PatchSpan {
  index: number;
  para: number;
  start: number;
  end: number;
  /** 被替换的原文与新文本（原文形态）。段后插入时 old 为锚点、new 为插入的条款，起止为锚点位置（用于重叠检查）。 */
  old: string;
  new: string;
  insert?: true;
}

const AUTHOR = "Kimi Work 法律助手（AI 建议，待律师确认）";

/** 合并写入时先做段后插入（不改原有段落文字），再做替换：替换不会把插入的锚点改掉（复核 Q2-06）；各自保持原先后次序。 */
const insertsFirst = (ops: readonly RevisionOp[]): RevisionOp[] => [...ops.filter((o) => o.insertAfter), ...ops.filter((o) => !o.insertAfter)];

export function applyStructuredPatches(
  deps: { db: KernelDb; blobs: BlobStore; tokens: MatterTokenStore },
  input: {
    matter_id: string;
    document_version_id: string;
    patches: StructuredPatch[];
    created_by: string;
    run_id?: string | null;
    author?: string;
    /** 只试定位与重叠检查、合并试写一遍，不登记成果（工作台“接受后”预览，余项续复核 RC-B-01）。 */
    dryRun?: boolean;
    /** 成果文件名后缀（缺省“（修订建议）”；工作台对外版 / 内部版各有后缀）。 */
    filename_suffix?: string;
  },
): PatchResult {
  const { db, blobs, tokens } = deps;
  const doc = db.get<{ document_version_id: string; matter_id: string; tenant_id: string; filename: string; sha256: string; storage_uri: string }>(
    `SELECT document_version_id, matter_id, tenant_id, filename, sha256, storage_uri FROM document_versions WHERE document_version_id = ? AND quarantined_at IS NULL`,
    [input.document_version_id],
  );
  if (!doc || doc.matter_id !== input.matter_id) throw new DomainError("not_found", "文档不存在或无权查看", 404);
  const patches = Array.isArray(input.patches) ? input.patches.slice(0, 500) : [];
  const blocked = tokens.conflicts(input.matter_id);
  const table = tokens.table(input.matter_id).filter((e) => !blocked.has(e.token));
  const restoreMap = new Map(table.map((e) => [e.token, e.value]));
  const restore = (s: string) => tokens.restore(input.matter_id, s);
  const preview: PatchPreviewItem[] = patches.map((p, index) => ({
    index,
    anchor_restored: restore(String(p?.anchor ?? "")).text,
    proposed_restored: restore(String(p?.proposed_text ?? "")).text,
    ok: false,
  }));
  if (patches.length === 0) return { status: "preview", reason: "no_patches", conflicts: [], preview };
  // 版本：只在当前版本上改（已被新版本取代 → 预览，由律师在新版本上重做）
  const newer = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM document_versions WHERE supersedes = ?`, [doc.document_version_id])!;
  if (newer.n > 0) return { status: "preview", reason: "document_version_superseded", conflicts: [], preview };
  if (!doc.filename.toLowerCase().endsWith(".docx")) return { status: "preview", reason: "not_docx", conflicts: [], preview };
  const buf = blobs.read(doc.storage_uri);
  if (sha256Hex(buf) !== doc.sha256) {
    throw new DomainError("hash_mismatch", "原件内容已变化（读取时复算 hash 不符）：原件只读不覆盖——请重新导入生成新文档版本", 412);
  }

  if (input.run_id) {
    const r = db.get<{ matter_id: string }>(`SELECT matter_id FROM runs WHERE run_id = ?`, [input.run_id]);
    if (!r || r.matter_id !== input.matter_id) throw new DomainError("validation", "run_id 不属于本事项", 422);
  }
  // Agent 所见的令牌化视图：同一事项令牌化器作用于原件全文（不写回新条目：视图只用于核对）
  const viewText = tokens.tokenizer(input.matter_id).tokenize(extractParagraphs(buf).map((x) => x.text).join("\n")).text;
  const conflicts: PatchConflict[] = [];
  const ops: RevisionOp[] = [];
  let tokensRestored = 0;
  patches.forEach((p, index) => {
    const anchor = String(p?.anchor ?? "");
    const proposed = String(p?.proposed_text ?? "");
    const comment = typeof p?.comment === "string" ? p.comment : undefined;
    if (anchor.length === 0) return void conflicts.push({ index, reason: "anchor_empty" });
    if (sha256Hex(anchor) !== String(p?.expected_text_hash ?? "")) return void conflicts.push({ index, reason: "anchor_hash_mismatch" });
    if (!viewText.includes(anchor)) return void conflicts.push({ index, reason: "anchor_not_in_view", detail: "锚点不在当前版本的令牌化视图中（文档已变化或锚点不是 Agent 看到的原文）" });
    // 代号必须都在本事项令牌表里（不认识的代号不猜）
    const unknown = [...findTokens(anchor), ...findTokens(proposed), ...(comment ? findTokens(comment) : [])].filter((t) => !restoreMap.has(t));
    if (unknown.length > 0) return void conflicts.push({ index, reason: "unknown_token", detail: [...new Set(unknown)].join("、") });
    const a = restore(anchor);
    const n = restore(proposed);
    const c = comment ? restore(comment) : null;
    tokensRestored += a.restored + n.restored + (c?.restored ?? 0);
    ops.push({
      opId: `p${index}`,
      anchor: {
        originalText: a.text,
        ...(Number.isInteger(p.occurrence) && (p.occurrence as number) >= 0 ? { occurrence: p.occurrence } : {}),
        ...(typeof p.paragraph_hint === "string" && p.paragraph_hint ? { paragraphHint: restore(p.paragraph_hint).text } : {}),
      },
      originalHash: sha256Hex(a.text),
      newText: n.text,
      ...(p.insert_after === true ? { insertAfter: true } : {}),
      ...(c ? { comment: c.text } : {}),
      author: input.author ?? AUTHOR,
    });
  });
  // 逐条在原件上试定位（任一条不成立即整体预览）；定位口径与文书引擎一致：出现序号按段落内计，多段命中须有条款提示
  const paragraphs = extractParagraphs(buf).map((x) => x.text);
  const nth = (text: string, needle: string, occ: number): number => {
    let at = -1;
    for (let k = 0; k <= occ; k++) {
      at = text.indexOf(needle, at + 1);
      if (at < 0) return -1;
    }
    return at;
  };
  const spans: PatchSpan[] = [];
  for (const op of ops) {
    const index = Number(op.opId.slice(1));
    try {
      applyRevisionsToDocx(buf, { baselineHash: doc.sha256, ops: [op] });
    } catch (e) {
      const msg = (e as Error).message;
      conflicts.push({ index, reason: /歧义/.test(msg) ? "anchor_ambiguous" : /未找到|非文本区/.test(msg) ? "anchor_not_found" : "apply_failed", detail: msg.slice(0, 200) });
      continue;
    }
    // 记录定位，检查补丁之间是否重叠（重叠的两处修改无法同时写成原生修订）
    const occ = op.anchor.occurrence ?? 0;
    const cands = paragraphs.map((t, i) => ({ i, at: nth(t, op.anchor.originalText, occ) })).filter((c) => c.at >= 0);
    const hint = op.anchor.paragraphHint;
    const target = cands.length === 1 ? cands[0] : hint ? (cands.find((c) => paragraphs[c.i]!.includes(hint)) ?? cands[0]) : cands[0];
    if (target) spans.push({ index, para: target.i, start: target.at, end: target.at + op.anchor.originalText.length, old: op.anchor.originalText, new: op.newText, ...(op.insertAfter ? { insert: true as const } : {}) });
  }
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const a = spans[i]!;
      const b = spans[j]!;
      // 段后插入不改锚点所在段落、合并写入时先于替换（见下）：插入与其他补丁不算重叠；同一段之后的多条插入按先后接在一起（复核 Q2-04/Q2-06）
      if (a.insert || b.insert) continue;
      if (a.para === b.para && a.start < b.end && b.start < a.end) conflicts.push({ index: b.index, reason: "overlap", detail: `与第 ${a.index + 1} 条补丁的锚点重叠` });
    }
  }
  const bad = new Set(conflicts.map((c) => c.index));
  for (const item of preview) item.ok = !bad.has(item.index);
  if (input.dryRun) {
    // 逐条成立时再合并试写一遍（与真正生成时同一步）：合并失败即整体不成立
    if (conflicts.length === 0) {
      try {
        applyRevisionsToDocx(buf, { baselineHash: doc.sha256, ops: insertsFirst(ops) });
      } catch (e) {
        for (const item of preview) item.ok = false;
        conflicts.push({ index: 0, reason: "apply_failed", detail: (e as Error).message.slice(0, 200) });
      }
    }
    return { status: "preview", reason: conflicts.length > 0 ? "conflicts" : "dry_run", conflicts: conflicts.sort((x, y) => x.index - y.index), preview, paragraphs, spans: spans.filter((x) => !bad.has(x.index)) };
  }
  if (conflicts.length > 0) return { status: "preview", reason: "conflicts", conflicts: conflicts.sort((x, y) => x.index - y.index), preview };

  let out: Buffer;
  try {
    out = applyRevisionsToDocx(buf, { baselineHash: doc.sha256, ops: insertsFirst(ops) }).docx;
  } catch (e) {
    // 逐条成立而合并失败（例如前一条的修订改变了后一条的定位）：整体预览
    for (const item of preview) item.ok = false;
    return { status: "preview", reason: "conflicts", conflicts: [{ index: 0, reason: "apply_failed", detail: (e as Error).message.slice(0, 200) }], preview };
  }
  // 还原校验：交付件里不得残留代号（零错名：代号只按令牌表还原，不认识的代号在上面已拒绝）
  const residual = extractParagraphs(out).some((p) => findTokens(p.text).length > 0);
  if (residual) throw new DomainError("internal", "修订稿中残留事项代号（还原未完成），已停止", 500);
  const stored = blobs.put(out, doc.matter_id);
  const artifactId = newId("artifactVersion");
  const kind = "revision_draft";
  const v = db.get<{ next: number }>(`SELECT COALESCE(MAX(version), 0) + 1 AS next FROM artifact_versions WHERE matter_id = ? AND kind = ? AND audience = 'internal'`, [doc.matter_id, kind])!;
  const filename = doc.filename.replace(/\.docx$/i, `${input.filename_suffix ?? "（修订建议）"}.docx`);
  const manifest = {
    source_document_version_id: doc.document_version_id,
    source_sha256: doc.sha256,
    patches: ops.length,
    tokens_restored: tokensRestored,
    author: input.author ?? AUTHOR,
    note: "结构化补丁：锚点与新文本经事项令牌表还原后在原件副本上生成原生修订；原件不变",
  };
  db.run(
    `INSERT INTO artifact_versions
      (artifact_version_id, tenant_id, matter_id, run_id, kind, version, baseline_id, audience, status, filename, sha256, storage_uri, open_items, manifest, created_by, lineage)
     VALUES (?,?,?,?,?,?,NULL,'internal','draft',?,?,?,?,?,?,?)`,
    [artifactId, doc.tenant_id, doc.matter_id, input.run_id ?? null, kind, v.next, filename, stored.sha256, stored.storage_uri, "[]", JSON.stringify(manifest), input.created_by, docLineage(doc.document_version_id)],
  );
  return { status: "applied", artifact_version_id: artifactId, filename, sha256: stored.sha256, applied: ops.length, tokens_restored: tokensRestored, preview };
}
