// 打开事项页：MID；打印事项头 / 胶囊展开 / “⋯”菜单 / 事项成员页；ACT=remove:姓名 两步移出（REMOVE_GO=1 才点确定）；TAG 前缀
const ts = () => new Date().toISOString();
export default async ({ page, shot }) => {
  const TAG = process.env.TAG;
  page.on("response", async (r) => { if (!r.url().includes("/invoke")) return; try { const b = JSON.parse(r.request().postData() || "{}"); if (/^(matters\.members\.(add|remove|set_role)|matters\.update|matters\.members\.list)/.test(b.method)) console.log(ts(), "INVOKE", b.method, JSON.stringify(b.params).slice(0, 200), "→", (await r.text()).slice(0, 900)); } catch {} });
  await page.waitForTimeout(3000);
  const base = page.url().split("#")[0];
  await page.goto(base + "#/matter/" + process.env.MID); await page.waitForTimeout(5000);
  const head = page.locator(".matter-head, header").first();
  console.log("HEAD:", (await page.locator("main").first().innerText()).replace(/\s+/g, " ").slice(0, 400));
  const pill = page.locator("details.team-pill");
  console.log("PILL count:", await pill.count());
  if (await pill.count()) { await pill.locator("summary").click(); await page.waitForTimeout(1200); console.log("PILL:", (await pill.innerText()).replace(/\s+/g, " ")); await shot(`${TAG}-pill`); await pill.locator("summary").click(); }
  await page.locator("button.tab-more").click(); await page.waitForTimeout(600);
  console.log("MORE MENU:", (await page.locator(".tab-more-menu").innerText()).replace(/\s+/g, " "));
  await shot(`${TAG}-more-menu`);
  const mi = page.locator(".tab-more-menu button", { hasText: "事项成员" });
  if (await mi.count()) await mi.click(); else { await page.keyboard.press("Escape"); await page.locator("button.tab", { hasText: /^\s*事项成员\s*$/ }).first().click(); }
  await page.waitForTimeout(3000);
  const mm = page.locator("section.mm");
  console.log("MEMBERS:", (await mm.innerText()).replace(/\s+/g, " "));
  console.log("BUTTONS:", (await mm.locator("button:visible").allInnerTexts()).join(" | "), "| selects:", await mm.locator("select, .mm-role-select").count());
  await shot(`${TAG}-members`);
  if (process.env.ACT?.startsWith("remove:")) {
    const who = process.env.ACT.slice(7);
    const row = mm.locator("li.mm-row", { hasText: who });
    await row.locator("button", { hasText: /^\s*移出\s*$/ }).click(); await page.waitForTimeout(800);
    console.log("ASK:", (await row.innerText()).replace(/\s+/g, " "));
    await shot(`${TAG}-remove-ask`);
    if (process.env.REMOVE_GO) { await row.locator("button", { hasText: "确定移出" }).click(); console.log(ts(), "REMOVE GO"); await page.waitForTimeout(5000); console.log("AFTER:", (await mm.innerText()).replace(/\s+/g, " ")); await shot(`${TAG}-removed`); }
  }
};
