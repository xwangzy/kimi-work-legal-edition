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
