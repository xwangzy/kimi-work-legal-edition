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
import { escapeXml, findInParagraph, mapParagraphs, type ParagraphMap } from "./textmap.ts";
import { paragraphListLabels } from "./numbering.ts";
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
  // 自动编号（第 29 批）：条款提示（“3.2”“第五条”）也按 Word 显示的编号比对；按原件段落次序算一次（新插入的段落不参与匹配，次序不变）
  const labels = paragraphListLabels(documentXml, files.get("word/numbering.xml")?.toString("utf8") ?? null, files.get("word/styles.xml")?.toString("utf8") ?? null);

  for (const op of plan.ops) {
    xml = applyOne(xml, op, comments, () => idSeq++, applied, labels);
  }
  // 段后插入用的临时标记（同一段后的多条插入按先后接在一起；插入的新段落不参与后续锚点匹配）写完即去掉
  xml = xml.replace(/ kwl-(?:anchor|ins)="\d+"/g, "");

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
  labels: readonly (string | null)[] = [],
): string {
  if (sha256Hex(op.anchor.originalText) !== op.originalHash) {
    throw new DomainError("anchor_mismatch", `修订 ${op.opId} 原文 hash 校验失败`, 422, { opId: op.opId });
  }
  // 本次写入里新插入的段落不算候选（复核 Q2-06：补充条款里恰好含后面某张卡的锚点时不会多出一处匹配）
  const paras = mapParagraphs(xml).filter((p) => !/^<w:p\b[^>]*\skwl-ins="/.test(xml.slice(p.xmlStart, p.xmlStart + 200)));
  const shown = new Map(paras.map((p, i) => [p, labels[i] ? `${labels[i]} ${p.text}` : p.text]));
  const candidates = paras.filter((p) => findInParagraph(p, op.anchor.originalText, op.anchor.occurrence ?? 0) !== null);
  let target = candidates[0];
  if (op.anchor.paragraphHint && candidates.length > 1) {
    target = candidates.find((p) => shown.get(p)!.includes(op.anchor.paragraphHint!)) ?? target;
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
  if (op.insertAfter) return insertParagraphsAfter(xml, target, op, comments, nextId, applied);
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
  // 只标出真正改动的字（第 28 批）：锚点与新文本相同的开头、结尾照原样保留，中间一段删、一段插——
  // 律师看修订稿时不必在整句删除与整句插入之间逐字比对
  const { keepHead, removed, added, keepTail } = minimalChange(op.anchor.originalText, op.newText);
  const before = prefixText + keepHead;
  const after = keepTail + suffixText;
  if (before) parts.push(`<w:r>${rpr}<w:t xml:space="preserve">${escapeXml(before)}</w:t></w:r>`);
  if (removed) {
    parts.push(
      `<w:del w:id="${delId}" w:author="${escapeXml(author)}" w:date="${date}"><w:r>${rpr}<w:delText xml:space="preserve">${escapeXml(removed)}</w:delText></w:r></w:del>`,
    );
  }
  if (added) {
    parts.push(
      `<w:ins w:id="${insId}" w:author="${escapeXml(author)}" w:date="${date}"><w:r>${rpr}<w:t xml:space="preserve">${escapeXml(added)}</w:t></w:r></w:ins>`,
    );
  }
  if (after) parts.push(`<w:r>${rpr}<w:t xml:space="preserve">${escapeXml(after)}</w:t></w:r>`);
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

/** 段后插入：新段落沿用目标段落的段落格式（去掉分节 w:sectPr、段落标记的 w:rPr 与已有修订标记），段落标记标为插入。 */
/**
 * 原文与新文本的最小改动：去掉相同的开头与结尾，只剩中间一段删除、一段插入。按码点切分（不拆开代理对）。
 * 删除整段（新文本为空）时原样整段删除；新旧相同时不产生修订。纯函数。
 */
export function minimalChange(original: string, replacement: string): { keepHead: string; removed: string; added: string; keepTail: string } {
  const a = Array.from(original);
  const b = Array.from(replacement);
  if (b.length === 0) return { keepHead: "", removed: original, added: "", keepTail: "" };
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return {
    keepHead: a.slice(0, head).join(""),
    removed: a.slice(head, a.length - tail).join(""),
    added: b.slice(head, b.length - tail).join(""),
    keepTail: a.slice(a.length - tail).join(""),
  };
}

function insertParagraphsAfter(
  xml: string,
  target: ParagraphMap,
  op: RevisionOp,
  comments: { id: number; author: string; date: string; text: string }[],
  nextId: () => number,
  applied: AppliedRevision[],
): string {
  const lines = op.newText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) throw new DomainError("anchor_mismatch", `修订 ${op.opId} 插入的条款为空`, 422, { opId: op.opId });
  const paraXml = xml.slice(target.xmlStart, target.xmlEnd);
  const basePpr = (/<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(paraXml)?.[1] ?? "")
    .replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g, "")
    .replace(/<w:rPr>[\s\S]*?<\/w:rPr>/g, "")
    .replace(/<w:pPrChange\b[\s\S]*?<\/w:pPrChange>/g, "");
  const rpr = target.segments.find((s) => !s.deleted)?.rPr ?? "";
  const date = new Date().toISOString();
  const author = escapeXml(op.author);
  let commentId = -1;
  if (op.comment) {
    commentId = nextId();
    comments.push({ id: commentId, author: op.author, date, text: op.comment });
  }
  const paras = lines.map((line, i) => {
    const markId = nextId();
    const insId = nextId();
    const open = i === 0 && commentId >= 0 ? `<w:commentRangeStart w:id="${commentId}"/>` : "";
    const close =
      i === lines.length - 1 && commentId >= 0
        ? `<w:commentRangeEnd w:id="${commentId}"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${commentId}"/></w:r>`
        : "";
    return (
      `<w:p><w:pPr>${basePpr}<w:rPr><w:ins w:id="${markId}" w:author="${author}" w:date="${date}"/></w:rPr></w:pPr>${open}` +
      `<w:ins w:id="${insId}" w:author="${author}" w:date="${date}"><w:r>${rpr}<w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:ins>${close}</w:p>`
    );
  });
  applied.push({ opId: op.opId, status: "applied", paragraphIndex: target.index });
  // 同一段之后已经插过的（复核 Q2-04）：接在它们后面，最终顺序与写入顺序一致；目标段落打上编号，写完统一去掉
  const head = /^<w:p\b[^>]*>/.exec(paraXml)![0];
  const known = /\skwl-anchor="(\d+)"/.exec(head)?.[1];
  const k = known ?? String((xml.match(/ kwl-anchor="/g) ?? []).length + 1);
  const tagged = paras.map((p) => p.replace(/^<w:p>/, `<w:p kwl-ins="${k}">`));
  let out = known ? xml : xml.slice(0, target.xmlStart) + head.replace(/>$/, ` kwl-anchor="${k}">`) + xml.slice(target.xmlStart + head.length);
  let at = target.xmlEnd + (known ? 0 : ` kwl-anchor="${k}"`.length);
  for (;;) {
    const m = /^<w:p\b[^>]*>[\s\S]*?<\/w:p>/.exec(out.slice(at));
    if (!m || !m[0].startsWith(`<w:p kwl-ins="${k}">`)) break;
    at += m[0].length;
  }
  out = out.slice(0, at) + tagged.join("") + out.slice(at);
  return out;
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
