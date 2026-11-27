export default async ({ page, shot }) => {
  await page.waitForTimeout(3000);
  const base = page.url().split("#")[0];
  await page.goto(base + "#/" + (process.env.MID ? "matter/" + process.env.MID : "")); await page.waitForTimeout(3500);
  if (process.env.MID) { await page.locator("button", { hasText: /^\s*发起任务\s*$/ }).first().click(); await page.waitForTimeout(1500); }
  await page.locator("textarea:visible").first().fill(process.env.GOAL || "帮我梳理本案争议焦点");
  await page.locator("textarea:visible").first().press("Enter"); await page.waitForTimeout(4000);
  const ex = page.locator(".authz-exits");
  console.log("EXITS count:", await ex.count());
  if (!(await ex.count())) { console.log("MAIN:", (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 600)); await shot(process.env.TAG + "-noexits"); return; }
  await ex.scrollIntoViewIfNeeded(); await page.waitForTimeout(500);
  console.log("EXITS:", (await ex.innerText()).replace(/\s+/g, " "));
  const b = ex.locator("button", { hasText: "记为客户要求不上云" });
  console.log("disabled:", await b.isDisabled(), "describedby:", await b.getAttribute("aria-describedby"));
  const bt = (await page.locator("body").innerText()).replace(/\s+/g, " "); console.log("CARD:", bt.match(/授权要覆盖.{0,120}/)?.[0], "||", bt.match(/系统另外做到.{0,40}/)?.[0]);
  await shot(process.env.TAG);
  await page.locator("button", { hasText: "返回修改" }).click().catch(() => {});
};
