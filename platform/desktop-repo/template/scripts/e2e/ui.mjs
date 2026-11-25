/**
 * 安装包真实联调驱动（第 54 批）：连已安装、以 --remote-debugging-port 启动的 Kimi Work 法律版，按“阶段”操作真实界面，
 * 所有 AI 结果来自真实模型调用，账号、用量来自云端；本脚本不注入任何模拟数据，也不绕过界面直接改内核状态
 * （只在读取状态与核对时调用 window.zrKernel.invoke 的只读方法）。
 *
 * 用法：node scripts/e2e/ui.mjs <阶段> [参数]
 *   环境：KWL_CDP_PORT（缺省 9222）、KWL_E2E_OUT（证据目录，缺省 ./e2e-out）、PW_CORE（playwright-core 所在目录，可选）
 *   ready                              等主窗口加载，打印当前页面
 *   register                           注册（KWL_EMAIL / KWL_PASSWORD / KWL_NAME，凭码时加 KWL_CODE；云端要求手机验证时加 KWL_PHONE 与 KWL_SMS_RELAY）；
 *                                      凭成员邀请码的会停在“等待批准”，打印入组核对码
 *   login                              登录（KWL_EMAIL / KWL_PASSWORD）；云端开了验证码登录时先切到“密码登录”
 *   login-sms                          第 63 批：手机号验证码登录（KWL_PHONE；验证码由人转交：KWL_SMS_RELAY_LOGIN，缺省同 KWL_SMS_RELAY）。
 *                                      在开通页（这台电脑还没有身份）或已激活电脑的“设置 · 账号”就地登录框里都可用；新电脑会停在“等待批准这台电脑”
 *   logout                             第 63 批：设置 · 账号 → 退出登录（确认对话框），核对出现就地登录框
 *   approve-join                       第 63 批：管理员电脑上“设置 · 管理 · 成员”里按 KWL_CHECK_CODE 找到待批准申请、逐位一致才批准
 *   await-approval [分钟]              等管理员批准；出现“本所识别码”后与 KWL_FIRM_CODE 逐位比对，一致才点“一致，打开”
 *   diagnose [expect-ok|expect-fail]   设置里的“检测连接”（connection.diagnose），打印各服务结论
 *   qa <问题>                          问答页真实提问，等回答，打印前 800 字与引用条数
 *   task <卡片 JSON 文件>              新建事项、加材料（真实文件输入框）、开始面板、确认计划、等任务到终态
 *   export                             对上一个任务的每份 Word/Excel 成果点“下载”，经系统保存对话框存到 $KWL_E2E_OUT/exports，核对文件
 *   usage                              “套餐与用量”页与额度状态（quota.status）
 *   preview                            第 62 批：上一个任务每份 Word/Excel 成果（含旧版本）在复核页与任务页右栏的预览是否真的出图
 *                                      （按框架区域截图数深色像素，文档载入了但没画出来也判失败），截图存证
 *   shot <名字>                        截主窗口到 $KWL_E2E_OUT/<名字>.png
 * 保存对话框：Windows 上由 scripts/e2e/win-save-dialog.ps1 按 $KWL_E2E_OUT/next-save-path.txt 填路径并点“保存”；
 * macOS 上没有辅助功能权限时由人点“存储”（脚本等文件出现，最多 5 分钟）。
 */
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { inflateRawSync, inflateSync } from "node:zlib";
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
// 页面重载、内核按新身份重启时，正在执行的页面脚本会报“Execution context was destroyed”等：这类瞬时错误照常轮询，不算失败
// （第 54 批 Windows 运行 44917507144：入组批准后应用重启内核、页面重载，旧驱动在这里失败）
const TRANSIENT = /Execution context was destroyed|Cannot find context|Target (page, context or browser )?closed|navigation|frame was detached|Protocol error/i;
async function until(fn, ms, step = 1000, what = "条件") {
  const end = Date.now() + ms;
  for (;;) {
    let v = null;
    try {
      v = await fn();
    } catch (e) {
      if (!TRANSIENT.test(String(e?.message ?? e))) throw e;
      log("页面正在重载，稍后再看：", String(e?.message ?? e).slice(0, 80));
    }
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


// ── 预览出图核对（第 62 批）：截隔离框架所在区域，解 PNG 数深色像素（框架里文书正文是深色字、纸面浅底） ──
function decodePng(buf) {
  let off = 8;
  let w = 0, h = 0, ct = 0, bd = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") [w, h, bd, ct] = [data.readUInt32BE(0), data.readUInt32BE(4), data[8], data[9]];
    if (type === "IDAT") idat.push(data);
    off += 12 + len;
  }
  if (bd !== 8 || (ct !== 6 && ct !== 2)) throw new Error(`不支持的 PNG（位深 ${bd}、颜色类型 ${ct}）`);
  const bpp = ct === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      out[y * stride + x] = (src[x] + pred) & 0xff;
    }
  }
  return { w, h, bpp, data: out };
}
function darkPixels(png) {
  const { w, h, bpp, data } = decodePng(png);
  let n = 0;
  for (let i = 0; i < w * h; i++) {
    const [r, g, b] = [data[i * bpp], data[i * bpp + 1], data[i * bpp + 2]];
    if (0.299 * r + 0.587 * g + 0.114 * b < 110) n++;
  }
  return n;
}
async function framePainted(label) {
  const frame = page.locator("iframe.sp-frame").first();
  await frame.waitFor({ state: "visible", timeout: 60_000 });
  await sleep(2500);
  await frame.scrollIntoViewIfNeeded().catch(() => {});
  const box = await frame.boundingBox();
  const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  if (!box || box.width < 50 || box.height < 50) return { label, ok: false, dark: 0, why: "框架尺寸异常" };
  // 只截框架在视口内的部分（框架下沿可能超出窗口）
  const y0 = Math.max(0, box.y);
  const clip = { x: Math.max(0, box.x), y: y0, width: Math.min(box.width, vp.w - Math.max(0, box.x)), height: Math.min(box.height, 600, vp.h - y0) };
  if (clip.width < 50 || clip.height < 50) return { label, ok: false, dark: 0, why: "框架不在视口内" };
  const png = await page.screenshot({ clip });
  const dark = darkPixels(png);
  const name = `预览-${label}`.replace(/[\\/:*?"<>|\s]/g, "_");
  writeFileSync(join(OUT, `${name}.png`), png);
  return { label, ok: dark >= 300, dark, shot: `${name}.png` };
}

// ── 阶段 ──────────────────────────────────────────────────────────────
async function ready() {
  await until(async () => (await text()).trim().length > 20, 180000, 1000, "主窗口内容");
  log("主窗口：", (await text()).replace(/\s+/g, " ").slice(0, 160));
  log("地址：", page.url());
}

/** 等人把收到的短信验证码转交过来（最多 15 分钟）：只认发码之后写入/上传的那一份。 */
async function waitSmsCode(sinceMs, relay = process.env.KWL_SMS_RELAY ?? "") {
  log("等待转交短信验证码：", relay.replace(/:[^:]*$/, ":…"));
  return until(
    async () => {
      if (relay.startsWith("file:")) {
        const f = relay.slice(5);
        if (existsSync(f) && statSync(f).mtimeMs >= sinceMs - 1000) return (readFileSync(f, "utf8").match(/\b(\d{4,8})\b/) ?? [])[1] ?? null;
        return null;
      }
      if (relay.startsWith("gh-release:")) {
        const [, repo, tag, name] = relay.split(":");
        const h = { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "kwl-e2e" };
        const rel = await (await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, { headers: h })).json();
        const a = (rel.assets ?? []).find((x) => x.name === name && Date.parse(x.created_at) >= sinceMs - 60000);
        if (!a) return null;
        const body = await (await fetch(a.url, { headers: { ...h, accept: "application/octet-stream" } })).text();
        return (body.match(/\b(\d{4,8})\b/) ?? [])[1] ?? null;
      }
      throw new Error("KWL_SMS_RELAY 须为 file:<路径> 或 gh-release:<owner/repo>:<tag>:<文件名>");
    },
    15 * 60000,
    5000,
    "短信验证码转交",
  );
}

async function register() {
  const { KWL_EMAIL: email, KWL_PASSWORD: pw, KWL_NAME: name, KWL_CODE: code } = process.env;
  // KWL_CODE 可不给：云端 registration=open 时自助注册（自动开试用律所，本人为律所管理员；第 59 批 116 云端改为开放注册）
  if (!email || !pw || !name) throw new Error("register 需要 KWL_EMAIL / KWL_PASSWORD / KWL_NAME（凭码注册再给 KWL_CODE）");
  await ready();
  // 第 64 批：注册从外层页签改为登录卡片下方的“还没有账号？注册”（旧版本仍是页签，两种都认）；表单要等登录方式取到才出现
  await openRegister();
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').first().fill(pw);
  await page.locator('input[placeholder="同事和客户看到的名字"]').fill(name);
  // “我有开通码或邀请码”：凭码注册才勾；开放注册不带码时保持不勾（第 59 批）。第 62 批：云端要求邀请码时没有这个勾选框、码框直接显示
  const cb = page.locator("label.auth-check input[type=checkbox]");
  if (await cb.count()) {
    if (Boolean(code) !== (await cb.isChecked())) await cb.setChecked(Boolean(code));
  }
  if (code) await page.locator("input.activate-code").fill(code);
  // 第 62 批：手机号 + 短信验证码（云端要求时界面才有这一栏）。验证码由收到短信的人转交：
  // KWL_SMS_RELAY=file:<路径>（本机：人把验证码写进这个文件）或 gh-release:<owner/repo>:<tag>:<文件名>（CI：人把验证码作为预发布附件上传，凭 GITHUB_TOKEN 读取）
  const phoneInput = page.locator('input[type="tel"]');
  // 注册策略由云端 /v1/meta 异步取回后才决定是否显示手机号一栏：给了手机号就等它出现（旧云端或策略没开时 8 秒后照旧流程）
  if (process.env.KWL_PHONE) await phoneInput.first().waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
  if (await phoneInput.count()) {
    const phone = process.env.KWL_PHONE;
    if (!phone) throw new Error("云端要求手机号验证：请给 KWL_PHONE 与 KWL_SMS_RELAY");
    await phoneInput.fill(phone);
    const sendAt = Date.now();
    await page.locator("button").filter({ hasText: /^\s*获取验证码\s*$/ }).first().click();
    const hint = await until(async () => {
      const t = await text();
      const m = t.match(/验证码已发送到\s*\S+|测试环境：验证码是\s*\d+|验证码没有发出[^\n]*|发送太频繁[^\n]*/);
      return m ? m[0] : null;
    }, 30000, 500, "短信发送结果");
    log("短信：", hint.replace(/\d{4,}/g, "<码>"));
    if (/没有发出|太频繁/.test(hint)) throw new Error(`短信没有发出：${hint}`);
    let sms = (hint.match(/测试环境：验证码是\s*(\d+)/) ?? [])[1] ?? "";
    if (!sms) sms = await waitSmsCode(sendAt);
    await page.locator('input[autocomplete="one-time-code"]').fill(sms);
    log("已填入转交的短信验证码");
  }
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

/** 开通页上切到注册（第 64 批是表单下方的链接按钮，第 63 批及以前是页签）。 */
async function openRegister() {
  await authFormReady();
  const tab = page.getByRole("tab", { name: "注册", exact: true });
  if (await tab.count()) return tab.click();
  await page.locator('[data-auth-page="activate"] button.btn-link').filter({ hasText: /^\s*注册\s*$/ }).first().click();
}

/** 第 64 批：登录页先显示“正在取得登录方式”的骨架，取到才出表单；取不到会显示“暂时取不到登录方式”（如实失败，不再等到超时）。 */
async function authFormReady(ms = 60000) {
  await until(
    async () => {
      if (await page.locator(".auth-unavailable").count()) throw new Error(`登录页取不到登录方式：${mask(await page.locator(".auth-unavailable").innerText())}`);
      return (await page.locator('[data-auth-page] form, .auth-seg, .login-box').count()) > 0 && !(await page.locator(".auth-skeleton").count()) ? true : null;
    },
    ms,
    500,
    "登录表单",
  );
}

/** 开通页上回到登录（第 64 批：注册页的“已有账号？登录”；旧版本是页签）。 */
async function openLogin() {
  await authFormReady();
  const tab = page.getByRole("tab", { name: "登录", exact: true });
  if (await tab.count()) return tab.click();
  const back = page.locator('[data-auth-page="activate"] .auth-title-row button.btn-link').filter({ hasText: /^\s*登录\s*$/ });
  if (await back.count()) await back.first().click();
}

async function login() {
  const { KWL_EMAIL: email, KWL_PASSWORD: pw } = process.env;
  await ready();
  await openLogin();
  // 第 63 批：云端开了验证码登录时登录页缺省是“验证码登录”（或上次用过的方式）——密码登录要先切过去
  await sleep(1500);
  const pwTab = page.getByRole("tab", { name: "密码登录" });
  if (await pwTab.count()) await pwTab.click();
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').first().fill(pw);
  await page.locator('form button[type="submit"]:visible').filter({ hasText: /^\s*登录\s*$/ }).first().click();
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

/** 第 63 批：手机号验证码登录（开通页或已激活电脑的就地登录框）。 */
async function loginSms() {
  const phone = process.env.KWL_PHONE;
  if (!phone) throw new Error("login-sms 需要 KWL_PHONE 与 KWL_SMS_RELAY_LOGIN（或 KWL_SMS_RELAY）");
  await ready();
  // 第 64 批：开通页与整窗重新登录页都带 data-auth-page（旧版本开通页是“登录或注册”页签、重新登录在顶部横幅）
  const onActivate = (await page.locator('[data-auth-page="activate"]').count()) > 0 || (await page.getByRole("tablist", { name: "登录或注册" }).count()) > 0;
  const onRelogin = (await page.locator('[data-auth-page="relogin"]').count()) > 0;
  if (onActivate) await openLogin();
  else if (onRelogin) await authFormReady();
  else {
    // 就地登录框只在打开时取一次登录方式：先离开再回来，取到的是云端此刻的策略（例如断网恢复之后）
    await go("#/matters");
    await go("#/connections/account");
  }
  // 登录方式由云端 /v1/meta 异步取回后才出现
  const smsTab = page.getByRole("tab", { name: "验证码登录" });
  await smsTab.first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  if (!(await smsTab.count())) throw new Error("界面上没有“验证码登录”：云端没有开放验证码登录，或这台电脑还登录着");
  await smsTab.first().click();
  const tel = page.locator('input[type="tel"]:visible').first();
  await tel.fill(phone);
  const sendAt = Date.now();
  await page.locator("button:visible").filter({ hasText: /^\s*获取验证码\s*$/ }).first().click();
  const hint = await until(async () => {
    const t = await text();
    const m = t.match(/验证码已发送到\s*\S+|测试环境：验证码是\s*\d+|这个手机号还没有注册账号[^\n]*|手机号验证码登录暂未开放[^\n]*|短信服务暂时不可用[^\n]*|连不上中软服务[^\n]*|获取验证码过于频繁[^\n]*|验证码已发送，请 \d+ 秒后[^\n]*/);
    return m ? m[0] : null;
  }, 30000, 500, "短信发送结果");
  log("短信：", hint.replace(/\d{4,}/g, "<码>"));
  if (!/验证码已发送到|测试环境/.test(hint)) throw new Error(`验证码没有发出：${hint}`);
  let sms = (hint.match(/测试环境：验证码是\s*(\d+)/) ?? [])[1] ?? "";
  if (!sms) sms = await waitSmsCode(sendAt, process.env.KWL_SMS_RELAY_LOGIN || process.env.KWL_SMS_RELAY || "");
  await page.locator('input[autocomplete="one-time-code"]:visible').first().fill(sms);
  log("已填入转交的短信验证码");
  await shot("登录-验证码已填");
  // 开通页上“登录”既是外层分段（登录｜注册）也是提交按钮：只点表单里的提交按钮（第 63 批 Windows 运行 45427882175 点到了分段）
  await page.locator('form button[type="submit"]:visible').filter({ hasText: /^\s*登录\s*$/ }).first().click();
  const r = await until(
    async () => {
      const t = await text();
      if (/等待管理员批准|等待批准这台电脑/.test(t)) return "pending";
      if (/这台电脑暂时不能继续/.test(t)) return `blocked:${(await page.locator(".activate-error").first().textContent().catch(() => "")) ?? ""}`;
      // 先数再取（没有错误行时 textContent 会等满默认超时 20 秒）
      const al = page.locator('.activate-error[role="alert"]');
      const err = (await al.count()) ? await al.last().textContent().catch(() => null) : null;
      if (err && !/你已退出登录/.test(err)) return `error:${err}`;
      if (onActivate ? !/获取验证码/.test(t) && /事项|问答|开通的最后一步/.test(t) : !(await page.getByRole("tab", { name: "验证码登录" }).count()) && /已登录/.test(t)) return "in";
      return null;
    },
    180000,
    1000,
    "验证码登录结果",
  );
  log("验证码登录结果：", mask(r));
  if (r === "pending") {
    const check = (await page.locator('[aria-label="入组核对码"]').textContent()).trim();
    state.check_code = check;
    saveState();
    writeFileSync(join(OUT, "check-code.txt"), check + "\n");
    log("新电脑已提交入组申请，入组核对码：", check);
  }
  await shot(r === "pending" ? "登录-等待批准这台电脑" : "登录-验证码登录后");
  if (r.startsWith("error:") || r.startsWith("blocked:")) throw new Error(mask(r));
}

/** 第 63 批：退出登录（设置 · 账号），核对出现就地登录框。 */
async function logout() {
  await ready();
  await go("#/connections/account");
  await btnExact("退出登录").first().click();
  await page.getByRole("dialog").getByRole("button", { name: "退出登录" }).click();
  await until(async () => /你已退出登录/.test(await text()), 30000, 500, "退出登录");
  const st = await inv("account.status");
  log("退出后：", JSON.stringify(st.ok ? { logged_in: st.result.logged_in, login_required: st.result.login_required } : st));
  await shot("退出登录后");
}

/** 第 63 批：管理员电脑上批准新电脑的入组申请（按 KWL_CHECK_CODE 逐位核对，一致才批准）。 */
async function approveJoin() {
  const want = (process.env.KWL_CHECK_CODE || "").replace(/\s+/g, "");
  if (!/^\d{6,}$/.test(want)) throw new Error("approve-join 需要 KWL_CHECK_CODE（新电脑屏幕上的入组核对码）");
  await ready();
  // 成员与待批准申请在“设置 · 管理”（#/connections/admin，缺省子标签“成员”）
  await go("#/connections/admin");
  const row = await until(
    async () => {
      // 别的阶段（例如同时在跟的任务）可能把页面切走：每轮确认还在成员页
      if (!(await page.evaluate(() => location.hash)).startsWith("#/connections/admin")) await go("#/connections/admin");
      const membersTab = page.getByRole("tab", { name: "成员" });
      if ((await membersTab.count()) && (await membersTab.first().getAttribute("aria-selected")) !== "true") await membersTab.first().click();
      for (const tr of await page.locator("tr").all()) {
        const t = (await tr.innerText()).replace(/\s+/g, "");
        if (t.includes(want)) return tr;
      }
      return null;
    },
    10 * 60000,
    5000,
    "待批准申请（核对码一致）",
  );
  await shot("批准-待批准申请");
  await row.getByRole("button", { name: "批准" }).click();
  await page.getByRole("button", { name: "已核对一致，批准" }).click();
  await until(async () => /已批准/.test(await text()), 60000, 500, "批准结果");
  log("已批准入组申请（核对码逐位一致）");
  await shot("批准-已批准");
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
  // 新电脑入组后要等首次同步取得席位令牌才能发起任务（第 54 批 Windows 运行 44918571693：入组约 20 秒就发起，开始前确认提示
  // “席位令牌未取得或已失效（联网后自动续期）……补齐后才能发起”）；等到取得为止并记下用了多久
  const seatT0 = Date.now();
  try {
    await until(async () => {
      const r = await inv("control_plane.status", {});
      return r.ok && r.result?.seat?.has_token ? r.result : null;
    }, 5 * 60000, 2000, "席位令牌");
  } catch (e) {
    // 取不到席位令牌：把同步各步结果留作证据（第 54 批：本所席位用完时新电脑登记成功但没有席位）
    const st = await inv("control_plane.status", {});
    writeFileSync(join(OUT, "control-plane-status.json"), JSON.stringify(st.ok ? { seat: st.result.seat, last_sync: st.result.last_sync, alerts: st.result.alerts } : st, null, 1));
    throw e;
  }
  log(`席位令牌已取得（入组进入后约 ${Math.round((Date.now() - seatT0) / 1000)} 秒）`);
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
  // 第 51 批：第一次用 AI 先弹“开始用 AI 之前”的告知（给律师本人，一次）；点“我知道了，继续”后这次提问照常发出
  // （第 59 批 macOS 新管理员第一次问答停在这个框上）
  const notice = page.locator("[role=dialog] button").filter({ hasText: /^\s*我知道了，继续\s*$/ }).first();
  if (await notice.waitFor({ timeout: 4000 }).then(() => true).catch(() => false)) {
    await shot("qa-首次用AI告知");
    await notice.click();
    log("已确认“开始用 AI 之前”的告知");
  }
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
      // 回答还在生成：回答框带 aria-busy（流式正文很长时“正在撰写… 已用时”在正文上方，只看结尾会误判写完）
      const streaming = (await page.locator('main [aria-busy="true"]').count()) > 0;
      const waiting = streaming || /正在思考|正在回答|正在写|已用时/.test(t);
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
  // 客户授权（第 48 批 D-202：新建事项时的分段按钮；第 51 批 D-216 起改为每个事项第一次用 AI 时在“开始前确认”里逐案记录，
  // 新建事项不再问）：两种版本都认——有这组按钮就按“已取得”，没有就留到开始前确认那一步记录
  const authz = dlg.locator('[role=radiogroup][aria-label="客户是否同意使用 AI 辅助"] [role=radio]').filter({ hasText: /^\s*已取得\s*$/ });
  if (await authz.count()) await authz.click();
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
    // 第 55 批：字段外层由 <label> 改为 <div>（逐项请求一栏里有多个输入框与按钮）；两种都认
    const field = sp.locator(".ss-field").filter({ has: page.locator(".ss-label", { hasText: label }) }).first();
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
  for (let i = 0; i < 10 && !/#\/run\//.test(page.url()); i++) {
    await sleep(1500);
    const d2 = page.locator("[role=dialog]").last();
    if (await d2.count()) {
      // 第 51 批 D-216：本事项第一次用 AI——记录客户授权的依据与出处（本单材料是虚构案例，按“委托合同中的 AI 条款”记录）
      const record = d2.locator("button").filter({ hasText: /^\s*记录授权并开始\s*$/ }).first();
      if (await record.count()) {
        await d2.getByText("委托合同中的 AI 条款").first().click().catch(() => {});
        const ref = d2.locator('input[aria-label="授权依据的出处"]').first();
        if ((await ref.count()) && !(await ref.inputValue())) await ref.fill("委托代理合同（验收用虚构案例）第 9 条");
        await shot("12b-记录客户授权");
        await record.click().catch(() => {});
        continue;
      }
      // 第 51 批：首次使用 AI 的告知（给律师本人，一次）
      const notice = d2.locator("button").filter({ hasText: /^\s*我知道了，继续\s*$/ }).first();
      if (await notice.count()) {
        await notice.click().catch(() => {});
        continue;
      }
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
        // 第 62 批：一张提问卡可能有多道题（如“论点确认”+“财产保全”），每组单选都要有选择，否则“确定”不可点、驱动原地打转
        for (const g of await main.locator("[role=radiogroup]").all()) {
          if (await g.locator('[role=radio][aria-checked="true"]').count()) continue;
          const first = g.locator("[role=radio]").first();
          if (!(await first.count())) continue;
          await first.click().catch(() => {});
          log("同卡另一题未预设，选第一项：", (await first.innerText().catch(() => "")).slice(0, 60));
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
  state.run_hash = await page.evaluate(() => location.hash);
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
    // 也认“下载”：macOS 上由人点“存储”时，“文稿”里已有同名文件（律师自己的）就请他改存到“下载”，不覆盖别人的文件（第 59 批）
    const defaults = process.platform === "darwin" || process.platform === "win32" ? ["Documents", "Downloads"].map((d) => join(homedir(), d, basename(target))) : [];
    const befores = defaults.map((p) => (existsSync(p) ? statSync(p).mtimeMs : 0));
    const fresh = (p, b) => existsSync(p) && statSync(p).mtimeMs !== b && statSync(p).size > 0;
    const freshDefault = () => defaults.find((p, i) => fresh(p, befores[i])) ?? null;
    const waitMin = Number(process.env.KWL_SAVE_WAIT_MIN || 5);
    const ok = await until(async () => fresh(target, before) || Boolean(freshDefault()), waitMin * 60000, 1000, `保存 ${a.filename}`).catch((e) => (log(String(e)), false));
    if (ok && !fresh(target, before)) {
      await sleep(1500);
      const got = freshDefault();
      copyFileSync(got, target);
      log("已存到对话框缺省位置（文档 / 文稿 / 下载），复制进证据目录：", basename(target), "←", got);
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

/** 第 62 批：每份 Office 成果（含旧版本）在复核页预览，再到任务页右栏看缺省选中的那份；任何一处没出图即失败。 */
async function preview() {
  if (!state.artifacts?.length) throw new Error("没有上一个任务的成果（先跑 task）");
  const office = state.artifacts.filter((x) => /\.(docx|xlsx)$/i.test(x.filename));
  const results = [];
  for (const a of office) {
    await go(`#/review/${a.id}`);
    results.push(await framePainted(`复核页-${a.filename}-v${a.version ?? "?"}`).catch((e) => ({ label: a.filename, ok: false, dark: 0, why: e.message })));
    log(JSON.stringify(results[results.length - 1]));
  }
  const runHash = state.run_hash ?? (state.run_id && state.matter_id ? `#/run/${state.run_id}/${state.matter_id}` : null);
  if (runHash) {
    await go(runHash);
    await sleep(3000);
    // 合同审查一类任务右栏缺省是“审查摘要”页签：先切到“成果”再看预览
    // 右栏页签是 .exec-right .tabs 里的普通按钮（不是 role=tab）；风险卡晚到时界面会自动切到“审查摘要”，所以等按钮出现再点、点完核对
    const tab = page.locator(".exec-right .tabs button").filter({ hasText: /^\s*成果(\s*\d+)?\s*$/ });
    await tab.first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    for (let i = 0; i < 3 && (await tab.count()); i++) {
      await tab.first().click().catch(() => {});
      await sleep(1200);
      if (/\bactive\b/.test((await tab.first().getAttribute("class")) ?? "")) break;
    }
    await sleep(1500);
    results.push(await framePainted("任务页右栏-缺省选中").catch((e) => ({ label: "任务页右栏", ok: false, dark: 0, why: e.message })));
    log(JSON.stringify(results[results.length - 1]));
    // 右栏下拉里逐个切换（版本切换时预览要跟着换、不残留上一份）
    // 自绘下拉（components/Select.tsx，listbox 语义、键盘可用）：用键盘逐项选，避开列表滚动与遮挡
    const trigger = page.locator(".artifact-select").first();
    const n = await page.evaluate(() => document.querySelectorAll(".artifact-select").length);
    if (n > 0) {
      await trigger.click();
      const opts = await page.locator('[role="option"]').allInnerTexts();
      await page.keyboard.press("Escape");
      for (let i = 0; i < opts.length; i++) {
        if (!/\.(docx|xlsx)|Word|Excel|起诉状|律师函|意见|修订|清单|目录|备忘录|申请书|明细/.test(opts[i])) continue;
        await trigger.focus();
        await page.keyboard.press("Enter");
        await sleep(300);
        await page.keyboard.press("Home");
        for (let k = 0; k < i; k++) await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
        results.push(await framePainted(`任务页右栏-${opts[i].slice(0, 24)}`).catch((e) => ({ label: opts[i], ok: false, dark: 0, why: e.message })));
        log(JSON.stringify(results[results.length - 1]));
      }
    }
  }
  writeFileSync(join(OUT, "preview-check.json"), JSON.stringify(results, null, 1));
  const bad = results.filter((r) => !r.ok);
  log(`预览核对：${results.length - bad.length}/${results.length} 出图`);
  if (bad.length) throw new Error(`预览没出图：${bad.map((b) => b.label).join("；")}`);
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
const phases = { ready, register, login, "login-sms": loginSms, logout, "approve-join": approveJoin, "await-approval": awaitApproval, diagnose, qa, task, export: exportAll, preview, usage, shot: (n) => shot(n ?? "shot") };
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
