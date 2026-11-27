// 打开 HASH 页，滚到含 TEXT 的元素再拍：HASH=#/… TEXT=… SHOT=名字
export default async ({ page, shot, base }) => {
  await page.waitForTimeout(4000);
  await page.goto(base.split("#")[0] + process.env.HASH);
  await page.waitForTimeout(4000);
  const el = page.getByText(process.env.TEXT, { exact: false }).first();
  await el.scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  console.log("ROW:", (await el.evaluate((n) => (n.closest("section,.card,.set-card,div") ?? n).innerText)).replace(/\s+/g, " ").slice(0, 400));
  await shot(process.env.SHOT);
};
