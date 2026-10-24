import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const pw = require("/Users/wangzeyu/.nvm/versions/node/v26.8.1/lib/node_modules/playwright");
const out = process.argv[2]; const ids = JSON.parse(process.argv[3]);
const base = "http://localhost:5220/";
const b = await pw.chromium.launch();
const mk = async (dark) => { const c = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN", colorScheme: dark ? "dark" : "light" }); return c.newPage(); };
let p = await mk(false);
const dump = () => p.evaluate(() => {
  document.querySelectorAll("textarea").forEach((t) => { t.textContent = t.value; });
  document.querySelectorAll("input").forEach((i) => { if (i.type === "checkbox" || i.type === "radio") { if (i.checked) i.setAttribute("checked", ""); else i.removeAttribute("checked"); } else i.setAttribute("value", i.value); });
  document.querySelectorAll("select").forEach((s) => { [...s.options].forEach((o) => { if (o.selected) o.setAttribute("selected", ""); else o.removeAttribute("selected"); }); });
  document.querySelectorAll("details").forEach((d) => { if (d.open) d.setAttribute("open", ""); });
  return { theme: document.documentElement.getAttribute("data-theme"), html: document.body.innerHTML, modal: !!document.querySelector(".modal-backdrop, .modal") };
});
const shot = async (n) => { await p.waitForTimeout(250); await p.screenshot({ path: `${out}/${n}.png` }); writeFileSync(`${out}/${n}.json`, JSON.stringify(await dump())); console.log("ok", n); };
const step = async (name, fn) => { try { await fn(); } catch (e) { console.log("stepfail", name, e.message.split("\n")[0]); } };
const go = async (h) => { await p.goto(base + h); await p.waitForTimeout(1600); };
const clickText = async (sel, text) => { await p.locator(sel, { hasText: text }).first().click(); await p.waitForTimeout(700); };
const TASK = "审查这份股权转让协议，我方为受让方，重点关注付款与违约责任";
let RUN = "";
await step("banner", async () => { await go("#/"); const t = p.getByRole("button", { name: "明天提醒" }); if (await t.count()) { await t.click(); await p.waitForTimeout(500); } });
await step("home", async () => {
  await go("#/"); await shot("h01-home-blank");
  await p.locator("button.ctx-matter").click(); await p.waitForTimeout(400); await shot("h02-matter-menu");
  await clickText(".composer-menu .menu-item", "乙投资"); await shot("h03-home-matter");
  await p.locator("textarea").first().fill(TASK); await p.waitForTimeout(1500); await shot("h04-home-typed");
  await p.locator(".suggest-bar button.btn-primary").click(); await p.waitForTimeout(800); await shot("h05-home-method");
  for (const c of ["付款", "违约责任"]) { await p.locator(".modal button", { hasText: c }).first().click(); await p.waitForTimeout(300); }
  await shot("h06-start-focus");
  const v = p.locator(".modal button, .modal summary, .modal a", { hasText: "看看 AI 会看到什么" }); if (await v.count()) { await v.first().click(); await p.waitForTimeout(900); await shot("c02-start-preview"); await p.locator(".modal").first().evaluate((m) => { const sc = [...m.querySelectorAll("*")].find((e) => e.scrollHeight > e.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(e).overflowY)); if (sc) sc.scrollTop = sc.scrollHeight; }); await p.waitForTimeout(400); await shot("c03-start-preview-scrolled"); }
  await p.getByRole("button", { name: /^开始审查$/ }).click(); await p.waitForTimeout(1500); await shot("c04-after-start");
  const conf = p.getByRole("button", { name: /^开始$/ }); if (await conf.count()) { await shot("c05-confirm"); await conf.last().click(); }
  await p.waitForTimeout(500); await shot("r00-run-start");
  await p.waitForTimeout(6000); await shot("r01-run-done"); RUN = p.url().split("#")[1];
});
await step("runtabs", async () => { for (const t of ["成果", "引用", "数据去向", "审查摘要"]) { await clickText("[role=tab], .tabs button, .rp-tabs button", t); await shot(`r02-run-${t}`); } });
await step("details", async () => { const d = p.locator("main summary, main button", { hasText: "处理细节" }); if (await d.count()) { await d.first().click(); await p.waitForTimeout(600); await shot("r03-run-details"); } });
await step("review", async () => {
  await go("#" + RUN); await p.getByRole("button", { name: "打开审查工作台" }).click(); await p.waitForTimeout(2000); await shot("w01-review"); writeFileSync(`${out}/review-url.txt`, p.url());
  await p.getByRole("button", { name: /^接受首选/ }).first().click(); await p.waitForTimeout(1000); await shot("w02-acc1");
  await p.getByRole("button", { name: /^接受/ }).first().click(); await p.waitForTimeout(1000); await shot("w03-acc2");
  await p.getByRole("button", { name: /^接受/ }).first().click(); await p.waitForTimeout(1000); await shot("w04-acc3");
  await p.getByRole("button", { name: /^不采纳/ }).first().click(); await p.waitForTimeout(1000); await shot("w05-rej");
  await clickText("button", "接受后"); await shot("w06-after");
  await clickText("button", "原文");
  const g = p.getByRole("button", { name: /生成修订稿/ }); await g.first().click(); await p.waitForTimeout(2500); await shot("w07-redline");
});
const pick = async (label) => { await clickText("[role=tab], .tabs button, .rp-tabs button", "成果"); await p.locator("button", { hasText: /· v1/ }).first().click(); await p.waitForTimeout(500); await p.locator("[role=option]", { hasText: label }).first().click(); await p.waitForTimeout(1500); };
await step("report", async () => { await go("#" + RUN); await pick("审查意见"); await p.waitForTimeout(1500); await shot("r04-report");
  const fr = p.frames().find((f) => f !== p.mainFrame()); if (fr) writeFileSync(`${out}/r04-report-frame.html`, await fr.content());
  await clickText("[role=tab], .tabs button, .rp-tabs button", "引用"); await p.waitForTimeout(800); await shot("r05-cite");
  await pick("修订稿"); await p.waitForTimeout(1500); await shot("r06-redline-preview"); const fr2 = p.frames().find((f) => f !== p.mainFrame()); if (fr2) writeFileSync(`${out}/r06-redline-frame.html`, await fr2.content());
});
await step("pages", async () => {
  for (const [n, h] of [["p01-home", "#/"], ["p02-matter-lit", `#/matter/${ids.lit}`], ["p03-matter-nonlit", `#/matter/${ids.nonlit}`], ["p04-deliverables", "#/deliverables"], ["p05-reminders", "#/reminders"], ["p06-chat", "#/chat"], ["p07-boards", "#/boards"], ["p08-device", "#/connections/device"], ["p09-visibility", "#/connections/visibility"], ["p10-methods", "#/methods"], ["p11-matters", "#/matters"]]) { await go(h); await shot(n); }
  await go("#/"); for (const t of ["非诉", "企业法务"]) { await p.getByRole("tab", { name: t }).click(); await p.waitForTimeout(500); await shot(`p01-home-${t}`); }
});
await step("dark", async () => { p = await mk(true); await go("#/"); { const t = p.getByRole("button", { name: "明天提醒" }); if (await t.count()) { await t.click(); await p.waitForTimeout(500); } } await shot("d01-home"); await go("#" + RUN); await shot("d02-run"); await p.getByRole("button", { name: "打开审查工作台" }).click(); await p.waitForTimeout(2000); await shot("d03-review"); });
await b.close();
console.log("RUN", RUN);
