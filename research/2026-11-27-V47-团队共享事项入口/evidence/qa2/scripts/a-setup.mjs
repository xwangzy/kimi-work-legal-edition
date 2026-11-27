// 甲：注册 → 升级为团队 → 邀请乙丙丁（码写 inv-<x>.txt）
import { writeFileSync } from "node:fs";
import reg from "./reg.mjs";
const btn = (page, re) => page.locator("button:visible").filter({ hasText: re });
export default async (ctx) => {
  const { page, shot } = ctx;
  await reg(ctx);
  const base = page.url().split("#")[0];
  await page.goto(base + "#/connections/account"); await page.waitForTimeout(3500);
  await btn(page, /把工作室升级为团队/).click(); await page.waitForTimeout(500);
  await page.locator(".ws-upgrade input:not([type=checkbox])").fill(process.env.TEAM);
  await page.locator(".ws-upgrade input[type=checkbox]").check();
  await btn(page, /^\s*升级为团队\s*$/).click();
  await page.waitForSelector(".ws-done", { timeout: 30000 }); await page.waitForTimeout(2500);
  await shot("0-a-upgraded");
  for (const [x, name] of [["b", "苏若溪"], ["c", "温景行"], ["d", "林清越"]]) {
    await page.goto(base + "#/connections/team"); await page.waitForTimeout(3500);
    await btn(page, /邀请成员/).first().click(); await page.waitForTimeout(400);
    await page.locator(".invite-form input").fill(name);
    await page.locator(".role-opt").filter({ hasText: "律师" }).first().click();
    await btn(page, /^\s*生成邀请码\s*$/).click();
    await page.waitForSelector(".invite-code", { timeout: 20000 });
    writeFileSync(new URL(`./inv-${x}.txt`, import.meta.url), (await page.locator(".invite-code").innerText()).trim());
    console.log("invited", name);
    await btn(page, /^\s*完成\s*$/).click(); await page.waitForTimeout(1200);
  }
  const t = (await page.locator("main").first().innerText()).replace(/\s+/g, " ");
  console.log("SEATS:", t.match(/席位[^。]{0,60}/)?.[0]);
  await shot("0-a-team-invited");
};
