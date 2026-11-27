// 甲：团队页 → 邀请（INV 姓名）→ 码写 OUT 文件
import { writeFileSync } from "node:fs";
const btn = (page, re) => page.locator("button:visible").filter({ hasText: re });
export default async ({ page, shot }) => {
  await page.waitForTimeout(3000);
  const base = page.url().split("#")[0];
  await page.goto(base + "#/connections/team");
  await page.waitForTimeout(4000);
  await btn(page, /邀请成员/).first().click();
  await page.waitForTimeout(400);
  await page.locator(".invite-form input").fill(process.env.INV);
  await page.locator(".role-opt").filter({ hasText: "律师" }).first().click();
  await btn(page, /^\s*生成邀请码\s*$/).click();
  await page.waitForSelector(".invite-code", { timeout: 20000 });
  writeFileSync(new URL("./" + process.env.OUT, import.meta.url), (await page.locator(".invite-code").innerText()).trim());
  await shot(process.env.TAG);
  await btn(page, /^\s*完成\s*$/).click();
};
