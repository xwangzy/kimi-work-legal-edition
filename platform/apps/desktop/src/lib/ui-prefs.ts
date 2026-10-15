/**
 * 界面偏好（设置 → 通用；UIUX 增量评审 ST-5）：字号。只存在本机浏览器存储（键已登记在 docs/privacy/residency.json），读写失败一律按标准字号。
 */
export const UI_ZOOM_KEY = "kwl.ui.zoom";
export const UI_ZOOM_OPTIONS: readonly { value: number; label: string }[] = Object.freeze([
  { value: 1, label: "标准" },
  { value: 1.12, label: "大" },
  { value: 1.25, label: "特大" },
]);

export function readUiZoom(): number {
  try {
    const v = Number(window.localStorage.getItem(UI_ZOOM_KEY));
    return UI_ZOOM_OPTIONS.some((o) => o.value === v) ? v : 1;
  } catch {
    return 1;
  }
}

/** 应用字号（CSS zoom 作用于整个界面）；persist 为 true 时记住选择。 */
export function applyUiZoom(v: number, persist = false): void {
  const z = UI_ZOOM_OPTIONS.some((o) => o.value === v) ? v : 1;
  document.documentElement.style.setProperty("zoom", z === 1 ? "" : String(z));
  if (!persist) return;
  try {
    if (z === 1) window.localStorage.removeItem(UI_ZOOM_KEY);
    else window.localStorage.setItem(UI_ZOOM_KEY, String(z));
  } catch {
    // 存不下：本次生效，下次启动回到标准
  }
}

/** 脚本发起的滚动是否平滑：系统“减少动画”时直接跳到位置（Y4 V-11；CSS 的 reduced-motion 规则管不到 scrollIntoView，复核 S7B-10）。 */
export function scrollBehavior(): ScrollBehavior {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  } catch {
    return "smooth";
  }
}
