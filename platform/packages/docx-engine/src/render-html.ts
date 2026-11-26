/**
 * Office 成果的应用内预览（UIUX P0-3：律师在应用里看 DOCX/XLSX，不必下载到 Word）：
 * DOCX → 段落（对齐、首行缩进取段落样式与直接格式）、标题、表格、原生修订（插入 <ins>、删除 <del>，带作者）与批注（文末列出，正文以上标编号标出位置）；
 * XLSX → 每个工作表一个 section（按表签顺序，界面做表签切换），表内按原文列宽、行高、合并单元格、对齐、换行、字形、底色、边框与数字格式排（前 500 行、40 列）。
 *
 * 输出只含白名单元素（p、h2–h4、table/colgroup/col/thead/tbody/tr/td/th、ins、del、sup、ol/li、section、strong、em、span、style），
 * 属性只有 class、title、colspan、rowspan、data-sheet-name 与不含外部引用的内联样式（颜色、宽高、对齐），不带任何链接与外部资源；
 * 文字一律 HTML 转义。界面再经隔离框架（sandbox="" + CSP）渲染，代号在隔离框架里按事项令牌表还原。
 */
import { readZipSelected } from "./zip.ts";
import { unescapeXml } from "./textmap.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// maxSheets 与表格工具的上限（12 张，V16 第 41 批）一致：本产品生成的表格在预览里全部看得到
export const PREVIEW_LIMITS = { maxParagraphs: 5_000, maxRows: 500, maxCols: 40, maxSheets: 12 } as const;

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

/** 段落版式里预览要的几项：对齐、首行缩进（字符或缇）、悬挂缩进、左缩进。 */
interface ParaFmt {
  jc?: string;
  firstChars?: number;
  first?: number;
  hangChars?: number;
  hang?: number;
  left?: number;
}
function paraFmt(pPr: string): ParaFmt {
  const f: ParaFmt = {};
  const clean = pPr.replace(/<w:pPrChange\b[\s\S]*?<\/w:pPrChange>/g, "").replace(/<w:rPr>[\s\S]*?<\/w:rPr>/g, "");
  const jc = /<w:jc\b[^>]*w:val="([^"]*)"/.exec(clean)?.[1];
  if (jc) f.jc = jc;
  const ind = /<w:ind\b([^>]*)\/?>/.exec(clean)?.[1];
  if (ind) {
    const num = (n: string) => {
      const v = new RegExp(`w:${n}="(-?\\d+)"`).exec(ind)?.[1];
      return v === undefined ? undefined : Number(v);
    };
    const set = (k: keyof ParaFmt, v: number | undefined) => {
      if (v !== undefined) (f as Record<string, number>)[k] = v;
    };
    set("firstChars", num("firstLineChars"));
    set("first", num("firstLine"));
    set("hangChars", num("hangingChars"));
    set("hang", num("hanging"));
    set("left", num("left") ?? num("start"));
  }
  return f;
}
/** styles.xml → 段落样式的版式（沿 basedOn 合并，近的优先）、缺省段落样式与文档缺省。 */
function paraStyles(xml: string | undefined): { byId: Map<string, ParaFmt>; base: ParaFmt; defaults: ParaFmt } {
  const raw = new Map<string, { basedOn?: string; fmt: ParaFmt }>();
  let defaults: ParaFmt = {};
  let defaultId: string | undefined;
  if (xml) {
    defaults = paraFmt(/<w:pPrDefault>([\s\S]*?)<\/w:pPrDefault>/.exec(xml)?.[1] ?? "");
    for (const m of xml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
      if (!/w:type="paragraph"/.test(m[1]!)) continue;
      const id = /w:styleId="([^"]*)"/.exec(m[1]!)?.[1];
      if (!id) continue;
      if (/w:default="(?:1|true)"/.test(m[1]!)) defaultId = id;
      const basedOn = /<w:basedOn\b[^>]*w:val="([^"]*)"/.exec(m[2]!)?.[1];
      raw.set(id, { ...(basedOn ? { basedOn } : {}), fmt: paraFmt(/<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(m[2]!)?.[1] ?? "") });
    }
  }
  const byId = new Map<string, ParaFmt>();
  const resolve = (id: string, depth = 0): ParaFmt => {
    const hit = byId.get(id);
    if (hit) return hit;
    const s = raw.get(id);
    if (!s || depth > 20) return {};
    const merged = { ...(s.basedOn ? resolve(s.basedOn, depth + 1) : {}), ...s.fmt };
    byId.set(id, merged);
    return merged;
  };
  for (const id of raw.keys()) resolve(id);
  return { byId, defaults, base: { ...defaults, ...(defaultId ? (byId.get(defaultId) ?? {}) : {}) } };
}
const twPt = (tw: number) => `${Math.round(tw / 2) / 10}pt`;
function paraCss(f: ParaFmt): string {
  const out: string[] = [];
  if (f.jc && f.jc !== "left" && f.jc !== "start") out.push(`text-align:${f.jc === "center" ? "center" : f.jc === "right" || f.jc === "end" ? "right" : "justify"}`);
  if (f.hangChars) out.push(`text-indent:-${f.hangChars / 100}em`);
  else if (f.hang) out.push(`text-indent:-${twPt(f.hang)}`);
  else if (f.firstChars) out.push(`text-indent:${f.firstChars / 100}em`);
  else if (f.firstChars === undefined && f.first) out.push(`text-indent:${twPt(f.first)}`);
  if (f.left && f.left > 0) out.push(`margin-left:${twPt(f.left)}`);
  return out.join(";");
}

function paragraphHtml(pXml: string, commentNo: Map<string, number>, ps?: ReturnType<typeof paraStyles>): string {
  const style = /<w:pStyle w:val="([^"]*)"/.exec(pXml)?.[1] ?? "";
  // 文档缺省 → 段落样式（无样式或样式不存在时用缺省段落样式）→ 段落直接格式
  const fmt = ps ? { ...(style && ps.byId.has(style) ? { ...ps.defaults, ...ps.byId.get(style)! } : ps.base), ...paraFmt(/<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(pXml)?.[1] ?? "") } : {};
  const css = paraCss(fmt);
  const sa = css ? ` style="${css}"` : "";
  // 段落属性（w:pPr）里的修订标记与 run 属性不参与内联渲染
  const { html, text } = inlineHtml(pXml.replace(/<w:pPr>[\s\S]*?<\/w:pPr>/, ""), commentNo);
  // 本产品生成的文书用自己的样式名（KwlTitle、KwlHeading1～3）；此前只认 Word 内置样式名，预览里所有标题都排成普通段落（V18 第 43 批）
  if (/^(?:Kwl)?Title$/i.test(style)) return `<h2 class="kwl-title">${html}</h2>`;
  const heading = /^(?:(?:Kwl)?Heading1|1)$/i.test(style) ? "h2" : /^(?:(?:Kwl)?Heading2|2)$/i.test(style) ? "h3" : /^(?:(?:Kwl)?Heading3|3)$/i.test(style) ? "h4" : null;
  if (heading) return `<${heading}${sa}>${html}</${heading}>`;
  if (!text.trim() && !/<(?:ins|del)/.test(html)) return "<p>&nbsp;</p>";
  return `<p${sa}>${html}</p>`;
}

export function renderDocxHtml(docx: Buffer): { html: string; paragraphs: number; revisions: number; comments: number; truncated: boolean } {
  // 只解压正文与批注（复核 B13-O01 余项：图片等不解压，与 XLSX 预览同一做法）
  const files = readZipSelected(docx, (n) => n === "word/document.xml" || n === "word/comments.xml" || n === "word/styles.xml");
  // 段落对齐与首行缩进（V41 第 67 批：原先全部左对齐、无缩进，“此致”“具状人”落款与正文首行缩进都和 Word 里不一样）
  const ps = paraStyles(files.get("word/styles.xml")?.toString("utf8"));
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
          .map((tc) => `<td>${(tc.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? []).map((p) => paragraphHtml(p, commentNo, ps)).join("")}</td>`)
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
    parts.push(paragraphHtml(blk, commentNo, ps));
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
    "<style>p{margin:0 0 6px}ins{background:#e6f4ea;color:#0b6b2e;text-decoration:underline}del{background:#fdecec;color:#b42318}table{border-collapse:collapse;margin:10px 0;width:100%}td,th{border:1px solid #d0cbc5;padding:4px 8px;vertical-align:top;font-size:14px;line-height:1.6}td p{margin:0}h2{font-size:17px;margin:18px 0 8px}h2.kwl-title{text-align:center;font-size:20px;letter-spacing:2px;margin:0 0 24px}h3{font-size:16px;margin:14px 0 6px}h4{font-size:15px;margin:10px 0 4px}.kwl-cmt{color:#c2410c;font-size:11px}section.kwl-comments{border-top:1px solid #e3dfda;margin-top:24px;padding-top:4px;font-size:13px;line-height:1.7}section.kwl-comments h3{font-size:14px}</style>";
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

function colName(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * 预览只解压工作簿与其关系、共享字符串、样式、主题与各表（复核 B13-O01 余项：原先解压全部条目，含 xl/media 下的图片；
 * 第 59 批加样式：日期格要按格式显示；V41 第 67 批加关系与主题：表名按 r:id 对到表文件，主题色还原底色与字色）。
 */
const PREVIEW_PARTS = (n: string) =>
  n === "xl/sharedStrings.xml" || n === "xl/workbook.xml" || n === "xl/_rels/workbook.xml.rels" || n === "xl/styles.xml" || /^xl\/theme\/[^/]+\.xml$/.test(n) || /^xl\/worksheets\/[^/]+\.xml$/.test(n);

/** 工作簿关系：r:id → 表文件路径（相对 xl/，或以 / 开头的包内绝对路径）。 */
function relTargets(rels: string): Map<string, string> {
  const target = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /\bId="([^"]*)"/.exec(m[1]!)?.[1];
    const t = /\bTarget="([^"]*)"/.exec(m[1]!)?.[1];
    if (id && t) target.set(id, t.startsWith("/") ? t.slice(1) : `xl/${t.replace(/^\.\//, "")}`);
  }
  return target;
}

/** 工作簿里的表（按 workbook.xml 的顺序，即 Excel 底部表签的顺序）：表名、表文件（经关系对应）、是否隐藏。 */
function workbookSheets(wb: string, rels: string, files: Map<string, Buffer>): { name: string; file: string; hidden: boolean }[] {
  const target = relTargets(rels);
  const listed = [...wb.matchAll(/<sheet\b([^>]*)\/?>/g)].map((m, i) => {
    const name = unescapeXml(/\bname="([^"]*)"/.exec(m[1]!)?.[1] ?? `表${i + 1}`);
    const rid = /\br:id="([^"]*)"/.exec(m[1]!)?.[1];
    return { name, file: (rid && target.get(rid)) || `xl/worksheets/sheet${i + 1}.xml`, hidden: /\bstate="(?:hidden|veryHidden)"/.test(m[1]!) };
  });
  if (listed.length > 0) return listed;
  // 工作簿没列出表（不规范的写入器）：退回按文件编号
  return [...files.keys()]
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]))
    .map((file, i) => ({ name: `表${i + 1}`, file, hidden: false }));
}

/** Excel 文字里的 _xHHHH_ 转义（如 _x000D_ 回车）。 */
const xmlText = (s: string) => unescapeXml(s).replace(/_x([0-9A-Fa-f]{4})_/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
const tTexts = (xml: string) => [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)].map((t) => xmlText(t[1] ?? "")).join("");

interface SsRun {
  t: string;
  css: string;
}
interface SsItem {
  text: string;
  runs?: SsRun[];
}

/** 一段字符串（<si> 或 <is> 的内容）：拼音注音（<rPh>）不算正文；富文本按段保留字形（粗、斜、下划线、字号、颜色）。 */
function stringItem(body: string, pal?: Palette, baseSz?: number): SsItem {
  const clean = body.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").replace(/<phoneticPr\b[^>]*\/>/g, "");
  const rs = [...clean.matchAll(/<r>([\s\S]*?)<\/r>/g)];
  if (rs.length === 0) return { text: tTexts(clean) };
  const runs = rs.map((r) => {
    const rPr = /<rPr>([\s\S]*?)<\/rPr>/.exec(r[1]!)?.[1] ?? "";
    return { t: tTexts(r[1]!.replace(/<rPr>[\s\S]*?<\/rPr>/, "")), css: pal ? fontCss(parseFont(rPr, pal), baseSz ?? 11) : "" };
  });
  return { text: runs.map((r) => r.t).join(""), runs };
}

function sharedStrings(sst: string | undefined, pal?: Palette, baseSz?: number): SsItem[] {
  if (!sst) return [];
  return [...sst.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((si) => stringItem(si[1] ?? "", pal, baseSz));
}

// ---- 颜色（rgb / 主题色 + 明暗 / 旧式索引色） ----
interface Palette {
  theme: string[];
  indexed: string[];
}
const DEFAULT_INDEXED =
  "000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF 000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF 800000 008000 000080 808000 800080 008080 C0C0C0 808080 9999FF 993366 FFFFCC CCFFFF 660066 FF8080 0066CC CCCCFF 000080 FF00FF FFFF00 00FFFF 800080 800000 008080 0000FF 00CCFF CCFFFF CCFFCC FFFF99 99CCFF FF99CC CC99FF FFCC99 3366FF 33CCCC 99CC00 FFCC00 FF9900 FF6600 666699 969696 003366 339966 003300 333300 993300 993366 333399 333333".split(" ");
// Office 2013+ 缺省主题（按 Excel 主题序号：0 lt1、1 dk1、2 lt2、3 dk2、4–9 accent1–6、10 hlink、11 folHlink）
const DEFAULT_THEME = "FFFFFF 000000 E7E6E6 44546A 4472C4 ED7D31 A5A5A5 FFC000 5B9BD5 70AD47 0563C1 954F72".split(" ");

function themeColors(xml: string | undefined): string[] {
  const scheme = xml ? /<(?:\w+:)?clrScheme\b[\s\S]*?<\/(?:\w+:)?clrScheme>/.exec(xml)?.[0] : undefined;
  if (!scheme) return DEFAULT_THEME;
  const get = (n: string, i: number) => {
    const body = new RegExp(`<(?:\\w+:)?${n}>([\\s\\S]*?)</(?:\\w+:)?${n}>`).exec(scheme)?.[1] ?? "";
    return /srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})"/.exec(body)?.[1] ?? /sysClr\b[^>]*\blastClr="([0-9A-Fa-f]{6})"/.exec(body)?.[1] ?? DEFAULT_THEME[i]!;
  };
  return ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"].map(get);
}

/** 主题色的明暗调整（tint：负数变暗、正数变亮，按 HSL 亮度）。 */
function applyTint(hex: string, tint: number): string {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  let l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6;
  }
  l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
  };
  let rgb: number[];
  if (s === 0) rgb = [l, l, l];
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    rgb = [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)];
  }
  return rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("");
}

function colorOf(attrs: string, pal: Palette): string | null {
  if (/\bauto="(?:1|true)"/.test(attrs)) return null;
  let hex: string | undefined;
  const rgb = /\brgb="([0-9A-Fa-f]{6,8})"/.exec(attrs)?.[1];
  if (rgb) hex = rgb.slice(-6);
  else {
    const th = /\btheme="(\d+)"/.exec(attrs)?.[1];
    const ix = /\bindexed="(\d+)"/.exec(attrs)?.[1];
    if (th !== undefined) hex = pal.theme[Number(th)];
    else if (ix !== undefined) hex = pal.indexed[Number(ix)]; // 64、65 是系统前景 / 背景色：取不到即按缺省
  }
  if (!hex || !/^[0-9A-Fa-f]{6}$/.test(hex)) return null;
  const tint = Number(/\btint="(-?[\d.]+(?:[Ee]-?\d+)?)"/.exec(attrs)?.[1] ?? 0);
  return `#${(tint ? applyTint(hex, tint) : hex).toLowerCase()}`;
}

// ---- 样式（字体、底色、边框、对齐、数字格式） ----
interface Font {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  s?: boolean;
  sz?: number;
  color?: string | null;
}
const flag = (xml: string, tag: string) => {
  const m = new RegExp(`<${tag}\\b([^>]*)>`).exec(xml);
  return !!m && !/\bval="(?:0|false|none)"/.test(m[1]!);
};
function parseFont(xml: string, pal: Palette): Font {
  const sz = Number(/<sz\b[^>]*\bval="([\d.]+)"/.exec(xml)?.[1] ?? NaN);
  const c = /<color\b([^>]*?)\/?>/.exec(xml)?.[1];
  return { b: flag(xml, "b"), i: flag(xml, "i"), u: flag(xml, "u"), s: flag(xml, "strike"), ...(Number.isFinite(sz) ? { sz } : {}), color: c ? colorOf(c, pal) : null };
}
/** 预览基准字号 13px 对应工作簿缺省字号（Excel 11 磅、本产品 10.5 磅、WPS 12 磅），其余字号按比例。 */
function fontCss(f: Font, baseSz: number): string {
  const css: string[] = [];
  if (f.b) css.push("font-weight:700");
  if (f.i) css.push("font-style:italic");
  const deco = [f.u ? "underline" : "", f.s ? "line-through" : ""].filter(Boolean).join(" ");
  if (deco) css.push(`text-decoration:${deco}`);
  if (f.sz && Math.abs(f.sz - baseSz) > 0.01) css.push(`font-size:${Math.min(48, Math.max(8, Math.round(((f.sz * 13) / baseSz) * 10) / 10))}px`);
  if (f.color && f.color !== "#000000") css.push(`color:${f.color}`);
  return css.join(";");
}

function parseFill(xml: string, pal: Palette): string | null {
  if (/<gradientFill\b/.test(xml)) {
    const c = /<stop\b[^>]*>\s*<color\b([^>]*?)\/?>/.exec(xml)?.[1];
    return c ? colorOf(c, pal) : null;
  }
  const pt = /<patternFill\b[^>]*\bpatternType="([^"]*)"/.exec(xml)?.[1];
  if (!pt || pt === "none") return null;
  const fg = /<fgColor\b([^>]*?)\/?>/.exec(xml)?.[1];
  return fg ? colorOf(fg, pal) : pt === "solid" ? "#000000" : null;
}

type Sides = { l?: string; r?: string; t?: string; b?: string };
const BORDER_LINE: Record<string, string> = {
  thin: "1px solid",
  hair: "1px solid",
  dotted: "1px dotted",
  dashed: "1px dashed",
  dashDot: "1px dashed",
  dashDotDot: "1px dotted",
  medium: "2px solid",
  mediumDashed: "2px dashed",
  mediumDashDot: "2px dashed",
  mediumDashDotDot: "2px dashed",
  slantDashDot: "2px dashed",
  thick: "3px solid",
  double: "3px double",
};
function parseBorder(xml: string, pal: Palette): Sides {
  const out: Sides = {};
  const key = { left: "l", start: "l", right: "r", end: "r", top: "t", bottom: "b" } as const;
  for (const m of xml.matchAll(/<(left|right|top|bottom|start|end)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g)) {
    const style = /\bstyle="([^"]*)"/.exec(m[2]!)?.[1];
    const line = style ? BORDER_LINE[style] : undefined;
    if (!line) continue;
    const c = /<color\b([^>]*?)\/?>/.exec(m[3] ?? "")?.[1];
    out[key[m[1] as keyof typeof key]] = `${line} ${(c && colorOf(c, pal)) || "#000000"}`;
  }
  return out;
}

interface Xf {
  code: string;
  kind: FmtKind;
  css: string;
  fill: boolean;
  border: Sides;
  h: string;
  wrap: boolean;
}

/**
 * Excel 内置数字格式（中文区域的写法：货币 ¥，27–36、50–58 是中文日期时间）。其余编号按“常规”。
 */
const BUILTIN_FMT: Record<number, string> = {
  1: "0",
  2: "0.00",
  3: "#,##0",
  4: "#,##0.00",
  5: '"¥"#,##0;"¥"-#,##0',
  6: '"¥"#,##0;[Red]"¥"-#,##0',
  7: '"¥"#,##0.00;"¥"-#,##0.00',
  8: '"¥"#,##0.00;[Red]"¥"-#,##0.00',
  9: "0%",
  10: "0.00%",
  11: "0.00E+00",
  37: "#,##0 ;(#,##0)",
  38: "#,##0 ;[Red](#,##0)",
  39: "#,##0.00;(#,##0.00)",
  40: "#,##0.00;[Red](#,##0.00)",
  41: '_-* #,##0_-;-* #,##0_-;_-* "-"_-;_-@_-',
  42: '_-"¥"* #,##0_-;-"¥"* #,##0_-;_-"¥"* "-"_-;_-@_-',
  43: '_-* #,##0.00_-;-* #,##0.00_-;_-* "-"??_-;_-@_-',
  44: '_-"¥"* #,##0.00_-;-"¥"* #,##0.00_-;_-"¥"* "-"??_-;_-@_-',
  48: "##0.0E+0",
  49: "@",
  27: 'yyyy"年"m"月"',
  28: 'm"月"d"日"',
  29: 'm"月"d"日"',
  31: 'yyyy"年"m"月"d"日"',
  32: 'h"时"mm"分"',
  33: 'h"时"mm"分"ss"秒"',
  34: '上午/下午h"时"mm"分"',
  35: '上午/下午h"时"mm"分"ss"秒"',
  36: 'yyyy"年"m"月"',
  50: 'yyyy"年"m"月"',
  51: 'm"月"d"日"',
  52: 'yyyy"年"m"月"',
  53: 'm"月"d"日"',
  54: 'm"月"d"日"',
  55: '上午/下午h"时"mm"分"',
  56: '上午/下午h"时"mm"分"ss"秒"',
  57: 'yyyy"年"m"月"',
  58: 'm"月"d"日"',
};

interface SheetStyles {
  xfs: Xf[];
  baseSz: number;
  pal: Palette;
  date1904: boolean;
}

function parseStyles(styles: string, wb: string, themeXml: string | undefined): SheetStyles {
  const custom = /<indexedColors>([\s\S]*?)<\/indexedColors>/.exec(styles)?.[1];
  const indexed = custom ? [...custom.matchAll(/<rgbColor\b[^>]*\brgb="([0-9A-Fa-f]{6,8})"/g)].map((m) => m[1]!.slice(-6)) : DEFAULT_INDEXED;
  const pal: Palette = { theme: themeColors(themeXml), indexed };
  const block = (tag: string) => new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(styles)?.[1] ?? "";
  const fonts = [...block("fonts").matchAll(/<font\b[^>]*?(?:\/>|>([\s\S]*?)<\/font>)/g)].map((m) => parseFont(m[1] ?? "", pal));
  const fills = [...block("fills").matchAll(/<fill\b[^>]*?(?:\/>|>([\s\S]*?)<\/fill>)/g)].map((m) => parseFill(m[1] ?? "", pal));
  const borders = [...block("borders").matchAll(/<border\b[^>]*?(?:\/>|>([\s\S]*?)<\/border>)/g)].map((m) => parseBorder(m[1] ?? "", pal));
  const codes = new Map<number, string>();
  for (const m of styles.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) codes.set(Number(m[1]), unescapeXml(m[2]!));
  const baseSz = fonts[0]?.sz ?? 11;
  const xfs: Xf[] = [];
  for (const m of block("cellXfs").matchAll(/<xf\b([^>]*?)(?:\/>|>([\s\S]*?)<\/xf>)/g)) {
    const a = m[1]!;
    const num = (n: string) => Number(new RegExp(`\\b${n}="(\\d+)"`).exec(a)?.[1] ?? 0);
    const id = num("numFmtId");
    const code = codes.get(id) ?? BUILTIN_FMT[id] ?? "General";
    const kind = codes.has(id) ? customFmtKind(codes.get(id)!) : builtinKind(id);
    const al = /<alignment\b([^>]*?)\/?>/.exec(m[2] ?? "")?.[1] ?? "";
    const h = /\bhorizontal="([^"]*)"/.exec(al)?.[1] ?? "general";
    const v = /\bvertical="([^"]*)"/.exec(al)?.[1] ?? "bottom";
    const wrap = /\bwrapText="(?:1|true)"/.test(al) || h === "justify" || h === "distributed" || v === "justify" || v === "distributed";
    const indent = Number(/\bindent="(\d+)"/.exec(al)?.[1] ?? 0);
    const fill = fills[num("fillId")] ?? null;
    const css: string[] = [];
    const fc = fonts[num("fontId")] ? fontCss(fonts[num("fontId")]!, baseSz) : "";
    if (fc) css.push(fc);
    if (fill) css.push(`background:${fill}`);
    const ta = { left: "left", center: "center", centerContinuous: "center", right: "right", justify: "justify", distributed: "justify", fill: "left" }[h];
    if (ta) css.push(`text-align:${ta}`);
    if (h === "distributed") css.push("text-align-last:justify");
    if (v !== "bottom") css.push(`vertical-align:${v === "top" ? "top" : v === "center" || v === "justify" || v === "distributed" ? "middle" : "bottom"}`);
    if (wrap) css.push("white-space:pre-wrap;overflow-wrap:anywhere");
    if (indent) css.push(`${h === "right" ? "padding-right" : "padding-left"}:${4 + indent * 10}px`);
    xfs.push({ code, kind, css: css.join(";"), fill: !!fill, border: borders[num("borderId")] ?? {}, h, wrap });
  }
  return { xfs, baseSz, pal, date1904: /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(wb) };
}

// ---- 数字格式 ----
/** “常规”格式：整数照写；小数至多约 10 位有效数字（去掉 0.1+0.2 一类的浮点尾数）；很大或很小的用科学计数。 */
export function generalNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n === 0) return "0";
  const a = Math.abs(n);
  if (a >= 1e11 || a < 1e-4) {
    const [m, e] = n.toExponential(5).split("e");
    return `${m!.replace(/\.?0+$/, "")}E${Number(e) < 0 ? "-" : "+"}${String(Math.abs(Number(e))).padStart(2, "0")}`;
  }
  if (Number.isInteger(n)) return String(n);
  const intDigits = Math.max(1, Math.floor(Math.log10(a)) + 1);
  return String(Number(n.toFixed(Math.max(0, 10 - intDigits))));
}

function splitSections(code: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
    if (ch === '"') quoted = !quoted;
    if (ch === "\\" && !quoted) {
      cur += ch + (code[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === ";" && !quoted) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

const NAMED_COLOR: Record<string, string> = { red: "#ff0000", blue: "#0000ff", green: "#008000", magenta: "#ff00ff", cyan: "#00ffff", yellow: "#ffff00", black: "#000000", white: "#ffffff" };

/** 按十进制四舍五入到 d 位（先取 15 位有效数字，1.005 → 1.01，与 Excel 一致；不用 toFixed 的二进制舍入）。 */
function roundFixed(x: number, d: number): string {
  const m = 10 ** d;
  const s = x.toPrecision(15);
  const shifted = s.includes("e") ? x * m : Number(`${s}e${d}`);
  return (Math.round(shifted) / m).toFixed(d);
}

/**
 * 数字格式（V41 第 67 批：原先只认日期，金额 66970 显示成 66970、0.125 的百分比显示成 0.125）：
 * 千分位、小数位、百分比、科学计数、货币符号（[$¥-804] 与引号里的 ¥）、正负零三段、[Red] 等颜色；条件段与分数退回“常规”。
 */
export function formatNumber(n: number, code: string): { text: string; color?: string } {
  if (!code || /^\s*general\s*$/i.test(code) || code === "@") return { text: generalNumber(n) };
  const secs = splitSections(code);
  let sec = secs[0]!;
  let v = n;
  if (n < 0 && secs.length >= 2 && secs[1]!.trim() !== "") {
    sec = secs[1]!;
    v = -n; // 负数段自带符号或括号
  } else if (n === 0 && secs.length >= 3 && secs[2]!.trim() !== "") sec = secs[2]!;
  if (/\[[<>=]/.test(sec) || /[0#?]\s*\/\s*[0-9#?]/.test(sec)) return { text: generalNumber(n) };
  let color: string | undefined;
  sec = sec.replace(/\[([^\]]*)\]/g, (_m, inner: string) => {
    const c = NAMED_COLOR[inner.toLowerCase()];
    if (c) {
      color = c;
      return "";
    }
    const cur = /^\$([^-]*)/.exec(inner);
    return cur ? `"${cur[1]}"` : "";
  });
  const pre: string[] = [];
  const post: string[] = [];
  let pat = "";
  let pct = 0;
  let sci = false;
  let expDigits = 0;
  let general = false;
  const lit = (s: string) => (pat || general ? post : pre).push(s);
  for (const m of sec.matchAll(/"([^"]*)"|\\([\s\S])|_([\s\S])|\*([\s\S])|(general)|([0#?.,])|([Ee][+-])|(%)|(@)|([\s\S])/gi)) {
    if (m[1] !== undefined) lit(m[1]);
    else if (m[2] !== undefined) lit(m[2]);
    else if (m[3] !== undefined) lit(" ");
    else if (m[4] !== undefined) lit(" "); // 填充（会计格式里货币符号与数字之间的空白）记一个空格
    else if (m[5]) general = true;
    else if (m[6]) {
      if (sci) {
        if (m[6] === "0" || m[6] === "#") expDigits++;
      } else if (post.length === 0 && (pat || /[0#?.]/.test(m[6]))) pat += m[6];
      else if (!pat) lit(m[6]);
      else post.push(m[6]);
    } else if (m[7]) sci = true;
    else if (m[8]) {
      pct++;
      lit("%");
    } else if (m[9]) lit("");
    else if (m[10] !== undefined) lit(m[10]);
  }
  const sign = v < 0 ? "-" : "";
  let x = Math.abs(v) * 100 ** pct;
  let num: string;
  if (general || !pat) num = general ? generalNumber(x) : "";
  else {
    const [ipRaw, fp = ""] = pat.split(".");
    const trailing = /,+$/.exec(ipRaw!)?.[0].length ?? 0;
    x /= 1000 ** trailing;
    const ip = ipRaw!.slice(0, ipRaw!.length - trailing);
    const dec = (fp.match(/[0#?]/g) ?? []).length;
    // “?” 只占位（补空格），不补零
    const minDec = (fp.match(/0/g) ?? []).length;
    const minInt = (ip.match(/0/g) ?? []).length;
    if (x >= 1e15) num = generalNumber(x);
    else if (sci) {
      const [mant, e] = x.toExponential(dec).split("e");
      num = `${mant}E${Number(e) < 0 ? "-" : "+"}${String(Math.abs(Number(e))).padStart(Math.max(1, expDigits), "0")}`;
    } else {
      let [is, fs = ""] = roundFixed(x, dec).split(".") as [string, string?];
      while (fs.length > minDec && fs.endsWith("0")) fs = fs.slice(0, -1);
      if (is === "0" && minInt === 0) is = "";
      is = is.padStart(minInt, "0");
      if (ip.includes(",")) is = is.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      num = is + (pat.includes(".") ? `.${fs}` : "");
    }
  }
  const text = (sign + pre.join("") + num + post.join("")).replace(/^\s+|\s+$/g, "");
  return color ? { text, color } : { text };
}

/** 日期时间格式按原格式写（中文的“2026年11月9日”“9时30分”）；年月日以外的写法交给 excelDate（yyyy-mm-dd）。 */
function formatDateCode(serial: number, code: string): string | null {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) return null;
  const d = new Date(Math.round((serial - 25569) * 86400_000));
  const [Y, M, D, h, mi, s] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()];
  const sec = (splitSections(code)[0] ?? "").replace(/\[[^\]]*\]/g, "").replace(/_[\s\S]/g, " ").replace(/\*[\s\S]/g, "");
  const toks: { k: string; v: string }[] = [];
  for (const m of sec.matchAll(/"([^"]*)"|\\([\s\S])|(yyyy|yy|e|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|AM\/PM|上午\/下午|A\/P)|([\s\S])/gi)) {
    if (m[1] !== undefined) toks.push({ k: "lit", v: m[1] });
    else if (m[2] !== undefined) toks.push({ k: "lit", v: m[2] });
    else if (m[3]) toks.push({ k: m[3].toLowerCase(), v: m[3] });
    else toks.push({ k: "lit", v: m[4]! });
  }
  const ampm = toks.some((t) => t.k === "am/pm" || t.k === "上午/下午" || t.k === "a/p");
  const p2 = (n: number) => String(n).padStart(2, "0");
  return toks
    .map((t, i) => {
      switch (t.k) {
        case "yyyy":
        case "e":
          return String(Y);
        case "yy":
          return p2(Y % 100);
        case "m":
        case "mm": {
          const prev = toks.slice(0, i).reverse().find((x) => x.k !== "lit");
          const next = toks.slice(i + 1).find((x) => x.k !== "lit");
          const n = (prev && /^h/.test(prev.k)) || (next && /^s/.test(next.k)) ? mi : M;
          return t.k === "mm" ? p2(n) : String(n);
        }
        case "mmm":
        case "mmmm":
          return `${M}月`;
        case "d":
          return String(D);
        case "dd":
          return p2(D);
        case "ddd":
        case "dddd":
          return `星期${"日一二三四五六"[d.getUTCDay()]}`;
        case "h":
          return String(ampm ? h % 12 || 12 : h);
        case "hh":
          return p2(ampm ? h % 12 || 12 : h);
        case "s":
          return String(s);
        case "ss":
          return p2(s);
        case "am/pm":
          return h < 12 ? "AM" : "PM";
        case "a/p":
          return h < 12 ? "A" : "P";
        case "上午/下午":
          return h < 12 ? "上午" : "下午";
        default:
          return t.v;
      }
    })
    .join("");
}

// ---- 工作表 ----
interface Cell {
  xf: number;
  t: string | undefined;
  inner: string;
}
interface Row {
  ht?: number;
  custom: boolean;
  hidden: boolean;
  xf?: number;
  cells: Map<number, Cell>;
}

/** Excel 列宽（字符数，已含边距）→ 像素：按缺省字体的数字宽 7px（Excel 100% 缩放）。 */
const widthPx = (w: number) => Math.max(0, Math.round(w * 7));
/** 文字的大致显示宽度（中文与全角按 1 个字号宽，其余约 0.55 个）：判断不换行的文字要不要溢到右边的空格子。 */
function textPx(s: string, fontPx: number): number {
  let w = 0;
  for (const ch of s) w += /[ᄀ-￿]/.test(ch) && !/[｡-ﾟ]/.test(ch) ? fontPx : fontPx * 0.55;
  return w;
}

const GRID_CSS = [
  ".kwl-sheet{margin:0}",
  "table.kwl-grid{border-collapse:separate;border-spacing:0;table-layout:fixed;font-family:Calibri,'Segoe UI',BlinkMacSystemFont,'Helvetica Neue',DengXian,'等线','Microsoft YaHei','微软雅黑','PingFang SC','Hiragino Sans GB',Arial,sans-serif;font-size:13px;line-height:1.4;color:#0e1219;background:#ffffff;margin:0}",
  ".kwl-grid td{box-sizing:border-box;padding:1px 4px;border-right:1px solid #e3dfda;border-bottom:1px solid #e3dfda;vertical-align:bottom;white-space:pre;overflow:hidden;text-overflow:clip}",
  ".kwl-grid th{box-sizing:border-box;position:sticky;background:#f4f3f2;color:#666666;font-weight:400;font-size:12px;line-height:20px;text-align:center;padding:0 2px;border-right:1px solid #d0cbc5;border-bottom:1px solid #d0cbc5;white-space:nowrap;overflow:hidden}",
  ".kwl-grid thead th{top:0;z-index:3;height:22px}",
  ".kwl-grid th.kwl-rh{left:0;z-index:2}",
  ".kwl-grid thead th.kwl-corner{left:0;z-index:4}",
  ".kwl-grid td.kf{position:sticky;z-index:1;background:#ffffff}",
  ".kwl-grid td.kn{text-align:right}",
  ".kwl-grid td.kc{text-align:center}",
  ".kwl-grid.kwl-nogrid td{border-right-color:transparent;border-bottom-color:transparent}",
  ".kwl-note{font-family:'Segoe UI','Microsoft YaHei',-apple-system,'PingFang SC',sans-serif;font-size:12px;color:#666666;margin:10px 12px}",
].join("");

/**
 * XLSX → 白名单 HTML（V41 第 67 批重写：原先一律平铺成等宽表格，证据目录的“证据编号”被挤成一字一行）：
 * 按工作簿的表签顺序（workbook.xml + 关系，不再按 sheetN 文件编号）每张表一个 section（class="kwl-sheet"，data-sheet-name 为表名），
 * 界面据此做表签、一次只显示一张；表内按原文列宽、行高、合并单元格、对齐、换行、字形、底色、边框、数字格式排，
 * 隐藏的行列与工作表不显示，列号（A B C）与行号固定在边上，冻结的首行跟着固定。上限：12 张表、每表 500 行、40 列，超出如实说明。
 */
export function renderXlsxHtml(xlsx: Buffer): { html: string; sheets: number; truncated: boolean; sheetNames: string[]; hiddenSheets: number } {
  const files = readZipSelected(xlsx, PREVIEW_PARTS);
  const wb = files.get("xl/workbook.xml")?.toString("utf8") ?? "";
  const themeFile = [...files.keys()].find((k) => /^xl\/theme\/[^/]+\.xml$/.test(k));
  const st = parseStyles(files.get("xl/styles.xml")?.toString("utf8") ?? "", wb, themeFile ? files.get(themeFile)!.toString("utf8") : undefined);
  const shared = sharedStrings(files.get("xl/sharedStrings.xml")?.toString("utf8"), st.pal, st.baseSz);
  const all = workbookSheets(wb, files.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "", files);
  const visible = all.filter((s) => !s.hidden && files.has(s.file));
  const hiddenSheets = all.filter((s) => s.hidden).length;
  let truncated = visible.length > PREVIEW_LIMITS.maxSheets;
  const borderClass = new Map<string, number>();
  const sections: string[] = [];
  const names: string[] = [];
  for (const sh of visible.slice(0, PREVIEW_LIMITS.maxSheets)) {
    const r = renderSheet(files.get(sh.file)!.toString("utf8"), st, shared, borderClass);
    if (r.truncated) truncated = true;
    names.push(sh.name);
    sections.push(`<section class="kwl-sheet" data-sheet-name="${esc(sh.name)}">${r.html}</section>`);
  }
  const xfCss = st.xfs.map((x, i) => (x.css ? `.kwl-grid td.x${i}{${x.css}}` : "")).join("");
  const bCss = [...borderClass].map(([k, i]) => `.kwl-grid td.b${i}{${k}}`).join("");
  const notes = [
    hiddenSheets > 0 ? `<p class="kwl-note">另有 ${hiddenSheets} 张隐藏的工作表未显示，请下载后在 Excel 里查看。</p>` : "",
    visible.length > PREVIEW_LIMITS.maxSheets ? `<p class="kwl-note">预览只显示前 ${PREVIEW_LIMITS.maxSheets} 张工作表，请下载查看全部。</p>` : "",
  ].join("");
  return { html: `<style>${GRID_CSS}${xfCss}${bCss}</style>${sections.join("\n")}${notes}`, sheets: sections.length, truncated, sheetNames: names, hiddenSheets };
}

function renderSheet(xml: string, st: SheetStyles, shared: SsItem[], borderClass: Map<string, number>): { html: string; truncated: boolean } {
  const L = PREVIEW_LIMITS;
  let truncated = false;
  // 列：宽度、隐藏、列样式
  const fmtPr = /<sheetFormatPr\b([^>]*)\/?>/.exec(xml)?.[1] ?? "";
  const defW = Number(/\bdefaultColWidth="([\d.]+)"/.exec(fmtPr)?.[1] ?? NaN);
  const baseW = Number(/\bbaseColWidth="(\d+)"/.exec(fmtPr)?.[1] ?? 8);
  const defColPx = Number.isFinite(defW) ? widthPx(defW) : Math.ceil((baseW * 7 + 5) / 8) * 8;
  const defRowPx = Math.round(Number(/\bdefaultRowHeight="([\d.]+)"/.exec(fmtPr)?.[1] ?? 15) * (4 / 3));
  const colPx: number[] = [];
  const colHidden: boolean[] = [];
  const colXf: (number | undefined)[] = [];
  for (const m of xml.matchAll(/<col\b([^>]*?)\/?>/g)) {
    const a = m[1]!;
    const min = Number(/\bmin="(\d+)"/.exec(a)?.[1] ?? 0);
    const max = Math.min(Number(/\bmax="(\d+)"/.exec(a)?.[1] ?? min), L.maxCols + 1);
    const w = Number(/\bwidth="([\d.]+)"/.exec(a)?.[1] ?? NaN);
    const hidden = /\bhidden="(?:1|true)"/.test(a) || w === 0;
    const s = /\bstyle="(\d+)"/.exec(a)?.[1];
    for (let c = min; c <= max; c++) {
      if (Number.isFinite(w)) colPx[c - 1] = widthPx(w);
      colHidden[c - 1] = hidden;
      if (s !== undefined) colXf[c - 1] = Number(s);
    }
  }
  // 行与格
  const rows = new Map<number, Row>();
  let maxRow = 0;
  let maxCol = -1;
  let rowSeq = 0;
  const data = /<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/.exec(xml)?.[1] ?? "";
  for (const m of data.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const a = m[1]!;
    const rn = Number(/\br="(\d+)"/.exec(a)?.[1] ?? rowSeq + 1);
    rowSeq = rn;
    if (rn > L.maxRows) {
      if (/<c\b/.test(m[2] ?? "")) truncated = true;
      continue;
    }
    const ht = Number(/\bht="([\d.]+)"/.exec(a)?.[1] ?? NaN);
    const row: Row = { custom: /\bcustomHeight="(?:1|true)"/.test(a), hidden: /\bhidden="(?:1|true)"/.test(a), cells: new Map(), ...(Number.isFinite(ht) ? { ht } : {}) };
    if (/\bcustomFormat="(?:1|true)"/.test(a)) row.xf = Number(/\bs="(\d+)"/.exec(a)?.[1] ?? 0);
    let seq = 0;
    for (const c of (m[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ca = c[1]!;
      const ref = /\br="([A-Z]+)\d+"/.exec(ca)?.[1];
      const ci = ref ? colIndex(ref) : seq;
      seq = ci + 1;
      if (ci >= L.maxCols) {
        if (/<v>|<is>/.test(c[2] ?? "")) truncated = true;
        continue;
      }
      const cell: Cell = { xf: Number(/\bs="(\d+)"/.exec(ca)?.[1] ?? 0), t: /\bt="([^"]*)"/.exec(ca)?.[1], inner: c[2] ?? "" };
      row.cells.set(ci, cell);
      if (cell.inner.includes("<v") || cell.inner.includes("<is") || cell.xf !== 0) {
        maxCol = Math.max(maxCol, ci);
        maxRow = Math.max(maxRow, rn);
      }
    }
    rows.set(rn, row);
  }
  // 合并单元格（只认落在预览范围内的；锚点所在的行或列被隐藏时按未合并处理）
  const merges: { r1: number; c1: number; r2: number; c2: number }[] = [];
  for (const m of xml.matchAll(/<mergeCell\b[^>]*\bref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/g)) {
    const mc = { c1: colIndex(m[1]!), r1: Number(m[2]), c2: colIndex(m[3]!), r2: Number(m[4]) };
    if (mc.r1 > L.maxRows || mc.c1 >= L.maxCols) continue;
    mc.r2 = Math.min(mc.r2, L.maxRows);
    mc.c2 = Math.min(mc.c2, L.maxCols - 1);
    merges.push(mc);
    maxRow = Math.max(maxRow, mc.r2);
    maxCol = Math.max(maxCol, mc.c2);
  }
  if (maxRow === 0 || maxCol < 0) return { html: `<p class="kwl-note">这张工作表是空的。</p>`, truncated };
  const pane = /<pane\b([^>]*?)\/?>/.exec(xml)?.[1] ?? "";
  const frozenRows = /\bstate="frozen(?:Split)?"/.test(pane) ? Math.min(3, Number(/\bySplit="(\d+)"/.exec(pane)?.[1] ?? 0)) : 0;
  const noGrid = /<sheetView\b[^>]*\bshowGridLines="(?:0|false)"/.test(xml);

  const px = (c: number) => colPx[c] ?? defColPx;
  // 不换行的长文字在 Excel 里会接着显示在已用范围右侧的空列上：把列补到放得下为止（不超过 40 列），不在表格边上截断
  let spillTo = maxCol;
  for (const row of rows.values()) {
    if (row.hidden) continue;
    for (const [c, cell] of row.cells) {
      if (cell.t !== "s" && cell.t !== "inlineStr" && cell.t !== "str") continue;
      const xf = st.xfs[cell.xf];
      if (xf && (xf.wrap || xf.fill || (xf.h !== "general" && xf.h !== "left"))) continue;
      let need = textPx(cellValue(cell, xf, st, shared).text, 13) + 8 - px(c);
      let k = c;
      while (need > 0 && k < L.maxCols - 1) {
        k++;
        if (!colHidden[k]) need -= px(k);
      }
      if (k > spillTo) spillTo = k;
    }
  }
  maxCol = spillTo;
  const cols = Array.from({ length: maxCol + 1 }, (_, c) => c).filter((c) => !colHidden[c]);
  const rowNums = Array.from({ length: maxRow }, (_, i) => i + 1).filter((r) => !rows.get(r)?.hidden);
  const nextCol = new Map(cols.map((c, i) => [c, cols[i + 1]]));
  const nextRow = new Map(rowNums.map((r, i) => [r, rowNums[i + 1]]));
  const xfAt = (r: number, c: number): number => rows.get(r)?.cells.get(c)?.xf ?? rows.get(r)?.xf ?? colXf[c] ?? 0;
  const sides = (r: number, c: number): Sides => st.xfs[xfAt(r, c)]?.border ?? {};
  const anchor = new Map<string, { rs: number; cs: number; r2: number; c2: number }>();
  const covered = new Set<string>();
  for (const mc of merges) {
    if (rows.get(mc.r1)?.hidden || colHidden[mc.c1]) continue;
    const vr = rowNums.filter((r) => r >= mc.r1 && r <= mc.r2);
    const vc = cols.filter((c) => c >= mc.c1 && c <= mc.c2);
    if (vr.length * vc.length <= 1) continue;
    anchor.set(`${mc.r1}:${mc.c1}`, { rs: vr.length, cs: vc.length, r2: vr[vr.length - 1]!, c2: vc[vc.length - 1]! });
    for (const r of vr) for (const c of vc) if (r !== mc.r1 || c !== mc.c1) covered.add(`${r}:${c}`);
  }
  const hasValue = (r: number, c: number) => {
    const cell = rows.get(r)?.cells.get(c);
    return !!cell && (/<v>[\s\S]*?<\/v>/.test(cell.inner) || /<t\b[^>]*>[^<]/.test(cell.inner));
  };
  const borderOf = (r1: number, c1: number, r2: number, c2: number): string => {
    // 分离边框模型：每格画右框与下框（与右邻的左框、下邻的上框合并），首列首行另画左框、上框
    const nc = nextCol.get(c2);
    const nr = nextRow.get(r2);
    const right = sides(r1, c2).r ?? (nc !== undefined ? sides(r1, nc).l : undefined);
    const bottom = sides(r2, c1).b ?? (nr !== undefined ? sides(nr, c1).t : undefined);
    const left = c1 === cols[0] ? sides(r1, c1).l : undefined;
    const top = r1 === rowNums[0] ? sides(r1, c1).t : undefined;
    const css = [right ? `border-right:${right}` : "", bottom ? `border-bottom:${bottom}` : "", left ? `border-left:${left}` : "", top ? `border-top:${top}` : ""].filter(Boolean).join(";");
    if (!css) return "";
    if (!borderClass.has(css)) borderClass.set(css, borderClass.size);
    return `b${borderClass.get(css)}`;
  };

  const head = `<thead><tr><th class="kwl-corner"></th>${cols.map((c) => `<th>${colName(c)}</th>`).join("")}</tr></thead>`;
  const body: string[] = [];
  let frozenTop = 22;
  for (const r of rowNums) {
    const row = rows.get(r);
    const hPx = row?.ht !== undefined ? Math.round(row.ht * (4 / 3)) : defRowPx;
    const frozen = r <= frozenRows;
    const tds: string[] = [];
    const spilled = new Set<number>();
    for (const c of cols) {
      const key = `${r}:${c}`;
      if (covered.has(key) || spilled.has(c)) continue;
      const xi = xfAt(r, c);
      const xf = st.xfs[xi];
      const cell = row?.cells.get(c);
      const v = cell ? cellValue(cell, xf, st, shared) : { html: "", text: "", kind: "" as const };
      const span = anchor.get(key);
      let cs = span?.cs ?? 1;
      let c2 = span?.c2 ?? c;
      // 不换行、靠左的文字溢到右边连着的空格子（与 Excel 一样不被截断）；有底色、边框或合并的格子不溢
      if (!span && v.kind === "t" && v.text && (!xf || (!xf.wrap && !xf.fill && (xf.h === "general" || xf.h === "left")))) {
        let need = textPx(v.text, 13) + 8 - px(c);
        let n = nextCol.get(c);
        while (need > 0 && n !== undefined && !hasValue(r, n) && !covered.has(`${r}:${n}`) && !anchor.has(`${r}:${n}`)) {
          const nx = st.xfs[xfAt(r, n)];
          if (nx && (nx.fill || Object.keys(nx.border).length > 0)) break;
          spilled.add(n);
          need -= px(n);
          cs++;
          c2 = n;
          n = nextCol.get(n);
        }
      }
      const cls = [xf?.css ? `x${xi}` : "", v.kind === "n" && (!xf || xf.h === "general") ? "kn" : "", v.kind === "c" && (!xf || xf.h === "general") ? "kc" : "", frozen ? "kf" : "", borderOf(r, c, span?.r2 ?? r, c2)].filter(Boolean).join(" ");
      const attrs = `${cls ? ` class="${cls}"` : ""}${cs > 1 ? ` colspan="${cs}"` : ""}${span && span.rs > 1 ? ` rowspan="${span.rs}"` : ""}${frozen || v.color ? ` style="${frozen ? `top:${frozenTop}px` : ""}${frozen && v.color ? ";" : ""}${v.color ? `color:${v.color}` : ""}"` : ""}`;
      tds.push(`<td${attrs}>${v.html}</td>`);
    }
    const rh = `<th class="kwl-rh"${frozen ? ` style="top:${frozenTop}px;z-index:3"` : ""}>${r}</th>`;
    body.push(`<tr style="height:${hPx}px">${rh}${tds.join("")}</tr>`);
    if (frozen) frozenTop += hPx;
  }
  const width = 40 + cols.reduce((n, c) => n + px(c), 0);
  const colgroup = `<colgroup><col style="width:40px">${cols.map((c) => `<col style="width:${px(c)}px">`).join("")}</colgroup>`;
  const notes = [
    truncated ? `<p class="kwl-note">（预览只显示每个表前 ${L.maxRows} 行、前 ${L.maxCols} 列，请下载查看全部）</p>` : "",
    colHidden.some(Boolean) || [...rows.values()].some((x) => x.hidden) ? `<p class="kwl-note">表里有隐藏的行或列，预览与 Excel 一样不显示。</p>` : "",
  ].join("");
  return { html: `<table class="kwl-grid${noGrid ? " kwl-nogrid" : ""}" style="width:${width}px">${colgroup}${head}<tbody>${body.join("")}</tbody></table>${notes}`, truncated };
}

/** 单元格显示值：共享 / 内联字符串（含富文本）、公式文字、布尔、错误值、数字（按数字格式，日期格按日期）。 */
function cellValue(cell: Cell, xf: Xf | undefined, st: SheetStyles, shared: SsItem[]): { html: string; text: string; kind: "" | "t" | "n" | "c"; color?: string } {
  const wrap = !!xf?.wrap;
  const flat = (s: string) => (wrap ? s : s.replace(/\r?\n|\r/g, " "));
  const v = /<v>([\s\S]*?)<\/v>/.exec(cell.inner)?.[1];
  const str = (item: SsItem | undefined) => {
    if (!item || !item.text) return { html: "", text: "", kind: "" as const };
    const html = item.runs ? item.runs.map((r) => (r.css ? `<span style="${r.css}">${esc(flat(r.t))}</span>` : esc(flat(r.t)))).join("") : esc(flat(item.text));
    return { html, text: flat(item.text), kind: "t" as const };
  };
  if (cell.t === "s") return str(shared[Number(v ?? -1)]);
  if (cell.t === "inlineStr") return str(stringItem(/<is>([\s\S]*?)<\/is>/.exec(cell.inner)?.[1] ?? "", st.pal, st.baseSz));
  if (v === undefined || v === "") return { html: "", text: "", kind: "" };
  const raw = xmlText(v);
  if (cell.t === "str") return str({ text: raw });
  if (cell.t === "b") return { html: raw === "1" ? "TRUE" : "FALSE", text: "", kind: "c" };
  if (cell.t === "e") return { html: esc(raw), text: "", kind: "c" };
  if (cell.t === "d") return { html: esc(raw.replace(/T00:00:00(?:\.0+)?Z?$/, "")), text: "", kind: "n" };
  const n = Number(raw);
  if (!Number.isFinite(n)) return str({ text: raw });
  if (xf?.kind) {
    // 日期格：中文写法（年月日、时分秒）照原格式；其他沿用 yyyy-mm-dd（第 59 批）
    const serial = n + (st.date1904 && xf.kind !== "time" && xf.kind !== "elapsed" ? 1462 : 0);
    const d = (/[年月日时分秒]/.test(xf.code) ? formatDateCode(serial, xf.code) : null) ?? excelDate(serial, xf.kind);
    if (d) return { html: esc(d), text: d, kind: "n" };
  }
  const f = formatNumber(n, xf?.code ?? "General");
  return { html: esc(f.text), text: f.text, kind: "n", ...(f.color ? { color: f.color } : {}) };
}

type FmtKind = "date" | "datetime" | "time" | "elapsed" | null;

/**
 * Excel 内置数字格式编号的类别：14–17 日期、22 日期时间、18–21 与 45、47 时间、46 累计时长（[h]:mm:ss）；
 * 27–36、50–58 是中日韩区域的内置日期格式（如 yyyy"年"m"月"d"日"）。其余（含 0–13 数值、货币、百分比）都不是日期。
 */
function builtinKind(id: number): FmtKind {
  if (id >= 14 && id <= 17) return "date";
  if (id === 22) return "datetime";
  if ((id >= 18 && id <= 21) || id === 45 || id === 47) return "time";
  if (id === 46) return "elapsed";
  if ((id >= 27 && id <= 36) || (id >= 50 && id <= 58)) return "date";
  return null;
}

/**
 * 自定义格式的类别（复核 R2B-28：原判定把 [Red] 里的 d、[DBNum2] 里的 D 当成日期占位，金额被改写成日期）：
 * 只看第一段（正数段）；先去掉引号里的文字、反斜杠转义、方括号段（颜色、区域、DBNum；[h]/[m]/[s] 记为累计时长）、_x 与 *x 填充；
 * 含数字占位 0 # ? 的一律不是日期；y、d 是日期，m 与 h、s 相邻时是分钟、否则是月份。
 */
export function customFmtKind(code: string): FmtKind {
  let elapsed = false;
  const s = (code.split(";")[0] ?? "")
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/\[[^\]]*\]/g, (m) => {
      const e = /^\[(h+|m+|s+)\]$/i.test(m);
      if (e) elapsed = true;
      return e ? "h" : "";
    })
    .replace(/[_*]./g, "");
  if (/[0#?]/.test(s)) return null;
  const withoutMinutes = s.replace(/h+[^a-z]*m+|m+[^a-z]*s+/gi, "hh");
  const date = /[yd]/i.test(s) || /m/i.test(withoutMinutes);
  const time = /[hs]/i.test(s) || /AM\/PM|A\/P|上午\/下午/i.test(s);
  if (elapsed) return "elapsed";
  if (date && time) return "datetime";
  if (date) return "date";
  if (time) return "time";
  return null;
}

/** 序列号 → ISO 日期 / 时间（1900 日期系统；1904 日期系统的工作簿由调用方先加 1462 天）。 */
function excelDate(serial: number, kind: Exclude<FmtKind, null>): string | null {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) return null;
  const hms = (frac: number, total = false) => {
    const sec = Math.round(frac * 86400);
    const h = total ? Math.floor(sec / 3600) : Math.floor(sec / 3600) % 24;
    const mm = Math.floor((sec % 3600) / 60);
    const ss = sec % 60;
    return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}${ss ? `:${String(ss).padStart(2, "0")}` : ""}`;
  };
  if (kind === "elapsed") return hms(serial, true);
  if (kind === "time") return hms(serial % 1);
  if (serial < 1) return null;
  const iso = new Date(Math.round((serial - 25569) * 86400_000)).toISOString();
  return kind === "datetime" && serial % 1 !== 0 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}

/** 单元格样式序号 → 日期类别，与工作簿是否用 1904 日期系统（预览与文本提取共用）。 */
function dateStyles(styles: string, wb: string): { xfKind: FmtKind[]; date1904: boolean } {
  // cellXfs 的第 i 个 xf 的 numFmtId → 类别（内置编号查表；自定义格式按 customFmtKind 判定，自定义优先）
  const customKind = new Map<number, FmtKind>();
  for (const m of styles.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) customKind.set(Number(m[1]), customFmtKind(unescapeXml(m[2]!)));
  const xfKind: FmtKind[] = [];
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? "";
  for (const m of cellXfs.matchAll(/<xf\b([^>]*)/g)) {
    const id = Number(/numFmtId="(\d+)"/.exec(m[1]!)?.[1] ?? 0);
    xfKind.push(customKind.has(id) ? customKind.get(id)! : builtinKind(id));
  }
  // 1904 日期系统（Mac 旧工作簿）：序列号比 1900 系统小 1462 天
  return { xfKind, date1904: /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(wb) };
}

/** 数值单元格按样式转成日期 / 时间；不是日期格或转不了返回 null。 */
function cellDate(v: string, styleIndex: string | undefined, ds: { xfKind: FmtKind[]; date1904: boolean }): string | null {
  const kind = styleIndex !== undefined ? (ds.xfKind[Number(styleIndex)] ?? null) : null;
  if (!kind) return null;
  return excelDate(Number(v) + (ds.date1904 && kind !== "time" && kind !== "elapsed" ? 1462 : 0), kind);
}

/**
 * XLSX → 纯文字（第 13 批：材料导入，评审 Z1——选择对话框允许 xlsx，解析却不支持）：每个表以“【表名】”开头，
 * 每行单元格以制表符分隔；只取值（不算公式），共享字符串与内联字符串都认。上限：50 个表、每表 20,000 行、每行 200 列、总计 200 万字，
 * 超出即截断并返回 truncated（导入页如实提示）。
 * 复核处置（B13-O01/O02）：只解压工作簿、关系、共享字符串、样式与各表（图片等不解压，每个条目以声明大小为解压上限）；
 * 表名经 workbook.xml.rels 对应到表文件（调整过顺序的工作簿也不会对错）；日期格式的数值转成日期（转不了的保留数字并记 dates_raw）。
 */
export function xlsxToText(xlsx: Buffer): { text: string; sheets: number; truncated: boolean; dates_raw?: boolean } {
  const files = readZipSelected(xlsx, (n) => n === "xl/workbook.xml" || n === "xl/_rels/workbook.xml.rels" || n === "xl/sharedStrings.xml" || n === "xl/styles.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  // 共享字符串：拼音注音（<rPh>）不算正文（V41 第 67 批：日文、中文注音的工作簿原先把注音拼进了文字）
  const shared = sharedStrings(files.get("xl/sharedStrings.xml")?.toString("utf8")).map((x) => x.text);
  // 表名 → 表文件（经 rels 对应）
  const target = relTargets(files.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "");
  const wb = files.get("xl/workbook.xml")?.toString("utf8") ?? "";
  const ds = dateStyles(files.get("xl/styles.xml")?.toString("utf8") ?? "", wb);
  const sheets = [...wb.matchAll(/<sheet\b([^>]*)\/?>/g)].map((m, i) => {
    const name = unescapeXml(/\bname="([^"]*)"/.exec(m[1]!)?.[1] ?? `表${i + 1}`);
    const rid = /\br:id="([^"]*)"/.exec(m[1]!)?.[1];
    return { name, file: (rid && target.get(rid)) || `xl/worksheets/sheet${i + 1}.xml` };
  });
  const MAX_SHEETS = 50, MAX_ROWS = 20_000, MAX_COLS = 200, MAX_CHARS = 2_000_000;
  let truncated = sheets.length > MAX_SHEETS;
  let datesRaw = false;
  const out: string[] = [];
  let chars = 0;
  for (const sh of sheets.slice(0, MAX_SHEETS)) {
    if (chars >= MAX_CHARS) {
      truncated = true;
      break;
    }
    const xml = files.get(sh.file)?.toString("utf8");
    if (xml === undefined) continue;
    out.push(`【${sh.name}】`);
    const rowRe = /<row\b[\s\S]*?<\/row>|<row\b[^>]*\/>/g;
    let rows = 0;
    for (let m = rowRe.exec(xml); m; m = rowRe.exec(xml)) {
      if (++rows > MAX_ROWS) {
        truncated = true;
        break;
      }
      const cells: string[] = [];
      for (const c of m[0].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1]!;
        const inner = c[2] ?? "";
        const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
        const ci = ref ? colIndex(ref) : cells.length;
        if (ci >= MAX_COLS) {
          truncated = true;
          continue;
        }
        const t = /t="([^"]*)"/.exec(attrs)?.[1];
        let v = "";
        if (t === "s") v = shared[Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? -1)] ?? "";
        else if (t === "inlineStr") v = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => unescapeXml(x[1]!)).join("");
        else {
          v = unescapeXml(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "");
          const si = /\bs="(\d+)"/.exec(attrs)?.[1];
          if (v && (t === undefined || t === "n") && si !== undefined && ds.xfKind[Number(si)]) {
            const d = cellDate(v, si, ds);
            if (d) v = d;
            else datesRaw = true;
          }
        }
        while (cells.length < ci) cells.push("");
        cells[ci] = v.replace(/[\t\r\n]+/g, " ");
      }
      const line = cells.join("\t").replace(/\t+$/, "");
      if (!line) continue;
      out.push(line);
      chars += line.length + 1;
      if (chars >= MAX_CHARS) {
        truncated = true;
        break;
      }
    }
  }
  return { text: out.join("\n").slice(0, MAX_CHARS), sheets: Math.min(sheets.length, MAX_SHEETS), truncated, ...(datesRaw ? { dates_raw: true } : {}) };
}
