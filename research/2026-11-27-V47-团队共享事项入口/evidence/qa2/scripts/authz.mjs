// 首页对团队共享事项发起 → 开始前确认的授权卡；拦截 ai_authorization.get：先失败、再延迟 8 秒后放行（点重试）
const ts = () => new Date().toISOString();
let mode = "fail";
export default async ({ page, shot }) => {
  const TAG = process.env.TAG;
  await page.route("**/invoke", async (route) => {
    let m = ""; try { m = JSON.parse(route.request().postData() || "{}").method; } catch {}
    if (m !== "ai_authorization.get") return route.continue();
    console.log(ts(), "INTERCEPT ai_authorization.get mode=" + mode);
    if (mode === "fail") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "unavailable", message: "测试拦截：读取失败" } }) });
    if (mode === "delay") { await new Promise((r) => setTimeout(r, 8000)); return route.continue(); }
    return route.continue();
  });
  await page.waitForTimeout(3500);
  const base = page.url().split("#")[0];
  await page.goto(base + "#/"); await page.waitForTimeout(4000);
  console.log("HOME CHIP:", (await page.locator("main").first().innerText()).replace(/\s+/g, " ").match(/先给我看计划.{0,60}/)?.[0]);
  await page.locator("textarea:visible").first().fill("帮我梳理本案争议焦点和证据清单");
  await page.locator("textarea:visible").first().press("Enter");
  const go = page.locator("button", { hasText: /记录授权并开始|重新确认并开始/ }).first();
  await go.waitFor({ timeout: 60000 }); await page.waitForTimeout(1500);
  const card = async () => (await page.locator(".modal, [role=dialog]").last().innerText()).replace(/\s+/g, " ").replace(/^.*?记录本案的客户授权/, "记录本案的客户授权");
  await page.locator("label, [role=radio], button").filter({ hasText: /委托合同中的 AI 条款/ }).first().click(); await page.waitForTimeout(800);
  const dlg = page.locator(".modal, [role=dialog]").last();
  const ins = dlg.locator("input:visible:not([type=radio]):not([type=checkbox]), textarea:visible");
  console.log("inputs in card:", await ins.count());
  await ins.first().fill("委托合同第 8 条（AI 辅助条款）"); await page.waitForTimeout(500);
  console.log("[FAIL] go disabled:", await go.isDisabled(), "| retry btns:", await page.locator("button:visible", { hasText: /^\s*重试\s*$/ }).count());
  console.log("[FAIL] CARD:", (await card()).slice(0, 1500));
  await go.scrollIntoViewIfNeeded(); await shot(`${TAG}-fail`, { full: true });
  mode = "delay";
  await page.locator("button:visible", { hasText: /^\s*重试\s*$/ }).first().click(); await page.waitForTimeout(2000);
  console.log("[LOADING] go disabled:", await go.isDisabled(), "| note:", (await card()).match(/正在读取[^。]{0,30}|没读到[^。]{0,40}/)?.[0]);
  await shot(`${TAG}-loading`, { full: true });
  await page.waitForTimeout(9000);
  console.log("[OK] go disabled:", await go.isDisabled());
  console.log("[OK] CARD:", (await card()).slice(0, 2000));
  await shot(`${TAG}-ok`, { full: true });
  if (!process.env.GO) { await page.locator("button", { hasText: "返回修改" }).click().catch(() => {}); return; }
};
