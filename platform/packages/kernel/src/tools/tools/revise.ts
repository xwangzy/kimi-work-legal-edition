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
import { DomainError, sha256Hex } from "@zr-legal/domain";
import { sanitizeDocx } from "@zr-legal/docx-engine";
import { applyStructuredPatches, type PatchConflict, type StructuredPatch } from "../../services/structured-patch.ts";
import type { InvokeCtx } from "../registry.ts";
import { registerToolArtifact } from "./review.ts";

export const REVISE_MAX_PATCHES = 200;

/** 逐条失败原因的改法（写给模型；律师界面不显示）。 */
const FIX_HINT: Record<PatchConflict["reason"], string> = {
  anchor_not_found: "原件里找不到这段原文：逐字照抄材料原文（同一段落之内，含标点、空格与代号；Word 自动编号不在文字里，不要抄进锚点）",
  anchor_ambiguous: "这段原文在多个段落出现：加 paragraph_hint（条款号）或 occurrence，或把锚点写长到唯一",
  anchor_not_in_view: "这段原文不在本材料的文字里：不是照抄的原文，或跨了段落（一条修改只能在一个段落之内）",
  overlap: "与另一条修改的原文重叠：合并成一条",
  unknown_token: "含有本事项不存在的代号：代号只能照抄材料里出现过的",
  anchor_empty: "anchor 不能为空；新增条款用 insert_after，锚点写插入位置前一段里的原文",
  anchor_hash_mismatch: "内部校验失败，请重新提交",
  apply_failed: "写入失败：通常是两条修改落在同一处，拆开或合并后重试",
};

interface RevisePatchInput {
  anchor?: unknown;
  proposed_text?: unknown;
  occurrence?: unknown;
  paragraph_hint?: unknown;
  comment?: unknown;
  insert_after?: unknown;
}

/**
 * 试写（dry_run）：只定位、不生成文件，返回每个改到的段落“改前 / 改后”的整段文字——Agent 写入前读一遍改后的句子
 * （第 28 批真实走查：锚点漏了“本”字，清洁稿成了“甲方应于本验收合格后三十日内”）。同一段多处修改合并成一段改后文字。
 */
function previewChanges(paragraphs: readonly string[], spans: readonly { para: number; start: number; end: number; new: string; insert?: true }[]) {
  const byPara = new Map<number, typeof spans[number][]>();
  for (const sp of spans) byPara.set(sp.para, [...(byPara.get(sp.para) ?? []), sp]);
  return [...byPara.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([para, list]) => {
      const before = paragraphs[para] ?? "";
      let after = before;
      for (const sp of list.filter((x) => !x.insert).sort((a, b) => b.start - a.start)) after = after.slice(0, sp.start) + sp.new + after.slice(sp.end);
      const inserted = list.filter((x) => x.insert).map((x) => x.new);
      return { paragraph: para, before, after, ...(inserted.length > 0 ? { inserted_after: inserted } : {}) };
    });
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
    };
  });
  const documentVersionId = String(p.document_version_id ?? "");
  const dryRun = p.dry_run === true;
  const r = applyStructuredPatches(
    { db: ctx.db, blobs: ctx.blobs, tokens: ctx.tokens },
    { matter_id: mid, document_version_id: documentVersionId, patches, created_by: run.created_by, run_id: rid, filename_suffix: "（修订稿）", ...(dryRun ? { dryRun: true } : {}) },
  );
  if (r.status === "preview" && r.reason === "dry_run") {
    return {
      status: "preview" as const,
      written: false,
      changes: previewChanges(r.paragraphs ?? [], r.spans ?? []),
      note: "这是试写，没有生成文件。逐段读 after（改后的整段）：语句通顺、与前后文衔接（没有多出或漏掉的字，例如替换“合同签订之日起”时留下的“本”）、编号与互引正确后，去掉 dry_run 把全部修改正式提交一次。",
    };
  }
  if (r.status !== "applied") {
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
  return {
    status: "applied" as const,
    applied: r.applied,
    revision: { artifact_version_id: r.artifact_version_id, filename: r.filename },
    clean: { artifact_version_id: cleanReg.artifact_version_id, filename: cleanReg.filename },
    note: "修订稿保留原件版式、编号与表格，修改以修订痕迹显示（有批注的附批注）；清洁稿已接受全部修订、去掉批注；原件不变。批注是写给律师的修改理由，发给对方前须删除批注或改用清洁稿。",
  };
}
