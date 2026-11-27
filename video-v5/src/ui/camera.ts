/**
 * 镜头关键帧 → 世界相机。关键帧给“看向的目标点 (x,y,d) + 距离 z + 偏航/俯仰”，
 * 各分量用 film.tsx 的 camPath（单调三次 Hermite，速度连续、不过冲）插值；距离在对数空间插值（推拉匀称）。
 */
import { camPath, type Key } from "./film";
import type { Cam } from "./space";

export interface ShotKey {
  f: number;
  x: number;
  y: number;
  d: number;
  z: number;
  yaw: number;
  pitch: number;
}

export function camAt(f: number, keys: ShotKey[], F: number) {
  const ks = keys.map((k) => ({ ...k, lz: Math.log(k.z) })) as unknown as (Key & ShotKey & { lz: number })[];
  const v = (p: string) => camPath(f, ks, p as never);
  const t = { x: v("x"), y: v("y"), d: v("d") };
  const z = Math.exp(v("lz"));
  const yaw = v("yaw");
  const pitch = v("pitch");
  const a = (yaw * Math.PI) / 180;
  const b = (pitch * Math.PI) / 180;
  const cam: Cam = { x: t.x - z * Math.sin(a) * Math.cos(b), y: t.y - z * Math.sin(b), d: t.d - z * Math.cos(a) * Math.cos(b), yaw, pitch, F };
  return { cam, t, z };
}
