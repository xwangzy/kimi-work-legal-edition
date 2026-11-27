/**
 * 图标线宽按设备像素比对齐（第 72 批，D-300 第 4 条；A2 §1.4 D）。
 * 原先 24 网格、strokeWidth 1.7 按 16～18px 显示，线宽约 1.1～1.3 CSS px：125% / 150% 缩放下落到 1.6 / 1.9 个物理像素，线条发灰发虚。
 * 现在图标用 non-scaling-stroke（线宽按 CSS 像素算、不随图标尺寸缩放），线宽取“约 1.4 CSS px 对齐到整数物理像素”：
 *   1x → 1、1.25x → 1.6、1.5x → 1.333、2x → 1.5（CSS px），即 1 / 2 / 2 / 3 个物理像素。
 * 写到 <html> 的 --icon-stroke；缩放（系统缩放、界面字号缩放）变化时重算。
 */
export function iconStrokeFor(dpr: number): number {
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return Math.max(1, Math.round(1.4 * d)) / d;
}

export function applyIconStroke(win: Window = window): void {
  const root = win.document.documentElement;
  const apply = () => {
    const dpr = win.devicePixelRatio || 1;
    root.style.setProperty("--icon-stroke", `${Number(iconStrokeFor(dpr).toFixed(3))}px`);
    // 只在“当前这个像素比”变化时触发一次，触发后按新像素比重新挂
    const mq = win.matchMedia?.(`(resolution: ${dpr}dppx)`);
    mq?.addEventListener?.("change", apply, { once: true });
  };
  apply();
}
