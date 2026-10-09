/**
 * Electron 主进程（方案 v5.0 第 4 篇 §3：窗口/托盘/更新/拉起内核；renderer 沙箱、
 * 上下文隔离、关闭页面 Node；界面与内核只经 IPC 通信）。
 *
 * v5：内核以 utilityProcess 内嵌运行（esbuild 单文件制品，目标 Node 24）；
 * renderer 经 preload 暴露的最小 IPC 调用内核 API（§15.2），本机事实都在内核。
 */
const { app, BrowserWindow, shell, ipcMain, utilityProcess, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

const DEV_SERVER = process.env.ZR_DESKTOP_DEV_URL ?? "http://127.0.0.1:5173";
const isDev = !app.isPackaged && process.env.ZR_DESKTOP_PROD !== "1";

let kernel = null;
let rpcSeq = 0;
const pendingRpc = new Map();
const listeners = new Set();

/**
 * 数据库主密钥（§5.1）：随机 32 字节 base64，首跑生成后经 safeStorage 异步 API 包裹落盘
 * （Windows DPAPI / macOS 钥匙串；方案 §5.1：同步 API 已在 Electron 46 移除，新代码直接用
 * 异步 API——本文件使用 encryptStringAsync/decryptStringAsync）；解封后一次性交付内核，
 * 本进程变量随即置 null。safeStorage 不可用（部分 Linux）时如实降级：不交付密钥（明文开发库形态）并告警。
 */
async function loadDbKey() {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn("[kernel] safeStorage 不可用：不交付数据库主密钥（明文开发库形态，仅开发可接受）");
    return null;
  }
  const file = path.join(app.getPath("userData"), "ledger-key");
  try {
    const wrapped = fs.readFileSync(file);
    const dec = await safeStorage.decryptStringAsync(wrapped);
    if (dec.shouldReEncrypt) {
      // 密钥已轮换/升级：按提示重新包裹落盘（Electron typings 要求再次 decrypt 取得新密文口径）
      try {
        fs.writeFileSync(file, await safeStorage.encryptStringAsync(dec.result), { mode: 0o600 });
      } catch (e) {
        console.warn(`[kernel] 数据库密钥再包裹落盘失败（继续使用本次解封值）：${e && e.message ? e.message : e}`);
      }
    }
    return dec.result;
  } catch {
    try {
      const key = crypto.randomBytes(32).toString("base64");
      const wrapped = await safeStorage.encryptStringAsync(key);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, wrapped, { mode: 0o600 });
      return key;
    } catch (e) {
      console.warn(`[kernel] 数据库主密钥生成/落盘失败：${e && e.message ? e.message : e}；按明文开发库形态启动`);
      return null;
    }
  }
}

async function startKernel() {
  const bundle = path.join(__dirname, "kernel.bundle.cjs");
  const agentHostEntry = path.join(__dirname, "agent-host.bundle.mjs");
  let dbKey = await loadDbKey();
  kernel = utilityProcess.fork(bundle, [], {
    env: {
      ...process.env,
      ZR_KERNEL_DATA_DIR: process.env.ZR_KERNEL_DATA_DIR ?? path.join(app.getPath("appData"), "KimiWorkLegal"),
      ZR_AGENT_HOST_ENTRY: process.env.ZR_AGENT_HOST_ENTRY ?? agentHostEntry,
    },
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
    for (const [, resolve] of pendingRpc) resolve({ ok: false, error: { code: "internal", message: "内核进程已退出" } });
    pendingRpc.clear();
  });
}

function wireIpc() {
  ipcMain.handle("kwl:invoke", (_e, method, params) => {
    return new Promise((resolve) => {
      if (!kernel) return resolve({ ok: false, error: { code: "internal", message: "内核未启动" } });
      const id = ++rpcSeq;
      pendingRpc.set(id, resolve);
      kernel.postMessage({ id, method, params: params ?? {} });
    });
  });
}

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

  // 出站只允许本机界面（§12.2 端侧硬化）：拦截窗口内第三方导航
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(DEV_SERVER) || url.startsWith("file://")) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const allowed = isDev ? url.startsWith(DEV_SERVER) : url.startsWith("file://");
    if (!allowed) event.preventDefault();
  });

  if (isDev) {
    void win.loadURL(DEV_SERVER);
  } else {
    void win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

app.whenReady().then(() => {
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

app.on("will-quit", () => {
  if (kernel) kernel.kill();
});
