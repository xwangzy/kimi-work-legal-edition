// 常驻：在产品界面上自动点“按这个计划开始”与“确认并开始起草”（真实按钮）；提问与其他确认卡只打印出来，由人按题库的预设回答处理（question.mjs / answer.mjs）。
// 计划与提纲全文存 <工作目录>/plans/<run>.plan.txt / .outline.txt，评分时要看。用法：node eval/autoapprove.mjs（全部登记任务到终态后自行退出）
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TERMINAL, WORK, chromium, inv, runsOf, sleep, stacks } from "./lib.mjs";

mkdirSync(join(WORK, "plans"), { recursive: true });
const browser = await (await chromium()).launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 1600 } })).newPage();
const told = new Set();
const now = () => new Date().toTimeString().slice(0, 8);
for (;;) {
  let active = 0;
  let total = 0;
  for (const w of stacks()) {
    for (const [tag, run, mat] of runsOf(w)) {
      total++;
      let st;
      try {
        st = (await inv(w, "runs.get", { run_id: run })).run.status;
      } catch {
        active++;
        continue;
      }
      if (!TERMINAL.test(st)) active++;
      if (st !== "waiting_approval" && st !== "waiting_input") continue;
      try {
        await page.goto(`http://127.0.0.1:${w.web}/#/run/${run}/${mat}`);
        await page.waitForTimeout(3500);
        const text = await page.locator("main").innerText();
        const planBtn = page.getByRole("button", { name: "按这个计划开始", exact: true });
        const outlineBtn = page.locator("button", { hasText: /^确认并开始起草/ });
        if (await planBtn.count()) {
          writeFileSync(join(WORK, "plans", `${run}.plan.txt`), text.slice(Math.max(0, text.indexOf("请确认工作计划"))));
          await planBtn.first().click();
          await page.waitForTimeout(1500);
          console.log(now(), w.name, tag, "计划已确认");
        } else if (await outlineBtn.count()) {
          writeFileSync(join(WORK, "plans", `${run}.outline.txt`), text);
          const cb = page.locator("label", { hasText: "同时确认" }).locator("input[type=checkbox]");
          if ((await cb.count()) && !(await cb.first().isChecked())) await cb.first().check();
          await outlineBtn.first().click();
          await page.waitForTimeout(1500);
          console.log(now(), w.name, tag, "论点提纲已确认");
        } else if (!told.has(run + st)) {
          told.add(run + st);
          const at = Math.max(0, text.search(/需要你/));
          console.log(now(), w.name, tag, run, mat, "需要人处理：" + st, text.slice(at, at + 160).replace(/\n/g, " "));
        }
      } catch (e) {
        console.log(now(), w.name, tag, "出错", String(e).slice(0, 120));
      }
    }
  }
  if (total > 0 && active === 0) break;
  await sleep(15000);
}
await browser.close();
console.log(now(), "全部到终态");
