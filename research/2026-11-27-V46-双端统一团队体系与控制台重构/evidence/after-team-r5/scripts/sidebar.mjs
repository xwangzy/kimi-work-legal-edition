// 侧栏用户卡：TAG
export default async ({ page, shot }) => {
  await page.waitForTimeout(5000);
  await shot(process.env.TAG);
  console.log("SIDEBAR:", (await page.locator(".sidebar-foot").innerText().catch(() => "")).replace(/\s+/g, " "));
};
