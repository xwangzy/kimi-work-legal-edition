export default async ({ page, shot }) => {
  await page.waitForTimeout(3000);
  const base = page.url().split("#")[0];
  await page.goto(base + "#/"); await page.waitForTimeout(3000);
  await page.locator('button.section-act[aria-label="新建事项"]').first().click({ force: true });
  await page.waitForSelector(".modal, [role=dialog]"); await page.waitForTimeout(2000);
  const dlg = page.locator(".modal, [role=dialog]").first(); const sf = dlg.locator(".scope-field");
  const conf = (t) => dlg.locator('[aria-label="怎么处理"] button[role=radio]', { hasText: t });
  const st = async (tag) => console.log(tag, "| team disabled:", await sf.locator("button[role=radio]", { hasText: "和同事一起办" }).isDisabled(), "| team checked:", await sf.locator("button[role=radio]", { hasText: "和同事一起办" }).getAttribute("aria-checked"), "| L3b disabled:", await conf("客户要求不上云").isDisabled(), "| L3b checked:", await conf("客户要求不上云").getAttribute("aria-checked"), "|", (await sf.innerText()).replace(/\s+/g, " "), "| conf note:", (await dlg.locator('div.authz-field[aria-label="怎么处理"]').innerText()).replace(/\s+/g, " ").slice(0, 160));
  await conf("客户要求不上云").click(); await page.waitForTimeout(600); await st("A: 先选不上云");
  await shot("11-3-a-mutex-l3b-first");
  await conf("一般").click(); await sf.locator("button[role=radio]", { hasText: "和同事一起办" }).click(); await page.waitForTimeout(600);
  await conf("客户要求不上云").click({ timeout: 3000 }).catch(() => console.log("L3b click blocked")); await page.waitForTimeout(600); await st("B: 先选一起办再点不上云");
  await shot("11-3-a-mutex-team-first");
};
