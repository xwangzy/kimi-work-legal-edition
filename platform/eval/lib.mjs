// 验收流水线公共部分：工作目录、测试栈清单、经开发桥调用产品接口、读任务登记表。
// 工作目录（KWL_EVAL_DIR，缺省系统临时目录下的 kwl-eval）放一切运行期文件：stacks.json、runs-<栈名>.txt、各栈数据、计划全文、成果。仓库里只放脚本与题库。
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EVAL = dirname(fileURLToPath(import.meta.url));
export const PLATFORM = resolve(EVAL, "..");
export const WORK = resolve(process.env.KWL_EVAL_DIR ?? join(tmpdir(), "kwl-eval"));
mkdirSync(WORK, { recursive: true });

/** 测试栈清单：[{ name, web, bridge, gw, search, model? }]；model 是这套栈的上游型号（缺省 kimi-k3.1-pro）。 */
export function stacks() {
  const f = join(WORK, "stacks.json");
  if (!existsSync(f)) throw new Error(`没有 ${f}：先按 eval/README.md 写一份测试栈清单`);
  return JSON.parse(readFileSync(f, "utf8"));
}
export const stackOf = (name) => {
  const w = stacks().find((s) => s.name === name);
  if (!w) throw new Error(`stacks.json 里没有“${name}”`);
  return w;
};
export const runsFile = (w) => join(WORK, `runs-${w.name}.txt`);
export const stackDir = (w) => join(WORK, `stack-${w.name}`);
export const ledgerOf = (w) => join(stackDir(w), "web-data", "demo-firm", "ledger.db");

/** 任务登记表：每行“标签 run_id matter_id”。 */
export function runsOf(w) {
  try {
    return readFileSync(runsFile(w), "utf8").split("\n").map((l) => l.trim().split(/\s+/)).filter((x) => x.length >= 3);
  } catch {
    return [];
  }
}

/** 经开发桥调用产品接口（与界面同一条路；令牌是开发桥启动时写下的）。 */
export async function inv(w, method, params = {}) {
  const tok = readFileSync(join(PLATFORM, "apps/desktop/dev/.bridge-token"), "utf8").trim();
  const r = await fetch(`http://127.0.0.1:${w.bridge}/invoke`, { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${w.web}`, "x-kwl-token": tok }, body: JSON.stringify({ method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result ?? j;
}

/** 无头浏览器（Playwright 不是仓库依赖：全局装一份，或用 KWL_PLAYWRIGHT 指到它的 index.mjs）。 */
export async function chromium() {
  const candidates = [process.env.KWL_PLAYWRIGHT, "playwright", join(dirname(process.execPath), "..", "lib", "node_modules", "playwright", "index.mjs")].filter(Boolean);
  for (const c of candidates) {
    try {
      return (await import(c)).chromium;
    } catch {}
  }
  throw new Error("找不到 Playwright：npm i -g playwright && npx playwright install chromium，或设 KWL_PLAYWRIGHT");
}

export const TERMINAL = /^(succeeded|failed|partial|cancelled|canceled|timed_out|expired)/;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 题库材料与界面驱动脚本要由界面开发服务器提供（apps/desktop/kwl-testdocs 不入库）：起栈前从 eval/ 同步过去。
 * 逐个文件覆盖；几套栈同时起时由 up.mjs 先同步一次，各栈不再重复（两个进程同时写同一个文件会报“已存在”）。
 */
export function syncMaterials() {
  const dest = join(PLATFORM, "apps/desktop/kwl-testdocs");
  const walk = (from, to) => {
    mkdirSync(to, { recursive: true });
    for (const f of readdirSync(from)) {
      const a = join(from, f);
      if (statSync(a).isDirectory()) walk(a, join(to, f));
      else copyFileSync(a, join(to, f));
    }
  };
  walk(join(EVAL, "materials"), dest);
  copyFileSync(join(EVAL, "driver.js"), join(dest, "driver.js"));
}
