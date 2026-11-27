export default async ({ page, shot }) => {
  await page.waitForTimeout(3000);
  const base = page.url().split("#")[0];
  await page.goto(base + "#/matter/" + process.env.MID); await page.waitForTimeout(5000);
  console.log("MAIN:", (await page.locator("main").first().innerText()).replace(/\s+/g, " ").slice(0, 900));
  console.log("发起任务:", await page.locator("button:visible", { hasText: /^\s*发起任务\s*$/ }).count(), "file inputs:", await page.locator("input[type=file]").count(), "选择文件:", await page.locator("text=选择文件").count(), "关联案卷文件夹:", await page.locator("text=关联案卷文件夹").count());
  await shot(process.env.TAG);
  await page.locator("button.tab, [role=tab]", { hasText: /事项成员/ }).first().click().catch(() => {}); await page.waitForTimeout(2500);
  console.log("MM:", (await page.locator("section.mm").innerText().catch(() => "-")).replace(/\s+/g, " "));
  await shot(process.env.TAG + "-members");
};
