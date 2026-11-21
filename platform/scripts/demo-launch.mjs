#!/usr/bin/env node
/**
 * 一键演示拉起（本地部署模拟）：真实 API（从 Word 交付文件读取，只进内存不落盘不打印）→ 云端（scripts/stack-local.mjs：生产入口
 * cloud-serve 拉起签名服务、控制面、网关、检索，网关直连真实上游）→ 统一云端控制台（stack-local 同进程发的静态页）→ Electron 桌面窗口。
 *
 *   node scripts/demo-launch.mjs [--docx <path>] [--fresh] [--no-browser] [--no-desktop] [--base-port 18400]
 *
 * - API 密钥存放：macOS 钥匙串（服务名 kwl-demo-maas-key，与 ~/Library/Application Support/KimiWorkLegal-Demo/start-demo.mjs 同一约定）；
 *   docx 交付文件（`Base url:` / `Key:` / `Model id=` 三行）在钥匙串为空或密钥不一致时自动灌入更新。密钥只经环境变量交给 stack-local，
 *   stack-local 再只经文件描述符交给网关进程；不落盘、不打印。
 * - 控制台账号（第 46 批）：不再用 ops-cli 名册与密码。stack-local 按契约 §2.4 用控制面写出的设置码设好系统管理员密码，
 *   登录信息在 platform/output/demo-cloud/stack/console-login.txt（0600），本脚本每次拉起都打印；平台人员登录只要账号密码。
 * - 状态都在 platform/output/demo-cloud/stack/（git 忽略），跨重启保留。
 * - --fresh：清空演示状态（控制面与各服务数据、控制台登录信息；密钥与桌面工作区不动），下次拉起重新引导系统管理员。
 */
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const out = join(root, "output", "demo-cloud");
const opsDir = join(out, "ops");
const argv = process.argv.slice(2);
const flag = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const docxPath = resolve(flag("docx") ?? join(homedir(), "Documents", "test.docx"));
const basePort = Number(flag("base-port") ?? 18400);
const stackDir = join(out, "stack");
const fresh = argv.includes("--fresh");
const noBrowser = argv.includes("--no-browser");
const noDesktop = argv.includes("--no-desktop");

const log = (m) => console.log(`[demo] ${m}`);
const fail = (m) => {
  console.error(`[demo] ${m}`);
  process.exit(1);
};
if (!existsSync(docxPath)) fail(`找不到 API 交付文件：${docxPath}`);

mkdirSync(out, { recursive: true });
if (fresh) {
  for (const p of ["data", "console-login.txt", "console-dist"]) {
    const d = join(stackDir, p);
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
  log("--fresh：已清空云端数据与控制台登录信息（下次拉起重新引导系统管理员）");
}

/* ---------- ① API 配置：密钥以 macOS 钥匙串为准（本机演示约定，服务名 kwl-demo-maas-key）；
   docx 交付文件只在钥匙串为空或密钥不一致时灌入/更新（--no-keychain-sync 跳过同步）。密钥全程不落盘、不打印 ---------- */
const DOCX_READER = `
import json, re, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    xml = z.read("word/document.xml").decode("utf-8")
# 段落/表格单元格/换行先落成换行分隔，再剥标签（否则相邻单元格文本会粘连）
text = re.sub(r"</w:p>|</w:tc>|<w:br[^>]*/>", "\\n", xml)
text = re.sub(r"<[^>]+>", "", text)
def find(pat):
    m = re.search(pat, text, re.I)
    return m.group(1).strip() if m else None
cfg = {
    "base": find(r"Base\\s*url\\s*[:：]\\s*(https?://\\S+)") or find(r"(https?://\\S+/v\\d+)"),
    "key": find(r"\\b(sk-[A-Za-z0-9_-]{10,})\\b"),
    "model": find(r"Model\\s*id\\s*[=:]\\s*(\\S+)") or find(r"模型\\s*[=:]\\s*(\\S+)"),
}
print(json.dumps(cfg))
`;
const readDocx = () => {
  try {
    return JSON.parse(execFileSync("python3", ["-I", "-", docxPath], { input: DOCX_READER, encoding: "utf8" }).trim());
  } catch {
    return null;
  }
};
const readKeychain = () => {
  try {
    return execFileSync("/usr/bin/security", ["find-generic-password", "-a", "kwl-demo", "-s", "kwl-demo-maas-key", "-w"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};
const writeKeychain = (key) => execFileSync("/usr/bin/security", ["add-generic-password", "-U", "-a", "kwl-demo", "-s", "kwl-demo-maas-key", "-w", key], { stdio: ["ignore", "ignore", "ignore"] });
const fp = (s) => createHash("sha256").update(s).digest("hex").slice(0, 8);
const docx = existsSync(docxPath) ? readDocx() : null;
let keychainKey = readKeychain();
if (!docx && !keychainKey) fail(`既没有钥匙串密钥（kwl-demo-maas-key），也读不到交付文件：${docxPath}`);
let key = keychainKey;
if (docx?.key && !argv.includes("--no-keychain-sync") && docx.key !== keychainKey) {
  writeKeychain(docx.key);
  key = docx.key;
  log(`钥匙串密钥已按交付文件更新（sha256 ${fp(docx.key)}，明文不打印）`);
}
if (!key) key = docx?.key;
const api = { base: docx?.base ?? "https://maas.jointpilot.com/v1", model: docx?.model ?? "kimi-k3.1-pro", key };
log(`API 配置：base=${api.base} model=${api.model} key=sk-…${api.key.slice(-4)}（sha256 ${fp(api.key)}；存于钥匙串 kwl-demo-maas-key）`);

/* ---------- ②③ 云端（stack-local：生产入口 + 真实上游；控制台账号按契约 §2.4 引导） ---------- */
const children = [];
const cloud = spawn(process.execPath, [join(root, "scripts", "stack-local.mjs"), "--dir", stackDir, "--base-port", String(basePort), "--upstream", api.base, "--model", api.model], {
  cwd: root,
  env: { ...process.env, KWL_MOONSHOT_API_KEY: api.key },
  stdio: ["ignore", "pipe", "inherit"],
});
children.push(cloud);
let consoleUrl = null;
let loginFile = null;
let cloudReady = false;
let cloudDead = null;
let buf = "";
cloud.stdout.setEncoding("utf8");
cloud.stdout.on("data", (chunk) => {
  process.stdout.write(chunk.replace(/^/gm, "[cloud] ").replace(/\[cloud\] $/, ""));
  buf += chunk;
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    const c = /控制台 (http:\/\/127\.0\.0\.1:\d+\/)/.exec(line);
    if (c) consoleUrl = c[1];
    const l = /^\[stack\] 控制台账号：(.+)$/.exec(line);
    if (l) {
      loginFile = l[1].trim();
      cloudReady = true;
    }
  }
});
cloud.on("error", (e) => (cloudDead = e.message));
cloud.on("exit", (c) => (cloudDead = `云端退出（code ${c}），日志见 ${join(stackDir, "logs")}`));
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("云端启动超时（120 秒）")), 120_000);
  const poll = setInterval(() => {
    if (cloudDead || cloudReady) {
      clearTimeout(t);
      clearInterval(poll);
      return cloudDead ? rej(new Error(cloudDead)) : res();
    }
  }, 100);
}).catch((e) => fail(e.message));
// 桌面端环境变量：stack-local 写的 client.env（控制面、网关、检索地址与公钥）
const zrEnv = Object.fromEntries(
  readFileSync(join(stackDir, "client.env"), "utf8")
    .split("\n")
    .map((l) => /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
if (!zrEnv.ZR_GATEWAY_BASE || !zrEnv.ZR_CONTROL_PLANE_BASE) fail("client.env 里缺 ZR_GATEWAY_BASE / ZR_CONTROL_PLANE_BASE");
const login = existsSync(loginFile ?? "") ? Object.fromEntries([...readFileSync(loginFile, "utf8").matchAll(/^(url|email|password):\s*(\S+)/gm)].map((m) => [m[1], m[2]])) : {};
consoleUrl = consoleUrl ?? login.url ?? `http://127.0.0.1:${basePort + 3}/`;

/* 开发端口占用时自动错开（KWL_DEV_WEB_PORT / ZR_DEV_BRIDGE_PORT 既有约定；如另一会话正占 5173/7720） */
const isFree = (port) =>
  new Promise((r) => {
    const s = createServer();
    s.once("error", () => r(false));
    s.once("listening", () => s.close(() => r(true)));
    s.listen(port, "127.0.0.1");
  });
const pickPort = async (base, fallbacks) => {
  for (const p of [base, ...fallbacks]) if (await isFree(p)) return p;
  return fail(`没有可用开发端口：${[base, ...fallbacks].join(", ")}`);
};
const webPort = Number(flag("web-port") ?? process.env.KWL_DEV_WEB_PORT ?? (await pickPort(5173, [5175, 5176, 5177])));
const bridgePort = Number(process.env.ZR_DEV_BRIDGE_PORT ?? (await pickPort(7720, [7721, 7722, 7723])));
if (webPort !== 5173 || bridgePort !== 7720) log(`开发端口错开：vite :${webPort} / 开发桥 :${bridgePort}`);

/* ---------- ④⑤ 控制台已由 stack-local 发出；自检：GET /v1/meta（无鉴权） ---------- */
log(`统一云端控制台已就绪：${consoleUrl}`);
try {
  const m = await (await fetch(`${zrEnv.ZR_CONTROL_PLANE_BASE}/v1/meta`)).json();
  log(`控制面自检通过（${m.api ?? "?"}，注册方式 ${m.registration ?? "?"}）`);
} catch (e) {
  log(`控制面自检失败（不影响其余部分）：${String(e.message).slice(0, 200)}`);
}

/* ---------- ⑥ Electron 桌面（窗口化法律版；不启动开发桥——演示工作区库为页级加密，纯 Node 桥打不开） ---------- */
// 沿用既有演示工作区（若在）：保留已建事项、材料与律所密钥；可用 KWL_DEMO_DATA_DIR / --data-dir 覆盖
const defaultDataDir = join(homedir(), "Library", "Application Support", "KimiWorkLegal-Demo", "desktop-data");
const dataDir = flag("data-dir") ?? process.env.KWL_DEMO_DATA_DIR ?? (existsSync(defaultDataDir) ? defaultDataDir : undefined);
if (!noDesktop) {
  const D = join(root, "apps", "desktop");
  const desktopEnv = {
    ...process.env,
    ...zrEnv,
    ZR_FIRM_SLUG: process.env.ZR_FIRM_SLUG ?? "demo-firm",
    ZR_USER_SLUG: process.env.ZR_USER_SLUG ?? "demo-lawyer",
    ZR_MODEL_PROVIDER: "upstream",
    ZR_INTERNAL_SECRET: process.env.ZR_INTERNAL_SECRET ?? randomBytes(24).toString("base64url"),
    ZR_BACKUP_TIMER: process.env.ZR_BACKUP_TIMER ?? "off",
    // 演示示例事项（第 45 批 D-190）：正式安装包永远不放；客户演示缺省放入两件虚构示例，想按正式产品的样子演示时设 ZR_DEMO_SAMPLES=0
    ZR_DEMO_SAMPLES: process.env.ZR_DEMO_SAMPLES ?? "1",
    KWL_DEV_WEB_PORT: String(webPort),
    ZR_DEV_BRIDGE_PORT: String(bridgePort),
    ...(dataDir ? { ZR_KERNEL_DATA_DIR: dataDir } : {}),
  };
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
  // vite 开发页（渲染进程从这里加载）
  const vite = spawn(npxCmd, ["vite", "--port", String(webPort), "--strictPort", "--host", "127.0.0.1"], { cwd: D, env: desktopEnv, stdio: "inherit" });
  children.push(vite);
  // 内核单文件制品按当前源码重建一次（幂等；随后 Electron 以 utilityProcess 内嵌内核）
  await new Promise((res, rej) => {
    const bk = spawn(npmCmd, ["run", "build:kernel"], { cwd: D, env: desktopEnv, stdio: "inherit" });
    bk.on("error", rej);
    bk.on("exit", (c) => (c === 0 ? res() : rej(new Error(`build:kernel 失败（code ${c}）`))));
  }).catch((e) => fail(e.message));
  // 等 vite 就绪再开窗口
  const webUrl = `http://127.0.0.1:${webPort}/`;
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(webUrl)).ok) break;
    } catch {}
    if (i === 119) fail("vite 开发页没有就绪");
    await new Promise((r) => setTimeout(r, 500));
  }
  const electronBin = join(root, "node_modules", ".bin", "electron");
  const electron = spawn(electronBin, ["."], { cwd: D, env: desktopEnv, stdio: "inherit" });
  children.push(electron);
  log(`桌面窗口已拉起（开发页 :${webPort}，工作区 ${dataDir ?? "（缺省）"}）`);
}

/* ---------- ⑦ 打开控制台 + 演示说明 ---------- */
if (!noBrowser) {
  try {
    execFileSync("open", [consoleUrl], { stdio: "ignore" });
  } catch {
    /* 非 macOS 忽略 */
  }
}
console.log(`
==================== 演示环境已拉起 ====================
云端（本机模拟部署，真实上游 ${api.base} · 模型 ${api.model}）
  法律模型网关   ${zrEnv.ZR_GATEWAY_BASE}
  控制面         ${zrEnv.ZR_CONTROL_PLANE_BASE}
统一云端控制台（浏览器）
  地址           ${consoleUrl}
  系统管理员     ${login.email ?? "（见登录信息文件）"}
  密码           ${login.password ?? "（已改过或未引导：删掉登录信息文件并用 --fresh 重新引导）"}
  登录信息       ${loginFile ?? join(stackDir, "console-login.txt")}（0600）
桌面端
  Electron 窗口（律所标识 demo-firm，席位令牌经控制面签发${dataDir ? `；工作区 ${dataDir}` : ""}）
日志与状态：${out}（git 已忽略）
停止：Ctrl-C（一并退出云端与桌面）
========================================================`);

const stop = () => {
  for (const c of children) {
    try {
      c.kill("SIGINT");
    } catch {}
  }
  setTimeout(() => process.exit(0), 500);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
cloud.on("exit", () => {
  log("云端已退出");
  stop();
});
await new Promise(() => {});
