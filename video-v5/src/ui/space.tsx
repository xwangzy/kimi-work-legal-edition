/**
 * 三维空间与镜头（CSS 3D）：世界坐标 x 向右、y 向下、d 向前（离镜头越远 d 越大）。
 * 镜头 = 位置 (x, y, d) + 偏航 yaw + 俯仰 pitch；焦距 F（像素）。
 * 世界容器一次性做“相机变换”，元素用 translate3d(x, y, -d) 摆放；CSS 负责透视与透视缩短。
 * 景深、雾、近裁剪由 depthOf() 手算（CSS 不做）。
 */
import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill } from "remotion";

export interface Cam {
  x: number;
  y: number;
  d: number;
  yaw: number; // 度
  pitch: number; // 度
  F: number;
}

/** 世界点相对镜头的坐标：返回 {x, y, z}（z 为沿视线的深度，>0 在镜头前）。 */
export function rel(cam: Cam, p: { x: number; y: number; d: number }) {
  const vx = p.x - cam.x;
  const vy = p.y - cam.y;
  const vz = p.d - cam.d;
  const a = (cam.yaw * Math.PI) / 180;
  const b = (cam.pitch * Math.PI) / 180;
  const x1 = vx * Math.cos(a) - vz * Math.sin(a);
  const z1 = vx * Math.sin(a) + vz * Math.cos(a);
  const y2 = vy * Math.cos(b) - z1 * Math.sin(b);
  const z2 = vy * Math.sin(b) + z1 * Math.cos(b);
  return { x: x1, y: y2, z: z2 };
}

/** 屏幕投影（1920×1080 合成坐标）。 */
export function project(cam: Cam, p: { x: number; y: number; d: number }) {
  const r = rel(cam, p);
  const k = cam.F / Math.max(1e-3, r.z);
  return { sx: 960 + r.x * k, sy: 540 + r.y * k, k, z: r.z };
}

/** 景深模糊（屏幕像素）：A 为光圈系数，zf 为对焦距离。 */
export function coc(z: number, zf: number, A: number, max = 22) {
  return Math.min(max, (A * Math.abs(z - zf)) / Math.max(1, z));
}

/** 镜头容器：perspective = F，内部世界容器做相机变换。 */
export function World({ cam, children, style }: { cam: Cam; children: ReactNode; style?: CSSProperties }) {
  return (
    <AbsoluteFill style={{ perspective: cam.F, perspectiveOrigin: "960px 540px", overflow: "hidden", ...style }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: 0,
          height: 0,
          transformStyle: "preserve-3d",
          transformOrigin: "0 0 0",
          // 右到左作用于点：平移到镜头 → 俯仰 → 偏航 → 推到投影面前 F 处
          transform: `translate3d(960px, 540px, ${cam.F}px) rotateX(${-cam.pitch}deg) rotateY(${cam.yaw}deg) translate3d(${-cam.x}px, ${-cam.y}px, ${cam.d}px)`,
        }}
      >
        {children}
      </div>
    </AbsoluteFill>
  );
}

/** 世界中的一个平面元素（左上角在 (x, y, d)）。ry：自身偏航（度）。 */
export function Plane({ x, y, d, ry = 0, rx = 0, children, style }: { x: number; y: number; d: number; ry?: number; rx?: number; children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ position: "absolute", left: 0, top: 0, transformOrigin: "0 0 0", transform: `translate3d(${x}px, ${y}px, ${-d}px) rotateY(${ry}deg) rotateX(${rx}deg)`, ...style }}>
      {children}
    </div>
  );
}
