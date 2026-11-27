// 宣传片 V4 采集公用：Playwright 打开采集栈界面（1440×900），每个状态存一张截图（检查用）+ 一份 DOM 快照（片子用）。
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_PATH ?? "/Users/wangzeyu/.nvm/versions/node/v26.8.1/lib/node_modules/playwright");
export const BASE = `http://127.0.0.1:${process.env.FILM_WEB_PORT ?? "5261"}/`;

export async function open(out, { dark = false } = {}) {
  mkdirSync(out, { recursive: true });
  const b = await pw.chromium.launch();
  const c = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN", timezoneId: "Asia/Shanghai", colorScheme: dark ? "dark" : "light" });
  const p = await c.newPage();
  p.on("pageerror", (e) => console.log("pageerror", e.message.split("\n")[0]));
  const dump = () =>
    p.evaluate(async () => {
      document.querySelectorAll("textarea").forEach((t) => { t.textContent = t.value; });
      document.querySelectorAll("input").forEach((i) => { if (i.type === "checkbox" || i.type === "radio") { if (i.checked) i.setAttribute("checked", ""); else i.removeAttribute("checked"); } else i.setAttribute("value", i.value); });
      document.querySelectorAll("select").forEach((s) => { [...s.options].forEach((o) => { if (o.selected) o.setAttribute("selected", ""); else o.removeAttribute("selected"); }); });
      document.querySelectorAll("details").forEach((d) => { if (d.open) d.setAttribute("open", ""); });
      // 滚动位置记成属性（片子里用位移还原）
      document.querySelectorAll("*").forEach((e) => { if (e.scrollTop > 0) e.setAttribute("data-film-scroll", String(e.scrollTop)); else e.removeAttribute("data-film-scroll"); });
      // 图片内联成 data URI（快照离开开发服务器也能显示）
      const toData = async (src) => { const r = await fetch(src); const bl = await r.blob(); return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(bl); }); };
      for (const img of document.querySelectorAll("img")) { const s = img.getAttribute("src"); if (s && !s.startsWith("data:")) { try { img.setAttribute("src", await toData(img.src)); } catch {} } }
      return { theme: document.documentElement.getAttribute("data-theme") ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"), htmlClass: document.documentElement.className, bodyClass: document.body.className, html: document.body.innerHTML, url: location.hash };
    });
  const styles = () => p.evaluate(() => [...document.styleSheets].map((s) => { try { return [...s.cssRules].map((r) => r.cssText).join("\n"); } catch { return ""; } }).join("\n"));
  const shot = async (n) => {
    await p.waitForTimeout(350);
    await p.screenshot({ path: `${out}/${n}.png` });
    writeFileSync(`${out}/${n}.json`, JSON.stringify(await dump()));
    console.log("ok", n);
  };
  const step = async (name, fn) => { try { await fn(); } catch (e) { console.log("stepfail", name, e.message.split("\n")[0]); await p.screenshot({ path: `${out}/_fail-${name}.png` }).catch(() => {}); } };
  const go = async (h, wait = 1500) => { await p.goto(BASE + h); await p.waitForTimeout(wait); };
  const clickText = async (sel, text, wait = 700) => { await p.locator(sel, { hasText: text }).first().click(); await p.waitForTimeout(wait); };
  return { b, c, p, dump, shot, step, go, clickText, styles, saveStyles: async () => writeFileSync(`${out}/_styles.css`, await styles()) };
}
