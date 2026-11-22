// 无头浏览器在产品真实界面上逐卡发起任务（点真实按钮：新建事项、拖入材料、开始面板填字段、开始前确认），登记到 runs-<栈名>.txt。
// 用法：node eval/launch.mjs <栈名> <标签> [<标签>…]　卡片集缺省 eval/cards/cards16.json（KWL_EVAL_CARDS 可换）
// 质量回归一律全新发起：不要拿失败后“重新运行”的成果评质量（那是另一条代码路径）。
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { EVAL, PLATFORM, chromium, runsFile, stackOf } from "./lib.mjs";

// 开始面板字段按当前源码生成（第 55 批起字段经常改，driver.js 里写死的旧表只作兜底）：{ verb, f: { 键: [标签, 类型, 是否收在“更多选项”] } }
const { SCENARIOS } = await import(pathToFileURL(join(PLATFORM, "apps/desktop/src/lib/scenarios.ts")).href);
const specOf = (id) => {
  const s = SCENARIOS.find((x) => x.id === id);
  return s ? { verb: s.verb, f: Object.fromEntries(s.fields.map((f) => [f.key, [f.label, f.kind, !!f.more]])) } : undefined;
};

const [sn, ...tags] = process.argv.slice(2);
const w = stackOf(sn);
const specs = JSON.parse(readFileSync(process.env.KWL_EVAL_CARDS ?? join(EVAL, "cards/cards16.json"), "utf8"));
const browser = await (await chromium()).launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 1200 } });
for (const tag of tags) {
  const c = specs.find((x) => x.tag === tag);
  if (!c) {
    console.log(tag, "卡片集里没有");
    continue;
  }
  const page = await ctx.newPage();
  try {
    await page.goto(`http://127.0.0.1:${w.web}/`);
    await page.waitForTimeout(2500);
    await page.addScriptTag({ url: `/kwl-testdocs/driver.js?${Date.now()}` });
    await page.waitForTimeout(300);
    const r = await page.evaluate(async (c) => {
      try {
        return await window.kwl.card(c);
      } catch (e) {
        return ["ERR", String((e && e.message) || e), (document.querySelector("[role=dialog]")?.innerText || document.querySelector("main")?.innerText || "").slice(-300)];
      }
    }, { ...c, spec: specOf(c.id) });
    if (r[0] === "ERR" || !r[2]) console.log(tag, "发起失败", JSON.stringify(r).slice(0, 500));
    else {
      appendFileSync(runsFile(w), `${tag} ${r[2]} ${r[1]}\n`);
      console.log(tag, r[2], r[1]);
    }
  } catch (e) {
    console.log(tag, "异常", String(e).slice(0, 300));
  }
  await page.close();
}
await browser.close();
