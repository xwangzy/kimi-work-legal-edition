export default async ({ page, shot }) => {
  await page.waitForTimeout(3500);
  await page.locator('button[aria-label*="搜索"]').first().click(); await page.waitForTimeout(800);
  const inp = page.locator('input[type=search]:visible, [role=dialog] input:visible').first();
  for (const q of process.env.Q.split(",")) {
    await inp.fill(q); await page.waitForTimeout(2500);
    console.log("SEARCH", q, ":", (await page.locator("[role=dialog], .search-pop, .modal").last().innerText().catch(() => "-")).replace(/\s+/g, " ").slice(0, 300));
    await shot(`${process.env.TAG}-${q}`);
  }
};
