// 管理员：设置 · 团队 · 电脑待确认 → 行截图 / 折行检查 / 核对码是否出现；MODE=look|ok|reject；NAME 只看某人的行；CODEF 对方核对码
import { readFileSync } from "node:fs";
const MODE = process.env.MODE || "look", TAG = process.env.TAG;
const btn = (page, re) => page.locator("button:visible").filter({ hasText: re });
const ts = () => new Date().toISOString();
export default async ({ page, shot }) => {
  page.on("response", async (r) => { if (!r.url().includes("/invoke")) return; try { const m = JSON.parse(r.request().postData() || "{}").method; if (/^(members\.|team\.)/.test(m) && !/list|status|summary/.test(m)) console.log(ts(), "INVOKE", m, JSON.stringify(JSON.parse(r.request().postData()).params), "→", (await r.text()).slice(0, 300)); } catch {} });
  await page.waitForTimeout(3000);
  const base = page.url().split("#")[0];
  await page.goto(base + "#/connections/team");
  await page.waitForTimeout(3000);
  const h = page.locator("h3.team-h3", { hasText: "电脑待确认" });
  let row = null;
  for (let i = 0; i < 12; i++) {
    const r = page.locator("tr", { hasText: "申请接收团队共享事项" }).filter({ hasText: process.env.NAME || "" });
    if (await r.count()) { row = r.first(); break; }
    await page.waitForTimeout(5000);
    if (i % 3 === 2) { await page.reload(); await page.waitForTimeout(3000); }
  }
  if (!row) { await shot(`${TAG}-no-row`); console.log("NO ROW"); return; }
  await row.scrollIntoViewIfNeeded(); await page.waitForTimeout(500);
  await shot(`${TAG}-pending-row`);
  const code = readFileSync(new URL("./" + process.env.CODEF, import.meta.url), "utf8").trim(), digits = code.replace(/\D/g, "");
  const info = await row.evaluate((tr, d) => {
    const ths = [...tr.closest("table").querySelectorAll("th")].map((x) => x.innerText.trim());
    const tds = [...tr.querySelectorAll("td")].map((td, i) => { const rg = document.createRange(); rg.selectNodeContents(td); const lines = new Set([...rg.getClientRects()].map((q) => Math.round(q.top))).size; return { th: ths[i], text: td.innerText.replace(/\s+/g, " ").slice(0, 120), lines, ws: getComputedStyle(td).whiteSpace, w: Math.round(td.getBoundingClientRect().width) }; });
    const sec = tr.closest("section, .card, div").innerText.replace(/\s/g, "");
    return { tds, codeInRow: tr.innerText.replace(/\s/g, "").includes(d), codeInPage: document.body.innerText.replace(/\s/g, "").includes(d), codeInDom: document.documentElement.outerHTML.replace(/\s/g, "").includes(d) };
  }, digits);
  console.log("ROWINFO:", JSON.stringify(info, null, 1));
  console.log("SIDEBAR:", (await page.locator(".sidebar, aside").first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(-200));
  if (MODE === "look") return;
  const input = row.locator("input.members-code-input");
  const confirmBtn = row.locator("button", { hasText: /^\s*确认\s*$/ });
  if (MODE === "reject") {
    await row.locator("button", { hasText: /^\s*拒绝\s*$/ }).click(); await page.waitForTimeout(500);
    await shot(`${TAG}-reject-ask`);
    await btn(page, /^\s*拒绝\s*$/).last().click(); console.log(ts(), "REJECT CLICKED");
    await page.waitForTimeout(3000); await shot(`${TAG}-rejected`);
    console.log("AFTER:", (await page.locator(".set-page, main").first().innerText()).replace(/\s+/g, " ").match(/电脑待确认.{0,200}/)?.[0]);
    let lastSb = ""; for (let i = 0; i < 45; i++) { const sb = (await page.locator(".sidebar-foot, .sidebar, aside").first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(-60); if (sb !== lastSb) { lastSb = sb; console.log(ts(), "SIDEBAR:", sb); } await page.waitForTimeout(1000); }
    return;
  }
  const wrong = digits.slice(0, 11) + String((Number(digits[11]) + 1) % 10);
  await input.fill(wrong.replace(/(\d{3})(?=\d)/g, "$1 ")); await page.waitForTimeout(400);
  console.log(ts(), "WRONG typed", wrong, "confirm disabled:", await confirmBtn.isDisabled());
  await confirmBtn.click().catch((e) => console.log("click err", e.message)); await page.waitForTimeout(3000);
  console.log("WRONG after click ROW:", (await row.innerText().catch(() => "(row gone)")).replace(/\s+/g, " "));
  console.log("WRONG page errors:", (await page.locator(".activate-error, [role=alert], .error").allInnerTexts()).join(" | ").replace(/\s+/g, " "));
  await shot(`${TAG}-wrong-code`);
  await input.fill(code); await page.waitForTimeout(400);
  console.log(ts(), "RIGHT typed, confirm disabled:", await confirmBtn.isDisabled());
  await shot(`${TAG}-right-code`);
  await confirmBtn.click(); console.log(ts(), "CONFIRM CLICKED");
  await page.waitForTimeout(3500);
  await shot(`${TAG}-confirmed`);
  console.log("AFTER SECTION:", (await page.locator(".set-page, main").first().innerText()).replace(/\s+/g, " ").match(/电脑待确认.{0,300}|没有待确认.{0,200}/)?.[0]);
  console.log("ROW STILL:", await page.locator("tr", { hasText: "申请接收团队共享事项" }).count());
  console.log("ERRORS:", (await page.locator(".activate-error, [role=alert]").allInnerTexts()).join(" | ").replace(/\s+/g, " "), "| FK in page:", /FOREIGN KEY/.test(await page.evaluate(() => document.body.innerText)));
  console.log("TOASTS:", (await page.locator("[role=status], .toast").allInnerTexts()).join(" | ").replace(/\s+/g, " ").slice(0, 300));
  console.log("SIDEBAR:", (await page.locator(".sidebar, aside").first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(-200));
};
