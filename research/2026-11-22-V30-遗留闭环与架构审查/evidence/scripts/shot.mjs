// node shot.mjs <port> <hash> <out.png> [--click 文本]... [--wait ms] [--full] [--dark] [--w 1440 --h 900]
import { chromium } from "/Users/wangzeyu/.nvm/versions/node/v26.8.1/lib/node_modules/playwright/index.mjs";
const a = process.argv.slice(2);
const [port, hash, out] = a;
const opt = (k, d) => { const i = a.indexOf("--" + k); return i >= 0 ? a[i + 1] : d; };
const clicks = a.flatMap((x, i) => (x === "--click" ? [a[i + 1]] : []));
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: Number(opt("w", 1440)), height: Number(opt("h", 900)) }, deviceScaleFactor: 2, colorScheme: a.includes("--dark") ? "dark" : "light" });
await p.goto(`http://127.0.0.1:${port}/${hash}`);
await p.waitForTimeout(Number(opt("wait", 2500)));
for (const c of clicks) { const l = c.startsWith("css=") ? p.locator(c.slice(4)).first() : p.getByText(c, { exact: true }).first(); await l.click({ timeout: 8000 }); await p.waitForTimeout(900); }
await p.screenshot({ path: out, fullPage: a.includes("--full") });
if (a.includes("--text")) console.log((await p.locator("main").innerText()).slice(0, 6000));
await b.close();
