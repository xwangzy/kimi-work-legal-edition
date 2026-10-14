/**
 * Electron 主进程（方案 v5.0 第 4 篇 §3：窗口/托盘/更新/拉起内核；renderer 沙箱、
 * 上下文隔离、关闭页面 Node；界面与内核只经 IPC 通信）。
 *
 * v5：内核以 utilityProcess 内嵌运行（esbuild 单文件制品，目标 Node 24）；
 * renderer 经 preload 暴露的最小 IPC 调用内核 API（§15.2），本机事实都在内核。
 */
const { app, BrowserWindow, ipcMain, utilityProcess, safeStorage, session, dialog } = require("electron");
const path = require("node:path");
const { createUrlPolicy } = require("./url-policy.cjs");
const { resolveBundledRuntime } = require("./runtime-paths.cjs");
const { loadOrCreateDbKey, purgeOldDumps } = require("./secret-store.cjs");
const { kernelChildEnv, loadReleaseConfig } = require("./release-config.cjs");

const DEV_SERVER = process.env.ZR_DESKTOP_DEV_URL ?? "http://127.0.0.1:5173";
const isDev = !app.isPackaged && process.env.ZR_DESKTOP_PROD !== "1";

let kernel = null;
let rpcSeq = 0;
const pendingRpc = new Map();
const listeners = new Set();

/**
 * 数据库主密钥（§5.1；隐私安全审查 P0-2）：经 safeStorage（Windows DPAPI）包裹落盘，解封后一次性交付内核、本进程随即置 null。
 * 安装包形态 safeStorage 不可用即拒绝启动；解封失败绝不覆盖密钥文件（secret-store.cjs）。
 */
async function loadDbKey() {
  const r = await loadOrCreateDbKey({ safeStorage, file: path.join(app.getPath("userData"), "ledger-key"), packaged: app.isPackaged });
  if (!r.ok) return r;
  if (r.warning) console.warn(`[kernel] ${r.warning}`);
  return r;
}

/**
 * 随包运行时（安装包形态）：Node 26、可信 rg、W 执行域、Agent 宿主、出站闸门都在 resources/runtime/，
 * 摘要核验通过才拉起内核；任何一项不成立即显示修复指引，绝不回落到 PATH 上的 node（runtime-paths.cjs）。
 * 开发形态可用 ZR_DESKTOP_RUNTIME_DIR 指向 scripts/build-runtime.mjs 的输出做本机验证。
 */
function bundledRuntime() {
  const root = app.isPackaged ? path.join(process.resourcesPath, "runtime") : process.env.ZR_DESKTOP_RUNTIME_DIR;
  if (!root) return { ok: true, env: {} };
  return resolveBundledRuntime(root);
}

/** 内核意外退出后的自动恢复：退避 1、2、4、8、16 秒；2 分钟内超过 5 次即停止并提示（避免反复崩溃损坏数据）。 */
const restart = { times: [], timer: null, quitting: false, runtimeEnv: null };

async function startKernel() {
  const bundle = path.join(__dirname, "kernel.bundle.cjs");
  const agentHostEntry = path.join(__dirname, "agent-host.bundle.mjs");
  // 出站闸门（v9 第 04 篇 §5.1：独立进程、唯一出口；内核按需拉起）
  const gateEntry = path.join(__dirname, "egress-gate.bundle.mjs");
  // Agent 宿主（kap-host，v9 默认引擎）：开发形态从源码拉起（Node 26 原生剥离类型）；安装包随包制品尚未构建（如实登记，W3/W21）
  const kapEntry = isDev ? path.join(__dirname, "../../../packages/kap-host/src/main.ts") : path.join(__dirname, "kap-host.bundle.mjs");
  const keyResult = await loadDbKey();
  if (!keyResult.ok) {
    // 不以明文库启动、不覆盖密钥：给出律师与 IT 都能照做的说明
    dialog.showErrorBox(
      "无法打开本机加密数据",
      keyResult.code === "unavailable"
        ? "Windows 的数据保护服务当前不可用，应用无法加密保存您的案件数据，因此不会启动。\n\n请重新启动电脑后再试；若仍出现，请联系所内 IT。"
        : "本机案件数据的密钥无法解开（常见于更换 Windows 账户、重置系统密码或迁移电脑之后）。为避免数据丢失，应用没有做任何改动。\n\n" +
            "请联系所内 IT 或客服，使用“设备恢复包”或律所恢复流程找回数据。\n\n" +
            `技术信息：${keyResult.code}（${keyResult.message}）`,
    );
    restart.quitting = true;
    app.quit();
    return;
  }
  let dbKey = keyResult.key;
  // 安装包形态：上游地址与钉住集只认随包的 release.json（审计 S5）；内核环境按白名单构造、数据目录与入口写定（复核 B3-A02、C-A15）
  let release = null;
  if (app.isPackaged) {
    release = loadReleaseConfig(path.join(__dirname, "release.json"));
    for (const p of release.problems) console.error(`[release] ${p}`);
  }
  kernel = utilityProcess.fork(bundle, [], {
    env: kernelChildEnv({
      packaged: app.isPackaged,
      isDev,
      processEnv: process.env,
      release,
      paths: { dataDir: path.join(app.getPath("appData"), "KimiWorkLegal"), agentHostEntry, gateEntry, kapEntry },
      runtimeEnv: restart.runtimeEnv,
    }),
    stdio: "ignore",
  });
  // 一次性交付数据库主密钥（内核等待 kernel.init 后启动），主进程随即清除
  kernel.postMessage(dbKey ? { type: "kernel.init", dbKey } : { type: "kernel.init" });
  dbKey = null;
  kernel.on("message", (msg) => {
    if (msg && msg.type === "kernel.event") {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send("kwl:event", msg);
      return;
    }
    if (msg && msg.type === "kernel.ready") {
      console.log(`[kernel] ready, localPort=${msg.localPort}, workspace=${msg.workspace}`);
      return;
    }
    if (msg && msg.type === "kernel.fatal") {
      console.error(`[kernel] fatal: ${msg.message}`);
      return;
    }
    if (msg && typeof msg.id === "number") {
      const resolve = pendingRpc.get(msg.id);
      if (resolve) {
        pendingRpc.delete(msg.id);
        resolve(msg);
      }
    }
  });
  kernel.on("exit", (code) => {
    console.error(`[kernel] exited code=${code}`);
    kernel = null;
    for (const [, resolve] of pendingRpc) resolve({ ok: false, error: { code: "internal", message: "内核进程已退出" } });
    pendingRpc.clear();
    if (restart.quitting) return;
    const now = Date.now();
    restart.times = restart.times.filter((t) => now - t < 120_000);
    if (restart.times.length >= 5) {
      broadcastStatus({ status: "stopped", message: "后台服务多次异常退出，已停止自动重启。请重新打开应用；若仍出现，请在“设备”页导出诊断信息联系支持。" });
      return;
    }
    const delay = Math.min(16_000, 1000 * 2 ** restart.times.length);
    restart.times.push(now);
    broadcastStatus({ status: "restarting", message: `后台服务意外退出，${Math.round(delay / 1000)} 秒后自动恢复。进行中的任务会在恢复后继续或标为待处理。` });
    restart.timer = setTimeout(() => {
      restart.timer = null;
      void startKernel().then(() => broadcastStatus({ status: "running" }));
    }, delay);
  });
}

/** 向界面广播后台服务状态（界面据此显示“正在恢复”横幅，不弹系统对话框打断律师）。 */
function broadcastStatus(payload) {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send("kwl:event", { type: "kernel.status", ...payload });
}

/**
 * IPC 只认本应用窗口的主框架（复核 S5-B14）：子框架（Agent 产物预览的隔离框架）与其他来源的调用一律拒绝。
 */
function fromAppMainFrame(e) {
  const frame = e.senderFrame;
  if (!frame || frame !== e.sender.mainFrame) return false;
  return allowedMainNavigation(frame.url);
}

function wireIpc() {
  ipcMain.handle("kwl:invoke", (e, method, params) => {
    if (!fromAppMainFrame(e)) return Promise.resolve({ ok: false, error: { code: "forbidden", message: "只接受应用主窗口的调用" } });
    return new Promise((resolve) => {
      if (!kernel) return resolve({ ok: false, error: { code: "internal", message: "内核未启动" } });
      const id = ++rpcSeq;
      pendingRpc.set(id, resolve);
      kernel.postMessage({ id, method, params: params ?? {} });
    });
  });
}

/**
 * 渲染进程零外部请求（v9 第 04 篇 §1.2 约束 3、§5.1 ③；第 06 篇 T07）：在网络层拦截渲染会话的一切非本机请求——
 * 生产只允许本包文件（file://）与开发者工具；开发形态另允许 vite 开发服务与热更新。Agent 产物 HTML 即使绕过清洗与 CSP 也发不出请求。
 * 同时：拒绝一切权限请求（摄像头、麦克风、定位、通知……）、不打开外部浏览器、不在窗口或框架内导航到应用之外。
 */
const DEV_ORIGINS = ["http://127.0.0.1:5173", "ws://127.0.0.1:5173"];
const rendererNet = { blocked: 0, lastBlocked: [] };
// 地址策略（url-policy.cjs，可单测）：生产只认本包 dist 内、主机为空的 file:// 地址（排除 UNC，复核 S5-B14）；开发另认 vite
const { allowedRendererUrl, allowedMainNavigation } = createUrlPolicy({
  appDist: path.resolve(__dirname, "../dist"),
  isDev,
  devServer: DEV_SERVER,
  devOrigins: DEV_ORIGINS,
});
function hardenSession(ses) {
  ses.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    if (allowedRendererUrl(details.url)) return callback({});
    rendererNet.blocked += 1;
    rendererNet.lastBlocked = [details.url.slice(0, 120), ...rendererNet.lastBlocked].slice(0, 10);
    callback({ cancel: true });
  });
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
}

app.on("web-contents-created", (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.on("will-navigate", (event, url) => {
    if (!allowedMainNavigation(url)) event.preventDefault();
  });
  // 隔离框架（Agent 产物预览）内的任何导航（链接、meta 刷新、表单）一律阻止
  contents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && event.url !== "about:srcdoc" && event.url !== "about:blank") event.preventDefault();
  });
});

ipcMain.handle("kwl:renderer-net", (e) => (fromAppMainFrame(e) ? { blocked: rendererNet.blocked, last: rendererNet.lastBlocked } : { blocked: -1, last: [] }));

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    title: "Kimi Work 法律行业发行版",
    backgroundColor: "#fbfaf9",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      spellcheck: false,
    },
  });

  if (isDev) {
    void win.loadURL(DEV_SERVER);
  } else {
    void win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

// 崩溃转储（隐私安全审查 P0-4）：只留在本机用户目录、从不上传，启动时删除超过 3 天的转储（转储可能含内存中的案卷片段）
try {
  const dumps = path.join(app.getPath("userData"), "crash");
  app.setPath("crashDumps", dumps);
  purgeOldDumps(dumps, 3);
  require("electron").crashReporter.start({ uploadToServer: false, compress: true });
} catch (e) {
  console.warn(`[crash] 转储目录配置失败：${e && e.message ? e.message : e}`);
}

// 单实例：同一台电脑同时只运行一个客户端（两个实例共用一个本机数据库会互相锁死）
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

app.whenReady().then(() => {
  hardenSession(session.defaultSession);
  const rt = bundledRuntime();
  if (!rt.ok) {
    // 安装不完整或文件被改动（常见原因：杀毒软件隔离了随包组件）：不拉起内核，给出律师能照做的修复指引
    console.error(`[runtime] ${rt.problems.join("；")}`);
    dialog.showErrorBox(
      "Kimi Work 法律版无法启动",
      "应用的部分组件缺失或已被改动，为保护您的案件数据，应用不会在这种状态下运行。\n\n" +
        "请：1）检查杀毒软件是否隔离了 Kimi Work 法律版的文件，恢复并加入信任；2）重新运行安装程序修复。\n\n" +
        `技术信息（供 IT 人员）：${rt.problems.slice(0, 5).join("；")}`,
    );
    app.quit();
    return;
  }
  restart.runtimeEnv = rt.env;
  void startKernel();
  wireIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  restart.quitting = true;
  if (restart.timer) clearTimeout(restart.timer);
});

app.on("will-quit", () => {
  restart.quitting = true;
  if (kernel) kernel.kill();
});
