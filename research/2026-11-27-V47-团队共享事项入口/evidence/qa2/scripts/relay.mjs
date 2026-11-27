// 团队页“同事之间同步”行：BTN 正则（续期|关闭|重新开通|开通）；GO=1 点确认框主按钮；TAG
const ts = () => new Date().toISOString();
export default async ({ page, shot }) => {
  const TAG = process.env.TAG;
  page.on("response", async (r) => { if (!r.url().includes("/invoke")) return; try { const b = JSON.parse(r.request().postData() || "{}"); if (/share_relay_(enable|renew)|firm_policy\.(sign|publish|create_draft)/.test(b.method)) console.log(ts(), "INVOKE", b.method, JSON.stringify(b.params).slice(0, 300), "→", (await r.text()).slice(0, 700)); } catch {} });
  await page.waitForTimeout(3000);
  const base = page.url().split("#")[0];
  console.log("SIDEBAR FOOT:", (await page.locator(".sidebar-foot").innerText().catch(() => "")).replace(/\s+/g, " "));
  await page.goto(base + "#/connections/team"); await page.waitForTimeout(4500);
  const row = page.locator("#row-share-relay"); await row.scrollIntoViewIfNeeded(); await page.waitForTimeout(400);
  console.log("ROW BEFORE:", (await row.innerText()).replace(/\s+/g, " "));
  console.log("TEAM PAGE notes:", (await page.locator("main").first().innerText()).replace(/\s+/g, " ").match(/[^。]{0,40}到期[^。]{0,60}/g)?.slice(0, 4));
  await shot(`${TAG}-row-before`);
  if (!process.env.BTN) return;
  await row.locator("button", { hasText: new RegExp(process.env.BTN) }).first().click(); await page.waitForTimeout(1500);
  const m = page.locator(".modal, [role=dialog]").last();
  console.log("MODAL:", (await m.innerText()).replace(/\s+/g, " ").slice(0, 1500));
  await shot(`${TAG}-modal`);
  if (!process.env.GO) return;
  await m.locator("button.btn-primary, button.btn-danger").last().click(); console.log(ts(), "CLICK GO");
  await page.waitForTimeout(6000);
  const dl = page.locator(".modal, [role=dialog]");
  if (await dl.count()) { console.log("MODAL2:", (await dl.last().innerText()).replace(/\s+/g, " ").slice(0, 1500)); await shot(`${TAG}-modal2`); }
  console.log("TOAST:", (await page.locator("[role=status], .toast").allInnerTexts()).join(" | ").replace(/\s+/g, " ").slice(0, 400));
  console.log("ROW AFTER:", (await row.innerText().catch(() => "-")).replace(/\s+/g, " "));
  await row.scrollIntoViewIfNeeded().catch(() => {}); await shot(`${TAG}-after`);
  console.log("SIDEBAR FOOT AFTER:", (await page.locator(".sidebar-foot").innerText().catch(() => "")).replace(/\s+/g, " "));
};
