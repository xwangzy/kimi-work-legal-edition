/**
 * 安装包真实联调驱动（第 54 批）：连已安装、以 --remote-debugging-port 启动的 Kimi Work 法律版，按“阶段”操作真实界面，
 * 所有 AI 结果来自真实模型调用，账号、用量来自云端；本脚本不注入任何模拟数据，也不绕过界面直接改内核状态
 * （只在读取状态与核对时调用 window.zrKernel.invoke 的只读方法）。
 *
 * 用法：node scripts/e2e/ui.mjs <阶段> [参数]
 *   环境：KWL_CDP_PORT（缺省 9222）、KWL_E2E_OUT（证据目录，缺省 ./e2e-out）、PW_CORE（playwright-core 所在目录，可选）
 *   ready                              等主窗口加载，打印当前页面
 *   register                           注册（KWL_EMAIL / KWL_PASSWORD / KWL_NAME / KWL_CODE）；凭邀请码的会停在“等待批准”，打印入组核对码
 *   login                              登录（KWL_EMAIL / KWL_PASSWORD）
 *   await-approval [分钟]              等管理员批准；出现“本所识别码”后与 KWL_FIRM_CODE 逐位比对，一致才点“一致，打开”
 *   diagnose [expect-ok|expect-fail]   设置里的“检测连接”（connection.diagnose），打印各服务结论
 *   qa <问题>                          问答页真实提问，等回答，打印前 800 字与引用条数
 *   task <卡片 JSON 文件>              新建事项、加材料（真实文件输入框）、开始面板、确认计划、等任务到终态
 *   export                             对上一个任务的每份 Word/Excel 成果点“下载”，经系统保存对话框存到 $KWL_E2E_OUT/exports，核对文件
 *   usage                              “套餐与用量”页与额度状态（quota.status）
 *   shot <名字>                        截主窗口到 $KWL_E2E_OUT/<名字>.png
 * 保存对话框：Windows 上由 scripts/e2e/win-save-dialog.ps1 按 $KWL_E2E_OUT/next-save-path.txt 填路径并点“保存”；
 * macOS 上没有辅助功能权限时由人点“存储”（脚本等文件出现，最多 5 分钟）。
 */
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { basename, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const pwDir = process.env.PW_CORE;
const { chromium } = require(pwDir ? join(pwDir, "node_modules", "playwright-core") : "playwright-core");

const PORT = Number(process.env.KWL_CDP_PORT || 9222);
const OUT = resolve(process.env.KWL_E2E_OUT || "e2e-out");
mkdirSync(OUT, { recursive: true });
const STATE = join(OUT, "state.json");
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const saveState = () => writeFileSync(STATE, JSON.stringify(state, null, 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)} +${Math.round((Date.now() - t0) / 1000)}s]`, ...a);

async function connect() {
  let lastErr;
  for (let i = 0; i < 60; i++) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 10000 });
      let page = null;
      let best = -1;
      for (const p of browser.contexts().flatMap((c) => c.pages())) {
        if (!p.url().startsWith("kwl://") && !p.url().startsWith("http")) continue;
        const area = await p.evaluate(() => window.innerWidth * window.innerHeight).catch(() => 0);
        if (area > best) [best, page] = [area, p];
      }
      if (page) return { browser, page };
      lastErr = new Error("还没有主窗口");
    } catch (e) {
      lastErr = e;
    }
    await sleep(2000);
  }
  throw lastErr;
}

const { page } = await connect();
page.setDefaultTimeout(20000);
const text = () => page.evaluate(() => document.body.innerText);
const inv = (method, params = {}) =>
  page.evaluate(
    async ([m, p]) => {
      try {
        return { ok: true, result: await window.zrKernel.invoke(m, p) };
      } catch (e) {
        return { ok: false, code: e.code, message: e.message };
      }
    },
    [method, params],
  );
async function until(fn, ms, step = 1000, what = "条件") {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`等待超时：${what}`);
    await sleep(step);
  }
}
const shot = async (name) => {
  const p = join(OUT, `${name}.png`);
  await page.screenshot({ path: p });
  log("截图", basename(p));
};
const go = async (hash) => {
  await page.evaluate((h) => (location.hash = h), hash);
  await sleep(1500);
};
const btnExact = (label) => page.locator("button:visible").filter({ hasText: new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`) });
const mask = (s) => String(s ?? "").replace(/[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3,}/g, "<码>");

// ── 阶段 ──────────────────────────────────────────────────────────────
async function ready() {
  await until(async () => (await text()).trim().length > 20, 180000, 1000, "主窗口内容");
  log("主窗口：", (await text()).replace(/\s+/g, " ").slice(0, 160));
  log("地址：", page.url());
}

async function register() {
  const { KWL_EMAIL: email, KWL_PASSWORD: pw, KWL_NAME: name, KWL_CODE: code } = process.env;
  if (!email || !pw || !name || !code) throw new Error("register 需要 KWL_EMAIL / KWL_PASSWORD / KWL_NAME / KWL_CODE");
  await ready();
  await page.getByRole("tab", { name: "注册" }).click();
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').first().fill(pw);
  await page.locator('input[placeholder="同事和客户看到的名字"]').fill(name);
  const cb = page.locator("label.auth-check input[type=checkbox]");
  if (!(await cb.isChecked())) await cb.check();
  await page.locator("input.activate-code").fill(code);
  await shot("01-注册表单");
  await btnExact("注册并继续").click();
  const outcome = await until(
    async () => {
      const t = await text();
      if (/等待管理员批准|等待批准这台电脑/.test(t)) return "pending";
      const err = await page.locator(".activate-error").first().textContent().catch(() => null);
      if (err) return `error:${err}`;
      if (/#\/(welcome|home)?$/.test(new URL(page.url()).hash) && !/注册并继续/.test(t) && /事项|问答|首页/.test(t)) return "in";
      return null;
    },
    180000,
    1000,
    "注册结果",
  );
  if (outcome.startsWith("error:")) {
    await shot("01-注册失败");
    throw new Error(`注册失败：${mask(outcome.slice(6))}`);
  }
  if (outcome === "pending") {
    const check = (await page.locator('[aria-label="入组核对码"]').textContent()).trim();
    state.check_code = check;
    saveState();
    writeFileSync(join(OUT, "check-code.txt"), check + "\n");
    log("已提交入组申请，入组核对码：", check);
    await shot("02-等待管理员批准");
  } else {
    log("注册完成，已进入");
    await shot("02-注册后");
  }
}

async function login() {
  const { KWL_EMAIL: email, KWL_PASSWORD: pw } = process.env;
  await ready();
  await page.getByRole("tab", { name: "登录" }).click();
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').first().fill(pw);
  await btnExact("登录").click();
  const r = await until(async () => {
    const t = await text();
    if (/等待管理员批准|等待批准这台电脑/.test(t)) return "pending";
    const err = await page.locator(".activate-error").first().textContent().catch(() => null);
    if (err) return `error:${err}`;
    if (!/忘记密码/.test(t) && /事项|问答/.test(t)) return "in";
    return null;
  }, 120000);
  log("登录结果：", r.startsWith("error:") ? r : r);
  await shot("登录后");
  if (r.startsWith("error:")) throw new Error(r);
}

async function awaitApproval(minutes = 45) {
  // 两种入组：账号在新电脑登录（D-186）批准后先显示“本所识别码”请律师比对再打开；邀请码入组由管理员的批准核对段（邀请码本机秘密段的 HMAC）
  // 认证，批准后直接打开——这时到“设置 · 账号与团队 · 本所识别码”取同一串数字比对（第 54 批真实走查：旧驱动只等前一种，邀请码入组会一直等到超时）
  const want = (process.env.KWL_FIRM_CODE || "").replace(/\s+/g, "");
  if (!want) throw new Error("没有给 KWL_FIRM_CODE：不能确认本所识别码，按产品要求不应继续");
  let lastShot = 0;
  let lastClick = 0;
  const got = await until(
    async () => {
      const t = await text();
      if (/已拒绝|被拒绝|没有批准这次申请/.test(t)) throw new Error("入组申请被拒绝");
      if (await page.locator('[aria-label="本所识别码"]').count()) return { via: "account", firm: (await page.locator('[aria-label="本所识别码"]').first().innerText()).trim() };
      if (!(await page.locator('[aria-label="入组核对码"]').count()) && !/等待管理员批准|等待批准这台电脑|正在完成激活/.test(t) && /事项|问答|开通的最后一步/.test(t)) return { via: "invite" };
      if (Date.now() - lastShot > 60000) {
        lastShot = Date.now();
        await shot("03-等待批准-现场");
        writeFileSync(join(OUT, "waiting-text.txt"), t);
      }
      if (Date.now() - lastClick > 30000) {
        lastClick = Date.now();
        await btnExact("现在查一下").click({ timeout: 2000 }).catch(() => {});
      }
      return null;
    },
    Number(minutes) * 60000,
    1500,
    "管理员批准",
  );
  if (got.via === "account") {
    log("已批准（账号新电脑）；本所识别码：", got.firm);
    await shot("03-已批准-本所识别码");
    if (got.firm.replace(/\s+/g, "") !== want) throw new Error(`本所识别码与管理员电脑上的不一致（${got.firm}）：按产品要求停止`);
    log("本所识别码与管理员电脑逐位一致");
    await btnExact("一致，打开").click();
    await until(async () => /事项|问答/.test(await text()) && !/本所识别码/.test(await text()), 180000, 1500, "进入主界面");
  } else {
    log("已批准（邀请码入组），已直接进入；到“设置 · 账号与团队”核对本所识别码");
    const st = await until(async () => {
      const r = await inv("kernel.status", {});
      return r.ok && r.result?.activation?.firm_check_code ? r.result.activation : null;
    }, 120000, 2000, "本机身份");
    await go("#/connections/account");
    await page.locator("summary", { hasText: "本所识别码" }).first().click().catch(() => {});
    await sleep(800);
    await shot("03-已批准-设置里的本所识别码");
    const firm = String(st.firm_check_code);
    log("本所识别码（这台电脑）：", firm, "；律所：", st.firm?.name, "；成员：", st.member?.name, st.member?.role);
    if (firm.replace(/\s+/g, "") !== want) throw new Error(`本所识别码与管理员电脑上的不一致（${firm}）：按产品要求停止`);
    log("本所识别码与管理员电脑逐位一致");
  }
  await sleep(3000);
  await go("#/");
  await sleep(2000);
  await shot("04-入组后主界面");
  log("已进入：", (await text()).replace(/\s+/g, " ").slice(0, 120));
}

async function diagnose(expect = "expect-ok") {
  const r = await inv("connection.diagnose", {});
  if (!r.ok) throw new Error(`检测连接调用失败：${r.code} ${r.message}`);
  const d = r.result;
  log("检测连接：", d.conclusion, "| tone", d.tone, "| gate", d.gate);
  for (const s of d.rows ?? []) log("  ", s.name, `${s.host ?? ""}:${s.port ?? ""}`, "→", s.class, s.label, `${s.elapsed_ms}ms`, s.detail ?? "");
  writeFileSync(join(OUT, `diagnose-${expect}.json`), JSON.stringify(d, null, 1));
  const cap = await inv("kernel.capabilities", {});
  if (cap.ok) {
    log("执行域：", cap.result.execution_domain?.label, "|", cap.result.execution_domain?.status);
    writeFileSync(join(OUT, `capabilities-${expect}.json`), JSON.stringify({ execution_domain: cap.result.execution_domain, customer_rows: cap.result.customer_rows }, null, 1));
  }
  await go("#/connections/general");
  await shot(`diagnose-${expect}`);
  const allOk = d.tone === "ok";
  if (expect === "expect-ok" && !allOk) log("注意：检测连接不是全部正常（见上）");
  if (expect === "expect-fail" && allOk) throw new Error("断网后检测连接仍显示全部正常");
}

async function qa(question) {
  await go("#/chat");
  const ta = page.locator("main textarea").first();
  await ta.fill(question);
  const before = await page.locator("main").innerText();
  await page.locator('button[aria-label="发送"]').click();
  const started = Date.now();
  // 等回答写完：发送键恢复可用且主区域出现新内容、且不再有等待块
  // 回答写完：问题之后出现了回答（或“未能取得回答”），且不再显示等待。不用“页面变长”判断——新问答会换成新会话，页面可能比之前短
  // （第 54 批 Windows 断网演练：问题已如实回“连不上云端 AI 服务”，旧判据一直等到超时）
  void before;
  await until(
    async () => {
      const t = await page.locator("main").innerText();
      const i = t.lastIndexOf(question);
      const after = i < 0 ? "" : t.slice(i + question.length).replace(/\s+/g, "");
      const busy = await page.locator('button[aria-label="发送"]').isDisabled().catch(() => true);
      const waiting = /正在思考|正在回答|正在写|已用时/.test(t.slice(-400));
      return after.length > 20 && !waiting && (!busy || !(await ta.inputValue()));
    },
    Number(process.env.KWL_QA_TIMEOUT_MIN || 15) * 60000,
    2000,
    "问答回答",
  );
  await sleep(2000);
  const t = await page.locator("main").innerText();
  const ans = t.slice(t.lastIndexOf(question) + question.length).trim();
  log(`问答用时 ${Math.round((Date.now() - started) / 1000)} 秒；回答前 800 字：\n${ans.slice(0, 800)}`);
  writeFileSync(join(OUT, `qa-${Date.now()}.txt`), `问：${question}\n\n${ans}\n`);
  await shot("qa");
  return ans;
}

// 开始面板字段（取自 eval/driver.js 的同一份界面约定）
const VERB = { "contract-review": "开始审查", pleading: "开始起草", "doc-revise": "开始修改", "demand-lit": "开始起草", "research-lit": "开始研究", "legal-opinion": "开始起草" };
async function task(cardFile) {
  const card = JSON.parse(readFileSync(cardFile, "utf8"));
  const base = card.base ? resolve(card.base) : resolve(cardFile, "..");
  const pick = async (startsWith) => {
    await page.locator("[role=option]").filter({ hasText: new RegExp(`^\\s*${startsWith}`) }).first().click();
    await sleep(300);
  };
  // KWL_MATTER_ID：沿用已建好、材料已导入的事项（中断后续跑用），跳过第 1、2 步
  let matterId = process.env.KWL_MATTER_ID || "";
  if (matterId) log("沿用已建事项：", matterId);
  else {
  // 1. 新建事项（真实对话框）
  await go("#/matters");
  await btnExact("新建事项").click();
  const dlg = page.locator("[role=dialog]").last();
  await dlg.waitFor();
  const m = card.matter;
  if (m.type) {
    await dlg.locator("button[type=button]").nth(0).click();
    await pick(m.type);
  }
  await dlg.locator("button[type=button]").nth(1).click();
  await pick(m.stance);
  await dlg.locator('input[placeholder^="例如：甲公司股权转让"]').fill(m.title);
  if (m.client) await dlg.locator('input[placeholder^="委托人"]').fill(m.client);
  if (m.counter) await dlg.locator('input[placeholder^="多个以顿号"]').fill(m.counter);
  // 客户授权是分段按钮（role=radio，第 48 批 D-202），不是 <input type=radio>：本单材料是虚构案例，按“已取得”记录
  await dlg.locator('[role=radiogroup][aria-label="客户是否同意使用 AI 辅助"] [role=radio]').filter({ hasText: /^\s*已取得\s*$/ }).click();
  if (m.asOf || m.region || m.eventDate) {
    await dlg.locator("button").filter({ hasText: "更多设置" }).first().click();
    if (m.eventDate) await dlg.locator('input[placeholder^="如 2023-05"]').fill(m.eventDate);
    if (m.region) await dlg.locator('input[placeholder^="如 上海市"]').fill(m.region);
    // 有模板起算日时对话框里还有一个日期框；分析截止日在“更多设置”里，排在最后
    if (m.asOf) await dlg.locator("input[type=date]").last().fill(m.asOf);
  }
  await shot("10-新建事项");
  await dlg.locator("button").filter({ hasText: /^\s*创建事项\s*$/ }).click();
  await until(async () => /#\/matter\/mat_/.test(page.url()), 30000, 500, "事项创建");
  matterId = page.url().match(/mat_[0-9a-zA-Z_-]+/)[0];
  log("事项已创建：", matterId);
  // 2. 加材料：给“选择文件”背后的真实文件输入框塞文件（与拖放同一路径：preload 经 webUtils 取路径交主进程登记）
  const files = card.files.map((f) => resolve(base, f));
  for (const f of files) if (!existsSync(f)) throw new Error(`材料不存在：${f}`);
  // 经 CDP 的 DOM.setFileInputFiles 给真实磁盘路径（与系统“选择文件”对话框同效）：Playwright 经 connectOverCDP 的 setInputFiles
  // 传的是内存里的文件内容，页面里的 File 没有磁盘路径，preload 的 webUtils.getPathForFile 取不到路径 → 客户端按设计拒收
  const cdp = await page.context().newCDPSession(page);
  const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "main input[type=file]" });
  if (!nodeId) throw new Error("没有找到材料的文件输入框");
  await cdp.send("DOM.setFileInputFiles", { nodeId, files });
  await cdp.detach().catch(() => {});
  await until(async () => ((await page.locator("main").innerText()).match(/已添加/g) ?? []).length >= files.length, 180000, 1000, "材料加密导入");
  log(`材料已导入 ${files.length} 份`);
  await shot("11-材料已导入");
  }
  // 3. 开始面板
  await go(`#/start/${card.id}/${matterId}`);
  const sp = page.locator("[role=dialog]").last();
  await sp.waitFor();
  await sleep(1500);
  for (const c of await sp.locator("input[type=checkbox][aria-label]").all()) if (!(await c.isChecked())) await c.check();
  for (const [label, v] of Object.entries(card.fields ?? {})) {
    const field = sp.locator("label.ss-field").filter({ has: page.locator(".ss-label", { hasText: label }) }).first();
    if (Array.isArray(v)) {
      for (const x of v) await field.locator("button").filter({ hasText: new RegExp(`^\\s*${x}\\s*$`) }).click();
    } else if (await field.locator("textarea, input:not([type=checkbox])").count()) {
      await field.locator("textarea, input:not([type=checkbox])").first().fill(v);
    } else {
      await field.locator("button").first().click();
      await pick(v);
    }
  }
  if (card.extra) await sp.locator('textarea[aria-label="补充要求"]').fill(card.extra);
  await sleep(1500);
  await shot("12-开始面板");
  const verb = sp.locator("button").filter({ hasText: new RegExp(`^\\s*(${VERB[card.id] ?? "开始"}|下一步：确认)\\s*$`) }).first();
  await verb.click();
  for (let i = 0; i < 6 && !/#\/run\//.test(page.url()); i++) {
    await sleep(1500);
    const d2 = page.locator("[role=dialog]").last();
    if (await d2.count()) {
      const b = d2.locator("button").filter({ hasText: /^\s*(确认发起|开始)\s*$/ }).first();
      if (await b.count()) await b.click().catch(() => {});
    }
  }
  const [, runId] = page.url().match(/#\/run\/(run_[0-9a-zA-Z_-]+)/) ?? [];
  if (!runId) throw new Error("没有进入任务页");
  Object.assign(state, { matter_id: matterId, run_id: runId, card: card.id });
  saveState();
  log("任务已发起：", runId);
  // 4. 跟到终态：计划卡点“按这个计划开始”；论点提纲勾“同时确认事实”并确认；提问按卡片预设回答或选第一项
  const answers = [...(card.answers ?? [])];
  const started = Date.now();
  let last = "";
  const terminal = /^(succeeded|failed|partial|cancelled|canceled|timed_out|expired)/;
  for (;;) {
    const r = await inv("runs.get", { run_id: runId });
    const st = r.ok ? r.result.run?.status : `?${r.code}`;
    if (st !== last) {
      log("任务状态：", st);
      last = st;
    }
    if (r.ok && terminal.test(st)) break;
    if (Date.now() - started > (card.timeout_min ?? 75) * 60000) throw new Error("任务超时（驱动侧）");
    if (st === "waiting_approval" || st === "waiting_input") {
      await go(`#/run/${runId}/${matterId}`);
      await sleep(2500);
      const main = page.locator("main");
      const plan = main.locator("button").filter({ hasText: /^\s*按这个计划开始\s*$/ });
      const outline = main.locator("button").filter({ hasText: /^\s*确认并开始起草/ });
      if (await plan.count()) {
        writeFileSync(join(OUT, "plan.txt"), await main.innerText());
        await shot("13-工作计划");
        await plan.first().click();
        log("已确认工作计划");
      } else if (await outline.count()) {
        writeFileSync(join(OUT, "outline.txt"), await main.innerText());
        const cb = main.locator("label", { hasText: "同时确认" }).locator("input[type=checkbox]");
        if ((await cb.count()) && !(await cb.first().isChecked())) await cb.first().check();
        await outline.first().click();
        log("已确认论点提纲");
      } else {
        const q = await main.innerText();
        writeFileSync(join(OUT, `question-${Date.now()}.txt`), q);
        await shot(`14-提问-${Date.now()}`);
        const opts = await main.locator("[role=radio], [role=checkbox]").all();
        const want = answers.shift();
        if (want && (await main.locator("textarea").count())) {
          await main.locator("textarea").first().fill(want);
          log("按预设回答：", want);
        } else if (opts.length) {
          await opts[0].click();
          log("提问未预设，选第一项：", (await opts[0].innerText()).slice(0, 60));
        }
        const ok = main.locator("button").filter({ hasText: /^\s*确定\s*$/ });
        if (await ok.count()) await ok.first().click().catch(() => {});
      }
      await sleep(3000);
      continue;
    }
    await sleep(10000);
  }
  await go(`#/run/${runId}/${matterId}`);
  await sleep(3000);
  const runText = await page.locator("main").innerText();
  writeFileSync(join(OUT, "run-view.txt"), runText);
  await shot("15-任务完成");
  const run = (await inv("runs.get", { run_id: runId })).result;
  const arts = (await inv("artifacts.list", { matter_id: matterId })).result?.artifacts ?? [];
  const mine = arts.filter((a) => a.run_id === runId);
  state.artifacts = mine.map((a) => ({ id: a.artifact_version_id, filename: a.filename, kind: a.kind, status: a.status, version: a.version, is_latest: a.is_latest }));
  state.run_status = run?.run?.status;
  state.run_minutes = Math.round((Date.now() - started) / 60000);
  saveState();
  log(`任务终态 ${run?.run?.status}，用时约 ${state.run_minutes} 分钟；成果 ${mine.length} 份：`);
  for (const a of state.artifacts) log("   ", a.kind, a.filename);
  // 部分完成（partial）是产品如实报告“还有没做完的地方”（复核回看发现必须改的意见没落到文件等，D-182）：成果已交付、照常导出核对，
  // 但不记成成功——终态与“没做完的地方”原文写进证据（run-view.txt），由验收报告如实写明
  if (/^partial/.test(run?.run?.status ?? "")) log("注意：任务终态是“部分完成”——成果照常导出核对，验收按部分完成记录（见 run-view.txt 的“还有没做完的地方”）");
  else if (!/^(succeeded|completed)/.test(run?.run?.status ?? "")) throw new Error(`任务没有成功：${run?.run?.status}（${run?.run?.error ?? ""}）`);
}

/** 读 zip（docx/xlsx）里的一个条目：只用中央目录 + inflateRaw，不依赖第三方包。 */
function zipEntry(buf, name) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("不是 zip");
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const fnLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const cmt = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const fn = buf.toString("utf8", p + 46, p + 46 + fnLen);
    names.push(fn);
    if (fn === name) {
      const lfn = buf.readUInt16LE(off + 26);
      const lex = buf.readUInt16LE(off + 28);
      const data = buf.subarray(off + 30 + lfn + lex, off + 30 + lfn + lex + csize);
      return method === 0 ? data.toString("utf8") : inflateRawSync(data).toString("utf8");
    }
    p += 46 + fnLen + extra + cmt;
  }
  return name === null ? names : null;
}

async function exportAll() {
  if (!state.artifacts?.length) throw new Error("没有上一个任务的成果（先跑 task）");
  const dir = join(OUT, "exports");
  mkdirSync(dir, { recursive: true });
  const results = [];
  // 只导出每份成果的最新版本（任务过程中的旧版本在“成果”里另有，不逐个导出）
  const latest = new Map();
  for (const x of state.artifacts.filter((x) => /\.(docx|xlsx)$/i.test(x.filename))) {
    const cur = latest.get(x.filename);
    if (x.is_latest === true || !cur || (cur.is_latest !== true && (x.version ?? 0) > (cur.version ?? 0))) latest.set(x.filename, x);
  }
  for (const a of latest.values()) {
    await go(`#/review/${a.id}`);
    await sleep(2500);
    const btn = page.locator(".page-head-actions button").filter({ hasText: /^\s*下载/ }).first();
    const target = join(dir, a.filename.replace(/[\\/:*?"<>|]/g, "_"));
    writeFileSync(join(OUT, "next-save-path.txt"), target);
    const before = existsSync(target) ? statSync(target).mtimeMs : 0;
    await btn.click();
    log("已点“下载”，等系统保存对话框存到：", basename(target));
    // 对话框缺省位置（Windows“文档”、macOS“文稿”，应用给的缺省文件名）也认，再复制进证据目录：macOS 没有辅助功能权限时由人点“存储”；
    // Windows 由 win-save-dialog.ps1 直接按“保存”（第 54 批：往新式文件对话框的文件名框 WM_SETTEXT 不生效，文件仍存到缺省位置）
    const macDefault = process.platform === "darwin" || process.platform === "win32" ? join(homedir(), "Documents", basename(target)) : null;
    const macBefore = macDefault && existsSync(macDefault) ? statSync(macDefault).mtimeMs : 0;
    const fresh = (p, b) => existsSync(p) && statSync(p).mtimeMs !== b && statSync(p).size > 0;
    const ok = await until(async () => fresh(target, before) || (macDefault && fresh(macDefault, macBefore)), 300000, 1000, `保存 ${a.filename}`).catch((e) => (log(String(e)), false));
    if (ok && macDefault && !fresh(target, before)) {
      await sleep(1500);
      copyFileSync(macDefault, target);
      log("已存到对话框缺省位置（文档 / 文稿），复制进证据目录：", basename(target));
    }
    if (!ok) {
      results.push({ file: a.filename, saved: false });
      continue;
    }
    await sleep(1500);
    const buf = readFileSync(target);
    const r = { file: a.filename, kind: a.kind, saved: true, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
    try {
      const names = zipEntry(buf, null);
      r.zip_entries = names.length;
      if (/\.docx$/i.test(target)) {
        const doc = zipEntry(buf, "word/document.xml") ?? "";
        r.paragraphs = (doc.match(/<w:p[ >]/g) ?? []).length;
        r.ins = (doc.match(/<w:ins /g) ?? []).length;
        r.del = (doc.match(/<w:del /g) ?? []).length;
        const cm = zipEntry(buf, "word/comments.xml");
        r.comments = cm ? (cm.match(/<w:comment /g) ?? []).length : 0;
        const authors = new Set([...doc.matchAll(/w:author="([^"]*)"/g)].map((x) => x[1]));
        r.authors = [...authors].slice(0, 4);
        r.text_chars = doc.replace(/<[^>]+>/g, "").length;
        r.has_token_residue = /〔[^〕]{1,20}〕/.test(doc.replace(/<[^>]+>/g, ""));
      } else {
        r.sheets = names.filter((x) => /^xl\/worksheets\/sheet\d+\.xml$/.test(x)).length;
      }
    } catch (e) {
      r.zip_error = String(e.message);
    }
    log("已导出：", JSON.stringify(r));
    results.push(r);
  }
  await shot("16-导出后");
  writeFileSync(join(OUT, "exports.json"), JSON.stringify(results, null, 1));
  const bad = results.filter((x) => !x.saved || x.zip_error);
  if (!results.length || bad.length) throw new Error(`导出未全部完成：${bad.map((x) => x.file).join("、") || "没有可导出的 Word/Excel"}`);
}

async function usage() {
  const q = await inv("quota.status", {});
  writeFileSync(join(OUT, "quota-status.json"), JSON.stringify(q, null, 1));
  log("额度状态（quota.status）：", JSON.stringify(q.ok ? q.result : q).slice(0, 1200));
  await go("#/connections/usage");
  await sleep(3500);
  const t = await page.locator("main").innerText();
  writeFileSync(join(OUT, "usage-page.txt"), t);
  log("套餐与用量页：\n" + t.slice(0, 1500));
  await shot("17-套餐与用量");
}

const [phase, ...args] = process.argv.slice(2);
const phases = { ready, register, login, "await-approval": awaitApproval, diagnose, qa, task, export: exportAll, usage, shot: (n) => shot(n ?? "shot") };
if (!phases[phase]) {
  console.error(`未知阶段：${phase}`);
  process.exit(2);
}
try {
  await phases[phase](...args);
  log(`阶段 ${phase} 完成`);
  process.exit(0);
} catch (e) {
  log(`阶段 ${phase} 失败：`, mask(e.message));
  await shot(`失败-${phase}`).catch(() => {});
  process.exit(1);
}
