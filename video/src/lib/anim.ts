import { Easing, interpolate, spring } from "remotion";
import { FPS } from "../timeline";

/** 电影感缓动：大部分位移用 expo-out（快起慢停），镜头推拉用 inOut。 */
export const easeOut = Easing.bezier(0.16, 1, 0.3, 1);
export const easeInOut = Easing.bezier(0.65, 0, 0.35, 1);
export const easeIn = Easing.bezier(0.7, 0, 0.84, 0);
export const easeSoft = Easing.bezier(0.33, 0, 0.2, 1);

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** 0→1 进度（帧区间内），带缓动。 */
export function prog(frame: number, start: number, dur: number, easing = easeOut): number {
  if (dur <= 0) return frame >= start ? 1 : 0;
  return interpolate(frame, [start, start + dur], [0, 1], { ...clamp, easing });
}

/** 区间映射（带夹取）。 */
export function map(frame: number, input: number[], output: number[], easing = easeInOut): number {
  return interpolate(frame, input, output, { ...clamp, easing });
}

/** 淡入 → 保持 → 淡出。 */
export function inOut(frame: number, inStart: number, inDur: number, outStart: number, outDur: number): number {
  return Math.min(prog(frame, inStart, inDur), 1 - prog(frame, outStart, outDur, easeIn));
}

/** 弹簧（克制的阻尼，不要弹跳感）。 */
export function spr(frame: number, delay = 0, stiffness = 120, damping = 26, mass = 1): number {
  return spring({ frame: frame - delay, fps: FPS, config: { stiffness, damping, mass } });
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 关键帧插值：keys 按帧升序，每段用 inOut 缓动。 */
export interface Key {
  f: number;
  [k: string]: number;
}
export function keyed<K extends Key>(frame: number, keys: K[], prop: keyof K & string, easing = easeInOut): number {
  if (frame <= keys[0].f) return keys[0][prop] as number;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (frame <= b.f) {
      const t = interpolate(frame, [a.f, b.f], [0, 1], { ...clamp, easing });
      return lerp(a[prop] as number, b[prop] as number, t);
    }
  }
  return keys[keys.length - 1][prop] as number;
}

/** 逐字打出：返回 [已打出文本, 是否在打字中]。cps 为每秒字数。 */
export function typed(text: string, frame: number, start: number, cps = 14): [string, boolean] {
  const chars = Array.from(text);
  const n = Math.max(0, Math.min(chars.length, Math.floor(((frame - start) / FPS) * cps)));
  return [chars.slice(0, n).join(""), frame >= start && n < chars.length];
}

/** 打字结束帧。 */
export function typedEnd(text: string, start: number, cps = 14): number {
  return start + Math.ceil((Array.from(text).length / cps) * FPS);
}

/** 文字“显影”：从下方 + 模糊中浮现。 */
export function reveal(frame: number, start: number, dur = 22, dist = 26) {
  const p = prog(frame, start, dur);
  return { opacity: p, transform: `translateY(${(1 - p) * dist}px)`, filter: `blur(${(1 - p) * 10}px)` };
}

/** 文字“消散”。 */
export function vanish(frame: number, start: number, dur = 14, dist = -14) {
  const p = prog(frame, start, dur, easeIn);
  return { opacity: 1 - p, transform: `translateY(${p * dist}px)`, filter: `blur(${p * 8}px)` };
}

/** 可确定的伪随机（同一 seed 每帧一致）。 */
export function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}
