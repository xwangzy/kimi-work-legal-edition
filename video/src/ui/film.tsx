/**
 * 片场元件：背景、标题字、光标、3D 产品窗口与镜头。
 * 视觉原则：产品是主角——背景只给柔和的环境光，不用科技线条、粒子与过度发光。
 */
import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { easeInOut, keyed, prog, reveal, spr, vanish, type Key } from "../lib/anim";
import { SNAPS, type SnapName } from "../snaps";
import { Snap, type SnapEdit } from "./Snap";

export const FONT_UI = `"PingFang SC", -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif`;
export const FONT_DISPLAY = `"PingFang SC", "SF Pro Display", -apple-system, "Helvetica Neue", sans-serif`;
export const FONT_EN = `"SF Pro Display", -apple-system, "Helvetica Neue", Arial, sans-serif`;
export const FONT_DOC = `"Songti SC", "Source Han Serif SC", "Noto Serif CJK SC", serif`;

export const INK = "#0e1219";
export const STUDIO = "#f3f2ef";
export const NIGHT = "#0a0b0d";

/** 暖白摄影棚：中央柔光 + 四周微暗 + 极细颗粒感（用渐变模拟，不用噪点图）。 */
export function StudioBackdrop({ tone = 1 }: { tone?: number }) {
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(120% 90% at 50% 38%, #ffffff 0%, #f6f5f2 42%, #e9e7e3 100%)`,
        opacity: tone,
      }}
    />
  );
}

/** 夜色：近黑 + 一束极弱的顶光。 */
export function NightBackdrop({ glow = 1, glowX = 50, glowY = 30 }: { glow?: number; glowX?: number; glowY?: number }) {
  return (
    <AbsoluteFill style={{ background: NIGHT }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(60% 55% at ${glowX}% ${glowY}%, rgba(255,250,240,${0.075 * glow}) 0%, rgba(255,250,240,0) 70%)`,
        }}
      />
    </AbsoluteFill>
  );
}

/** 电影遮幅暗角（极轻）。 */
export function Vignette({ strength = 0.35 }: { strength?: number }) {
  return <AbsoluteFill style={{ pointerEvents: "none", background: `radial-gradient(130% 100% at 50% 50%, rgba(0,0,0,0) 55%, rgba(0,0,0,${strength}) 100%)` }} />;
}

/** 标题字：主句 + 副句，显影进入、消散退出。 */
export function Headline({
  title,
  sub,
  at,
  out,
  x,
  y,
  align = "left",
  dark = false,
  size = 64,
  subSize = 26,
  width = 760,
  subDelay = 8,
}: {
  title: ReactNode;
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
  subDelay?: number;
}) {
  const f = useCurrentFrame();
  const vt = out !== undefined ? vanish(f, out) : { opacity: 1, transform: "none", filter: "none" };
  const vs = out !== undefined ? vanish(f, out - 2) : { opacity: 1, transform: "none", filter: "none" };
  const r1 = reveal(f, at, 24, 30);
  const r2 = reveal(f, at + subDelay, 24, 20);
  const left = align === "center" ? x - width / 2 : align === "right" ? x - width : x;
  return (
    <div style={{ position: "absolute", left, top: y, width, textAlign: align, fontFamily: FONT_DISPLAY }}>
      <div
        style={{
          fontSize: size,
          lineHeight: 1.22,
          fontWeight: 600,
          letterSpacing: size > 50 ? -0.5 : 0,
          color: dark ? "#f5f4f1" : INK,
          opacity: r1.opacity * vt.opacity,
          transform: `${r1.transform} ${vt.transform}`,
          filter: f < at + 24 ? r1.filter : vt.filter,
        }}
      >
        {title}
      </div>
      {sub && (
        <div
          style={{
            marginTop: size * 0.32,
            fontSize: subSize,
            lineHeight: 1.5,
            fontWeight: 400,
            color: dark ? "rgba(245,244,241,0.62)" : "#6b6862",
            opacity: r2.opacity * vs.opacity,
            transform: `${r2.transform} ${vs.transform}`,
            filter: f < at + subDelay + 24 ? r2.filter : vs.filter,
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

/** macOS 指针 + 点击涟漪。keys: {f,x,y}（窗口坐标）；clicks: 点击帧。 */
export function Cursor({ keys, clicks = [], show = [0, 99999] }: { keys: { f: number; x: number; y: number }[]; clicks?: number[]; show?: [number, number] }) {
  const f = useCurrentFrame();
  if (f < show[0] - 8 || f > show[1] + 8) return null;
  const x = keyed(f, keys as Key[], "x", easeInOut);
  const y = keyed(f, keys as Key[], "y", easeInOut);
  const op = Math.min(prog(f, show[0] - 8, 8), 1 - prog(f, show[1], 8));
  let press = 0;
  let ripple: { p: number } | null = null;
  for (const c of clicks) {
    if (f >= c - 3 && f <= c + 5) press = Math.max(press, 1 - Math.abs(f - c) / 5);
    if (f >= c && f <= c + 18) ripple = { p: (f - c) / 18 };
  }
  return (
    <div style={{ position: "absolute", left: x, top: y, zIndex: 100, opacity: op, pointerEvents: "none" }}>
      {ripple && (
        <div
          style={{
            position: "absolute",
            left: -22,
            top: -22,
            width: 44,
            height: 44,
            borderRadius: 999,
            border: "2px solid rgba(22,127,251,0.55)",
            transform: `scale(${0.4 + ripple.p * 1.1})`,
            opacity: 1 - ripple.p,
          }}
        />
      )}
      <svg width="26" height="26" viewBox="0 0 24 24" style={{ transform: `translate(-3px,-2px) scale(${1 - press * 0.12})`, transformOrigin: "3px 2px", filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.28))" }}>
        <path d="M4 2.5 L4 19.5 L8.6 15.4 L11.6 22 L14.6 20.7 L11.7 14.2 L18 14.2 Z" fill="#111" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

/** 镜头关键帧：fx/fy 为窗口内焦点（px），s 为缩放，rx/ry 为俯仰/偏航（度），ox/oy 为画面偏移。 */
export interface CamKey extends Key {
  fx: number;
  fy: number;
  s: number;
  rx: number;
  ry: number;
  ox: number;
  oy: number;
}

/**
 * 3D 产品窗口：窗口尺寸 w×h（与真实客户端 1440×900 一致），按镜头关键帧推拉摇移。
 * 焦点 (fx,fy) 会被移到画面中心 + (ox,oy)。
 */
export function ProductStage({
  cam,
  w = WIN_W,
  h = WIN_H,
  children,
  style,
  perspective = 2600,
}: {
  cam: CamKey[];
  w?: number;
  h?: number;
  children: ReactNode;
  style?: CSSProperties;
  perspective?: number;
}) {
  const f = useCurrentFrame();
  const k = (p: keyof CamKey & string) => keyed(f, cam, p, easeInOut);
  const s = k("s");
  const tx = -(k("fx") - w / 2) * s + k("ox");
  const ty = -(k("fy") - h / 2) * s + k("oy");
  return (
    <AbsoluteFill style={{ perspective, perspectiveOrigin: "50% 45%", ...style }}>
      <div
        style={{
          position: "absolute",
          left: 960 - w / 2,
          top: 540 - h / 2,
          width: w,
          height: h,
          transform: `translate3d(${tx}px, ${ty}px, 0) rotateX(${k("rx")}deg) rotateY(${k("ry")}deg) scale(${s})`,
          transformStyle: "preserve-3d",
        }}
      >
        {children}
      </div>
    </AbsoluteFill>
  );
}

/** 标题栏高度：桌面端用 Electron 默认窗口框，macOS 上有原生标题栏。 */
export const TITLEBAR = 30;
export const WIN_W = 1440;
export const WIN_H = 900 + TITLEBAR;

/** 客户端窗口外壳：原生标题栏（红绿灯 + 居中标题）+ 圆角 + 多层柔和投影。children 放在标题栏下方 1440×900 区域。 */
export function AppWindow({ children, dark = false, shadow = 1, style }: { children: ReactNode; dark?: boolean; shadow?: number; style?: CSSProperties }) {
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
        background: dark ? "#1b1c1f" : "#fff",
        boxShadow: dark
          ? `0 0 0 1px rgba(255,255,255,${0.1 * shadow}), 0 30px 60px -12px rgba(0,0,0,${0.5 * shadow}), 0 80px 160px -40px rgba(0,0,0,${0.6 * shadow})`
          : `0 0 0 1px rgba(14,18,25,${0.09 * shadow}), 0 2px 4px rgba(14,18,25,${0.04 * shadow}), 0 24px 48px -12px rgba(14,18,25,${0.16 * shadow}), 0 70px 140px -30px rgba(14,18,25,${0.26 * shadow})`,
        ...style,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          right: 0,
          height: TITLEBAR,
          background: dark ? "#2a2b2f" : "#ecebe8",
          borderBottom: `1px solid ${dark ? "rgba(255,255,255,0.08)" : "rgba(14,18,25,0.09)"}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: FONT_UI,
          fontSize: 13,
          fontWeight: 500,
          color: dark ? "rgba(255,255,255,0.6)" : "#6f6b65",
        }}
      >
        <TrafficLights />
        Kimi Work 法律行业发行版
      </div>
      <div style={{ position: "absolute", left: 0, top: TITLEBAR, width: WIN_W, height: 900, overflow: "hidden" }}>{children}</div>
    </div>
  );
}

export function TrafficLights() {
  const c = ["#ff5f57", "#febc2e", "#28c840"];
  return (
    <div style={{ position: "absolute", left: 13, top: 9, display: "flex", gap: 8 }}>
      {c.map((x) => (
        <span key={x} style={{ width: 12, height: 12, borderRadius: 99, background: x, boxShadow: "inset 0 0 0 0.5px rgba(0,0,0,0.15)" }} />
      ))}
    </div>
  );
}

/** 焦点区（快照坐标）：区外按 blur 虚化、按 dim 压暗，区内保持清晰——模拟浅景深与“只看这里”。 */
export interface FocusRect {
  x: number;
  y: number;
  w: number;
  h: number;
  r?: number;
}

/**
 * 产品窗口：真实界面快照 + 可选焦点区。焦点区通过“同一快照渲染两层”实现：底层整体虚化压暗，上层按圆角矩形裁出清晰区域。
 * blur / dim 为 0 时只渲染一层。
 */
export function ProductWindow({
  name,
  edit,
  focus,
  blur = 0,
  dim = 0,
  shadow = 1,
  overlay,
}: {
  name: SnapName;
  edit?: SnapEdit;
  focus?: FocusRect | null;
  blur?: number;
  dim?: number;
  shadow?: number;
  overlay?: ReactNode;
}) {
  const dark = SNAPS[name].theme === "dark";
  const on = !!focus && (blur > 0.05 || dim > 0.005);
  return (
    <AppWindow dark={dark} shadow={shadow}>
      <div style={{ position: "absolute", inset: 0, filter: on ? `blur(${blur}px) brightness(${1 - dim})` : undefined }}>
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

/** 柔和的聚光圈（快照坐标）：Kimi 蓝描边 + 外发光，提示观众视线落点。p 为 0→1 的强度。 */
export function Spot({ rect, p, color = "22,127,251", pad = 6, r = 10 }: { rect: FocusRect; p: number; color?: string; pad?: number; r?: number }) {
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
        border: `2px solid rgba(${color},${0.75 * p})`,
        boxShadow: `0 0 0 ${6 * p}px rgba(${color},${0.1 * p}), 0 0 ${28 * p}px rgba(${color},${0.25 * p})`,
        transform: `scale(${1.04 - 0.04 * p})`,
        pointerEvents: "none",
      }}
    />
  );
}

/** 弹簧出现（缩放 + 位移 + 透明度）。 */
export function Pop({ at, children, from = 16, scale = 0.96, style }: { at: number; children: ReactNode; from?: number; scale?: number; style?: CSSProperties }) {
  const f = useCurrentFrame();
  const p = spr(f, at, 140, 22);
  return <div style={{ opacity: Math.min(1, p * 1.4), transform: `translateY(${(1 - p) * from}px) scale(${scale + (1 - scale) * p})`, transformOrigin: "50% 0%", ...style }}>{children}</div>;
}

/** 左侧柔光遮罩：标题压在产品画面上时，用摄影棚底色把左侧轻轻洗白。 */
export function Scrim({ opacity = 1, to = 52, side = "left" }: { opacity?: number; to?: number; side?: "left" | "right" }) {
  return (
    <AbsoluteFill
      style={{
        pointerEvents: "none",
        opacity,
        background: `linear-gradient(${side === "left" ? 90 : 270}deg, rgba(246,245,242,0.97) 0%, rgba(246,245,242,0.9) ${to * 0.55}%, rgba(246,245,242,0) ${to}%)`,
      }}
    />
  );
}

/** 底部柔光遮罩：字幕放在画面下方时托住文字。 */
export function BottomScrim({ opacity = 1, from = 58, dark = false }: { opacity?: number; from?: number; dark?: boolean }) {
  const c = dark ? "10,11,13" : "246,245,242";
  return <AbsoluteFill style={{ pointerEvents: "none", opacity, background: `linear-gradient(180deg, rgba(${c},0) ${from}%, rgba(${c},0.92) ${from + 22}%, rgba(${c},0.97) 100%)` }} />;
}
