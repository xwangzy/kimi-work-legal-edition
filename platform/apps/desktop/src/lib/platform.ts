/**
 * 运行平台（第 72 批，D-300 第 4 条）：快捷键写法（⌘ / Ctrl）与快捷键判定统一读 preload 给的 platform，不再用已弃用的 navigator.platform。
 * 顺序：preload（桌面端）→ <html> 上的 plat-* 类（window-chrome.ts 打的，与上一条同源）→ 网页开发形态按 userAgent 猜。
 */
import { windowBridge } from "../api.ts";

export type HostPlatform = "darwin" | "win32" | "other";

export function hostPlatform(bridge: { zrKernel?: { platform?: string } } = typeof window === "undefined" ? {} : windowBridge(), doc: Document | null = typeof document === "undefined" ? null : document, ua = typeof navigator === "undefined" ? "" : navigator.userAgent): HostPlatform {
  const p = bridge.zrKernel?.platform;
  if (p) return p === "darwin" ? "darwin" : p === "win32" ? "win32" : "other";
  const cls = doc?.documentElement?.classList;
  if (cls?.contains("plat-darwin")) return "darwin";
  if (cls?.contains("plat-win32")) return "win32";
  return /Mac OS X|Macintosh/i.test(ua) ? "darwin" : /Windows/i.test(ua) ? "win32" : "other";
}

/** 修饰键的写法：macOS 写 ⌘，其余写 Ctrl。 */
export function modKeyLabel(p: HostPlatform = hostPlatform()): string {
  return p === "darwin" ? "⌘" : "Ctrl";
}

/** 这次按键是不是“修饰键 + 字母”：macOS 只认 ⌘（文本框里系统自带的 Ctrl + K 是删除到行尾），其余系统认 Ctrl。 */
export function isModKey(e: { metaKey: boolean; ctrlKey: boolean }, p: HostPlatform = hostPlatform()): boolean {
  return p === "darwin" ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}
