// 设置 · 账号（个人空间 C8）：TAG
export default async ({ page, shot }) => {
  await page.waitForTimeout(3000);
  const base = page.url().split("#")[0];
  await page.goto(base + "#/connections/account");
  await page.waitForTimeout(4500);
  await shot(process.env.TAG);
  console.log("PILLS:", (await page.locator(".account-card .pill").allInnerTexts()).join(" | "));
};
