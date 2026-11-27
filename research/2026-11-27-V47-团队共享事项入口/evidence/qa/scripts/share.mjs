const ts = () => new Date().toISOString();
export default async ({ page, shot }) => {
  const TAG = process.env.TAG;
  page.on("response", async (r) => { if (!r.url().includes("/invoke")) return; try { const b = JSON.parse(r.request().postData() || "{}"); if (/^(matters\.update|matters\.members\.add)/.test(b.method)) console.log(ts(), "INVOKE", b.method, JSON.stringify(b.params).slice(0, 300), "→", (await r.text()).slice(0, 700)); } catch {} });
  await page.waitForTimeout(3000);
  const base = page.url().split("#")[0];
  await page.goto(base + "#/matter/" + process.env.MID); await page.waitForTimeout(4500);
  console.log("PILL before:", await page.locator("details.team-pill").count());
  await page.locator("button.tab-more").click(); await page.waitForTimeout(600);
  console.log("MORE MENU:", (await page.locator(".tab-more-menu").innerText()).replace(/\s+/g, " "));
  const mi = page.locator(".tab-more-menu button", { hasText: "和同事一起办" });
  if (!(await mi.count())) { await shot(`${TAG}-menu`); return; }
  await mi.click(); await page.waitForTimeout(2500);
  const m = page.locator(".modal, [role=dialog]").last();
  console.log("MODAL:", (await m.innerText()).replace(/\s+/g, " "));
  if (process.env.PICK) for (const n of process.env.PICK.split(",")) { const row = m.locator(".cp-row", { hasText: n }); if (!(await row.count())) { await m.locator(".cp-add").click().catch(() => {}); await page.waitForTimeout(400); } await m.locator(".cp-row", { hasText: n }).locator("input").check(); }
  await page.waitForTimeout(500);
  await shot(`${TAG}-modal`);
  console.log("PRIMARY:", await m.locator("button.btn-primary").innerText());
  await m.locator("button.btn-primary").click(); console.log(ts(), "GO"); await page.waitForTimeout(4000);
  console.log("MODAL2:", (await page.locator(".modal, [role=dialog]").count()) ? (await page.locator(".modal, [role=dialog]").last().innerText()).replace(/\s+/g, " ").slice(0, 400) : "(closed)");
  console.log("MAIN:", (await page.locator("main").first().innerText()).replace(/\s+/g, " ").slice(0, 700));
  await shot(`${TAG}-after`);
};
