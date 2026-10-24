/**
 * 真实界面快照：把采集自产品的 DOM（src/snaps）放进 1440×900 的 .kw 容器，由快照的真实样式渲染。
 * 每帧先还原快照、再执行 edit(root, frame) 做“演示态”改动（打字、勾选、显隐、滚动……），
 * 所以 edit 只需按当前帧把状态写全，不依赖前一帧——Remotion 并行乱序渲染帧时结果也一致。
 * 容器带一个空 transform，让快照里 position: fixed 的弹窗、遮罩以容器（而不是整张画面）为定位基准。
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { continueRender, delayRender, useCurrentFrame } from "remotion";
import { SNAPS, type SnapName } from "../snaps";

export type SnapEdit = (root: HTMLElement, f: number) => void;

export function Snap({ name, edit, style, className }: { name: SnapName; edit?: SnapEdit; style?: CSSProperties; className?: string }) {
  const f = useCurrentFrame();
  const ref = useRef<HTMLDivElement>(null);
  const s = SNAPS[name];
  // 字体没加载完时排版偏矮，edit 里的滚动位置会被夹到 0：先等字体就绪再出这一帧
  const [fontsReady, setFontsReady] = useState(() => document.fonts.status === "loaded");
  useEffect(() => {
    if (fontsReady) return;
    const h = delayRender("等待字体");
    document.fonts.ready.then(() => {
      setFontsReady(true);
      continueRender(h);
    });
  }, [fontsReady]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = s.html;
    edit?.(el, f);
  }, [s, edit, f, fontsReady]);
  return <div ref={ref} className={`kw${s.theme === "dark" ? " kw-dark" : ""}${className ? ` ${className}` : ""}`} style={{ position: "absolute", left: 0, top: 0, width: 1440, height: 900, overflow: "hidden", transform: "translate(0px, 0px)", ...style }} />;
}

/* ───────── edit 用的小工具：都按“当前帧写全状态”的方式使用 ───────── */

/** 查一个元素（找不到时返回 null，不抛错：快照里结构变了就让画面少一个动作，而不是整片渲染失败）。 */
export const q = (root: ParentNode, sel: string) => root.querySelector<HTMLElement>(sel);
export const qa = (root: ParentNode, sel: string) => [...root.querySelectorAll<HTMLElement>(sel)];
/** 按文字找元素：sel 范围内 textContent 含 text 的最内层元素。 */
export function byText(root: ParentNode, sel: string, text: string | RegExp): HTMLElement | null {
  const hits = qa(root, sel).filter((e) => (typeof text === "string" ? e.textContent?.includes(text) : text.test(e.textContent ?? "")));
  return hits.find((e) => !hits.some((o) => o !== e && e.contains(o))) ?? hits[0] ?? null;
}
export function css(el: HTMLElement | null | undefined, s: Partial<CSSStyleDeclaration> | Record<string, string | number>) {
  if (!el) return;
  for (const [k, v] of Object.entries(s)) (el.style as unknown as Record<string, string>)[k] = String(v);
}
/** 元素在快照坐标系（1440×900）里的矩形。 */
export function rectIn(root: HTMLElement, el: Element | null) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const o = root.getBoundingClientRect();
  const k = o.width / root.offsetWidth || 1;
  return { x: (r.left - o.left) / k, y: (r.top - o.top) / k, w: r.width / k, h: r.height / k };
}

/** 快照局部：只显示 rect（快照坐标）那一块，按 scale 缩放。用于把真实界面的一个区域单独拿出来做特写。 */
export function SnapCrop({ name, rect, scale = 1, edit, radius = 14, style }: { name: SnapName; rect: { x: number; y: number; w: number; h: number }; scale?: number; edit?: SnapEdit; radius?: number; style?: CSSProperties }) {
  return (
    <div style={{ position: "relative", width: rect.w * scale, height: rect.h * scale, overflow: "hidden", borderRadius: radius, ...style }}>
      <div style={{ position: "absolute", left: 0, top: 0, width: 1440, height: 900, transform: `scale(${scale}) translate(${-rect.x}px, ${-rect.y}px)`, transformOrigin: "0 0" }}>
        <Snap name={name} edit={edit} />
      </div>
    </div>
  );
}
