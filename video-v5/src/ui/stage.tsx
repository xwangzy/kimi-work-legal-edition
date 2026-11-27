/**
 * 一镜到底用的“世界里的产品窗口”：窗口按世界坐标摆放（中心 + 偏航），镜头用 space.tsx 的相机。
 * 渲染时不把窗口放进 CSS 3D 世界（放大的 3D 文字会被 Chrome 降分辨率栅格化），而是逐个窗口手算投影：
 * 屏幕位置 + scale(k) + 以窗口中心为轴、按相对偏航用 perspective(z) 旋转——放大来自 scale()，界面文字保持清晰。
 */
import type { CSSProperties, ReactNode } from "react";
import { rel, type Cam } from "./space";
import { ProductWindow, StageScale, WIN_H, WIN_W, type FocusRect } from "./film";
import type { SnapName } from "../snaps";
import type { SnapEdit } from "./Snap";

export interface WinPos {
  x: number; // 中心
  y: number;
  d: number;
  ry: number; // 偏航（度）
}

/** 窗口内坐标 (u, v)（快照 px）→ 世界坐标。 */
export function winPoint(w: WinPos, u: number, v: number) {
  const a = (w.ry * Math.PI) / 180;
  return { x: w.x + (u - WIN_W / 2) * Math.cos(a), y: w.y + (v - WIN_H / 2), d: w.d + (u - WIN_W / 2) * Math.sin(a) };
}

/** 屏幕上的投影参数。 */
export function winProject(cam: Cam, w: WinPos) {
  const c = rel(cam, w);
  const k = cam.F / Math.max(1, c.z);
  return { sx: 960 + c.x * k, sy: 540 + c.y * k, k, z: c.z, yaw: w.ry - cam.yaw, pitch: cam.pitch };
}

export function WorldWindow({
  cam,
  w,
  name,
  prev,
  mix,
  edit,
  focus,
  blur = 0,
  focusBlur = 0,
  dim = 0,
  opacity = 1,
  overlay,
  children,
  sheen,
  shadow = 1,
  style,
}: {
  cam: Cam;
  w: WinPos;
  name: SnapName;
  prev?: SnapName | null;
  mix?: number;
  edit?: SnapEdit;
  focus?: FocusRect | null;
  blur?: number; // 屏幕 px（整窗离焦）
  focusBlur?: number; // 焦点区以外的局部虚化（快照 px）
  dim?: number;
  opacity?: number;
  overlay?: ReactNode;
  children?: ReactNode;
  sheen?: number;
  shadow?: number;
  style?: CSSProperties;
}) {
  const p = winProject(cam, w);
  if (p.z < 120 || opacity <= 0.002) return null;
  const visible = p.sx > -WIN_W * p.k && p.sx < 1920 + WIN_W * p.k;
  if (!visible) return null;
  const localBlur = blur / p.k;
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: WIN_W,
        height: WIN_H,
        transformOrigin: "0 0",
        transform: `translate(${p.sx.toFixed(2)}px, ${p.sy.toFixed(2)}px) scale(${p.k.toFixed(4)}) perspective(${p.z.toFixed(1)}px) rotateX(${(-p.pitch).toFixed(3)}deg) rotateY(${p.yaw.toFixed(3)}deg) translate(${-WIN_W / 2}px, ${-WIN_H / 2}px)`,
        opacity,
        filter: localBlur > 0.3 ? `blur(${localBlur.toFixed(2)}px)` : undefined,
        ...style,
      }}
    >
      <StageScale.Provider value={p.k}>
        <ProductWindow name={name} prev={prev} mix={mix} edit={edit} focus={focus} blur={focusBlur} dim={dim} overlay={overlay} sheen={sheen} shadow={shadow} />
        {children}
      </StageScale.Provider>
    </div>
  );
}
