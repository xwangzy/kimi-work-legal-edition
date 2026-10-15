/**
 * 渲染进程的地址策略（v9 第 04 篇 §1.2 约束 3、§5.1 ③；复核 S5-B14、B4-A03）：主进程网络层拦截、导航拦截与 IPC 来源核对共用这一份。
 * - 生产：只认应用协议 kwl://app/（app-protocol.cjs 只读本包 dist 内文件）；任何 file:// 地址一律拦截——
 *   界面不再从 file:// 加载（熔断关闭 file 额外特权后模块脚本被拦），也就不必再为 UNC（file://host/share，即 SMB 外连）开口子；
 * - 开发：另认 vite 开发服务与热更新；
 * - 一律放行：开发者工具、data:、blob:、about:blank、about:srcdoc（隔离预览框架）。
 * 纯函数（不依赖 electron），可在 Node 下单测。
 */
const { APP_ORIGIN } = require("./app-protocol.cjs");

function createUrlPolicy({ isDev, devServer, devOrigins }) {
  function isAppUrl(url) {
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.host}` === APP_ORIGIN && u.username === "" && u.password === "" && u.port === "";
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
    if (isAppUrl(url)) return true;
    return isDevUrl(url);
  }
  /** 主框架导航是否放行（只回到应用自身）。 */
  function allowedMainNavigation(url) {
    return isDev ? url === devServer || url.startsWith(`${devServer}/`) : isAppUrl(url);
  }
  return { isAppUrl, allowedRendererUrl, allowedMainNavigation };
}

module.exports = { createUrlPolicy };
