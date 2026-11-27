/**
 * 真实产品样式 → 片子用的作用域样式（v3）。
 * 输入：采集时从运行中的界面读出的全部样式表（scripts/capture 的 _styles.css，浏览器 CSSOM 序列化，和界面实际生效的完全一致）。
 * 片子里产品界面放在 1440×900 的 .kw 容器内渲染，所以：
 *  - :root / html / body 改写到 .kw 上；html.frameless.plat-darwin（Electron 桌面端在 <html> 打的类）→ .kw.frameless.plat-darwin；
 *  - 深色 [data-theme="dark"] → .kw.kw-dark；
 *  - 其余选择器一律加 .kw 前缀；vh / vw 按采集视口 1440×900 换算成像素。
 * 用法：node scripts/snap-css.mjs <_styles.css>
 */
import { readFileSync, writeFileSync } from "node:fs";
const src = readFileSync(process.argv[2], "utf8");
const VH = 9, VW = 14.4;
const units = (css) => css.replace(/(-?\d*\.?\d+)vh\b/g, (_, n) => `${+(n * VH).toFixed(2)}px`).replace(/(-?\d*\.?\d+)vw\b/g, (_, n) => `${+(n * VW).toFixed(2)}px`);

/** 找与 open 处“{”配对的“}”位置（跳过字符串）。 */
function matchBrace(s, open) {
  let d = 0, q = "";
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === "\\") i++; else if (c === q) q = ""; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === "{") d++;
    else if (c === "}" && --d === 0) return i;
  }
  return s.length - 1;
}
function scopeSel(sel) {
  return sel
    .split(/,(?![^(]*\))/)
    .map((x) => {
      let s = x.trim();
      if (!s) return s;
      // 开头的 html / :root / body（可带类、属性）→ .kw（深色、无边框等类保留在 .kw 上）
      const m = /^(html|:root|body)((?:\[[^\]]*\]|\.[\w-]+|:not\([^)]*\))*)(.*)$/.exec(s);
      if (m) {
        let quals = m[2].replace(/\[data-theme="?dark"?\]/g, ".kw-dark").replace(/:not\(\[data-theme="?dark"?\]\)/g, ":not(.kw-dark)");
        let rest = m[3];
        // html body …、html #root … 的第二段 body 也并到 .kw
        rest = rest.replace(/^\s+body\b/, "");
        return `.kw${quals}${rest}`;
      }
      if (/^\[data-theme="?dark"?\]/.test(s)) return s.replace(/^\[data-theme="?dark"?\]/, ".kw.kw-dark");
      if (s.startsWith("#root")) return `.kw ${s}`;
      return `.kw ${s}`;
    })
    .join(", ");
}
function scope(css) {
  let out = "", i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open < 0) break;
    const head = css.slice(i, open).trim();
    const close = matchBrace(css, open);
    const body = css.slice(open + 1, close);
    if (head.startsWith("@media") || head.startsWith("@supports") || head.startsWith("@layer") || head.startsWith("@container")) out += `${head} {\n${scope(body)}}\n`;
    else if (head.startsWith("@")) out += `${head} {${body}}\n`;
    else if (head) out += `${scopeSel(head)} {${body}}\n`;
    i = close + 1;
  }
  return out;
}
const css = `/* 快照自运行中的产品界面（scripts/capture，CSSOM 全量）——由 scripts/snap-css.mjs 生成，勿手改 */\n${units(scope(src))}`;
writeFileSync(new URL("../src/product/app.css", import.meta.url), css);
writeFileSync(new URL("../src/product/tokens.css", import.meta.url), "/* v3 起令牌并入 app.css（采集时的 CSSOM 已含 design-tokens） */\n");
console.log("product css:", css.length, "bytes");
