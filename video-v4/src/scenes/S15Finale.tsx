/**
 * 收束四场：
 *  S14 价值（2 小节）：摄影棚里，律师签发后的清洁稿静静躺在光里（纸 → 界面 → 纸的闭环）；“AI 不是替代律师，而是延伸律师的专业能力。”
 *  S15 主题（2.5 小节）：夜色中主题句逐字显影，英文随后；蓝点再次亮起。
 *  S16 产品名（2 小节）：蓝点落进标识，夜色像灯亮起一样转为暖白；Kimi 标识 + Kimi Work + 法律行业发行版。
 *  S17 联袂打造（4.5 小节）：产品名退去，Kimi 标识移入官方组合标识的位置，KIMI 字标显影；中软国际印章在左侧显影，
 *      中间是 Kimi 合作模板里的“×”；下方“联袂打造”。两枚标识原样使用，按光学重量对齐；停留 6 秒以上，末尾淡出。
 */
import { createContext, useContext } from "react";
import { AbsoluteFill, Easing, Img, staticFile, useCurrentFrame } from "remotion";
import { FONT_LATIN, FONT_SERIF, FONT_TITLE, useGlyphs } from "../fonts";
import { DOT_C, easeCine, easeIn, easeInOut, easeOut, Grain, INK, KimiDot, KimiMark, lerp, map, NightBackdrop, prog, StudioBackdrop, Title, Vignette, Wordmark } from "../ui/film";
import { ClauseRedline } from "../ui/redline";

/* ───────── S14 价值（夜色，与片头呼应） ───────── */
// 片头夜色里那页纸的第 7.1 条，现在是律师接受后的样子（逐字取自本次任务的修订）——在同一束顶光下。
export function S14Value() {
  const f = useCurrentFrame();
  const push = map(f, [0, 288], [0, 1], easeInOut);
  const lightIn = prog(f, 4, 60, easeInOut);
  const out = prog(f, 240, 46, easeInOut);
  return (
    <AbsoluteFill style={{ overflow: "hidden", background: "#07080a" }}>
      <NightBackdrop glow={lightIn * 1.1} gy={58} size={58} />
      <AbsoluteFill style={{ perspective: 1900, perspectiveOrigin: "50% 40%" }}>
        <div style={{ position: "absolute", left: 960 - 600, top: 470, width: 1200, transformOrigin: "50% 0%", transform: `rotateX(${34 - push * 4}deg) rotateZ(${-2 + push}deg) translateY(${-push * 18}px) scale(${0.98 + push * 0.04})`, opacity: lightIn * (1 - out) }}>
          <ClauseRedline w={1200} strike={0} ins={1} clean light={0.92} />
        </div>
      </AbsoluteFill>
      {/* 顶光：只照亮纸面中部，四周沉入黑暗 */}
      <AbsoluteFill style={{ pointerEvents: "none", background: "radial-gradient(48% 42% at 50% 70%, rgba(7,8,10,0) 0%, rgba(7,8,10,0.25) 55%, rgba(7,8,10,0.85) 100%)" }} />
      <Title dark align="center" lines={["AI 不是替代律师，", "而是延伸律师的专业能力。"]} at={30} out={214} x={960} y={150} width={1600} size={66} stagger={22} />
      <Vignette strength={0.55} dark />
      <Grain opacity={0.05} />
    </AbsoluteFill>
  );
}

/* ───────── S15 主题 ───────── */
const THEME = "让法律专业能力，进入 AI 时代。";
export function S15Theme() {
  const f = useCurrentFrame();
  useGlyphs(THEME + "Legal Intelligence. Reimagined.");
  const chars = Array.from(THEME);
  const en = prog(f, 126, 60, easeOut);
  const dot = prog(f, 214, 40, easeOut);
  const out = prog(f, 300, 50, easeInOut);
  return (
    <AbsoluteFill style={{ background: "#07080a", overflow: "hidden" }}>
      <NightBackdrop glow={map(f, [0, 90, 360], [0.4, 1, 0.7])} gy={40} size={56} />
      <div style={{ position: "absolute", left: 0, right: 0, top: 420, textAlign: "center", fontFamily: FONT_TITLE, fontSize: 84, fontWeight: 700, letterSpacing: 2, color: "#f5f4f1", opacity: 1 - out, transform: `translateY(${-out * 20}px) translateX(${84 * 0.28}px)` }}>
        {chars.map((c, i) => {
          const p = prog(f, 14 + i * 4, 46, easeOut);
          return (
            <span key={i} style={{ display: "inline-block", opacity: p, filter: `blur(${(1 - p) * 12}px)`, transform: `translateY(${(1 - p) * 18}px)`, whiteSpace: "pre" }}>
              {c}
            </span>
          );
        })}
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 560, textAlign: "center", fontFamily: FONT_LATIN, fontWeight: 400, fontSize: 32, letterSpacing: 3.2, color: `rgba(245,244,241,${0.62 * en * (1 - out)})` }}>
        Legal Intelligence. Reimagined.
      </div>
      {dot > 0.001 && (
        <div style={{ position: "absolute", left: 960 - 13, top: lerp(700, 540, prog(f, 300, 60, easeInOut)) - 13, opacity: dot, transform: `scale(${(0.6 + 0.4 * dot) * (1 + Math.sin((f - 214) / 9) * 0.05)})` }}>
          <KimiDot size={26} glow={1} />
        </div>
      )}
      <Vignette strength={0.55} dark />
      <Grain opacity={0.05} />
    </AbsoluteFill>
  );
}

/* ───────── S16 产品名 ───────── */
export const LK = { M: 150, WH: 104, GAP: 46 };
const LK_WW = (236 * LK.WH) / 52;
export const LK_X0 = 960 - (LK.M + LK.GAP + LK_WW) / 2;
export const LK_Y0 = 540 - LK.M / 2 - 6;

export function S16Lockup() {
  const f = useCurrentFrame();
  useGlyphs("法律行业发行版");
  const dotX = LK_X0 + (DOT_C.x / 180) * LK.M;
  const dotY = LK_Y0 + (DOT_C.y / 180) * LK.M;
  // 小节线上的一拍：暖白从蓝点处展开（与登场同一动作），蓝点同时滑到标识右上角
  const open = prog(f, 0, 40, easeInOut);
  const move = prog(f, 0, 30, easeInOut);
  const mark = prog(f, 30, 26, easeOut);
  const word = prog(f, 40, 52, easeOut);
  const sub = prog(f, 70, 46, easeOut);
  const dx = lerp(960, dotX, move);
  const dy = lerp(540, dotY, move);
  const ds = lerp(26, (19 / 180) * LK.M, move);
  return (
    <AbsoluteFill style={{ background: "#07080a", overflow: "hidden" }}>
      <AbsoluteFill style={{ WebkitMaskImage: `radial-gradient(circle at ${dx}px ${dy}px, #000 ${Math.sqrt(open) * 2400}px, transparent ${Math.sqrt(open) * 2400 + Math.min(22, open * 200) + 0.5}px)` }}>
        <StudioBackdrop />
      </AbsoluteFill>
      <div style={{ position: "absolute", left: LK_X0, top: LK_Y0, opacity: mark, transform: `scale(${0.92 + 0.08 * mark})`, transformOrigin: `${(DOT_C.x / 180) * 100}% ${(DOT_C.y / 180) * 100}%` }}>
        <KimiMark size={LK.M} dot={move >= 0.999 ? 1 : 0} />
      </div>
      {move < 0.999 && (
        <div style={{ position: "absolute", left: dx - ds / 2, top: dy - ds / 2 }}>
          <KimiDot size={ds} glow={1 - move} />
        </div>
      )}
      <div style={{ position: "absolute", left: LK_X0 + LK.M + LK.GAP, top: LK_Y0 + 2, WebkitMaskImage: `linear-gradient(90deg, #000 ${word * 120 - 20}%, transparent ${word * 120}%)`, WebkitMaskRepeat: "no-repeat", transform: `translateX(${(1 - word) * -16}px)` }}>
        <Wordmark h={LK.WH} color={INK} />
      </div>
      <div style={{ position: "absolute", left: LK_X0 + LK.M + LK.GAP + 4, top: LK_Y0 + LK.WH + 14, fontFamily: FONT_TITLE, fontSize: 27, fontWeight: 500, letterSpacing: 8.5, color: "#57534d", opacity: sub, transform: `translateY(${(1 - sub) * 10}px)` }}>
        法律行业发行版
      </div>
      <Grain opacity={0.03} />
    </AbsoluteFill>
  );
}

/* ───────── S17 联袂打造 ───────── */
// 以“×”为中轴的对称落版：左中软国际印章、右 Kimi 官方 Logomark，两枚方形标识按光学重量匹配
// （直角实心红印章比圆角黑底标识显大，边长取 0.95）；“×”取 Kimi 官方合作模板（Partnerships）里的形状比例。
const KM = 160; // Kimi 标识边长
const SEAL = KM; // 印章红色覆盖率低于标识黑底，等边长视觉重量最接近
const XS = 54; // “×”外接尺寸
const XGAP = 74; // “×”到两侧标识的间距
const ROW_Y0 = 452; // 标识行中线
/** 30 秒版在落版上方加产品名时，整块标识随之下移（正片为 0）。 */
export const PartnerShift = createContext(0);
const SEAL_X = 960 - XS / 2 - XGAP - SEAL;
const KM_X = 960 + XS / 2 + XGAP;

export function S17Partner() {
  const f = useCurrentFrame();
  const ROW_Y = ROW_Y0 + useContext(PartnerShift);
  useGlyphs("联袂打造画面为 Kimi Work 法律行业发行版真实界面演示案例为虚构审查意见等由 Kimi 模型在真实任务中生成");
  // 产品名的文字先退，标识随后移到右侧方位
  const leave = prog(f, 0, 20, easeIn);
  const travel = prog(f, 16, 64, easeCine);
  const markX = lerp(LK_X0, KM_X, travel);
  const markY = lerp(LK_Y0, ROW_Y - KM / 2, travel);
  const markS = lerp(LK.M, KM, travel);
  // 落印：印章从 1.08 倍落到 1.0，落定时投影收紧
  const T_STAMP = 62;
  const stamp = prog(f, T_STAMP, 22, Easing.bezier(0.2, 0.8, 0.2, 1));
  const stampShadow = map(f, [T_STAMP, T_STAMP + 22, T_STAMP + 60], [0, 1, 0]);
  const cross = prog(f, 96, 34, easeOut);
  const names = prog(f, 118, 40, easeOut);
  const tag = prog(f, 150, 50, easeOut);
  const sweep = map(f, [200, 420], [-0.25, 1.25], easeInOut);
  const note = prog(f, 226, 50) * (1 - prog(f, 470, 30));
  const toBlack = prog(f, 496, 70, easeInOut);
  const bar = (rot: number, p: number) => (
    <div style={{ position: "absolute", left: XS / 2 - 2.5, top: XS / 2 - 38 * p, width: 5, height: 76 * p, borderRadius: 2.5, background: "#111", transform: `rotate(${rot}deg)`, transformOrigin: `2.5px ${38 * p}px` }} />
  );
  return (
    <AbsoluteFill style={{ overflow: "hidden", background: "#07080a" }}>
      <StudioBackdrop cy={44} floor={0} />
      {/* 背景光缓缓掠过（只在标识后面，不改动标识颜色） */}
      <AbsoluteFill style={{ background: `radial-gradient(30% 55% at ${sweep * 100}% 44%, rgba(255,255,255,0.7) 0%, rgba(255,255,255,0) 70%)`, opacity: 0.6 }} />
      {/* 产品名的字标与副名退去 */}
      {leave < 0.999 && (
        <div style={{ position: "absolute", left: LK_X0 + LK.M + LK.GAP, top: LK_Y0 + 2, opacity: 1 - leave, transform: `translateX(${leave * 24}px)`, filter: `blur(${leave * 6}px)` }}>
          <Wordmark h={LK.WH} color={INK} />
          <div style={{ marginTop: 12, marginLeft: 4, fontFamily: FONT_TITLE, fontSize: 27, fontWeight: 500, letterSpacing: 11.5, color: "#57534d" }}>法律行业发行版</div>
        </div>
      )}
      {/* Kimi 官方 Logomark */}
      <div style={{ position: "absolute", left: markX, top: markY }}>
        <KimiMark size={markS} />
      </div>
      {/* 中软国际：落印 */}
      {stamp > 0.001 && (
        <div
          style={{
            position: "absolute",
            left: SEAL_X,
            top: ROW_Y - SEAL / 2,
            width: SEAL,
            height: SEAL,
            opacity: Math.min(1, stamp * 2.2),
            transform: `scale(${1.08 - 0.08 * stamp})`,
            filter: `drop-shadow(0 ${lerp(14, 3, stamp)}px ${lerp(16, 4, stamp)}px rgba(60,20,20,${0.2 * stampShadow}))`,
          }}
        >
          <Img src={staticFile("logos/csi.png")} style={{ width: SEAL, height: SEAL, display: "block" }} />
        </div>
      )}
      {/* “×”（两笔从中心画出） */}
      <div style={{ position: "absolute", left: 960 - XS / 2, top: ROW_Y - XS / 2, width: XS, height: XS, opacity: Math.min(1, cross * 3) }}>
        {bar(45, cross)}
        {bar(-45, prog(f, 104, 34, easeOut))}
      </div>
      {/* 标识下的名称（小字） */}
      {[
        { x: SEAL_X + SEAL / 2, t: "中软国际", font: FONT_TITLE, ls: 2.4 },
      ].map((n, i) => (
        <div key={i} style={{ position: "absolute", left: n.x - 120, width: 240, top: ROW_Y + KM / 2 + 22, textAlign: "center", fontFamily: n.font, fontSize: 20, fontWeight: 500, letterSpacing: n.ls, color: "#1f1f1f", opacity: names, transform: `translateY(${(1 - names) * 6}px)` }}>{n.t}</div>
      ))}
      {/* Kimi 官方字标（Logotype，原样，未改色） */}
      <div style={{ position: "absolute", left: KM_X + KM / 2 - (375 / 125) * 9, top: ROW_Y + KM / 2 + 27, opacity: names, transform: `translateY(${(1 - names) * 6}px)` }}>
        <Img src={staticFile("logos/kimi-logotype-light.svg")} style={{ height: 18, width: (375 / 125) * 18, display: "block" }} />
      </div>
      {/* 联袂打造（两侧细线） */}
      <div style={{ position: "absolute", left: 0, right: 0, top: ROW_Y + KM / 2 + 96, display: "flex", justifyContent: "center", alignItems: "center", gap: 26, opacity: tag, transform: `translateY(${(1 - tag) * 10}px)` }}>
        <div style={{ width: 120 * tag, height: 1, background: "#cfccc4" }} />
        <div style={{ fontFamily: FONT_TITLE, fontSize: 32, fontWeight: 500, letterSpacing: "0.34em", marginRight: "-0.34em", color: "#1f1f1f" }}>联袂打造</div>
        <div style={{ width: 120 * tag, height: 1, background: "#cfccc4" }} />
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 56, textAlign: "center", fontFamily: FONT_TITLE, fontSize: 16, letterSpacing: 0.8, color: "#7a756e", opacity: note }}>
        画面为 Kimi Work 法律行业发行版真实界面 · 演示案例为虚构 · 审查意见等由 Kimi 模型在真实任务中生成
      </div>
      <Grain opacity={0.02} />
      <AbsoluteFill style={{ background: "#07080a", opacity: toBlack, pointerEvents: "none" }} />
    </AbsoluteFill>
  );
}
export { FONT_SERIF };
