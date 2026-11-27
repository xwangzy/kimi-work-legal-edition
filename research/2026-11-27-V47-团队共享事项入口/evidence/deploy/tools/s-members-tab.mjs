export default async ({ page, shot, base }) => {
  await page.waitForTimeout(4000);
  await page.goto(base.split("#")[0] + process.env.HASH); await page.waitForTimeout(3500);
  await page.locator("[role=tab]").filter({ hasText: "事项成员" }).first().click(); await page.waitForTimeout(2500);
  console.log("MEMBERS:", (await page.locator(".main").innerText()).replace(/\s+/g, " ").slice(0, 700));
  await shot(process.env.SHOT);
};
