/**
 * 第 64 批：无边框窗口、登录页三态与整窗重新登录、Windows 首启“验证码登录迟到”的根因修复。
 * - 运行时核对先核闸门闭包（它自己的 Node 与入口），通过即放行闸门；全部文件随后照常核对、不符照旧关闭（main.cjs / runtime-paths.cjs）；
 * - 窗口：macOS 红绿灯、Windows 窗口控件浮层（颜色等于令牌、随明暗换色）；界面打 frameless / plat-* 类；
 * - 登录页：取策略三态（骨架 / 原因 + 重试 / 表单），取不到不冒充旧云端；退出登录、登录失效 → 整窗重新登录页（不渲染工作区）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyWindowChrome } from "../src/lib/window-chrome.ts";
import { reloginView } from "../src/lib/account.ts";

const require = createRequire(import.meta.url);
const { verifyRuntimeDigests, gateClosure } = require("../electron/runtime-paths.cjs");
const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const TOKENS = readFileSync(new URL("../../../packages/design-tokens/src/tokens.css", import.meta.url), "utf8");
function tokenValue(name: string, theme: "light" | "dark" = "light"): string {
  const at = TOKENS.indexOf('\n:root[data-theme="dark"]');
  const block = theme === "dark" ? TOKENS.slice(at) : TOKENS.slice(0, at);
  const v = new RegExp(`${name}:\\s*([^;]+);`).exec(block)![1]!.trim();
  const ref = /^var\((--[a-z0-9-]+)\)$/.exec(v);
  return (ref ? tokenValue(ref[1]!, "light") : v).toLowerCase();
}

function fakeRuntime(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "kwl-b64-rt-"));
  const all: { path: string; sha256: string; size: number }[] = [];
  for (const [p, body] of Object.entries(files)) {
    const abs = join(root, ...p.split("/"));
    require("node:fs").mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
    all.push({ path: p, sha256: createHash("sha256").update(body).digest("hex"), size: Buffer.byteLength(body) });
  }
  return { root, manifest: { format: "kwl-runtime/1", files: { gate: { path: "egress-gate/main.mjs" }, nodeEgress: { path: "node/kwl-egress.exe" }, node: { path: "node/node.exe" } }, all } };
}

test("运行时核对：闸门闭包排在最前、核完即放行（onFirst）；其余文件照常核对；闭包里有不符不放行", async () => {
  const { root, manifest } = fakeRuntime({ "parse/a.dll": "A", "node/node.exe": "N", "egress-gate/main.mjs": "G", "node/kwl-egress.exe": "E", "w/x.mjs": "W" });
  assert.deepEqual(gateClosure(manifest).sort(), ["egress-gate/main.mjs", "node/kwl-egress.exe"]);
  const order: string[] = [];
  let firstAt = -1;
  const fs = require("node:fs");
  const orig = fs.createReadStream;
  fs.createReadStream = (p: string, o: unknown) => (order.push(p.slice(root.length + 1).replace(/\\/g, "/")), orig(p, o));
  try {
    const problems = await verifyRuntimeDigests(root, manifest, { first: gateClosure(manifest), onFirst: () => (firstAt = order.length) });
    assert.deepEqual(problems, []);
  } finally {
    fs.createReadStream = orig;
  }
  assert.deepEqual(order.slice(0, 2).sort(), ["egress-gate/main.mjs", "node/kwl-egress.exe"], "闸门闭包先核");
  assert.equal(firstAt, 2, "闭包核完立刻放行，不等其余文件");
  assert.equal(order.length, 5, "其余文件照常核对");
  // 闭包里的文件被改：不放行，问题照报
  writeFileSync(join(root, "egress-gate", "main.mjs"), "X");
  let fired = false;
  const p2 = await verifyRuntimeDigests(root, manifest, { first: gateClosure(manifest), onFirst: () => (fired = true) });
  assert.equal(fired, false);
  assert.match(p2.join(";"), /摘要不符：egress-gate\/main\.mjs/);
});

test("主进程：先放行闸门（scope gate）再全量；记录核对耗时；窗口无边框且控件浮层颜色等于令牌", () => {
  const main = src("electron/main.cjs");
  assert.match(main, /verifyRuntimeDigests\(path\.join\(process\.resourcesPath, "runtime"\), manifest, \{\s*first,\s*onFirst: \(\) => \{\s*gateVerifiedOk = true;/);
  assert.match(main, /else if \(gateVerifiedOk\) kernel\.postMessage\(\{ type: "kernel\.runtime_verified", scope: "gate" \}\);/);
  assert.match(main, /slog\.event\("MAIN_RUNTIME_VERIFIED", \{ scope: "gate"/);
  assert.match(main, /if \(process\.platform === "darwin"\) return \{ titleBarStyle: "hidden", trafficLightPosition: \{ x: 18, y: 14 \} \};/);
  assert.match(main, /if \(process\.platform === "win32"\) return \{ titleBarStyle: "hidden", titleBarOverlay: \{ \.\.\.WINDOW_CHROME\[dark \? "dark" : "light"\], height: TITLEBAR_HEIGHT \} \};/);
  const chrome = /const WINDOW_CHROME = \{ light: \{ color: "(#[0-9a-f]{6})", symbolColor: "(#[0-9a-f]{6})" \}, dark: \{ color: "(#[0-9a-f]{6})", symbolColor: "(#[0-9a-f]{6})" \} \};/i.exec(main);
  assert.ok(chrome, "浮层颜色常量写法变了，请同步本用例");
  assert.deepEqual(chrome!.slice(1).map((x) => x.toLowerCase()), [tokenValue("--bg-sidebar"), tokenValue("--text-primary"), tokenValue("--bg-sidebar", "dark"), tokenValue("--text-primary", "dark")]);
  // 换色只认应用主框架、只认 light / dark
  assert.match(main, /ipcMain\.on\("kwl:window-theme", \(e, theme\) => \{\s*if \(!fromAppMainFrame\(e\) \|\| \(theme !== "light" && theme !== "dark"\)/);
  assert.match(src("electron/preload.cjs"), /setWindowTheme: \(theme\) => ipcRenderer\.send\("kwl:window-theme", theme === "dark" \? "dark" : "light"\)/);
});

test("界面：无边框类名与平台类、明暗变化通知主进程（只在桌面端）", () => {
  const sent: string[] = [];
  const classes = new Set<string>();
  const doc = { documentElement: { classList: { add: (...c: string[]) => c.forEach((x) => classes.add(x)) }, dataset: { theme: "dark" } } } as unknown as Document;
  const g = globalThis as { MutationObserver?: unknown };
  const prev = g.MutationObserver;
  g.MutationObserver = class {
    observe() {}
  };
  try {
    applyWindowChrome({ zrKernel: { frameless: true, platform: "win32", setWindowTheme: (t) => sent.push(t) } }, doc);
    assert.deepEqual([...classes].sort(), ["frameless", "plat-win32"]);
    assert.deepEqual(sent, ["dark"]);
    classes.clear();
    applyWindowChrome({}, doc);
    assert.equal(classes.size, 0, "网页开发形态什么都不做");
  } finally {
    g.MutationObserver = prev;
  }
  const css = src("src/styles-window.css");
  assert.match(css, /html\.frameless \.shell \{ -webkit-app-region: drag; \}/);
  assert.match(css, /html\.frameless \.shell-main \{ -webkit-app-region: no-drag; margin-top: 40px; \}/);
  assert.match(css, /html\.frameless \.modal-mask, html\.frameless \.guide-layer, html\.frameless \.select-list \{ -webkit-app-region: no-drag; \}/, "弹层不可拖动");
  assert.match(src("src/styles-auth.css"), /\.auth-page \.auth-card \{ -webkit-app-region: no-drag; \}/);
});

test("登录页三态：取到才渲染表单；取不到说原因 + 重试 + 退避自动再试；不再冒充旧云端", () => {
  const sms = src("src/components/SmsCodeFields.tsx");
  assert.match(sms, /export type MetaState =\s*\| \{ status: "loading"; attempt: number \}\s*\| \{ status: "ready"; meta: RegistrationMeta \}\s*\| \{ status: "error"/);
  assert.doesNotMatch(sms, /setMeta\(\{ legacy: true \}\)/);
  const shell = src("src/components/AuthShell.tsx");
  assert.match(shell, /if \(state\.status === "ready"\) return <>\{children\(state\.meta\)\}<\/>;/);
  assert.match(shell, /暂时取不到登录方式/);
  assert.match(shell, /秒后自动再试/);
  const act = src("src/pages/Activate.tsx");
  for (const v of ["LoginForm", "RegisterForm", "ForgotPassword"]) assert.match(act, new RegExp(`<MetaGate state=\\{metaState\\}>[\\s\\S]{0,80}<${v}`), v);
});

test("整窗重新登录：标题按原因、可见“你已退出登录”；工作区不渲染；首帧不露工作区；登录后回原页", () => {
  assert.equal(reloginView("session_required").title, "你已退出登录");
  assert.equal(reloginView("account_disabled").title, "账号已停用");
  assert.equal(reloginView("session_member_mismatch").title, "请用这台电脑登记的成员登录");
  assert.equal(reloginView("session_expired").title, "登录已失效");
  for (const r of [null, "session_expired", "session_required", "account_disabled", "session_member_mismatch"]) assert.match(reloginView(r).lead, /事项、材料和成果都还在/);
  const app = src("src/App.tsx");
  assert.match(app, /if \(login\)\s*return \(\s*<>\s*<ReloginPage/, "要重新登录时整页换成重新登录页");
  assert.ok(app.indexOf("<ReloginPage") < app.indexOf('<div className="shell">'), "在工作区之前返回");
  assert.doesNotMatch(app, /login-banner/);
  assert.match(app, /setLogin\(needsLogin\(st\) \?[\s\S]{0,200}\);\s*setBoot\(\{/, "登录状态与启动状态同一次渲染生效");
  assert.match(app, /onboardingRef\.current = boot === null \|\| !!boot\.onboarding \|\| !!login;/, "登录页期间快捷键、搜索、指南不响应");
  const relogin = src("src/pages/Relogin.tsx");
  assert.match(relogin, /<AuthPage kind="relogin">/);
  assert.match(relogin, /<LoginBox page email=\{p\.email\} onDone=\{p\.onDone\} \/>/);
  assert.doesNotMatch(relogin.replace(/\/\*[\s\S]*?\*\//g, ""), /register|注册/i, "重新登录页不能注册新账号");
});
