// 首页：上手清单卡片文字（P3-4）+ 截图
export default async ({ page, shot }) => {
  await page.waitForTimeout(3500);
  const base = page.url().split("#")[0];
  await page.goto(base + "#/"); await page.waitForTimeout(3500);
  const cards = await page.$$eval("[class*=onboard] li, [class*=onboard] .card, [class*=guide] li, [class*=checklist] li, [class*=start-card]", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 12));
  console.log("CARDS:", JSON.stringify(cards));
  const t = (await page.locator("main").first().innerText()).replace(/\s+/g, " ");
  console.log("HOME:", t.slice(0, 900));
  await shot(process.env.TAG);
};
