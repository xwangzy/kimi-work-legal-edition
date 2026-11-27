/** 最小 IPC 桥（§3：renderer 沙箱、无 Node；只暴露 invoke 与事件订阅）。 */
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("zrKernel", {
  platform: process.platform,
  /** 第 64 批：无边框窗口（界面顶部自绘 40px 拖动条；macOS 红绿灯、Windows 窗口控件浮层在其中）。 */
  frameless: process.platform === "darwin" || process.platform === "win32",
  /** 界面明暗变了：Windows 窗口控件浮层跟着换色（只收 light / dark）。 */
  setWindowTheme: (theme) => ipcRenderer.send("kwl:window-theme", theme === "dark" ? "dark" : "light"),
  /** 调用内核 API（§15.2 方法名）；失败抛出带 code 的 Error。 */
  invoke: async (method, params) => {
    const r = await ipcRenderer.invoke("kwl:invoke", method, params ?? {});
    if (!r || r.ok !== true) {
      const err = new Error(r?.error?.message ?? "内核调用失败");
      err.code = r?.error?.code ?? "internal";
      err.detail = r?.error?.detail;
      throw err;
    }
    return r.result;
  },
  /** 内核广播事件（run.settled 等）。 */
  onEvent: (cb) => {
    const listener = (_e, msg) => cb(msg);
    ipcRenderer.on("kwl:event", listener);
    return () => ipcRenderer.removeListener("kwl:event", listener);
  },
  /** 渲染会话被拦截的外部请求计数（设备页“唯一出口”的行为证据）。 */
  rendererNet: () => ipcRenderer.invoke("kwl:renderer-net"),
  /**
   * 第 72 批（A1 H5）：在应用内重拉内核（E1“还没有打开成功”、E5“还没有切换过去”、E6“后台服务没有启动起来”时先自动重试一次，
   * 仍不行再给“重试”按钮，不再让律师关闭并重新打开应用）。两次之间至少隔 15 秒。
   * 结果：{ ok: true, result: "restarted" } / { ok: false, result: "failed" | "skipped" } / { ok: false, reason: "too_soon", retry_after_ms } / { ok: false, reason: "exiting" }
   */
  restartKernel: () => ipcRenderer.invoke("kwl:restart-kernel"),
  /** 自动更新（W7）：状态与“重启并安装”（只在更新已下载并通过发布签名核验后可用）。 */
  updateStatus: () => ipcRenderer.invoke("kwl:update-status"),
  installUpdate: () => ipcRenderer.invoke("kwl:update-install"),
  /** 主进程文件对话框（v9.2 §3.7；Y5 P1-4）：不进“最近使用”；只回一次性句柄与文件名，渲染进程拿不到也不能指定路径。 */
  pickFiles: (o) => ipcRenderer.invoke("kwl:pick-files", o ?? {}),
  pickSave: (o) => ipcRenderer.invoke("kwl:pick-save", o ?? {}),
  /** 选文件夹（第 14 批：备份位置、从备份恢复）：同样只回一次性句柄与文件夹名。 */
  pickFolder: () => ipcRenderer.invoke("kwl:pick-folder"),
  saveText: (handle, text) => ipcRenderer.invoke("kwl:save-text", handle, text),
  /** 把 Word 成果导出成 PDF（第 29 批）：主进程选保存位置、打印、写文件；只回文件名与“打开”句柄。 */
  exportPdf: (artifactVersionId) => ipcRenderer.invoke("kwl:export-pdf", artifactVersionId),
  /** 用系统默认程序打开刚保存的成果（v9.4 第 21 批）：只认保存成功后主进程发的一次性句柄。 */
  openSaved: (handle) => ipcRenderer.invoke("kwl:open-saved", handle),
  /**
   * 拖放或文件框选中的文件 → 一次性句柄（复核 S5A-01）：路径只在 preload 与主进程之间（Electron 44 经 webUtils 从真实的 File 取得），
   * 页面拿不到也不能指定路径。
   */
  fileHandleFor: async (file) => {
    let p = "";
    try {
      p = webUtils.getPathForFile(file);
    } catch {
      p = "";
    }
    return p ? ipcRenderer.invoke("kwl:register-file", p) : null;
  },
});
