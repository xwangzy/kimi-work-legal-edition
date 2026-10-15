/**
 * 界面偏好（设置 → 通用；UIUX 增量评审 ST-5、Y4 #32）：字号与外观。只存在本机浏览器存储（键已登记在 docs/privacy/residency.json），
 * 读写失败一律按标准字号、跟随系统。
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

export const UI_THEME_KEY = "kwl.ui.theme";
export type UiTheme = "system" | "light" | "dark";
export const UI_THEME_OPTIONS: readonly { value: UiTheme; label: string }[] = Object.freeze([
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
]);

export function readUiTheme(): UiTheme {
  try {
    const v = window.localStorage.getItem(UI_THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

/** 实际生效的明暗：显式选择优先，否则看系统设置（取不到按浅色）。 */
export function resolveTheme(pref: UiTheme, systemDark: boolean): "light" | "dark" {
  return pref === "system" ? (systemDark ? "dark" : "light") : pref;
}

function systemDarkQuery(): MediaQueryList | null {
  try {
    return window.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
  } catch {
    return null;
  }
}

let themePref: UiTheme = "system";
let themeWatch = false;

/**
 * 应用外观：在 <html> 上写 data-theme（令牌层据此切换语义色，tokens.css）；跟随系统时监听系统切换。
 * persist 为 true 时记住选择（跟随系统 = 删除键）。
 */
export function applyUiTheme(pref: UiTheme, persist = false): void {
  themePref = UI_THEME_OPTIONS.some((o) => o.value === pref) ? pref : "system";
  const q = systemDarkQuery();
  document.documentElement.dataset.theme = resolveTheme(themePref, q?.matches ?? false);
  if (!themeWatch) {
    themeWatch = true;
    q?.addEventListener?.("change", () => {
      if (themePref === "system") document.documentElement.dataset.theme = resolveTheme("system", q.matches);
    });
    // 打印（“数据去向说明”另存 PDF 给客户等）一律按浅色：深色下浅字印在白纸上看不清
    window.addEventListener("beforeprint", () => {
      document.documentElement.dataset.theme = "light";
    });
    window.addEventListener("afterprint", () => {
      document.documentElement.dataset.theme = resolveTheme(themePref, systemDarkQuery()?.matches ?? false);
    });
  }
  if (!persist) return;
  try {
    if (themePref === "system") window.localStorage.removeItem(UI_THEME_KEY);
    else window.localStorage.setItem(UI_THEME_KEY, themePref);
  } catch {
    // 存不下：本次生效，下次启动回到跟随系统
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
