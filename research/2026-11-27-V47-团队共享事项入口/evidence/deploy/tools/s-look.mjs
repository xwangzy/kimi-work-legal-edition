// 拍几页：用法 PAGES="名字=#/路径,名字=#/路径" node pw.mjs <目录> s-look.mjs <base>
export default async ({ page, shot, base }) => {
  await page.waitForTimeout(4000);
  for (const item of (process.env.PAGES ?? "").split(",").filter(Boolean)) {
    const [name, hash] = item.split("=");
    await page.goto(base.split("#")[0] + hash);
    await page.waitForTimeout(3500);
    const t = (await page.evaluate(() => document.querySelector(".main")?.innerText ?? document.body.innerText)).replace(/\s+/g, " ");
    console.log(`TEXT ${name}:`, t.slice(0, 600));
    await shot(name, { full: process.env.FULL === "1" });
  }
};
