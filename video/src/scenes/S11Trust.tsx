/**
 * S11 · 为律所的保密义务而设计：夜色中依次特写三块真实界面（深色模式）——
 * 设置“本机与安全”的案卷安全、执行页“数据去向”、设置“数据去向说明”里的“经过中软，不保存”。
 */
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { easeInOut, map, prog, reveal, spr, vanish } from "../lib/anim";
import { FONT_DISPLAY, FONT_UI, Headline, NightBackdrop, Vignette } from "../ui/film";
import { SnapCrop } from "../ui/Snap";
import type { SnapName } from "../snaps";

const ITEMS: { name: SnapName; rect: { x: number; y: number; w: number; h: number }; scale: number; title: string; sub: string; at: number; end: number }[] = [
  { name: "d05-device", rect: { x: 300, y: 129, w: 369, h: 118 }, scale: 2.3, title: "在律所电脑上执行", sub: "案卷加密保存在本机；原件只读，结果都是草稿。", at: 10, end: 70 },
  { name: "d04-run-数据去向", rect: { x: 828, y: 55, w: 604, h: 160 }, scale: 1.55, title: "每一次外发，都有去向", sub: "发了几次、多少字、换了几处代号，逐条可查。", at: 70, end: 130 },
  { name: "d06-visibility", rect: { x: 665, y: 208, w: 369, h: 200 }, scale: 2.2, title: "经过中软，不保存", sub: "哪些只在本机、哪些经过中软，一页说清。", at: 130, end: 999 },
];

export function S11Trust() {
  const f = useCurrentFrame();
  const out = vanish(f, 172, 18, -10);
  return (
    <AbsoluteFill>
      <NightBackdrop glow={1.3} glowX={64} glowY={40} />
      <Vignette strength={0.5} />
      <AbsoluteFill style={{ opacity: out.opacity, filter: out.filter }}>
        <Headline dark at={4} x={160} y={392} size={30} width={700} title={<span style={{ color: "rgba(245,244,241,0.55)", letterSpacing: 2 }}>为律所的保密义务而设计</span>} />
        {ITEMS.map((it) => {
          const p = spr(f, it.at, 110, 24);
          const gone = prog(f, it.end - 6, 14, easeInOut);
          if (f < it.at - 2 || gone >= 1) return null;
          const t = reveal(f, it.at + 6, 22, 18);
          const tv = vanish(f, it.end - 8, 12, -10);
          const w = it.rect.w * it.scale;
          const h = it.rect.h * it.scale;
          return (
            <div key={it.title}>
              <div style={{ position: "absolute", left: 160, top: 452, width: 640, ...t, opacity: t.opacity * tv.opacity, filter: f < it.end - 8 ? t.filter : tv.filter }}>
                <div style={{ fontFamily: FONT_DISPLAY, fontSize: 62, fontWeight: 600, lineHeight: 1.25, color: "#f5f4f1" }}>{it.title}</div>
                <div style={{ fontFamily: FONT_UI, fontSize: 26, lineHeight: 1.6, color: "rgba(245,244,241,0.62)", marginTop: 22 }}>{it.sub}</div>
              </div>
              <div
                style={{
                  position: "absolute",
                  left: 1290 - w / 2,
                  top: 540 - h / 2,
                  perspective: 1600,
                  opacity: Math.min(1, p * 1.5) * (1 - gone),
                  transform: `translateX(${(1 - p) * 80 - gone * 60}px) translateY(${map(f, [it.at, it.end], [10, -10])}px)`,
                  filter: `blur(${gone * 8}px)`,
                }}
              >
                <div style={{ transform: `rotateY(${(1 - p) * -14 - 4}deg)` }}>
                  <SnapCrop name={it.name} rect={it.rect} scale={it.scale} radius={18} style={{ boxShadow: "0 0 0 1px rgba(255,255,255,0.12), 0 40px 90px -20px rgba(0,0,0,0.85), 0 0 120px -30px rgba(255,250,240,0.12)" }} />
                </div>
              </div>
            </div>
          );
        })}
      </AbsoluteFill>
      <AbsoluteFill style={{ background: "#0a0b0d", opacity: 1 - prog(f, 0, 18) }} />
    </AbsoluteFill>
  );
}
