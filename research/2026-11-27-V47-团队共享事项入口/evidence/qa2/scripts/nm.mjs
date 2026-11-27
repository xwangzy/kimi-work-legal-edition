// 完整“新建事项”弹窗：TITLE、SCOPE=team|personal、PICK=姓名,姓名、CONF=怎么处理选项文字、SUBMIT=1；TAG 截图前缀
const ts = () => new Date().toISOString();
export default async ({ page, shot }) => {
  const TAG = process.env.TAG;
  page.on("response", async (r) => { if (!r.url().includes("/invoke")) return; try { const b = JSON.parse(r.request().postData() || "{}"); if (/^(matters\.create|matters\.members|matters\.update|team\.)/.test(b.method)) console.log(ts(), "INVOKE", b.method, JSON.stringify(b.params).slice(0, 400), "→", (await r.text()).slice(0, 700)); } catch {} });
  await page.waitForTimeout(3500);
  const base = page.url().split("#")[0];
  await page.goto(base + "#/"); await page.waitForTimeout(3000);
  await page.locator('button.section-act[aria-label="新建事项"]').first().click({ force: true });
  await page.waitForSelector(".modal, [role=dialog]", { timeout: 15000 }); await page.waitForTimeout(2500);
  const dlg = page.locator(".modal, [role=dialog]").first();
  const sf = dlg.locator(".scope-field");
  console.log("SCOPE FIELD count:", await sf.count());
  if (await sf.count()) {
    console.log("SCOPE TEXT:", (await sf.innerText()).replace(/\s+/g, " "));
    console.log("TEAM BTN disabled:", await sf.locator('button[role=radio]', { hasText: "团队共享" }).isDisabled());
    console.log("去申请 link:", await sf.locator(".scope-go").count());
  }
  console.log("DIALOG TEXT:", (await dlg.innerText()).replace(/\s+/g, " ").slice(0, 900));
  if (process.env.TITLE) await dlg.locator('input[placeholder^="例如"]').fill(process.env.TITLE);
  if (process.env.CLIENT) await dlg.locator('input[placeholder^="委托人"]').fill(process.env.CLIENT);
  if (process.env.CONF) await dlg.locator('[aria-label="怎么处理"] button[role=radio]', { hasText: process.env.CONF }).click();
  if (process.env.SCOPE === "team") {
    await sf.locator('button[role=radio]', { hasText: "团队共享" }).click(); await page.waitForTimeout(1200);
    console.log("SCOPE TEXT (team):", (await sf.innerText()).replace(/\s+/g, " "));
    if (process.env.PICK) {
      await sf.locator(".cp-toggle").click(); await page.waitForTimeout(800);
      console.log("LIST:", (await sf.locator(".cp-list").innerText()).replace(/\s+/g, " "));
      await shot(`${TAG}-picklist`);
      for (const n of process.env.PICK.split(",")) await sf.locator(".cp-row", { hasText: n }).locator("input").check();
      await page.waitForTimeout(500);
      console.log("PICKED:", (await sf.innerText()).replace(/\s+/g, " "));
    }
  }
  await shot(`${TAG}-form`);
  if (!process.env.SUBMIT) return;
  await dlg.locator("button.btn-primary", { hasText: "创建事项" }).click(); console.log(ts(), "SUBMIT");
  await page.waitForTimeout(6000);
  console.log("URL:", page.url());
  console.log("ERRS:", (await page.locator(".activate-error, [role=alert]").allInnerTexts()).join(" | ").replace(/\s+/g, " "));
  console.log("HEAD:", (await page.locator("main").first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 500));
  await shot(`${TAG}-created`);
};
