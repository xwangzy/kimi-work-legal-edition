/** S14 · 联袂打造：中软国际 × Kimi。末尾 1 小节淡出到黑。 */
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from "remotion";
import { prog, reveal, spr } from "../lib/anim";
import { FONT_UI, StudioBackdrop } from "../ui/film";

export function S14Partner() {
  const f = useCurrentFrame();
  const a = spr(f, 6, 120, 22);
  const x = prog(f, 18, 20);
  const b = spr(f, 22, 120, 22);
  const t = reveal(f, 44, 26, 16);
  const note = prog(f, 90, 30);
  const end = prog(f, 212, 40);
  return (
    <AbsoluteFill>
      <StudioBackdrop />
      <AbsoluteFill style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 64 }}>
          <Img src={staticFile("logos/csi.png")} style={{ width: 150, height: 150, borderRadius: 6, opacity: Math.min(1, a * 1.3), transform: `scale(${0.85 + 0.15 * a})`, boxShadow: "0 18px 40px -20px rgba(180,30,30,0.5)" }} />
          <svg width="44" height="44" viewBox="0 0 44 44" style={{ opacity: x, transform: `rotate(${(1 - x) * -45}deg)` }}>
            <path d="M8 8 L36 36 M36 8 L8 36" stroke="#8f8a84" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
          <Img src={staticFile("logos/kimi-lockup-light.svg")} style={{ height: 116, opacity: Math.min(1, b * 1.3), transform: `scale(${0.88 + 0.12 * b})`, transformOrigin: "0 50%" }} />
        </div>
        <div style={{ marginTop: 72, fontFamily: FONT_UI, fontWeight: 500, fontSize: 40, letterSpacing: 22, paddingLeft: 22, color: "#24211c", ...t }}>联袂打造</div>
      </AbsoluteFill>
      <div style={{ position: "absolute", bottom: 54, left: 0, right: 0, textAlign: "center", fontFamily: FONT_UI, fontSize: 17, color: "#9a958e", letterSpacing: 1, opacity: note }}>
        画面为 Kimi Work 法律行业发行版开发中版本的界面演示 · 案例与数据均为虚构
      </div>
      <AbsoluteFill style={{ background: "#000", opacity: end }} />
    </AbsoluteFill>
  );
}
