// 事项页加材料：MID、FILE（绝对路径）；打印材料页
const ts = () => new Date().toISOString();
export default async ({ page, shot }) => {
  page.on("response", async (r) => { if (!r.url().includes("/invoke")) return; try { const b = JSON.parse(r.request().postData() || "{}"); if (/^(documents|materials|import)\./.test(b.method) && !/list|get|status/.test(b.method)) console.log(ts(), "INVOKE", b.method, "→", (await r.text()).slice(0, 300)); } catch {} });
  await page.waitForTimeout(3000);
  const base = page.url().split("#")[0];
  await page.goto(base + "#/matter/" + process.env.MID); await page.waitForTimeout(4500);
  await page.locator("button.tab, [role=tab]", { hasText: /^\s*材料/ }).first().click().catch(() => {}); await page.waitForTimeout(2000);
  const inp = page.locator("input[type=file]").first();
  console.log("file inputs:", await page.locator("input[type=file]").count());
  await inp.setInputFiles(process.env.FILE); await page.waitForTimeout(6000);
  console.log("AFTER:", (await page.locator("main").first().innerText()).replace(/\s+/g, " ").slice(0, 700));
  await shot(process.env.TAG);
};
