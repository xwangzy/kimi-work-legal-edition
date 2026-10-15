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

export { scrubCss };

export const PREVIEW_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:; form-action 'none'; base-uri 'none'";

const DROP_ELEMENTS = [
  "script", "noscript", "iframe", "frame", "frameset", "object", "embed", "applet", "base", "link", "meta", "form", "portal", "template", "audio", "video", "source", "track",
];
const URL_ATTRS = ["href", "src", "srcset", "xlink:href", "action", "formaction", "poster", "background", "ping", "data", "codebase", "cite", "longdesc", "usemap", "manifest"];

function isDataUrl(v: string): boolean {
  return /^\s*data:(image|font)\//i.test(v);
}

/** 清洗并包装为预览文档（返回 srcdoc 字符串）；给出代号表时按文本节点还原（只在隔离框架内显示）。 */
/** 文书纸面版式（v9.2 §4.4；Y4 §5 D-8、#31）：衬线正文、较大字号与行距、纸面底色——用于 Word/Excel 成果预览。 */
const PAPER_STYLE = "body{font-family:'Source Han Serif SC','Noto Serif CJK SC','Songti SC',SimSun,serif;font-size:16px;line-height:1.9;color:#1f1d1a;background:#fffdf9;margin:24px 40px;}";

export function buildPreviewDoc(html: string, tokenMap?: Map<string, string | null>, o: { paper?: boolean } = {}): string {
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
  const body = doc.body?.innerHTML ?? "";
  const styles = Array.from(doc.head?.querySelectorAll("style") ?? [])
    .map((s) => `<style>${s.textContent ?? ""}</style>`)
    .join("");
  return [
    "<!doctype html><html><head>",
    `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`,
    '<meta charset="utf-8">',
    "<style>body{font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;font-size:14px;line-height:1.7;color:#0e1219;margin:16px;} .kwl-link{color:#167ffb;text-decoration:underline dotted;cursor:default;} img{max-width:100%;}</style>",
    o.paper ? `<style>${PAPER_STYLE}</style>` : "",
    styles,
    "</head><body>",
    body,
    "</body></html>",
  ].join("");
}
