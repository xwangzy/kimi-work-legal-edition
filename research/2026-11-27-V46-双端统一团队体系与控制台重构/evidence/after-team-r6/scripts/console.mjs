// 团队管理员登录控制台 → 本所 · 电脑；读每行；点“待确认共享”筛选
const TAG = process.env.TAG;
const txt = (page, s = "main") => page.locator(s).first().innerText().then((t) => t.replace(/\s+/g, " ")).catch(() => "-");
export default async ({ page, shot }) => {
  await page.goto("http://127.0.0.1:18743/"); await page.waitForSelector("#lg-email", { timeout: 20000 });
  await page.fill("#lg-email", process.env.EMAIL); await page.fill("#lg-pw", "Kwl-Local-2026a"); await page.locator("button[type=submit]").first().click();
  await page.waitForTimeout(3500);
  console.log("landing:", page.url(), "| nav:", (await txt(page, "nav, aside")).slice(0, 300));
  await page.locator("nav a, aside a, nav button, aside button").filter({ hasText: /^\s*电脑\s*$/ }).first().click(); await page.waitForTimeout(3500); console.log("URL", page.url());
  console.log("DEVICES:", (await txt(page)).slice(0, 2500));
  await shot(`${TAG}-console-firm-devices`, { full: true });
  const rows = await page.$$eval("tr, [role=row], .row, li", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()).filter((t) => /冯三禾|郑二宁|周一航/.test(t) && t.length < 400));
  console.log("ROWS:", JSON.stringify([...new Set(rows)], null, 1));
  const f = page.locator("button:visible, [role=tab]:visible, [role=radio]:visible, label:visible").filter({ hasText: /待确认共享/ }).first();
  if (await f.count()) { console.log("FILTER:", (await f.innerText()).replace(/\s+/g, " ")); await f.click(); await page.waitForTimeout(1500); await shot(`${TAG}-console-filter-pending`, { full: true }); console.log("FILTERED:", (await txt(page)).slice(0, 1500)); }
};
