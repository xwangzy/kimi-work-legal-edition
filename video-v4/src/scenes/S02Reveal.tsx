/**
 * S02 登场（2.5 小节，360 帧）：蓝点 → Kimi 标识 → 产品名 → 匹配剪辑到首页中央字标。
 * 蓝点从画面中央移到标识右上角的位置，暖白从蓝点处以圆形展开；黑底与 K 形围绕蓝点显影；
 * “Kimi Work / 法律行业发行版”自遮罩中出现；随后标识与副名退去，字标移到首页字标的位置与大小，交给 S03。
 */
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { FONT_TITLE, useGlyphs } from "../fonts";
import { DOT_C, EditionTag, easeCine, easeIn, easeInOut, easeOut, Grain, INK, KimiDot, KimiMark, lerp, NightBackdrop, prog, StudioBackdrop, Vignette, Wordmark } from "../ui/film";
import { HOME_CAM0, HOME_WORD } from "./S03Home";

const M = 150; // 标识边长
const WH = 104; // 字标高度
const WW = (236 * WH) / 52;
const GAP = 46;
const X0 = 960 - (M + GAP + WW) / 2;
const Y0 = 540 - M / 2 - 6;
const DOT = { x: X0 + (DOT_C.x / 180) * M, y: Y0 + (DOT_C.y / 180) * M };
const DOT_FINAL = (19 / 180) * M; // 标识里蓝点的外接尺寸

export function S02Reveal() {
  const f = useCurrentFrame();
  useGlyphs("法律行业发行版");
  const move = prog(f, 36, 96, easeInOut);
  const open = prog(f, 64, 110, easeInOut);
  const bg = prog(f, 126, 34, easeOut);
  const k = bg;
  const word = prog(f, 150, 64, easeOut);
  const sub = prog(f, 186, 56, easeOut);
  const toHome = prog(f, 252, 96, easeCine);
  const markOut = prog(f, 246, 44, easeIn);
  const badge = prog(f, 186, 40, easeOut);

  const dx = lerp(960, DOT.x, move);
  const dy = lerp(540, DOT.y, move);
  const ds = lerp(26, DOT_FINAL, move);
  const breathe = 1 + Math.sin(f / 9) * 0.06 * (1 - move);

  // 字标：从产品名位置移到首页字标在 S03 第一帧的位置与大小
  const targetH = HOME_WORD.h * HOME_CAM0.s;
  const wh = lerp(WH, targetH, toHome);
  const wx = lerp(X0 + M + GAP, 960 + (HOME_WORD.x - HOME_CAM0.fx) * HOME_CAM0.s, toHome);
  const wy = lerp(Y0 + 2, 540 + (HOME_WORD.y - HOME_CAM0.fy) * HOME_CAM0.s, toHome);

  return (
    <AbsoluteFill style={{ overflow: "hidden", background: "#07080a" }}>
      <NightBackdrop glow={0.5} />
      <AbsoluteFill style={{ WebkitMaskImage: `radial-gradient(circle at ${dx}px ${dy}px, #000 ${open * 2300}px, transparent ${open * 2300 + Math.min(22, open * 2300 * 0.3) + 0.5}px)` }}>
        <StudioBackdrop />
        <Vignette strength={0.16} />
      </AbsoluteFill>
      {/* 标识：黑底、K 形围绕蓝点显影 */}
      <div style={{ position: "absolute", left: X0, top: Y0, opacity: 1 - markOut, transform: `translateX(${-markOut * 40}px) scale(${0.6 + 0.4 * bg})`, transformOrigin: `${(DOT_C.x / 180) * 100}% ${(DOT_C.y / 180) * 100}%` }}>
        <KimiMark size={M} bg={bg > 0.001 ? 1 : 0} k={bg > 0.001 ? 1 : 0} dot={move >= 0.999 ? 1 : 0} />
      </div>
      {/* 蓝点（标识显影前独立存在；显影后与标识里的蓝点重合） */}
      {move < 0.999 && (
        <div style={{ position: "absolute", left: dx - ds / 2, top: dy - ds / 2, transform: `scale(${breathe})` }}>
          <KimiDot size={ds} glow={(1 - move) * 0.9} />
        </div>
      )}
      {/* 字标 */}
      <div style={{ position: "absolute", left: wx, top: wy, WebkitMaskImage: `linear-gradient(90deg, #000 ${word * 120 - 20}%, transparent ${word * 120}%)`, WebkitMaskRepeat: "no-repeat", transform: `translateX(${(1 - word) * -18}px)` }}>
        <Wordmark h={wh} color={INK} />
      </div>
      <div style={{ position: "absolute", left: wx + (242 / 236) * ((236 * wh) / 52), top: wy + (2 / 52) * wh, opacity: badge, transform: `translateY(${(1 - badge) * 6}px)` }}>
        <EditionTag h={(22 / 52) * wh} />
      </div>
      <Grain opacity={0.035} />
    </AbsoluteFill>
  );
}
export const REVEAL_END_EASE = easeOut;
