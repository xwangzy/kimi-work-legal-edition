/**
 * 封面：夜色里的法条星海（随包法规库真实条文）与一颗蓝点；主题句 + 产品名。
 * 16:9（4K）、1:1、3:4。背景取第一幕某一帧（去掉字幕）。
 */
import { AbsoluteFill, Sequence } from "remotion";
import { COPY } from "./copy";
import { S1Corpus } from "./scenes/S1Corpus";
import { EditionTag, Grain, KimiDot, KimiMark } from "./ui/film";
import { FONT_LATIN, FONT_SERIF, FONT_TITLE, useGlyphs } from "./fonts";

const BG_FRAME = 1000;

function Brand({ scale = 1 }: { scale?: number }) {
  const M = 64 * scale;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 18 * scale }}>
      <KimiMark size={M} dark />
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 * scale }}>
          <svg width={(236 * 34 * scale) / 52} height={34 * scale} viewBox="0 0 236 52" style={{ display: "block", overflow: "visible" }}>
            <text x="0" y="44" fill="#f4f1ea" fontSize="50" fontWeight="800" textLength="234" lengthAdjust="spacing" fontFamily={`BlinkMacSystemFont, -apple-system, "Helvetica Neue", Arial, sans-serif`}>
              Kimi Work
            </text>
          </svg>
          <EditionTag h={15 * scale} dark />
        </div>
        <div style={{ marginTop: 6 * scale, fontFamily: FONT_TITLE, fontSize: 15 * scale, letterSpacing: 5 * scale, color: "rgba(244,241,234,0.62)" }}>法律行业发行版</div>
      </div>
    </div>
  );
}

export function Cover() {
  useGlyphs(COPY.f3 + "中软国际 × Kimi 联袂打造法律行业发行版");
  return (
    <AbsoluteFill style={{ background: "#07080a" }}>
      <AbsoluteFill style={{ transform: "translateX(360px) scale(1.12)", filter: "brightness(1.35)" }}>
        <Sequence from={-BG_FRAME}>
          <S1Corpus captions={false} dot={false} />
        </Sequence>
      </AbsoluteFill>
      <AbsoluteFill style={{ background: "linear-gradient(90deg, rgba(7,8,10,0.94) 0%, rgba(7,8,10,0.72) 34%, rgba(7,8,10,0) 62%)" }} />
      <div style={{ position: "absolute", left: 1330 - 9, top: 420 - 9 }}>
        <KimiDot size={18} glow={1.4} />
      </div>
      <AbsoluteFill style={{ background: "linear-gradient(0deg, rgba(7,8,10,0.75) 0%, rgba(7,8,10,0) 40%)" }} />
      <div style={{ position: "absolute", left: 128, top: 380, fontFamily: FONT_SERIF, fontSize: 64, fontWeight: 600, lineHeight: 1.5, letterSpacing: "0.05em", color: "#f1ece2" }}>
        让智能承担繁复，
        <br />
        把时间留给判断。
      </div>
      <div style={{ position: "absolute", left: 132, top: 594, fontFamily: FONT_LATIN, fontSize: 22, letterSpacing: "0.1em", color: "rgba(241,236,226,0.5)" }}>{COPY.f3en}</div>
      <div style={{ position: "absolute", left: 128, bottom: 112 }}>
        <Brand />
      </div>
      <div style={{ position: "absolute", right: 112, bottom: 120, fontFamily: FONT_TITLE, fontSize: 17, letterSpacing: 4, color: "rgba(241,236,226,0.5)" }}>中软国际 × Kimi　联袂打造</div>
      <Grain opacity={0.04} />
    </AbsoluteFill>
  );
}

export function CoverSocial({ ratio }: { ratio: "1x1" | "3x4" }) {
  useGlyphs(COPY.f3 + "中软国际 × Kimi 联袂打造法律行业发行版");
  const h = ratio === "1x1" ? 1080 : 1440;
  return (
    <AbsoluteFill style={{ background: "#07080a", overflow: "hidden" }}>
      <div style={{ position: "absolute", left: -420, top: (h - 1080) / 2, width: 1920, height: 1080 }}>
        <AbsoluteFill style={{ filter: "brightness(1.35)" }}>
          <Sequence from={-BG_FRAME}>
            <S1Corpus captions={false} dot={false} />
          </Sequence>
        </AbsoluteFill>
      </div>
      <div style={{ position: "absolute", left: 760 - 9, top: h * 0.3 - 9 }}>
        <KimiDot size={18} glow={1.4} />
      </div>
      <AbsoluteFill style={{ background: "linear-gradient(0deg, rgba(7,8,10,0.94) 0%, rgba(7,8,10,0.7) 42%, rgba(7,8,10,0.1) 75%)" }} />
      <div style={{ position: "absolute", left: 96, bottom: h * 0.3, fontFamily: FONT_SERIF, fontSize: 66, fontWeight: 600, lineHeight: 1.5, letterSpacing: "0.05em", color: "#f1ece2" }}>
        让智能承担繁复，
        <br />
        把时间留给判断。
      </div>
      <div style={{ position: "absolute", left: 100, bottom: h * 0.3 - 46, fontFamily: FONT_LATIN, fontSize: 20, letterSpacing: "0.1em", color: "rgba(241,236,226,0.5)" }}>{COPY.f3en}</div>
      <div style={{ position: "absolute", left: 96, bottom: 96 }}>
        <Brand scale={1.05} />
      </div>
      <div style={{ position: "absolute", right: 80, bottom: 108, fontFamily: FONT_TITLE, fontSize: 16, letterSpacing: 4, color: "rgba(241,236,226,0.5)" }}>中软国际 × Kimi</div>
      <Grain opacity={0.04} />
    </AbsoluteFill>
  );
}
