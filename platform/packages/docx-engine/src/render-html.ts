/**
 * Office 成果的应用内预览（UIUX P0-3：律师在应用里看 DOCX/XLSX，不必下载到 Word）：
 * DOCX → 段落、标题、表格、原生修订（插入 <ins>、删除 <del>，带作者）与批注（文末列出，正文以上标编号标出位置）；
 * XLSX → 每个工作表一张表格（前 500 行、40 列）。
 *
 * 输出只含白名单元素（p、h1–h3、table/tr/td/th、ins、del、sup、ol/li、section、strong、em、span），不带任何属性以外的链接与外部资源；
 * 文字一律 HTML 转义。界面再经隔离框架（sandbox="" + CSP）渲染，代号在隔离框架里按事项令牌表还原。
 */
import { readZipEntries } from "./zip.ts";
import { unescapeXml } from "./textmap.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const PREVIEW_LIMITS = { maxParagraphs: 5_000, maxRows: 500, maxCols: 40, maxSheets: 10 } as const;

interface Comment {
  id: string;
  author: string;
  text: string;
}

function commentsOf(files: Map<string, Buffer>): Map<string, Comment> {
  const xml = files.get("word/comments.xml")?.toString("utf8");
  const out = new Map<string, Comment>();
  if (!xml) return out;
  for (const m of xml.matchAll(/<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g)) {
    const id = /w:id="([^"]*)"/.exec(m[1]!)?.[1] ?? "";
    const author = unescapeXml(/w:author="([^"]*)"/.exec(m[1]!)?.[1] ?? "");
    const text = [...m[2]!.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((t) => unescapeXml(t[1]!)).join("");
    out.set(id, { id, author, text });
  }
  return out;
}

/** 段落内联内容 → HTML（按标签顺序扫描：插入/删除包裹、文字、制表、换行、批注引用）。 */
function inlineHtml(pXml: string, commentNo: Map<string, number>): { html: string; text: string } {
  let html = "";
  let text = "";
  const stack: ("ins" | "del")[] = [];
  const TAG = /<(\/?)(w:ins|w:del|w:r|w:t|w:delText|w:tab|w:br|w:commentReference|w:b|w:i)\b([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  let bold = false;
  let italic = false;
  while ((m = TAG.exec(pXml))) {
    const [, close, name, attrs, selfClose] = m;
    if (name === "w:ins" || name === "w:del") {
      const tag = name === "w:ins" ? "ins" : "del";
      if (close) {
        if (stack[stack.length - 1] === tag) {
          stack.pop();
          html += `</${tag}>`;
        }
      } else if (!selfClose) {
        const author = unescapeXml(/w:author="([^"]*)"/.exec(attrs!)?.[1] ?? "");
        stack.push(tag);
        html += `<${tag} title="${esc(author)}">`;
      }
      continue;
    }
    if (name === "w:r" && !close) {
      // 每个 run 开头复位粗斜体（格式在 run 的 w:rPr 里）
      bold = false;
      italic = false;
      continue;
    }
    if (name === "w:b" && !close) {
      bold = !/w:val="(?:0|false)"/.test(attrs!);
      continue;
    }
    if (name === "w:i" && !close) {
      italic = !/w:val="(?:0|false)"/.test(attrs!);
      continue;
    }
    if ((name === "w:t" || name === "w:delText") && !close && !selfClose) {
      const end = pXml.indexOf(`</${name}>`, TAG.lastIndex);
      if (end < 0) continue;
      const t = unescapeXml(pXml.slice(TAG.lastIndex, end));
      TAG.lastIndex = end + name.length + 3;
      let piece = esc(t);
      if (bold) piece = `<strong>${piece}</strong>`;
      if (italic) piece = `<em>${piece}</em>`;
      html += piece;
      if (name === "w:t" && !stack.includes("del")) text += t;
      continue;
    }
    if (name === "w:tab" && !close) {
      html += " ";
      text += "\t";
      continue;
    }
    if (name === "w:br" && !close) {
      html += "<br>";
      text += "\n";
      continue;
    }
    if (name === "w:commentReference" && !close) {
      const id = /w:id="([^"]*)"/.exec(attrs!)?.[1] ?? "";
      const n = commentNo.get(id);
      if (n) html += `<sup class="kwl-cmt">[${n}]</sup>`;
    }
  }
  while (stack.length) html += `</${stack.pop()}>`;
  return { html, text };
}

function paragraphHtml(pXml: string, commentNo: Map<string, number>): string {
  const style = /<w:pStyle w:val="([^"]*)"/.exec(pXml)?.[1] ?? "";
  // 段落属性（w:pPr）里的修订标记与 run 属性不参与内联渲染
  const { html, text } = inlineHtml(pXml.replace(/<w:pPr>[\s\S]*?<\/w:pPr>/, ""), commentNo);
  const heading = /^(?:Title|Heading1|1)$/i.test(style) ? "h2" : /^(?:Heading2|2)$/i.test(style) ? "h3" : null;
  if (heading) return `<${heading}>${html}</${heading}>`;
  if (!text.trim() && !/<(?:ins|del)/.test(html)) return "<p>&nbsp;</p>";
  return `<p>${html}</p>`;
}

export function renderDocxHtml(docx: Buffer): { html: string; paragraphs: number; revisions: number; comments: number; truncated: boolean } {
  const files = readZipEntries(docx);
  const xml = files.get("word/document.xml")?.toString("utf8");
  if (!xml) throw new Error("DOCX 缺少 word/document.xml");
  const comments = commentsOf(files);
  const commentNo = new Map<string, number>();
  let n = 0;
  for (const m of xml.matchAll(/<w:commentReference\b[^>]*w:id="([^"]*)"/g)) if (!commentNo.has(m[1]!) && comments.has(m[1]!)) commentNo.set(m[1]!, ++n);
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;
  const parts: string[] = [];
  let paragraphs = 0;
  let truncated = false;
  const BLOCK = /<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[^>]*\/>|<w:p\b[\s\S]*?<\/w:p>/g;
  for (const b of body.matchAll(BLOCK)) {
    if (paragraphs >= PREVIEW_LIMITS.maxParagraphs) {
      truncated = true;
      break;
    }
    const blk = b[0];
    if (blk.startsWith("<w:tbl")) {
      const rows = blk.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) ?? [];
      const trs = rows.slice(0, PREVIEW_LIMITS.maxRows).map((tr) => {
        const cells = tr.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) ?? [];
        return `<tr>${cells
          .slice(0, PREVIEW_LIMITS.maxCols)
          .map((tc) => `<td>${(tc.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? []).map((p) => paragraphHtml(p, commentNo)).join("")}</td>`)
          .join("")}</tr>`;
      });
      parts.push(`<table>${trs.join("")}</table>`);
      paragraphs += rows.length;
      continue;
    }
    if (blk.endsWith("/>")) {
      parts.push("<p>&nbsp;</p>");
      paragraphs++;
      continue;
    }
    parts.push(paragraphHtml(blk, commentNo));
    paragraphs++;
  }
  const revisions = (xml.match(/<w:(?:ins|del)\b/g) ?? []).length;
  const cmtList = [...commentNo.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([id, no]) => {
      const c = comments.get(id)!;
      return `<li value="${no}"><strong>${esc(c.author)}</strong>：${esc(c.text)}</li>`;
    });
  const style =
    "<style>ins{background:#e6f4ea;color:#0b6b2e;text-decoration:underline}del{background:#fdecec;color:#b42318}table{border-collapse:collapse;margin:8px 0}td,th{border:1px solid #d0d4da;padding:4px 8px;vertical-align:top}h2{font-size:17px}h3{font-size:15px}.kwl-cmt{color:#c2410c}section.kwl-comments{border-top:1px solid #e3e6ea;margin-top:16px;font-size:13px}</style>";
  return {
    html: `${style}${parts.join("\n")}${cmtList.length ? `<section class="kwl-comments"><h3>批注</h3><ol>${cmtList.join("")}</ol></section>` : ""}${truncated ? `<p><em>（篇幅较长，预览只显示前 ${PREVIEW_LIMITS.maxParagraphs} 段，请下载查看全文）</em></p>` : ""}`,
    paragraphs,
    revisions,
    comments: cmtList.length,
    truncated,
  };
}

function colIndex(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function renderXlsxHtml(xlsx: Buffer): { html: string; sheets: number; truncated: boolean } {
  const files = readZipEntries(xlsx);
  const shared: string[] = [];
  const sst = files.get("xl/sharedStrings.xml")?.toString("utf8");
  if (sst) for (const si of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push([...si[1]!.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unescapeXml(t[1]!)).join(""));
  const wb = files.get("xl/workbook.xml")?.toString("utf8") ?? "";
  const names = [...wb.matchAll(/<sheet\b[^>]*name="([^"]*)"/g)].map((m) => unescapeXml(m[1]!));
  const sheetFiles = [...files.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  let truncated = sheetFiles.length > PREVIEW_LIMITS.maxSheets;
  const out: string[] = [];
  sheetFiles.slice(0, PREVIEW_LIMITS.maxSheets).forEach((f, si) => {
    const xml = files.get(f)!.toString("utf8");
    const rows = xml.match(/<row\b[\s\S]*?<\/row>|<row\b[^>]*\/>/g) ?? [];
    if (rows.length > PREVIEW_LIMITS.maxRows) truncated = true;
    const trs = rows.slice(0, PREVIEW_LIMITS.maxRows).map((row, ri) => {
      const cells: string[] = [];
      for (const c of row.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1]!;
        const inner = c[2] ?? "";
        const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
        const ci = ref ? colIndex(ref) : cells.length;
        if (ci >= PREVIEW_LIMITS.maxCols) continue;
        const t = /t="([^"]*)"/.exec(attrs)?.[1];
        let v = "";
        if (t === "s") v = shared[Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? -1)] ?? "";
        else if (t === "inlineStr") v = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => unescapeXml(x[1]!)).join("");
        else v = unescapeXml(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "");
        while (cells.length < ci) cells.push("");
        cells[ci] = v;
      }
      const tag = ri === 0 ? "th" : "td";
      return `<tr>${cells.map((v) => `<${tag}>${esc(v)}</${tag}>`).join("")}</tr>`;
    });
    out.push(`<section><h3>${esc(names[si] ?? `表${si + 1}`)}</h3><table>${trs.join("")}</table></section>`);
  });
  const style = "<style>table{border-collapse:collapse;margin:8px 0;font-size:13px}td,th{border:1px solid #d0d4da;padding:4px 8px;vertical-align:top}th{background:#f4f5f7;text-align:left}h3{font-size:15px}</style>";
  return { html: `${style}${out.join("\n")}${truncated ? `<p><em>（预览只显示每个表前 ${PREVIEW_LIMITS.maxRows} 行，请下载查看全部）</em></p>` : ""}`, sheets: out.length, truncated };
}
