// 负责人在事项成员页两步移出 NAME
const ts = () => new Date().toISOString();
export default async ({ page, shot }) => {
  page.on("response", async (r) => { if (!r.url().includes("/invoke")) return; try { const b = JSON.parse(r.request().postData() || "{}"); if (/^matters\.members\.remove/.test(b.method)) console.log(ts(), "INVOKE", b.method, JSON.stringify(b.params), "→", (await r.text()).slice(0, 600)); } catch {} });
  await page.waitForTimeout(3000);
  const base = page.url().split("#")[0];
  await page.goto(base + "#/matter/" + process.env.MID); await page.waitForTimeout(4500);
  await page.locator("button.tab, [role=tab]", { hasText: /事项成员/ }).first().click(); await page.waitForTimeout(3000);
  const row = page.locator("ul.mm-list > li").filter({ hasText: process.env.NAME });
  await row.locator("button.mm-remove").click(); await page.waitForTimeout(600);
  console.log("ASK:", (await row.locator(".mm-confirm").innerText()).replace(/\s+/g, " "));
  await shot(`${process.env.TAG}-ask`);
  await row.locator(".mm-confirm button", { hasText: /确定移出/ }).click(); console.log(ts(), "REMOVE GO"); await page.waitForTimeout(4000);
  console.log("AFTER:", (await page.locator("section.mm").innerText()).replace(/\s+/g, " "));
  await shot(`${process.env.TAG}-after`);
};
