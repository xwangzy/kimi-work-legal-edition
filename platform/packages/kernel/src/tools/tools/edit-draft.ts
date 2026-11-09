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
import { applyRevisionsToDocx, extractParagraphs, keepHouseMark, readZipText, sanitizeDocx, type RevisionOp } from "@zr-legal/docx-engine";
import { findTokens } from "@zr-legal/tokenizer";
import type { InvokeCtx } from "../registry.ts";
import { registerToolArtifact } from "./review.ts";
import type { DeliverableSection } from "../../services/deliverable-check.ts";
import { slog } from "@zr-legal/safe-log";

/** 结果分布留痕（V13 第 38 批）：只记计数，不记文字。 */
function logOutcome(status: "applied" | "partial" | "not_applied" | "preview", patches: number, applied: number, conflicts: readonly { reason: Reason }[]): void {
  const n = (r: Reason) => conflicts.filter((c) => c.reason === r).length;
  slog.event("TOOLS_DOCX_EDIT_OUTCOME", { tool: "docx_edit_draft", status, patches, applied, not_found: n("anchor_not_found") + n("anchor_empty"), ambiguous: n("anchor_ambiguous"), unknown_token: n("unknown_token"), other: n("overlap") + n("apply_failed") });
}

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
 * 改出来的重复句（V14 第 39 批；基线走查 A 独立评分：复核后修改轮把第 10.3 条改完，同一项通知义务写了两遍；V13 W4 修改轮同样在 v5 多出一整句）：
 * 修改后文书里出现次数比修改前多、且出现两次以上的句子（12 字以上，按句号、分号断句，去空白比较）。纯函数。
 */
export function newlyRepeatedSentences(before: readonly string[], after: readonly string[], max = 5): string[] {
  const count = (paras: readonly string[]) => {
    const m = new Map<string, number>();
    for (const p of paras) for (const raw of p.split(/[。；;]/)) {
      // 句首的条款号（“10.3”“第十条”“（一）”）不算在内：同一句被重复写进另一款时编号不同
      const k = raw.replace(/\s+/g, "").replace(/^(?:第[一二三四五六七八九十百零〇两\d]+[条款项]|\d+(?:\.\d+)*\.?|[（(][一二三四五六七八九十\d]+[)）])/, "");
      if ([...k].length >= 12) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const b = count(before);
  const out: string[] = [];
  for (const [k, n] of count(after)) if (n >= 2 && n > (b.get(k) ?? 0) && out.length < max) out.push(k);
  return out;
}

export function docxEditDraft(ctx: InvokeCtx, p: { artifact_version_id?: unknown; patches?: unknown; dry_run?: unknown }) {
  const mid = ctx.claims.mid;
  if (!mid) throw new DomainError("forbidden", "令牌未绑定事项", 403);
  const rid = typeof ctx.claims.rid === "string" ? ctx.claims.rid : null;
  if (!rid) throw new DomainError("forbidden", "只有任务内的调用可以修改文书草稿", 403);
  const id = String(p.artifact_version_id ?? "");
  const art = ctx.db.get<{ kind: string; filename: string; storage_uri: string; sha256: string; run_id: string | null }>(
    `SELECT kind, filename, storage_uri, sha256, run_id FROM artifact_versions WHERE artifact_version_id = ? AND matter_id = ?`,
    [id, mid],
  );
  if (!art) throw new DomainError("not_found", "找不到这份文书：artifact_version_id 用 docx.render_report 返回的那个", 404);
  if (art.run_id !== rid) throw new DomainError("validation", "只能修改本任务里生成的文书草稿；律师上传的材料用 docx.revise 出修订稿", 422);
  if (art.kind !== "agent_report" || !art.filename.toLowerCase().endsWith(".docx")) {
    throw new DomainError("validation", "只能修改 docx.render_report 生成的 Word 文书；修订稿、清洁稿要改的，在原件上重新用 docx.revise 提交全部修改", 422);
  }
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
  // 能定位的先写入、定位不到的逐条退回（V13 第 38 批取证：4 次正式调用里 2 次因 2 处中 1 处找不到而整体未写，另一处本可写入）。
  // 草稿是在最新版本上逐处增量修改，部分写入不丢已写的修改；一处都定位不到时照旧不写
  if (ops.length === 0) {
    logOutcome("not_applied", raw.length, 0, conflicts);
    return { status: "not_applied" as const, written: false, conflicts, note: "没有写入任何修改：按逐条原因改正后重新提交" };
  }
  let out: Buffer;
  try {
    // 段后插入先写（与 docx.revise 同一顺序），再接受全部修改：草稿是助手自己的文字，不留修订痕迹
    const ordered = [...ops.filter((o) => o.insertAfter), ...ops.filter((o) => !o.insertAfter)];
    // 本产品生成的草稿保留版式标记（下载与导出照旧套函头），见 keepHouseMark
    out = keepHouseMark(buf, sanitizeDocx(applyRevisionsToDocx(buf, { baselineHash: art.sha256, ops: ordered }).docx).docx);
  } catch (e) {
    logOutcome("not_applied", raw.length, 0, [{ reason: "apply_failed" }]);
    return { status: "not_applied" as const, written: false, conflicts: [{ index: 0, reason: "apply_failed" as const, fix: FIX.apply_failed, detail: (e as Error).message.slice(0, 200) }], note: "逐条都能定位，合并写入失败：通常是两条修改落在同一处，合并后重新提交" };
  }
  if (p.dry_run === true) {
    logOutcome("preview", raw.length, ops.length, []);
    return { status: "preview" as const, written: false, applied: ops.length, note: "试写通过，没有生成文件；去掉 dry_run 正式提交" };
  }
  let repeated: string[] = [];
  try {
    repeated = newlyRepeatedSentences(extractParagraphs(buf).map((x) => x.text), extractParagraphs(out).map((x) => x.text));
  } catch {
    repeated = [];
  }
  const stored = ctx.blobs.put(out, mid);
  logOutcome(conflicts.length > 0 ? "partial" : "applied", raw.length, ops.length, conflicts);
  const reg = registerToolArtifact(ctx, {
    kind: "agent_report",
    filename: art.filename,
    sha256: stored.sha256,
    storage_uri: stored.storage_uri,
    manifest: { tool: "docx.edit_draft", edited_from: id, patches: ops.length, note: "在本任务的文书草稿上逐处修改后的新版本（旧版本保留）" },
  });
  const name = art.filename.replace(/\.docx$/i, "");
  return {
    status: conflicts.length > 0 ? ("partial" as const) : ("applied" as const),
    applied: ops.length,
    ...(conflicts.length > 0 ? { conflicts } : {}),
    ...reg,
    edited_from: id,
    ...(repeated.length > 0
      ? { repeated_sentences: repeated, repeated_note: "这次修改后，上面这些句子在文书里出现了两次以上（修改前没有这么多）：多半是新文字和原有的句子重复了。逐处核对，重复的用 docx.edit_draft 删掉一处（用这次返回的 artifact_version_id）" }
      : {}),
    note:
      conflicts.length > 0
        ? `已在《${name}》上改好 ${ops.length} 处，登记为新版本；另有 ${conflicts.length} 处没有写入（见 conflicts 的序号与原因）：按原因改正后，用这次返回的 artifact_version_id 只重交这几处，已写入的不要重复提交`
        : `已在《${name}》上改好 ${ops.length} 处，登记为同名文书的新版本（旧版本保留）。后续再改，用这次返回的 artifact_version_id`,
  };
}
