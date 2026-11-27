// 首页写任务 → 回车发送 → “放进哪个事项？”→ 新建事项（团队 + PICK）→ 建好并发起（GO=1）
const ts = () => new Date().toISOString();
export default async ({ page, shot }) => {
  const TAG = process.env.TAG;
  page.on("response", async (r) => { if (!r.url().includes("/invoke")) return; try { const b = JSON.parse(r.request().postData() || "{}"); if (/^(matters\.create|tasks\.(create|start)|runs\.)/.test(b.method)) console.log(ts(), "INVOKE", b.method, JSON.stringify(b.params).slice(0, 300), "→", (await r.text()).slice(0, 500)); } catch {} });
  await page.waitForTimeout(3000);
  const base = page.url().split("#")[0];
  await page.goto(base + "#/"); await page.waitForTimeout(3500);
  console.log("TRAY:", (await page.locator(".composer, form").first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 200));
  await page.locator("textarea").first().fill(process.env.GOAL || "审查这份股权转让协议，我方为受让方");
  await page.locator("textarea").first().press("Enter"); await page.waitForTimeout(2000);
  const pop = page.locator(".place-pop");
  console.log("POP count:", await pop.count(), "mode:", await pop.getAttribute("data-place").catch(() => null));
  if (!(await pop.count())) { await shot(`${TAG}-nopop`); return; }
  console.log("POP:", (await pop.innerText()).replace(/\s+/g, " ").slice(0, 700));
  console.log("TEAM MARKS in list:", await pop.locator(".place-list .menu-item svg, .place-list [class*=team-mark], .place-list .team-mark").count());
  await shot(`${TAG}-pop`);
  if ((await pop.getAttribute("data-place")) !== "create") { await pop.locator("button.place-new").click(); await page.waitForTimeout(800); }
  if (process.env.TITLE) await pop.locator(".place-fields input.input").first().fill(process.env.TITLE);
  const st = pop.locator('.select-trigger[aria-label^="我方立场"]'); await st.click(); await page.waitForTimeout(400); await page.locator('[role=option]', { hasText: process.env.STANCE || "受让方" }).first().click().catch(async () => { await page.locator('[role=option]').first().click(); });
  await page.waitForTimeout(400);
  const sf = pop.locator(".scope-field");
  console.log("SCOPE:", await sf.count() ? (await sf.innerText()).replace(/\s+/g, " ") : "(none)");
  if (process.env.SCOPE === "team") {
    await sf.locator('button[role=radio]', { hasText: "和同事一起办" }).click(); await page.waitForTimeout(800);
    if (process.env.PICK) { await sf.locator(".cp-add").click(); await page.waitForTimeout(500); for (const n of process.env.PICK.split(",")) await sf.locator(".cp-row", { hasText: n }).locator("input").check(); }
    console.log("SCOPE team:", (await sf.innerText()).replace(/\s+/g, " "));
  }
  await shot(`${TAG}-form`);
  if (!process.env.GO) return;
  await pop.locator("button[type=submit]", { hasText: "建好并发起" }).click(); console.log(ts(), "GO");
  await page.waitForTimeout(9000);
  console.log("URL:", page.url());
  console.log("MAIN:", (await page.locator("main").first().innerText()).replace(/\s+/g, " ").slice(0, 900));
  await shot(`${TAG}-after`);
};
