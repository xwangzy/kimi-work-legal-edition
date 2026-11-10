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
import { applyRevisionsToDocx, docxListLabels, extractParagraphs, headerFooterParagraphs, paragraphCells, readZipText, sameSpaces, sanitizeDocx, stripListLabel, type RevisionOp } from "@zr-legal/docx-engine";
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
  /** 条款号提示（锚点多处出现时用于定位）。写“页眉”或“页脚”时改的是页眉 / 页脚里的文字（V10 第 36 批）。 */
  paragraph_hint?: string;
  /** 批注（令牌形态）。 */
  comment?: string;
  /** 段后插入（v9.4 第 19 批 C-02 缺失条款）：不改锚点，在锚点所在段落之后插入 proposed_text（按换行分段）。 */
  insert_after?: boolean;
  /** 表后插入（V16 第 41 批）：在锚点所在表格（或锚点段落后面紧跟的表格）之后插入 proposed_text；格式与自动编号取表格前那一段。 */
  insert_after_table?: boolean;
  /** 表格新增一行（V16 第 41 批）：在锚点所在行之后加一行，proposed_text 各格用“｜”分隔。 */
  insert_row_after?: boolean;
  /** 删除锚点所在的表格行（V16 第 41 批）：proposed_text 须为空。 */
  delete_row?: boolean;
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
    | "complex_structure"
    | "new_clause_in_edit"
    | "bad_placement"
    | "apply_failed";
  detail?: string;
}

/**
 * 改字的新文字里换行后冒出新的条款编号（“2.3 ……”“第七条 ……”）：新增条款被接在原段落里成了软回车，
 * 不受自动编号管理，对方也无法单独接受或拒绝（V10 真实走查 V9：提前退租权写成第 2.2 款段内的“2.3”）。
 * 返回冒出的编号；原文本身就是多行的段落不查。
 */
const NEW_CLAUSE_LINE_RE = /^\s*(第\s*[0-9一二三四五六七八九十百零〇]{1,6}\s*条|[0-9]{1,3}(?:\.[0-9]{1,3})+)(?![0-9.])/;
export function newClauseInEdit(anchor: string, proposed: string): string | null {
  if (/\n/.test(anchor)) return null;
  for (const line of proposed.split(/\r?\n/).slice(1)) {
    const m = NEW_CLAUSE_LINE_RE.exec(line);
    if (m && !anchor.includes(m[1]!)) return m[1]!.replace(/\s+/g, "");
  }
  return null;
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
      /** 自动编号挪动与正文里的旧条号（接受全部修订后的稿与原件对照）。 */
      numbering: NumberingShifts;
      /** 新文字开头抄进去、已去掉的自动编号（逐条）。 */
      label_notes: { index: number; dropped: string[] }[];
      /** 修改对照（原文形态，第 35 批）：只给内核生成《修改对照表》，不返回给助手。 */
      changes: ChangeRow[];
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
      numbering?: NumberingShifts;
      label_notes?: { index: number; dropped: string[] }[];
      /** 只在 dryRun 时给出：页眉页脚里的修改（原文形态，改前 / 改后整段）。 */
      header_footer_changes?: ChangeRow[];
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
  /** 落在表格上的方式（V16 第 41 批）：表后插入、新增一行、删除一行。 */
  placement?: "after_table" | "row_inserted" | "row_deleted";
}

export const AI_REVISION_AUTHOR = "Kimi Work 法律助手（AI 建议，待律师确认）";
const AUTHOR = AI_REVISION_AUTHOR;

/** 自动编号挪动后的条号与正文里写死的旧条号（第 34 批 T3b 真实走查：删去第十条后，“丙方依本合同第十一条承担保证责任”指向了通知与送达）。 */
export interface NumberingShifts {
  /** 编号变了的条款：原编号、现编号、条款文字开头。 */
  renumbered: { from: string; to: string; text: string }[];
  /** 正文里仍写着旧编号的地方：所在段落（现编号与文字开头）、写的条号、该条现在的编号。 */
  references: { at: string; ref: string; now: string }[];
}

/** 双字组重合度（Dice）：0～1。 */
function similarity(x: string, y: string): number {
  const grams = (t: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i + 1 < t.length; i++) m.set(t.slice(i, i + 2), (m.get(t.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const gx = grams(x);
  const gy = grams(y);
  let inter = 0;
  for (const [g, n] of gx) inter += Math.min(n, gy.get(g) ?? 0);
  const total = Math.max(0, x.length - 1) + Math.max(0, y.length - 1);
  return total === 0 ? 0 : (2 * inter) / total;
}

/** 与某个自动编号同形的段首编号（“8.4 ”“第十条 ”“（三）”）：数字换成任意数字、中文数字换成任意中文数字。 */
function leadingLabel(label: string): RegExp {
  const body = label
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/[0-9０-９]+/g, "[0-9０-９]+")
    .replace(/[一二三四五六七八九十百千零〇两]+/g, "[一二三四五六七八九十百千零〇两]+");
  return new RegExp(`^${body}(?:[\\s　]+|(?<=[、.．）)]))`);
}

const REF_RE = /第[一二三四五六七八九十百千零〇两0-9０-９]+条|(?<![\d.])\d+(?:\.\d+)+(?![\d.])/g;

/**
 * 修改前后的自动编号对照：按文字相同、先后次序对齐两稿的段落，列出编号变了的条款；再找正文里仍写着旧编号的互引。
 * 自动编号由 Word 生成，删除、插入条款后会自动顺延，正文里写死的“第十一条”“11.2”不会跟着变。
 */
export function numberingShifts(before: Buffer, after: Buffer): NumberingShifts {
  const b = extractParagraphs(before).map((p) => p.text);
  const bl = docxListLabels(before);
  const a = extractParagraphs(after).map((p) => p.text);
  const al = docxListLabels(after);
  const moved = new Map<string, string>();
  const renumbered: NumberingShifts["renumbered"] = [];
  // ① 文字相同的段落按先后次序对齐
  const pairOf = new Map<number, number>();
  let j = 0;
  for (let i = 0; i < a.length; i++) {
    if (!al[i] || !a[i]!.trim()) continue;
    let k = j;
    while (k < b.length && b[k] !== a[i]) k++;
    if (k >= b.length) continue;
    j = k + 1;
    pairOf.set(i, k);
  }
  // ② 被改过文字的段落（V13 第 38 批 W2：10.1→11.1、11.3→12.3 等 5 处本身被修改的段落漏出顺延清单）：
  //    在前后两个已对齐段落之间，按文字相似度（双字组重合度 ≥ 0.3，只在两个已对齐段落之间找）依次配对，插入、删除的段落不配
  const used = new Set(pairOf.values());
  const anchors = [...pairOf.entries()].sort((x, y) => x[0] - y[0]);
  for (let i = 0; i < a.length; i++) {
    if (pairOf.has(i) || !al[i] || !a[i]!.trim()) continue;
    const prev = anchors.filter(([ai]) => ai < i).at(-1)?.[1] ?? -1;
    const next = anchors.find(([ai]) => ai > i)?.[1] ?? b.length;
    let best = -1;
    let score = 0.3;
    for (let k = prev + 1; k < next; k++) {
      if (used.has(k) || !bl[k] || !b[k]!.trim()) continue;
      const sc = similarity(b[k]!, a[i]!);
      if (sc >= score) {
        score = sc;
        best = k;
      }
    }
    if (best >= 0) {
      used.add(best);
      pairOf.set(i, best);
      anchors.push([i, best]);
      anchors.sort((x, y) => x[0] - y[0]);
    }
  }
  for (const [i, k] of [...pairOf.entries()].sort((x, y) => x[0] - y[0])) {
    const from = bl[k];
    if (from && from !== al[i] && !moved.has(from)) {
      moved.set(from, al[i]!);
      renumbered.push({ from, to: al[i]!, text: a[i]!.slice(0, 20) });
    }
  }
  const references: NumberingShifts["references"] = [];
  if (moved.size > 0) {
    a.forEach((t, i) => {
      for (const m of t.matchAll(REF_RE)) {
        const now = moved.get(m[0]);
        if (now) references.push({ at: `${al[i] ? `${al[i]} ` : ""}${t.slice(0, 24)}`, ref: m[0], now });
      }
    });
  }
  return { renumbered: renumbered.slice(0, 40), references: references.slice(0, 40) };
}

/** 合并写入时先做段后插入（不改原有段落文字），再做替换：替换不会把插入的锚点改掉（复核 Q2-06）；各自保持原先后次序。 */
// V16 第 41 批：新增表格行与段后、表后插入一样先做；删除表格行最后做（同一行里另有改字的，由文书引擎报“落在同一处”）
const insertsFirst = (ops: readonly RevisionOp[]): RevisionOp[] => [
  ...ops.filter((o) => o.insertAfter || o.insertRowAfter),
  ...ops.filter((o) => !o.insertAfter && !o.insertRowAfter && !o.deleteRow),
  ...ops.filter((o) => o.deleteRow),
];

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
  // Agent 所见的令牌化视图：同一事项令牌化器作用于原件全文（不写回新条目：视图只用于核对）。
  // 自动编号写在段首（第 29 批：材料解析文字带“第三条”“3.2”，与 Agent 看到的一致）；编号不在原件段落文字里，抄进锚点的编号在定位前去掉
  const paragraphs = extractParagraphs(buf).map((x) => x.text);
  const labels = docxListLabels(buf);
  const viewText = tokens.tokenizer(input.matter_id).tokenize(paragraphs.map((t, i) => (labels[i] && t.trim() ? `${labels[i]} ${t}` : t)).join("\n")).text;
  const withoutLabel = (s: string): string => {
    const stripped = stripListLabel(s, labels);
    return stripped !== s && stripped && !paragraphs.some((t) => t.includes(s)) ? stripped : s;
  };
  // 页眉页脚（V10 第 36 批）：paragraph_hint 写“页眉 / 页脚”的修改改在页眉页脚里，锚点核对它们的令牌化文字
  const hfParts = headerFooterParagraphs(buf);
  const hfView = (part: "header" | "footer") => tokens.tokenizer(input.matter_id).tokenize(hfParts.filter((x) => x.part === part).flatMap((x) => x.texts).join("\n")).text;
  const conflicts: PatchConflict[] = [];
  const ops: RevisionOp[] = [];
  let tokensRestored = 0;
  patches.forEach((p, index) => {
    const anchor = String(p?.anchor ?? "");
    const proposed = String(p?.proposed_text ?? "");
    const comment = typeof p?.comment === "string" ? p.comment : undefined;
    if (anchor.length === 0) return void conflicts.push({ index, reason: "anchor_empty" });
    if (sha256Hex(anchor) !== String(p?.expected_text_hash ?? "")) return void conflicts.push({ index, reason: "anchor_hash_mismatch" });
    const part = headerFooterHint(p?.paragraph_hint);
    // 表格上的三种写法与段后插入互斥；删除表格行不带新文字（V16 第 41 批）
    const tableModes = [p?.insert_after_table === true, p?.insert_row_after === true, p?.delete_row === true].filter(Boolean).length;
    if (tableModes > 1 || (tableModes === 1 && p?.insert_after === true && p?.insert_after_table !== true)) return void conflicts.push({ index, reason: "bad_placement", detail: "insert_after、insert_after_table、insert_row_after、delete_row 一条修改只能用一种" });
    if (p?.delete_row === true && proposed.trim() !== "") return void conflicts.push({ index, reason: "bad_placement", detail: "delete_row 删除整行，proposed_text 须为空串；只改某一格的字不要用 delete_row" });
    if ((p?.insert_after_table === true || p?.insert_row_after === true) && proposed.trim() === "") return void conflicts.push({ index, reason: "bad_placement", detail: "新增的内容不能为空" });
    if (tableModes === 1 && part) return void conflicts.push({ index, reason: "bad_placement", detail: "页眉页脚里只能改字" });
    const inserting = p?.insert_after === true || p?.insert_after_table === true || p?.insert_row_after === true || p?.delete_row === true;
    const newLabel = inserting ? null : newClauseInEdit(anchor, proposed);
    if (newLabel) return void conflicts.push({ index, reason: "new_clause_in_edit", detail: `新文字里换行后是新的“${newLabel}”` });
    if (part) {
      if (p.insert_after === true) return void conflicts.push({ index, reason: "apply_failed", detail: "页眉页脚只能改字，不能插入新段落" });
      if (!sameSpaces(hfView(part)).includes(sameSpaces(anchor))) return void conflicts.push({ index, reason: "anchor_not_in_view", detail: `锚点不在原件${part === "header" ? "页眉" : "页脚"}的文字里（照抄 header_footer 列出的文字）` });
    } else if (!sameSpaces(viewText).includes(sameSpaces(anchor))) return void conflicts.push({ index, reason: "anchor_not_in_view", detail: "锚点不在当前版本的令牌化视图中（文档已变化或锚点不是 Agent 看到的原文）" });
    // 代号必须都在本事项令牌表里（不认识的代号不猜）
    const unknown = [...findTokens(anchor), ...findTokens(proposed), ...(comment ? findTokens(comment) : [])].filter((t) => !restoreMap.has(t));
    if (unknown.length > 0) return void conflicts.push({ index, reason: "unknown_token", detail: [...new Set(unknown)].join("、") });
    const a0 = restore(anchor);
    const a = { ...a0, text: withoutLabel(a0.text) };
    const n = restore(proposed);
    const c = comment ? restore(comment) : null;
    tokensRestored += a.restored + n.restored + (c?.restored ?? 0);
    ops.push({
      opId: `p${index}`,
      anchor: {
        originalText: a.text,
        ...(Number.isInteger(p.occurrence) && (p.occurrence as number) >= 0 ? { occurrence: p.occurrence } : {}),
        ...(typeof p.paragraph_hint === "string" && p.paragraph_hint && !part ? { paragraphHint: restore(p.paragraph_hint).text } : {}),
        ...(part ? { part } : {}),
      },
      originalHash: sha256Hex(a.text),
      newText: n.text,
      ...(p.insert_after === true || p.insert_after_table === true ? { insertAfter: true } : {}),
      ...(p.insert_after_table === true ? { afterTable: true } : {}),
      ...(p.insert_row_after === true ? { insertRowAfter: true } : {}),
      ...(p.delete_row === true ? { deleteRow: true } : {}),
      ...(c && !part ? { comment: c.text } : {}),
      author: input.author ?? AUTHOR,
    });
  });
  // 逐条在原件上试定位（任一条不成立即整体预览）；定位口径与文书引擎一致：出现序号按段落内计，多段命中须有条款提示
  const nth = (text: string, needle: string, occ: number): number => {
    let at = -1;
    for (let k = 0; k <= occ; k++) {
      at = sameSpaces(text).indexOf(sameSpaces(needle), at + 1);
      if (at < 0) return -1;
    }
    return at;
  };
  const spans: PatchSpan[] = [];
  let cellsCache: ReturnType<typeof paragraphCells> | null = null;
  const bodyCells = (): ReturnType<typeof paragraphCells> => {
    if (cellsCache) return cellsCache;
    try {
      cellsCache = paragraphCells(readZipText(buf, "word/document.xml") ?? "");
    } catch {
      cellsCache = [];
    }
    return cellsCache;
  };
  const labelNotes: { index: number; dropped: string[] }[] = [];
  const hfRows: ChangeRow[] = [];
  for (const op of ops) {
    const index = Number(op.opId.slice(1));
    let located: number | undefined;
    let formatAt: number | undefined;
    let placement: PatchSpan["placement"];
    try {
      const one = applyRevisionsToDocx(buf, { baselineHash: doc.sha256, ops: [op] }).applied[0];
      located = one?.paragraphIndex;
      formatAt = one?.formatParagraphIndex;
      placement = one?.placement;
    } catch (e) {
      const msg = (e as Error).message;
      conflicts.push({
        index,
        reason: /歧义/.test(msg)
          ? "anchor_ambiguous"
          : /未找到|非文本区/.test(msg)
            ? "anchor_not_found"
            : /同一处/.test(msg)
              ? "overlap"
              : /后面不是表格|不在表格里|应有 \d+ 格|没有文字|新文字须为空|没有正文段落可以沿用/.test(msg)
                ? "bad_placement"
                : /修订痕迹|超链接|内容控件|域|脚注|特殊符号|嵌入对象|结构不完整|无法自动|嵌着表格/.test(msg)
                  ? "complex_structure"
                  : "apply_failed",
        detail: msg.slice(0, 200),
      });
      continue;
    }
    // 普通的段后插入落在表格单元格里（V16 第 41 批真实走查 D1）：律师要“表格新增一行”“在第 6.1 款及其表格之后新增一款”，
    // 助手把锚点写在格子里用 insert_after——结果是格内多了一段带制表符的文字，表格没有多一行，回报却写“已新增一行”。这种落位一律不写，告诉助手该用哪一种
    if (op.insertAfter && !op.afterTable && located !== undefined && bodyCells()[located]) {
      conflicts.push({ index, reason: "bad_placement", detail: "锚点在表格单元格里，段后插入只会在这一格里多出一段，不会新增表格行，也不会落到表格之后：要加一行用 insert_row_after（各格用“｜”分隔）；要把新款插在整张表之后用 insert_after_table；确实只想在这一格里另起一行字的，把这一格的原文作为 anchor 改写，新文字里用换行" });
      continue;
    }
    // 页眉页脚：不参与正文的段落定位与编号处理；对照表单列一行（位置写“页眉 / 页脚”，修改理由取助手给的批注）
    if (op.anchor.part === "header" || op.anchor.part === "footer") {
      const where = op.anchor.part === "header" ? "页眉" : "页脚";
      const comment = patches[index]?.comment;
      for (const t of hfParts.filter((x) => x.part === op.anchor.part).flatMap((x) => x.texts)) {
        if (!sameSpaces(t).includes(sameSpaces(op.anchor.originalText))) continue;
        hfRows.push({ para: -1, label: null, place: where, kind: "edit", before: t, after: t.replace(op.anchor.originalText, op.newText), reason: comment ? restore(comment).text : "" });
        break;
      }
      continue;
    }
    // 记录定位，检查补丁之间是否重叠（重叠的两处修改无法同时写成原生修订）；段落用引擎实际定位的那一段
    // （第 34 批 D10：原先这里另按“提示是段落文字的子串”挑一遍，对不上时取第一处，与引擎不一致）
    const occ = op.anchor.occurrence ?? 0;
    const target = located !== undefined && paragraphs[located] !== undefined ? { i: located, at: nth(paragraphs[located]!, op.anchor.originalText, occ) } : undefined;
    // 段首编号是自动编号的：新文字开头抄进去的编号去掉（第 34 批 T3b：锚点里的“11.2”在定位前去掉了，新文字里的没去，
    // Word 里显示成“11.2 11.2 保证范围……”；插入的条款继承自动编号，“8.3 乙方违约的……”同样重号）。原文段首本来就写着编号的不动
    // 表后插入的新款沿用表格前那一段的编号（V16 第 41 批）：抄进去的编号按那一段的编号样式去掉；表格行不处理
    const lab = target && !op.insertRowAfter && !op.deleteRow ? (labels[op.afterTable && formatAt !== undefined ? formatAt : target.i] ?? null) : null;
    if (target && lab && (op.insertAfter || target.at === 0)) {
      const re = leadingLabel(lab);
      if (!re.test(paragraphs[op.afterTable && formatAt !== undefined ? formatAt : target.i]!)) {
        const lines = op.newText.split("\n");
        const fixed = lines.map((l, li) => (op.insertAfter || li === 0 ? l.replace(re, "") : l));
        const dropped = lines.map((l, li) => (fixed[li] !== l ? (re.exec(l)?.[0] ?? "").trim() : "")).filter(Boolean);
        if (dropped.length > 0) {
          op.newText = fixed.join("\n");
          labelNotes.push({ index, dropped });
        }
      }
    }
    if (target && target.at >= 0) spans.push({ index, para: target.i, start: target.at, end: target.at + op.anchor.originalText.length, old: op.anchor.originalText, new: op.newText, ...(op.insertAfter || op.insertRowAfter || op.deleteRow ? { insert: true as const } : {}), ...(placement ? { placement } : {}) });
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
    let numbering: NumberingShifts | undefined;
    if (conflicts.length === 0) {
      try {
        numbering = numberingShifts(buf, sanitizeDocx(applyRevisionsToDocx(buf, { baselineHash: doc.sha256, ops: insertsFirst(ops) }).docx).docx);
      } catch (e) {
        for (const item of preview) item.ok = false;
        conflicts.push({ index: 0, reason: "apply_failed", detail: (e as Error).message.slice(0, 200) });
      }
    }
    return { status: "preview", reason: conflicts.length > 0 ? "conflicts" : "dry_run", conflicts: conflicts.sort((x, y) => x.index - y.index), preview, paragraphs, spans: spans.filter((x) => !bad.has(x.index)), ...(numbering ? { numbering } : {}), label_notes: labelNotes, ...(hfRows.length > 0 ? { header_footer_changes: hfRows } : {}) };
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
  return { status: "applied", artifact_version_id: artifactId, filename, sha256: stored.sha256, applied: ops.length, tokens_restored: tokensRestored, preview, numbering: numberingShifts(buf, sanitizeDocx(out).docx), label_notes: labelNotes, changes: [...hfRows, ...changeRows(paragraphs, labels, spans, ops, paragraphPlaces(buf, paragraphs, labels), rowTexts(buf, paragraphs))] };
}

/**
 * 修改对照（第 35 批）：按原件段落逐段给出“修改前 / 修改后”整段文字、条款编号与修改理由（原文形态，与修订稿同为真名）——
 * 律师要的“修改对照及修改说明”由内核按实际写入的修改生成，不靠助手再抄一遍全文。同一段多处修改合并成一行；段后插入单列一行。
 */
/**
 * 每段在原件里的位置，用律师的说法（第 35 批 R5 律师评分：对照表“条款”栏写成“第 21 段”这类内部段落号）：
 * 自动编号或段首手打的条款号；表格里的格子写“第 2.1 款下表格‘合计’行·金额（元）”；都没有的写段首几个字。
 */
function paragraphPlaces(docx: Buffer, paragraphs: readonly string[], labels: readonly (string | null)[]): (string | null)[] {
  const leadNo = (t: string | undefined) => /^\s*(第[一二三四五六七八九十百零〇\d]+条|\d{1,3}(?:\.\d{1,3})+)/.exec(t ?? "")?.[1] ?? null;
  const own = (i: number) => labels[i] ?? leadNo(paragraphs[i]);
  let cells: ReturnType<typeof paragraphCells> = [];
  try {
    cells = paragraphCells(readZipText(docx, "word/document.xml") ?? "");
  } catch {
    cells = [];
  }
  const snip = (t: string) => `“${[...t.trim()].slice(0, 12).join("")}${[...t.trim()].length > 12 ? "……" : ""}”一段`;
  return paragraphs.map((t, i) => {
    const c = cells[i];
    if (!c) return own(i) ?? (t.trim() ? snip(t) : null);
    const rowHead = cells.findIndex((x) => x !== null && x.table === c.table && x.row === c.row && x.col === 1);
    const rowName = rowHead >= 0 ? (paragraphs[rowHead] ?? "").trim().slice(0, 12) : "";
    const lead = c.lead !== null ? own(c.lead) : null;
    const where = `${lead ? `第 ${lead.replace(/^第|条$/g, "")} ${/条$/.test(lead) ? "条" : "款"}下` : ""}表格`;
    return `${where}${rowName && c.col > 1 ? `“${rowName}”行` : `第 ${c.row} 行`}${c.header && c.row > 1 ? `·${c.header}` : ""}`;
  });
}

/** 某段所在表格行的整行文字（各格用“｜”连接）；不在表格里返回 null。对照表写“整行删除”的修改前文字用。 */
function rowTexts(docx: Buffer, paragraphs: readonly string[]): (para: number) => string | null {
  let cells: ReturnType<typeof paragraphCells> = [];
  try {
    cells = paragraphCells(readZipText(docx, "word/document.xml") ?? "");
  } catch {
    cells = [];
  }
  return (para) => {
    const c = cells[para];
    if (!c) return null;
    const byCol = new Map<number, string[]>();
    cells.forEach((x, i) => {
      if (x && x.table === c.table && x.row === c.row) byCol.set(x.col, [...(byCol.get(x.col) ?? []), (paragraphs[i] ?? "").trim()]);
    });
    return [...byCol.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t.filter(Boolean).join(" ")).join("｜");
  };
}

/** paragraph_hint 写“页眉”“页脚”（可带“首页页眉”等字样）时改的是页眉页脚（V10 第 36 批）。 */
export function headerFooterHint(hint: unknown): "header" | "footer" | null {
  if (typeof hint !== "string") return null;
  const h = hint.trim();
  if (/^(?:首页|偶数页|奇数页|默认)?页眉$/.test(h)) return "header";
  if (/^(?:首页|偶数页|奇数页|默认)?页脚$/.test(h)) return "footer";
  return null;
}

function changeRows(paragraphs: readonly string[], labels: readonly (string | null)[], spans: readonly PatchSpan[], ops: readonly RevisionOp[], places: readonly (string | null)[] = [], rowTextOf?: (para: number) => string | null): ChangeRow[] {
  const comment = (i: number) => ops.find((o) => o.opId === `p${i}`)?.comment ?? "";
  const byPara = new Map<number, PatchSpan[]>();
  for (const sp of spans) byPara.set(sp.para, [...(byPara.get(sp.para) ?? []), sp]);
  const rows: ChangeRow[] = [];
  for (const [para, list] of [...byPara.entries()].sort((a, b) => a[0] - b[0])) {
    const before = paragraphs[para] ?? "";
    const label = labels[para] ?? null;
    const place = places[para] ?? null;
    const edits = list.filter((x) => !x.insert);
    if (edits.length > 0) {
      let after = before;
      for (const sp of [...edits].sort((a, b) => b.start - a.start)) after = after.slice(0, sp.start) + sp.new + after.slice(sp.end);
      rows.push({ para, label, place, kind: after.trim() ? "edit" : "delete", before, after, reason: [...new Set(edits.map((x) => comment(x.index)).filter(Boolean))].join("；") });
    }
    for (const sp of list.filter((x) => x.insert)) {
      // 表格上的修改（V16 第 41 批）：位置写清是整张表之后、哪一行之后，还是整行删除
      const rowPlace = (place ?? "").replace(/·[^·]*$/, "");
      if (sp.placement === "row_deleted") rows.push({ para, label, place: `${rowPlace || place || ""}（整行删除）`, kind: "delete", before: rowTextOf?.(para) ?? before, after: "", reason: comment(sp.index) });
      else if (sp.placement === "row_inserted") rows.push({ para, label, place: `${rowPlace || place || ""}（新增一行）`, kind: "insert", before, after: sp.new.replace(/\t/g, "｜"), reason: comment(sp.index), row: true });
      else if (sp.placement === "after_table") rows.push({ para, label, place: `${(place ?? "").replace(/表格.*$/, "") || label || ""}表格`, kind: "insert", before, after: sp.new, reason: comment(sp.index) });
      else rows.push({ para, label, place, kind: "insert", before, after: sp.new, reason: comment(sp.index) });
    }
  }
  return rows;
}

export interface ChangeRow {
  /** 原件段落序号。 */
  para: number;
  /** 该段的 Word 自动编号（原件编号；没有为 null）。 */
  label: string | null;
  /** 该段位置的律师说法（条款号、表格的行与列、段首几个字；第 35 批）。 */
  place?: string | null;
  kind: "edit" | "delete" | "insert";
  /** edit / delete：该段修改前的整段文字；insert：插入位置之前那一段的文字。 */
  before: string;
  /** edit：修改后的整段文字；delete：空；insert：新增的文字。 */
  after: string;
  reason: string;
  /** insert 且新增的是表格行（V16 第 41 批）：对照表写“在……行之后新增一行”。 */
  row?: boolean;
}

/**
 * 修订稿的清洁稿（第 29 批）：接受全部修订、去掉批注，登记为 revision_clean（与 docx.revise 的清洁稿同一种成果、同一函数）。
 * 审查工作台“生成修订稿”原先只出带修订痕迹的稿，律师还要自己在 Word 里“接受全部修订”才能得到干净的合同文本。
 * 修订稿与原件都不动；返回清洁稿的成果编号与文件名。
 */
export function registerCleanCopy(deps: { db: KernelDb; blobs: BlobStore }, revisionArtifactId: string, createdBy: string): { artifact_version_id: string; filename: string } {
  const { db, blobs } = deps;
  const rev = db.get<{ tenant_id: string; matter_id: string; run_id: string | null; filename: string; sha256: string; storage_uri: string; manifest: string; lineage: string | null }>(
    `SELECT tenant_id, matter_id, run_id, filename, sha256, storage_uri, manifest, lineage FROM artifact_versions WHERE artifact_version_id = ? AND kind = 'revision_draft'`,
    [revisionArtifactId],
  );
  if (!rev) throw new DomainError("not_found", "修订稿不存在", 404);
  const clean = sanitizeDocx(blobs.read(rev.storage_uri));
  const stored = blobs.put(clean.docx, rev.matter_id);
  const id = newId("artifactVersion");
  const filename = /（[^（）]*修订[^（）]*）\.docx$/i.test(rev.filename) ? rev.filename.replace(/（[^（）]*修订[^（）]*）\.docx$/i, "（清洁稿）.docx") : rev.filename.replace(/\.docx$/i, "（清洁稿）.docx");
  const source = (JSON.parse(rev.manifest || "{}") as { source_document_version_id?: string }).source_document_version_id ?? null;
  db.tx(() => {
    const v = db.get<{ next: number }>(`SELECT COALESCE(MAX(version), 0) + 1 AS next FROM artifact_versions WHERE matter_id = ? AND kind = 'revision_clean' AND audience = 'internal'`, [rev.matter_id])!;
    db.run(
      `INSERT INTO artifact_versions
        (artifact_version_id, tenant_id, matter_id, run_id, kind, version, baseline_id, audience, status, filename, sha256, storage_uri, open_items, manifest, created_by, lineage)
       VALUES (?,?,?,?,'revision_clean',?,NULL,'internal','draft',?,?,?,'[]',?,?,?)`,
      [
        id,
        rev.tenant_id,
        rev.matter_id,
        rev.run_id,
        v.next,
        filename,
        stored.sha256,
        stored.storage_uri,
        JSON.stringify({ source_document_version_id: source, derived_from: rev.sha256, accepted: clean.removed, note: "清洁稿：修订稿接受全部修订、去掉批注；原件与修订稿不变" }),
        createdBy,
        rev.lineage,
      ],
    );
  });
  return { artifact_version_id: id, filename };
}
