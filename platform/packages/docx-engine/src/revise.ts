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
import { childElements, escapeXml, findElement, findInParagraph, mapParagraph, mapParagraphs, paragraphCells, removeElements, splitParagraphRuns, type ParagraphMap, type TextSegment } from "./textmap.ts";
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
  // 修订与批注的 id 在整份文件里取号（第 34 批 D15：原先只看 document.xml，和已有批注、脚注里的修订撞号）
  let idSeq = nextIdSeed([...files.entries()].filter(([n]) => /^word\/[^/]+\.xml$/.test(n)).map(([, d]) => d.toString("utf8")).join(""));
  const applied: AppliedRevision[] = [];
  // 自动编号（第 29 批）：条款提示（“3.2”“第五条”）也按 Word 显示的编号比对；按原件段落次序算一次（新插入的段落不参与匹配，次序不变）
  const labels = paragraphListLabels(documentXml, files.get("word/numbering.xml")?.toString("utf8") ?? null, files.get("word/styles.xml")?.toString("utf8") ?? null);

  for (const op of plan.ops) {
    xml = applyOne(xml, op, comments, () => idSeq++, applied, labels);
  }
  // 段后插入用的临时标记（同一段后的多条插入按先后接在一起；插入的新段落不参与后续锚点匹配）写完即去掉
  // 接着对方插入时重开的标签后面没有字的，整个去掉（不留空的对方插入）
  xml = xml.replace(/<w:ins\b[^>]*\skwl-reopen="1"[^>]*><\/w:ins>/g, "");
  xml = xml.replace(/ kwl-(?:anchor|ins|new|reopen)="\d+"/g, "");
  // 结构自检（第 34 批，文档工程压测 D01～D05）：写坏了就整体停止、原件不动，不交一份打不开的文件
  assertWellFormed(xml, "word/document.xml");

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
    assertWellFormed(next, "word/comments.xml");
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
  const all = mapParagraphs(xml);
  const paras = all.filter((p) => !/^<w:p\b[^>]*\skwl-ins="/.test(xml.slice(p.xmlStart, p.xmlStart + 200)));
  // 原件段落序号（去掉本次新插入的段落后的次序，与自动编号 labels 对齐）
  const origIndex = new Map(paras.map((p, i) => [p, i]));
  const candidates = paras.filter((p) => findInParagraph(p, op.anchor.originalText, op.anchor.occurrence ?? 0) !== null);
  let target = candidates[0];
  if (candidates.length > 1) {
    // 多处匹配：没有条款提示、或提示对不上 / 仍有多处时都按歧义拒写（第 34 批 D10：原先提示对不上时静默改第一处）
    // 表格里的格子按所在行认提示（“首期”那一行的“无”）：材料视图里表格按行写成“| 首期 | 无 |”
    const cells = op.anchor.paragraphHint ? paragraphCells(xml) : [];
    const rowText = (p: ParagraphMap): string => {
      const c = cells[p.index];
      return c ? all.filter((q) => cells[q.index]?.table === c.table && cells[q.index]?.row === c.row).map((q) => q.text).join(" | ") : "";
    };
    // 列名：该列首行的文字（同一行里两格金额相同，如“应还利息”与“本期合计”都是 75,000.00，靠列名区分；第 34 批 T3 真实走查）
    const colText = (p: ParagraphMap): string => cells[p.index]?.header ?? "";
    const picked = op.anchor.paragraphHint ? pickByHint(candidates.map((p) => ({ label: labels[origIndex.get(p)!] ?? null, text: p.text, row: rowText(p), col: colText(p) })), op.anchor.paragraphHint) : null;
    if (picked === null) {
      throw new DomainError(
        "anchor_mismatch",
        op.anchor.paragraphHint
          ? `修订 ${op.opId} 锚点歧义（${candidates.length} 处匹配），条款提示“${op.anchor.paragraphHint.slice(0, 20)}”对不上其中唯一一处，需改提示或转人工`
          : `修订 ${op.opId} 锚点歧义（${candidates.length} 处匹配），需 paragraphHint 或转人工`,
        422,
        { opId: op.opId },
      );
    }
    target = candidates[picked];
  }
  if (!target) {
    throw new DomainError("anchor_mismatch", `修订 ${op.opId} 锚点未找到（原文不存在或已被修改），转人工`, 422, {
      opId: op.opId,
      anchor: op.anchor.originalText.slice(0, 60),
    });
  }
  const paragraphIndex = origIndex.get(target)!;
  if (op.insertAfter) return insertParagraphsAfter(xml, target, op, comments, nextId, applied, paragraphIndex);
  // 一个 run 里有几段文字、制表符、换行的（Word 常这样写签署栏、地址栏），先按内容拆成一段一个 run 再切（第 34 批 D07：
  // 原先只认第一段文字，改前半段会把后半段静默删掉）；只拆要改的这一段，其余段落字节不动
  const lenBefore = xml.length;
  xml = splitParagraphRuns(xml, target, nextId);
  target = mapParagraph(xml.slice(target.xmlStart, target.xmlEnd + xml.length - lenBefore), target.xmlStart, target.index);
  const span = findInParagraph(target, op.anchor.originalText, op.anchor.occurrence ?? 0)!;
  const coverSegs = target.segments.filter((s) => !s.deleted && !s.fresh && s.end > span.start && s.start < span.end);
  if (coverSegs.length === 0) {
    throw new DomainError("anchor_mismatch", `修订 ${op.opId} 锚点落在非文本区`, 422, { opId: op.opId });
  }
  const first = coverSegs[0]!;
  const last = coverSegs.at(-1)!;
  const date = new Date().toISOString();
  const author = op.author;
  const paraXml = xml.slice(target.xmlStart, target.xmlEnd);
  const relStart = first.runXmlStart - target.xmlStart;
  const relEnd = last.runXmlEnd - target.xmlStart;
  const region = paraXml.slice(relStart, relEnd);
  const { preserved, foreignIns } = checkRegion(op.opId, paraXml, relStart, region);

  // 只标出真正改动的字（第 28 批）：锚点与新文本相同的开头、结尾照原样保留，中间一段删、一段插。
  // 第 34 批 D08：每个原 run 按自己的格式重发（原先没改的字一律套第一个 run 的格式，下划线、楷体、字号会丢）
  const { keepHead, removed, added, keepTail } = minimalChange(op.anchor.originalText, op.newText);
  const r0 = span.start + keepHead.length;
  const r1 = span.end - keepTail.length;
  type Atom = { kind: "keep" | "del"; seg: TextSegment; text: string };
  const atoms: Atom[] = [];
  for (const seg of target.segments) {
    if (seg.runXmlStart < first.runXmlStart || seg.runXmlEnd > last.runXmlEnd || seg.deleted || seg.fresh) continue;
    const cut = (a: number, b: number, kind: Atom["kind"]) => {
      if (b > a) atoms.push({ kind, seg, text: seg.text.slice(a - seg.start, b - seg.start) });
    };
    cut(seg.start, Math.min(seg.end, r0), "keep");
    cut(Math.max(seg.start, r0), Math.min(seg.end, r1), "del");
    cut(Math.max(seg.start, r1), seg.end, "keep");
  }
  const changed = removed.length > 0 || added.length > 0;
  // 插入的新字接在删除的字之后；格式取改动开始处那个 run 的（纯插入取前一个字的）
  const firstDel = atoms.findIndex((x) => x.kind === "del");
  const insPos = firstDel >= 0 ? atoms.findLastIndex((x) => x.kind === "del") + 1 : insertionIndex(atoms, r0, first.start);
  const insRpr = cleanRpr((firstDel >= 0 ? atoms[firstDel]! : (atoms[Math.max(0, insPos - 1)] ?? atoms[0]!)).seg.rPr);
  const delId = nextId();
  const insId = nextId();
  let commentId = -1;
  if (op.comment) {
    commentId = nextId();
    comments.push({ id: commentId, author, date, text: op.comment });
  }
  const parts: string[] = [];
  let delOpen = false;
  const closeDel = () => {
    if (delOpen) parts.push("</w:del>");
    delOpen = false;
  };
  const changeStart = firstDel >= 0 ? firstDel : insPos;
  for (let i = 0; i <= atoms.length; i++) {
    if (i === changeStart && commentId >= 0 && changed) parts.push(`<w:commentRangeStart w:id="${commentId}"/>`);
    if (i === insPos && added) {
      closeDel();
      const ours = `<w:ins w:id="${insId}" w:author="${escapeXml(author)}" w:date="${date}" kwl-new="1"><w:r>${insRpr}${runContent(added)}</w:r></w:ins>`;
      // 在对方的插入里：先收起对方的插入，我方插入放在外面，再用新编号接着对方的插入（ins 里不能再套 ins）
      parts.push(foreignIns ? `</w:ins>${ours}${foreignIns.replace(/\bw:id="\d+"/, `w:id="${nextId()}"`).replace(/>$/, ' kwl-reopen="1">')}` : ours);
      if (commentId >= 0) parts.push(commentEnd(commentId));
    }
    const x = atoms[i];
    if (!x) break;
    // 原有的字（保留的、删除的）照原格式重发，连同对方的格式修订记录（换新编号，切开的几段不重号）；新插入的字才去掉
    const rpr = freshChangeIds(x.seg.rPr ?? "", nextId);
    const body = x.seg.kind === "text" ? `<w:${x.kind === "del" ? "delText" : "t"} xml:space="preserve">${escapeXml(x.text)}</w:${x.kind === "del" ? "delText" : "t"}>` : xml.slice(x.seg.xmlStart, x.seg.xmlEnd);
    if (x.kind === "del") {
      if (!delOpen) parts.push(`<w:del w:id="${delId}" w:author="${escapeXml(author)}" w:date="${date}" kwl-new="1">`);
      delOpen = true;
      parts.push(`<w:r>${rpr}${body}</w:r>`);
      if (!atoms[i + 1] || atoms[i + 1]!.kind !== "del") {
        closeDel();
        if (!added && commentId >= 0) parts.push(commentEnd(commentId));
      }
    } else parts.push(`<w:r>${rpr}${body}</w:r>`);
  }
  closeDel();
  if (!changed && commentId >= 0) parts.push(`<w:commentRangeStart w:id="${commentId}"/>${commentEnd(commentId)}`);
  // 切除范围里原有的书签、批注范围等标记照原样放回（第 34 批 D06：原先随 run 一起被静默删掉）
  parts.push(...preserved);

  let newParaXml = paraXml.slice(0, relStart) + parts.join("") + paraXml.slice(relEnd);
  // 整段删除（第 31 批）：段落的可见文字全部删掉时，段落标记也标为删除——接受修订后整段消失（清洁稿同一处理，见 sanitize），
  // 不留空行；自动编号的条款不再剩一个空的“5.3”、后面的编号也随之顺延。分节符所在的段落不动段落标记（会并掉分节）。
  const remaining = target.text.slice(0, span.start) + target.text.slice(span.end);
  if (!op.newText && remaining.trim() === "") newParaXml = markParagraphDeleted(newParaXml, nextId(), escapeXml(author), date);
  applied.push({ opId: op.opId, status: "applied", paragraphIndex });
  return xml.slice(0, target.xmlStart) + newParaXml + xml.slice(target.xmlEnd);
}

function commentEnd(id: number): string {
  return `<w:commentRangeEnd w:id="${id}"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${id}"/></w:r>`;
}

/** 纯插入（没有删除的字）时新字的位置：第一个起点不早于插入点的保留片段之前。 */
function insertionIndex(atoms: readonly { seg: TextSegment; text: string }[], r0: number, base: number): number {
  let pos = base;
  for (let i = 0; i < atoms.length; i++) {
    if (pos >= r0) return i;
    pos += atoms[i]!.text.length;
  }
  return atoms.length;
}

/** 复制的格式里的格式修订记录（w:rPrChange）换新编号：同一记录写进几个 run 时编号不重复。 */
function freshChangeIds(rPr: string, nextId: () => number): string {
  return rPr.replace(/(<w:rPrChange\b[^>]*?\bw:id=")\d+(")/g, (_m, a: string, b: string) => `${a}${nextId()}${b}`);
}

/** 新 run 用的格式：去掉他人的格式修订记录（w:rPrChange），不把对方的修订复制到本次的修改上（第 34 批 D03）。 */
function cleanRpr(rPr: string | null): string {
  return rPr ? removeElements(rPr, ["w:rPrChange"]) : "";
}

/** 新文字写成 run 内容：换行写成 w:br、制表符写成 w:tab（第 34 批 D19：原先写成 w:t 里的字面换行，Word 里不分行）。 */
function runContent(text: string): string {
  return text
    .split(/(\r?\n|\t)/)
    .map((piece) => (piece === "\t" ? "<w:tab/>" : /^\r?\n$/.test(piece) ? "<w:br/>" : piece ? `<w:t xml:space="preserve">${escapeXml(piece)}</w:t>` : ""))
    .join("");
}

/** 切除范围里可以照原样放回的标记（书签、批注范围、权限范围）；拼写标记直接去掉。 */
const MARKERS = new Set(["w:bookmarkStart", "w:bookmarkEnd", "w:commentRangeStart", "w:commentRangeEnd", "w:permStart", "w:permEnd"]);
/** run 里可以当文字处理的内容；lastRenderedPageBreak 只是排版缓存，可以去掉。 */
const RUN_TEXT_CHILDREN = new Set(["w:rPr", "w:t", "w:tab", "w:ptab", "w:br", "w:cr", "w:lastRenderedPageBreak"]);
/** 不能切开的容器：他人修订、超链接、内容控件、智能标记、简单域等（第 34 批 D01、D09、D13、D17）。 */
const CONTAINERS = /<(\/?)w:(ins|del|moveFrom|moveTo|hyperlink|sdt|sdtContent|smartTag|customXml|fldSimple|txbxContent)\b([^>]*?)(\/?)>/g;

/**
 * 切除范围的检查：范围必须只由 run 和可放回的标记组成；不能落在他人修订或域里、不能跨过容器的边界；run 里不能有脚注引用、
 * 域代码、图片等（切掉就丢了）。不成立时拒写并说明改法。返回要放回的标记。
 */
function checkRegion(opId: string, paraXml: string, relStart: number, region: string): { preserved: string[]; foreignIns: string | null } {
  const refuse = (why: string): never => {
    throw new DomainError("anchor_mismatch", `修订 ${opId} ${why}`, 422, { opId });
  };
  // 起点所在的容器
  const stack: { name: string; fresh: boolean; tag: string }[] = [];
  CONTAINERS.lastIndex = 0;
  for (const m of paraXml.matchAll(CONTAINERS)) {
    if (m.index! >= relStart) break;
    if (m[4] === "/") continue;
    if (m[1]) stack.pop();
    else stack.push({ name: m[2]!, fresh: /\skwl-new="/.test(m[3] ?? ""), tag: m[0] });
  }
  // 整段落在对方的一处插入之内（对方加的字我方再改，如“不接受对方把连带责任保证改成一般保证”）：照 Word 的写法，
  // 删除嵌在对方的插入里、我方插入放在对方插入之外——接受全部得到我方文字，拒绝全部回到原件（第 34 批，T3 第 6 条意见）
  let foreignIns: string | null = null;
  for (const c of stack) {
    if (c.fresh) refuse("与本次另一处修改落在同一处：合并成一条修改");
    if (c.name === "ins" && !foreignIns && stack.filter((x) => x.name === "ins").length === 1) {
      foreignIns = c.tag;
      continue;
    }
    if (c.name === "ins" || c.name === "del" || c.name === "moveFrom" || c.name === "moveTo") refuse("锚点在原件已有的修订痕迹里（对方的插入或删除）：自动改写会打乱对方的修订记录，请先在 Word 里接受或拒绝对方的修订，或手工修改这一处");
    if (c.name === "fldSimple") refuse("锚点在 Word 域（自动日期、页码、交叉引用等）的结果里：域更新后修改会失效，请手工修改");
  }
  for (const m of region.matchAll(CONTAINERS)) {
    if (m[4] === "/") continue;
    if (/\skwl-new="/.test(m[3] ?? "")) refuse("与本次另一处修改落在同一处：合并成一条修改");
    if (m[2] === "ins" || m[2] === "del" || m[2] === "moveFrom" || m[2] === "moveTo") refuse("锚点跨过了原件已有的修订痕迹（对方的插入或删除）：把锚点缩到修订痕迹之外，或先在 Word 里处理对方的修订");
    refuse("锚点跨过了超链接、内容控件或域的边界：把锚点缩到其中一侧的纯文字");
  }
  const preserved: string[] = [];
  for (const c of childElements(region)) {
    const el = region.slice(c.start, c.end);
    if (c.name === "w:r") {
      const open = /^<w:r\b[^>]*>/.exec(el)?.[0];
      if (!open || el.endsWith("/>")) continue;
      const kids = childElements(el.slice(open.length, el.length - "</w:r>".length));
      if (kids.some((k) => k.name === "w:commentReference")) {
        preserved.push(el);
        continue;
      }
      if (kids.some((k) => !RUN_TEXT_CHILDREN.has(k.name))) refuse("锚点范围里有脚注引用、域代码、图片或特殊符号：切开会丢失，把锚点缩小到纯文字部分，或手工修改");
      continue;
    }
    if (MARKERS.has(c.name)) preserved.push(el);
    else if (c.name !== "w:proofErr") refuse("锚点范围里有无法自动改写的内容（如公式或嵌入对象）：把锚点缩小到纯文字部分，或手工修改");
  }
  return { preserved, foreignIns };
}

/**
 * 条款提示定位（第 34 批 D10）：多处匹配时按提示挑一处——先比自动编号（“3.2”“第五条”），再比段首（段首是“3.2”不算“3.2.1”），
 * 最后比段内；同一档里不止一处、或哪一档都对不上时返回 null（按歧义处理，不再默认改第一处）。纯函数。
 */
export function pickByHint(cands: readonly { label: string | null; text: string; row?: string; col?: string }[], hint: string): number | null {
  const norm = (s: string) => s.replace(/\s+/g, "").replace(/[.、．:：）)]+$/, "");
  const h = norm(hint);
  if (!h) return null;
  // “行名｜列名”（“第 2 期｜应还本金”）：每一段都要出现在该格所在行或该列表头里（去空白比较）
  const parts = hint.split(/[｜|/／,，、;；]+/).map((x) => x.replace(/\s+/g, "")).filter(Boolean);
  const tiers: ((c: { label: string | null; text: string; row?: string; col?: string }) => boolean)[] = [
    (c) => c.label !== null && norm(c.label) === h,
    (c) => {
      const t = `${c.label ?? ""}${c.text}`.replace(/\s+/g, "");
      return t.startsWith(h) && !/^[.．]?\d/.test(t.slice(h.length));
    },
    (c) => `${c.label ?? ""} ${c.text}`.includes(hint),
    // 表格格子：提示写的是同一行别的格子（行首的项目名、期次）
    (c) => !!c.row && c.row.includes(hint),
    (c) => parts.length >= 2 && !!c.row && parts.every((x) => `${c.row}${c.col ?? ""}`.replace(/\s+/g, "").includes(x)),
  ];
  for (const tier of tiers) {
    const hits = cands.map((c, i) => (tier(c) ? i : -1)).filter((i) => i >= 0);
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) return null;
  }
  return null;
}

/** XML 结构自检：标签逐一配对（忽略声明、注释、CDATA）。不成立抛错——整体停止写入、原件不动。 */
export function assertWellFormed(xml: string, part: string): void {
  const stack: string[] = [];
  const body = xml.replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  for (const m of body.matchAll(/<(\/?)([A-Za-z_][\w.:-]*)\b[^>]*?(\/?)>/g)) {
    if (m[3] === "/") continue;
    if (!m[1]) {
      stack.push(m[2]!);
      continue;
    }
    if (stack.pop() !== m[2]) {
      throw new DomainError("unsupported_file", `写入后 ${part} 的结构不完整（原件里有修订痕迹、文本框或域等复杂结构），已停止写入、原件未改；请手工修改这几处`, 422, { part });
    }
  }
  if (stack.length > 0) throw new DomainError("unsupported_file", `写入后 ${part} 的结构不完整，已停止写入、原件未改；请手工修改这几处`, 422, { part });
}

/** 在段落的 w:pPr/w:rPr 里加段落标记删除（<w:del …/>）；没有 pPr / rPr 的补上；带分节符（w:sectPr）的段落原样返回。纯函数。 */
export function markParagraphDeleted(paraXml: string, id: number, author: string, date: string): string {
  const mark = `<w:del w:id="${id}" w:author="${author}" w:date="${date}"/>`;
  const open = /^<w:p\b[^>]*>/.exec(paraXml)![0];
  const pPr = /^<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>/.exec(paraXml.slice(open.length))?.[0];
  if (!pPr) return `${open}<w:pPr><w:rPr>${mark}</w:rPr></w:pPr>${paraXml.slice(open.length)}`;
  // 带分节符的不动；已有段落格式修订（w:pPrChange 里嵌着旧的 w:pPr）的也不动，免得把嵌套结构切坏
  if (/<w:sectPr\b|<w:pPrChange\b/.test(paraXml)) return paraXml;
  // w:pPr 里 w:rPr 之后只能是 w:sectPr / w:pPrChange：有 rPr 的加在 rPr 里，没有的加在这两者之前（或末尾）
  const rPr = /<w:rPr\b[^>]*>[\s\S]*?<\/w:rPr>|<w:rPr\b[^>]*\/>/.exec(pPr);
  let next: string;
  if (rPr) next = pPr.replace(rPr[0], rPr[0].endsWith("/>") ? `<w:rPr>${mark}</w:rPr>` : rPr[0].replace(/<\/w:rPr>$/, `${mark}</w:rPr>`));
  else {
    const at = pPr.search(/<w:pPrChange\b|<\/w:pPr>$/);
    next = `${pPr.slice(0, at)}<w:rPr>${mark}</w:rPr>${pPr.slice(at)}`;
  }
  return open + next + paraXml.slice(open.length + pPr.length);
}

/** 段后插入：新段落沿用目标段落的段落格式（去掉分节 w:sectPr、段落标记的 w:rPr 与已有修订标记），段落标记标为插入。 */
/**
 * 原文与新文本的最小改动：去掉相同的开头与结尾，只剩中间一段删除、一段插入。按码点切分（不拆开代理对）。
 * 删除整段（新文本为空）时原样整段删除；新旧相同时不产生修订。纯函数。
 */
/** 数字、金额与中文大写数字的用字（最小改动不在它们中间切开）。 */
const NUMERIC = /[0-9０-９.,，．%％零〇壹贰叁肆伍陆柒捌玖拾佰仟萬]/;

export function minimalChange(original: string, replacement: string): { keepHead: string; removed: string; added: string; keepTail: string } {
  const a = Array.from(original);
  const b = Array.from(replacement);
  if (b.length === 0) return { keepHead: "", removed: original, added: "", keepTail: "" };
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  // 不在数字中间切开（第 34 批律师验收：13.50 改 14.20 显示成“1[-3.5-][+4.2+]0”，金额、日期被切成碎片，对方核对容易看错）：
  // 边界两侧都是数字、金额或中文大写数字的字时，退到整个数字的边界
  const numAt = (xs: string[], i: number) => i >= 0 && i < xs.length && NUMERIC.test(xs[i]!);
  while (head > 0 && numAt(a, head - 1) && (numAt(a, head) || numAt(b, head))) head--;
  while (tail > 0 && numAt(a, a.length - tail) && (numAt(a, a.length - tail - 1) || numAt(b, b.length - tail - 1))) tail--;
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
  paragraphIndex: number,
): string {
  const lines = op.newText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) throw new DomainError("anchor_mismatch", `修订 ${op.opId} 插入的条款为空`, 422, { opId: op.opId });
  const paraXml = xml.slice(target.xmlStart, target.xmlEnd);
  // 段落格式按配对标签取全（第 34 批 D04：段落带他人格式修订 w:pPrChange 时，原先只取到半截、写坏文件）
  const pPrEl = findElement(paraXml, "w:pPr");
  const pPrXml = pPrEl && /^<w:p\b[^>]*>\s*$/.test(paraXml.slice(0, pPrEl.start)) ? paraXml.slice(pPrEl.start, pPrEl.end) : "";
  const basePpr = pPrXml.endsWith("/>") || !pPrXml ? "" : removeElements(pPrXml.slice(pPrXml.indexOf(">") + 1, pPrXml.length - "</w:pPr>".length), ["w:sectPr", "w:rPr", "w:pPrChange"]);
  const rpr = cleanRpr(target.segments.find((s) => !s.deleted && !s.fresh)?.rPr ?? null);
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
      `<w:ins w:id="${insId}" w:author="${author}" w:date="${date}" kwl-new="1"><w:r>${rpr}${runContent(line)}</w:r></w:ins>${close}</w:p>`
    );
  });
  applied.push({ opId: op.opId, status: "applied", paragraphIndex });
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

/**
 * 原件里已有的修订痕迹（第 34 批）：插入、删除、移动与格式修订的处数（只计数，不返回署名）。
 * 修订稿保留它们；清洁稿“接受全部修订”会把它们与本次修改一并接受——助手须告诉律师。
 */
export function existingRevisions(docx: Buffer): { insertions: number; deletions: number; moves: number; format_changes: number; total: number } {
  const xml = readZipEntries(docx).get("word/document.xml")?.toString("utf8") ?? "";
  const count = (re: RegExp) => (xml.match(re) ?? []).length;
  const insertions = count(/<w:ins\b[^>]*[^/]>/g);
  const deletions = count(/<w:del\b[^>]*[^/]>/g);
  const moves = count(/<w:moveTo\b[^>]*[^/]>/g);
  const format_changes = count(/<w:(?:rPrChange|pPrChange)\b/g);
  return { insertions, deletions, moves, format_changes, total: insertions + deletions + moves + format_changes };
}
