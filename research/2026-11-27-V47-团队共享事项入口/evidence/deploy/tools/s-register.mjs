// 新电脑注册个人空间（dry-run 短信）：P / E / N
const PHONE = process.env.P, EMAIL = process.env.E, NAME = process.env.N, PW = "Kwl-Local-2026a";
const btn = (page, re) => page.locator("button:visible").filter({ hasText: re });
export default async ({ page, shot }) => {
  await page.waitForSelector("[data-auth-page]", { timeout: 90000 });
  await page.waitForTimeout(1500);
  await page.locator('[data-auth-page] button.btn-link').filter({ hasText: /^\s*注册\s*$/ }).first().click();
  await page.waitForTimeout(500);
  await page.locator('input[type="tel"]:visible').fill(PHONE);
  await btn(page, /^\s*获取验证码\s*$/).first().click();
  await page.waitForFunction(() => /测试环境：验证码是\s*\d+/.test(document.body.innerText), null, { timeout: 30000 });
  const code = (await page.evaluate(() => document.body.innerText)).match(/测试环境：验证码是\s*(\d+)/)[1];
  await page.locator('input[autocomplete="one-time-code"]:visible').fill(code);
  await btn(page, /^\s*下一步\s*$/).click();
  await page.waitForTimeout(400);
  await page.locator('input[autocomplete="name"]:visible').fill(NAME);
  await page.locator('input[type="email"]:visible').fill(EMAIL);
  await page.locator('input[type="password"]:visible').first().fill(PW);
  await btn(page, /^\s*注册并继续\s*$/).click();
  for (let i = 0; i < 240; i++) {
    await page.waitForTimeout(500);
    const t = await page.evaluate(() => document.body.innerText).catch(() => "");
    if (/新建任务/.test(t)) { console.log("IN after", i / 2, "s"); break; }
  }
  await page.waitForTimeout(2500);
  await shot(process.env.SHOT ?? `r-${NAME}-home`);
};
