// 团队页成员行“⋯”→ LABEL（释放席位 / 分配席位）；有确认框就点确认
const ts = () => new Date().toISOString();
export default async ({ page, shot }) => {
  const TAG = process.env.TAG;
  page.on("response", async (r) => { if (!r.url().includes("/invoke")) return; try { const b = JSON.parse(r.request().postData() || "{}"); if (/seat/i.test(b.method) || (/^(members\.|team\.)/.test(b.method) && !/list|status|roster|summary|refresh|deviceShare/.test(b.method))) console.log(ts(), "INVOKE", b.method, JSON.stringify(b.params), "→", (await r.text()).slice(0, 400)); } catch {} });
  await page.waitForTimeout(3000);
  const base = page.url().split("#")[0];
  await page.goto(base + "#/connections/team"); await page.waitForTimeout(4500);
  console.log("SEATS:", (await page.locator("main").first().innerText()).replace(/\s+/g, " ").match(/席位（AI 使用名额）[^。]{0,40}/)?.[0]);
  for (const [name, label] of process.env.OPS.split(";").map((x) => x.split(":"))) {
    const row = page.locator("tr", { hasText: name }).filter({ has: page.locator("button") }).first();
    await row.scrollIntoViewIfNeeded();
    console.log("ROW", name, ":", (await row.innerText()).replace(/\s+/g, " "));
    await row.locator("button").last().click(); await page.waitForTimeout(800);
    const menu = page.locator("[role=menu], .popover").last();
    console.log("MENU:", (await menu.innerText()).replace(/\s+/g, " "));
    await menu.locator("button, [role=menuitem]", { hasText: label }).first().click(); await page.waitForTimeout(1200);
    const d = page.locator(".modal, [role=dialog], [role=alertdialog]");
    if (await d.count()) { console.log("DIALOG:", (await d.last().innerText()).replace(/\s+/g, " ").slice(0, 500)); await d.last().locator("button.btn-primary, button.btn-danger").last().click(); }
    console.log(ts(), "DONE", name, label); await page.waitForTimeout(3500);
    console.log("ROW AFTER", name, ":", (await row.innerText()).replace(/\s+/g, " "));
    console.log("ERR:", (await page.locator(".activate-error, [role=alert]").allInnerTexts()).join("|").replace(/\s+/g, " ").slice(0, 300));
  }
  console.log("SEATS AFTER:", (await page.locator("main").first().innerText()).replace(/\s+/g, " ").match(/席位（AI 使用名额）[^。]{0,40}/)?.[0]);
  await shot(TAG, { full: true });
};
