/** 最小 IPC 桥（§3：renderer 沙箱、无 Node；只暴露 invoke 与事件订阅）。 */
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("zrKernel", {
  platform: process.platform,
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
  /** 自动更新（W7）：状态与“重启并安装”（只在更新已下载并通过发布签名核验后可用）。 */
  updateStatus: () => ipcRenderer.invoke("kwl:update-status"),
  installUpdate: () => ipcRenderer.invoke("kwl:update-install"),
  /** 主进程文件对话框（v9.2 §3.7；Y5 P1-4）：不进“最近使用”；只回一次性句柄与文件名，渲染进程拿不到也不能指定路径。 */
  pickFiles: (o) => ipcRenderer.invoke("kwl:pick-files", o ?? {}),
  pickSave: (o) => ipcRenderer.invoke("kwl:pick-save", o ?? {}),
  /** 选文件夹（第 14 批：备份位置、从备份恢复）：同样只回一次性句柄与文件夹名。 */
  pickFolder: () => ipcRenderer.invoke("kwl:pick-folder"),
  saveText: (handle, text) => ipcRenderer.invoke("kwl:save-text", handle, text),
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
