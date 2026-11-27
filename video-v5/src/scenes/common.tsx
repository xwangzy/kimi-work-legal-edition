/** 场景共用：按帧选快照、输入框打字（带光标）、滚动模拟、只显示某个元素。 */
import type { SnapName } from "../snaps";
import { q, qa, shiftChildren } from "../ui/Snap";

/** states: [起始帧, 快照名]，按帧取当前快照。 */
export function pick<T extends string>(f: number, states: [number, T][]): T {
  let cur = states[0][1];
  for (const [at, n] of states) if (f >= at) cur = n;
  return cur;
}
export const asSnap = (x: string) => x as SnapName;

/** 带交叉溶解的选快照：返回当前、上一张与溶解进度（xf 帧内从上一张溶到当前）。 */
export function pickX<T extends string>(f: number, states: [number, T][], xf = 10): { name: T; prev: T | null; mix: number } {
  let i = 0;
  for (let k = 0; k < states.length; k++) if (f >= states[k][0]) i = k;
  const [at, name] = states[i];
  const prev = i > 0 ? states[i - 1][1] : null;
  const t = Math.min(1, Math.max(0, (f - at) / xf));
  const mix = t * t * (3 - 2 * t);
  return { name, prev, mix };
}

/**
 * 在快照的输入框里打字：把 textarea 换成同样式的 div（才能放闪烁的光标）。
 * caret：是否显示光标；f 用来算闪烁。
 */
export function typeInto(root: HTMLElement, sel: string, text: string, f: number, caret = true) {
  const ta = q(root, sel) as HTMLTextAreaElement | null;
  if (!ta) return;
  const cs = getComputedStyle(ta);
  const d = document.createElement("div");
  d.className = ta.className;
  for (const k of ["fontSize", "fontFamily", "fontWeight", "lineHeight", "letterSpacing", "padding", "color", "width", "minHeight", "boxSizing", "border", "background"] as const) (d.style as unknown as Record<string, string>)[k] = (cs as unknown as Record<string, string>)[k];
  d.style.height = cs.height;
  d.style.whiteSpace = "pre-wrap";
  d.style.overflow = "hidden";
  d.textContent = text;
  if (!text) {
    const ph = document.createElement("span");
    ph.textContent = ta.getAttribute("placeholder") ?? "";
    ph.style.color = "var(--text-3, #9a978f)";
    d.appendChild(ph);
  }
  if (caret && Math.floor(f / 30) % 2 === 0) {
    const c = document.createElement("span");
    c.style.cssText = "display:inline-block;width:2px;height:1.15em;margin-left:1px;vertical-align:-0.18em;background:#1783ff;border-radius:1px";
    if (text) d.appendChild(c);
    else d.insertBefore(c, d.firstChild);
  }
  ta.replaceWith(d);
}

/** 把滚动容器里的内容整体上移 y（模拟滚动；与 Snap 对 data-film-scroll 的处理同法）。 */
export function scrollTo(root: HTMLElement, sel: string, y: number) {
  const sc = q(root, sel);
  if (sc) shiftChildren(sc, y);
}
export function scrollMarked(root: HTMLElement, y: number) {
  for (const sc of qa(root, "[data-film-scroll]")) shiftChildren(sc, y);
}

/** 只显示 sel 选中的元素（其余 visibility: hidden）——分层展开用。 */
export function only(root: HTMLElement, sels: string[]) {
  root.style.visibility = "hidden";
  for (const s of sels) for (const e of qa(root, s)) e.style.visibility = "visible";
}
/** 隐藏 sel 选中的元素。 */
export function hide(root: HTMLElement, sels: string[]) {
  for (const s of sels) for (const e of qa(root, s)) e.style.visibility = "hidden";
}
