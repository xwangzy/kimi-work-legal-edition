/**
 * 安装包形态的界面加固（第 60 批安全加固 H4；审计 11 文第 6 项）。纯函数，可在 Node 下单测。
 *
 * - 开发者工具：正式包（release.json 未标 test_build）不允许打开——没有菜单项、快捷键无效（webPreferences.devTools=false）。
 *   界面里能做的事内核都另行核验；关掉开发者工具是为了不让“走到电脑前的人”绕过只在界面层做的提示与限制、查看页面内的令牌与数据。
 *   测试/演示包与开发形态保留（排错用）。
 * - 应用菜单：安装包一律换成精简菜单——不含“切换开发者工具”“强制重新载入”（Electron 缺省菜单有这两项）；
 *   macOS 保留应用、编辑（复制粘贴快捷键靠它）与窗口三组，Windows 不显示菜单栏（文本框的复制粘贴由 Chromium 自带处理）。
 * - 远程调试开关（--remote-debugging-port）：本批不拦——正式安装包的端到端验收靠它驱动真实界面（第 54、59、60 批）。
 *   能以本人身份启动程序的本机进程本就能读本人的文件与 DPAPI 数据，这一层残余风险写在研究记录 V34 的剩余风险里。
 */

/** 是否允许开发者工具：开发形态（未打包）或测试/演示包。 */
function devToolsAllowed({ isPackaged, testBuild }) {
  return !isPackaged || testBuild === true;
}

/** 安装包的应用菜单模板（Menu.buildFromTemplate 的输入）；Windows/Linux 返回 null（不显示菜单栏）。 */
function appMenuTemplate(platform, appName) {
  if (platform !== "darwin") return null;
  return [
    {
      label: appName,
      submenu: [{ role: "about", label: `关于 ${appName}` }, { type: "separator" }, { role: "hide", label: `隐藏 ${appName}` }, { role: "hideOthers", label: "隐藏其他" }, { role: "unhide", label: "全部显示" }, { type: "separator" }, { role: "quit", label: `退出 ${appName}` }],
    },
    {
      label: "编辑",
      submenu: [{ role: "undo", label: "撤销" }, { role: "redo", label: "重做" }, { type: "separator" }, { role: "cut", label: "剪切" }, { role: "copy", label: "拷贝" }, { role: "paste", label: "粘贴" }, { role: "pasteAndMatchStyle", label: "粘贴并匹配样式" }, { role: "selectAll", label: "全选" }],
    },
    {
      label: "窗口",
      submenu: [{ role: "minimize", label: "最小化" }, { role: "zoom", label: "缩放" }, { type: "separator" }, { role: "front", label: "前置全部窗口" }, { role: "close", label: "关闭窗口" }],
    },
  ];
}

/** 模板里是否含开发者工具或强制重载一类的项（用例与自检用）。 */
function menuHasDebugItems(template) {
  const bad = new Set(["toggleDevTools", "reload", "forceReload"]);
  const walk = (items) => (items ?? []).some((i) => bad.has(i.role) || walk(Array.isArray(i.submenu) ? i.submenu : []));
  return walk(template ?? []);
}

module.exports = { devToolsAllowed, appMenuTemplate, menuHasDebugItems };
