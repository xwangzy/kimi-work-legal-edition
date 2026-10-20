/**
 * 修订写入：在 word/document.xml 上按锚点做定点字符串手术，写原生 w:del/w:ins 与批注。
 * 安全语义（§5.4/§6.2）：
 * - 每次写回绑定基线 hash 与原文 hash；不匹配即整体停止（原子，不写半个文件）；
 * - 锚点歧义（多处匹配且无提示）拒绝自动写入；
 * - 删除文本进 w:delText、新增进 w:ins，作者与日期如实标记（AI 建议 ≠ 律师批准）。
 */
import { dropHouseMark } from "./house-style.ts";
import { DomainError, sha256Hex } from "@zr-legal/domain";
import { readZipEntries, writeZip } from "./zip.ts";
import { escapeXml, findInParagraph, mapParagraphs } from "./textmap.ts";
import type { AppliedRevision, RevisionOp, RevisionPlan } from "./revision-ops.ts";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

export interface ApplyResult {
  docx: Buffer;
  applied: AppliedRevision[];
}

export function applyRevisionsToDocx(docx: Buffer, plan: RevisionPlan): ApplyResult {
  const baseline = sha256Hex(docx);
  if (baseline !== plan.baselineHash) {
    throw new DomainError("stale_baseline", "基线 hash 不符：文档已变化，停止写入（不静默覆盖）", 412, {
      expected: plan.baselineHash,
      actual: baseline,
    });
  }
  const files = readZipEntries(docx);
  const documentXml = files.get("word/document.xml")?.toString("utf8");
  if (documentXml === undefined) throw new DomainError("unsupported_file", "DOCX 缺少 word/document.xml", 422);

  let xml = documentXml;
  const comments: { id: number; author: string; date: string; text: string }[] = [];
  let idSeq = nextIdSeed(xml);
  const applied: AppliedRevision[] = [];

  for (const op of plan.ops) {
    xml = applyOne(xml, op, comments, () => idSeq++, applied);
  }

  if (comments.length > 0) {
    ensureCommentsInfrastructure(files);
    const existing = files.get("word/comments.xml")?.toString("utf8");
    const body = comments
      .map(
        (c) =>
          `<w:comment w:id="${c.id}" w:author="${escapeXml(c.author)}" w:date="${c.date}" w:initials="AI"><w:p><w:r><w:t xml:space="preserve">${escapeXml(c.text)}</w:t></w:r></w:p></w:comment>`,
      )
      .join("");
    const next = existing
      ? existing.replace(/<\/w:comments>/, `${body}</w:comments>`)
      : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="${W_NS}">${body}</w:comments>`;
    files.set("word/comments.xml", Buffer.from(next, "utf8"));
  }

  files.set("word/document.xml", Buffer.from(xml, "utf8"));
  dropHouseMark(files);
  const out = writeZip([...files.entries()].map(([name, data]) => ({ name, data })));
  return { docx: out, applied };
}

function applyOne(
  xml: string,
  op: RevisionOp,
  comments: { id: number; author: string; date: string; text: string }[],
  nextId: () => number,
  applied: AppliedRevision[],
): string {
  if (sha256Hex(op.anchor.originalText) !== op.originalHash) {
    throw new DomainError("anchor_mismatch", `修订 ${op.opId} 原文 hash 校验失败`, 422, { opId: op.opId });
  }
  const paras = mapParagraphs(xml);
  const candidates = paras.filter((p) => findInParagraph(p, op.anchor.originalText, op.anchor.occurrence ?? 0) !== null);
  let target = candidates[0];
  if (op.anchor.paragraphHint && candidates.length > 1) {
    target = candidates.find((p) => p.text.includes(op.anchor.paragraphHint!)) ?? target;
  }
  if (!target) {
    throw new DomainError("anchor_mismatch", `修订 ${op.opId} 锚点未找到（原文不存在或已被修改），转人工`, 422, {
      opId: op.opId,
      anchor: op.anchor.originalText.slice(0, 60),
    });
  }
  if (candidates.length > 1 && !op.anchor.paragraphHint) {
    throw new DomainError("anchor_mismatch", `修订 ${op.opId} 锚点歧义（${candidates.length} 处匹配），需 paragraphHint 或转人工`, 422, {
      opId: op.opId,
    });
  }
  const span = findInParagraph(target, op.anchor.originalText, op.anchor.occurrence ?? 0)!;
  const coverSegs = target.segments.filter((s) => !s.deleted && s.end > span.start && s.start < span.end);
  if (coverSegs.length === 0) {
    throw new DomainError("anchor_mismatch", `修订 ${op.opId} 锚点落在非文本区`, 422, { opId: op.opId });
  }
  const first = coverSegs[0]!;
  const last = coverSegs.at(-1)!;
  const rpr = first.rPr ?? "";
  const date = new Date().toISOString();
  const author = op.author;

  const delId = nextId();
  const insId = nextId();
  const prefixText = first.text.slice(0, span.start - first.start);
  const suffixText = last.text.slice(span.end - last.start);

  const parts: string[] = [];
  let commentId = -1;
  if (op.comment) {
    commentId = nextId();
    comments.push({ id: commentId, author, date, text: op.comment });
    parts.push(`<w:commentRangeStart w:id="${commentId}"/>`);
  }
  if (prefixText) parts.push(`<w:r>${rpr}<w:t xml:space="preserve">${escapeXml(prefixText)}</w:t></w:r>`);
  parts.push(
    `<w:del w:id="${delId}" w:author="${escapeXml(author)}" w:date="${date}"><w:r>${rpr}<w:delText xml:space="preserve">${escapeXml(op.anchor.originalText)}</w:delText></w:r></w:del>`,
  );
  if (op.newText) {
    parts.push(
      `<w:ins w:id="${insId}" w:author="${escapeXml(author)}" w:date="${date}"><w:r>${rpr}<w:t xml:space="preserve">${escapeXml(op.newText)}</w:t></w:r></w:ins>`,
    );
  }
  if (suffixText) parts.push(`<w:r>${rpr}<w:t xml:space="preserve">${escapeXml(suffixText)}</w:t></w:r>`);
  if (commentId >= 0) {
    parts.push(
      `<w:commentRangeEnd w:id="${commentId}"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${commentId}"/></w:r>`,
    );
  }

  // 以 run 为最小切除单位：从第一个覆盖 run 的起点切到最后一个覆盖 run 的终点，
  // 前/后缀文本用继承 rPr 的新 run 重发，避免嵌套残留（保真手术）。
  const relStart = first.runXmlStart - target.xmlStart;
  const relEnd = last.runXmlEnd - target.xmlStart;
  const paraXml = xml.slice(target.xmlStart, target.xmlEnd);
  const newParaXml = paraXml.slice(0, relStart) + parts.join("") + paraXml.slice(relEnd);
  applied.push({ opId: op.opId, status: "applied", paragraphIndex: target.index });
  return xml.slice(0, target.xmlStart) + newParaXml + xml.slice(target.xmlEnd);
}

function nextIdSeed(xml: string): number {
  let max = 0;
  for (const m of xml.matchAll(/w:id="(\d+)"/g)) {
    const v = Number(m[1]);
    if (v >= max) max = v + 1;
  }
  return max;
}

/** 确保 comments part 的关系与内容类型注册存在（幂等）。 */
function ensureCommentsInfrastructure(files: Map<string, Buffer>): void {
  const relsName = "word/_rels/document.xml.rels";
  const ctName = "[Content_Types].xml";
  const rels = files.get(relsName)?.toString("utf8") ?? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
  if (!rels.includes("comments.xml")) {
    const ids = [...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
    const nextRid = (ids.length ? Math.max(...ids) : 0) + 1;
    files.set(
      relsName,
      Buffer.from(
        rels.replace(
          "</Relationships>",
          `<Relationship Id="rId${nextRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/></Relationships>`,
        ),
        "utf8",
      ),
    );
  }
  const ct = files.get(ctName)?.toString("utf8");
  if (ct && !ct.includes("comments+xml")) {
    files.set(
      ctName,
      Buffer.from(
        ct.replace(
          "</Types>",
          `<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>`,
        ),
        "utf8",
      ),
    );
  }
}
