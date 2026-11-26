// 复制隔离核对：在预览里全选并复制，读剪贴板 text/html，看有没有画布色、点阵、投影
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire("/Users/wangzeyu/.nvm/versions/node/v26.8.1/lib/node_modules/");
const { chromium } = require("playwright");
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:5692" });
const p = await ctx.newPage();
await p.goto("http://127.0.0.1:5692/#/deliverables");
await p.waitForSelector(".dl-row");
await p.waitForTimeout(1200);
for (const t of await p.$$(".dl-proc-toggle")) await t.click().catch(() => {});
await p.waitForTimeout(400);
const BAD = /efedea|161514|rgb\(239, 237, 234\)|rgb\(22, 21, 20\)|radial-gradient|box-shadow|background-image/i;
const results = [];
for (const theme of ["light", "dark"]) {
  await p.evaluate((th) => (document.documentElement.dataset.theme = th), theme);
  for (const [name, re] of [["doc", /^W 民事起诉状/], ["redline", /^W 修订稿 /], ["xlsx", /^X 证据目录/], ["md", /^文 答复摘要/]]) {
    const rows = await p.$$(".dl-row, .dl-row-sub");
    for (const r of rows) {
      if (re.test((await r.innerText()).replace(/\s+/g, " "))) {
        await r.click();
        break;
      }
    }
    await p.waitForTimeout(2200);
    await p.evaluate(() => navigator.clipboard.writeText(""));
    if (name === "md") {
      await p.click(".dlp .sp-md .md p");
    } else {
      const fr = p.frameLocator(".dlp .sp-frame");
      await fr.locator("body").click({ position: { x: 200, y: 200 } });
    }
    await p.keyboard.press("ControlOrMeta+A");
    await p.keyboard.press("ControlOrMeta+C");
    await p.waitForTimeout(300);
    const clip = await p.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const out = {};
      for (const it of items) for (const t of it.types) out[t] = await (await it.getType(t)).text();
      return out;
    });
    const html = clip["text/html"] ?? "";
    writeFileSync(`clip-${name}-${theme}.html`, html);
    const bg = [...new Set((html.match(/background(-color)?:\s*[^;"]+/gi) ?? []).map((s) => s.toLowerCase()))].slice(0, 6);
    results.push({ name, theme, htmlLen: html.length, textLen: (clip["text/plain"] ?? "").length, canvasLeak: BAD.test(html), backgrounds: bg });
  }
}
console.log(JSON.stringify(results, null, 1));
await b.close();
