/**
 * 品牌宣传片封面（主视觉，静帧）：暖白摄影棚；右侧真实审查工作台（第 7.1 条被标出）悬浮在透视里，前景是律师接受意见后生成的修订稿；
 * 左侧主题句与产品名；底部中软国际 × Kimi 联袂打造。所有界面与文书均为片中真实采集画面。
 */
import { AbsoluteFill, Img, staticFile } from "remotion";
import { FONT_LATIN, FONT_TITLE, useGlyphs } from "./fonts";
import { AppWindow, Grain, INK, KimiMark, StudioBackdrop, Vignette, Wordmark } from "./ui/film";
import { Snap, SnapCrop } from "./ui/Snap";

export function Cover() {
  useGlyphs("让法律专业能力，进入 AI 时代。法律行业发行版联袂打造Legal Intelligence. Reimagined.");
  const H = 54;
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <StudioBackdrop cx={66} cy={34} />
      <AbsoluteFill style={{ perspective: 2600, perspectiveOrigin: "60% 45%" }}>
        <div style={{ position: "absolute", left: 980, top: 150, width: 1440, height: 900, transformOrigin: "0 0", transform: "rotateY(-14deg) rotateX(4deg) scale(0.78)" }}>
          <AppWindow shadow={1}>
            <Snap name="w04-acc" />
          </AppWindow>
        </div>
        <div style={{ position: "absolute", left: 1180, top: 470, transformOrigin: "0 0", transform: "rotateY(-10deg) rotateX(8deg) rotateZ(-3deg)", filter: "drop-shadow(0 40px 50px rgba(40,30,20,0.25))", WebkitMaskImage: "linear-gradient(180deg, #000 72%, transparent 100%)" }}>
          <SnapCrop name="s20-signed-top" rect={{ x: 334, y: 262, w: 592, h: 610 }} scale={1.02} radius={3} />
        </div>
      </AbsoluteFill>
      <AbsoluteFill style={{ background: "linear-gradient(90deg, rgba(244,243,240,0.98) 0%, rgba(244,243,240,0.92) 34%, rgba(244,243,240,0.4) 50%, rgba(244,243,240,0) 60%)" }} />
      <div style={{ position: "absolute", left: 140, top: 250, display: "flex", alignItems: "center", gap: 22 }}>
        <KimiMark size={76} />
        <div>
          <Wordmark h={H} />
          <div style={{ marginTop: 8, fontFamily: FONT_TITLE, fontSize: 19, fontWeight: 500, letterSpacing: 6, color: "#57534d" }}>法律行业发行版</div>
        </div>
      </div>
      <div style={{ position: "absolute", left: 140, top: 404, fontFamily: FONT_TITLE, fontWeight: 700, fontSize: 92, lineHeight: 1.22, letterSpacing: 1, color: INK }}>
        <div>让法律专业能力，</div>
        <div>进入 AI 时代。</div>
      </div>
      <div style={{ position: "absolute", left: 144, top: 668, fontFamily: FONT_LATIN, fontWeight: 400, fontSize: 30, letterSpacing: 2, color: "#6d6962" }}>Legal Intelligence. Reimagined.</div>
      {/* 联合落版（与片尾同一构成：中软国际印章 × Kimi 标识，等光学重量） */}
      <div style={{ position: "absolute", left: 140, top: 820, display: "flex", alignItems: "center", gap: 28 }}>
        <Img src={staticFile("logos/csi.png")} style={{ width: 64, height: 64, display: "block" }} />
        <div style={{ position: "relative", width: 22, height: 22 }}>
          <div style={{ position: "absolute", left: 9, top: -4, width: 3, height: 30, borderRadius: 1.5, background: "#111", transform: "rotate(45deg)" }} />
          <div style={{ position: "absolute", left: 9, top: -4, width: 3, height: 30, borderRadius: 1.5, background: "#111", transform: "rotate(-45deg)" }} />
        </div>
        <KimiMark size={64} />
        <span style={{ marginLeft: 8, fontFamily: FONT_TITLE, fontSize: 24, fontWeight: 500, letterSpacing: "0.3em", color: "#1f1f1f" }}>联袂打造</span>
      </div>
      <Vignette strength={0.12} />
      <Grain opacity={0.025} />
    </AbsoluteFill>
  );
}

/** 社交平台封面：1:1（1080×1080）与 3:4（1080×1440），同一组元素重新排版，联合落版完整。 */
export function CoverSocial({ ratio }: { ratio: "1x1" | "3x4" }) {
  useGlyphs("让法律专业能力，进入 AI 时代。法律行业发行版联袂打造Legal Intelligence. Reimagined.");
  const tall = ratio === "3x4";
  const H = tall ? 1440 : 1080;
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <StudioBackdrop cx={60} cy={tall ? 62 : 60} />
      <AbsoluteFill style={{ perspective: 2400, perspectiveOrigin: "55% 70%" }}>
        <div style={{ position: "absolute", left: 330, top: tall ? 700 : 540, width: 1440, height: 900, transformOrigin: "0 0", transform: "rotateY(-14deg) rotateX(6deg) scale(0.58)" }}>
          <AppWindow shadow={1}>
            <Snap name="w04-acc" />
          </AppWindow>
        </div>
        <div style={{ position: "absolute", left: 500, top: tall ? 860 : 660, transformOrigin: "0 0", transform: "rotateY(-10deg) rotateX(10deg) rotateZ(-3deg)", filter: "drop-shadow(0 40px 50px rgba(40,30,20,0.25))", WebkitMaskImage: "linear-gradient(180deg, #000 50%, transparent 92%)" }}>
          <SnapCrop name="s20-signed-top" rect={{ x: 334, y: 262, w: 592, h: 610 }} scale={0.9} radius={3} />
        </div>
      </AbsoluteFill>
      <AbsoluteFill style={{ background: `linear-gradient(180deg, rgba(244,243,240,0.98) 0%, rgba(244,243,240,0.94) ${tall ? 44 : 46}%, rgba(244,243,240,0.2) ${tall ? 62 : 66}%, rgba(244,243,240,0) 78%)` }} />
      <div style={{ position: "absolute", left: 96, top: 96, display: "flex", alignItems: "center", gap: 18 }}>
        <KimiMark size={64} />
        <div>
          <Wordmark h={46} />
          <div style={{ marginTop: 6, fontFamily: FONT_TITLE, fontSize: 16, fontWeight: 500, letterSpacing: 5, color: "#57534d" }}>法律行业发行版</div>
        </div>
      </div>
      <div style={{ position: "absolute", left: 96, top: tall ? 300 : 250, fontFamily: FONT_TITLE, fontWeight: 700, fontSize: tall ? 96 : 84, lineHeight: 1.22, letterSpacing: 1, color: INK }}>
        <div>让法律专业能力，</div>
        <div>进入 AI 时代。</div>
      </div>
      <div style={{ position: "absolute", left: 100, top: tall ? 560 : 480, fontFamily: FONT_LATIN, fontWeight: 400, fontSize: 28, letterSpacing: 2.5, color: "#6d6962" }}>Legal Intelligence. Reimagined.</div>
      {/* 联合落版托底：白色柔光，不压在界面上 */}
      <AbsoluteFill style={{ background: `linear-gradient(0deg, rgba(244,243,240,0.99) 0%, rgba(244,243,240,0.97) ${(230 / H) * 100}%, rgba(244,243,240,0) ${(380 / H) * 100}%)` }} />
      <div style={{ position: "absolute", left: 96, top: H - 150, display: "flex", alignItems: "center", gap: 24 }}>
        <Img src={staticFile("logos/csi.png")} style={{ width: 58, height: 58, display: "block" }} />
        <div style={{ position: "relative", width: 20, height: 20 }}>
          <div style={{ position: "absolute", left: 8.5, top: -4, width: 3, height: 28, borderRadius: 1.5, background: "#111", transform: "rotate(45deg)" }} />
          <div style={{ position: "absolute", left: 8.5, top: -4, width: 3, height: 28, borderRadius: 1.5, background: "#111", transform: "rotate(-45deg)" }} />
        </div>
        <KimiMark size={58} />
        <span style={{ marginLeft: 8, fontFamily: FONT_TITLE, fontSize: 22, fontWeight: 500, letterSpacing: "0.3em", color: "#1f1f1f" }}>联袂打造</span>
      </div>
      <Vignette strength={0.12} />
      <Grain opacity={0.025} />
    </AbsoluteFill>
  );
}
