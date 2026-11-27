/**
 * 落版（10 秒）：产品名 → 中软国际 × Kimi 联袂打造。
 *  - 暖白里一颗蓝点落下，Kimi 官方 Logomark 在它周围成形；Kimi Work · 法律版 ／ 法律行业发行版（停 ≥ 3 秒）；
 *  - 字标与副名退去，标识移到右侧；中软国际标识在左侧“落印”（与 Kimi 标识等边长、以“×”为中轴对称）；
 *    “×”两笔画出；标识下方分别为“中软国际”与 Kimi 官方字标；细线夹“联袂打造”；一道光缓缓掠过；静止约 4 秒后淡出。
 * 标识全部原样使用（public/logos：maas-site 的 logo-csi.png 与 ~/Downloads/KIMI-logos 官方 SVG），不改形改色。
 */
import { AbsoluteFill, Easing, Img, staticFile, useCurrentFrame } from "remotion";
import { COPY } from "../copy";
import { FINALE as T } from "../beats";
import { easeCine, easeIn, easeInOut, easeOut, Grain, KimiDot, KimiMark, lerp, map, prog, StudioBackdrop } from "../ui/film";
import { FONT_LATIN, FONT_SERIF, FONT_TITLE, useGlyphs } from "../fonts";
import { LK, LK_DOT, LK_X0, LK_Y0, Lockup } from "../ui/lockup";

const KM = 168; // Kimi 标识边长
const SEAL = KM; // 中软国际标识（方形印章）等边长：两者光学重量接近
const XS = 56;
const XGAP = 84;
const ROW_Y = 470;
const SEAL_X = 960 - XS / 2 - XGAP - SEAL;
const KM_X = 960 + XS / 2 + XGAP;

export function S8Finale() {
  const f = useCurrentFrame();
  useGlyphs(COPY.partner + COPY.footnote + "中软国际");
  // 主题句从上一场延续（静止 ≥ 5 秒的后半段），随后退去
  const themeO = 1 - prog(f, T.THEME_OUT, 36, easeInOut);
  // 产品名
  const dotIn = prog(f, T.DOT, 24, easeOut);
  const mark = prog(f, T.MARK, 46, easeOut);
  const word = prog(f, T.MARK + 18, 52, easeOut);
  const tag = prog(f, T.MARK + 40, 30, easeOut);
  const sub = prog(f, T.MARK + 56, 40, easeOut);
  const leave = prog(f, T.NAME_OUT, 24, easeIn);
  // 标识移到右侧
  const travel = prog(f, T.NAME_OUT + 8, 64, easeCine);
  const mx = lerp(LK_X0, KM_X, travel);
  const my = lerp(LK_Y0, ROW_Y - KM / 2, travel);
  const ms = lerp(LK.M, KM, travel);
  const stamp = prog(f, T.STAMP, 24, Easing.bezier(0.2, 0.8, 0.2, 1));
  const stampShadow = map(f, [T.STAMP, T.STAMP + 24, T.STAMP + 70], [0, 1, 0]);
  const cross = prog(f, T.CROSS, 34, easeOut);
  const cross2 = prog(f, T.CROSS + 8, 34, easeOut);
  const names = prog(f, T.NAMES, 40, easeOut);
  const tagP = prog(f, T.TAG, 50, easeOut);
  const note = prog(f, T.NOTE, 50) * (1 - prog(f, T.FADE - 20, 30));
  const sweep = map(f, [T.TAG, T.FADE], [-0.25, 1.25], easeInOut);
  const toBlack = prog(f, T.FADE, 46, easeInOut);
  const bar = (rot: number, p: number) => <div style={{ position: "absolute", left: XS / 2 - 2.5, top: XS / 2 - 39 * p, width: 5, height: 78 * p, borderRadius: 2.5, background: "#111", transform: `rotate(${rot}deg)`, transformOrigin: `2.5px ${39 * p}px` }} />;
  const partnerPhase = f >= T.NAME_OUT;
  return (
    <AbsoluteFill style={{ overflow: "hidden", background: "#07080a" }}>
      <StudioBackdrop cy={44} floor={0} />
      {themeO > 0.002 && (
        <>
          <div style={{ position: "absolute", left: 60, right: 60, top: 520 - 66 * 1.62 / 2, textAlign: "center", fontFamily: FONT_SERIF, fontSize: 66, fontWeight: 600, lineHeight: 1.62, letterSpacing: "0.06em", color: "#1d1a16", opacity: themeO, transform: `translateY(${-(1 - themeO) * 14}px)`, filter: themeO < 0.99 ? `blur(${(1 - themeO) * 6}px)` : undefined, whiteSpace: "nowrap" }}>{COPY.f3}</div>
          <div style={{ position: "absolute", left: 0, right: 0, top: 600, textAlign: "center", fontFamily: FONT_LATIN, fontSize: 27, fontWeight: 400, letterSpacing: "0.14em", color: "#77736c", opacity: themeO }}>{COPY.f3en}</div>
        </>
      )}
      <AbsoluteFill style={{ background: `radial-gradient(28% 55% at ${sweep * 100}% 44%, rgba(255,255,255,0.75) 0%, rgba(255,255,255,0) 70%)`, opacity: partnerPhase ? 0.6 : 0 }} />
      {!partnerPhase || leave < 0.999 ? (
        <div style={{ opacity: 1 - leave, filter: leave > 0.01 ? `blur(${leave * 6}px)` : undefined }}>
          <Lockup mark={partnerPhase ? 0 : mark} word={word} tag={tag} sub={sub} showDot={false} />
        </div>
      ) : null}
      {/* 产品名阶段的标识（含蓝点）；进入联合落版后由下面的移动标识接手 */}
      {!partnerPhase && f >= T.DOT && (
        <div style={{ position: "absolute", left: LK_DOT.x - LK_DOT.size / 2, top: LK_DOT.y - LK_DOT.size / 2, opacity: dotIn, transform: `scale(${1 + (1 - dotIn) * 0.6})` }}>
          <KimiDot size={LK_DOT.size} glow={(1 - mark) * 0.8} />
        </div>
      )}
      {partnerPhase && (
        <div style={{ position: "absolute", left: mx, top: my }}>
          <KimiMark size={ms} />
        </div>
      )}
      {stamp > 0.001 && (
        <div style={{ position: "absolute", left: SEAL_X, top: ROW_Y - SEAL / 2, width: SEAL, height: SEAL, opacity: Math.min(1, stamp * 2.2), transform: `scale(${1.08 - 0.08 * stamp})`, filter: `drop-shadow(0 ${lerp(14, 3, stamp)}px ${lerp(16, 4, stamp)}px rgba(60,20,20,${0.2 * stampShadow}))`, mixBlendMode: "multiply" }}>
          <Img src={staticFile("logos/csi.png")} style={{ width: SEAL, height: SEAL, display: "block" }} />
        </div>
      )}
      {cross > 0.001 && (
        <div style={{ position: "absolute", left: 960 - XS / 2, top: ROW_Y - XS / 2, width: XS, height: XS }}>
          {bar(45, cross)}
          {bar(-45, cross2)}
        </div>
      )}
      <div style={{ position: "absolute", left: SEAL_X + SEAL / 2 - 120, width: 240, top: ROW_Y + KM / 2 + 24, textAlign: "center", fontFamily: FONT_TITLE, fontSize: 24, fontWeight: 500, letterSpacing: 2.8, color: "#1f1f1f", opacity: names, transform: `translateY(${(1 - names) * 6}px)` }}>中软国际</div>
      <div style={{ position: "absolute", left: KM_X + KM / 2 - (375 / 125) * 9.5, top: ROW_Y + KM / 2 + 29, opacity: names, transform: `translateY(${(1 - names) * 6}px)` }}>
        <Img src={staticFile("logos/kimi-logotype-light.svg")} style={{ height: 19, width: (375 / 125) * 19, display: "block" }} />
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: ROW_Y + KM / 2 + 104, display: "flex", justifyContent: "center", alignItems: "center", gap: 28, opacity: tagP, transform: `translateY(${(1 - tagP) * 10}px)` }}>
        <div style={{ width: 130 * tagP, height: 1, background: "#cfccc4" }} />
        <div style={{ fontFamily: FONT_TITLE, fontSize: 38, fontWeight: 500, letterSpacing: "0.36em", marginRight: "-0.36em", color: "#1f1f1f" }}>{COPY.partner}</div>
        <div style={{ width: 130 * tagP, height: 1, background: "#cfccc4" }} />
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 50, textAlign: "center", fontFamily: FONT_TITLE, fontSize: 24, letterSpacing: 0.8, color: "#7a756e", opacity: note }}>{COPY.footnote}</div>
      <Grain opacity={0.02} />
      <AbsoluteFill style={{ background: "#07080a", opacity: toBlack, pointerEvents: "none" }} />
    </AbsoluteFill>
  );
}
