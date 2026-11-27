const ts = () => new Date().toISOString();
export default async ({ page, shot }) => {
  page.on("response", async (r) => { if (!r.url().includes("/invoke")) return; try { const b = JSON.parse(r.request().postData() || "{}"); if (/^matters\.members\.(?!list)/.test(b.method)) console.log(ts(), "INVOKE", b.method, JSON.stringify(b.params), "→", (await r.text()).slice(0, 500)); } catch {} });
  await page.waitForTimeout(3000);
  const base = page.url().split("#")[0];
  await page.goto(base + "#/matter/" + process.env.MID); await page.waitForTimeout(4500);
  await page.locator("button.tab-more").click(); await page.waitForTimeout(500);
  await page.locator(".tab-more-menu button", { hasText: "事项成员" }).click(); await page.waitForTimeout(3000);
  const row = page.locator("li.mm-row", { hasText: process.env.NAME });
  await row.locator(".mm-role-select, .select-trigger, select").first().click(); await page.waitForTimeout(600);
  console.log("OPTIONS:", (await page.locator("[role=option]").allInnerTexts()).join(" | ").replace(/\s+/g, " "));
  await shot(process.env.TAG + "-options");
  await page.locator("[role=option]", { hasText: process.env.ROLE }).first().click(); await page.waitForTimeout(3500);
  console.log("AFTER:", (await page.locator("section.mm").innerText()).replace(/\s+/g, " "));
  await shot(process.env.TAG + "-after");
};
