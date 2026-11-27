// D6：团队页顶部横幅（MODE=team）/ 个人空间账号页“把工作室升级为团队”二次确认（MODE=upgrade，不真升级）
const btn = (page, re) => page.locator("button:visible").filter({ hasText: re });
export default async ({ page, shot }) => {
  await page.waitForTimeout(4000);
  const base = page.url().split("#")[0];
  if (process.env.MODE === "team") {
    await page.goto(base + "#/connections/team"); await page.waitForTimeout(4000);
    console.log("BANNERS:", (await page.evaluate(() => [...document.querySelectorAll("span, p, div")].filter((e) => e.children.length < 3 && /共享通道|团队共享/.test(e.innerText || "")).map((e) => e.innerText.replace(/\s+/g, " ")).filter((t) => t.length < 200))).join(" ## "));
    await shot(process.env.TAG); return;
  }
  await page.goto(base + "#/connections/account"); await page.waitForTimeout(4000);
  console.log("CARD:", (await page.locator(".sidebar-foot").innerText().catch(() => "")).replace(/\s+/g, " "));
  await btn(page, /把工作室升级为团队/).first().click(); await page.waitForTimeout(800);
  await page.locator(".ws-upgrade input:not([type=checkbox])").fill("冯氏测试团队");
  await page.waitForTimeout(500);
  console.log("MODAL:", (await page.locator(".ws-upgrade, [role=dialog]").first().innerText()).replace(/\s+/g, " ").slice(0, 800));
  await shot(process.env.TAG);
};
