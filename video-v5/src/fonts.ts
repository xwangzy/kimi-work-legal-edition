/**
 * 片中自有排版的字体（全部 SIL Open Font License 1.1，可商用、可嵌入视频）：
 *  - Noto Sans SC（思源黑体）：标题、字幕、标签
 *  - Noto Serif SC（思源宋体）：纸张上的合同、法条、判决（与产品文书的宋体气质一致）
 *  - Inter：英文与数字
 * 产品界面快照内部保持产品自己的字体栈，不受这里影响。
 * fontsource 按 unicode-range 分片，只有用到的字才会加载；waitFonts() 在出帧前把要用的字形全部加载完。
 */
import "@fontsource/noto-sans-sc/300.css";
import "@fontsource/noto-sans-sc/400.css";
import "@fontsource/noto-sans-sc/500.css";
import "@fontsource/noto-sans-sc/700.css";
import "@fontsource/noto-serif-sc/400.css";
import "@fontsource/noto-serif-sc/600.css";
import "@fontsource/noto-serif-sc/700.css";
import "@fontsource/inter/300.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import { useEffect, useState } from "react";
import { continueRender, delayRender } from "remotion";

export const FONT_TITLE = `"Inter", "Noto Sans SC", sans-serif`;
export const FONT_SERIF = `"Noto Serif SC", serif`;
export const FONT_LATIN = `"Inter", sans-serif`;

const cache = new Map<string, Promise<unknown>>();
/** 预加载：specs 形如 '700 64px "Noto Sans SC"'，text 为要用到的字。 */
export function loadGlyphs(specs: string[], text: string) {
  const key = specs.join("|") + "::" + text;
  if (!cache.has(key)) cache.set(key, Promise.all(specs.map((sp) => document.fonts.load(sp, text))).then(() => document.fonts.ready));
  return cache.get(key)!;
}

const ALL_SPECS = [
  '300 40px "Noto Sans SC"',
  '400 40px "Noto Sans SC"',
  '500 40px "Noto Sans SC"',
  '700 40px "Noto Sans SC"',
  '400 40px "Noto Serif SC"',
  '600 40px "Noto Serif SC"',
  '700 40px "Noto Serif SC"',
  '300 40px "Inter"',
  '400 40px "Inter"',
  '500 40px "Inter"',
  '600 40px "Inter"',
];

/** 组件里调用：在 text 的字形加载完之前挂起这一帧。 */
export function useGlyphs(text: string) {
  const [h] = useState(() => delayRender(`字体 ${text.slice(0, 12)}`));
  useEffect(() => {
    loadGlyphs(ALL_SPECS, text).then(() => continueRender(h), () => continueRender(h));
  }, [h, text]);
}
