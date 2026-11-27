// 甲：起草律所策略（放宽“客服直发”+ 额外网站）→ 确认 → 发布
const ts = () => new Date().toISOString();
export default async ({ page, shot }) => {
  page.on("response", async (r) => { if (!r.url().includes("/invoke")) return; try { const b = JSON.parse(r.request().postData() || "{}"); if (/^(policy|firm_policy)/.test(b.method) && !/status|drafts|^policy\.get/.test(b.method)) console.log(ts(), "INVOKE", b.method, "→", (await r.text()).slice(0, 300)); } catch {} });
  await page.waitForTimeout(3000);
  const base = page.url().split("#")[0];
  await page.goto(base + "#/connections/team"); await page.waitForTimeout(4500);
  const form = page.locator(".device-row", { hasText: "起草律所策略" }).last();
  await form.scrollIntoViewIfNeeded();
  await form.locator("label.pd-check", { hasText: "律师可以把问题报告直接发给客服" }).locator("input").check();
  await form.locator('textarea[aria-label^="官方网站之外"]').fill("www.example.com");
  await shot("2-0-prep-draft-form");
  await form.locator("button", { hasText: "生成草稿" }).click(); await page.waitForTimeout(3500);
  const sec = page.locator("#sec-policy-drafts"); await sec.scrollIntoViewIfNeeded();
  const panel = page.locator(".panel", { hasText: "律所策略第" }).first();
  console.log("DRAFT:", (await panel.innerText()).replace(/\s+/g, " ").slice(0, 600));
  await panel.locator("button", { hasText: "核对无误，确认" }).click(); await page.waitForTimeout(3000);
  await panel.locator("button", { hasText: /^\s*发布\s*$/ }).click(); await page.waitForTimeout(600);
  await page.locator("button:visible", { hasText: "确定发布" }).click(); await page.waitForTimeout(4000);
  console.log("AFTER:", (await page.locator("main").first().innerText()).replace(/\s+/g, " ").match(/团队策略.{0,700}/)?.[0]);
  await shot("2-0-prep-published");
};
