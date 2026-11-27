// 事项页 → 事项成员：打印成员区与事项头；MID、TAG
export default async ({ page, shot }) => {
  await page.waitForTimeout(3000);
  const base = page.url().split("#")[0];
  await page.goto(base + "#/matter/" + process.env.MID); await page.waitForTimeout(4500);
  const head = (await page.locator("main").first().innerText()).replace(/\s+/g, " ");
  console.log("HEAD:", head.slice(0, 600));
  await shot(process.env.TAG + "-matter");
  const tab = page.locator("button.tab, [role=tab]", { hasText: /事项成员/ }).first();
  if (await tab.count()) await tab.click(); else { await page.locator("button.tab-more").click(); await page.locator(".tab-more-menu button", { hasText: "事项成员" }).click(); }
  await page.waitForTimeout(3500);
  console.log("MM:", (await page.locator("section.mm").innerText().catch(() => "(no section.mm)")).replace(/\s+/g, " "));
  console.log("ASSIGN links:", await page.locator(".mm-sub-go").count(), "buttons:", (await page.locator("section.mm button:visible").allInnerTexts()).join("|"));
  await shot(process.env.TAG + "-members");
  if (process.env.SIDEBAR) console.log("SIDEBAR:", (await page.locator(".sidebar, aside").first().innerText()).replace(/\s+/g, " ").slice(0, 600));
};
