// 成员：团队页“团队共享”行截图；ACT=知道了|重新申请 时点按钮后再截；RELOAD=1 点完后整页重开再截
const TAG = process.env.TAG, ACT = process.env.ACT;
const row = (page) => page.evaluate(() => { const r = [...document.querySelectorAll(".device-row")].find((x) => /团队共享/.test(x.querySelector(".device-k")?.innerText || "")); return (r ? r.innerText.replace(/\s+/g, " ") : "(无团队共享行)") + " || notes=" + document.querySelectorAll(".share-note").length; });
const go = async (page) => { const base = page.url().split("#")[0]; await page.goto(base + "#/connections/team"); const k = page.locator(".device-k", { hasText: "团队共享" }).first(); await k.waitFor({ timeout: 30000 }).catch(() => {}); await page.waitForTimeout(2500); await k.scrollIntoViewIfNeeded().catch(() => {}); await page.waitForTimeout(500); };
export default async ({ page, shot }) => {
  await page.waitForTimeout(3000); await go(page);
  console.log(new Date().toISOString(), "ROW:", await row(page)); await shot(TAG);
  if (!ACT) return;
  await page.locator("button:visible").filter({ hasText: new RegExp(`^\\s*${ACT}\\s*$`) }).first().click();
  await page.waitForTimeout(2500);
  console.log(new Date().toISOString(), "AFTER", ACT, ":", await row(page)); await shot(`${TAG}-after-${ACT === "知道了" ? "dismiss" : "rerequest"}`);
  const code = await page.locator(".share-confirm-box .members-check").innerText().catch(() => null); if (code) console.log("CODE", code);
  if (process.env.RELOAD) { await page.reload(); await page.waitForTimeout(3000); await go(page); console.log(new Date().toISOString(), "AFTER RELOAD:", await row(page)); await shot(`${TAG}-after-reload`); }
};
