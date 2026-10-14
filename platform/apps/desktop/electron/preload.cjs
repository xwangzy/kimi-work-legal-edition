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
  /** Electron 44：File.path 已移除，经 webUtils 取拖拽/选择文件的本机路径（挂载/导入用）。 */
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
});
