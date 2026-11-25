/**
 * 无边框窗口的界面一侧（第 64 批）：在 <html> 上标 frameless 与平台（plat-darwin / plat-win32），styles-window.css 据此
 * 留出顶部 40px 拖动条、给 macOS 红绿灯与 Windows 窗口控件让位；界面明暗变了通知主进程给 Windows 控件浮层换色。
 * 网页开发形态（浏览器里的开发桥）没有 zrKernel，什么都不做。
 */
export function applyWindowChrome(w: { zrKernel?: { frameless?: boolean; platform?: string; setWindowTheme?: (t: "light" | "dark") => void } } = window, doc: Document = document): void {
  const k = w.zrKernel;
  if (!k?.frameless) return;
  const root = doc.documentElement;
  root.classList.add("frameless", `plat-${k.platform === "darwin" ? "darwin" : k.platform === "win32" ? "win32" : "other"}`);
  if (!k.setWindowTheme) return;
  let last = "";
  const sync = () => {
    const t = root.dataset.theme === "dark" ? "dark" : "light";
    if (t === last) return;
    last = t;
    k.setWindowTheme!(t);
  };
  sync();
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
}
