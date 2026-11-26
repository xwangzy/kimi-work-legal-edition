// 滚动性能对比：修订稿（长文档）在新画布（点阵 + 三层投影）与旧样式（纯色画布 + 描边轻阴影）下滚动，统计主线程 Paint 与光栅耗时；顺带收集 CSP 报错
import { createRequire } from "node:module";
const require = createRequire("/Users/wangzeyu/.nvm/versions/node/v26.8.1/lib/node_modules/");
const { chromium } = require("playwright");
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const csp = [];
p.on("console", (m) => /Content Security Policy|Refused/i.test(m.text()) && csp.push(m.text().slice(0, 160)));
await p.goto("http://127.0.0.1:5692/#/deliverables");
await p.waitForSelector(".dl-row");
await p.waitForTimeout(1200);
const OLD = "html,body{background:#f4f3f2;background-image:none;}.kwl-paper{border:1px solid #eeebe7;box-shadow:0 1px 6px rgba(14,18,25,0.06);}";
const res = {};
for (const theme of ["light", "dark"]) {
  for (const mode of ["new", "old", "new2", "old2"]) {
    await p.reload();
    await p.waitForSelector(".dl-row");
    await p.evaluate((th) => (document.documentElement.dataset.theme = th), theme);
    await p.waitForTimeout(1000);
    for (const r of await p.$$(".dl-row")) if (/^W 修订稿 /.test((await r.innerText()).replace(/\s+/g, " "))) { await r.click(); break; }
    await p.waitForTimeout(1800);
    if (mode.startsWith("old")) {
      await p.evaluate((css) => { const f = document.querySelector(".dlp .sp-frame"); const n = f.cloneNode(); n.setAttribute("srcdoc", f.getAttribute("srcdoc").replace("</head>", "<style>" + css + "</style></head>")); f.replaceWith(n); }, OLD);
      await p.waitForTimeout(1200);
    }
    const box = await (await p.$(".dlp .sp-frame")).boundingBox();
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await b.startTracing(p, { categories: ["devtools.timeline", "disabled-by-default-devtools.timeline"] });
    for (let i = 0; i < 40; i++) { await p.mouse.wheel(0, 140); await p.waitForTimeout(16); }
    for (let i = 0; i < 40; i++) { await p.mouse.wheel(0, -140); await p.waitForTimeout(16); }
    const buf = await b.stopTracing();
    const ev = JSON.parse(buf.toString()).traceEvents;
    const sum = (n) => Math.round(ev.filter((e) => e.name === n && e.dur).reduce((s, e) => s + e.dur, 0) / 100) / 10;
    const cnt = (n) => ev.filter((e) => e.name === n).length;
    res[`${theme}-${mode}`] = { paintMs: sum("Paint"), rasterMs: sum("RasterTask"), paints: cnt("Paint"), frames: cnt("DrawFrame") };
  }
}
console.log(JSON.stringify({ res, csp }, null, 1));
await b.close();
