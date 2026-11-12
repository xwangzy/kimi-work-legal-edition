// 在真实任务页上作答并点“确定”；每次作答追加到 <工作目录>/answers.log（评分要对照“律师的回答成果是否照办”）。
// 用法：node eval/answer.mjs <栈名> <run> <mat> '<json>'
// json 是数组，按题目顺序每题一项：{"pick":"选项文字片段"} 或 {"picks":["片段",…]}（多选）或 {"other":"在“其他”里写的话"}。
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { WORK, chromium, stackOf } from "./lib.mjs";

const [sn, run, mat, json] = process.argv.slice(2);
const w = stackOf(sn);
const ans = JSON.parse(json);
const b = await (await chromium()).launch({ headless: true });
const p = await (await b.newContext({ viewport: { width: 1360, height: 2400 } })).newPage();
await p.goto(`http://127.0.0.1:${w.web}/#/run/${run}/${mat}`);
await p.waitForTimeout(4000);
const r = await p.evaluate(async (ans) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const setVal = (el, v) => {
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
    d.set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const main = document.querySelector("main");
  const log = [];
  const others = () => [...main.querySelectorAll("input, textarea")].filter((x) => /其他/.test(x.placeholder || ""));
  const radios = () => [...main.querySelectorAll("[role=radio], [role=checkbox]")];
  for (let qi = 0; qi < ans.length; qi++) {
    const a = ans[qi];
    const os = others();
    const o = os[qi];
    const prev = qi === 0 ? null : os[qi - 1];
    if (!o) return { ok: false, err: `没有第 ${qi + 1} 题`, log };
    const opts = radios().filter((r) => r.compareDocumentPosition(o) & Node.DOCUMENT_POSITION_FOLLOWING && (!prev || prev.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING));
    if (a.other) {
      setVal(others()[qi], a.other);
      await sleep(400);
      log.push(`Q${qi + 1} 其他：${a.other}`);
      continue;
    }
    for (const frag of a.picks ?? [a.pick]) {
      const el = opts.find((x) => x.textContent.includes(frag));
      if (!el) return { ok: false, err: `第 ${qi + 1} 题没有含“${frag}”的选项`, log, options: opts.map((x) => x.textContent.slice(0, 60)) };
      if (el.getAttribute("aria-checked") !== "true") el.click();
      await sleep(300);
      log.push(`Q${qi + 1} 选：${el.textContent.replace(/\s+/g, " ").slice(0, 80)}`);
    }
  }
  const ok = [...main.querySelectorAll("button")].find((x) => x.textContent.trim() === "确定");
  if (!ok || ok.disabled) return { ok: false, err: "“确定”不可点：" + (main.innerText.match(/还有 \d+ 题未选[^\n]*/) || [""])[0], log };
  ok.click();
  await sleep(2000);
  return { ok: true, log };
}, ans);
appendFileSync(join(WORK, "answers.log"), JSON.stringify({ at: new Date().toISOString(), stack: sn, run, ...r }) + "\n");
console.log(JSON.stringify(r));
await b.close();
