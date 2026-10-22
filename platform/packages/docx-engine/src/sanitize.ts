/**
 * 受众净化（§2.4/§5.4）：先生成受众版本的确切文件，再检查；
 * 清除隐藏批注、历史修订、作者属性；接受修订以定稿文本为准。
 * 注意：不得误删依法应保留的生成标识（AIGC 标识在 manifest 与文件属性保留）。
 */
import { dropHouseMark } from "./house-style.ts";
import { readZipEntries, writeZip } from "./zip.ts";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

export interface SanitizeResult {
  docx: Buffer;
  removed: { comments: number; deletionsAccepted: number; insertionsAccepted: number };
}

export function sanitizeDocx(docx: Buffer): SanitizeResult {
  const files = readZipEntries(docx);
  let xml = files.get("word/document.xml")?.toString("utf8");
  if (xml === undefined) throw new Error("DOCX 缺少 word/document.xml");

  let deletionsAccepted = 0;
  let insertionsAccepted = 0;
  // 段落标记被删（复核 Q2-15）：接受即与下一段合并（与 Word“接受全部修订”一致），不能只去掉标记把段落留下
  const merged = mergeDeletedParagraphMarks(xml);
  xml = merged.xml;
  deletionsAccepted += merged.merged;
  // 段落标记上的修订（自闭合 <w:ins …/> / <w:del …/>，在 w:pPr 的 w:rPr 里）：接受即去掉标记——必须先于成对标记处理，
  // 否则下面的成对正则会把自闭合标记当成开头、一直吞到后面别的修订的结束标记（v9.4 第 19 批：段后插入的新段落带这种标记）
  xml = xml.replace(/<w:(?:ins|del)\b[^>]*\/>/g, "");
  // 接受删除：整段 w:del 移除
  xml = xml.replace(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/g, () => {
    deletionsAccepted++;
    return "";
  });
  // 接受插入：保留内部 runs
  xml = xml.replace(/<w:ins\b[^>]*>([\s\S]*?)<\/w:ins>/g, (_m, inner) => {
    insertionsAccepted++;
    return inner as string;
  });
  // 批注引用与范围标记移除
  let comments = 0;
  xml = xml.replace(/<w:commentRangeStart\b[^>]*\/>/g, () => {
    comments++;
    return "";
  });
  xml = xml.replace(/<w:commentRangeEnd\b[^>]*\/>/g, "");
  xml = xml.replace(/<w:r\b[^>]*>(?:(?!<\/w:r>)[\s\S])*?<w:commentReference\b[^>]*\/>[\s\S]*?<\/w:r>/g, "");

  files.set("word/document.xml", Buffer.from(xml, "utf8"));
  files.set("word/comments.xml", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="${W_NS}"></w:comments>`, "utf8"));

  // 作者属性净化（保留生成标识：creator 标记为发行版，满足 AI 标识要求）
  const core = files.get("docProps/core.xml");
  if (core) {
    let c = core.toString("utf8");
    c = c.replace(/<dc:creator>[\s\S]*?<\/dc:creator>/, "<dc:creator>Kimi Work 法律行业发行版（AI 辅助起草，经律师复核）</dc:creator>");
    c = c.replace(/<cp:lastModifiedBy>[\s\S]*?<\/cp:lastModifiedBy>/, "<cp:lastModifiedBy></cp:lastModifiedBy>");
    files.set("docProps/core.xml", Buffer.from(c, "utf8"));
  }

  dropHouseMark(files);
  const out = writeZip([...files.entries()].map(([name, data]) => ({ name, data })));
  return { docx: out, removed: { comments, deletionsAccepted, insertionsAccepted } };
}

/**
 * 段落标记上的删除（<w:pPr><w:rPr><w:del …/></w:rPr></w:pPr>）表示“这个段落标记被删、与下一段合并”。
 * 接受时把这一段的文字接到下一段开头，合并后的段落用下一段的段落属性（留下来的是下一段的段落标记）；
 * 连续几段都删了标记的依次并入；后面没有紧挨着的段落时只去掉标记。表格单元格里的段落同样处理（不跨单元格合并）。
 */
export function mergeDeletedParagraphMarks(xml: string): { xml: string; merged: number } {
  const re = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
  const paras: { start: number; end: number; text: string }[] = [];
  for (let m = re.exec(xml); m; m = re.exec(xml)) paras.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  const pPrOf = (p: string) => /^<w:p\b[^>]*>\s*(<w:pPr\b[\s\S]*?<\/w:pPr>)?/.exec(p)!;
  const markDeleted = (p: string) => {
    const pPr = pPrOf(p)[1] ?? "";
    return /<w:rPr\b[^>]*>(?:(?!<\/w:rPr>)[\s\S])*<w:del\b[^>]*\/>/.test(pPr);
  };
  const body = (p: string) => p.slice(pPrOf(p)[0].length, p.length - "</w:p>".length);
  let out = "";
  let cursor = 0;
  let merged = 0;
  for (let i = 0; i < paras.length; i += 1) {
    if (!markDeleted(paras[i]!.text)) continue;
    // 连续删标记的一串段落，与其后紧挨着的那一段合并
    let j = i;
    while (j + 1 < paras.length && markDeleted(paras[j]!.text) && /^\s*$/.test(xml.slice(paras[j]!.end, paras[j + 1]!.start))) j += 1;
    // 后面没有紧挨着的段落可并入：只去掉标记（交给下面的统一处理）
    if (j === i) continue;
    const target = paras[j]!.text;
    const head = pPrOf(target)[0];
    const runs = paras.slice(i, j).map((p) => body(p.text)).join("");
    out += xml.slice(cursor, paras[i]!.start) + head + runs + target.slice(head.length);
    cursor = paras[j]!.end;
    merged += j - i;
    i = j;
  }
  out += xml.slice(cursor);
  return { xml: out, merged };
}
