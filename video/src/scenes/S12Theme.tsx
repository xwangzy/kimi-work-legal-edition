/** S12 · 主题：让法律专业能力，进入 AI 时代。Legal Intelligence. Reimagined. */
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { easeInOut, map, prog, reveal, vanish } from "../lib/anim";
import { FONT_DISPLAY, FONT_EN, NightBackdrop, Vignette } from "../ui/film";

export function S12Theme() {
  const f = useCurrentFrame();
  const l1 = reveal(f, 10, 30, 30);
  const l2 = reveal(f, 30, 30, 30);
  const en = prog(f, 80, 40, easeInOut);
  const out = vanish(f, 172, 18, -10);
  return (
    <AbsoluteFill>
      <NightBackdrop glow={map(f, [0, 120], [0.4, 1.4])} glowY={46} />
      <Vignette strength={0.5} />
      <AbsoluteFill style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", opacity: out.opacity, filter: out.filter }}>
        <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 92, lineHeight: 1.25, color: "#f5f4f1", letterSpacing: 2, textAlign: "center" }}>
          <div style={l1}>让法律专业能力，</div>
          <div style={l2}>进入 AI 时代。</div>
        </div>
        <div
          style={{
            marginTop: 54,
            fontFamily: FONT_EN,
            fontWeight: 500,
            fontSize: 38,
            color: "rgba(245,244,241,0.7)",
            letterSpacing: map(en, [0, 1], [18, 6]),
            opacity: en,
            filter: `blur(${(1 - en) * 8}px)`,
          }}
        >
          Legal Intelligence. Reimagined.
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
