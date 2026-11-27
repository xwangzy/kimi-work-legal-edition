// 设置 · 账号整页（C8）：TAG；整页一张 + 滚到底部一张
export default async ({ page, shot }) => {
  await page.waitForTimeout(3000);
  const base = page.url().split("#")[0];
  await page.goto(base + "#/connections/account");
  await page.waitForTimeout(4500);
  await shot(process.env.TAG);
  await shot(process.env.TAG + "-full", { full: true });
  await page.evaluate(() => { const m = document.querySelector("main") || document.scrollingElement; m.scrollTop = m.scrollHeight; for (const el of document.querySelectorAll("*")) { if (el.scrollHeight > el.clientHeight + 50 && getComputedStyle(el).overflowY.match(/auto|scroll/)) el.scrollTop = el.scrollHeight; } });
  await page.waitForTimeout(600);
  await shot(process.env.TAG + "-bottom");
  console.log("PILLS:", (await page.locator(".pill, .tag").allInnerTexts()).join(" | "));
};
