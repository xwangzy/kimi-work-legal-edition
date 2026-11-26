// 用法：node shot.mjs <输出目录> [方案.mjs] [只截哪些]   方案导出 { frame(dark, name) -> css, parent: css }
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
const require = createRequire("/Users/wangzeyu/.nvm/versions/node/v26.8.1/lib/node_modules/");
const { chromium } = require("playwright");
const [out, optFile, only] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const [optPath, optKey] = (optFile ?? "-").split("#");
const opt = optPath !== "-" ? (await import(pathToFileURL(optPath).href))[optKey ?? "default"] : null;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto("http://127.0.0.1:5692/#/deliverables");
await p.waitForSelector(".dl-row");
await p.waitForTimeout(1500);
for (const t of await p.$$(".dl-proc-toggle")) await t.click().catch(() => {});
await p.waitForTimeout(500);
const all = await p.$$eval(".dl-row, .dl-row-sub", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").slice(0, 60)));
const mdIdx = all.findIndex((t) => !/^[WX] /.test(t));
const targets = [
  ["doc", (t) => t.startsWith("W 民事起诉状")],
  ["xlsx", (t) => t.startsWith("X 证据目录")],
  ["redline", (t) => t.startsWith("W 修订稿 ")],
  ["md", (_t, i) => i === mdIdx],
].filter(([n]) => !only || only.split(",").includes(n));
console.log("rows:", all.join(" | "), "mdIdx", mdIdx);
for (const theme of ["light", "dark"]) {
  await p.evaluate((th) => (document.documentElement.dataset.theme = th), theme);
  if (opt?.parent) {
    await p.evaluate((css) => {
      let s = document.getElementById("opt-parent");
      if (!s) {
        s = document.createElement("style");
        s.id = "opt-parent";
        document.head.append(s);
      }
      s.textContent = css;
    }, opt.parent);
  }
  for (const [name, match] of targets) {
    const els = await p.$$(".dl-row, .dl-row-sub");
    let hit = null;
    for (let i = 0; i < els.length; i++) {
      const t = (await els[i].innerText()).replace(/\s+/g, " ");
      if (match(t, i)) {
        hit = els[i];
        break;
      }
    }
    if (!hit) {
      console.log("miss", name);
      continue;
    }
    await hit.click();
    await p.waitForTimeout(2200);
    if (opt?.frame) {
      await p.evaluate((css) => {
        const f = document.querySelector(".dlp .sp-frame");
        if (!f) return;
        const n = f.cloneNode();
        n.setAttribute("srcdoc", f.getAttribute("srcdoc").replace("</head>", "<style id=\"opt\">" + css + "</style></head>"));
        f.replaceWith(n);
      }, opt.frame(theme === "dark", name));
      await p.waitForTimeout(900);
    }
    const dlp = await p.$(".dlp");
    await dlp.screenshot({ path: `${out}/${name}-${theme}.png` });
    if (name === "doc") await p.screenshot({ path: `${out}/page-${theme}.png` });
  }
}
await b.close();
