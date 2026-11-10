/**
 * docx.revise（第 28 批）：Agent 在律师上传的 Word 原件副本上写修订，交出《修订稿》与《清洁稿》。
 *
 * 此前 Agent 只能读材料纯文本，“按我的意见改这份合同”只能重新生成一份新文档（原版式、编号、表格全丢，也没有修订痕迹），
 * 或者把修改意见写在答复里；docx.apply_revisions 要求原件 hash 且不登记成果，对 Agent 不可见。
 *
 * - 修订稿：复用结构化补丁（services/structured-patch.ts）——锚点必须出现在 Agent 看到的令牌化视图里、代号按事项令牌表还原、
 *   全部锚点唯一定位才写、原件只读不覆盖，登记为 revision_draft（与审查工作台生成的修订稿同一种成果）；
 * - 清洁稿：修订稿接受全部修订（docx-engine sanitizeDocx，与 S1 清洁稿同一函数），登记为 revision_clean；
 * - 锚点完整性 hash 由本工具按 Agent 给出的锚点计算（Agent 拿不到原件字节）：绑定关系靠“锚点在令牌化视图里”这一条；
 * - 任一条不成立：整体不写，逐条返回原因与改法（不返回还原后的原文，结果仍经本机端点令牌化）。
 */
import { slog } from "@zr-legal/safe-log";
import { DomainError, sha256Hex } from "@zr-legal/domain";
import { createDocx, existingRevisions, externalRedline, headerFooterParagraphs, minimalChange, readZipEntries, sanitizeDocx } from "@zr-legal/docx-engine";
import { AI_REVISION_AUTHOR } from "../../services/structured-patch.ts";
import { redlineAuthorOf } from "../../services/doc-style.ts";
import { LAWYER_APPROVED_AUTHOR } from "../../services/review-cards.ts";
import { applyStructuredPatches, headerFooterHint, type ChangeRow, type NumberingShifts, type PatchConflict, type StructuredPatch } from "../../services/structured-patch.ts";
import type { InvokeCtx } from "../registry.ts";
import { registerToolArtifact } from "./review.ts";

export const REVISE_MAX_PATCHES = 200;

/** 逐条失败原因的改法（写给模型；律师界面不显示）。 */
const FIX_HINT: Record<PatchConflict["reason"], string> = {
  anchor_not_found: "原件里找不到这段原文：逐字照抄材料原文（同一段落之内，含标点、空格与代号；段首的条款编号可以不抄）",
  anchor_ambiguous: "这段原文在多个段落出现：加 paragraph_hint 写条款号；表格里的格子写“行名｜列名”（如“第 2 期｜应还本金”，同一行里金额相同的两格靠列名区分）；几张表的行名列名相同时，前面再加表格前一段的条款号（如“2.1｜合计｜金额（元）”与“3.1｜合计｜金额（元）”），或把锚点写长到唯一；occurrence 只区分同一段落里的第几次出现",
  anchor_not_in_view: "这段原文不在本材料的文字里：不是照抄的原文，或跨了段落（一条修改只能在一个段落之内）；改页眉页脚的，paragraph_hint 写“页眉”或“页脚”，anchor 照抄 header_footer_text 里的原文",
  overlap: "与另一条修改的原文重叠：合并成一条",
  complex_structure: "要改的字跨过了对方的修订痕迹、Word 域、脚注、超链接或内容控件的边界，自动改写会丢内容或打乱修订记录：按 detail 在边界处拆成两条修改（每条只改一侧的纯文字，锚点可以带上两边没变的字）；做不到的（如要改对方删除的字、域结果）不要重试，在最终答复里列明这一处请律师在 Word 里手工修改",
  unknown_token: "含有本事项不存在的代号：代号只能照抄材料里出现过的",
  anchor_empty: "anchor 不能为空；新增条款用 insert_after，锚点写插入位置前一段里的原文",
  anchor_hash_mismatch: "内部校验失败，请重新提交",
  new_clause_in_edit: "新增条款不要接在原段落里换行写（会成为同一段里的软回车：不受自动编号管理，对方也没法单独接受或拒绝）：本条只写对原段的修改；新增条款另提一条 insert_after，锚点写它前一段里的原文，新文字不写编号（自动续号）",
  bad_placement: "这条修改落位的写法不对，按 detail 改：新款要插在某款及其表格之后的用 insert_after_table（锚点写表格前紧挨着的那一段、或表格里任一格的原文）；表格加一行用 insert_row_after（锚点写要接在其后的那一行里任一格的原文，新文字各格用“｜”分隔，纵向合并的格子留空）；删整行用 delete_row（新文字为空串）",
  apply_failed: "写入失败：通常是两条修改落在同一处，拆开或合并后重试",
};

interface RevisePatchInput {
  anchor?: unknown;
  proposed_text?: unknown;
  occurrence?: unknown;
  paragraph_hint?: unknown;
  comment?: unknown;
  insert_after?: unknown;
  insert_after_table?: unknown;
  insert_row_after?: unknown;
  delete_row?: unknown;
}

/**
 * 试写（dry_run）：只定位、不生成文件，返回每个改到的段落“改前 / 改后”的整段文字——Agent 写入前读一遍改后的句子
 * （第 28 批真实走查：锚点漏了“本”字，清洁稿成了“甲方应于本验收合格后三十日内”）。同一段多处修改合并成一段改后文字。
 */
function previewChanges(paragraphs: readonly string[], spans: readonly { para: number; start: number; end: number; new: string; insert?: true; placement?: "after_table" | "row_inserted" | "row_deleted" }[]) {
  const byPara = new Map<number, typeof spans[number][]>();
  for (const sp of spans) byPara.set(sp.para, [...(byPara.get(sp.para) ?? []), sp]);
  return [...byPara.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([para, list]) => {
      const before = paragraphs[para] ?? "";
      let after = before;
      for (const sp of list.filter((x) => !x.insert).sort((a, b) => b.start - a.start)) after = after.slice(0, sp.start) + sp.new + after.slice(sp.end);
      const inserted = list.filter((x) => x.insert && !x.placement).map((x) => x.new);
      // 表格上的修改（V16 第 41 批）：写清落在哪里，助手试写时能看出新款是在整张表之后、新行是在哪一行之后
      const afterTable = list.filter((x) => x.placement === "after_table").map((x) => x.new);
      const newRows = list.filter((x) => x.placement === "row_inserted").map((x) => x.new.replace(/\t/g, "｜"));
      const rowDeleted = list.some((x) => x.placement === "row_deleted");
      return {
        paragraph: para,
        before,
        after,
        ...(inserted.length > 0 ? { inserted_after: inserted } : {}),
        ...(afterTable.length > 0 ? { inserted_after_table: afterTable, inserted_after_table_note: "新段落在这段所在（或紧随其后）的整张表格之后，格式与自动编号沿用表格前那一段" } : {}),
        ...(newRows.length > 0 ? { row_inserted_after: newRows, row_inserted_note: "在这一格所在的行之后新增一行（整行标为插入修订）" } : {}),
        ...(rowDeleted ? { row_deleted: true, row_deleted_note: "这一格所在的整行标为删除" } : {}),
      };
    });
}

/**
 * 页眉页脚（第 35 批真实走查 R5：律师要求“首部、鉴于条款、页眉和签署页”的乙方名称统一改正）：材料文字只覆盖正文，
 * 页眉页脚里的同一处错名原先不会被改到，也不提示，助手会回报“已全部改完”。这里按每条正文修改实际删掉的字（前后各带 4 个字的上下文）
 * 在原件页眉页脚里查一遍，查到、且没有同一处的页眉页脚修改（paragraph_hint 写“页眉 / 页脚”，V10 第 36 批起可以改）的，列给助手补一条修改。
 */
function headerFooterLeftovers(docx: Buffer, patches: readonly { anchor: string; proposed: string; part: "header" | "footer" | null }[]): { part: string; text: string; patches: number[] }[] {
  let parts: [string, string][];
  try {
    parts = [...readZipEntries(docx).entries()]
      .filter(([n]) => /^word\/(header|footer)\d*\.xml$/.test(n))
      .map(([n, d]) => [n.includes("header") ? "页眉" : "页脚", d.toString("utf8").replace(/<w:tab\/>/g, " ").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")]);
  } catch {
    return [];
  }
  const out = new Map<string, { part: string; text: string; patches: number[] }>();
  // 已有页眉页脚修改覆盖的原文（锚点）：同一处不再列为遗漏
  const covered = (part: string, probe: string) => patches.some((x) => x.part && (x.part === "header" ? "页眉" : "页脚") === part && x.anchor.includes(probe.slice(4, -4) || probe));
  patches.forEach((x, i) => {
    if (x.part) return;
    const { keepHead, removed, keepTail } = minimalChange(x.anchor, x.proposed);
    if (!removed.trim()) return;
    const probe = `${keepHead.slice(-4)}${removed}${keepTail.slice(0, 4)}`;
    if ([...probe].length < 6) return;
    for (const [part, text] of parts) {
      if (!text.includes(probe) || covered(part, probe)) continue;
      const key = `${part}${text}`;
      const hit = out.get(key) ?? { part, text: text.trim().slice(0, 120), patches: [] };
      hit.patches.push(i + 1);
      out.set(key, hit);
    }
  });
  return [...out.values()];
}

/** 自动编号的提示（第 34 批 T3b）：新文字开头抄进去的编号已去掉；删除、插入条款后编号顺延，正文里写死的旧条号要一并改。 */
function numberingNotes(r: { numbering?: NumberingShifts; label_notes?: { index: number; dropped: string[] }[] }, written: boolean) {
  const out: Record<string, unknown> = {};
  if (r.label_notes && r.label_notes.length > 0) {
    out.label_notes = r.label_notes.map((x) => ({ patch: x.index + 1, dropped: x.dropped }));
    out.label_note = "这几条改的是 Word 自动编号的段落：新文字开头抄进去的编号已去掉（编号由 Word 生成，插入、删除条款后自动顺延），不要在文字里另写编号";
  }
  if (r.numbering && r.numbering.renumbered.length > 0) {
    out.numbering_changes = r.numbering;
    out.numbering_note = `删除或插入了自动编号的条款，后面的条款编号已自动顺延（renumbered）；正文里写死的条号不会跟着变${
      r.numbering.references.length > 0 ? `——references 列出 ${r.numbering.references.length} 处互引仍写着旧号，${written ? "把它们改成新号后连同全部修改重新提交一次（生成新版本），做不到的在答复里逐处列给律师" : "把它们改成新号、连同全部修改一并提交"}` : ""
    }。最终答复写明编号已顺延，不要写“后续编号保持不动”`;
  }
  return out;
}

export function docxRevise(ctx: InvokeCtx, p: { document_version_id?: unknown; patches?: unknown; dry_run?: unknown }) {
  const mid = ctx.claims.mid;
  if (!mid) throw new DomainError("forbidden", "令牌未绑定事项", 403);
  const rid = typeof ctx.claims.rid === "string" ? ctx.claims.rid : null;
  if (!rid) throw new DomainError("forbidden", "只有任务内的调用可以生成修订稿", 403);
  if (!ctx.tokens) throw new DomainError("provider_unavailable", "令牌化工作区未启用", 503);
  const run = ctx.db.get<{ created_by: string; matter_id: string }>(`SELECT created_by, matter_id FROM runs WHERE run_id = ?`, [rid]);
  if (!run || run.matter_id !== mid) throw new DomainError("not_found", "任务不存在", 404);
  const raw = Array.isArray(p.patches) ? (p.patches as RevisePatchInput[]) : [];
  if (raw.length === 0) throw new DomainError("validation", "patches 至少一条", 422);
  if (raw.length > REVISE_MAX_PATCHES) throw new DomainError("validation", `一次最多 ${REVISE_MAX_PATCHES} 处修改，请分批提交`, 422);
  const patches: StructuredPatch[] = raw.map((x) => {
    const anchor = String(x?.anchor ?? "");
    return {
      anchor,
      expected_text_hash: sha256Hex(anchor),
      proposed_text: String(x?.proposed_text ?? ""),
      ...(Number.isInteger(x?.occurrence) && (x.occurrence as number) >= 0 ? { occurrence: x.occurrence as number } : {}),
      ...(typeof x?.paragraph_hint === "string" && x.paragraph_hint ? { paragraph_hint: x.paragraph_hint } : {}),
      ...(typeof x?.comment === "string" && x.comment ? { comment: x.comment } : {}),
      ...(x?.insert_after === true ? { insert_after: true } : {}),
      ...(x?.insert_after_table === true ? { insert_after_table: true } : {}),
      ...(x?.insert_row_after === true ? { insert_row_after: true } : {}),
      ...(x?.delete_row === true ? { delete_row: true } : {}),
    };
  });
  const documentVersionId = String(p.document_version_id ?? "");
  const dryRun = p.dry_run === true;
  // 原件里已有的修订（第 34 批）：对方返回的带修订稿上再改时，清洁稿会把对方的修订一并接受——让助手先告诉律师
  const src = ctx.db.get<{ storage_uri: string; filename: string }>(`SELECT storage_uri, filename FROM document_versions WHERE document_version_id = ? AND matter_id = ?`, [documentVersionId, mid]);
  const srcBuf = src && src.filename.toLowerCase().endsWith(".docx") ? ctx.blobs.read(src.storage_uri) : null;
  const prior = srcBuf ? existingRevisions(srcBuf) : null;
  const priorNote = prior && prior.total > 0
    ? { existing_revisions: prior, existing_revisions_note: `原件里已有他人的修订痕迹 ${prior.total} 处（插入 ${prior.insertions}、删除 ${prior.deletions}、移动 ${prior.moves}、格式 ${prior.format_changes}）：修订稿原样保留；清洁稿会把它们与本次修改一并接受。在计划与最终答复里告诉律师这一点；完全落在对方插入的文字之内的可以改（记成我方修订），跨过对方修订边界的不能自动写，列明请律师在 Word 里处理` }
    : {};
  const hf = srcBuf ? headerFooterLeftovers(srcBuf, patches.filter((x) => !x.insert_after && !x.insert_after_table && !x.insert_row_after && !x.delete_row).map((x) => ({ anchor: ctx.tokens!.restore(mid, x.anchor).text, proposed: ctx.tokens!.restore(mid, x.proposed_text).text, part: headerFooterHint(x.paragraph_hint) }))) : [];
  // 原件页眉页脚的文字（令牌化后给助手照抄锚点；V10 第 36 批）
  const hfText = srcBuf ? headerFooterParagraphs(srcBuf).map((x) => ({ part: x.part === "header" ? "页眉" : "页脚", text: ctx.tokens!.tokenizer(mid).tokenize(x.texts.join(" / ")).text.slice(0, 300) })) : [];
  const hfNote = hf.length > 0
    ? { header_footer: hf, header_footer_text: hfText, header_footer_note: "原件的页眉或页脚里也有这次改掉的原文（见 header_footer，patches 是第几条修改）：律师要求一并改的，再加一条修改——paragraph_hint 写“页眉”或“页脚”，anchor 照抄 header_footer_text 里的原文，修订同样以痕迹显示；律师没有要求改页眉页脚的，在最终答复里提醒这一处" }
    : {};
  const r = applyStructuredPatches(
    { db: ctx.db, blobs: ctx.blobs, tokens: ctx.tokens },
    { matter_id: mid, document_version_id: documentVersionId, patches, created_by: run.created_by, run_id: rid, filename_suffix: "（修订稿）", ...(dryRun ? { dryRun: true } : {}) },
  );
  if (r.status === "preview" && r.reason === "dry_run") {
    return {
      status: "preview" as const,
      written: false,
      changes: previewChanges(r.paragraphs ?? [], r.spans ?? []),
      ...(r.header_footer_changes ? { header_footer_changes: r.header_footer_changes.map((c) => ({ part: c.place, before: c.before, after: c.after })) } : {}),
      ...(hfText.length > 0 && !hfNote.header_footer ? { header_footer_text: hfText } : {}),
      ...priorNote,
      ...hfNote,
      ...numberingNotes(r, false),
      note: "这是试写，没有生成文件。逐段读 after（改后的整段）：语句通顺、与前后文衔接（没有多出或漏掉的字，例如替换“合同签订之日起”时留下的“本”）、编号与互引正确后，去掉 dry_run 把全部修改正式提交一次。",
    };
  }
  if (r.status !== "applied") {
    // 结果分布留痕（V13 第 38 批）：只记计数
    const n = (re: RegExp) => r.conflicts.filter((c) => re.test(String(c.reason))).length;
    slog.event("TOOLS_DOCX_EDIT_OUTCOME", { tool: "docx_revise", status: "not_applied", patches: Array.isArray(p.patches) ? p.patches.length : 0, applied: 0, not_found: n(/not_found|empty/), ambiguous: n(/ambiguous/), unknown_token: n(/token/), other: r.conflicts.length - n(/not_found|empty|ambiguous|token/) });
    const note =
      r.reason === "not_docx"
        ? "这份材料不是 Word（.docx）文件，不能在原件上写修订：告诉律师原因，改为用 docx.render_report 出“修改后全文（新排版）”"
        : r.reason === "document_version_superseded"
          ? "这份材料已有更新的版本：用 materials.list 找到最新版本的材料编号后重做"
          : "整体没有写入任何修改：按逐条原因改正后，把全部修改重新提交一次";
    return {
      status: "not_applied" as const,
      reason: r.reason,
      written: false,
      conflicts: r.conflicts.map((c) => ({ index: c.index, reason: c.reason, fix: FIX_HINT[c.reason], ...(c.detail ? { detail: c.detail } : {}) })),
      ...priorNote,
      ...(hfText.length > 0 ? { header_footer_text: hfText } : {}),
      note,
    };
  }
  // 清洁稿：从刚登记的修订稿字节派生（接受全部修订、去掉批注），原件与修订稿都不动
  const rev = ctx.db.get<{ storage_uri: string; manifest: string }>(`SELECT storage_uri, manifest FROM artifact_versions WHERE artifact_version_id = ?`, [r.artifact_version_id]);
  if (!rev) throw new DomainError("internal", "修订稿登记后读取失败", 500);
  const clean = sanitizeDocx(ctx.blobs.read(rev.storage_uri));
  const stored = ctx.blobs.put(clean.docx, mid);
  const cleanName = r.filename.replace(/（修订稿）\.docx$/i, "（清洁稿）.docx");
  const cleanReg = registerToolArtifact(ctx, {
    kind: "revision_clean",
    filename: cleanName,
    sha256: stored.sha256,
    storage_uri: stored.storage_uri,
    manifest: {
      tool: "docx.revise",
      source_document_version_id: documentVersionId,
      derived_from: r.sha256,
      accepted: clean.removed,
      note: "清洁稿：修订稿接受全部修订、去掉批注（含律师尚未逐条确认的修改）；原件不变",
    },
  });
  // 对外版修订稿（V14 第 39 批，基线走查 B 独立评分）：修订痕迹保留、批注去掉、本产品写的修订改署名为设置里的修订署名（没设用本所名称，10-23 拍板）
  const externalReg = (() => {
    try {
      const author = redlineAuthorOf(ctx.db, String(ctx.claims.tid ?? ""), "external", ctx.firmName ?? null) || LAWYER_APPROVED_AUTHOR;
      const ext = externalRedline(ctx.blobs.read(rev.storage_uri), AI_REVISION_AUTHOR, author);
      const put = ctx.blobs.put(ext.docx, mid);
      return registerToolArtifact(ctx, {
        kind: "revision_draft",
        filename: r.filename.replace(/（修订稿）\.docx$/i, "（修订稿·对外版）.docx"),
        sha256: put.sha256,
        storage_uri: put.storage_uri,
        manifest: { tool: "docx.revise", audience: "external", source_document_version_id: documentVersionId, derived_from: r.sha256, author, comments_removed: ext.comments, reauthored: ext.reauthored, note: "对外版修订稿：修订痕迹保留，批注（修改理由）去掉，修订署名为本所设置；原件与内部版修订稿不变" },
      });
    } catch {
      return null;
    }
  })();
  // 修改对照表（第 35 批）：按实际写入的修改逐段列“修改前 / 修改后 / 修改理由”，供律师复核与向客户说明——律师要的“修改对照及修改说明”
  const compareReg = registerComparison(ctx, r, src?.filename ?? r.filename);
  return {
    status: "applied" as const,
    applied: r.applied,
    revision: { artifact_version_id: r.artifact_version_id, filename: r.filename },
    clean: { artifact_version_id: cleanReg.artifact_version_id, filename: cleanReg.filename },
    ...(compareReg ? { comparison: { artifact_version_id: compareReg.artifact_version_id, filename: compareReg.filename } } : {}),
    ...(externalReg ? { external: { artifact_version_id: externalReg.artifact_version_id, filename: externalReg.filename } } : {}),
    ...priorNote,
    ...hfNote,
    ...numberingNotes(r, true),
    note: `修订稿保留原件版式、编号与表格，修改以修订痕迹显示（有批注的附批注）；${externalReg ? "另有《修订稿·对外版》：同样的修订痕迹、不带批注、修订署名为本所设置，可直接发对方——所以修改理由照常写进 comment（它进内部修订稿与修改对照表），不要为了“能直接发对方”而去掉 comment 重交；" : ""}清洁稿已接受全部修订、去掉批注；${compareReg ? "修改对照表逐段列出修改前后与理由（由系统按实际写入的修改生成，不用另写）；" : ""}原件不变。批注是写给律师的修改理由，发给对方前须删除批注或改用清洁稿。要核对实际写入的结果，用 docx.compare（baseline 填原件的 document_version_id，current 填清洁稿的 artifact_version_id）。`,
  };
}

/**
 * 只改了条款援引号（“第十一条”→“第十二条”、“第4.4款”→“第4.3款”）的修改：增删条款引起的联动，对照表单列（V13 第 38 批）。纯函数。
 */
export function isReferenceOnlyChange(before: string, after: string): boolean {
  if (before === after) return false;
  const norm = (t: string) =>
    t
      .replace(/第[一二三四五六七八九十百零〇两\d]+条/g, "第#条")
      .replace(/第\d+(?:\.\d+)+款/g, "第#款")
      .replace(/第[（(][一二三四五六七八九十]+[)）]项/g, "第#项")
      .replace(/\s+/g, "");
  return norm(before) === norm(after);
}

/**
 * 生成并登记《修改对照表》（Word，原文形态与修订稿一致）；没有可列的修改或生成失败时返回 null（不影响修订稿与清洁稿）。
 * V13 第 38 批（W2 律师评分：律师要求“增删条款引起的条号、援引条号跟着改，并在对照表里单独列出来”，原表混在一起、顺延清单只列前 20 条被截断）：
 * 一、按修改意见的修改；二、援引条号联动（只改了援引号的段落）；三、条款编号顺延（原件 → 修订后，全部列出）。条款一栏写“原号（现号）”。
 */
function registerComparison(ctx: InvokeCtx, r: { changes?: ChangeRow[]; numbering?: NumberingShifts; filename: string }, source: string) {
  const rows = r.changes ?? [];
  if (rows.length === 0) return null;
  try {
    const name = source.replace(/\.docx$/i, "");
    const cap = (s: string) => (s.length > 2000 ? `${s.slice(0, 2000)}……` : s);
    const shifts = r.numbering?.renumbered ?? [];
    const now = new Map(shifts.map((x) => [x.from, x.to]));
    // 位置用律师的说法（第 35 批 R5：原先没有自动编号的段落写“第 21 段”）；编号顺延了的写“原 11.3（现 12.3）”
    const at = (c: ChangeRow) => {
      const base = c.label ?? c.place ?? `第 ${c.para + 1} 段`;
      const to = c.label ? now.get(c.label) : undefined;
      return to && to !== c.label ? `原 ${base}（现 ${to}）` : base;
    };
    const where = (c: ChangeRow) => (c.kind === "insert" ? (c.row ? `在${at(c).replace(/（新增一行）$/, "")}之后新增一行` : `在${at(c)}之后新增`) : at(c));
    const row = (c: ChangeRow, i: number, why = "按律师意见修改") => [String(i + 1), where(c), c.kind === "insert" ? "（新增）" : cap(c.before), c.kind === "delete" ? (/（整行删除）$/.test(c.place ?? "") ? "（删除整行）" : "（删除本段）") : cap(c.after), c.reason || why];
    const linked = rows.filter((c) => c.kind === "edit" && isReferenceOnlyChange(c.before, c.after));
    const own = rows.filter((c) => !linked.includes(c));
    // 第一部分里没写理由的行（V14 基线 B：复核轮为去掉批注不写 comment 重交，17 行全成了“按律师意见修改”）：如实写“未注明理由”，不冒称律师意见
    const ownRow = (c: ChangeRow, i: number) => row(c, i, "（助手未注明理由，请律师核对）");
    const notes = [
      `本表逐段列出对《${name}》所作的修改，共 ${rows.length} 处（按修改意见的修改 ${own.length} 处${linked.length > 0 ? `、因增删条款引起的援引条号联动 ${linked.length} 处` : ""}），与修订稿一致（以修订稿为准）；“条款”一栏写原件条款号，编号顺延了的括注现在的编号。`,
      ...(shifts.length > 0 ? [`删除或插入条款后，${shifts.length} 处条款的自动编号顺延，见第三部分。`] : []),
      "本表供律师复核与向客户说明修改内容；发给对方前请删去“修改理由”一栏。",
    ];
    const cols = ["序号", "条款", "修改前", "修改后", "修改理由"];
    const sections: { heading: string; paragraphs: string[]; table?: { columns: string[]; rows: string[][] } }[] = [
      { heading: "说明", paragraphs: notes },
      { heading: "一、按修改意见的修改", paragraphs: [], table: { columns: cols, rows: own.map(ownRow) } },
    ];
    // 联动行没有写理由的不写“按律师意见修改”（V14 基线 B 独立评分：联动不是律师点名的修改，那样写不实）
    if (linked.length > 0) sections.push({ heading: "二、因增删条款引起的援引条号联动", paragraphs: [], table: { columns: cols, rows: linked.map((c, i) => row(c, i, "增删条款后援引条号随之调整")) } });
    if (shifts.length > 0) {
      sections.push({
        heading: linked.length > 0 ? "三、条款编号顺延（原件 → 修订后）" : "二、条款编号顺延（原件 → 修订后）",
        paragraphs: [],
        table: { columns: ["序号", "原件编号", "修订后编号", "条款开头"], rows: shifts.map((x, i) => [String(i + 1), x.from, x.to, cap(x.text).slice(0, 40)]) },
      });
    }
    const buf = createDocx(`${name}修改对照表`, sections);
    const stored = ctx.blobs.put(buf, ctx.claims.mid ?? null);
    return registerToolArtifact(ctx, {
      kind: "agent_report",
      filename: r.filename.replace(/（修订稿）\.docx$/i, "（修改对照表）.docx"),
      sha256: stored.sha256,
      storage_uri: stored.storage_uri,
      manifest: { tool: "docx.revise", derived_from: "revision_draft", rows: rows.length, linked: linked.length, renumbered: shifts.length, note: "修改对照表：按修订稿实际写入的修改逐段列出修改前后与理由（系统生成）" },
    });
  } catch {
    return null;
  }
}
