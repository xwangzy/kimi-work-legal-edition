/**
 * Word 成果导出 PDF 用的打印页（第 29 批）：律师指定要 PDF 时，桌面端主进程把这张页面交给 Chromium 打印成 PDF。
 *
 * 与应用内预览（render-html.ts）不同，这里按文书本身的版式排：页面大小与页边距取文件的 sectPr，段落的对齐、首行缩进、行距、
 * 字体（仿宋 / 黑体 / 宋体 / 楷体）、字号与加粗取段落样式（含 basedOn 与文档缺省）和段落、文字的直接格式，Word 自动编号照显示写出，
 * 表格画框线。只排“可见文字”：修订稿须先接受修订（调用方只放行没有修订痕迹的文件），批注不打印。
 * 输出只含白名单元素与内联样式，不带脚本、链接与外部资源；文字一律 HTML 转义。
 */
import { readZipSelected } from "./zip.ts";
import { unescapeXml } from "./textmap.ts";
import { paragraphListLabels } from "./numbering.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const attr = (xml: string, tag: string, name = "val"): string | null => new RegExp(`<w:${tag}\\b[^>]*\\bw:${name}="([^"]*)"`).exec(xml)?.[1] ?? null;

interface Fmt {
  jc?: string;
  firstLineChars?: number;
  firstLine?: number;
  left?: number;
  line?: number;
  lineRule?: string;
  before?: number;
  after?: number;
  font?: string;
  size?: number;
  bold?: boolean;
}

function pFmt(pPr: string): Fmt {
  const f: Fmt = {};
  const jc = attr(pPr, "jc");
  if (jc) f.jc = jc;
  const ind = /<w:ind\b[^>]*\/?>/.exec(pPr)?.[0];
  if (ind) {
    const fc = attr(ind, "ind", "firstLineChars");
    const fl = attr(ind, "ind", "firstLine");
    const left = attr(ind, "ind", "left") ?? attr(ind, "ind", "start");
    if (fc !== null) f.firstLineChars = Number(fc);
    if (fl !== null) f.firstLine = Number(fl);
    if (left !== null) f.left = Number(left);
  }
  const sp = /<w:spacing\b[^>]*\/?>/.exec(pPr)?.[0];
  if (sp) {
    const line = attr(sp, "spacing", "line");
    if (line !== null) f.line = Number(line);
    const rule = attr(sp, "spacing", "lineRule");
    if (rule) f.lineRule = rule;
    const b = attr(sp, "spacing", "before");
    const a = attr(sp, "spacing", "after");
    if (b !== null) f.before = Number(b);
    if (a !== null) f.after = Number(a);
  }
  return f;
}

function rFmt(rPr: string): Fmt {
  const f: Fmt = {};
  const font = attr(rPr, "rFonts", "eastAsia") ?? attr(rPr, "rFonts", "ascii");
  if (font) f.font = font;
  const sz = attr(rPr, "sz");
  if (sz !== null) f.size = Number(sz);
  if (/<w:b\b(?![^>]*w:val="(?:0|false)")[^>]*\/>/.test(rPr)) f.bold = true;
  else if (/<w:b\b[^>]*w:val="(?:0|false)"/.test(rPr)) f.bold = false;
  return f;
}

/** styles.xml → 段落样式的合并格式（basedOn 链，越近越优先）与文档缺省。 */
function styleTable(xml: string | null): { defaults: Fmt; styles: Map<string, Fmt>; defaultStyle: string | null } {
  const raw = new Map<string, { basedOn: string | null; fmt: Fmt }>();
  let defaults: Fmt = {};
  let defaultStyle: string | null = null;
  if (xml) {
    const dd = /<w:docDefaults>([\s\S]*?)<\/w:docDefaults>/.exec(xml)?.[1] ?? "";
    defaults = { ...pFmt(/<w:pPrDefault>([\s\S]*?)<\/w:pPrDefault>/.exec(dd)?.[1] ?? ""), ...rFmt(/<w:rPrDefault>([\s\S]*?)<\/w:rPrDefault>/.exec(dd)?.[1] ?? "") };
    for (const m of xml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
      if (!/w:type="paragraph"/.test(m[1]!)) continue;
      const id = /w:styleId="([^"]*)"/.exec(m[1]!)?.[1];
      if (!id) continue;
      if (/w:default="1"/.test(m[1]!)) defaultStyle = id;
      const body = m[2]!;
      raw.set(id, {
        basedOn: attr(body, "basedOn"),
        fmt: { ...pFmt(/<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(body)?.[1] ?? ""), ...rFmt(/<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(body)?.[1] ?? "") },
      });
    }
  }
  const styles = new Map<string, Fmt>();
  const resolve = (id: string, depth = 0): Fmt => {
    if (styles.has(id)) return styles.get(id)!;
    const s = raw.get(id);
    if (!s || depth > 20) return {};
    const merged = { ...(s.basedOn ? resolve(s.basedOn, depth + 1) : {}), ...s.fmt };
    styles.set(id, merged);
    return merged;
  };
  for (const id of raw.keys()) resolve(id);
  return { defaults, styles, defaultStyle };
}

/** 中文字体名 → CSS 字体栈（Windows 与 macOS 都有对应字体；单引号，写进 style 属性不截断）。 */
function fontStack(font: string | undefined): string {
  const f = font ?? "";
  if (/仿宋|FangSong/i.test(f)) return `'FangSong','仿宋','FangSong_GB2312','仿宋_GB2312','STFangsong',serif`;
  if (/黑体|SimHei|Heiti/i.test(f)) return `'SimHei','黑体','Heiti SC','STHeiti','PingFang SC',sans-serif`;
  if (/楷体|KaiTi/i.test(f)) return `'KaiTi','楷体','KaiTi_GB2312','STKaiti',serif`;
  return `'SimSun','宋体','Songti SC','STSong','Times New Roman',serif`;
}

const pt = (halfPoints: number) => `${halfPoints / 2}pt`;
const twipPt = (tw: number) => `${tw / 20}pt`;

function css(f: Fmt): string {
  const out: string[] = [];
  if (f.jc) out.push(`text-align:${f.jc === "center" ? "center" : f.jc === "right" || f.jc === "end" ? "right" : f.jc === "both" || f.jc === "distribute" ? "justify" : "left"}`);
  if (f.firstLineChars !== undefined) out.push(`text-indent:${f.firstLineChars / 100}em`);
  else if (f.firstLine !== undefined) out.push(`text-indent:${twipPt(f.firstLine)}`);
  if (f.left) out.push(`margin-left:${twipPt(f.left)}`);
  if (f.line !== undefined) out.push(f.lineRule === "exact" || f.lineRule === "atLeast" ? `line-height:${twipPt(f.line)}` : `line-height:${(f.line / 240).toFixed(2)}`);
  out.push(`margin-top:${twipPt(f.before ?? 0)}`, `margin-bottom:${twipPt(f.after ?? 0)}`);
  if (f.font) out.push(`font-family:${fontStack(f.font)}`);
  if (f.size) out.push(`font-size:${pt(f.size)}`);
  if (f.bold !== undefined) out.push(`font-weight:${f.bold ? "bold" : "normal"}`);
  return out.join(";");
}

/** 段落的文字（可见文字：删除的不要），按 run 带上加粗、字体与字号的差异。 */
function runsHtml(pXml: string, base: Fmt): string {
  let html = "";
  const visible = pXml.replace(/<w:(del|moveFrom)\b[^>]*>[\s\S]*?<\/w:\1>/g, "").replace(/<w:pPr>[\s\S]*?<\/w:pPr>/, "");
  for (const r of visible.matchAll(/<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g)) {
    const rPr = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(r[1]!)?.[1] ?? "";
    const f = rFmt(rPr);
    let text = "";
    for (const t of r[1]!.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/g)) {
      if (t[0].startsWith("<w:tab")) text += "\u2003\u2003";
      else if (t[0].startsWith("<w:br")) text += "\n";
      else text += unescapeXml(t[1] ?? "");
    }
    if (!text) continue;
    const diff: Fmt = {};
    if (f.bold !== undefined && f.bold !== (base.bold ?? false)) diff.bold = f.bold;
    if (f.font && f.font !== base.font) diff.font = f.font;
    if (f.size && f.size !== base.size) diff.size = f.size;
    const body = esc(text).replace(/\n/g, "<br>");
    const style = [diff.bold !== undefined ? `font-weight:${diff.bold ? "bold" : "normal"}` : "", diff.font ? `font-family:${fontStack(diff.font)}` : "", diff.size ? `font-size:${pt(diff.size)}` : ""].filter(Boolean).join(";");
    html += style ? `<span style="${style}">${body}</span>` : body;
  }
  return html;
}

/**
 * DOCX → 打印用的完整 HTML 页面（A4 或文件里的纸张，文件里的页边距）。title 写进 <title>（PDF 的文档标题）。
 * 有修订痕迹的文件抛错：PDF 只能从接受修订后的文本生成（修订稿请用清洁稿导出）。
 */
export function renderDocxPrintHtml(docx: Buffer, title: string): string {
  const files = readZipSelected(docx, (n) => n === "word/document.xml" || n === "word/styles.xml" || n === "word/numbering.xml");
  const raw = files.get("word/document.xml")?.toString("utf8");
  if (!raw) throw new Error("DOCX 缺少 word/document.xml");
  // 空段落写成 <w:p …/> 的展开成一对标签：编号按段落逐个计，与下面逐段排版的次序一一对应
  const xml = raw.replace(/<w:p\b([^>]*?)\/>/g, "<w:p$1></w:p>");
  if (/<w:(ins|del|moveFrom|moveTo)\b/.test(xml)) throw new Error("文件带修订痕迹：请先接受修订（或用清洁稿）再导出 PDF");
  const { defaults, styles, defaultStyle } = styleTable(files.get("word/styles.xml")?.toString("utf8") ?? null);
  const labels = paragraphListLabels(xml, files.get("word/numbering.xml")?.toString("utf8") ?? null, files.get("word/styles.xml")?.toString("utf8") ?? null);
  // 段落序号与编号的计号口径一致：全文 <w:p> 按出现次序，表格里的也算
  let pIndex = 0;
  const paragraph = (pXml: string): string => {
    const label = labels[pIndex++] ?? null;
    const pPr = /<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(pXml)?.[1] ?? "";
    const styleId = attr(pPr.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, ""), "pStyle") ?? defaultStyle;
    const fmt: Fmt = { ...defaults, ...(styleId ? (styles.get(styleId) ?? {}) : {}), ...pFmt(pPr.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, "")) };
    const body = runsHtml(pXml, fmt);
    const text = (label ? `${esc(label)} ` : "") + body;
    return `<p style="${css(fmt)}">${text || "&nbsp;"}</p>`;
  };
  const bodyXml = /<w:body>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;
  const parts: string[] = [];
  for (const b of bodyXml.matchAll(/<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g)) {
    const blk = b[0];
    if (blk.startsWith("<w:tbl")) {
      const rows = (blk.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) ?? []).map(
        (tr) => `<tr>${(tr.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) ?? []).map((tc) => `<td>${(tc.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? []).map(paragraph).join("")}</td>`).join("")}</tr>`,
      );
      parts.push(`<table>${rows.join("")}</table>`);
      continue;
    }
    parts.push(paragraph(blk));
  }
  // 纸张与页边距：取最后一个 sectPr（缺省 A4、公文页边距）
  const sect = [...xml.matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)].at(-1)?.[0] ?? "";
  const w = Number(attr(sect, "pgSz", "w") ?? 11906);
  const h = Number(attr(sect, "pgSz", "h") ?? 16838);
  const mar = (k: string, d: number) => twipPt(Number(attr(sect, "pgMar", k) ?? d));
  const page = `@page{size:${twipPt(w)} ${twipPt(h)};margin:${mar("top", 2098)} ${mar("right", 1474)} ${mar("bottom", 1984)} ${mar("left", 1587)}}`;
  const base = `html,body{margin:0;padding:0;color:#000;background:#fff}body{font-family:${fontStack(defaults.font)};font-size:${pt(defaults.size ?? 24)}}p{orphans:2;widows:2;white-space:pre-wrap;word-break:break-all}table{border-collapse:collapse;width:100%;margin:6pt 0;page-break-inside:auto}td{border:0.5pt solid #000;padding:2pt 4pt;vertical-align:top}td p{text-indent:0 !important}tr{page-break-inside:avoid}`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${esc(title)}</title><style>${page}${base}</style></head><body>${parts.join("\n")}</body></html>`;
}
