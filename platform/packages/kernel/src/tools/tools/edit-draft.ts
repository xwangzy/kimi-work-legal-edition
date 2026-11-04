/**
 * docx.edit_draft（第 35 批）：在本任务已生成的 Word 文书草稿上逐处修改，交出同名文书的新版本。
 *
 * 真实走查 N1（股权转让协议，K3.1-Pro）：助手自查发现“著作权登记在转让方一 personal名下”与一处“迟延”措辞，
 * 为改这两个词把约 1 万字的协议用 docx.render_report 整份重出（一次 2～6 分钟）；想改又只能找 docx.revise（只认律师上传的原件，调用失败），
 * 前后整份重出 5 次，25 分钟工作时限用完，任务记“已超时”，后两版还被压缩掉了定义条款。
 *
 * - 只改本任务里 docx.render_report 生成的文书（agent_report，.docx）；律师上传的原件仍用 docx.revise（出修订稿）；
 * - 文书草稿按代号形态存放（导出时还原真名）：锚点与新文字照抄草稿文字即可定位，新文字里的代号须在本事项令牌表里；
 * - 修改直接写入（接受全部修改、无修订痕迹），登记为同名文书的新版本（同一任务里同名成果串成“第 n 版”），旧版本保留；
 * - 任一处找不到或有歧义：整体不写，逐条返回原因；改后对新版本重做交付前检查。
 */
import { DomainError, sha256Hex } from "@zr-legal/domain";
import { applyRevisionsToDocx, keepHouseMark, readZipText, sanitizeDocx, type RevisionOp } from "@zr-legal/docx-engine";
import { findTokens } from "@zr-legal/tokenizer";
import type { InvokeCtx } from "../registry.ts";
import { registerToolArtifact } from "./review.ts";
import type { DeliverableSection } from "../../services/deliverable-check.ts";

export const EDIT_DRAFT_MAX_PATCHES = 100;

interface EditPatchInput {
  anchor?: unknown;
  proposed_text?: unknown;
  occurrence?: unknown;
  paragraph_hint?: unknown;
  insert_after?: unknown;
}

type Reason = "anchor_empty" | "anchor_not_found" | "anchor_ambiguous" | "unknown_token" | "overlap" | "apply_failed";

const FIX: Record<Reason, string> = {
  anchor_empty: "anchor 不能为空；新增段落用 insert_after，锚点写插入位置前一段里的原文",
  anchor_not_found: "草稿里找不到这段文字：逐字照抄这份文书里的原文（同一段落之内，含标点与代号）",
  anchor_ambiguous: "这段文字在多个段落或表格格子出现：加 paragraph_hint——正文写所在条款号或该段里另一段独有的文字，表格里的格子写“行名｜列名”（如“付款安排｜严重度”，行名取该行第一格的文字），几张表的行名列名相同时前面再加表格前一段的条款号或标题（如“2.1｜合计｜金额（元）”）；或把锚点写长到唯一",
  unknown_token: "含有本事项不存在的代号：代号只能照抄材料或草稿里出现过的",
  overlap: "与另一条修改的原文重叠：合并成一条",
  apply_failed: "写入失败：通常是两条修改落在同一处，拆开或合并后重试",
};

function classify(msg: string): Reason {
  if (/歧义/.test(msg)) return "anchor_ambiguous";
  if (/未找到|非文本区/.test(msg)) return "anchor_not_found";
  if (/同一处/.test(msg)) return "overlap";
  return "apply_failed";
}

const textOfParagraph = (inner: string): string =>
  [...inner.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((t) => t[1]).join("").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/**
 * 按文书引擎的样式还原“节”（一级、二级标题起节），供改后重做交付前检查（条款编号与互引按节标题判断）。
 * 表格整张收进本节的 table（首行作表头，与 docx.render_report 的输入同形），表后的文字另起无标题节（仍属上一条）：
 * 格子里的“56.25”“33.75”等数字不再当款号查（V10 真实走查 V7：股权表的持股比例报了 30 条“款号不连续”）。
 */
export function sectionsOfDocx(docx: Buffer): { title: string; sections: DeliverableSection[] } {
  const xml = readZipText(docx, "word/document.xml") ?? "";
  let title = "";
  const sections: DeliverableSection[] = [];
  let cur: DeliverableSection = { heading: "", paragraphs: [] };
  for (const m of xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b[^>]*>([\s\S]*?)<\/w:p>|<w:p\b[^>]*\/>/g)) {
    if (m[0].startsWith("<w:tbl>")) {
      const rows = [...m[0].matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((r) =>
        [...r[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((c) => [...c[0].matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)].map((p) => textOfParagraph(p[1] ?? "")).join("\n")),
      );
      if (cur.table) {
        sections.push(cur);
        cur = { heading: "", paragraphs: [] };
      }
      cur.table = { columns: rows[0] ?? [], rows: rows.slice(1) };
      continue;
    }
    const inner = m[1] ?? "";
    const style = /<w:pStyle w:val="([^"]+)"/.exec(inner)?.[1] ?? "";
    const text = textOfParagraph(inner);
    if (style === "KwlTitle") {
      title ||= text;
      continue;
    }
    if (style === "KwlHeading1" || style === "KwlHeading2") {
      sections.push(cur);
      cur = { heading: text, paragraphs: [] };
      continue;
    }
    if (!text.trim()) continue;
    if (cur.table) {
      sections.push(cur);
      cur = { heading: "", paragraphs: [] };
    }
    cur.paragraphs!.push(text);
  }
  sections.push(cur);
  return { title, sections: sections.filter((s, i) => i > 0 || (s.paragraphs?.length ?? 0) > 0 || !!s.table) };
}

/**
 * 同一份文书（同一 lineage，与界面“第 n 版 / 最新版”同一口径）里比这一版更新的版本；没有更新的返回 null。
 * 早期没有 lineage 的成果按本任务里的同名文书判断。
 */
function newerVersionOf(
  ctx: InvokeCtx,
  mid: string,
  id: string,
  art: { kind: string; filename: string; run_id: string | null; audience: string; version: number; lineage: string | null },
) {
  const latest = art.lineage
    ? ctx.db.get<{ artifact_version_id: string; run_id: string | null; version: number }>(
        `SELECT artifact_version_id, run_id, version FROM artifact_versions WHERE matter_id = ? AND kind = ? AND audience = ? AND lineage = ? ORDER BY version DESC LIMIT 1`,
        [mid, art.kind, art.audience, art.lineage],
      )
    : ctx.db.get<{ artifact_version_id: string; run_id: string | null; version: number }>(
        `SELECT artifact_version_id, run_id, version FROM artifact_versions WHERE matter_id = ? AND kind = ? AND audience = ? AND run_id IS ? AND filename = ? ORDER BY version DESC LIMIT 1`,
        [mid, art.kind, art.audience, art.run_id, art.filename],
      );
  if (!latest || latest.artifact_version_id === id || latest.version <= art.version) return null;
  const name = art.filename.replace(/\.docx$/i, "");
  const own = latest.run_id === art.run_id;
  return {
    status: "not_applied" as const,
    written: false,
    reason: "stale_version" as const,
    latest_artifact_version_id: latest.artifact_version_id,
    conflicts: [],
    note: own
      ? `《${name}》已有更新的版本（${latest.artifact_version_id}），你给的 ${id} 是旧版本：在旧版本上改会丢掉之后的修改，整体没有写入。改用 artifact_version_id=${latest.artifact_version_id}，锚点照抄最新版本里的文字，把这次的修改重新提交一次（之前几轮已改好的不用再交）`
      : `《${name}》已有更新的版本（${latest.artifact_version_id}，不是本任务生成的），你给的 ${id} 是旧版本，整体没有写入：不要在旧版本上改；在最终答复里告诉律师最新版本已在别的任务里更新，需要时请律师在最新版本上提出修改`,
  };
}

export function docxEditDraft(ctx: InvokeCtx, p: { artifact_version_id?: unknown; patches?: unknown; dry_run?: unknown }) {
  const mid = ctx.claims.mid;
  if (!mid) throw new DomainError("forbidden", "令牌未绑定事项", 403);
  const rid = typeof ctx.claims.rid === "string" ? ctx.claims.rid : null;
  if (!rid) throw new DomainError("forbidden", "只有任务内的调用可以修改文书草稿", 403);
  const id = String(p.artifact_version_id ?? "");
  const art = ctx.db.get<{ kind: string; filename: string; storage_uri: string; sha256: string; run_id: string | null; audience: string; version: number; lineage: string | null }>(
    `SELECT kind, filename, storage_uri, sha256, run_id, audience, version, lineage FROM artifact_versions WHERE artifact_version_id = ? AND matter_id = ?`,
    [id, mid],
  );
  if (!art) throw new DomainError("not_found", "找不到这份文书：artifact_version_id 用 docx.render_report 返回的那个", 404);
  if (art.run_id !== rid) throw new DomainError("validation", "只能修改本任务里生成的文书草稿；律师上传的材料用 docx.revise 出修订稿", 422);
  if (art.kind !== "agent_report" || !art.filename.toLowerCase().endsWith(".docx")) {
    throw new DomainError("validation", "只能修改 docx.render_report 生成的 Word 文书；修订稿、清洁稿要改的，在原件上重新用 docx.revise 提交全部修改", 422);
  }
  // V12（第 36 批待拍板“基于旧版本修改会丢更新”）：只在这份文书的最新版本上改（乐观并发）。
  // 此前拿旧编号也照常写入：新版本由旧版本改出、却登记成最新版，上一轮已改好的内容悄悄没了（律师看到的最新文书少了修改）。
  // 不是最新的整体不写（试写也拦），交回最新版本的编号，由助手在最新版本上重新定位锚点后提交
  const stale = newerVersionOf(ctx, mid, id, art);
  if (stale) return stale;
  const raw = Array.isArray(p.patches) ? (p.patches as EditPatchInput[]) : [];
  if (raw.length === 0) throw new DomainError("validation", "patches 至少一条", 422);
  if (raw.length > EDIT_DRAFT_MAX_PATCHES) throw new DomainError("validation", `一次最多 ${EDIT_DRAFT_MAX_PATCHES} 处修改；改动更多时说明这份文书要重写，用 docx.render_report 重新生成`, 422);
  const buf = ctx.blobs.read(art.storage_uri);
  if (sha256Hex(buf) !== art.sha256) throw new DomainError("hash_mismatch", "文书草稿内容已变化（读取时复算 hash 不符），已停止", 412);
  const known = new Set((ctx.tokens?.table(mid) ?? []).map((e) => e.token));

  const conflicts: { index: number; reason: Reason; fix: string; detail?: string }[] = [];
  const ops: RevisionOp[] = [];
  raw.forEach((x, index) => {
    const anchor = String(x?.anchor ?? "");
    const proposed = String(x?.proposed_text ?? "");
    if (!anchor) return void conflicts.push({ index, reason: "anchor_empty", fix: FIX.anchor_empty });
    // 新文字里的代号须是本事项的（导出时按令牌表还原；不认识的代号会原样留在文书里）
    const unknown = findTokens(proposed).filter((t) => !known.has(t) && !anchor.includes(t));
    if (unknown.length > 0) return void conflicts.push({ index, reason: "unknown_token", fix: FIX.unknown_token, detail: [...new Set(unknown)].join("、") });
    const op: RevisionOp = {
      opId: `e${index}`,
      anchor: {
        originalText: anchor,
        ...(Number.isInteger(x?.occurrence) && (x.occurrence as number) >= 0 ? { occurrence: x.occurrence as number } : {}),
        ...(typeof x?.paragraph_hint === "string" && x.paragraph_hint ? { paragraphHint: x.paragraph_hint } : {}),
      },
      originalHash: sha256Hex(anchor),
      newText: proposed,
      ...(x?.insert_after === true ? { insertAfter: true } : {}),
      author: "AI 起草",
    };
    try {
      applyRevisionsToDocx(buf, { baselineHash: art.sha256, ops: [op] });
      ops.push(op);
    } catch (e) {
      const msg = (e as Error).message;
      const reason = classify(msg);
      conflicts.push({ index, reason, fix: FIX[reason], detail: msg.slice(0, 200) });
    }
  });
  if (conflicts.length > 0) {
    return { status: "not_applied" as const, written: false, conflicts, note: "整体没有写入任何修改：按逐条原因改正后，把全部修改重新提交一次" };
  }
  let out: Buffer;
  try {
    // 段后插入先写（与 docx.revise 同一顺序），再接受全部修改：草稿是助手自己的文字，不留修订痕迹
    const ordered = [...ops.filter((o) => o.insertAfter), ...ops.filter((o) => !o.insertAfter)];
    // 本产品生成的草稿保留版式标记（下载与导出照旧套函头），见 keepHouseMark
    out = keepHouseMark(buf, sanitizeDocx(applyRevisionsToDocx(buf, { baselineHash: art.sha256, ops: ordered }).docx).docx);
  } catch (e) {
    return { status: "not_applied" as const, written: false, conflicts: [{ index: 0, reason: "apply_failed" as const, fix: FIX.apply_failed, detail: (e as Error).message.slice(0, 200) }], note: "逐条都能定位，合并写入失败：通常是两条修改落在同一处，合并后重新提交" };
  }
  if (p.dry_run === true) {
    return { status: "preview" as const, written: false, applied: ops.length, note: "试写通过，没有生成文件；去掉 dry_run 正式提交" };
  }
  const stored = ctx.blobs.put(out, mid);
  const reg = registerToolArtifact(ctx, {
    kind: "agent_report",
    filename: art.filename,
    sha256: stored.sha256,
    storage_uri: stored.storage_uri,
    manifest: { tool: "docx.edit_draft", edited_from: id, patches: ops.length, note: "在本任务的文书草稿上逐处修改后的新版本（旧版本保留）" },
  });
  return {
    status: "applied" as const,
    applied: ops.length,
    ...reg,
    edited_from: id,
    note: `已在《${art.filename.replace(/\.docx$/i, "")}》上改好 ${ops.length} 处，登记为同名文书的新版本（旧版本保留）。后续再改，用这次返回的 artifact_version_id`,
  };
}
