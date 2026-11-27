// 成员：团队页常开，不手动刷新；每秒记录“团队共享”行与橙色提示数，变化即截图；记主框架导航
const ts = () => new Date().toISOString();
export default async ({ page, shot }) => {
  await page.waitForTimeout(3000);
  const base = page.url().split("#")[0];
  await page.goto(base + "#/connections/team");
  await page.locator(".device-k", { hasText: "团队共享" }).first().waitFor({ timeout: 30000 });
  await page.locator(".device-k", { hasText: "团队共享" }).first().scrollIntoViewIfNeeded();
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) console.log(ts(), "NAV", f.url()); });
  let last = "", n = 0;
  const end = Date.now() + Number(process.env.DUR || 120000);
  console.log(ts(), "WATCH START");
  while (Date.now() < end) {
    const t = await page.evaluate(() => { const r = [...document.querySelectorAll(".device-row")].find((x) => /团队共享/.test(x.querySelector(".device-k")?.innerText || "")); return (r ? r.innerText.replace(/\s+/g, " ") : "(无团队共享行)") + " || notes=" + document.querySelectorAll(".share-note").length + " cannot=" + (document.body.innerText.match(/还不能接收/g) || []).length; }).catch((e) => "(err " + e.message.slice(0, 60) + ")");
    if (t !== last) { last = t; n++; console.log(ts(), "ROW:", t.slice(0, 300)); await page.locator(".device-k", { hasText: "团队共享" }).first().scrollIntoViewIfNeeded().catch(() => {}); await shot(`${process.env.TAG}-${n}`); }
    await page.waitForTimeout(1000);
  }
};
