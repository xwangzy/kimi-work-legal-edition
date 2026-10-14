/**
 * 预览样式的清洗（复核 S5-B15）：按“有疑即去”判断——先去掉注释、解开 CSS 转义（\75 rl( 之类写法），再检查是否含外部引用：
 * url() 只允许 data:image / data:font；image-set()、-webkit-image-set()、image()、cross-fade()、element()、src()、@import、
 * expression()、-moz-binding、behavior 一律视为可疑。可疑的样式属性整条去掉、可疑的样式表整块清空（不逐条修补）。
 * 纯函数（不依赖 DOM），可在 Node 下单测；隔离框架与预览 CSP、主进程网络层另有两层独立拦截。
 */

function decodeCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_m, h: string) => {
      const cp = parseInt(h, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    })
    .replace(/\\([\s\S])/g, "$1");
}

const RISKY_FUNCTIONS = /(?:@import|(?:-webkit-)?image-set\s*\(|\bimage\s*\(|cross-fade\s*\(|\belement\s*\(|\bsrc\s*\(|expression\s*\(|-moz-binding|\bbehavior\s*:)/i;

function isDataUrl(v: string): boolean {
  return /^\s*data:(image|font)\//i.test(v);
}

/** 样式文本是否含外部引用（或无法判断的写法）。 */
export function cssHasExternalRef(css: string): boolean {
  const d = decodeCss(css);
  if (RISKY_FUNCTIONS.test(d)) return true;
  const opens = d.match(/url\s*\(/gi)?.length ?? 0;
  const urls = [...d.matchAll(/url\s*\(\s*(['"]?)([\s\S]*?)\1\s*\)/gi)];
  if (urls.length !== opens) return true; // 未闭合或拆开的 url(
  return urls.some((m) => !isDataUrl(m[2] ?? ""));
}

/** 清洗一段样式：含外部引用即整段去掉，否则原样保留。 */
export function scrubCss(css: string): string {
  return cssHasExternalRef(css) ? "" : css;
}
