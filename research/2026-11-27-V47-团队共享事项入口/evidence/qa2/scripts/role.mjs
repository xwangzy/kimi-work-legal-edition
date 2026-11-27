const ts = () => new Date().toISOString();
export default async ({ page, shot }) => {
  page.on("response", async (r) => { if (!r.url().includes("/invoke")) return; try { const b = JSON.parse(r.request().postData() || "{}"); if (/^matters\.members\.add/.test(b.method)) console.log(ts(), "INVOKE", b.method, JSON.stringify(b.params), "→", (await r.text()).slice(0, 400)); } catch {} });
  await page.waitForTimeout(3000);
  const base = page.url().split("#")[0];
  await page.goto(base + "#/matter/" + process.env.MID); await page.waitForTimeout(4500);
  await page.locator("button.tab, [role=tab]", { hasText: /事项成员/ }).first().click(); await page.waitForTimeout(3000);
  const row = page.locator("ul.mm-list > li").filter({ hasText: process.env.NAME });
  await page.locator(`[aria-label^="${process.env.NAME}的角色"]`).first().click(); await page.waitForTimeout(600);
  const opts = page.locator("[role=option]");
  console.log("OPTIONS:", (await opts.allInnerTexts()).join(" | ").replace(/\s+/g, " "));
  await opts.filter({ hasText: /^\s*只看/ }).first().click(); await page.waitForTimeout(3500);
  console.log("AFTER:", (await page.locator("section.mm").innerText()).replace(/\s+/g, " "));
  await shot(process.env.TAG);
};
