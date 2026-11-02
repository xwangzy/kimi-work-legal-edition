/**
 * 受众净化（§2.4/§5.4）：先生成受众版本的确切文件，再检查；
 * 清除隐藏批注、历史修订、作者属性；接受修订以定稿文本为准。
 * 注意：不得误删依法应保留的生成标识（AIGC 标识在 manifest 与文件属性保留）。
 */
import { dropHouseMark } from "./house-style.ts";
import { readZipEntries, writeZip } from "./zip.ts";
import { findElement, paragraphSpans, removeElements } from "./textmap.ts";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

export interface SanitizeResult {
  docx: Buffer;
  removed: { comments: number; deletionsAccepted: number; insertionsAccepted: number };
}

export function sanitizeDocx(docx: Buffer): SanitizeResult {
  const files = readZipEntries(docx);
  let xml = files.get("word/document.xml")?.toString("utf8");
  if (xml === undefined) throw new Error("DOCX 缺少 word/document.xml");

  const counts = { deletionsAccepted: 0, insertionsAccepted: 0, comments: 0 };
  files.set("word/document.xml", Buffer.from(acceptAll(xml, counts), "utf8"));
  // 脚注、尾注、页眉页脚里的修订与批注同样接受、去掉（第 34 批 D12：原先只处理正文，清洁稿脚注里还留着修订和悬空的批注引用）
  for (const [name, data] of files) {
    if (/^word\/(?:footnotes|endnotes|header\d*|footer\d*)\.xml$/.test(name)) files.set(name, Buffer.from(acceptAll(data.toString("utf8"), counts), "utf8"));
  }
  const { deletionsAccepted, insertionsAccepted, comments } = counts;
  files.set("word/comments.xml", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="${W_NS}"></w:comments>`, "utf8"));

  // 作者属性净化（保留生成标识：creator 标记为发行版，满足 AI 标识要求）
  const core = files.get("docProps/core.xml");
  if (core) {
    let c = core.toString("utf8");
    c = c.replace(/<dc:creator>[\s\S]*?<\/dc:creator>/, "<dc:creator>Kimi Work 法律行业发行版（AI 辅助生成，须经律师复核）</dc:creator>");
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
  // 与 mapParagraphs 同一切分（第 34 批 D05）；自闭合空段落展开成一对标签，才能把前一段的文字接进来
  const paras = paragraphSpans(xml).map((sp) => {
    const raw = xml.slice(sp.start, sp.end);
    return { start: sp.start, end: sp.end, text: raw.endsWith("/>") ? raw.replace(/\s*\/>$/, "></w:p>") : raw };
  });
  // 段落格式按配对标签取（含他人格式修订 w:pPrChange 时不截半）
  const pPrOf = (p: string): [string, string | undefined] => {
    const open = /^<w:p\b[^>]*>/.exec(p)![0];
    const e = findElement(p, "w:pPr");
    return e && /^\s*$/.test(p.slice(open.length, e.start)) ? [p.slice(0, e.end), p.slice(e.start, e.end)] : [open, undefined];
  };
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

/** 接受一个部件里的全部修订、去掉批注标记（第 34 批：移动修订、格式修订记录也处理——D12）。计数累加到 counts。 */
function acceptAll(input: string, counts: { deletionsAccepted: number; insertionsAccepted: number; comments: number }): string {
  let xml = input;
  // 段落标记被删（复核 Q2-15）：接受即与下一段合并（与 Word“接受全部修订”一致），不能只去掉标记把段落留下
  const merged = mergeDeletedParagraphMarks(xml);
  xml = merged.xml;
  counts.deletionsAccepted += merged.merged;
  // 段落标记上的修订（自闭合 <w:ins …/> / <w:del …/>，在 w:pPr 的 w:rPr 里）：接受即去掉标记——必须先于成对标记处理，
  // 否则下面的成对正则会把自闭合标记当成开头、一直吞到后面别的修订的结束标记（v9.4 第 19 批：段后插入的新段落带这种标记）
  xml = xml.replace(/<w:(?:ins|del|moveFrom|moveTo)\b[^>]*\/>/g, "");
  // 移动修订的范围标记、格式修订记录：接受即去掉（格式按修订后的生效；w:rPrChange 等里面嵌的是修订前的格式）
  xml = xml.replace(/<w:(?:moveFromRangeStart|moveFromRangeEnd|moveToRangeStart|moveToRangeEnd)\b[^>]*\/>/g, "");
  xml = removeElements(xml, ["w:rPrChange", "w:pPrChange", "w:sectPrChange", "w:tblPrChange", "w:tblPrExChange", "w:trPrChange", "w:tcPrChange", "w:tblGridChange", "w:numberingChange"]);
  // 接受删除：整段 w:del / w:moveFrom（移动的原位置）移除
  xml = xml.replace(/<w:(del|moveFrom)\b[^>]*>[\s\S]*?<\/w:\1>/g, () => {
    counts.deletionsAccepted++;
    return "";
  });
  // 接受插入：保留内部 runs（w:moveTo 是移动的新位置，同样保留）；嵌套的由内向外逐层展开
  for (let prev = ""; prev !== xml; ) {
    prev = xml;
    xml = xml.replace(/<w:(ins|moveTo)\b[^>]*>((?:(?!<w:(?:ins|moveTo)\b)[\s\S])*?)<\/w:\1>/g, (_m, _n, inner) => {
      counts.insertionsAccepted++;
      return inner as string;
    });
  }
  // 批注引用与范围标记移除
  xml = xml.replace(/<w:commentRangeStart\b[^>]*\/>/g, () => {
    counts.comments++;
    return "";
  });
  xml = xml.replace(/<w:commentRangeEnd\b[^>]*\/>/g, "");
  xml = xml.replace(/<w:r\b[^>]*>(?:(?!<\/w:r>)[\s\S])*?<w:commentReference\b[^>]*\/>[\s\S]*?<\/w:r>/g, "");
  return xml;
}
