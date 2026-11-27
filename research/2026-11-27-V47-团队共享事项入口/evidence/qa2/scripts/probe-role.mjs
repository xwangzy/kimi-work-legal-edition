export default async ({ page }) => {
  await page.waitForTimeout(3000);
  const base = page.url().split("#")[0];
  await page.goto(base + "#/matter/" + process.env.MID); await page.waitForTimeout(4500);
  await page.locator("button.tab, [role=tab]", { hasText: /事项成员/ }).first().click(); await page.waitForTimeout(3000);
  console.log(await page.locator("ul.mm-list").evaluate((e) => [...e.querySelectorAll("[aria-label], button")].map((x) => `${x.tagName}.${x.className}[${x.getAttribute("aria-label")}] ${x.innerText.replace(/\s+/g, " ").slice(0, 30)}`).join("\n")));
};
