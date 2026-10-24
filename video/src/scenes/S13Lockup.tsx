/** S13 · 产品名：从夜色中亮起暖白，字标落定。 */
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { easeInOut, prog, reveal } from "../lib/anim";
import { FONT_UI, NightBackdrop, StudioBackdrop } from "../ui/film";
import { BrandLockup } from "./S04Reveal";

export function S13Lockup() {
  const f = useCurrentFrame();
  const day = prog(f, 0, 26, easeInOut);
  const t = reveal(f, 46, 24, 16);
  return (
    <AbsoluteFill>
      <NightBackdrop />
      <AbsoluteFill style={{ clipPath: `circle(${day * 75}% at 50% 50%)` }}>
        <StudioBackdrop />
      </AbsoluteFill>
      <AbsoluteFill style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 46, opacity: 1 - prog(f, 112, 16), filter: `blur(${prog(f, 112, 16) * 6}px)` }}>
        <BrandLockup f={f} at={10} scale={1.12} />
        <div style={{ fontFamily: FONT_UI, fontSize: 28, letterSpacing: 4, color: "#6b6862", ...t }}>面向专业法律工作者的 AI 工作平台</div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
