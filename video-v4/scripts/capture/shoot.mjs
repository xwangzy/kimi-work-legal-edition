// 宣传片 V4 采集：在真实模型采集栈里按片中主线点出每个状态，存截图（检查用）与 DOM 快照（片子用）。
// 用法：node video-v4/scripts/capture/shoot.mjs <输出目录> '<seed 打印的 JSON>' <阶段…>
//   阶段：start（首页 → 开始面板 → 客户授权 → 发起真实任务，并在执行中逐步拍下）
//         post（任务完成后：成果 / 引用 / 数据去向 / 处理过程 / 预览）   wblook（只看审查工作台）   wbact（逐条处理 + 生成修订稿）
//         signoff   pages   chat   dark   lit（诉讼线：起草起诉状真实任务）
//   任务编号：start 阶段写到 <输出目录>/run-url.txt；其余阶段从这里读（或 FILM_RUN）。
// 窗口按 macOS 桌面端无边框形态采集：<html> 标 frameless plat-darwin（与 Electron 主进程打的类相同）。
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { open } from "./lib.mjs";
const [out, idsJson, ...phases] = process.argv.slice(2);
const ids = JSON.parse(idsJson);
const TASK = "审查这份股权转让协议，我方为受让方，重点看付款与违约责任";
const QUESTION = "股权转让价款在变更登记前一次付清，受让方有什么风险？怎么约定更稳妥？";
const LIT_TASK = "根据施工合同、竣工验收记录、结算确认单和催款函，为丁建设起草起诉状，请求支付欠付工程款及逾期利息";
const runFile = (n) => `${out}/${n}-url.txt`;
const RUN = () => process.env.FILM_RUN ?? (existsSync(runFile("run")) ? readFileSync(runFile("run"), "utf8").trim() : "");

async function prep(s) {
  await s.p.addInitScript(() => {
    const mark = () => document.documentElement.classList.add("frameless", "plat-darwin");
    if (document.documentElement) mark();
    document.addEventListener("DOMContentLoaded", mark);
  });
  return s;
}
const texts = async (p, sel) => (await p.locator(sel).allInnerTexts()).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean).join(" | ").slice(0, 3000);
async function tidyHome(p) {
  const t = p.getByRole("button", { name: "明天提醒" });
  if (await t.count()) { await t.first().click(); await p.waitForTimeout(300); }
  await p.evaluate(() => {
    for (const b of document.querySelectorAll("button")) {
      if (b.textContent?.trim() !== "收起") continue;
      let e = b.parentElement, n = 0;
      while (e && n++ < 4) { if (e.textContent?.includes("上手清单")) { b.click(); return; } e = e.parentElement; }
    }
  });
  await p.waitForTimeout(300);
}
const scrollModal = (p, y) => p.locator(".modal").first().evaluate((m, y) => { for (const e of [m, ...m.querySelectorAll("*")]) if (e.scrollHeight > e.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(e).overflowY)) e.scrollTop = y; }, y);
const scrollMain = (p, y) => p.evaluate((y) => { const sc = [...document.querySelectorAll("main *, main")].filter((e) => e.scrollHeight > e.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(e).overflowY)); for (const e of sc) e.scrollTop = y; return sc.length; }, y);

// 执行中逐步拍：界面文字变了才存一张；到“完成/失败”为止
async function pollRun(s, prefix, maxMin = 45) {
  const { p, shot } = s;
  let last = "", n = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < maxMin * 60_000) {
    await p.waitForTimeout(2500);
    const body = await p.locator("main").innerText().catch(() => "");
    const h = createHash("sha1").update(body.replace(/\d+\s*(秒|分)/g, "")).digest("hex");
    if (h !== last) { last = h; await shot(`${prefix}${String(n++).padStart(3, "0")}`); }
    if (/处理过程 · 用时|没能完成|已失败|已停止|已取消/.test(body)) { await p.waitForTimeout(3000); await shot(`${prefix}${String(n++).padStart(3, "0")}-end`); break; }
  }
  console.log(`[poll] ${prefix} ${n} 张，用时 ${Math.round((Date.now() - t0) / 1000)} 秒`);
}

async function start() {
  const s = await prep(await open(out));
  const { p, shot, step, go, saveStyles } = s;
  await step("home", async () => {
    await go("#/", 2500);
    await tidyHome(p);
    await saveStyles();
    await shot("h01-home");
    await p.locator("textarea").first().fill(TASK);
    await p.waitForTimeout(1500);
    await shot("h02-typed");
    await p.getByRole("button", { name: "使用审合同" }).click();
    await p.waitForTimeout(1500);
    await shot("h03-start");
    for (const c of ["付款", "违约责任"]) { await p.locator(".modal button", { hasText: c }).first().click(); await p.waitForTimeout(300); }
    await shot("h04-start-chips");
    // 建议修订稿：选第一项（若有）
    try {
      await p.locator(".modal button", { hasText: "请选择（可不选）" }).first().click(); await p.waitForTimeout(500);
      await shot("h04b-redline-menu");
      console.log("REDLINE-MENU>>", await texts(p, ".modal [role=option], .modal [role=menuitem], .modal li"));
      const opt = p.locator(".modal [role=option], .modal [role=menuitem]").first();
      if (await opt.count()) { await opt.click(); await p.waitForTimeout(400); } else await p.keyboard.press("Escape");
    } catch (e) { console.log("redline-menu skip", e.message.split("\n")[0]); }
    await shot("h05-start-ready");
    await scrollModal(p, 99999); await p.waitForTimeout(400);
    await shot("h06-start-bottom");
    await scrollModal(p, 0); await p.waitForTimeout(200);
    await p.getByRole("button", { name: /下一步：确认/ }).click();
    await p.waitForTimeout(1800);
    await shot("a01-confirm");
    if (await p.getByText("记录本案的客户授权").count()) {
      await p.getByText("委托合同中的 AI 条款").first().click(); await p.waitForTimeout(600);
      await shot("a02-auth-picked");
      const inp = p.locator(".modal input[type=text], .modal input:not([type])").first();
      if (await inp.count()) { await inp.fill("委托合同第 9 条（人工智能辅助）"); await p.waitForTimeout(400); }
      await shot("a03-auth-filled");
      console.log("AUTH>>", (await p.locator(".modal").first().innerText()).replace(/\s+/g, " ").slice(0, 1500));
      await p.getByRole("button", { name: "记录授权并开始" }).click();
    } else {
      console.log("CONFIRM>>", (await p.locator(".modal").first().innerText()).replace(/\s+/g, " ").slice(0, 1500));
      await p.locator(".modal button.btn-primary").last().click();
    }
    await p.waitForTimeout(1500);
    await shot("a04-notice");
    const cont = p.getByRole("button", { name: "我知道了，继续" });
    if (await cont.count()) { await cont.first().click(); await p.waitForTimeout(1500); }
    await shot("a05-run-open");
    console.log("RUN-OPEN>>", p.url(), (await p.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 800));
    writeFileSync(runFile("run"), p.url().split("#")[1] ?? "");
    await pollRun(s, "r");
    writeFileSync(runFile("run"), p.url().split("#")[1] ?? "");
    console.log("RUN-END>>", (await p.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 2500));
  });
  await s.b.close();
}

async function post() {
  const s = await prep(await open(out));
  const { p, shot, step, go, clickText } = s;
  const R = RUN();
  await step("tabs", async () => {
    await go("#" + R, 2500);
    await shot("t00-done");
    console.log("TABS>>", await texts(p, "button.tab"));
    for (const t of await p.locator("button.tab").allInnerTexts()) {
      const name = t.trim().replace(/\s+/g, "");
      await clickText("button.tab", t.trim(), 1200);
      await shot(`t-${name}`);
      await scrollMain(p, 600); await p.waitForTimeout(400); await shot(`t-${name}-s1`);
      await scrollMain(p, 0); await p.waitForTimeout(200);
    }
  });
  await step("process", async () => {
    await go("#" + R, 2500);
    const pr = p.getByText(/处理过程/).first();
    if (await pr.count()) { await pr.click(); await p.waitForTimeout(900); await shot("t10-process"); await scrollMain(p, 700); await p.waitForTimeout(400); await shot("t11-process-s1"); await scrollMain(p, 1600); await p.waitForTimeout(400); await shot("t12-process-s2"); }
    console.log("PROCESS>>", (await p.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 4000));
  });
  await step("previews", async () => {
    await go("#" + R, 2500);
    const n = await p.getByRole("button", { name: "预览" }).count();
    console.log("PREVIEW-COUNT", n);
    for (let i = 0; i < Math.min(n, 4); i++) {
      await go("#" + R, 2000);
      await p.getByRole("button", { name: "预览" }).nth(i).click(); await p.waitForTimeout(3000);
      await shot(`v0${i}-preview`);
      const fr = p.frames().find((f) => f !== p.mainFrame()); if (fr) writeFileSync(`${out}/v0${i}-preview-frame.html`, await fr.content());
      await p.mouse.wheel(0, 900); await p.waitForTimeout(600); await shot(`v0${i}-preview-s1`);
    }
  });
  await s.b.close();
}

async function wblook() {
  const s = await prep(await open(out));
  const { p, shot, step, go } = s;
  await step("wb", async () => {
    await go("#" + RUN(), 2500);
    await p.getByRole("button", { name: /审查工作台/ }).first().click(); await p.waitForTimeout(2500);
    writeFileSync(runFile("review"), p.url().split("#")[1] ?? "");
    await shot("w00-look");
    console.log("WB>>", (await p.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 5000));
    console.log("WB-BUTTONS>>", await texts(p, "main button"));
  });
  await s.b.close();
}

async function wbact() {
  const s = await prep(await open(out));
  const { p, shot, step, go, clickText } = s;
  await step("wbact", async () => {
    await go("#" + RUN(), 3000);
    await p.getByRole("button", { name: /审查工作台/ }).first().click(); await p.waitForTimeout(3000);
    await shot("w01-review");
    // 逐条处理：默认“接受首选”；第 9.1 条（争议解决，可谈判）律师决定不采纳。前 6 次与不采纳各拍一张。
    let n = 0;
    for (let guard = 0; guard < 30; guard++) {
      const card = p.locator(".wb-cards .rc.open").first();
      if (!(await card.count())) break;
      const head = (await card.locator(".rc-head").innerText().catch(() => "")).replace(/\s+/g, " ");
      const reject = /第9\.1条/.test(head);
      const btn = reject ? card.locator(".rc-actions button", { hasText: /^不采纳$/ }) : card.locator(".rc-actions .btn-primary");
      if (!(await btn.count())) { console.log("no button on", head); break; }
      await btn.first().click(); await p.waitForTimeout(1100); n++;
      console.log("ACT", n, reject ? "不采纳" : "接受", head.slice(0, 60));
      if (n <= 6 || reject) await shot(`w${String(n + 1).padStart(2, "0")}-${reject ? "rej" : "acc"}`);
    }
    await shot("w30-all-done");
    console.log("AFTER-ALL>>", (await p.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 600));
    try { await clickText("button", "接受后", 1400); await shot("w31-after"); await scrollMain(p, 500); await p.waitForTimeout(400); await shot("w32-after-s1"); await scrollMain(p, 1100); await p.waitForTimeout(400); await shot("w33-after-s2"); await scrollMain(p, 0); } catch (e) { console.log("after skip", e.message.split("\n")[0]); }
    try { await clickText("button", "原文", 700); } catch {}
    await p.getByRole("button", { name: /生成修订稿/ }).first().click(); await p.waitForTimeout(5000);
    await shot("w40-redline");
    console.log("REDLINE>>", (await p.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 2500));
    const v = p.getByRole("button", { name: /查看修订稿|预览/ });
    if (await v.count()) { await v.first().click(); await p.waitForTimeout(3500); await shot("w41-redline-preview"); await p.mouse.wheel(0, 700); await p.waitForTimeout(700); await shot("w42-redline-preview-s1"); await p.mouse.wheel(0, 900); await p.waitForTimeout(700); await shot("w43-redline-preview-s2"); }
  });
  await s.b.close();
}

async function signoff() {
  const s = await prep(await open(out));
  const { p, shot, step, go, clickText } = s;
  await step("signoff", async () => {
    await go("#" + RUN(), 2500);
    await clickText("button.tab", "成果", 1200);
    await shot("s01-run-deliverables");
    console.log("DELIV>>", (await p.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 2500));
    const sub = p.getByRole("button", { name: /提交复核/ }); if (await sub.count()) { await sub.first().click(); await p.waitForTimeout(1800); }
    await shot("s02-submitted");
    await go("#/deliverables", 2000); await shot("s03-deliverables");
    try { await p.getByText("待复核").first().click(); await p.waitForTimeout(900); await shot("s04-filter-pending"); } catch {}
    try {
      await p.locator("main").getByText(/修订稿/).first().click(); await p.waitForTimeout(2500);
      writeFileSync(runFile("signoff"), p.url().split("#")[1] ?? "");
      await shot("s05-sign-page");
      console.log("SIGNPAGE>>", (await p.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 2500));
      await scrollMain(p, 600); await p.waitForTimeout(400); await shot("s06-sign-page-s1"); await scrollMain(p, 0);
      for (const cb of await p.locator("main input[type=checkbox]").all()) { try { await cb.check(); await p.waitForTimeout(400); } catch {} }
      await shot("s07-sign-checked");
    } catch (e) { console.log("sign skip", e.message.split("\n")[0]); }
  });
  await s.b.close();
}

async function pages() {
  const s = await prep(await open(out));
  const { p, shot, step, go } = s;
  await step("pages", async () => {
    for (const [n, h] of [["p01-deliverables", "#/deliverables"], ["p02-methods", "#/methods"], ["p03-reminders", "#/reminders"], ["p04-matter", `#/matter/${ids.nonlit}`], ["p05-matters", "#/matters"], ["p06-visibility", "#/connections/visibility"], ["p07-matter-lit", `#/matter/${ids.lit}`], ["p08-settings", "#/connections"]]) { await go(h, 1800); await shot(n); }
    await go("#/connections/visibility", 1800);
    await scrollMain(p, 420); await p.waitForTimeout(400); await shot("p06b-visibility-s1");
    await go("#/methods", 1800);
    for (const t of ["诉讼仲裁", "非诉", "企业法务"]) { try { await p.locator("main button", { hasText: t }).first().click(); await p.waitForTimeout(700); await shot(`p02-methods-${t}`); } catch {} }
    console.log("METHODS>>", (await p.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 3000));
    await go("#/", 2000); await tidyHome(p);
    for (const t of ["诉讼仲裁", "非诉", "企业法务"]) { try { await p.locator("main button", { hasText: t }).first().click(); await p.waitForTimeout(600); await shot(`h1x-home-${t}`); } catch {} }
  });
  await s.b.close();
}

async function chat() {
  const s = await prep(await open(out));
  const { p, shot, step, go } = s;
  await step("chat", async () => {
    await go("#/chat", 2000);
    await shot("q01-chat");
    await p.locator("textarea").first().fill(QUESTION); await p.waitForTimeout(400);
    await shot("q02-chat-typed");
    await p.locator("textarea").first().press("Meta+Enter");
    let last = "", n = 0;
    for (let i = 0; i < 160; i++) {
      await p.waitForTimeout(1500);
      const body = await p.locator("main").innerText().catch(() => "");
      if (body !== last) { last = body; await shot(`q1${String(n++).padStart(2, "0")}-chat`); }
      if (i > 6 && !/思考|正在|已用时/.test(body) && n > 3) break;
    }
    console.log("CHAT>>", last.replace(/\s+/g, " ").slice(0, 3000));
  });
  await s.b.close();
}

async function lit() {
  const s = await prep(await open(out));
  const { p, shot, step, go } = s;
  await step("lit", async () => {
    await go("#/", 2500); await tidyHome(p);
    await pickMatter(p, "丁建设诉戊置业");
    await p.locator("textarea").first().fill(LIT_TASK); await p.waitForTimeout(1500);
    await shot("L01-typed");
    console.log("LIT-HOME>>", (await p.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 1200));
    const use = p.getByRole("button", { name: /^使用/ });
    if (await use.count()) { await use.first().click(); await p.waitForTimeout(1500); }
    await shot("L02-start");
    const startText = (await p.locator(".modal").first().innerText()).replace(/\s+/g, " ");
    console.log("LIT-START>>", startText.slice(0, 2500));
    if (!startText.includes("丁建设诉戊置业")) throw new Error("开始面板不是诉讼事项，停下（不发起）");
    const all = p.locator(".modal button", { hasText: "改为全部" }); if (await all.count()) { await all.first().click(); await p.waitForTimeout(400); }
    await shot("L03-start-all");
    await p.getByRole("button", { name: /下一步：确认/ }).click(); await p.waitForTimeout(1800);
    await shot("L04-confirm");
    await p.getByText("委托合同中的 AI 条款").first().click(); await p.waitForTimeout(500);
    const inp = p.locator(".modal input[type=text], .modal input:not([type])").first();
    if (await inp.count()) { await inp.fill("委托代理合同第 7 条（人工智能辅助）"); await p.waitForTimeout(300); }
    await p.getByRole("button", { name: "记录授权并开始" }).click(); await p.waitForTimeout(1500);
    const cont = p.getByRole("button", { name: "我知道了，继续" });
    if (await cont.count()) { await cont.first().click(); await p.waitForTimeout(1500); }
    writeFileSync(runFile("lit"), p.url().split("#")[1] ?? "");
    await pollRun(s, "L", 50);
    writeFileSync(runFile("lit"), p.url().split("#")[1] ?? "");
    console.log("LIT-END>>", (await p.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 2500));
  });
  await s.b.close();
}


async function pickMatter(p, title) {
  await p.locator("main button", { hasText: /受让丙数据|供应商合同|建设工程款/ }).first().click(); await p.waitForTimeout(700);
  await p.locator("[role=menuitem], [role=option], .menu button, .popover button", { hasText: title }).first().click(); await p.waitForTimeout(800);
}

// 整理案卷（全程在本机，不用 AI）：诉讼事项
async function casefile() {
  const s = await prep(await open(out));
  const { p, shot, step, go } = s;
  await step("casefile", async () => {
    await go("#/", 2500); await tidyHome(p);
    await pickMatter(p, "丁建设诉戊置业");
    await shot("C00-home-lit");
    await p.locator("main button", { hasText: "整理案卷" }).first().click(); await p.waitForTimeout(1500);
    await shot("C01-start");
    const t = (await p.locator(".modal").first().innerText()).replace(/\s+/g, " ");
    console.log("CASEFILE-START>>", t.slice(0, 2000));
    if (!t.includes("丁建设诉戊置业")) throw new Error("不是诉讼事项，停下");
    console.log("BTN>>", await texts(p, ".modal button"));
    const all = p.locator(".modal button", { hasText: "改为全部" }); if (await all.count()) { await all.first().click(); await p.waitForTimeout(400); }
    await shot("C02-start-all");
    await p.locator(".modal button.btn-primary").last().click(); await p.waitForTimeout(1800);
    await shot("C03-after-start");
    console.log("AFTER>>", (await p.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 1200));
    const cont = p.getByRole("button", { name: "我知道了，继续" }); if (await cont.count()) { await cont.first().click(); await p.waitForTimeout(1200); }
    if (await p.locator(".modal button.btn-primary").count()) { console.log("MODAL2>>", (await p.locator(".modal").first().innerText()).replace(/\s+/g, " ").slice(0, 1200)); }
    writeFileSync(runFile("casefile"), p.url().split("#")[1] ?? "");
    await pollRun(s, "C1", 20);
    writeFileSync(runFile("casefile"), p.url().split("#")[1] ?? "");
    console.log("CASEFILE-END>>", (await p.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 2500));
  });
  await s.b.close();
}

async function dark() {
  const s = await prep(await open(out, { dark: true }));
  const { p, shot, step, go } = s;
  await step("dark", async () => {
    await go("#/", 2000); await tidyHome(p); await shot("d01-home");
    if (RUN()) { await go("#" + RUN(), 2500); await shot("d02-run"); }
    await go("#/connections/visibility", 1800); await shot("d03-visibility");
    await go("#/methods", 1800); await shot("d04-methods");
  });
  await s.b.close();
}

async function repoll() {
  const s = await prep(await open(out));
  const which = process.env.FILM_REPOLL ?? "run";
  await s.step("repoll", async () => {
    await s.go("#" + readFileSync(runFile(which), "utf8").trim(), 2500);
    await pollRun(s, process.env.FILM_PREFIX ?? "r2", 50);
    console.log("REPOLL-END>>", (await s.p.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 2500));
  });
  await s.b.close();
}

async function wbfinish() {
  const s = await prep(await open(out));
  const { p, shot, step, go, clickText } = s;
  await step("wbfinish", async () => {
    await go("#" + RUN(), 3000);
    await p.getByRole("button", { name: /审查工作台/ }).first().click(); await p.waitForTimeout(3000);
    await shot("w30b-all-done");
    console.log("WB-HEAD>>", (await p.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 700));
    await clickText("button", "接受后", 1500); await shot("w31-after");
    const sc = () => p.evaluate((y) => { for (const e of document.querySelectorAll(".wb-doc, .wb-doc *")) if (e.scrollHeight > e.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(e).overflowY)) { e.scrollTop = y; return e.className; } return null; }, 0);
    console.log("doc scroller", await sc());
    for (const [n, y] of [["w32-after-s1", 500], ["w33-after-s2", 1100], ["w34-after-s3", 1800]]) { await p.evaluate((y) => { for (const e of document.querySelectorAll("*")) if (e.scrollHeight > e.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(e).overflowY) && e.closest(".wb-doc, [class*=wb-doc], [class*=wb-left]")) { e.scrollTop = y; } }, y); await p.waitForTimeout(500); await shot(n); }
    await clickText("button", "原文", 800);
    await p.getByRole("button", { name: /生成修订稿/ }).first().click(); await p.waitForTimeout(6000);
    await shot("w40-redline");
    console.log("REDLINE>>", (await p.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 2000));
    console.log("BTNS>>", await texts(p, "button"));
  });
  await s.b.close();
}

async function wbredline() {
  const s = await prep(await open(out));
  const { p, shot, step, go } = s;
  await step("wbredline", async () => {
    await go("#" + RUN(), 3000);
    await p.getByRole("button", { name: /审查工作台/ }).first().click(); await p.waitForTimeout(3000);
    await p.getByRole("button", { name: /生成修订稿/ }).first().click(); await p.waitForTimeout(3000);
    const skip = p.getByRole("button", { name: /跳过这 \d+ 项，生成其余修订/ });
    if (await skip.count()) { await shot("w40b-skip-offer"); await skip.first().click(); await p.waitForTimeout(8000); }
    await shot("w41-redline-done");
    console.log("RL>>", (await p.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 1500));
    console.log("BTNS>>", await texts(p, "button"));
  });
  await s.b.close();
}

async function rlview() {
  const s = await prep(await open(out));
  const { p, shot, step, go } = s;
  await step("rlview", async () => {
    await go("#" + RUN(), 3000);
    await p.getByRole("button", { name: /审查工作台/ }).first().click(); await p.waitForTimeout(3000);
    await p.getByRole("button", { name: "查看修订稿" }).first().click(); await p.waitForTimeout(4000);
    await shot("x01-redline-view");
    console.log("RLV>>", (await p.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 1500));
    for (const [n, dy] of [["x02-redline-view-s1", 600], ["x03-redline-view-s2", 700], ["x04-redline-view-s3", 700]]) { await p.mouse.move(700, 600); await p.mouse.wheel(0, dy); await p.waitForTimeout(800); await shot(n); }
  });
  await s.b.close();
}

async function sign2() {
  const s = await prep(await open(out));
  const { p, shot, step, go } = s;
  await step("sign2", async () => {
    await go("#/deliverables", 2500);
    await p.getByText("待复核").first().click(); await p.waitForTimeout(800);
    await p.locator("main").getByText(/修订稿·对外版/).first().click(); await p.waitForTimeout(2500);
    await p.getByRole("button", { name: "去复核" }).first().click(); await p.waitForTimeout(3000);
    writeFileSync(runFile("signoff"), p.url().split("#")[1] ?? "");
    await shot("s10-review");
    console.log("REVIEW>>", (await p.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 3000));
    console.log("BTNS>>", await texts(p, "button, label"));
    const sc = (y) => p.evaluate((y) => { for (const e of document.querySelectorAll("main *")) if (e.scrollHeight > e.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(e).overflowY)) e.scrollTop = y; }, y);
    await sc(600); await p.waitForTimeout(500); await shot("s11-review-s1");
    await sc(99999); await p.waitForTimeout(500); await shot("s12-review-bottom");
    const boxes = await p.locator("input[type=checkbox]").all();
    console.log("checkboxes", boxes.length);
    let i = 0;
    for (const cb of boxes) { try { if (await cb.isVisible() && !(await cb.isChecked())) { await cb.check(); await p.waitForTimeout(500); await shot(`s13-check${i++}`); } } catch (e) { console.log("cb", e.message.split("\n")[0]); } }
    await shot("s14-checked");
    console.log("AFTER-CHECK>>", await texts(p, "button"));
    const signBtn = p.getByRole("button", { name: /确认签发|签发/ });
    console.log("sign buttons", await signBtn.count());
    if (await signBtn.count()) { const b = signBtn.first(); console.log("sign enabled", await b.isEnabled()); if (await b.isEnabled()) { await b.click(); await p.waitForTimeout(3500); await shot("s15-signed"); const conf = p.getByRole("button", { name: /确认签发|签发|确定/ }); if (await p.locator(".modal").count() && await conf.count()) { await shot("s15b-sign-modal"); console.log("MODAL>>", (await p.locator(".modal").first().innerText()).replace(/\s+/g, " ").slice(0, 800)); } } }
    console.log("END>>", (await p.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 1500));
  });
  await s.b.close();
}

async function signview() {
  const s = await prep(await open(out));
  const { p, shot, step, go } = s;
  await step("signview", async () => {
    await go("#" + readFileSync(runFile("signoff"), "utf8").trim(), 3000);
    await shot("s20-signed-top");
    console.log("SIGNED>>", (await p.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 1200));
    await p.evaluate(() => { for (const e of document.querySelectorAll("main *")) if (e.scrollHeight > e.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(e).overflowY)) e.scrollTop = 99999; });
    await p.waitForTimeout(600); await shot("s21-signed-bottom");
    await go("#/deliverables", 2500); await shot("s22-deliverables-after");
  });
  await s.b.close();
}

async function litpost() {
  const s = await prep(await open(out));
  const { p, shot, step, go } = s;
  for (const [key, pre] of [["casefile", "C"], ["lit", "L"]]) {
    await step("litpost-" + key, async () => {
      const u = readFileSync(runFile(key), "utf8").trim();
      await go("#" + u, 3000);
      await shot(`${pre}90-done`);
      console.log(key, "DONE>>", (await p.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 1500));
      const n = await p.getByRole("button", { name: "预览" }).count();
      for (let i = 0; i < Math.min(n, 6); i++) {
        await go("#" + u, 2200);
        await p.getByRole("button", { name: "预览" }).nth(i).click(); await p.waitForTimeout(3200);
        await shot(`${pre}9${i}-preview`);
      }
    });
  }
  await s.b.close();
}

// 开始面板页脚“详情” → “看看 AI 会看到什么”（只看，不发起任务）
async function aisees() {
  const s = await prep(await open(out));
  const { p, shot, step, go } = s;
  await step("aisees", async () => {
    await go("#/", 2500); await tidyHome(p);
    await pickMatter(p, "乙投资受让丙数据");
    await p.locator("main button", { hasText: "审合同" }).first().click(); await p.waitForTimeout(1800);
    const det = p.locator(".modal button", { hasText: "详情" });
    console.log("detail btn", await det.count());
    if (await det.count()) { await det.first().click(); await p.waitForTimeout(1200); }
    await shot("y01-detail");
    console.log("Y1>>", (await p.locator(".modal").first().innerText()).replace(/\s+/g, " ").slice(-1500));
    const look = p.locator(".modal button, .modal summary", { hasText: /AI 会看到/ });
    console.log("look btn", await look.count());
    if (await look.count()) { await look.first().click(); await p.waitForTimeout(1500); }
    await shot("y02-aisees");
    await p.locator(".modal").first().evaluate((m) => { const t = [...m.querySelectorAll("*")].find((e) => /AI 会看到的内容/.test(e.textContent || "") && e.children.length < 4); t?.scrollIntoView({ block: "start" }); });
    await p.waitForTimeout(600);
    await shot("y03-aisees-scrolled");
    console.log("Y3>>", (await p.locator(".modal").first().innerText()).replace(/\s+/g, " ").slice(-1800));
    const tok = p.locator(".modal [class*=token], .modal [class*=tok]").first();
    if (await tok.count()) { await tok.hover(); await p.waitForTimeout(700); await shot("y04-hover"); }
    await p.keyboard.press("Escape");
  });
  await s.b.close();
}

const table = { aisees, signview, litpost, sign2, rlview, wbredline, wbfinish, repoll, start, post, wblook, wbact, signoff, pages, chat, dark, lit, casefile };
for (const ph of phases) { console.log(`== ${ph}`); await table[ph](); }
console.log("done");
