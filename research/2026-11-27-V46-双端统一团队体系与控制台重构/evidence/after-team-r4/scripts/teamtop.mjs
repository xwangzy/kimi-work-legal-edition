// 团队页页首（横幅）截图：TAG
export default async ({ page, shot }) => {
  await page.waitForTimeout(3000);
  const base = page.url().split("#")[0];
  await page.goto(base + "#/connections/team");
  await page.waitForTimeout(4500);
  await shot(process.env.TAG);
  console.log("BANNER:", (await page.locator(".team-privacy").allInnerTexts().catch(() => [])).join(" | "));
  console.log("SAFETY:", (await page.locator("details.account-more summary").allInnerTexts().catch(() => [])).join(" | "));
};
