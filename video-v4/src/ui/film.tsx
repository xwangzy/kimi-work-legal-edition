/**
 * V4 片场元件：背景、标题排版、光标、品牌标识、3D 产品窗口与镜头。
 * 视觉原则（继承 V1）：暖白摄影棚 + 近黑夜色；左侧两行大字；窗口悬浮、透视让位；
 * 唯一的“特效”母题是 Kimi 标识里的蓝点。不用科技线条、粒子、数字雨、过度发光与 3D 地球。
 * 所有动画按“当前帧写全状态”，乱序并行渲染结果一致。时间单位：帧（60 fps）。
 */
import { createContext, useContext, type CSSProperties, type ReactNode } from "react";
import { AbsoluteFill, Easing, interpolate, staticFile, useCurrentFrame } from "remotion";
import { FONT_LATIN, FONT_TITLE, useGlyphs } from "../fonts";
import { FPS } from "../timeline";
import { SNAPS, type SnapName } from "../snaps";
import { Snap, type SnapEdit } from "./Snap";

/* ───────── 缓动与插值 ───────── */
export const easeOut = Easing.bezier(0.16, 1, 0.3, 1); // expo-out：快起慢停
export const easeInOut = Easing.bezier(0.65, 0, 0.35, 1);
export const easeIn = Easing.bezier(0.7, 0, 0.84, 0);
export const easeSoft = Easing.bezier(0.33, 0, 0.2, 1);
export const easeCine = Easing.bezier(0.45, 0, 0.15, 1); // 镜头：慢起、长尾
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
export const sec = (x: number) => Math.round(x * FPS);
export function prog(f: number, start: number, dur: number, easing = easeOut) {
  if (dur <= 0) return f >= start ? 1 : 0;
  return interpolate(f, [start, start + dur], [0, 1], { ...clamp, easing });
}
export function map(f: number, input: number[], output: number[], easing = easeInOut) {
  return interpolate(f, input, output, { ...clamp, easing });
}
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export function rand(seed: number) {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}
export interface Key {
  f: number;
  [k: string]: number;
}
export function keyed<K extends Key>(f: number, keys: K[], prop: keyof K & string, easing = easeInOut): number {
  if (f <= keys[0].f) return keys[0][prop] as number;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (f <= b.f) return lerp(a[prop] as number, b[prop] as number, interpolate(f, [a.f, b.f], [0, 1], { ...clamp, easing }));
  }
  return keys[keys.length - 1][prop] as number;
}
/** 逐字打出：返回 [已打出文本, 是否在打字中]。cps 为每秒字数。 */
export function typed(text: string, f: number, start: number, cps = 12): [string, boolean] {
  const chars = Array.from(text);
  const n = Math.max(0, Math.min(chars.length, Math.floor(((f - start) / FPS) * cps)));
  return [chars.slice(0, n).join(""), f >= start && n < chars.length];
}
export const typedEnd = (text: string, start: number, cps = 12) => start + Math.ceil((Array.from(text).length / cps) * FPS);

/* ───────── 颜色 ───────── */
export const INK = "#0e1219";
export const INK2 = "#5d5a55";
export const STUDIO = "#f3f2ef";
export const NIGHT = "#07080a";
export const KIMI_BLUE = "#1783ff";

/* ───────── 背景 ───────── */

/** 暖白摄影棚：主光从上方偏左打下，四周自然衰减，地面一道极淡的反光带。 */
export function StudioBackdrop({ tone = 1, cx = 50, cy = 36, floor = 1 }: { tone?: number; cx?: number; cy?: number; floor?: number }) {
  return (
    <AbsoluteFill style={{ opacity: tone }}>
      <AbsoluteFill style={{ background: `radial-gradient(120% 100% at ${cx}% ${cy}%, #ffffff 0%, #f7f6f3 38%, #ebe9e4 78%, #e2dfd9 100%)` }} />
      <AbsoluteFill style={{ opacity: floor, background: "linear-gradient(180deg, rgba(255,255,255,0) 64%, rgba(255,255,255,0.32) 80%, rgba(222,219,212,0.5) 100%)" }} />
    </AbsoluteFill>
  );
}

/** 夜色：近黑 + 一束极弱的顶光（可移动、可调色温）。 */
export function NightBackdrop({ glow = 1, gx = 50, gy = 28, tint = "255,248,236", size = 62 }: { glow?: number; gx?: number; gy?: number; tint?: string; size?: number }) {
  return (
    <AbsoluteFill style={{ background: NIGHT }}>
      <AbsoluteFill style={{ background: `radial-gradient(${size}% ${size * 0.95}% at ${gx}% ${gy}%, rgba(${tint},${0.09 * glow}) 0%, rgba(${tint},${0.03 * glow}) 45%, rgba(${tint},0) 75%)` }} />
    </AbsoluteFill>
  );
}

export function Vignette({ strength = 0.3, dark = false }: { strength?: number; dark?: boolean }) {
  const c = dark ? "0,0,0" : "58,50,40";
  return <AbsoluteFill style={{ pointerEvents: "none", background: `radial-gradient(130% 100% at 50% 46%, rgba(${c},0) 56%, rgba(${c},${strength}) 100%)` }} />;
}

/** 细颗粒：静态噪声纹理（public/textures/grain.png）每帧换位，避免大面积渐变起色带。 */
export function Grain({ opacity = 0.05 }: { opacity?: number }) {
  const f = useCurrentFrame();
  const k = Math.floor(f / 2) % 8;
  const x = Math.floor(rand(k * 3.7) * 512);
  const y = Math.floor(rand(k * 9.1) * 512);
  return <AbsoluteFill style={{ pointerEvents: "none", opacity, mixBlendMode: "overlay", backgroundImage: `url(${staticFile("textures/grain.png")})`, backgroundSize: "512px 512px", backgroundPosition: `${x}px ${y}px` }} />;
}

/* ───────── 品牌（与产品 components/Brand.tsx 同一组路径：Kimi 官方 Logomark，未改形） ───────── */
export const MARK_DOT = "M139.13 36.5137C144.237 36.5137 148.377 40.6535 148.377 45.7602C148.377 50.867 144.237 55.0068 139.13 55.0068L130.972 55.0068C130.371 55.0068 129.884 54.5198 129.884 53.919L129.884 45.7602C129.884 40.6535 134.024 36.5137 139.13 36.5137Z";
export const MARK_K =
  "M87.2905 90.3594L122.186 55.739C122.842 55.0865 122.473 53.7744 121.625 53.7744H102.848C102.644 53.7744 102.447 53.8577 102.288 54.0174L64.6898 91.3104C64.1035 91.8866 63.2366 91.3729 63.2366 90.4496V54.8782C63.2366 54.2673 62.8351 53.7744 62.3443 53.7744H49.406C48.9152 53.7744 48.5137 54.2673 48.5137 54.8782V131.575C48.5137 132.186 48.9152 132.679 49.406 132.679H62.3443C62.8351 132.679 63.2366 132.186 63.2366 131.575V115.948C63.2366 115.615 63.3577 115.295 63.5681 115.087L75.2254 103.522C75.5058 103.244 75.8946 103.202 76.2069 103.411L107.386 126.354C112.492 129.791 118.196 131.901 123.99 132.526C124.506 132.581 124.952 132.068 124.952 131.422V116.705C124.952 116.142 124.614 115.684 124.162 115.615C120.752 115.08 117.425 113.761 114.417 111.734L87.4244 92.1921C86.8635 91.8172 86.7934 90.8523 87.2905 90.3594Z";
/** 蓝点在 180×180 标识里的中心。 */
export const DOT_C = { x: 139.13, y: 45.76, r: 9.25 };

export function KimiMark({ size, bg = 1, k = 1, dot = 1, dark = false, style }: { size: number; bg?: number; k?: number; dot?: number; dark?: boolean; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 180 180" style={{ display: "block", overflow: "visible", ...style }}>
      <rect width="180" height="180" rx="45" fill={dark ? "#ffffff" : "#000000"} opacity={bg} />
      <path d={MARK_K} fill={dark ? "#000000" : "#ffffff"} opacity={k} />
      <path d={MARK_DOT} fill={KIMI_BLUE} opacity={dot} />
    </svg>
  );
}

/** 只有蓝点（与标识里同一形状），glow 为外晕强度。 */
export function KimiDot({ size, glow = 0, style }: { size: number; glow?: number; style?: CSSProperties }) {
  return (
    <div style={{ position: "absolute", width: size, height: size, ...style }}>
      {glow > 0 && (
        <div
          style={{
            position: "absolute",
            left: -size * 2.2,
            top: -size * 2.2,
            width: size * 5.4,
            height: size * 5.4,
            borderRadius: "50%",
            background: `radial-gradient(circle, rgba(23,131,255,${0.34 * glow}) 0%, rgba(23,131,255,${0.1 * glow}) 34%, rgba(23,131,255,0) 68%)`,
          }}
        />
      )}
      <svg width={size} height={size} viewBox="129.6 36.3 19 19" style={{ position: "absolute", inset: 0 }}>
        <path d={MARK_DOT} fill={KIMI_BLUE} />
      </svg>
    </div>
  );
}

/** “法律版”黑底小标（与产品 EditionTag 同一画法）。 */
export function EditionTag({ h = 17, dark = false, text = "法律版" }: { h?: number; dark?: boolean; text?: string }) {
  const chars = [...text].length;
  const w = Math.round(chars * 11.5 + 9);
  return (
    <svg width={(w * h) / 17} height={h} viewBox={`0 0 ${w} 17`} style={{ display: "block" }}>
      <rect width={w} height={17} rx={4.5} fill={dark ? "#f4f3f0" : "#0e1219"} />
      <text x={w / 2} y={12.4} textAnchor="middle" fontSize="10.5" fontWeight="600" textLength={w - 10} lengthAdjust="spacing" fill={dark ? "#0e1219" : "#ffffff"} fontFamily={`BlinkMacSystemFont, -apple-system, "PingFang SC", sans-serif`}>
        {text}
      </text>
    </svg>
  );
}

/** 产品名字标“Kimi Work”（与产品首页中央字标同一画法：系统字体 800、宽度定死）。 */
export function Wordmark({ h, color = INK, style }: { h: number; color?: string; style?: CSSProperties }) {
  return (
    <svg width={(236 * h) / 52} height={h} viewBox="0 0 236 52" style={{ display: "block", overflow: "visible", ...style }}>
      <text x="0" y="44" fill={color} fontSize="50" fontWeight="800" textLength="234" lengthAdjust="spacing" fontFamily={`BlinkMacSystemFont, -apple-system, "Helvetica Neue", Arial, sans-serif`}>
        Kimi Work
      </text>
    </svg>
  );
}

/* ───────── 标题排版 ───────── */

/**
 * 章节标题（V1 版式的升级）：小号章节标签 + 一到两行主句（自遮罩中逐行升起）+ 灰色副句。
 * 退场：逐行上移淡出。at / out 为帧（场景内）。
 */
export function Title({
  eyebrow,
  lines,
  sub,
  at,
  out,
  x,
  y,
  align = "left",
  dark = false,
  size = 68,
  subSize = 26,
  width = 760,
  weight = 700,
  lineGap = 1.22,
  stagger = 7,
  scrim,
}: {
  eyebrow?: string;
  lines: ReactNode[];
  sub?: ReactNode;
  at: number;
  out?: number;
  x: number;
  y: number;
  align?: "left" | "center" | "right";
  dark?: boolean;
  size?: number;
  subSize?: number;
  width?: number;
  weight?: number;
  lineGap?: number;
  stagger?: number;
  /** 左侧柔光：标题压在产品画面上时把左侧洗亮（缺省：浅色、左对齐时开） */
  scrim?: boolean;
}) {
  const f = useCurrentFrame();
  useGlyphs(`${eyebrow ?? ""}${lines.map((l) => (typeof l === "string" ? l : "")).join("")}${typeof sub === "string" ? sub : ""}`);
  // 挂载窗口要覆盖柔光遮罩的整个淡入淡出（遮罩从 at−24 开始、到 out+60 结束），否则遮罩会单帧出现/消失
  if (f < at - 26 || (out !== undefined && f > out + 64)) return null;
  const left = align === "center" ? x - width / 2 : align === "right" ? x - width : x;
  const exit = (i: number) => (out === undefined ? 0 : prog(f, out + i * 4, 26, easeIn));
  const ink = dark ? "#f5f4f1" : INK;
  const subInk = dark ? "rgba(245,244,241,0.56)" : "#77736c";
  const eb = prog(f, at - 6, 34);
  const nLines = lines.length;
  const useScrim = scrim ?? align === "left";
  const scrimO = useScrim ? Math.min(prog(f, at - 24, 36, easeInOut), out === undefined ? 1 : 1 - prog(f, out + 26, 34, easeInOut)) : 0;
  return (
    <>
    {scrimO > 0.001 && (
      <AbsoluteFill style={{ pointerEvents: "none", zIndex: 45, opacity: scrimO, background: `linear-gradient(90deg, rgba(${dark ? "7,8,10" : "244,243,240"},0.97) 0%, rgba(${dark ? "7,8,10" : "244,243,240"},0.95) 40%, rgba(${dark ? "7,8,10" : "244,243,240"},0.6) 48%, rgba(${dark ? "7,8,10" : "244,243,240"},0) 58%)` }} />
    )}
    <div style={{ position: "absolute", left, top: y, width, textAlign: align, fontFamily: FONT_TITLE, zIndex: 50 }}>
      {eyebrow && (
        <div
          style={{
            display: "flex",
            justifyContent: align === "center" ? "center" : align === "right" ? "flex-end" : "flex-start",
            alignItems: "center",
            gap: 12,
            marginBottom: size * 0.42,
            fontSize: 17,
            fontWeight: 500,
            letterSpacing: 3.2,
            color: dark ? "rgba(245,244,241,0.5)" : "#8b877f",
            opacity: eb * (1 - exit(0)),
          }}
        >
          <span style={{ width: 7, height: 7, borderRadius: 2, background: KIMI_BLUE, display: "inline-block", transform: `scale(${eb})` }} />
          <span>{eyebrow}</span>
        </div>
      )}
      {lines.map((l, i) => {
        const p = prog(f, at + i * stagger, 52, easeOut);
        const e = exit(i);
        return (
          <div key={i} style={{ overflow: "hidden", paddingBottom: size * 0.12, marginBottom: -size * 0.12 }}>
            <div
              style={{
                fontSize: size,
                lineHeight: lineGap,
                fontWeight: weight,
                letterSpacing: size > 50 ? 0.6 : 0.3,
                color: ink,
                whiteSpace: "nowrap",
                transform: `translateY(${(1 - p) * 104 - e * 36}%) translateX(${align === "center" && typeof l === "string" && /[。，、；：]$/.test(l) ? size * 0.28 : 0}px)`,
                opacity: Math.min(1, p * 1.6) * (1 - e),
              }}
            >
              {l}
            </div>
          </div>
        );
      })}
      {sub && (() => {
        const p = prog(f, at + nLines * stagger + 14, 44);
        const e = exit(nLines);
        return (
          <div style={{ marginTop: size * 0.36, fontSize: subSize, lineHeight: 1.62, fontWeight: 400, letterSpacing: 0.4, color: subInk, opacity: p * (1 - e), transform: `translateY(${(1 - p) * 14 - e * 10}px)` }}>
            {sub}
          </div>
        );
      })()}
    </div>
    </>
  );
}

/** 下三分之一的说明字（动作段用，比章节标题轻一级）：小标签 + 一行，底部柔光托字。 */
export function LowerThird({ eyebrow, text, at, out, dark = false }: { eyebrow?: string; text: string; at: number; out: number; dark?: boolean }) {
  const f = useCurrentFrame();
  useGlyphs((eyebrow ?? "") + text);
  if (f < at - 30 || f > out + 50) return null;
  const p = prog(f, at, 44, easeOut);
  const e = prog(f, out, 26, easeIn);
  const scrim = Math.min(prog(f, at - 20, 30), 1 - prog(f, out + 6, 30));
  const c = dark ? "7,8,10" : "244,243,240";
  return (
    <>
      <AbsoluteFill style={{ pointerEvents: "none", zIndex: 45, opacity: scrim, background: `linear-gradient(180deg, rgba(${c},0) 58%, rgba(${c},0.78) 82%, rgba(${c},0.94) 100%)` }} />
      <div style={{ position: "absolute", left: 128, bottom: 112, zIndex: 50, fontFamily: FONT_TITLE }}>
        {eyebrow && (
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, fontSize: 17, fontWeight: 500, letterSpacing: 3.2, color: dark ? "rgba(245,244,241,0.5)" : "#8b877f", opacity: p * (1 - e) }}>
            <span style={{ width: 7, height: 7, borderRadius: 2, background: KIMI_BLUE, display: "inline-block" }} />
            <span>{eyebrow}</span>
          </div>
        )}
        <div style={{ overflow: "hidden", paddingBottom: 6 }}>
          <div style={{ fontSize: 40, fontWeight: 600, letterSpacing: 0.5, color: dark ? "#f5f4f1" : INK, transform: `translateY(${(1 - p) * 104 - e * 40}%)`, opacity: Math.min(1, p * 1.6) * (1 - e), whiteSpace: "nowrap" }}>{text}</div>
        </div>
      </div>
    </>
  );
}

/** 单行小字（落版说明、注释）。 */
export function Note({ children, at, out, style, dark = false }: { children: string; at: number; out?: number; style?: CSSProperties; dark?: boolean }) {
  const f = useCurrentFrame();
  useGlyphs(children);
  const o = prog(f, at, 40) * (out === undefined ? 1 : 1 - prog(f, out, 30, easeIn));
  if (o <= 0.001) return null;
  return <div style={{ position: "absolute", fontFamily: FONT_TITLE, color: dark ? "rgba(245,244,241,0.5)" : "#8f8a83", opacity: o, ...style }}>{children}</div>;
}

export { FONT_LATIN, FONT_TITLE };

/* ───────── 光标 ───────── */
/** 当前镜头缩放（ProductStage 提供），光标据此反向缩放，保持接近真实系统光标的屏幕尺寸。 */
const StageScale = createContext(1);

/** macOS 指针 + 点击涟漪。keys: {f,x,y}（窗口坐标）；clicks: 点击帧。 */
export function Cursor({ keys, clicks = [], show = [0, 99999] }: { keys: { f: number; x: number; y: number }[]; clicks?: number[]; show?: [number, number] }) {
  const f = useCurrentFrame();
  if (f < show[0] - 12 || f > show[1] + 12) return null;
  const x = keyed(f, keys as Key[], "x", easeInOut);
  const y = keyed(f, keys as Key[], "y", easeInOut);
  const op = Math.min(prog(f, show[0] - 12, 12), 1 - prog(f, show[1], 12));
  let press = 0;
  let ripple: number | null = null;
  for (const c of clicks) {
    if (f >= c - 6 && f <= c + 10) press = Math.max(press, 1 - Math.abs(f - c) / 10);
    if (f >= c && f <= c + 34) ripple = (f - c) / 34;
  }
  const stageS = useContext(StageScale);
  const cs = 1.25 / Math.pow(stageS, 0.85);
  return (
    <div style={{ position: "absolute", left: x, top: y, zIndex: 100, opacity: op, pointerEvents: "none", transform: `scale(${cs})`, transformOrigin: "0 0" }}>
      {ripple !== null && (
        <div style={{ position: "absolute", left: -24, top: -24, width: 48, height: 48, borderRadius: 999, border: "2px solid rgba(23,131,255,0.55)", transform: `scale(${0.35 + easeOut(ripple) * 1.15})`, opacity: 1 - ripple }} />
      )}
      <svg width="26" height="26" viewBox="0 0 24 24" style={{ transform: `translate(-3px,-2px) scale(${1 - press * 0.14})`, transformOrigin: "3px 2px", filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.28))" }}>
        <path d="M4 2.5 L4 19.5 L8.6 15.4 L11.6 22 L14.6 20.7 L11.7 14.2 L18 14.2 Z" fill="#111" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

/* ───────── 镜头与窗口 ───────── */

/**
 * 镜头路径：关键帧之间用速度连续的样条（Catmull-Rom，按时间非均匀参数化）穿过所有关键帧，
 * 整条路径只在首尾缓入缓出——中间关键帧不再“减速到 0 再起步”。
 * 相邻两个关键帧相隔 ≤ 2 帧视为硬切：在此处把路径分段，各段独立。
 * 缩放 s 在对数空间插值（推拉匀称）。
 */
export function camPath<K extends Key>(f: number, keys: K[], prop: keyof K & string, edge = easeCine): number {
  // 分段（硬切）
  const segs: K[][] = [];
  let cur: K[] = [keys[0]];
  for (let i = 1; i < keys.length; i++) {
    if (keys[i].f - keys[i - 1].f <= 2) { segs.push(cur); cur = [keys[i]]; } else cur.push(keys[i]);
  }
  segs.push(cur);
  let seg = segs[0];
  for (const sg of segs) if (f >= sg[0].f) seg = sg;
  const log = prop === "s";
  const val = (k: K) => (log ? Math.log(k[prop] as number) : (k[prop] as number));
  const out = (v: number) => (log ? Math.exp(v) : v);
  if (seg.length === 1 || f <= seg[0].f) return out(val(seg[0]));
  const last = seg[seg.length - 1];
  if (f >= last.f) return out(val(last));
  // 不做整段时间重映射（否则中间关键帧会提前到达）：每个关键帧准时到达；首尾切线为 0，本身就是缓入缓出
  void edge;
  const ft = f;
  let i = 0;
  while (i < seg.length - 2 && ft > seg[i + 1].f) i++;
  // 单调三次 Hermite（Fritsch–Carlson）：不过冲；相邻关键帧值相同（停住）时真的停住
  const slope = (a: K, b: K) => (val(b) - val(a)) / (b.f - a.f);
  const tan = (j: number) => {
    if (j <= 0 || j >= seg.length - 1) return 0;
    const d0 = slope(seg[j - 1], seg[j]);
    const d1 = slope(seg[j], seg[j + 1]);
    if (d0 * d1 <= 0) return 0;
    const m = (d0 + d1) / 2;
    const lim = 3 * Math.min(Math.abs(d0), Math.abs(d1));
    return Math.sign(m) * Math.min(Math.abs(m), lim);
  };
  const p1 = seg[i], p2 = seg[i + 1];
  const h = p2.f - p1.f;
  const tt = (ft - p1.f) / h;
  const m1 = tan(i) * h;
  const m2 = tan(i + 1) * h;
  const t2 = tt * tt, t3 = t2 * tt;
  const v = (2 * t3 - 3 * t2 + 1) * val(p1) + (t3 - 2 * t2 + tt) * m1 + (-2 * t3 + 3 * t2) * val(p2) + (t3 - t2) * m2;
  return out(v);
}

/** 镜头关键帧：fx/fy 为窗口内焦点（px），s 为缩放，rx/ry 为俯仰/偏航（度），ox/oy 为画面偏移，rz 为滚转。 */
export interface CamKey extends Key {
  fx: number;
  fy: number;
  s: number;
  rx: number;
  ry: number;
  ox: number;
  oy: number;
}
export const cam = (f: number, fx: number, fy: number, s: number, rx = 0, ry = 0, ox = 0, oy = 0): CamKey => ({ f, fx, fy, s, rx, ry, ox, oy });

export const WIN_W = 1440;
export const WIN_H = 900;

/**
 * 3D 产品舞台：窗口按镜头关键帧推拉摇移；焦点 (fx,fy) 被移到画面中心 + (ox,oy)。
 * drift：极小的持续“手持”漂移，让静止画面也在呼吸。
 */
export function ProductStage({ cam, w = WIN_W, h = WIN_H, children, style, perspective = 2600, drift = 0.45, easing = easeCine }: { cam: CamKey[]; w?: number; h?: number; children: ReactNode; style?: CSSProperties; perspective?: number; drift?: number; easing?: (t: number) => number }) {
  const f = useCurrentFrame();
  const k = (p: keyof CamKey & string) => camPath(f, cam, p, easing);
  const sc = k("s");
  const t = f / FPS;
  const dx = Math.sin(t * 0.64) * 3 * drift;
  const dy = Math.cos(t * 0.49) * 2 * drift;
  const tx = -(k("fx") - w / 2) * sc + k("ox") + dx;
  const ty = -(k("fy") - h / 2) * sc + k("oy") + dy;
  // 运动模糊：按上一帧到这一帧的屏幕位移，沿运动方向模糊（只在快速横摇/推拉时出现）
  const k0 = (p: keyof CamKey & string) => camPath(f - 1, cam, p, easing);
  const s0 = k0("s");
  const vx = tx - (-(k0("fx") - w / 2) * s0 + k0("ox"));
  const vy = ty - (-(k0("fy") - h / 2) * s0 + k0("oy"));
  const vz = Math.abs(sc - s0) * 900;
  const bx = Math.max(0, Math.min(8, (Math.abs(vx) + vz * 0.4 - 6) * 0.4));
  const by = Math.max(0, Math.min(8, (Math.abs(vy) + vz * 0.4 - 6) * 0.4));
  const blurId = `mb-${Math.round(bx * 10)}-${Math.round(by * 10)}`;
  const acrossCut = cam.some((kk, i) => i > 0 && kk.f - cam[i - 1].f <= 2 && f >= kk.f && f - 1 < kk.f + 2);
  const useBlur = !acrossCut && (bx > 0.3 || by > 0.3);
  return (
    <AbsoluteFill style={{ perspective, perspectiveOrigin: "50% 45%", ...style }}>
      {useBlur && (
        <svg width="0" height="0" style={{ position: "absolute" }}>
          <filter id={blurId} x="-5%" y="-5%" width="110%" height="110%">
            <feGaussianBlur stdDeviation={`${bx.toFixed(1)} ${by.toFixed(1)}`} />
          </filter>
        </svg>
      )}
      <div
        style={{
          position: "absolute",
          left: 960 - w / 2,
          top: 540 - h / 2,
          width: w,
          height: h,
          transform: `translate3d(${tx}px, ${ty}px, 0) rotateX(${k("rx") + Math.sin(t * 0.36) * 0.12 * drift}deg) rotateY(${k("ry") + Math.cos(t * 0.31) * 0.16 * drift}deg) scale(${sc})`,
          transformStyle: "preserve-3d",
          filter: useBlur ? `url(#${blurId})` : undefined,
        }}
      >
        <StageScale.Provider value={sc}>{children}</StageScale.Provider>
      </div>
    </AbsoluteFill>
  );
}

export function TrafficLights() {
  return (
    <div style={{ position: "absolute", left: 18, top: 14, display: "flex", gap: 8, zIndex: 5 }}>
      {["#ff5f57", "#febc2e", "#28c840"].map((x, i) => (
        <span key={i} style={{ width: 12, height: 12, borderRadius: 99, background: x, boxShadow: "inset 0 0 0 0.5px rgba(0,0,0,0.18)" }} />
      ))}
    </div>
  );
}

/** 客户端窗口外壳：无边框，圆角 + 多层柔和投影 + 玻璃高光（sheen 0→1 扫过一次）。 */
export function AppWindow({ children, dark = false, shadow = 1, style, sheen = 0, lights = true }: { children: ReactNode; dark?: boolean; shadow?: number; style?: CSSProperties; sheen?: number; lights?: boolean }) {
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: WIN_W,
        height: WIN_H,
        borderRadius: 12,
        overflow: "hidden",
        background: dark ? "#141312" : "#fbfaf9",
        boxShadow: dark
          ? `0 0 0 1px rgba(255,255,255,${0.12 * shadow}), 0 30px 60px -12px rgba(0,0,0,${0.55 * shadow}), 0 90px 180px -40px rgba(0,0,0,${0.7 * shadow})`
          : `0 0 0 1px rgba(14,18,25,${0.09 * shadow}), 0 2px 4px rgba(14,18,25,${0.04 * shadow}), 0 28px 54px -14px rgba(14,18,25,${0.16 * shadow}), 0 90px 160px -36px rgba(14,18,25,${0.26 * shadow})`,
        ...style,
      }}
    >
      {children}
      {lights && <TrafficLights />}
      {sheen > 0.001 && sheen < 0.999 && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            background: `linear-gradient(112deg, rgba(255,255,255,0) ${sheen * 150 - 45}%, rgba(255,255,255,${dark ? 0.07 : 0.34}) ${sheen * 150 - 28}%, rgba(255,255,255,0) ${sheen * 150 - 10}%)`,
          }}
        />
      )}
      <div style={{ position: "absolute", inset: 0, borderRadius: 12, pointerEvents: "none", boxShadow: dark ? "inset 0 0 0 1px rgba(255,255,255,0.06)" : "inset 0 1px 0 rgba(255,255,255,0.7)" }} />
    </div>
  );
}

export interface FocusRect {
  x: number;
  y: number;
  w: number;
  h: number;
  r?: number;
}

/** 产品窗口：真实界面快照 + 可选焦点区（同一快照渲染两层：底层虚化压暗，上层裁出清晰区）。 */
export function ProductWindow({ name, prev, mix = 1, edit, focus, blur = 0, dim = 0, shadow = 1, overlay, sheen = 0, style, lights }: { name: SnapName; prev?: SnapName | null; mix?: number; edit?: SnapEdit; focus?: FocusRect | null; blur?: number; dim?: number; shadow?: number; overlay?: ReactNode; sheen?: number; style?: CSSProperties; lights?: boolean }) {
  const dark = SNAPS[name].theme === "dark";
  const on = !!focus && (blur > 0.05 || dim > 0.005);
  const fading = !!prev && prev !== name && mix < 0.999;
  return (
    <AppWindow dark={dark} shadow={shadow} sheen={sheen} style={style} lights={lights}>
      {fading && (
        <div style={{ position: "absolute", inset: 0, opacity: Math.min(1, (1 - mix) * 2), filter: on ? `blur(${blur}px) brightness(${1 - dim})` : undefined }}>
          <Snap name={prev!} edit={edit} />
        </div>
      )}
      <div style={{ position: "absolute", inset: 0, opacity: fading ? mix : 1, filter: on ? `blur(${blur}px) brightness(${1 - dim})` : undefined }}>
        <Snap name={name} edit={edit} />
      </div>
      {on && focus && (
        <div style={{ position: "absolute", inset: 0, clipPath: `inset(${focus.y}px ${1440 - focus.x - focus.w}px ${900 - focus.y - focus.h}px ${focus.x}px round ${focus.r ?? 12}px)` }}>
          <Snap name={name} edit={edit} />
        </div>
      )}
      {overlay}
    </AppWindow>
  );
}

/** 柔和的聚光圈（快照坐标）：Kimi 蓝描边 + 外晕。p 为 0→1 的强度。 */
export function Spot({ rect, p, color = "23,131,255", pad = 6, r = 10 }: { rect: FocusRect; p: number; color?: string; pad?: number; r?: number }) {
  if (p <= 0.001) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: rect.x - pad,
        top: rect.y - pad,
        width: rect.w + pad * 2,
        height: rect.h + pad * 2,
        borderRadius: (rect.r ?? r) + pad,
        border: `2px solid rgba(${color},${0.72 * p})`,
        boxShadow: `0 0 0 ${6 * p}px rgba(${color},${0.08 * p}), 0 0 ${28 * p}px rgba(${color},${0.2 * p})`,
        transform: `scale(${1.03 - 0.03 * p})`,
        pointerEvents: "none",
        zIndex: 20,
      }}
    />
  );
}

/** 侧向柔光：标题压在画面上时，把一侧轻轻洗亮（dark 时压暗）。 */
export function Scrim({ opacity = 1, to = 50, side = "left", dark = false }: { opacity?: number; to?: number; side?: "left" | "right"; dark?: boolean }) {
  const c = dark ? "7,8,10" : "245,244,241";
  if (opacity <= 0.001) return null;
  return <AbsoluteFill style={{ pointerEvents: "none", zIndex: 40, opacity, background: `linear-gradient(${side === "left" ? 90 : 270}deg, rgba(${c},0.97) 0%, rgba(${c},0.88) ${to * 0.55}%, rgba(${c},0) ${to}%)` }} />;
}

/** 画面整体淡入淡出（黑场 / 白场）。 */
export function Fade({ color = NIGHT, inAt, inDur = 18, outAt, outDur = 18 }: { color?: string; inAt?: number; inDur?: number; outAt?: number; outDur?: number }) {
  const f = useCurrentFrame();
  let o = 0;
  if (inAt !== undefined) o = Math.max(o, 1 - prog(f, inAt, inDur, easeInOut));
  if (outAt !== undefined) o = Math.max(o, prog(f, outAt, outDur, easeInOut));
  if (o <= 0.001) return null;
  return <AbsoluteFill style={{ background: color, opacity: o, pointerEvents: "none", zIndex: 90 }} />;
}

/** 镜头运动模糊的近似：快速位移时给整层一点方向模糊（只在速度大时生效）。 */
export function motionBlur(speedPx: number) {
  const b = Math.min(6, Math.max(0, (Math.abs(speedPx) - 6) / 10));
  return b > 0.2 ? `blur(${b.toFixed(2)}px)` : undefined;
}
