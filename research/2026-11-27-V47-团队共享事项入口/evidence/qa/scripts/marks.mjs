// 记号：全局搜索 Q1/Q2、事项列表页、新建任务后“放进哪个事项”列表
export default async ({ page, shot }) => {
  const TAG = process.env.TAG;
  await page.waitForTimeout(3000);
  const base = page.url().split("#")[0];
  for (const [i, q] of (process.env.QS || "").split(",").filter(Boolean).entries()) {
    await page.goto(base + "#/"); await page.waitForTimeout(2500);
    await page.evaluate(() => window.dispatchEvent(new Event("kwl:search"))); await page.waitForTimeout(800);
    await page.locator('input[placeholder="搜索事项、任务、成果"]').fill(q); await page.waitForTimeout(2500);
    const box = page.locator('input[placeholder="搜索事项、任务、成果"]').locator("xpath=ancestor::*[@role='dialog' or contains(@class,'palette')][1]");
    console.log(`SEARCH[${q}]:`, (await box.innerText().catch(async () => await page.locator("body").innerText())).replace(/\s+/g, " ").slice(0, 400));
    await shot(`${TAG}-search-${i}`);
    await page.keyboard.press("Escape");
  }
  await page.goto(base + "#/matters"); await page.waitForTimeout(3500);
  console.log("MATTERS PAGE:", (await page.locator("main").first().innerText()).replace(/\s+/g, " ").slice(0, 600));
  console.log("team marks on page:", await page.locator("main .team-mark, main [aria-label*='团队共享'], main [title*='团队共享']").count());
  await shot(`${TAG}-matters-page`);
  await page.goto(base + "#/"); await page.waitForTimeout(2500);
  await page.locator("button", { hasText: "新建任务" }).first().click(); await page.waitForTimeout(2000);
  console.log("TRAY:", (await page.locator("main").first().innerText()).replace(/\s+/g, " ").slice(0, 200));
  await page.locator("textarea:visible").first().fill("帮我看一下这个事项下一步怎么推进"); await page.locator("textarea:visible").first().press("Enter"); await page.waitForTimeout(2500);
  const pop = page.locator(".place-pop");
  console.log("PLACE POP:", (await pop.count()) ? (await pop.innerText()).replace(/\s+/g, " ").slice(0, 500) : "(none)");
  if (await pop.count()) console.log("PLACE team marks:", await pop.locator(".team-mark, [aria-label*='团队共享'], [title*='团队共享']").count(), "| HTML item:", (await pop.locator(".place-list .menu-item").first().evaluate((e) => e.outerHTML)).slice(0, 600));
  await shot(`${TAG}-place-list`);
  if (await pop.count()) await page.keyboard.press("Escape");
  console.log("GUIDE:", (await page.locator("main").first().innerText()).replace(/\s+/g, " ").match(/.{0,20}团队管理员都看不到内容.{0,10}|事项内容只在你的电脑上.{0,40}/)?.[0] ?? "(no guide note)");
};
