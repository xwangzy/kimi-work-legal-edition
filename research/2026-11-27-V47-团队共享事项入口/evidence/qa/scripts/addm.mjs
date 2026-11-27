const ts = () => new Date().toISOString();
export default async ({ page, shot }) => {
  const TAG = process.env.TAG;
  page.on("response", async (r) => { if (!r.url().includes("/invoke")) return; try { const b = JSON.parse(r.request().postData() || "{}"); if (/^matters\.members\.(add|remove)/.test(b.method)) console.log(ts(), "INVOKE", b.method, JSON.stringify(b.params), "→", (await r.text()).slice(0, 600)); } catch {} });
  await page.waitForTimeout(3000);
  const base = page.url().split("#")[0];
  await page.goto(base + "#/matter/" + process.env.MID); await page.waitForTimeout(4500);
  await page.locator("button.tab-more").click(); await page.waitForTimeout(500);
  await page.locator(".tab-more-menu button", { hasText: "事项成员" }).click(); await page.waitForTimeout(3000);
  await page.locator("section.mm button.mm-add").click(); await page.waitForTimeout(2000);
  const m = page.locator(".modal, [role=dialog]").last();
  console.log("MODAL:", (await m.innerText()).replace(/\s+/g, " ").slice(0, 600));
  await m.locator(".cp-row", { hasText: process.env.NAME }).locator("input").check(); await page.waitForTimeout(400);
  await shot(`${TAG}-modal`);
  await m.locator("button.btn-primary").click(); console.log(ts(), "ADD GO"); await page.waitForTimeout(4000);
  console.log("MEMBERS:", (await page.locator("section.mm").innerText()).replace(/\s+/g, " "));
  await shot(`${TAG}-after`);
};
