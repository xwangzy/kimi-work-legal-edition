// 第 56 批四页真实点击：node flow56.mjs <which> <outdir>
import { chromium } from "/Users/wangzeyu/.nvm/versions/node/v26.8.1/lib/node_modules/playwright/index.mjs";
const [which, out] = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const log = (...x) => console.log("[flow]", ...x);
const wait = (ms) => p.waitForTimeout(ms);
try {
  if (which === "reminders") {
    await p.goto("http://127.0.0.1:5601/#/reminders");
    await wait(2500);
    log("rows before", await p.locator(".rm-row").count());
    if (await p.locator(".rm-row", { hasText: "第56批测试用" }).count()) { log("leftover exists, cancelling"); } else {
    await p.getByRole("button", { name: "设提醒", exact: true }).first().click();
    await wait(800);
    await p.locator('input[type="date"]').fill("2026-12-18");
    await p.locator("textarea").first().fill("开庭：第56批测试用（稍后取消）");
    await p.getByRole("button", { name: "保存", exact: true }).click();
    await wait(2500);
    const row = p.locator(".rm-row", { hasText: "第56批测试用" });
    log("created rows", await row.count(), "title:", await row.locator(".rm-title").innerText(), "pill:", await row.locator(".rm-pill").innerText(), "meta:", await row.locator(".rm-meta").innerText());
    await p.screenshot({ path: `${out}/rm-created.png` }); }
    const row2 = p.locator(".rm-row", { hasText: "第56批测试用" });
    await row2.hover();
    await wait(300);
    await row2.getByRole("button", { name: "撤销", exact: true }).click();
    await wait(400);
    await p.getByRole("button", { name: "撤销提醒", exact: true }).last().click();
    await wait(2500);
    log("after cancel rows with text", await p.locator(".rm-row", { hasText: "第56批测试用" }).count());
    await p.locator("button.rm-cal-day", { hasText: /^27/ }).first().click();
    await wait(600);
    log("focused rows", await p.locator(".rm-row.is-focus").count(), await p.locator(".rm-row.is-focus .rm-title").allInnerTexts());
    await p.screenshot({ path: `${out}/rm-calclick.png` });
  } else if (which === "backup") {
    await p.goto("http://127.0.0.1:5601/#/connections/backup");
    await wait(2500);
    log("status:", await p.locator(".bk-status").innerText());
    await p.locator(".bk-path input").first().fill(process.env.PKG_PATH);
    await p.locator(".bk-step").first().getByRole("button", { name: "生成恢复包" }).click();
    await wait(4000);
    log("code lines", await p.locator(".recovery-line").count(), "msg:", await p.locator(".bk-msg").innerText().catch(() => ""));
    log("status after:", await p.locator(".bk-status").innerText());
    log("steps:", (await p.locator(".bk-step .bk-step-head").allInnerTexts()).join(" | "));
    await p.screenshot({ path: `${out}/bk-created.png`, fullPage: true });
    await p.getByRole("button", { name: "检测连接", exact: true }).click();
    await wait(2500);
    log("conn:", await p.locator(".cc-conclusion").innerText());
    await p.locator(".help-sec").scrollIntoViewIfNeeded();
    await p.screenshot({ path: `${out}/bk-conn.png` });
  } else if (which === "audit") {
    await p.goto("http://127.0.0.1:5601/#/connections/admin");
    await wait(2000);
    await p.getByText("操作记录", { exact: true }).click();
    await wait(2000);
    log("tabs:", (await p.locator(".audit-bar .seg-btn").allInnerTexts()).join(" / "), "rows:", await p.locator(".audit-item").count());
    await p.getByRole("tab", { name: /^全部/ }).click();
    await wait(400);
    log("all rows:", await p.locator(".audit-item").count());
    await p.locator(".audit-more").first().click();
    await wait(400);
    log("detail:", (await p.locator(".audit-detail").first().innerText()).replace(/\n/g, " "));
    await p.screenshot({ path: `${out}/au-all-detail.png` });
    await p.getByRole("button", { name: "取回最新" }).click();
    await wait(2500);
    log("after refresh rows:", await p.locator(".audit-item").count(), "banner:", await p.locator(".audit-page .banner").allInnerTexts());
    log("text has id?", /dev_|seat_|acc_|stf_/.test(await p.locator(".audit-list").innerText()));
  }
} catch (e) {
  log("ERROR", e.message);
  await p.screenshot({ path: `${out}/error-${which}.png` });
}
await b.close();
