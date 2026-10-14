/**
 * 渲染进程的地址策略（v9 第 04 篇 §1.2 约束 3、§5.1 ③；复核 S5-B14）：主进程网络层拦截、导航拦截与 IPC 来源核对共用这一份。
 * - 生产：只认本包 dist 目录内、主机为空的 file:// 地址（排除 file://host/share 这类 UNC——Windows 上即 SMB 外连）；
 * - 开发：另认 vite 开发服务与热更新；
 * - 一律放行：开发者工具、data:、blob:、about:blank、about:srcdoc（隔离预览框架）。
 * 纯函数（不依赖 electron），可在 Node 下单测。
 */
const path = require("node:path");
const { fileURLToPath } = require("node:url");

function createUrlPolicy({ appDist, isDev, devServer, devOrigins }) {
  const dist = path.resolve(appDist);
  function isAppFileUrl(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== "file:" || u.host !== "") return false;
      const p = path.resolve(fileURLToPath(u));
      return p === dist || p.startsWith(dist + path.sep);
    } catch {
      return false;
    }
  }
  function isDevUrl(url) {
    return isDev && devOrigins.some((o) => url === o || url.startsWith(`${o}/`));
  }
  /** 渲染会话的网络请求是否放行。 */
  function allowedRendererUrl(url) {
    if (url.startsWith("devtools://") || url.startsWith("data:") || url.startsWith("blob:") || url === "about:blank" || url === "about:srcdoc") return true;
    if (url.startsWith("file:")) return isAppFileUrl(url);
    return isDevUrl(url);
  }
  /** 主框架导航是否放行（只回到应用自身）。 */
  function allowedMainNavigation(url) {
    return isDev ? url === devServer || url.startsWith(`${devServer}/`) : isAppFileUrl(url);
  }
  return { isAppFileUrl, allowedRendererUrl, allowedMainNavigation };
}

module.exports = { createUrlPolicy };
