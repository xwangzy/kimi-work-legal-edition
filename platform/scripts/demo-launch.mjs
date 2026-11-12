#!/usr/bin/env node
/**
 * 一键演示拉起（本地部署模拟）：真实 API（从 Word 交付文件读取，只进内存不落盘不打印）→ 云端 v0（控制面 + 法律模型网关 + 检索，
 * 网关直连真实上游）→ 网页运营控制台（apps/ops-console 静态页 + 同源 /v1 代理，免 CORS）→ Electron 桌面窗口。
 *
 *   node scripts/demo-launch.mjs [--docx <path>] [--fresh] [--no-browser] [--no-desktop] [--console-port 8790]
 *
 * - API 密钥存放：macOS 钥匙串（服务名 kwl-demo-maas-key，与 ~/Library/Application Support/KimiWorkLegal-Demo/start-demo.mjs 同一约定）；
 *   docx 交付文件（`Base url:` / `Key:` / `Model id=` 三行）在钥匙串为空或密钥不一致时自动灌入更新。密钥只进云端子进程环境变量，不落盘、不打印。
 * - 运营身份（一次性生成，platform/output/demo-cloud/ops/，git 忽略）：安全管理员名册签名密钥 + 运营名册 + 运营 op_0001 私钥
 *   （演示用、无口令）。名册有效期至多 31 天，过期后运营接口 503：`node scripts/ops-cli.mjs roster renew --roster … --sign-key …
 *   --sign-kid sec-1 --out …` 重签即可。
 * - 控制面状态持久化（platform/output/demo-cloud/cp-state.json）：租户与律所登记跨重启保留；开发形态控制面签名密钥每次运行新生成，
 *   本脚本每次把新的公钥随环境变量交给桌面端（即文档所述“重启后客户端须重新取回签名文档”）。
 * - --fresh：清空演示状态（控制面状态与云端数据目录；运营身份与桌面工作区不动）。
 */
import { execFileSync, spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const consolePort = Number(flag("console-port") ?? 8790);
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
  for (const p of ["cp-state.json", "cp-state.json.audit.jsonl", "cloud-data"]) {
    const d = join(out, p);
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
  log("--fresh：已清空控制面状态与云端数据目录");
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

/* ---------- ② 运营身份（一次性；platform/output/demo-cloud/ops/，不入仓） ---------- */
const opsCli = (args) => execFileSync(process.execPath, [join(root, "scripts", "ops-cli.mjs"), ...args], { cwd: root, encoding: "utf8" });
const secKey = join(opsDir, "offline", "sec-1.key.pem");
const rosterFile = join(opsDir, "ops-roster.json");
const rosterKeysFile = join(opsDir, "ops-roster-keys.json");
const opKeyFile = join(opsDir, "op", "op_0001.k1.key.pem");
const doneMarker = join(opsDir, ".demo-setup-done");
if (!existsSync(doneMarker)) {
  if (!existsSync(rosterKeysFile)) {
    opsCli(["roster-keygen", "--kid", "sec-1", "--out", join(opsDir, "offline"), "--keys-file", rosterKeysFile]);
    log("运营名册签名密钥已生成（演示用；生产应离线保管）");
  }
  if (!existsSync(rosterFile)) opsCli(["roster", "init", "--deployment", "dev", "--sign-key", secKey, "--sign-kid", "sec-1", "--out", rosterFile]);
  if (!existsSync(opKeyFile)) {
    const kg = JSON.parse(opsCli(["keygen", "--id", "op_0001", "--kid", "k1", "--out", join(opsDir, "op")]));
    opsCli(["roster", "add", "--roster", rosterFile, "--id", "op_0001", "--perms", "tenant.read,tenant.manage,quota.manage,quota.cap,tenant.terminate", "--pub", join(opsDir, "op", "op_0001.k1.pub.pem"), "--fingerprint", kg.fingerprint, "--sign-key", secKey, "--sign-kid", "sec-1", "--out", rosterFile]);
    log(`运营身份已生成：op_0001 / k1（指纹 ${kg.fingerprint}）`);
  }
  writeFileSync(doneMarker, new Date().toISOString() + "\n", { mode: 0o600 });
} else {
  log("运营身份已存在，跳过生成");
}

/* ---------- ③ 云端 v0（控制面 + 网关 + 检索；真实上游） ---------- */
const cloudEnv = {
  ...process.env,
  KWL_CONTROL_PLANE: "1",
  KWL_CP_STATE_FILE: join(out, "cp-state.json"),
  KWL_CLOUD_DIR: join(out, "cloud-data"),
  KWL_MOONSHOT_API_KEY: api.key,
  KWL_MOONSHOT_BASE: api.base,
  KWL_UPSTREAM_K3: api.model,
  KWL_OPS_ROSTER: rosterFile,
  KWL_OPS_ROSTER_KEYS: rosterKeysFile,
  KWL_OPS_DEPLOYMENT: "dev",
};
const children = [];
const cloud = spawn(process.execPath, [join(root, "scripts", "dev-cloud-v0.mjs")], { cwd: root, env: cloudEnv, stdio: ["ignore", "pipe", "inherit"] });
children.push(cloud);
const zrEnv = {};
let cloudReady = false;
let cloudDead = null;
let buf = "";
cloud.stdout.setEncoding("utf8");
cloud.stdout.on("data", (chunk) => {
  process.stdout.write(`[cloud] ${chunk}`);
  buf += chunk;
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    const m = line.match(/^export ([A-Z_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (/^'.*'$/.test(v) || /^".*"$/.test(v)) v = v.slice(1, -1);
    zrEnv[m[1]] = v;
  }
  if (buf.includes("云端 v0 已启动") || lines.some((l) => l.includes("云端 v0 已启动"))) cloudReady = true;
});
cloud.on("error", (e) => (cloudDead = e.message));
cloud.on("exit", (c) => (cloudDead = `云端 v0 退出（code ${c}）`));
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("云端 v0 启动超时（60 秒）")), 60_000);
  const poll = setInterval(() => {
    if (cloudDead) {
      clearTimeout(t);
      clearInterval(poll);
      return rej(new Error(cloudDead));
    }
    if (cloudReady) {
      clearTimeout(t);
      clearInterval(poll);
      res();
    }
  }, 100);
}).catch((e) => fail(e.message));
if (!zrEnv.ZR_GATEWAY_BASE || !zrEnv.ZR_CONTROL_PLANE_BASE) fail("云端输出里缺 ZR_GATEWAY_BASE / ZR_CONTROL_PLANE_BASE");
const cpUrl = new URL(zrEnv.ZR_CONTROL_PLANE_BASE);

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

/* ---------- ④ 运营控制台静态页 + 同源 /v1 代理（免 CORS） ---------- */
const consoleFiles = { "/": "index.html", "/index.html": "index.html", "/console.js": "console.js", "/console.css": "console.css", "/ops-sign.js": "ops-sign.js" };
const consoleBase = join(root, "apps", "ops-console");
const types = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", json: "application/json; charset=utf-8" };
const proxy = (req, res, pathname) => {
  const up = httpRequest({ host: cpUrl.hostname, port: cpUrl.port, method: req.method, path: pathname, headers: { ...req.headers, host: cpUrl.host } }, (r) => {
    const h = { ...r.headers };
    delete h.connection;
    delete h["transfer-encoding"];
    res.writeHead(r.statusCode ?? 502, h);
    r.pipe(res);
  });
  up.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end("control plane unreachable");
  });
  req.pipe(up);
};
const consoleSrv = createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${consolePort}`);
  if (u.pathname === "/config.json") {
    const body = JSON.stringify({ control_plane_base: `http://127.0.0.1:${consolePort}`, deployment: "dev", point_price_cny: 0.001, label: "本地演示云端" });
    res.writeHead(200, { "content-type": types.json, "cache-control": "no-store" });
    return res.end(body);
  }
  if (u.pathname.startsWith("/v1/")) return proxy(req, res, u.pathname + u.search); // 路径原样转发（运营签名覆盖 method/path/body）
  const f = consoleFiles[u.pathname];
  if (!f) {
    res.writeHead(404);
    return res.end("not found");
  }
  res.writeHead(200, { "content-type": types[f.split(".").pop()], "cache-control": "no-store" });
  res.end(readFileSync(join(consoleBase, f)));
});
await new Promise((r) => consoleSrv.listen(consolePort, "127.0.0.1", r));
const consoleUrl = `http://127.0.0.1:${consolePort}/`;
log(`运营控制台已就绪：${consoleUrl}`);

/* ---------- ⑤ 运营链路自检：ops-cli 签名调用 /v1/ops/tenants ---------- */
try {
  const t = JSON.parse(execFileSync(process.execPath, [join(root, "scripts", "ops-cli.mjs"), "call", "--url", zrEnv.ZR_CONTROL_PLANE_BASE, "--deployment", "dev", "--aud", "control-plane", "--id", "op_0001", "--kid", "k1", "--key", opKeyFile, "--method", "GET", "--path", "/v1/ops/tenants"], { cwd: root, encoding: "utf8" }));
  const list = (t.body?.tenants ?? []).map((x) => x.tid ?? x.id).join(", ");
  log(`运营接口自检通过（/v1/ops/tenants → ${list || "（空）"}）`);
} catch (e) {
  log(`运营接口自检失败（不影响其余部分）：${String(e.message).slice(0, 200)}`);
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
运营控制台（浏览器）
  地址           ${consoleUrl}
  运营编号       op_0001    密钥编号 k1
  私钥文件       ${opKeyFile}（无口令，直接选择即可）
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
  log("云端 v0 已退出");
  stop();
});
await new Promise(() => {});
