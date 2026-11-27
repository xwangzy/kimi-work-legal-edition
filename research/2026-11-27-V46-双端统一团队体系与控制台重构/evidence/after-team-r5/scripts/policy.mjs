// 设置 · 团队 · 团队策略：TAG
export default async ({ page, shot }) => {
  await page.waitForTimeout(3000);
  const base = page.url().split("#")[0];
  await page.goto(base + "#/connections/team");
  await page.waitForTimeout(4500);
  const h = page.locator("#sec-policy");
  await h.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(600);
  await shot(process.env.TAG);
};
