/**
 * 第六幕 · 升华（13.3 秒）
 *  - 回到第二幕那张桌子：台灯熄灭，晨光从左上斜照进来；桌上只剩一页——律师接受意见后的第 7.1 条（清洁稿文字，
 *    逐字取自本次真实任务“接受后”视图）。不写时间戳，不说“效率提升多少”，让观众看见时间回来了。
 *  - “法律的价值，从来不只是处理信息。”→“而是 理解复杂，作出判断，守护信任。”（三个动词一拍一个）
 *  - 画面退成一片暖白，主题句居中：“让智能承担繁复，把时间留给判断。” Intelligence for the complexity. Time for judgment.（静止 ≥ 5 秒，跨到落版开头）
 */
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { COPY } from "../copy";
import { DAWN as T } from "../beats";
import { cam, easeInOut, easeOut, Grain, map, prog, ProductStage, StudioBackdrop } from "../ui/film";
import { FONT_LATIN, useGlyphs } from "../fonts";
import { DESK_H, DESK_W, DeskSurface, Pen, WindowLight } from "../ui/desk";
import { ClauseRedline } from "../ui/redline";
import { Clock, Manifesto } from "../ui/type";

const CARD_X = DESK_W / 2 - 560;
const CARD_Y = DESK_H / 2 - 330;

export function S7Dawn() {
  const f = useCurrentFrame();
  useGlyphs(COPY.f3en);
  // 光：台灯亮着进场 → 熄灭（开关一声）→ 片刻的冷暗 → 晨光从左上斜照进来
  const lamp = 1 - prog(f, T.LAMP_OFF, 10, easeInOut);
  const day = prog(f, T.DAY + 20, 200, easeInOut);
  const enter = prog(f, 0, 30, easeInOut);
  const toWhite = prog(f, T.THEME - 40, 90, easeInOut); // 第二句开始退场之后才转白
  // 与第二幕台灯段后拉终点同一机位（同一张桌子、同一角度），随后极慢地推近
  // 开头与第二幕开场同一景别：台灯下第 7.1 条的微距（这次是修订后的那一行）；熄灯、晨光后再后拉到第二幕的桌面机位
  const keys = [
    cam(0, CARD_X + 700, CARD_Y + 150, 1.55, 1, 0, 0, 0),
    cam(T.PULL, CARD_X + 640, CARD_Y + 170, 1.42, 4, 0, 0, 0),
    cam(T.PULL + 260, DESK_W / 2 + 120, DESK_H / 2 - 60, 0.66, 32, 0, 220, 40),
    cam(T.THEME, DESK_W / 2 + 70, DESK_H / 2 - 30, 0.72, 30, 0, 190, 24),
    cam(1100, DESK_W / 2 + 60, DESK_H / 2 - 20, 0.75, 29, 0, 180, 20),
  ];
  const macroGlow = map(f, [30, 80, T.LAMP_OFF - 20, T.LAMP_OFF + 20], [0, 1, 1, 0]);
  const verbs = COPY.f2;
  const en = prog(f, T.EN, 60, easeOut);
  const shaft = (f / 60) * 6; // 光柱缓慢移动
  return (
    <AbsoluteFill style={{ overflow: "hidden", background: "#07080a" }}>
      <AbsoluteFill style={{ opacity: enter, filter: `blur(${(toWhite * 10).toFixed(2)}px)` }}>
        <ProductStage cam={keys} w={DESK_W} h={DESK_H} perspective={2400} drift={0.2}>
          <DeskSurface lamp={lamp} day={day} lx={DESK_W / 2 + 60} ly={DESK_H / 2 - 40} />
          {/* 桌上只剩一页：律师接受意见后的第 7.1 条（修订痕迹逐字取自本次任务“接受后”视图） */}
          <div style={{ position: "absolute", left: CARD_X, top: CARD_Y, transform: "rotate(-1.2deg)" }}>
            <ClauseRedline strike={1} ins={1} w={1120} glow={macroGlow} light={0.62 + 0.38 * Math.max(lamp * 0.9, day)} />
          </div>
          <WindowLight p={day * 0.9} x={DESK_W / 2 - 1900} y={DESK_H / 2 - 1300} />
          {/* 同一支钢笔，已经合上帽 */}
          <Pen L={500} capped style={{ left: DESK_W / 2 + 620, top: DESK_H / 2 + 260, transform: "rotate(-24deg)", transformOrigin: "0 50%" }} />
          {/* 晨光透过窗格投在桌面上的光柱（斜向、柔边） */}
          <div style={{ position: "absolute", left: 0, top: 0, width: DESK_W, height: DESK_H, opacity: day * 0.4, mixBlendMode: "screen", background: `repeating-linear-gradient(118deg, rgba(255,236,200,0) ${0 + shaft}px, rgba(255,236,200,0.2) ${160 + shaft}px, rgba(255,236,200,0.26) ${260 + shaft}px, rgba(255,236,200,0) ${420 + shaft}px, rgba(255,236,200,0) ${900 + shaft}px)` }} />
          {/* 熄灯后片刻的冷暗（清晨前的蓝） */}
          <div style={{ position: "absolute", left: 0, top: 0, width: DESK_W, height: DESK_H, background: "rgba(40,56,84,0.35)", opacity: (1 - lamp) * (1 - day) }} />
        </ProductStage>
      </AbsoluteFill>
      {/* 暖白：主题 */}
      <AbsoluteFill style={{ opacity: toWhite }}>
        <StudioBackdrop cy={44} floor={0} />
      </AbsoluteFill>
      <AbsoluteFill style={{ pointerEvents: "none", background: `radial-gradient(90% 80% at 50% 50%, rgba(0,0,0,0) 45%, rgba(0,0,0,${0.5 * (1 - toWhite) * (1 - day * 0.5)}) 100%)` }} />
      <Clock times={[{ f: 0, t: "02:16" }, { f: T.DAY + 80, t: "08:30" }]} at={20} out={T.THEME - 40} />
      <Manifesto lines={[COPY.f1]} at={T.F1} out={T.F1_OUT} y={924} size={58} cps={16} scrim={0.96} />
      <Manifesto
        lines={[[{ t: verbs[0] }, { t: verbs[1], d: 10 }, { t: verbs[2], d: 10 + T.VERB - 25 }, { t: verbs[3], d: 10 + 2 * T.VERB - 50 }]]}
        at={T.F2}
        out={T.F2_OUT}
        y={924}
        size={58}
        cps={20}
        scrim={0.88}
      />
      <Manifesto lines={[COPY.f3]} at={T.THEME} y={520} size={66} dark={false} cps={12} />
      <div style={{ position: "absolute", left: 0, right: 0, top: 600, textAlign: "center", fontFamily: FONT_LATIN, fontSize: 27, fontWeight: 400, letterSpacing: "0.14em", color: "#77736c", opacity: en, transform: `translateY(${(1 - en) * 8}px)` }}>{COPY.f3en}</div>
      <Grain opacity={0.035} />
    </AbsoluteFill>
  );
}
export { easeOut, map };
