// 成员：设置 · 团队 · 团队共享 → 申请前截图 → 申请 → 申请后截图；核对只有一条状态；核对码写 CODEF
import { writeFileSync } from "node:fs";
const btn = (page, re) => page.locator("button:visible").filter({ hasText: re });
const TAG = process.env.TAG;
const rowText = (page) => page.evaluate(() => { const r = [...document.querySelectorAll(".device-row")].find((x) => /团队共享/.test(x.querySelector(".device-k")?.innerText || "")); return r ? r.innerText.replace(/\s+/g, " ") : "(无团队共享行)"; });
const facts = (page) => page.evaluate(() => ({ shareNote: document.querySelectorAll(".share-note").length, box: document.querySelectorAll(".share-confirm-box").length, statusEls: [...document.querySelectorAll(".share-confirm [role=status], .share-note")].map((e) => e.innerText.replace(/\s+/g, " ").slice(0, 120)), cannot: (document.body.innerText.match(/还不能接收团队共享事项/g) || []).length }));
export default async ({ page, shot }) => {
  await page.waitForTimeout(3000);
  const base = page.url().split("#")[0];
  await page.goto(base + "#/connections/team");
  await page.waitForTimeout(4000);
  const k = page.locator(".device-k", { hasText: "团队共享" }).first();
  await k.waitFor({ timeout: 30000 }); await k.scrollIntoViewIfNeeded(); await page.waitForTimeout(600);
  await shot(`${TAG}-share-before`);
  console.log("BEFORE ROW:", await rowText(page)); console.log("BEFORE FACTS:", JSON.stringify(await facts(page)));
  if (process.env.NOREQ) return;
  await btn(page, /^\s*(申请接收团队共享事项|重新申请)\s*$/).first().click();
  await page.waitForSelector(".share-confirm-box .members-check", { timeout: 30000 });
  await page.waitForTimeout(1000);
  const code = (await page.locator(".share-confirm-box .members-check").innerText()).trim();
  writeFileSync(new URL("./" + process.env.CODEF, import.meta.url), code);
  console.log("CODE", code);
  await shot(`${TAG}-share-requested`);
  console.log("AFTER ROW:", await rowText(page)); console.log("AFTER FACTS:", JSON.stringify(await facts(page)));
};
