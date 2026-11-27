export default async ({ page, shot }) => {
  await page.waitForTimeout(5000);
  console.log("SIDEBAR:", (await page.locator(".sidebar, aside").first().innerText()).replace(/\s+/g, " ").slice(0, 300));
  await shot("b10-home-sidebar-team-matter");
  const base = page.url().split("#")[0];
  await page.goto(base + "#/matter/" + process.env.MID); await page.waitForTimeout(5000);
  console.log("MATTER:", (await page.locator("main, .main").first().innerText()).replace(/\s+/g, " ").slice(0, 600));
  await shot("b11-team-matter-page");
};
