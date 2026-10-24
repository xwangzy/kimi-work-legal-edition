/** S4 · 登场：白色工作面退后，品牌字标浮现；随后工作面回到眼前，成为 Kimi Work 法律行业发行版的首页（真实界面快照）。 */
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from "remotion";
import { easeInOut, map, prog, spr } from "../lib/anim";
import { FONT_EN, FONT_UI, INK, ProductStage, ProductWindow, StudioBackdrop, WIN_H, type CamKey } from "../ui/film";

const CAM: CamKey[] = [
  { f: 0, fx: 720, fy: WIN_H / 2, s: 0.84, rx: 0, ry: 0, ox: 0, oy: 0 },
  { f: 26, fx: 720, fy: WIN_H / 2, s: 0.66, rx: 18, ry: 0, ox: 0, oy: 440 },
  { f: 62, fx: 720, fy: WIN_H / 2, s: 0.68, rx: 16, ry: 0, ox: 0, oy: 420 },
  { f: 104, fx: 720, fy: WIN_H / 2, s: 0.86, rx: 0, ry: 0, ox: 0, oy: 6 },
  { f: 128, fx: 720, fy: WIN_H / 2, s: 0.87, rx: 0, ry: 0, ox: 0, oy: 6 },
];

export function BrandLockup({ f, at = 0, scale = 1, dark = false }: { f: number; at?: number; scale?: number; dark?: boolean }) {
  const pm = spr(f, at, 150, 22);
  const pt = prog(f, at + 8, 30);
  const ps = prog(f, at + 18, 30);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 34 * scale, transform: `scale(${scale})`, transformOrigin: "50% 50%" }}>
      <Img src={staticFile(dark ? "logos/kimi-mark-dark.svg" : "logos/kimi-mark-light.svg")} style={{ width: 132, height: 132, opacity: pm, transform: `scale(${0.7 + 0.3 * pm})` }} />
      <div style={{ overflow: "hidden", paddingRight: 8 }}>
        <div style={{ fontFamily: FONT_EN, fontWeight: 600, fontSize: 92, lineHeight: 1.05, letterSpacing: -1.5, color: dark ? "#f5f4f1" : INK, opacity: pt, transform: `translateX(${(1 - pt) * -40}px)`, filter: `blur(${(1 - pt) * 8}px)` }}>Kimi Work</div>
        <div style={{ fontFamily: FONT_UI, fontWeight: 500, fontSize: 36, marginTop: 10, letterSpacing: 10, color: dark ? "rgba(245,244,241,0.66)" : "#5f5b55", opacity: ps, transform: `translateX(${(1 - ps) * -30}px)`, filter: `blur(${(1 - ps) * 6}px)` }}>法律行业发行版</div>
      </div>
    </div>
  );
}

export function S04Reveal() {
  const f = useCurrentFrame();
  // 工作面一离开眼前就开始显影（虚焦），回到眼前时清晰——不留空白窗口
  const content = prog(f, 8, 40);
  const lockOut = prog(f, 58, 22, easeInOut);
  const winBlur = map(f, [0, 20, 60, 100], [0, 8, 8, 0]);
  return (
    <AbsoluteFill>
      <StudioBackdrop />
      <ProductStage cam={CAM}>
        <div style={{ position: "absolute", inset: 0, filter: `blur(${winBlur}px)`, opacity: map(f, [0, 20, 60, 96], [1, 0.6, 0.6, 1]) }}>
          <ProductWindow
            name="h03-home-matter"
            edit={(root) => {
              const sh = root.querySelector<HTMLElement>(".shell");
              if (sh) {
                sh.style.opacity = String(content);
                sh.style.transform = `translateY(${(1 - content) * 18}px)`;
              }
            }}
          />
        </div>
      </ProductStage>
      <AbsoluteFill style={{ display: "grid", placeItems: "center", opacity: 1 - lockOut, transform: `translateY(${-lockOut * 60 - 70}px)` }}>
        <BrandLockup f={f} at={10} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
