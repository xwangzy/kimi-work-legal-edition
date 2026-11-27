// 乙：账号页输入邀请码加入 → 进团队空间 → 截图 → 团队页团队共享
import { readFileSync } from "node:fs";
const btn = (page, re) => page.locator("button:visible").filter({ hasText: re });
const waitHome = async (page, ms = 120000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await page.waitForTimeout(500);
    const t = await page.evaluate(() => document.body.innerText).catch(() => "");
    if (/新建任务/.test(t) && !(await page.locator(".ws-switching").count().catch(() => 1))) return (Date.now() - t0) / 1000;
  }
  return -1;
};
export default async ({ page, shot }) => {
  const code = readFileSync(new URL("./" + (process.env.INVF || "invite.txt"), import.meta.url), "utf8").trim();
  await page.waitForTimeout(3000);
  const base = page.url().split("#")[0];
  await page.goto(base + "#/connections/account");
  await page.waitForTimeout(3500);
  await page.locator(".ws-join-input").fill(code);
  await btn(page, /^\s*加入\s*$/).click();
  console.log("in team after", await waitHome(page), "s");
  await page.waitForTimeout(3000);
  await shot(process.env.TAG || "b01-team-home");
  console.log("CARD:", (await page.locator(".sidebar-foot").innerText()).replace(/\s+/g, " "));
};
