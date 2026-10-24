/**
 * 量取快照里元素的位置（1440×900 快照坐标），供镜头焦点与光标落点使用。
 * 用法：node scripts/measure.mjs <快照名> '<css 选择器>[@文字]' ...
 *   例：node scripts/measure.mjs w01-review 'button@接受首选' '.wb-doc'
 *   'scroll:<选择器>=<像素>' 先把该元素滚动到指定位置（超出时取最大值并打印实际值）
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const pw = require(process.env.PW ?? "/Users/wangzeyu/.nvm/versions/node/v26.8.1/lib/node_modules/playwright");
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const [name, ...sels] = process.argv.slice(2);
const mod = readFileSync(here(`../src/snaps/s_${name.replace(/[^a-zA-Z0-9]/g, (c) => (c.charCodeAt(0) > 127 ? c.charCodeAt(0).toString(16) : "_"))}.ts`), "utf8");
const snap = JSON.parse(mod.slice(mod.indexOf("export default ") + 15, mod.lastIndexOf(";")));
const cssText = ["../src/product/tokens.css", "../src/product/app.css", "../src/film.css"].map((p) => readFileSync(here(p), "utf8")).join("\n");
const b = await pw.chromium.launch();
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await p.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${cssText}</style></head><body style="margin:0"><div class="kw${snap.theme === "dark" ? " kw-dark" : ""}" style="position:absolute;left:0;top:0;width:1440px;height:900px;overflow:hidden;transform:translate(0px,0px)">${snap.html}</div></body></html>`);
await p.waitForTimeout(300);
for (const s of sels) {
  if (s.startsWith("scroll:")) {
    const [sel, v] = s.slice(7).split("=");
    console.log(s, "→", await p.evaluate(([sel, v]) => { const e = document.querySelector(sel); e.scrollTop = +v; return e.scrollTop; }, [sel, v]));
    continue;
  }
  const [sel, text] = s.split("@");
  const r = await p.evaluate(([sel, text]) => {
    let els = [...document.querySelectorAll(sel)];
    if (text) els = els.filter((e) => e.textContent.includes(text));
    els = els.filter((e) => !els.some((o) => o !== e && e.contains(o)));
    return els.slice(0, 4).map((e) => { const r = e.getBoundingClientRect(); return `[${Math.round(r.x)}, ${Math.round(r.y)}, ${Math.round(r.width)}, ${Math.round(r.height)}] ${e.tagName.toLowerCase()}.${[...e.classList].join(".")} “${e.textContent.trim().slice(0, 24)}”`; });
  }, [sel, text]);
  console.log(`${s}\n  ${r.join("\n  ") || "（没找到）"}`);
}
await b.close();
