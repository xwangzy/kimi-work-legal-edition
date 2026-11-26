/**
 * Agent 产物的安全预览（v9 第 04 篇 §1.2 约束 3、§5.1 ③：渲染进程 CSP 起步 default-src 'none'，Agent 产物 HTML 在无网隔离框架中预览；第 06 篇 T07）。
 *
 * 三层，各自独立：
 * 1. 清洗：DOMParser 解析为惰性文档（不加载资源、不执行脚本），去掉脚本、框架、嵌入、base、link、meta（刷新跳转）、表单，
 *    事件属性与一切非 data: 的外部引用；含外部引用的样式（解开转义后判断，见 css-scrub.ts）整条去掉；链接改为不可点击的文字（地址放在 title）；
 * 2. 隔离：iframe sandbox=""（不执行脚本、不同源、不能提交表单、不能弹窗、不能导航顶层）；
 * 3. 策略：文档首部注入 CSP（只允许内联样式与 data: 图片、字体、媒体），与父页面继承来的策略叠加；
 * 桌面主进程另在网络层拦截渲染会话的一切非本机请求（electron/main.cjs）。
 */

import { TOKEN_RE } from "./tokens.ts";
import { scrubCss } from "./css-scrub.ts";
import { scanMarks } from "./cite-scan.ts";

export { scrubCss };

/**
 * 预览框架的身份（第 62 批“安装包里 Word 预览空白”根因修复）：内容一变就换一个新的 iframe 元素，绝不在同一个框架上改 srcdoc。
 *
 * 根因（Electron 44.5.1 / Chromium，已在已安装的正式包与最小复现里证实）：sandbox="" 的 srcdoc 框架是不透明来源，
 * 由独立渲染进程承载（跨进程框架）。框架插入后首次导航提交前（实测约 50 毫秒内）再改 srcdoc 触发第二次导航，
 * 该框架此后永远不再出图——文档已完整载入（可查到正文与样式），但父页面合成里一片空白，再改 srcdoc 也救不回来；
 * 换成新元素立即正常。安装包里内核走 IPC，代号表与引用角标在 HTML 到达后几毫秒内就到，srcDoc 随之连变两三次，正好落进这个窗口；
 * 开发形态走 HTTP 开发桥、到得慢，所以只在安装包里稳定出现。
 * 做法：用内容摘要作 React key——内容不变不重挂（不闪烁），内容一变就是新框架、各自只做一次初始导航。
 */
export function previewFrameKey(srcDoc: string): string {
  // FNV-1a 32 位（只作身份区分，不作安全用途）+ 长度，碰撞概率可忽略
  let h = 0x811c9dc5;
  for (let i = 0; i < srcDoc.length; i++) {
    h ^= srcDoc.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16).padStart(8, "0")}-${srcDoc.length}`;
}

export const PREVIEW_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:; form-action 'none'; base-uri 'none'";

const DROP_ELEMENTS = [
  "script", "noscript", "iframe", "frame", "frameset", "object", "embed", "applet", "base", "link", "meta", "form", "portal", "template", "audio", "video", "source", "track",
];
const URL_ATTRS = ["href", "src", "srcset", "xlink:href", "action", "formaction", "poster", "background", "ping", "data", "codebase", "cite", "longdesc", "usemap", "manifest"];

function isDataUrl(v: string): boolean {
  return /^\s*data:(image|font)\//i.test(v);
}

/**
 * Word 成果的纸面版式（V41 第 67 批 §2.8：取消米黄纸色）：中性浅灰画布（--bg-muted 浅色值）上一张纯白 A4 纸（宽 794px 内随可用宽度缩，
 * 比例 210:297、内容多了往下长），细描边（--border-subtle）+ 轻阴影（--shadow-sm），页边距约 72px（窄时收小），四周画布留 24～32px（窄时收小）；
 * 正文衬线（--font-doc）16px / 1.75、段距 4px（与打印出来的文书相近；旧版内核输出没有段距规则时也按这个排）。
 * 框架内取不到本页令牌：颜色值手抄自 tokens.css，style-tokens.test.ts 核对相等。
 */
const PAPER_STYLE = "html,body{background:#f4f3f2;}body{margin:0;padding:32px 28px 48px;font-family:'Source Han Serif SC','Noto Serif CJK SC','Songti SC',SimSun,serif;font-size:16px;line-height:1.75;color:#1f1d1a;}.kwl-paper{box-sizing:border-box;max-width:794px;aspect-ratio:210/297;margin:0 auto;padding:72px;background:#ffffff;border:1px solid #eeebe7;box-shadow:0 1px 6px rgba(14,18,25,0.06);overflow-wrap:break-word;}.kwl-paper p{margin:0 0 4px;}.kwl-paper h2,.kwl-paper h3,.kwl-paper h4{line-height:1.5;}@media (max-width:760px){body{padding:24px 20px 32px;}.kwl-paper{padding:48px 40px;}}@media (max-width:520px){body{padding:12px 10px 24px;}.kwl-paper{padding:28px 20px;}}";

/**
 * Excel 成果的表格版式（V41 第 67 批 §2.8：表格是表格，不套文书纸面）：白底、无边距、无衬线（等线 / 微软雅黑 / 苹方）13px，
 * 表格本身（列宽、合并、对齐、底色、边框、固定的列号行号）由内核输出的样式排，框架里可横向、纵向滚动，不压缩列宽。
 * 后半是旧版内核输出（没有 kwl-grid 的平铺表格）的兜底：中文不在字间断行、表头不折行，表格宽于框架时横向滚动（“证据编号”不再一字一行）。
 */
const SHEET_STYLE = "html,body{background:#ffffff;}body{margin:0;font-family:Calibri,'Segoe UI',BlinkMacSystemFont,'Helvetica Neue',DengXian,'等线','Microsoft YaHei','微软雅黑','PingFang SC','Hiragino Sans GB',Arial,sans-serif;font-size:13px;line-height:1.4;color:#0e1219;}table:not(.kwl-grid){border-collapse:collapse;margin:0;}table:not(.kwl-grid) td,table:not(.kwl-grid) th{border:1px solid #e3dfda;padding:3px 8px;vertical-align:top;word-break:keep-all;overflow-wrap:break-word;}table:not(.kwl-grid) th{background:#f4f3f2;white-space:nowrap;text-align:left;font-weight:600;}";

/** 预览框架的基础样式（框架内取不到本页令牌：颜色值手抄自 tokens.css 的 --p-ink、--p-white、--p-blue-600，style-tokens.test.ts 核对相等）。 */
const BASE_STYLE = "body{font-family:'Segoe UI','Microsoft YaHei UI','Microsoft YaHei',-apple-system,'PingFang SC',sans-serif;font-size:14px;line-height:1.7;color:#0e1219;background:#ffffff;margin:16px;} .kwl-link{color:#0a66d1;text-decoration:underline dotted;cursor:default;} img{max-width:100%;} .kwl-cite{font-size:11px;font-weight:600;padding:0 2px;border-radius:4px;cursor:help;} .kwl-cite-red{color:#b42318;} .kwl-cite-orange{color:#b54708;} .kwl-cite-gray{color:#8f8a84;} .kwl-cite-confirmed{color:#5925dc;} .kwl-cite-ack{color:#0e1219;border:1px solid #8f8a84;}";

/** 成果预览里的引用角标（v9.4 第 20 批 C-03）：raw 第 n 次出现处加角标，颜色取三层里最弱的一层，悬停（title）看三层状态与原文。 */
export interface PreviewCite {
  raw: string;
  /** 本处引用在成果里第几次出现（与内核 key 的 #n 一致）。 */
  nth: number;
  mark: string;
  tone: "red" | "gray" | "orange" | "confirmed" | "ack";
  title: string;
}

/**
 * 把内核的 Excel 预览拆成一张张工作表（V41 第 67 批：隔离框架不执行脚本，表签只能放在框架外，一次只给框架一张表）。
 * 认新版的 section.kwl-sheet（data-sheet-name 为表名）与旧版的 section > h3（表名）两种写法；样式块每张表都带上，表后的说明（截断、隐藏表）附在每张表后。
 * 只按内核输出的结构切分，每一份仍整份经 buildPreviewDoc 清洗；拆不出表（不是表格预览）返回 null。
 */
export interface PreviewSheet {
  name: string;
  html: string;
}
const decodeAttr = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
export function splitSheets(html: string): { head: string; sheets: PreviewSheet[]; tail: string } | null {
  const STYLE = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
  const sheets: PreviewSheet[] = [];
  let end = -1;
  for (const m of html.matchAll(/<section class="kwl-sheet" data-sheet-name="([^"]*)">([\s\S]*?)<\/section>|<section>\s*<h3>([\s\S]*?)<\/h3>([\s\S]*?)<\/section>/g)) {
    if (m[1] !== undefined) sheets.push({ name: decodeAttr(m[1]), html: `<section class="kwl-sheet">${m[2]}</section>` });
    else sheets.push({ name: decodeAttr(m[3]!.replace(/<[^>]*>/g, "")), html: `<section>${m[4]}</section>` });
    end = m.index! + m[0].length;
  }
  if (sheets.length === 0) return null;
  return { head: (html.match(STYLE) ?? []).join(""), sheets, tail: html.slice(end).replace(STYLE, "") };
}

/**
 * 清洗并包装为预览文档（返回 srcdoc 字符串）；给出代号表时按文本节点还原（只在隔离框架内显示）。
 * paper：Word 纸面（正文包进 .kwl-paper）；sheet：Excel 表格版式；citePrefix：分表显示时排在本表之前的各表（只用来接着数引用出现到第几次，不显示）。
 */
export function buildPreviewDoc(html: string, tokenMap?: Map<string, string | null>, o: { paper?: boolean; sheet?: boolean; cites?: PreviewCite[]; citePrefix?: string } = {}): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const tag of DROP_ELEMENTS) for (const el of Array.from(doc.querySelectorAll(tag))) el.remove();
  for (const a of Array.from(doc.querySelectorAll("a[href]"))) a.setAttribute("data-kwl-href", a.getAttribute("href") ?? "");
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === "style") {
        const v = scrubCss(attr.value);
        if (v) el.setAttribute("style", v);
        else el.removeAttribute(attr.name);
        continue;
      }
      if (URL_ATTRS.includes(name) && !(name === "src" && el.tagName === "IMG" && isDataUrl(attr.value))) el.removeAttribute(attr.name);
    }
    if (el.tagName === "A") {
      // 链接不可点击：只显示文字，地址放在 title（不打开、不导航）
      const span = doc.createElement("span");
      span.className = "kwl-link";
      const href = (el as HTMLAnchorElement).getAttribute("data-kwl-href");
      if (href) span.title = href;
      span.append(...Array.from(el.childNodes));
      el.replaceWith(span);
    }
  }
  for (const st of Array.from(doc.querySelectorAll("style"))) st.textContent = scrubCss(st.textContent ?? "");
  if (tokenMap && tokenMap.size > 0 && doc.body) {
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.nodeValue ?? "";
      if (t.includes("〔")) n.nodeValue = t.replace(TOKEN_RE, (m) => tokenMap.get(m) ?? m);
    }
  }
  // 引用角标：只在单个文字节点里找得到的引用上加（跨格式片段拆开的找不到就不加，右栏列表仍然完整）；引用原文里没有代号，放在代号还原之后
  if (o.cites && o.cites.length > 0 && doc.body) {
    const byRaw = new Map<string, PreviewCite[]>();
    for (const c of o.cites) byRaw.set(c.raw, [...(byRaw.get(c.raw) ?? []), c]);
    const seen = new Map<string, number>();
    const raws = [...byRaw.keys()].sort((a, b) => b.length - a.length);
    if (o.citePrefix) {
      // 前面各表里的出现次数先数上（与内核按整份成果数的第 n 次对齐），本表的角标才落在对的那一处
      const pre = new DOMParser().parseFromString(o.citePrefix, "text/html");
      const pw = pre.createTreeWalker(pre.body, NodeFilter.SHOW_TEXT);
      for (let n = pw.nextNode(); n; n = pw.nextNode()) {
        let t = n.nodeValue ?? "";
        if (tokenMap && tokenMap.size > 0 && t.includes("〔")) t = t.replace(TOKEN_RE, (m) => tokenMap.get(m) ?? m);
        if (raws.some((r) => t.includes(r))) scanMarks(t, raws, seen);
      }
    }
    const nodes: Text[] = [];
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
    for (const node of nodes) {
      const text = node.nodeValue ?? "";
      if (!raws.some((r) => text.includes(r))) continue;
      const frag = doc.createDocumentFragment();
      let last = 0;
      for (const h of scanMarks(text, raws, seen)) {
        frag.append(doc.createTextNode(text.slice(last, h.end)));
        const c = byRaw.get(h.raw)!.find((x) => x.nth === h.nth);
        if (c) {
          const sup = doc.createElement("sup");
          sup.className = `kwl-cite kwl-cite-${c.tone}`;
          sup.title = c.title;
          sup.textContent = c.mark;
          frag.append(sup);
        }
        last = h.end;
      }
      frag.append(doc.createTextNode(text.slice(last)));
      node.replaceWith(frag);
    }
  }
  const inner = doc.body?.innerHTML ?? "";
  const body = o.paper && !o.sheet ? `<div class="kwl-paper">${inner}</div>` : inner;
  const styles = Array.from(doc.head?.querySelectorAll("style") ?? [])
    .map((s) => `<style>${s.textContent ?? ""}</style>`)
    .join("");
  return [
    "<!doctype html><html><head>",
    `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`,
    '<meta charset="utf-8">',
    `<style>${BASE_STYLE}</style>`,
    o.sheet ? `<style>${SHEET_STYLE}</style>` : o.paper ? `<style>${PAPER_STYLE}</style>` : "",
    styles,
    "</head><body>",
    body,
    "</body></html>",
  ].join("");
}
