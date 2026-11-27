export default async ({ page, shot }) => {
  await page.waitForTimeout(3000);
  const base = page.url().split("#")[0];
  await page.goto(base + "#/"); await page.waitForTimeout(3000);
  await page.locator("button.ctx-matter").first().click(); await page.waitForTimeout(1000);
  console.log("CTX MENU:", (await page.locator(".composer-menu").first().innerText()).replace(/\s+/g, " ").slice(0, 500));
  console.log("team-mark in menu:", await page.locator(".composer-menu .team-mark").count(), "| chip mark:", await page.locator("button.ctx-matter .team-mark").count());
  await shot(process.env.TAG);
  console.log("SIDEBAR marks:", await page.locator(".sidebar .team-mark, aside .team-mark").count(), "|", (await page.locator(".sidebar, aside").first().innerText()).replace(/\s+/g, " ").match(/事项.{0,120}/)?.[0]);
};
