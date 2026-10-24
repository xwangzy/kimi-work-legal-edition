/**
 * 快照真实产品样式：platform 的 design-tokens 与桌面端 styles.css → src/product/。
 * 片子里产品界面放在 1440×900 的 .kw 容器内渲染，所以：
 *  - :root / html / body / #root 改写到 .kw 上；深色主题 :root[data-theme="dark"] → .kw.kw-dark；
 *  - vh / vw 按采集视口 1440×900 换算成像素（片场视口是 1920×1080）。
 * 用法：node scripts/snap-css.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const rev = execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim();
const VH = 9, VW = 14.4;
const units = (css) => css.replace(/(-?\d*\.?\d+)vh\b/g, (_, n) => `${+(n * VH).toFixed(2)}px`).replace(/(-?\d*\.?\d+)vw\b/g, (_, n) => `${+(n * VW).toFixed(2)}px`);
const scope = (css) =>
  css
    .replace(/:root\[data-theme="dark"\]/g, ".kw.kw-dark")
    .replace(/:root\b/g, ".kw")
    .replace(/html,\s*body,\s*#root\s*\{/g, ".kw, .kw #root {")
    .replace(/(^|\n)body\s*\{/g, "$1.kw {")
    .replace(/(^|\n)body\s+/g, "$1.kw ");
const head = (src) => `/* 快照自 ${src} @ ${rev}（scripts/snap-css.mjs 生成，勿手改）——宣传片界面直接用真实产品样式 */\n`;
const tokens = "platform/packages/design-tokens/src/tokens.css";
const styles = "platform/apps/desktop/src/styles.css";
writeFileSync(new URL("../src/product/tokens.css", import.meta.url), head(tokens) + units(scope(readFileSync(ROOT + tokens, "utf8"))));
writeFileSync(new URL("../src/product/app.css", import.meta.url), head(styles) + units(scope(readFileSync(ROOT + styles, "utf8"))));
console.log("product css @", rev);
