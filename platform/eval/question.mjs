// 读出一个任务当前的提问卡（每题的题干、选项），JSON 输出。用法：node eval/question.mjs <栈名> <run> <mat>
import { chromium, stackOf } from "./lib.mjs";

const [sn, run, mat] = process.argv.slice(2);
const w = stackOf(sn);
const b = await (await chromium()).launch({ headless: true });
const p = await (await b.newContext({ viewport: { width: 1360, height: 2400 } })).newPage();
await p.goto(`http://127.0.0.1:${w.web}/#/run/${run}/${mat}`);
await p.waitForTimeout(4000);
const out = await p.evaluate(() => {
  const main = document.querySelector("main");
  const t = main.innerText;
  const i = t.lastIndexOf("需要你定一下");
  const lead = t.slice(Math.max(0, i - 900), i);
  const radios = [...main.querySelectorAll("[role=radio], [role=checkbox]")];
  // 按“其他”输入框把选项分到各题：每题的选项都在它的“其他”输入框之前
  const others = [...main.querySelectorAll("input, textarea")].filter((x) => /其他/.test(x.placeholder || ""));
  const qs = others.map((o, qi) => {
    const prev = qi === 0 ? null : others[qi - 1];
    const opts = radios.filter((r) => r.compareDocumentPosition(o) & Node.DOCUMENT_POSITION_FOLLOWING && (!prev || prev.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING));
    const box = opts[0]?.parentElement?.parentElement ?? o.parentElement;
    return { q: qi + 1, text: (box?.innerText ?? "").split("\n").slice(0, 3).join(" ").slice(0, 400), multi: opts.some((r) => r.getAttribute("role") === "checkbox"), options: opts.map((r) => r.innerText.replace(/\n/g, "｜").slice(0, 260)) };
  });
  const has = (f) => !![...main.querySelectorAll("button")].find((x) => f(x.textContent.trim()));
  const kind = has((s) => s.startsWith("确认并开始起草")) ? "outline" : has((s) => s === "按这个计划开始") ? "plan" : qs.length ? "question" : "unknown";
  return { kind, lead: lead.slice(-700), questions: qs, tail: qs.length ? "" : t.slice(-1200) };
});
console.log(JSON.stringify(out, null, 1));
await b.close();
