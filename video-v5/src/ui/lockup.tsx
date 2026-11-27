/**
 * 产品标识组合（与产品界面一致：Kimi 官方 Logomark + 粗体“Kimi Work”+ 黑底白字“法律版”小标），下方“法律行业发行版”。
 * 第三幕登场（三问 → 蓝点 → 标识）与首页匹配剪辑共用同一套几何。
 */
import { FONT_TITLE, useGlyphs } from "../fonts";
import { DOT_C, EditionTag, INK, KimiMark, Wordmark } from "./film";

export const LK = { M: 118, GAP: 30, WH: 62, TAG_H: 24, X0: 0, Y0: 0 };
// 整组宽度：标识 + 间距 + 字标（236/52 * WH）+ 小标间距 + 小标
const WORD_W = (236 * LK.WH) / 52;
const TAG_W = ((3 * 11.5 + 9) * LK.TAG_H) / 17;
export const LK_W = LK.M + LK.GAP + WORD_W + 14 + TAG_W;
export const LK_X0 = 960 - LK_W / 2;
export const LK_Y0 = 470;
/** 蓝点在画面上的位置（标识内）。 */
export const LK_DOT = { x: LK_X0 + (LK.M * DOT_C.x) / 180, y: LK_Y0 + (LK.M * DOT_C.y) / 180, size: (LK.M * DOT_C.r * 2) / 180 };
export const LK_WORD = { x: LK_X0 + LK.M + LK.GAP, y: LK_Y0 + (LK.M - LK.WH) / 2 - 12, w: WORD_W, h: LK.WH };

/** mark：标识显现 0..1（dot 单独由调用方画时 showDot=false）；word：字标揭示；tag：小标；sub：副名。 */
export function Lockup({ mark, word, tag, sub, showDot = true, subText = "法律行业发行版" }: { mark: number; word: number; tag: number; sub: number; showDot?: boolean; subText?: string }) {
  useGlyphs(subText);
  return (
    <>
      <div style={{ position: "absolute", left: LK_X0, top: LK_Y0, opacity: mark, transform: `scale(${0.9 + 0.1 * mark})`, transformOrigin: `${(DOT_C.x / 180) * 100}% ${(DOT_C.y / 180) * 100}%` }}>
        <KimiMark size={LK.M} dot={showDot ? 1 : 0} />
      </div>
      <div style={{ position: "absolute", left: LK_WORD.x, top: LK_WORD.y, WebkitMaskImage: `linear-gradient(90deg, #000 ${word * 120 - 20}%, transparent ${word * 120}%)`, WebkitMaskRepeat: "no-repeat", transform: `translateX(${(1 - word) * -14}px)` }}>
        <Wordmark h={LK.WH} color={INK} />
      </div>
      <div style={{ position: "absolute", left: LK_WORD.x + WORD_W + 14, top: LK_WORD.y + 8, opacity: tag, transform: `translateY(${(1 - tag) * 6}px)` }}>
        <EditionTag h={LK.TAG_H} />
      </div>
      <div style={{ position: "absolute", left: LK_WORD.x + 3, top: LK_WORD.y + LK.WH + 18, fontFamily: FONT_TITLE, fontSize: 25, fontWeight: 500, letterSpacing: 9, color: "#57534d", opacity: sub, transform: `translateY(${(1 - sub) * 8}px)` }}>{subText}</div>
    </>
  );
}
