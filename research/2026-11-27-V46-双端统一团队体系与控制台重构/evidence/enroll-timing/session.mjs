// 一次 Electron 会话：全新数据目录 → 注册（路径 A 计时）→ [退出登录 → 换个账号 → 密码登录已有账号（路径 B 计时）]
// 用法：node session.mjs <配置 JSON>，配置：{ ver, wt, lat, ud, webPort, phoneA, nameA, phoneB?, nameB?, logoutOnly?, out, tag }
// 结果一行 JSON 追加到 cfg.out；过程文字序列另写 <tag>.trace.txt；埋点（measure-enroll --watch）写 <tag>-A.jsonl / <tag>-B.jsonl
import { createRequire } from "node:module";
import { readFileSync, appendFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(process.argv[2]);
const SP = "/private/tmp/claude-501/-Users-wangzeyu-Documents-Coding-Kimi-Work-Legal/0d6e0c1f-ceda-4025-9dcf-13a576f15bc5/scratchpad";
const PLAT = `/Users/wangzeyu/Documents/Coding/Kimi Work Legal/.claude/worktrees/${cfg.wt}/platform`;
const DESK = join(PLAT, "apps/desktop");
const MEASURE = "/Users/wangzeyu/Documents/Coding/Kimi Work Legal/.claude/worktrees/kimi-legal-b72/platform/scripts/measure-enroll.mjs";
const RAW = join(here, "raw");
mkdirSync(RAW, { recursive: true });
const greq = createRequire("/Users/wangzeyu/.nvm/versions/node/v26.8.1/lib/node_modules/");
const { _electron } = greq("playwright");
const electronPath = createRequire(join(PLAT, "package.json"))("electron");
const PW = "Kwl-Local-2026a";

// 环境：stack/client.env 逐行；300 ms 档把控制面 / 网关 / 检索改指延迟代理
const env = { ...process.env };
for (const l of readFileSync(join(SP, "tools/stack/client.env"), "utf8").split("\n")) { const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(l); if (m) env[m[1]] = m[2]; }
if (cfg.lat > 0) for (const k of ["ZR_CONTROL_PLANE_BASE", "ZR_GATEWAY_BASE", "ZR_SEARCH_BASE"]) env[k] = env[k].replace(/127\.0\.0\.1:187(4\d)/, "127.0.0.1:287$1");
Object.assign(env, { ZR_MODEL_PROVIDER: "upstream", ZR_BACKUP_TIMER: "off", ZR_DEMO_SAMPLES: "0", ZR_KERNEL_TCP: "off", KWL_DEV_WEB_PORT: String(cfg.webPort), ZR_DESKTOP_RUNTIME_DIR: join(SP, "et", `rt-${cfg.ver}`) });
for (const k of ["KWL_MOONSHOT_API_KEY", "ZR_FIRM_SLUG", "ZR_USER_SLUG", "ZR_KERNEL_DATA_DIR", "ZR_DESKTOP_DEV_URL", "ZR_DESKTOP_PROD", "ELECTRON_RUN_AS_NODE"]) delete env[k];
// cfg.prod：生产渲染（ZR_DESKTOP_PROD=1，主进程从 apps/desktop/dist 经 kwl://app/ 载入 vite build 产物；没有 React StrictMode 的开发期双调用、没有热更新）
if (cfg.prod) env.ZR_DESKTOP_PROD = "1";

const trace = [];
const T = (s) => { const line = `${new Date().toISOString().slice(11, 23)} ${s}`; trace.push(line); console.log(line); };
const ERR_RE = /还没有登记完成|请关闭并重新打开应用|还没有打开成功|还没有切换过去|登记失败|没能|出错了|请重试/;
const OPENING_RE = /正在打开|这台电脑已登记为你的电脑|注册并继续|正在注册|正在登录|你已退出登录|正在切换|正在核对/;

const app = await _electron.launch({ executablePath: electronPath, args: [DESK, `--user-data-dir=${cfg.ud}`, "--use-mock-keychain"], cwd: DESK, env, timeout: 90000 });
const page = await app.firstWindow();
let navs = [];
page.on("framenavigated", (f) => { if (f === page.mainFrame()) navs.push(Date.now()); });
const btn = (re) => page.locator("button:visible").filter({ hasText: re });
const body = async () => { try { return (await page.evaluate(() => document.body?.innerText ?? "")).replace(/\s+/g, " "); } catch { return "(重载中)"; } };
const snap = async () => {
  try {
    return await page.evaluate(() => {
      const vis = (el) => !!(el && el.getClientRects().length);
      const t = (document.body?.innerText ?? "").replace(/\s+/g, " ");
      const newTask = [...document.querySelectorAll("button, a, [role=button]")].some((e) => vis(e) && /新建任务/.test(e.textContent || ""));
      return { t, newTask };
    });
  } catch { return { t: "(重载中)", newTask: false }; }
};
function watcher(tag) {
  const root = join(cfg.ud, "KimiWorkLegal");
  const out = join(RAW, `${cfg.tag}-${tag}.jsonl`);
  const p = spawn(process.execPath, [MEASURE, "--data", root, "--watch", "--out", out], { stdio: ["ignore", "pipe", "pipe"] });
  let rep = "";
  p.stdout.on("data", (d) => (rep += d));
  p.stderr.on("data", () => {});
  return { stop: () => new Promise((r) => { p.on("exit", () => { writeFileSync(join(RAW, `${cfg.tag}-${tag}.report.md`), rep); r(); }); p.kill("SIGINT"); }) };
}
/** 点击后计时：首屏 = 新建任务可见且前 400 字不是过渡页（可选：出现期望姓名）；就绪 = 首屏且全文不再有“正在启动 / 正在连接…”等字样。
 *  首屏后继续采样 postMs（收首次同步与 AI 可用埋点），记录文字序列（前 90 字 + 是否仍有“正在…”）与错误文案 */
const SETTLE_RE = /正在打开|正在启动|正在连接|正在加载|正在保存登录信息|这台电脑已登记为你的电脑|注册并继续|正在注册|正在登录|你已退出登录|正在切换|正在核对|正在取得/;
async function timeUntilWorkspace(label, expectName, clickFn, maxSec = 180, postMs = 9000) {
  navs = [];
  const seq = [];
  const errs = new Set();
  let last = "";
  let firstAt = null, settledAt = null, deviceLimit = false;
  const diag = {};
  const t0 = Date.now();
  await clickFn();
  while (Date.now() - t0 < maxSec * 1000) {
    await page.waitForTimeout(100);
    const s = await snap();
    const ms = Date.now() - t0;
    const busy = (s.t.match(SETTLE_RE) || [""])[0];
    const key = s.t.slice(0, 90) + (busy ? ` ‹${busy}›` : "");
    if (key !== last) { seq.push([ms, s.t.slice(0, 90), busy]); T(`${label} +${(ms / 1000).toFixed(1)}s ${key}`); last = key; }
    const m = s.t.match(ERR_RE);
    if (m) errs.add(m[0]);
    if (/电脑数已满|同时登录的电脑已达上限|选一台/.test(s.t) && !deviceLimit) { deviceLimit = true; T(`${label} 出现电脑数上限`); }
    const named = !expectName || s.t.includes(expectName);
    // 诊断（cfg.diag，只用于 300 ms 路径 B 卡住时取证）：卡在过渡页 15 s 后，读一次 kernel.status（只取模式 / 交接 / 重启 / 失败码等枚举），
    // 然后手动整页重载一次，看重载后能否直接进工作区（判断卡住的是界面等待循环还是内核）
    if (cfg.diag && label === "B" && firstAt === null && ms > 15000 && !diag.done) {
      diag.done = true;
      diag.at = ms;
      diag.status = await page.evaluate(async () => {
        try {
          const st = await window.zrKernel.invoke("kernel.status");
          const o = st?.onboarding;
          return { has_onboarding: !!o, onboarding_keys: o ? Object.keys(o).sort() : null, mode: o?.mode ?? null, handoff_next: o?.handoff?.next ?? null, restarting: o?.restarting ?? null, last_failure: o?.last_failure?.code ?? null, top_keys: st ? Object.keys(st).sort() : null, top_mode: st?.mode ?? null };
        } catch (e) { return { error: String(e?.code ?? e?.message ?? e).slice(0, 80) }; }
      }).catch((e) => ({ eval_error: String(e).slice(0, 80) }));
      T(`B 诊断 @${(ms / 1000).toFixed(1)}s kernel.status=${JSON.stringify(diag.status)}`);
      diag.reloadAt = Date.now() - t0;
      await page.evaluate(() => window.location.reload()).catch(() => {});
    }
    if (firstAt === null && s.newTask && !OPENING_RE.test(s.t.slice(0, 400)) && named) firstAt = ms;
    if (settledAt === null && s.newTask && !busy && named) settledAt = ms;
    if (firstAt !== null && settledAt !== null && ms - firstAt >= postMs) break;
  }
  return { ok: firstAt !== null, ms: firstAt, settled_ms: settledAt, seq, errors: [...errs], deviceLimit, reloads: navs.map((x) => x - t0), ...(diag.done ? { diag } : {}) };
}
const result = { tag: cfg.tag, ver: cfg.ver, lat: cfg.lat, started: new Date().toISOString() };
try {
  await page.waitForSelector("[data-auth-page]", { timeout: 90000 });
  result.boot_ms = Date.now() - Date.parse(result.started);
  await page.waitForTimeout(1500);
  // 注册
  await page.locator('[data-auth-page] button.btn-link:visible').filter({ hasText: /^\s*注册\s*$/ }).first().click();
  await page.waitForTimeout(400);
  await page.locator('input[type="tel"]:visible').fill(cfg.phoneA);
  await btn(/^\s*获取验证码\s*$/).first().click();
  await page.waitForFunction(() => /测试环境：验证码是\s*\d+|过于频繁/.test(document.body.innerText), null, { timeout: 30000 });
  if (/过于频繁/.test(await body())) throw new Error("短信限流：获取验证码过于频繁（未进入计时）");
  const code = (await body()).match(/测试环境：验证码是\s*(\d+)/)[1];
  await page.locator('input[autocomplete="one-time-code"]:visible').fill(code);
  await btn(/^\s*下一步\s*$/).click();
  await page.waitForTimeout(400);
  await page.locator('input[autocomplete="name"]:visible').fill(cfg.nameA);
  await page.locator('input[type="email"]:visible').fill(`t${cfg.phoneA}@kwl-local.example`);
  await page.locator('input[type="password"]:visible').first().fill(PW);
  await page.waitForTimeout(300);
  const wA = watcher("A");
  await page.waitForTimeout(500);
  result.A = await timeUntilWorkspace("A", null, () => btn(/^\s*注册并继续\s*$/).click());
  await wA.stop();
  result.A.landing = (await body()).slice(0, 300);
  if (cfg.shot) await page.screenshot({ path: join(RAW, `${cfg.tag}-A-landing.png`), scale: "css" });
  if (cfg.phoneB || cfg.logoutOnly) {
    await page.evaluate(() => { location.hash = "#/connections/account"; });
    await page.waitForTimeout(1500);
    if (!(await btn(/^\s*退出登录\s*$/).count())) T("账号页没有“退出登录”按钮");
    await btn(/^\s*退出登录\s*$/).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "退出登录" }).click();
    const tl = Date.now();
    await page.waitForFunction(() => /你已退出登录/.test(document.body.innerText), null, { timeout: 60000 });
    result.logout_ms = Date.now() - tl;
    await page.waitForTimeout(1000);
  }
  if (cfg.phoneB) {
    await btn(/^\s*换个账号\s*$/).click();
    await page.waitForTimeout(400);
    await page.getByRole("tab", { name: "密码登录" }).click();
    await page.locator('input[autocomplete="username"]:visible').fill(cfg.phoneB);
    await page.locator('input[type="password"]:visible').fill(PW);
    await page.waitForTimeout(300);
    const wB = watcher("B");
    await page.waitForTimeout(500);
    result.B = await timeUntilWorkspace("B", cfg.nameB, () => page.locator("form button[type=submit]:visible").first().click());
    await wB.stop();
    result.B.landing = (await body()).slice(0, 300);
    if (cfg.shot) await page.screenshot({ path: join(RAW, `${cfg.tag}-B-landing.png`), scale: "css" });
  }
} catch (e) {
  result.error = String(e?.message ?? e).slice(0, 400);
  T(`ERR ${result.error}`);
  try { await page.screenshot({ path: join(RAW, `${cfg.tag}-error.png`), scale: "css" }); } catch {}
  try { result.errorBody = (await body()).slice(0, 400); } catch {}
}
result.ended = new Date().toISOString();
appendFileSync(cfg.out, JSON.stringify(result) + "\n");
writeFileSync(join(RAW, `${cfg.tag}.trace.txt`), trace.join("\n") + "\n");
await app.close().catch(() => {});
process.exit(0);
