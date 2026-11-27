// 通用：HASH 路由 → 等待 → 打印 SEL 文本（RE 截取）→ 截图 TAG
export default async ({ page, shot }) => {
  await page.waitForTimeout(2500);
  const base = page.url().split("#")[0];
  if (process.env.HASH) { await page.goto(base + "#" + process.env.HASH); await page.waitForTimeout(Number(process.env.WAIT || 4000)); }
  if (process.env.SCROLL) { await page.getByText(process.env.SCROLL, { exact: false }).first().scrollIntoViewIfNeeded().catch(() => {}); await page.waitForTimeout(500); }
  const t = (await page.locator(process.env.SEL || "body").first().innerText()).replace(/\s+/g, " ");
  const re = process.env.RE ? new RegExp(process.env.RE) : null;
  console.log("TEXT:", re ? (t.match(re)?.[0] ?? "(no match)") : t.slice(0, Number(process.env.N || 1500)));
  if (process.env.HTML) console.log("HTML:", (await page.locator(process.env.HTML).first().evaluate((e) => e.outerHTML)).slice(0, 2500));
  if (process.env.TAG) await shot(process.env.TAG, { full: !!process.env.FULL });
};
