// playwright 小工具：node pw.mjs <输出目录> <脚本.mjs>；脚本导出 default async ({ page, shot, base }) => {}
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
const require = createRequire("/Users/wangzeyu/.nvm/versions/node/v26.8.1/lib/node_modules/");
const { chromium } = require("playwright");
const [, , outDir, script, base = "http://127.0.0.1:5701/", vw = "1440", vh = "900", theme = "light"] = process.argv;
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(vw), height: Number(vh) }, deviceScaleFactor: 2, colorScheme: theme });
page.on("console", (m) => { if (m.type() === "error") console.log("console:", m.text().slice(0, 300)); });
page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 300)));
let n = 0;
const shot = async (name, o = {}) => { const f = `${outDir}/${name}.png`; await page.screenshot({ path: f, fullPage: !!o.full }); console.log("shot", f); return f; };
await page.goto(base);
await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
const mod = await import(resolve(script));
try { await mod.default({ page, shot, base }); } catch (e) { console.log("ERR", e.message); await shot("error-state"); }
await browser.close();
