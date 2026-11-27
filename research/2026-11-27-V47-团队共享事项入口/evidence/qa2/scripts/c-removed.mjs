export default async ({ page, shot }) => {
  await page.waitForTimeout(3000);
  const base = page.url().split("#")[0];
  const t0 = Date.now();
  await page.goto(base + "#/matter/" + process.env.MID);
  let seen = -1;
  for (let i = 0; i < 40; i++) { await page.waitForTimeout(1000); if (await page.locator(".removed-me-note").count()) { seen = (Date.now() - t0) / 1000; break; } }
  console.log(new Date().toISOString(), "removed note after", seen, "s");
  await page.waitForTimeout(1500);
  console.log("HEAD:", (await page.locator("main").first().innerText()).replace(/\s+/g, " ").slice(0, 900));
  console.log("TABS:", (await page.locator(".tabs-line [role=tab], button.tab").allInnerTexts()).join("|"));
  console.log("WRITE entries: 发起任务", await page.locator("button:visible", { hasText: /^\s*发起任务\s*$/ }).count(), "file inputs", await page.locator("input[type=file]").count(), "选择文件", await page.locator("text=选择文件").count());
  const sb = page.locator(".sidebar, aside").first();
  const item = sb.locator("a, button, li").filter({ hasText: process.env.TITLE }).first();
  console.log("SIDEBAR ITEM:", (await item.innerText().catch(() => "-")).replace(/\s+/g, " "), "| aria:", await item.getAttribute("aria-label").catch(() => null), "| html:", (await item.innerHTML().catch(() => "")).replace(/\s+/g, " ").match(/(已移出|团队共享|removed|team-mark)[^<]{0,40}/g));
  await shot(process.env.TAG);
  await page.goto(base + "#/matters"); await page.waitForTimeout(3000);
  console.log("MATTERS PAGE row:", (await page.locator("main").first().innerText()).replace(/\s+/g, " ").match(/云杉[^。]{0,80}/)?.[0]);
  await shot(process.env.TAG + "-matters-list");
};
