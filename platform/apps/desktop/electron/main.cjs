/**
 * Electron 主进程（方案 v5.0 第 4 篇 §3：窗口/托盘/更新/拉起内核；renderer 沙箱、
 * 上下文隔离、关闭页面 Node；界面与内核只经 IPC 通信）。
 *
 * v5：内核以 utilityProcess 内嵌运行（esbuild 单文件制品，目标 Node 24）；
 * renderer 经 preload 暴露的最小 IPC 调用内核 API（§15.2），本机事实都在内核。
 */
const { app, BrowserWindow, ipcMain, utilityProcess, safeStorage, session, dialog, protocol } = require("electron");
const path = require("node:path");
const { createUrlPolicy } = require("./url-policy.cjs");
const { APP_INDEX_URL, handleAppProtocol, registerAppScheme } = require("./app-protocol.cjs");
const { resolveBundledRuntime, verifyRuntimeDigests } = require("./runtime-paths.cjs");
const { adoptDbKey, loadOrCreateDbKey, purgeOldDumps } = require("./secret-store.cjs");
const { quarantineUnreadable } = require("./unreadable-data.cjs");
const { kernelChildEnv, loadReleaseConfig } = require("./release-config.cjs");
const { initUpdater } = require("./updater.cjs");
const { parseSmokeArg, writeSmokeResult, SmokeFailure } = require("./smoke-io.cjs");
const { createIdentityRestart } = require("./identity-restart.cjs");
const { createHandleStore, classifySaveTarget, resolveFileParams, acceptDroppedPath, insideAppData, safeSuggestedName, openableSaved, OPENABLE } = require("./file-dialogs.cjs");

const DEV_SERVER = process.env.ZR_DESKTOP_DEV_URL ?? "http://127.0.0.1:5173";

/**
 * 本机数据根（隐私安全增量评审 F1）：Windows 上一律放在 %LOCALAPPDATA%（不漫游），不放 %APPDATA%（Roaming）——
 * 律所启用漫游配置文件或文件夹重定向时，Roaming 下的内容会同步到域服务器：事项密文、DPAPI 包裹的数据库主密钥连同
 * 用户 DPAPI 主密钥一起离开这台电脑，“每台设备独立密钥”不再成立。Electron 的 userData（主密钥包裹文件、崩溃转储、
 * 渲染进程存储）同样改到本地目录；必须在 app ready 之前设置。其他平台沿用系统缺省（macOS 的 Application Support 不漫游）。
 */
const LOCAL_ROOT =
  process.platform === "win32" ? path.join(process.env.LOCALAPPDATA || path.join(require("node:os").homedir(), "AppData", "Local"), "KimiWorkLegal") : null;
// 以点开头：律所标识（工作区目录名）只允许字母或数字开头，不会与之重名
if (LOCAL_ROOT) app.setPath("userData", path.join(LOCAL_ROOT, ".electron"));
const DATA_DIR = LOCAL_ROOT ?? path.join(app.getPath("appData"), "KimiWorkLegal");
const isDev = !app.isPackaged && process.env.ZR_DESKTOP_PROD !== "1";
// 应用协议 kwl://app/ 的特权须在 ready 之前登记（复核 B4-A03）
registerAppScheme(protocol);

let kernel = null;
let rpcSeq = 0;
const pendingRpc = new Map();
const listeners = new Set();

/**
 * 统一脱敏日志（v9.2 §3.6、调研 Y5 §5.2）：主进程不写日志文件、不用 console——只把事件码与字段交内核，由内核按登记表核验后单写；
 * 内核未就绪（或重启中）时暂存最多 50 条，就绪后补交。字段只放枚举、计数与错误码，绝不放 message、路径或用户名。
 */
const slog = (() => {
  const queued = [];
  return {
    event(code, fields) {
      const m = { type: "log.event", code, fields: fields || {} };
      if (kernel) {
        try {
          kernel.postMessage(m);
          return;
        } catch {}
      }
      if (queued.length < 50) queued.push(m);
    },
    flush() {
      while (kernel && queued.length) kernel.postMessage(queued.shift());
    },
  };
})();
/** 异常只取构造器名与错误码（与 @zr-legal/safe-log 的 errFields 同口径；内核会再核验一次）。 */
function errFields(e) {
  const out = {};
  if (e && typeof e === "object") {
    if (typeof e.name === "string" && /^(?:[A-Z][A-Za-z0-9]{0,40}(?:Error|Exception)|Error)$/.test(e.name)) out.err_name = e.name;
    if (typeof e.code === "string" && /^(?:E[A-Z0-9]{2,20}|ERR_[A-Z0-9_]{1,60}|[a-z][a-z0-9_]{1,47})$/.test(e.code)) out.err_code = e.code;
  }
  return out;
}

/**
 * 数据库主密钥（§5.1；隐私安全审查 P0-2）：经 safeStorage（Windows DPAPI）包裹落盘，解封后一次性交付内核、本进程随即置 null。
 * 安装包形态 safeStorage 不可用即拒绝启动；解封失败绝不覆盖密钥文件（secret-store.cjs）。
 */
async function loadDbKey() {
  const r = await loadOrCreateDbKey({ safeStorage, file: path.join(app.getPath("userData"), "ledger-key"), packaged: app.isPackaged });
  if (!r.ok) return r;
  if (r.warning) slog.event("MAIN_DBKEY_DEV_PLAINTEXT", {});
  return r;
}

/**
 * 主密钥解封失败（v9.3 主文 §9 第 7 项，复核 R2B-10）：给“退出 / 用恢复包恢复”。后者再确认一次，把打不开的数据改名到
 * `<数据根>/.unreadable-<时刻>/`（unreadable-data.cjs，不删除）后返回 true——调用方重新拉起内核：没有主密钥文件即生成新的，
 * 没有激活记录即以待激活模式启动，激活页直接打开“从备份恢复”（内核报告 set_aside）。
 */
async function offerSetAsideAndRestore(keyResult) {
  const first = await dialog.showMessageBox({
    type: "error",
    title: "无法打开本机加密数据",
    message: "本机案件数据的密钥无法解开",
    detail:
      "常见于重置 Windows 账户密码、重装系统后还原用户目录。应用没有做任何改动。\n\n" +
      "如果你有恢复包、恢复码和备份（设置 → 本机与安全 → 恢复与备份里生成的那些），可以选“用恢复包恢复”。拿不准时请先退出，联系所内 IT。\n\n" +
      `技术信息：${keyResult.code}`,
    buttons: ["退出", "用恢复包恢复…"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (first.response !== 1) return false;
  const second = await dialog.showMessageBox({
    type: "warning",
    title: "用恢复包恢复",
    message: "先把打不开的数据移到一边，再从备份恢复",
    detail:
      `这台电脑上打不开的数据不会删除，会移到：\n${path.join(DATA_DIR, ".unreadable-<时刻>")}\n是否保留、何时清理由所内 IT 决定。\n\n` +
      "接下来需要：恢复包文件、恢复码、备份所在的移动硬盘或文件夹。",
    buttons: ["取消", "移到一边并恢复"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (second.response !== 1) return false;
  const r = quarantineUnreadable({ dataDir: DATA_DIR, keyFile: path.join(app.getPath("userData"), "ledger-key") });
  if (r.ok) {
    slog.event("MAIN_DATA_SET_ASIDE", { code: "ok", moved: r.moved.length });
    return true;
  }
  slog.event("MAIN_DATA_SET_ASIDE_FAILED", { code: r.code, moved: r.moved.length });
  dialog.showErrorBox(
    "没能把数据移到一边",
    `已移动 ${r.moved.length} 项，其余保持原样；应用不会继续。请联系所内 IT 手工处理（数据目录：${DATA_DIR}）。\n\n技术信息：${r.code}`,
  );
  return false;
}

/**
 * 随包运行时（安装包形态）：Node 26、可信 rg、W 执行域、Agent 宿主、出站闸门都在 resources/runtime/，
 * 摘要核验通过才拉起内核；任何一项不成立即显示修复指引，绝不回落到 PATH 上的 node（runtime-paths.cjs）。
 * 开发形态可用 ZR_DESKTOP_RUNTIME_DIR 指向 scripts/build-runtime.mjs 的输出做本机验证。
 */
function bundledRuntime() {
  const root = app.isPackaged ? path.join(process.resourcesPath, "runtime") : process.env.ZR_DESKTOP_RUNTIME_DIR;
  if (!root) return { ok: true, env: {} };
  // 安装包：期望摘要取 asar 内的清单副本（package-desktop.mjs 暂存时放入；asar 受完整性熔断保护）
  return resolveBundledRuntime(
    root,
    app.isPackaged ? { trustedManifestFile: path.join(__dirname, "runtime-manifest.json"), unpackedRoot: path.join(process.resourcesPath, "app.asar.unpacked") } : {},
  );
}

/**
 * 后台核对随包运行时全部文件的摘要（复核 B4-A01）：启动时只同步核对入口摘要与全部文件的存在和大小，这里补上依赖闭包、
 * 原生模块、wasm 与模型的内容比对。发现不符即有序关闭内核并显示修复指引（与启动时“运行时损坏”同一口径）。
 */
let runtimeDigests = null;
let runtimeManifest = null;
/** 全量摘要核验已通过（开发形态没有随包运行时，视为通过）。内核在此之前不拉起随包子进程（KWL_RUNTIME_VERIFY_PENDING）。 */
let runtimeVerifiedOk = !app.isPackaged;
function sendRuntimeVerified() {
  if (!runtimeVerifiedOk || !kernel) return;
  try {
    kernel.postMessage({ type: "kernel.runtime_verified" });
  } catch {
    // 内核正在退出：重新就绪时再发
  }
}
function verifyRuntimeInBackground(manifest) {
  if (!app.isPackaged || !manifest) return Promise.resolve([]);
  runtimeDigests ??= verifyRuntimeDigests(path.join(process.resourcesPath, "runtime"), manifest).catch((e) => [`核验出错：${e && e.message ? e.message : e}`]);
  return runtimeDigests;
}

/**
 * 安装后冒烟（Windows CI 与 IT 部署核验）：`KWL_SMOKE=1 KimiWorkLegal.exe --kwl-smoke=<结果文件>`——启动后核验随包运行时、解封数据库主密钥、
 * 等内核就绪、调用 kernel.status、等界面真正渲染，把结果（不含任何事项内容与密钥，错误只写代码）写入一个新文件后退出；退出码 0 = 全部通过、
 * 2 = 已有实例在运行。入口与路径限制见 smoke-io.cjs（复核 B4-A08）。冒烟会在本账户真实数据目录上启动一次内核。
 */
const smoke = (() => {
  const { out, problem } = parseSmokeArg(process.argv, process.env);
  if (problem) slog.event("MAIN_SMOKE_FAILED", { reason: "arg_rejected" });
  let onReady = null;
  const ready = new Promise((r) => (onReady = r));
  // 冒烟期间内核崩溃/退出：立即失败并给出与"挂起超时"区分开的错误码（kernel.fatal 的 message 可能含路径，只写码不外带）
  let onFail = null;
  const failed = new Promise((_, rej) => (onFail = rej));
  failed.catch(() => {});
  return { out, rejected: Boolean(problem), ready, failed, kernelReady: (msg) => onReady && onReady(msg), kernelFailed: (code) => onFail && onFail(new SmokeFailure(code)) };
})();

async function runSmoke(win) {
  const fs = require("node:fs");
  const result = { ok: false, started_at: new Date().toISOString(), packaged: app.isPackaged, version: app.getVersion(), checks: {} };
  const timeout = (ms, what) => new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} 超时`)), ms));
  try {
    result.checks.runtime = restart.runtimeEnv ? "ok" : "missing";
    await Promise.race([smoke.ready, smoke.failed, timeout(120_000, "内核就绪")]).catch((e) => {
      if (e instanceof SmokeFailure) throw e;
      throw new SmokeFailure("kernel_ready_timeout");
    });
    result.checks.kernel_ready = "ok";
    const st = await Promise.race([
      new Promise((resolve) => {
        const id = ++rpcSeq;
        pendingRpc.set(id, resolve);
        kernel.postMessage({ id, method: "kernel.status", params: {} });
      }),
      timeout(30_000, "kernel.status"),
    ]).catch(() => null);
    if (!st || st.ok !== true) throw new SmokeFailure("kernel_status_failed");
    const s = st.result;
    result.checks.kernel_status = { ocr_available: s.ocr.available, egress_gate: Boolean(s.egress_gate), sole_exit: s.egress_gate && s.egress_gate.sole_exit, control_plane_mode: s.control_plane && s.control_plane.mode, lawdb: s.lawdb_package ? "ok" : "missing", onboarding: s.onboarding ? s.onboarding.mode : "activated", content_key: s.content_key };
    if (!s.ocr.available) throw new SmokeFailure("ocr_unavailable");
    await Promise.race([win.webContents.isLoading() ? new Promise((r) => win.webContents.once("did-finish-load", r)) : Promise.resolve(), timeout(60_000, "界面加载")]).catch(() => {
      throw new SmokeFailure("renderer_load_timeout");
    });
    result.checks.renderer_loaded = "ok";
    // 界面真正渲染（复核 B4-A03）：HTML 加载完成不代表脚本跑起来了（模块脚本被拦截时页面空白但 did-finish-load 照样触发）
    let mounted = 0;
    for (let i = 0; i < 40 && mounted === 0; i++) {
      mounted = Number(await win.webContents.executeJavaScript("document.getElementById('root')?.childElementCount ?? 0").catch(() => 0)) || 0;
      if (mounted === 0) await new Promise((r) => setTimeout(r, 250));
    }
    if (mounted === 0) throw new SmokeFailure("renderer_not_mounted"); // 页面空白：脚本未能加载
    result.checks.renderer_mounted = "ok";
    // 越过启动占位（复核 R2B-24 / B13-K01）：启动占位页也“有子节点”——要等到激活页或主界面之一真正出现
    let booted = false;
    for (let i = 0; i < 240 && !booted; i++) {
      booted = (await win.webContents.executeJavaScript("!!document.querySelector('.activate-title, .shell') && !document.querySelector('.activate[aria-busy=\"true\"]')").catch(() => false)) === true;
      if (!booted) await new Promise((r) => setTimeout(r, 250));
    }
    if (!booted) throw new SmokeFailure("ui_boot_stuck");
    result.checks.ui_boot = "ok";
    // 随包运行时全部文件的摘要（复核 B4-A01）：冒烟里同步等结果
    const digestProblems = await verifyRuntimeInBackground(runtimeManifest);
    if (digestProblems.length) {
      result.problems = digestProblems.slice(0, 10);
      throw new SmokeFailure("runtime");
    }
    result.checks.runtime_digests = app.isPackaged ? "ok" : "skipped";
    result.checks.renderer_external_requests_blocked = rendererNet.blocked;
    result.ok = true;
  } catch (e) {
    result.error = e instanceof SmokeFailure ? e.smokeCode : "internal";
    slog.event("MAIN_SMOKE_FAILED", { reason: result.error });
  }
  result.finished_at = new Date().toISOString();
  let wrote = true;
  try {
    writeSmokeResult(smoke.out, result);
  } catch (e) {
    wrote = false;
    slog.event("MAIN_SMOKE_FAILED", { reason: "write_result" });
  }
  // 有序关闭内核及其子进程后再退出：CI 用 Start-Process -Wait 等整棵进程树（复核 B4-A18）
  await stopKernel();
  app.exit(!wrote ? 3 : result.ok ? 0 : 1);
}

/** 随 asar 的发布配置（上游、钉住集、更新源与发布公钥）：安装包形态读取一次，开发形态为 null。 */
let releaseCached;
function releaseConfig() {
  if (releaseCached !== undefined) return releaseCached;
  releaseCached = null;
  if (app.isPackaged) {
    releaseCached = loadReleaseConfig(path.join(__dirname, "release.json"));
    if (releaseCached.problems.length) slog.event("MAIN_RELEASE_CONFIG_PROBLEM", { count: releaseCached.problems.length });
  }
  return releaseCached;
}

/** 自动更新状态（W7）：界面横幅据此提示“新版本已就绪，重启后生效”；不强制重启、不打断进行中的任务。 */
const updateState = { handle: null, last: { state: "idle" } };
function startUpdater() {
  updateState.handle = initUpdater({
    app,
    session,
    release: releaseConfig(),
    // 更新链的告警与失败只记事件码（消息文字可能含网址与路径，丢弃；复核 S5A-06）
    log: { warn: () => slog.event("MAIN_UPDATE_WARN", {}), error: () => slog.event("MAIN_UPDATE_FAILED", {}) },
    onStatus: (st) => {
      updateState.last = st;
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send("kwl:event", { type: "update.status", ...st });
    },
  });
}

/** 内核意外退出后的自动恢复：退避 1、2、4、8、16 秒；2 分钟内超过 5 次即停止并提示（避免反复崩溃损坏数据）。 */
const restart = { times: [], timer: null, quitting: false, runtimeEnv: null };

async function startKernel() {
  const bundle = path.join(__dirname, "kernel.bundle.cjs");
  // 出站闸门（v9 第 04 篇 §5.1：独立进程、唯一出口；内核按需拉起）
  const gateEntry = path.join(__dirname, "egress-gate.bundle.mjs");
  // 以下缺省入口只用于开发形态；安装包形态的闸门与 Agent 宿主入口只来自核验过的随包运行时（release-config.cjs，复核 B4-A20）。
  // Agent 宿主（kap-host，v9 默认引擎）：开发形态从源码拉起（Node 26 原生剥离类型）
  const kapEntry = isDev ? path.join(__dirname, "../../../packages/kap-host/src/main.ts") : path.join(__dirname, "kap-host.bundle.mjs");
  const keyResult = await loadDbKey();
  if (!keyResult.ok) {
    if (smoke.out) {
      try {
        writeSmokeResult(smoke.out, { ok: false, error: "db_key", code: keyResult.code });
      } catch {}
      restart.quitting = true;
      app.exit(1);
      return;
    }
    // 不以明文库启动、不覆盖密钥：给出律师与 IT 都能照做的说明
    if (keyResult.code === "unseal_failed" && (await offerSetAsideAndRestore(keyResult))) return startKernel();
    if (keyResult.code !== "unseal_failed")
      dialog.showErrorBox(
        "无法打开本机加密数据",
        keyResult.code === "unavailable"
          ? "Windows 的数据保护服务当前不可用，应用无法加密保存您的案件数据，因此不会启动。\n\n请重新启动电脑后再试；若仍出现，请联系所内 IT。"
          : `应用无法在这台电脑上保存数据库密钥，因此不会启动。请检查磁盘空间与权限后再试；若仍出现，请联系所内 IT。\n\n技术信息：${keyResult.code}`,
      );
    restart.quitting = true;
    app.quit();
    return;
  }
  let dbKey = keyResult.key;
  // 安装包形态：上游地址与钉住集只认随包的 release.json（审计 S5）；内核环境按白名单构造、数据目录与入口写定（复核 B3-A02、C-A15）
  const release = releaseConfig();
  kernelStopped = false;
  kernel = utilityProcess.fork(bundle, [], {
    env: kernelChildEnv({
      packaged: app.isPackaged,
      isDev,
      processEnv: process.env,
      release,
      paths: { dataDir: DATA_DIR, gateEntry, kapEntry },
      appVersion: app.getVersion(),
      runtimeEnv: restart.runtimeEnv,
    }),
    // 内核 stdout/stderr 进内存环形缓冲（上限 16KB）：内核崩溃在 asar 加载期只有这里可见——
    // 仅冒烟形态（KWL_SMOKE）在内核死亡时把它写到结果文件旁的 <out>.kernel.log 供 CI 取证
    // （错误文本可能含安装路径与用户名：只落在 runner/IT 提供的临时位置，绝不进用户数据根）
    stdio: ["ignore", "pipe", "pipe"],
  });
  const kernelOutRing = [];
  let kernelOutBytes = 0;
  for (const s of [kernel.stdout, kernel.stderr]) {
    if (!s) continue;
    s.on("data", (c) => {
      kernelOutRing.push(c);
      kernelOutBytes += c.length;
      while (kernelOutBytes > 16 * 1024 && kernelOutRing.length > 1) kernelOutBytes -= kernelOutRing.shift().length;
    });
  }
  const dumpKernelOutput = () => {
    if (!smoke.out || kernelOutRing.length === 0) return;
    try {
      require("node:fs").appendFileSync(`${smoke.out}.kernel.log`, kernelOutRing.join(""));
    } catch {}
    kernelOutRing.length = 0;
  };
  // 一次性交付数据库主密钥（内核等待 kernel.init 后启动），主进程随即清除
  kernel.postMessage(dbKey ? { type: "kernel.init", dbKey } : { type: "kernel.init" });
  dbKey = null;
  kernel.on("message", (msg) => {
    if (msg && typeof msg.id === "number") {
      const resolve = pendingRpc.get(msg.id);
      if (resolve) {
        pendingRpc.delete(msg.id);
        resolve(msg);
      }
      return;
    }
    if (msg && msg.type === "kernel.ready") {
      kernelOnboarding = msg.onboarding === true;
      slog.flush();
      slog.event("MAIN_KERNEL_READY", {});
      smoke.kernelReady(msg);
      // 内核（重新）就绪：若随包运行时全量核验已通过，告诉它可以拉起随包子进程（复核 B4-R15）
      sendRuntimeVerified();
      return;
    }
    // 从备份恢复（第 14 批）：内核取回了旧电脑的数据库主密钥——只在内核报告处于待激活模式时接受（本机还没有任何案件数据），
    // 用本机 DPAPI 重新包裹、原包裹文件留档，再按新身份重启；这条消息绝不转发给界面
    if (msg && msg.type === "kernel.adopt_master_key") {
      const key = msg.key;
      msg.key = null;
      if (!kernelOnboarding) {
        slog.event("MAIN_ADOPT_KEY_REJECTED", { reason: "not_onboarding" });
        return;
      }
      void adoptDbKey({ safeStorage, file: path.join(app.getPath("userData"), "ledger-key"), key }).then((r) => {
        if (!r.ok) slog.event("MAIN_ADOPT_KEY_REJECTED", { reason: r.code });
        else slog.event("MAIN_ADOPT_KEY_DONE", {});
        // 成功与否都按新身份重启（复核 R2A-15）：内核启动时用当前主密钥试开恢复出的账本——没采用成功就回滚恢复、回到待激活并告诉律师
        void restartKernelForIdentity();
      });
      return;
    }
    // 开通或入组完成（第 13 批）：内核已写好 activation.json，按新身份有序重启内核（界面轮询 kernel.status 后自行刷新）
    if (msg && msg.type === "kernel.restart_for_identity") {
      slog.event("MAIN_KERNEL_IDENTITY_RESTART", {});
      void restartKernelForIdentity();
      return;
    }
    if (msg && msg.type === "kernel.fatal") {
      slog.event("MAIN_KERNEL_FATAL", {});
      dumpKernelOutput();
      // 致命错误文本进 .kernel.log（同一取证通道：可能含路径与用户名，只落 runner/IT 提供的临时位置；结果文件仍只写码）
      if (smoke.out && typeof msg.message === "string") {
        try {
          require("node:fs").appendFileSync(`${smoke.out}.kernel.log`, `kernel.fatal: ${msg.message}\n`);
        } catch {}
      }
      if (smoke.out) smoke.kernelFailed("kernel_fatal");
      return;
    }
    // 其余都是内核广播（{type:"kernel.event",...} 与 run.updated、run.settled 等——广播自带的 type 会覆盖信封的 "kernel.event"，
    // 原先只认 type === "kernel.event" 时任务状态广播从未到达界面，2026-10-14 修正）。
    // 只转发白名单内的类型（复核 B4-B14）：内核今后新增的带 type 消息（诊断、内部状态）不会自动到达渲染进程，
    // 也不能冒充主进程自己合成的 update.status、focus.run、kernel.status
    if (msg && (msg.type === "run.updated" || msg.type === "run.settled" || msg.type === "kernel.event")) {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send("kwl:event", msg);
      notifyWaiting(msg);
    }
    // 期限提醒到时（第 10 批 S9）：只转发条数，系统通知只写“有 N 条期限提醒”
    if (msg && msg.type === "reminder.due" && Number.isInteger(msg.count) && msg.count > 0) {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send("kwl:event", { type: "reminder.due", count: msg.count });
      notifyReminder(msg.count);
    }
  });
  kernel.on("exit", (code) => {
    kernel = null;
    slog.event("MAIN_KERNEL_EXITED", { code: Number.isInteger(code) ? code : undefined });
    dumpKernelOutput();
    if (smoke.out) smoke.kernelFailed("kernel_exited");
    for (const [, resolve] of pendingRpc) resolve({ ok: false, error: { code: "internal", message: "内核进程已退出" } });
    pendingRpc.clear();
    if (restart.quitting) return;
    const now = Date.now();
    restart.times = restart.times.filter((t) => now - t < 120_000);
    if (restart.times.length >= 5) {
      kernelStopped = true;
      broadcastStatus({ status: "stopped", message: "后台服务多次异常退出，已停止自动重启。请重新打开应用；若仍出现，请联系所内 IT 或客服。" });
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

/**
 * 任务开始等你确认或回答时，若应用窗口不在前台：发系统通知并闪烁任务栏（UIUX 增量评审 P0-F）。
 * 通知只写“有任务在等你”，不含事项名称以外的任何内容（不含案情、当事人、检索式）；点击通知回到应用并打开该任务。
 */
function notifyWaiting(msg) {
  if (msg.type !== "run.updated" || !msg.waiting || typeof msg.run_id !== "string") return;
  const wins = BrowserWindow.getAllWindows();
  if (wins.length === 0 || wins.some((w) => w.isFocused())) return;
  const win = wins[0];
  try {
    win.flashFrame(true);
    const { Notification } = require("electron");
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: "Kimi Work 法律版", body: msg.waiting === "input" ? "有一个任务想先问你一个问题" : "有一个任务在等你确认", silent: false });
    n.on("click", () => {
      if (win.isMinimized()) win.restore();
      win.focus();
      win.webContents.send("kwl:event", { type: "focus.run", run_id: msg.run_id });
    });
    n.show();
  } catch (e) {
    slog.event("MAIN_NOTIFY_FAILED", errFields(e));
  }
}

/**
 * 期限提醒到时（第 10 批 S9）：发系统通知——无论窗口是否在前台（期限比任务确认更不能漏看）。
 * 通知中心会留存通知文字（驻留面第 22 类），所以只写条数，不写事项名、期限类型与备注；点击通知打开“期限提醒”页。
 */
function notifyReminder(count) {
  const wins = BrowserWindow.getAllWindows();
  const win = wins[0];
  try {
    if (win && !wins.some((w) => w.isFocused())) win.flashFrame(true);
    const { Notification } = require("electron");
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: "Kimi Work 法律版", body: count === 1 ? "你有一条期限提醒" : `你有 ${Math.min(count, 99)} 条期限提醒`, silent: false });
    n.on("click", () => {
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.focus();
      win.webContents.send("kwl:event", { type: "focus.reminders" });
    });
    n.show();
  } catch (e) {
    slog.event("MAIN_NOTIFY_FAILED", errFields(e));
  }
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

/** 等内核子进程出现（至多 timeoutMs；正在退出时立即放弃）。 */
/** 内核已停止（多次异常退出、按身份重启时拉起失败）：界面调用立即失败，不再每次空等 60 秒（复核 R2B-25）。 */
let kernelStopped = false;
function whenKernel(timeoutMs) {
  if (kernel) return Promise.resolve(kernel);
  if (kernelStopped) return Promise.resolve(null);
  const until = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (kernel) return resolve(kernel);
      if (Date.now() > until || (restart.quitting && !identityRestarting)) return resolve(null);
      setTimeout(tick, 200);
    };
    tick();
  });
}

/** 文件对话框的一次性句柄（file-dialogs.cjs）：渲染进程只拿句柄与文件名，路径只在主进程与内核之间。 */
const fileHandles = createHandleStore();

function wireIpc() {
  ipcMain.handle("kwl:invoke", (e, method, params) => {
    if (!fromAppMainFrame(e)) return Promise.resolve({ ok: false, error: { code: "forbidden", message: "只接受应用主窗口的调用" } });
    // 导出类方法只往对话框选定的位置写；读取类方法的句柄换成路径（渲染进程自带的写入路径一律剥掉）
    const r = resolveFileParams(String(method), params, fileHandles);
    if (r.error) return Promise.resolve({ ok: false, error: r.error });
    // 内核还没拉起（首次启动在解封主密钥、重启中）：等它出现再转发（复核 B13-K01）；内核入口在就绪前把调用排队
    return whenKernel(60_000).then(
      (k) =>
        new Promise((resolve) => {
          if (!k) return resolve({ ok: false, error: { code: "kernel_starting", message: "后台服务正在启动，请稍候" } });
          const id = ++rpcSeq;
          pendingRpc.set(id, (reply) => {
            // 成果存到律师选定的位置后，给一次性“打开”句柄（v9.4 第 21 批：在 Word / WPS 中打开）
            const saved = openableSaved(String(method), r.params, reply);
            if (saved) reply = { ...reply, result: { ...reply.result, open_handle: fileHandles.issue("opensaved", saved) } };
            resolve(reply);
          });
          k.postMessage({ id, method, params: r.params });
        }),
    );
  });
  // 用系统默认程序（Word / WPS / Excel）打开刚保存的成果：只认上面发的一次性句柄；路径在应用数据目录里、扩展名不对或文件不在的拒绝
  ipcMain.handle("kwl:open-saved", async (e, handle) => {
    if (!fromAppMainFrame(e)) return { ok: false };
    const p = fileHandles.take(handle, "opensaved");
    if (!p || !OPENABLE.test(p) || insideAppData(p, [app.getPath("userData")])) return { ok: false };
    try {
      if (!require("node:fs").statSync(p).isFile()) return { ok: false };
      const problem = await require("electron").shell.openPath(p);
      return problem ? { ok: false, reason: "no_app" } : { ok: true };
    } catch (err) {
      slog.event("MAIN_OPEN_SAVED_FAILED", errFields(err));
      return { ok: false };
    }
  });
  // 选择材料（v9.2 §3.7；Y5 P1-4）：系统对话框带 dontAddToRecent（不进“最近使用”与跳转列表）；只回句柄、文件名与大小
  ipcMain.handle("kwl:pick-files", async (e, opts) => {
    if (!fromAppMainFrame(e)) return null;
    const win = BrowserWindow.fromWebContents(e.sender);
    const exts = Array.isArray(opts && opts.extensions) ? opts.extensions.filter((x) => typeof x === "string" && /^[a-z0-9]{1,8}$/i.test(x)).slice(0, 20) : [];
    const r = await dialog.showOpenDialog(win, {
      properties: ["openFile", ...(opts && opts.multiple === false ? [] : ["multiSelections"]), "dontAddToRecent"],
      ...(exts.length ? { filters: [{ name: exts.length === 1 && exts[0] === "kwlr" ? "恢复包" : "材料", extensions: exts }] } : {}),
    });
    if (r.canceled) return [];
    const fs = require("node:fs");
    return r.filePaths.slice(0, 200).map((p) => {
      let size = 0;
      try {
        size = fs.statSync(p).size;
      } catch {}
      return { handle: fileHandles.issue("open", p), name: path.basename(p), size };
    });
  });
  // 选文件夹（第 14 批：备份位置、从备份恢复）：不进“最近使用”；不许选本应用自己的数据目录；网络与同步位置给风险标记
  ipcMain.handle("kwl:pick-folder", async (e) => {
    if (!fromAppMainFrame(e)) return null;
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory", "dontAddToRecent"] });
    if (r.canceled || !r.filePaths[0]) return null;
    const p = r.filePaths[0];
    if (insideAppData(p, [DATA_DIR, app.getPath("userData")])) {
      await dialog.showMessageBox(win, { type: "warning", message: "不能选 Kimi Work 自己的数据目录", detail: "请选移动硬盘、律所共享盘或另一个文件夹。" });
      return null;
    }
    return { handle: fileHandles.issue("folder", p), name: path.basename(p), risk: classifySaveTarget(p) };
  });
  // 保存位置：系统对话框（不进“最近使用”、覆盖须确认）；同步文件夹与网络位置给出风险标记，界面先说明再保存
  ipcMain.handle("kwl:pick-save", async (e, opts) => {
    if (!fromAppMainFrame(e)) return null;
    const win = BrowserWindow.fromWebContents(e.sender);
    const name = safeSuggestedName(opts && opts.name);
    const r = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath("documents"), name),
      properties: ["dontAddToRecent", "showOverwriteConfirmation", "createDirectory"],
    });
    if (r.canceled || !r.filePath) return null;
    if (insideAppData(r.filePath, [DATA_DIR, app.getPath("userData")])) {
      await dialog.showMessageBox(win, { type: "warning", message: "不能保存到 Kimi Work 的数据目录里", detail: "请换一个位置，例如“文档”或“桌面”。" });
      return null;
    }
    return { handle: fileHandles.issue("save", r.filePath), name: path.basename(r.filePath), risk: classifySaveTarget(r.filePath) };
  });
  // 拖放的文件（复核 S5A-01）：preload 从真实的 File 取得路径交主进程登记，页面只拿句柄；网络路径不收、只收普通文件
  ipcMain.handle("kwl:register-file", (e, p) => {
    if (!fromAppMainFrame(e) || !acceptDroppedPath(p)) return null;
    try {
      const st = require("node:fs").lstatSync(p);
      if (!st.isFile()) return null;
      return { handle: fileHandles.issue("open", p), name: path.basename(p), size: st.size };
    } catch {
      return null;
    }
  });
  // 不含案件内容的小文件（删除回执）：主进程写到对话框选定的位置
  ipcMain.handle("kwl:save-text", async (e, handle, text) => {
    if (!fromAppMainFrame(e)) return { ok: false };
    const target = fileHandles.take(handle, "save");
    if (!target || typeof text !== "string" || text.length > 256 * 1024) return { ok: false };
    try {
      require("node:fs").writeFileSync(target, text, { mode: 0o600 });
      return { ok: true, name: path.basename(target) };
    } catch (err) {
      slog.event("MAIN_SAVE_FAILED", errFields(err));
      return { ok: false };
    }
  });
}

/**
 * 渲染进程零外部请求（v9 第 04 篇 §1.2 约束 3、§5.1 ③；第 06 篇 T07）：在网络层拦截渲染会话的一切非本机请求——
 * 生产只允许应用协议 kwl://app/（本包 dist）与开发者工具；开发形态另允许 vite 开发服务与热更新。Agent 产物 HTML 即使绕过清洗与 CSP 也发不出请求。
 * 同时：拒绝一切权限请求（摄像头、麦克风、定位、通知……）、不打开外部浏览器、不在窗口或框架内导航到应用之外。
 */
const DEV_ORIGINS = ["http://127.0.0.1:5173", "ws://127.0.0.1:5173"];
const rendererNet = { blocked: 0, lastBlocked: [] };
// 地址策略（url-policy.cjs，可单测）：生产只认应用协议 kwl://app/（复核 B4-A03；不再放行任何 file:// 地址，UNC 外连也就无从谈起）；开发另认 vite
const { allowedRendererUrl, allowedMainNavigation } = createUrlPolicy({
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

ipcMain.handle("kwl:update-status", (e) => (fromAppMainFrame(e) ? { enabled: Boolean(updateState.handle && updateState.handle.enabled), ...updateState.last } : null));
/** 进行中的任务状态（与内核 liveAgentRunOf 同口径）：有这类任务时不安装更新（复核 B4-B17 主进程一侧）。 */
const LIVE_RUN_STATUSES = new Set(["created", "validating", "queued", "running", "waiting_input", "waiting_approval", "waiting_device", "budget_paused", "recovering", "reconciling"]);
ipcMain.handle("kwl:update-install", async (e) => {
  if (!fromAppMainFrame(e) || !updateState.handle || !updateState.handle.enabled || updateState.last.state !== "ready") return { ok: false };
  // 界面在有任务时不显示重启按钮；主进程再核一次（界面状态可能过时）——有进行中的任务即不安装，退出时再自动安装
  const recent = await kernelCall("runs.list_recent", { limit: 20 });
  // 内核没有应答（正在备份、正在启动）按“忙”处理，不放行安装（复核 R2B-04：原先超时返回 null 即绕过了这项检查）
  if (!recent || !Array.isArray(recent.runs) || recent.runs.some((r) => LIVE_RUN_STATUSES.has(r.status))) return { ok: false, reason: "busy" };
  restart.quitting = true;
  appExiting = true;
  // 先有序关闭内核及其子进程、再拉起安装程序（复核 B4-R11）：electron-updater 先拉起安装程序、后退出应用，
  // 安装程序约 1–3 秒后就强制结束应用，来不及等内核按序关闭子进程，残留的随包 node.exe 会占用安装目录
  await stopKernel();
  updateState.handle.install();
  return { ok: true };
});
ipcMain.handle("kwl:renderer-net", (e) => (fromAppMainFrame(e) ? { blocked: rendererNet.blocked, last: rendererNet.lastBlocked } : { blocked: -1, last: [] }));

/** 主进程向内核发一次调用（不经渲染进程）；内核未启动或超时返回 null。 */
function kernelCall(method, params, timeoutMs = 10_000) {
  if (!kernel) return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = ++rpcSeq;
    const timer = setTimeout(() => {
      pendingRpc.delete(id);
      resolve(null);
    }, timeoutMs);
    pendingRpc.set(id, (r) => {
      clearTimeout(timer);
      resolve(r && r.ok ? r.result : null);
    });
    kernel.postMessage({ id, method, params: params ?? {} });
  });
}

/**
 * 防截屏（隐私 Y5 P1-8）：打开敏感事项（L3a/L3b/L4）的事项页、任务页，以及从这类事项打开的复核页时，窗口内容不进截屏、录屏与
 * 远程桌面共享（Windows SetWindowDisplayAffinity；macOS 同样生效）。事项级别经内核查询；查不到时保持当前状态，不误关。
 * 界面路由是地址里的 # 段（App.tsx parseHash），主进程据此判断，不需要渲染进程配合。
 */
const SENSITIVE_LEVELS = new Set(["L3a", "L3b", "L4"]);
function wireContentProtection(win) {
  let seq = 0;
  let lastMatterSensitive = false;
  const apply = async (url) => {
    const my = ++seq;
    let h = "";
    try {
      h = new URL(url).hash.replace(/^#\/?/, "");
    } catch {
      h = "";
    }
    const [page, a, b] = h.split("/").map((x) => {
      try {
        return decodeURIComponent(x);
      } catch {
        return x;
      }
    });
    const matterId = page === "matter" ? a : page === "run" ? b : null;
    let protect;
    if (matterId) {
      const r = await kernelCall("matters.get", { matter_id: matterId });
      const level = r && r.matter ? r.matter.data_level : null;
      if (level === null) return; // 查不到：保持当前状态
      lastMatterSensitive = SENSITIVE_LEVELS.has(level);
      protect = lastMatterSensitive;
    } else protect = page === "review" ? lastMatterSensitive : false;
    if (my !== seq || win.isDestroyed()) return;
    win.setContentProtection(protect);
  };
  win.webContents.on("did-navigate-in-page", (_e, url) => void apply(url));
  win.webContents.on("did-finish-load", () => void apply(win.webContents.getURL()));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    title: "Kimi Work 法律行业发行版",
    // 首帧底色随系统明暗（侧栏 --bg-sidebar 两套值）；界面里显式选了与系统相反的外观时，首帧可能闪一下另一底色
    backgroundColor: require("electron").nativeTheme.shouldUseDarkColors ? "#141312" : "#fbfaf9",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      spellcheck: false,
    },
  });

  win.on("focus", () => win.flashFrame(false));
  wireContentProtection(win);
  if (isDev) {
    void win.loadURL(DEV_SERVER);
  } else {
    // 不用 loadFile（复核 B4-A03）：熔断关闭 file 额外特权后，file:// 页面的源是 null，模块脚本与 crossorigin 样式被拦，界面空白
    void win.loadURL(APP_INDEX_URL);
  }
  return win;
}

// 崩溃转储（隐私安全审查 P0-4）：只留在本机用户目录、从不上传，启动时删除超过 3 天的转储（转储可能含内存中的案卷片段）
try {
  const dumps = path.join(app.getPath("userData"), "crash");
  app.setPath("crashDumps", dumps);
  purgeOldDumps(dumps, 3);
  require("electron").crashReporter.start({ uploadToServer: false, compress: true });
} catch (e) {
  slog.event("MAIN_CRASH_DIR_FAILED", errFields(e));
}

// 单实例：同一台电脑同时只运行一个客户端（两个实例共用一个本机数据库会互相锁死）。
// 拿不到锁的实例在 quit 生效前仍可能收到 ready（复核 B4-A19）：ready 回调里先看锁，不拉内核、不开窗口
// 带了冒烟参数却不合规（缺 KWL_SMOKE=1、路径不合规或结果文件已存在）：直接以 3 退出，不进入正常界面、不写任何文件
if (smoke.rejected) app.exit(3);
const singleInstance = !smoke.rejected && app.requestSingleInstanceLock();
if (smoke.rejected) {
  // 已在退出
} else if (!singleInstance) {
  if (smoke.out) {
    try {
      writeSmokeResult(smoke.out, { ok: false, error: "already_running" });
    } catch {}
    app.exit(2);
  } else app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

/**
 * Windows：本机数据根设为“不编入内容索引”（隐私安全增量评审 P1-7）——事项数据虽是密文，文件名与少量元数据仍不应进入 Windows 搜索索引。
 * 两次调用（复核 B4-A09）：先标数据根本身，再标其下全部文件与子目录（`<根>\*` /S /D；直接对目录全路径加 /S 只会在父目录树里找同名项）。
 * 只在首次或应用版本变化时执行（标记文件记版本）。尽力而为：失败不影响启动（新文件是否继承该属性须在实机核对，登记在待核验清单）。
 */
function markNotContentIndexed() {
  if (process.platform !== "win32") return;
  const fs = require("node:fs");
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const marker = path.join(DATA_DIR, ".kwl-noindex");
    let done = "";
    try {
      done = fs.readFileSync(marker, "utf8").trim();
    } catch {
      done = "";
    }
    if (done === app.getVersion()) return;
    const attrib = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "attrib.exe");
    const { execFile } = require("node:child_process");
    execFile(attrib, ["+I", DATA_DIR], { windowsHide: true, timeout: 30_000 }, (e1) => {
      execFile(attrib, ["+I", path.join(DATA_DIR, "*"), "/S", "/D"], { windowsHide: true, timeout: 120_000 }, (e2) => {
        if (!e1 && !e2) {
          try {
            fs.writeFileSync(marker, app.getVersion());
          } catch {
            // 下次启动再试
          }
        }
      });
    });
  } catch {
    // 尽力而为
  }
}

/**
 * 旧数据位置（复核 B4-A10）：此前的开发与试用版本把数据放在漫游目录 %APPDATA%\KimiWorkLegal、主密钥包裹文件放在旧 userData
 * （%APPDATA%\Kimi Work 法律版\ledger-key）。新版本不读、不自动搬迁这些加密材料（会随漫游配置同步出本机），只提示一次 IT 处置办法。
 */
function legacyRoamingData() {
  if (process.platform !== "win32" || !process.env.APPDATA) return [];
  const fs = require("node:fs");
  return [path.join(process.env.APPDATA, "KimiWorkLegal"), path.join(process.env.APPDATA, "Kimi Work 法律版", "ledger-key")].filter((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}
function noticeLegacyData(win) {
  const found = legacyRoamingData();
  if (found.length === 0) return;
  const fs = require("node:fs");
  const marker = path.join(DATA_DIR, ".kwl-legacy-noticed");
  if (fs.existsSync(marker)) return;
  void dialog
    .showMessageBox(win, {
      type: "info",
      title: "发现旧版本的数据",
      message: "这台电脑上有旧版本留下的案件数据，位置会随漫游配置同步出本机。",
      detail:
        "新版本把数据放在本机目录，不会读取旧位置，所以这里看不到旧版本里的事项。\n\n" +
        "请联系所内 IT 处理：需要保留时，关闭应用后把旧数据迁到本机目录；确认不需要时删除旧位置。\n\n" +
        `旧位置：\n${found.join("\n")}`,
      buttons: ["知道了"],
    })
    .then(() => {
      try {
        fs.writeFileSync(marker, new Date().toISOString());
      } catch {
        // 下次启动再提示
      }
    });
}

app.whenReady().then(() => {
  if (!singleInstance) return;
  hardenSession(session.defaultSession);
  handleAppProtocol(session.defaultSession.protocol, path.join(__dirname, "../dist"), (f) => require("node:fs").promises.readFile(f));
  markNotContentIndexed();
  const rt = bundledRuntime();
  if (!rt.ok) {
    // 安装不完整或文件被改动（常见原因：杀毒软件隔离了随包组件）：不拉起内核，给出律师能照做的修复指引
    slog.event("MAIN_RUNTIME_PROBLEM", { count: rt.problems.length, stage: "startup" });
    if (smoke.out) {
      try {
        writeSmokeResult(smoke.out, { ok: false, error: "runtime", problems: rt.problems });
      } catch {}
      app.exit(1);
      return;
    }
    dialog.showErrorBox(
      "Kimi Work 法律版无法启动",
      "应用的部分组件缺失或已被改动，为保护您的案件数据，应用不会在这种状态下运行。\n\n" +
        "请：1）检查杀毒软件是否隔离了 Kimi Work 法律版的文件，恢复并加入信任；2）重新运行安装程序修复。\n\n" +
        `技术信息（供 IT 人员）：${rt.problems.slice(0, 5).join("；")}`,
    );
    app.quit();
    return;
  }
  // 安装包形态：全量摘要核验完成之前，内核不拉起随包子进程（复核 B4-R15）
  restart.runtimeEnv = { ...rt.env, ...(app.isPackaged ? { KWL_RUNTIME_VERIFY_PENDING: "1" } : {}) };
  runtimeManifest = rt.manifest ?? null;
  void startKernel();
  void verifyRuntimeInBackground(rt.manifest).then((problems) => {
    if (problems.length === 0) {
      runtimeVerifiedOk = true;
      sendRuntimeVerified();
    }
  });
  if (!smoke.out) {
    void verifyRuntimeInBackground(rt.manifest).then((problems) => {
      if (problems.length === 0) return;
      slog.event("MAIN_RUNTIME_PROBLEM", { count: problems.length, stage: "background" });
      void stopKernel().then(() => {
        dialog.showErrorBox(
          "Kimi Work 法律版需要修复",
          "应用的部分组件已被改动，为保护您的案件数据，应用已停止运行。\n\n" +
            "请：1）检查杀毒软件是否隔离或修改了 Kimi Work 法律版的文件，恢复并加入信任；2）重新运行安装程序修复。\n\n" +
            `技术信息（供 IT 人员）：${problems.slice(0, 5).join("；")}`,
        );
        app.quit();
      });
    });
  }
  wireIpc();
  const win = createWindow();
  if (smoke.out) {
    void runSmoke(win);
    return;
  }
  startUpdater();
  win.webContents.once("did-finish-load", () => noticeLegacyData(win));
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  restart.quitting = true;
  appExiting = true;
  if (restart.timer) clearTimeout(restart.timer);
});

/**
 * 开通或入组完成后按新身份重启内核：先有序关闭（闸门、宿主等子进程一并退出），再按 activation.json 拉起。
 * 编排在 identity-restart.cjs（复核 B13-K03）：应用退出或安装更新期间不再拉起；拉起失败广播 stopped。
 */
let identityRestarting = false;
/** 应用正在退出或安装更新（只增不减；before-quit、will-quit、kwl:update-install 置位）。 */
let appExiting = false;
/** 内核就绪消息报告的待激活模式（第 14 批：只有这时才接受“采用恢复的主密钥”）。 */
let kernelOnboarding = false;
const identityRestart = createIdentityRestart({
  stop: () => stopKernel(),
  start: async () => {
    restart.quitting = false;
    await startKernel();
  },
  exiting: () => appExiting,
  broadcast: (p) => broadcastStatus(p),
  onError: () => {
    kernelStopped = true;
    slog.event("MAIN_KERNEL_IDENTITY_RESTART_FAILED", {});
  },
});
async function restartKernelForIdentity() {
  if (identityRestarting) return;
  identityRestarting = true;
  try {
    await identityRestart.restart();
  } finally {
    identityRestarting = false;
  }
}

/**
 * 有序关闭内核（复核 B4-A13）：先请内核关闭闸门、Agent 宿主等子进程与账本，最多等 timeoutMs 再强制终止。
 * 退出与安装更新都走这里：强制终止内核会留下仍占用安装目录文件的随包 node.exe，NSIS 覆盖随之失败。
 */
function stopKernel(timeoutMs = 8_000) {
  restart.quitting = true;
  const k = kernel;
  if (!k) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        k.kill();
      } catch {
        // 已退出
      }
      if (kernel === k) kernel = null;
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    k.once("exit", finish);
    try {
      k.postMessage({ type: "kernel.shutdown" });
    } catch {
      finish();
    }
  });
}

let quitAfterKernel = false;
app.on("will-quit", (event) => {
  restart.quitting = true;
  appExiting = true;
  if (!kernel || quitAfterKernel) return;
  event.preventDefault();
  quitAfterKernel = true;
  void stopKernel().then(() => app.quit());
});
