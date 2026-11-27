// 设置 · 审计与支持 · 操作记录：TAG；ALL=1 另拍“全部”
export default async ({ page, shot }) => {
  await page.waitForTimeout(3000);
  const base = page.url().split("#")[0];
  await page.goto(base + "#/connections/admin");
  await page.waitForTimeout(6000);
  const head = page.locator(".audit-head").first();
  await head.waitFor({ timeout: 30000 }).catch(() => {});
  await head.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(500);
  await shot(process.env.TAG);
  const rows = await page.locator(".audit-item .audit-row").evaluateAll((els) => els.slice(0, 12).map((e) => { const c = [...e.children].map((x) => x.textContent.replace(/\s+/g, " ").trim()); const w = e.querySelector(".audit-what"); const rg = document.createRange(); rg.selectNodeContents(w); const lines = new Set([...rg.getClientRects()].map((q) => Math.round(q.top))).size; return c.slice(0, 4).join(" | ") + ` [what lines ${lines}]`; }));
  console.log("ROWS:\n" + rows.join("\n"));
  if (process.env.ALL) {
    await page.locator(".audit-bar button, .audit-bar [role=tab], .audit-bar [role=radio]").filter({ hasText: /^\s*全部/ }).first().click().catch((e) => console.log("all err", e.message));
    await page.waitForTimeout(1000);
    await shot(process.env.TAG + "-all");
    const rows2 = await page.locator(".audit-item .audit-row").evaluateAll((els) => els.slice(0, 14).map((e) => [...e.children].map((x) => x.textContent.replace(/\s+/g, " ").trim()).slice(0, 4).join(" | ")));
    console.log("ALL ROWS:\n" + rows2.join("\n"));
  }
};
