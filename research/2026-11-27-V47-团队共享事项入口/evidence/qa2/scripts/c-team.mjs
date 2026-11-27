export default async ({ page, shot }) => {
  await page.waitForTimeout(2500);
  const base = page.url().split("#")[0];
  console.log(new Date().toISOString(), "OPEN team page");
  await page.goto(base + "#/connections/team"); await page.waitForTimeout(9000);
  const k = page.locator(".device-row", { hasText: "团队共享" }).first();
  console.log(new Date().toISOString(), "ROW:", (await k.innerText().catch(() => "-")).replace(/\s+/g, " "));
  await k.scrollIntoViewIfNeeded().catch(() => {}); await shot(process.env.TAG);
};
