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
import { applyRevisionsToDocx, extractParagraphs, keepHouseMark, locateAnchorInDocx, readZipText, sanitizeDocx, type AnchorLocation, type AnchorMatch, type RevisionOp } from "@zr-legal/docx-engine";
import { findTokens } from "@zr-legal/tokenizer";
import type { InvokeCtx } from "../registry.ts";
import { registerToolArtifact } from "./review.ts";
import { factRefNos, isInternalDocument, scrubQualityLine, type DeliverableSection } from "../../services/deliverable-check.ts";
import { factTableRows, syncFactSection } from "../../services/fact-refs.ts";
import { slog } from "@zr-legal/safe-log";
import { latestOfLineage, sameFollowUpChain } from "../../services/artifact-lineage.ts";

/** 结果分布留痕（V13 第 38 批）：只记计数，不记文字。 */
function logOutcome(status: "applied" | "partial" | "not_applied" | "preview", patches: number, applied: number, conflicts: readonly { reason: Reason }[]): void {
  const n = (r: Reason) => conflicts.filter((c) => c.reason === r).length;
  slog.event("TOOLS_DOCX_EDIT_OUTCOME", { tool: "docx_edit_draft", status, patches, applied, not_found: n("anchor_not_found") + n("anchor_empty"), ambiguous: n("anchor_ambiguous") + n("hint_mismatch") + n("occurrence_out_of_range"), unknown_token: n("unknown_token"), other: n("overlap") + n("apply_failed") + n("quality_line") });
}

export const EDIT_DRAFT_MAX_PATCHES = 100;

/** docx.edit_draft 能改的成果：docx.render_report 出的文书及本工具在其上改出的版本。 */
const EDITABLE_TOOLS = new Set(["docx.render_report", "docx.edit_draft"]);
function manifestTool(manifest: string | null): string {
  try {
    const t = JSON.parse(manifest ?? "{}")?.tool;
    return typeof t === "string" ? t : "";
  } catch {
    return "";
  }
}

interface EditPatchInput {
  anchor?: unknown;
  proposed_text?: unknown;
  occurrence?: unknown;
  paragraph_hint?: unknown;
  insert_after?: unknown;
  style?: unknown;
}

/** insert_after 新段落的样式（第 58 批 D-242）：本产品文书的样式编号。 */
const INSERT_STYLE: Readonly<Record<string, { first: string; rest: string }>> = {
  body: { first: "KwlBody", rest: "KwlBody" },
  heading1: { first: "KwlHeading1", rest: "KwlBody" },
  heading2: { first: "KwlHeading2", rest: "KwlBody" },
  heading3: { first: "KwlHeading3", rest: "KwlBody" },
};
const KWL_HEADINGS = ["KwlTitle", "KwlHeading1", "KwlHeading2", "KwlHeading3"] as const;

type Reason = "anchor_empty" | "anchor_not_found" | "anchor_ambiguous" | "hint_mismatch" | "occurrence_out_of_range" | "unknown_token" | "overlap" | "apply_failed" | "quality_line";

const FIX: Record<Reason, string> = {
  anchor_empty: "anchor 不能为空；新增段落用 insert_after，锚点写插入位置前一段里的原文",
  anchor_not_found: "草稿里找不到这段文字：逐字照抄这份文书里的原文（同一段落之内，含标点与代号）",
  anchor_ambiguous: "这段文字在多个段落或表格格子出现（见 matches，按全文先后排，含表格格子）：要改哪一处就写 occurrence: 该处的序号；几处都要改的，每处各交一条。也可以加 paragraph_hint——正文写所在条款号或该段里另一段独有的文字，表格里的格子写“行名｜列名”（如“付款安排｜严重度”，行名取该行第一格的文字），几张表的行名列名相同时前面再加表格前一段的条款号或标题（如“2.1｜合计｜金额（元）”）；或把锚点写长到唯一",
  hint_mismatch: "锚点在文书里出现的位置（见 matches）与你给的位置提示对不上，没有写入：先确认要改的是哪一处——提示所指的那一处若已改过，这一条不要再交；要改的就是 matches 里的那一处，去掉 paragraph_hint 或改成与它相符的提示后重交",
  occurrence_out_of_range: "occurrence 是这段文字在全文里第几处出现（按先后，含表格格子，从 1 起），没有这一处：照 matches 里的序号写",
  unknown_token: "含有本事项不存在的代号：代号只能照抄材料或草稿里出现过的",
  overlap: "与另一条修改的原文重叠：合并成一条",
  apply_failed: "写入失败：通常是两条修改落在同一处，拆开或合并后重试",
  quality_line: "这一条要写进文书的只有质量说明（“通用辅助 · 未经本所质量验收”“草稿 · 待律师复核”）：它只写在最终答复末尾，交付文件里不写，去掉这一条",
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
 * 按文书引擎的样式还原“节”（一级、二级、三级标题起节），供改后重做交付前检查（条款编号与互引按节标题判断）。
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
    // V18 首轮 B11：三级标题同样开一节，标 level 3（交付前检查的序号规则不把它当大节、小节计数）。
    // 二级标题不标层级、照旧按节标题查：它也可能是段落里“一、”“（一）”开头的小标题排成的，原先就按节标题查序号
    if (style === "KwlHeading1" || style === "KwlHeading2" || style === "KwlHeading3") {
      sections.push(cur);
      cur = { heading: text, paragraphs: [], ...(style === "KwlHeading3" ? { level: 3 } : {}) };
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
  const art = ctx.db.get<{ kind: string; filename: string; storage_uri: string; sha256: string; run_id: string | null; manifest: string | null; lineage: string | null }>(
    `SELECT kind, filename, storage_uri, sha256, run_id, manifest, lineage FROM artifact_versions WHERE artifact_version_id = ? AND matter_id = ?`,
    [id, mid],
  );
  if (!art) throw new DomainError("not_found", "找不到这份文书：artifact_version_id 用 docx.render_report 返回的那个", 404);
  // 追问可以在此前各轮的草稿上改（D-185）：同一条追问链上的算本任务的文书；别的任务的仍不能动
  if (!sameFollowUpChain(ctx.db, art.run_id, rid)) throw new DomainError("validation", "只能修改本任务（含它所追问的此前各轮）里生成的文书草稿；律师上传的材料用 docx.revise 出修订稿", 422);
  if (art.run_id !== rid) {
    const latest = latestOfLineage(ctx.db, mid, art.kind, art.lineage);
    if (latest && latest !== id) throw new DomainError("validation", `这份文书已有更新的版本：此前各轮的文书只能在最新版上改，否则其后的修改会丢。请改用成果编号 ${latest}`, 422, { latest_artifact_version_id: latest });
  }
  if (art.kind !== "agent_report" || !art.filename.toLowerCase().endsWith(".docx")) {
    throw new DomainError("validation", "只能修改 docx.render_report 生成的 Word 文书；修订稿、清洁稿要改的，在原件上重新用 docx.revise 提交全部修改", 422);
  }
  // 安全评审 M1：按生成工具判断，不按成果类别猜——《修改对照表》也登记为本任务的 Word 成果，但内容是原件原文，
  // 本工具的结果按“助手写的文字”读回（只换已知名单），不能作用于它
  if (!EDITABLE_TOOLS.has(manifestTool(art.manifest))) {
    throw new DomainError("validation", "这份文书不是 docx.render_report 生成的（例如修改对照表由 docx.revise 按原件生成）：不能用本工具改；要改修订内容，在原件上用 docx.revise 补交", 422);
  }
  const raw = Array.isArray(p.patches) ? (p.patches as EditPatchInput[]) : [];
  if (raw.length === 0) throw new DomainError("validation", "patches 至少一条", 422);
  if (raw.length > EDIT_DRAFT_MAX_PATCHES) throw new DomainError("validation", `一次最多 ${EDIT_DRAFT_MAX_PATCHES} 处修改；改动更多时说明这份文书要重写，用 docx.render_report 重新生成`, 422);
  const buf = ctx.blobs.read(art.storage_uri);
  if (sha256Hex(buf) !== art.sha256) throw new DomainError("hash_mismatch", "文书草稿内容已变化（读取时复算 hash 不符），已停止", 412);
  const table = ctx.tokens?.table(mid) ?? [];
  const known = new Set(table.map((e) => e.token));
  const valueOf = new Map(table.map((e) => [e.token, e.value] as const));

  // 逐条明细（第 57 批真实走查：冲突序号从 0 起、没注明，模型按 1 起重交，重交的全是已写入的几处）：
  // patch_no 是第几处（从 1 起，按提交的 patches 顺序），anchor 是该处提交的原文（截断）；index 是同一处从 0 起的旧编号，保留兼容
  type Conflict = { patch_no: number; index: number; anchor: string; reason: Reason; fix: string; detail?: string; matches?: { occurrence: number; where: string; context: string }[] };
  const conflicts: Conflict[] = [];
  const clip = (s: string, n = 40) => ([...s].length > n ? `${[...s].slice(0, n).join("")}…` : s);
  const push = (index: number, anchor: string, reason: Reason, extra: { fix?: string; detail?: string; matches?: AnchorMatch[] } = {}) =>
    void conflicts.push({
      patch_no: index + 1,
      index,
      anchor: clip(anchor),
      reason,
      fix: extra.fix ?? FIX[reason],
      ...(extra.detail ? { detail: extra.detail } : {}),
      ...(extra.matches && extra.matches.length > 0 ? { matches: extra.matches.slice(0, 10).map((m) => ({ occurrence: m.occurrence, where: m.where, context: m.context })) } : {}),
    });
  /** 定位不成时写给模型的改法：带上命中各处的位置，给出 occurrence 的具体写法。 */
  const locateFix = (loc: Extract<AnchorLocation, { ok: false }>, occurrence: number | undefined, hint: string | undefined): string => {
    const ms = loc.matches;
    if (loc.reason === "ambiguous") {
      const eg = ms[1] ?? ms[0]!;
      return `${FIX.anchor_ambiguous}。例如改第 ${eg.occurrence} 处（${eg.where}）就写 occurrence: ${eg.occurrence}`;
    }
    if (loc.reason === "occurrence_out_of_range") return `这段文字全文共出现 ${ms.length} 处，没有第 ${occurrence} 处。${FIX.occurrence_out_of_range}`;
    if (loc.reason === "hint_mismatch") {
      const m = occurrence !== undefined ? ms[occurrence - 1] : ms[0];
      const head = occurrence !== undefined ? `你指定的第 ${occurrence} 处在${m?.where ?? ""}` : `锚点只在${m?.where ?? ""}出现（${m?.context ?? ""}）`;
      return `${head}，与你给的位置提示“${clip(hint ?? "", 30)}”不符。${FIX.hint_mismatch}`;
    }
    return FIX.anchor_not_found;
  };
  const ops: RevisionOp[] = [];
  /** 每条写入的修改：第几处（从 0 起）与定位到的原件段落（合并写入前查同段冲突用）。 */
  const placed: { index: number; op: RevisionOp; match: AnchorMatch }[] = [];
  raw.forEach((x, index) => {
    const anchor = String(x?.anchor ?? "");
    // 质量说明（第 42 批）：新文字里独立成段的质量说明直接删掉；删完什么都不剩的这一条不写（否则“替换成空”会把锚点原文删掉）
    const scrub = scrubQualityLine(String(x?.proposed_text ?? ""));
    const proposed = scrub.text;
    if (scrub.removed > 0 && proposed.trim() === "") return push(index, anchor, "quality_line");
    if (!anchor) return push(index, anchor, "anchor_empty");
    // 新文字里的代号须是本事项的（导出时按令牌表还原；不认识的代号会原样留在文书里）
    const unknown = findTokens(proposed).filter((t) => !known.has(t) && !anchor.includes(t));
    if (unknown.length > 0) return push(index, anchor, "unknown_token", { detail: [...new Set(unknown)].join("、") });
    // occurrence（第 57 批）：全文（含表格格子）按先后第几处，从 1 起；0、负数、小数不猜，退回说明
    const occurrence = x?.occurrence === undefined || x?.occurrence === null ? undefined : (x.occurrence as number);
    if (occurrence !== undefined && (!Number.isInteger(occurrence) || occurrence < 1)) return push(index, anchor, "occurrence_out_of_range", { fix: `occurrence 写的是 ${String(x.occurrence)}。${FIX.occurrence_out_of_range}` });
    const hint = typeof x?.paragraph_hint === "string" && x.paragraph_hint.trim() ? x.paragraph_hint : undefined;
    // 先在整份草稿里定位（全文次序、位置提示；全文只有一处时也核对提示），定准一处再写入，写入时只在那一段里找
    let text = anchor;
    let loc = locateAnchorInDocx(buf, text, { occurrence, hint });
    if (!loc.ok && loc.reason === "not_found") {
      // 草稿里是原字、助手看到的回读里却是代号：令牌表后来学进的值（V14 第 39 批真实走查 A：法条“当事人一方明确表示”让“方明”进了令牌表，
      // 助手早先写进草稿的“卖方明知”在回读里成了“卖〔自然人·…〕知”，照抄回读的锚点 9 次都定位不到）。锚点里的代号换回原字再找一次
      const restored = findTokens(anchor).reduce((t, tok) => (valueOf.has(tok) ? t.split(tok).join(valueOf.get(tok)!) : t), anchor);
      if (restored !== anchor) {
        const again = locateAnchorInDocx(buf, restored, { occurrence, hint });
        if (again.ok || again.reason !== "not_found") {
          text = restored;
          loc = again;
        }
      }
    }
    if (!loc.ok) {
      const reason: Reason = loc.reason === "not_found" ? "anchor_not_found" : loc.reason === "ambiguous" ? "anchor_ambiguous" : loc.reason;
      return push(index, anchor, reason, { fix: locateFix(loc, occurrence, hint), matches: loc.matches });
    }
    const op: RevisionOp = {
      opId: `e${index}`,
      anchor: { originalText: text, occurrence: loc.match.inParagraph, paragraphIndex: loc.match.paragraphIndex },
      originalHash: sha256Hex(text),
      newText: proposed,
      ...(x?.insert_after === true ? { insertAfter: true } : {}),
      // 新段落样式：给了 style 的按它（标题样式只给第一行，其余各行是正文）；没给的，插在标题之后时按正文，插在正文之后沿用锚点段落
      ...(x?.insert_after === true && typeof x?.style === "string" && INSERT_STYLE[x.style] ? { insertStyles: INSERT_STYLE[x.style] } : {}),
      ...(x?.insert_after === true ? { insertAfterHeading: { headingStyles: KWL_HEADINGS, style: "KwlBody" } } : {}),
      author: "AI 起草",
    };
    try {
      applyRevisionsToDocx(buf, { baselineHash: art.sha256, ops: [op] });
      ops.push(op);
      placed.push({ index, op, match: loc.match });
    } catch (e) {
      const msg = (e as Error).message;
      const reason = classify(msg);
      push(index, anchor, reason, { detail: msg.replace(/修订 e(\d+)/g, (_m, d: string) => `第 ${Number(d) + 1} 处修改`).slice(0, 200) });
    }
  });
  // 同一段里同一锚点出现几次、又有别的修改落在这一段的：段内次序会被前面的修改打乱（前一处删掉后“第 2 次出现”就成了原来的第 3 次），
  // 不冒险写错位置，退回请合并成一条
  for (const p of placed) {
    if (p.match.inParagraph === 0 || p.op.insertAfter) continue;
    if (!placed.some((q) => q !== p && !q.op.insertAfter && q.match.paragraphIndex === p.match.paragraphIndex)) continue;
    ops.splice(ops.indexOf(p.op), 1);
    push(p.index, String(raw[p.index]?.anchor ?? ""), "overlap", { fix: "这段文字在同一段落里出现了几次，这一段又有别的修改：把这一段里的几处修改合并成一条（锚点写成包含这几处的一整句）后重交" });
  }
  conflicts.sort((a, b) => a.index - b.index);
  const appliedNos = placed.filter((p) => ops.includes(p.op)).map((p) => p.index + 1);
  // 能定位的先写入、定位不到的逐条退回（V13 第 38 批取证：4 次正式调用里 2 次因 2 处中 1 处找不到而整体未写，另一处本可写入）。
  // 草稿是在最新版本上逐处增量修改，部分写入不丢已写的修改；一处都定位不到时照旧不写
  if (ops.length === 0) {
    logOutcome("not_applied", raw.length, 0, conflicts);
    return { status: "not_applied" as const, written: false, conflicts, note: `没有写入任何修改：conflicts 里 patch_no 是你提交的 patches 中的第几处（从 1 起，按提交顺序），anchor 是那一处的原文；按逐条原因改正后重新提交${p.dry_run === true ? "（这是试写）" : ""}` };
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
    logOutcome("preview", raw.length, ops.length, conflicts);
    // 试写与正式写入返回同样的逐条明细（第 57 批真实走查：14 处试写通过 11 处，看不到是哪 3 处、为什么）
    return {
      status: "preview" as const,
      written: false,
      applied: ops.length,
      applied_patch_nos: appliedNos,
      ...(conflicts.length > 0 ? { conflicts } : {}),
      note:
        conflicts.length > 0
          ? `试写：第 ${appliedNos.join("、")} 处能写入，另有 ${conflicts.length} 处写不进（见 conflicts：patch_no 是第几处，从 1 起，按你提交的 patches 顺序；anchor 是那一处的原文）。没有生成文件；改正这几处后，去掉 dry_run 正式提交`
          : "试写全部通过，没有生成文件；去掉 dry_run 正式提交",
    };
  }
  // 事实对照（V16 第 41 批）：内部文书改动后，文末系统附的“事实对照”按改后正文引用的序号重新生成（不重复追加；不再引用时整节去掉）
  let factSynced = false;
  if (isInternalDocument(art.filename.replace(/\.docx$/i, ""))) {
    try {
      const synced = syncFactSection(out, (body) => {
        const nos = factRefNos(body);
        return nos.length > 0 ? factTableRows({ db: ctx.db, tokens: ctx.tokens }, mid, nos) : null;
      });
      if (synced.changed) {
        out = synced.docx;
        factSynced = true;
      }
    } catch {
      // 同步失败不影响这次修改（文末那一节可能与正文引用不一致，交付前检查与复核仍会看到）
    }
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
    applied_patch_nos: appliedNos,
    ...(conflicts.length > 0 ? { conflicts } : {}),
    ...reg,
    edited_from: id,
    ...(factSynced ? { fact_table: "文末的“事实对照”已按改后正文引用的事实序号重新生成（系统附的，不要手工改这一节）" } : {}),
    ...(repeated.length > 0
      ? { repeated_sentences: repeated, repeated_note: "这次修改后，上面这些句子在文书里出现了两次以上（修改前没有这么多）：多半是新文字和原有的句子重复了。逐处核对，重复的用 docx.edit_draft 删掉一处（用这次返回的 artifact_version_id）" }
      : {}),
    note:
      conflicts.length > 0
        ? `已在《${name}》上改好 ${ops.length} 处，登记为新版本；已写入第 ${appliedNos.join("、")} 处；另有 ${conflicts.length} 处没有写入（见 conflicts：patch_no 是你提交的 patches 中的第几处，从 1 起，按提交顺序；anchor 是那一处的原文）：按原因改正后，用这次返回的 artifact_version_id 只重交这几处，已写入的不要重复提交`
        : `已在《${name}》上改好 ${ops.length} 处，登记为同名文书的新版本（旧版本保留）。后续再改，用这次返回的 artifact_version_id`,
  };
}
