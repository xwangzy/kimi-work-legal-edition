/**
 * 第二幕尾 + 第三幕登场（13.3 秒）
 * G 三问（0–560）：同一页法律意见书上，通用 AI 流畅地写出一段“根据相关法律规定……”的文字；“根据相关法律规定”被轻轻划出；
 *   纸面暗下，“AI 已经会写。可法律工作，还要回答——”，三个问题依次浮现：依据在哪里？谁来负责？案卷去了哪里？
 * H 登场（560–800）：最后一个“？”的那一点变成 Kimi 蓝，其余文字退入黑暗；蓝点移到标识里的位置，
 *   暖白从蓝点柔和地铺开（曝光渐升，不是硬边圆形遮罩）；标识在蓝点周围成形。
 */
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { COPY } from "../copy";
import { TURN as T } from "../beats";
import { easeCine, easeIn, easeInOut, easeOut, Grain, KimiDot, lerp, map, prog, StudioBackdrop, Vignette } from "../ui/film";
import { FONT_SERIF, FONT_TITLE, useGlyphs } from "../fonts";
import { OpinionPage } from "../ui/desk";
import { pageStyle, PAGE_POS } from "./S2Night";
import { LK_DOT, Lockup } from "../ui/lockup";
import { Clock, Manifesto } from "../ui/type";

const AI_TEXT = "经审查，第七条约定的违约金标准可能过高。根据相关法律规定，约定的违约金过分高于造成的损失的，当事人可以请求予以适当减少。建议双方协商调整违约金比例，并完善付款条件等相关约定，以降低交易风险。";
const VAGUE = "根据相关法律规定";
const QX = 560; // 问题列中线
const QY = [446, 564, 682];
const QS = 74;
/** “？”（思源宋体）里那一点相对字框左上角的位置（em），按渲染校准。 */
const QDOT = { x: 0.16, y: 1.02 };

export function S3Turn() {
  const f = useCurrentFrame();
  useGlyphs(AI_TEXT + COPY.q1 + COPY.q2 + COPY.q3);
  // 文字流
  const n = Math.max(0, Math.min(AI_TEXT.length, Math.floor(((f - T.STREAM) / 60) * T.CPS)));
  const shown = AI_TEXT.slice(0, n);
  const vagueAt = AI_TEXT.indexOf(VAGUE);
  const underline = prog(f, T.UNDERLINE, 30, easeInOut);
  const pageDim = map(f, [T.Q1 - 40, T.Q1 + 20], [0, 1], easeInOut);
  // 推近纸面看清文字流，提问前退回
  const zoom = map(f, [0, 50, T.LEAD - 10, T.Q1 - 10], [0, 1, 1, 0], easeInOut);
  const pageOut = prog(f, T.FADE, 50, easeInOut);
  const qOut = prog(f, T.FADE, 40, easeIn);
  // Q3 的“？”：点变蓝，其余退去
  // 先让“？”的那一点在原位变蓝（字形还在），再让字形与其余文字退去：观众看得出蓝点是从问号里来的
  const q3Rest = 1 - prog(f, T.DOT_BLUE + 26, 40, easeInOut);
  const blue = prog(f, T.DOT_BLUE, 18, easeOut);
  const glyphOut = prog(f, T.DOT_BLUE + 30, 24, easeInOut);
  // 问题列：三个问题左对齐在 QX 附近（每行居中于 QX）
  const q3W = Array.from(COPY.q3).length * QS;
  const q3X0 = QX - q3W / 2;
  const dot0 = { x: q3X0 + (Array.from(COPY.q3).length - 1) * QS + QDOT.x * QS, y: QY[2] - QS * 0.62 + QDOT.y * QS };
  const travel = prog(f, T.DOT_MOVE, T.BLOOM - T.DOT_MOVE + 20, easeCine);
  const dx = lerp(dot0.x, LK_DOT.x, travel);
  const dy = lerp(dot0.y, LK_DOT.y, travel) - Math.sin(travel * Math.PI) * 50;
  const dsz = lerp(QS * 0.15, LK_DOT.size, travel);
  // 暖白铺开：以蓝点为中心的柔边光，半径增长；边缘过渡占半径的一半（不是硬边圆）
  const bloom = prog(f, T.BLOOM, 110, easeInOut);
  const R = lerp(0, 2600, bloom);
  const mark = prog(f, T.MARK, 46, easeOut);
  const word = prog(f, T.MARK + 18, 52, easeOut);
  const tag = prog(f, T.MARK + 40, 30, easeOut);
  const sub = prog(f, T.MARK + 56, 40, easeOut);
  return (
    <AbsoluteFill style={{ background: "#050505", overflow: "hidden" }}>
      {/* 台灯与法律意见书（接第二幕） */}
      <AbsoluteFill style={{ opacity: 1 - pageOut }}>
        <AbsoluteFill style={{ background: `radial-gradient(900px 700px at ${PAGE_POS.x}px ${PAGE_POS.y + 40}px, rgba(255,208,150,0.2) 0%, rgba(255,196,140,0.07) 45%, rgba(0,0,0,0) 75%)` }} />
        <OpinionPage caret={false} style={{ ...pageStyle(), transform: `translate(${-zoom * 180}px, ${zoom * 330}px) rotate(${-1.6 * (1 - zoom)}deg) scale(${0.74 + 0.62 * zoom})`, filter: `brightness(${1 - 0.55 * pageDim})` }}>
          <div style={{ position: "absolute", left: 92, right: 92, top: 278, fontFamily: FONT_TITLE, fontSize: 21, lineHeight: 2, color: "#3a362f", textAlign: "justify" }}>
            {n > vagueAt ? shown.slice(0, vagueAt) : shown}
            {n > vagueAt && (
              <span style={{ position: "relative" }}>
                {shown.slice(vagueAt, Math.min(n, vagueAt + VAGUE.length))}
                <span style={{ position: "absolute", left: 0, bottom: -3, height: 2, width: `${underline * 100}%`, background: "#b0402f", borderRadius: 1 }} />
              </span>
            )}
            {n > vagueAt + VAGUE.length && shown.slice(vagueAt + VAGUE.length)}
            {n < AI_TEXT.length && f >= T.STREAM && <span style={{ display: "inline-block", width: 2, height: "1.05em", background: "#3a362f", verticalAlign: "-0.15em", marginLeft: 1 }} />}
          </div>
        </OpinionPage>
      </AbsoluteFill>
      {/* 引子与三问 */}
      <Manifesto lines={[COPY.b4]} at={T.LEAD} out={T.FADE - 20} x={QX} y={318} size={34} weight={400} color="rgba(239,234,225,0.62)" cps={20} />
      {[COPY.q1, COPY.q2].map((q, i) => (
        <Manifesto key={i} lines={[q]} at={[T.Q1, T.Q2][i]} out={T.DOT_BLUE + 24} x={QX} y={QY[i]} size={QS} cps={12} tracking={0.04} />
      ))}
      {/* 第三问：逐字显影；“？”单独画，便于让它的点变蓝 */}
      {f >= T.Q3 - 10 && (
        <div style={{ position: "absolute", left: q3X0, top: QY[2] - QS * 0.62, fontFamily: FONT_SERIF, fontSize: QS, fontWeight: 600, color: "#efeae1", whiteSpace: "nowrap", lineHeight: 1.24 }}>
          {Array.from(COPY.q3).map((ch, i, a) => {
            const p = prog(f, T.Q3 + i * 5, 34, easeOut);
            const last = i === a.length - 1;
            return (
              <span key={i} style={{ display: "inline-block", width: QS * 1.0, opacity: p * (last ? 1 - glyphOut : q3Rest), filter: p < 0.98 ? `blur(${(1 - p) * 7}px)` : undefined, transform: `translateY(${(1 - p) * 0.12}em)` }}>
                {ch}
              </span>
            );
          })}
        </div>
      )}
      {/* 暖白：从蓝点铺开 */}
      {/* 曝光渐升：以蓝点为中心、无硬边的柔光（不是圆形遮罩），同时整幅画面一起抬亮 */}
      {bloom > 0.001 && <AbsoluteFill style={{ background: `radial-gradient(circle ${Math.max(1, R)}px at ${LK_DOT.x}px ${LK_DOT.y}px, rgba(255,252,244,1) 0%, rgba(255,246,228,${Math.min(1, 0.4 + bloom * 1.8)}) 22%, rgba(255,236,206,${0.45 * Math.min(1, bloom * 2)}) 48%, rgba(255,230,196,0) 100%)`, mixBlendMode: "screen" }} />}
      {bloom > 0.001 && <AbsoluteFill style={{ background: "#f4f2ee", opacity: Math.pow(bloom, 1.6) }} />}
      {bloom > 0.6 && (
        <AbsoluteFill style={{ opacity: prog(f, T.BLOOM + 60, 60, easeInOut) }}>
          <StudioBackdrop cy={44} floor={0} />
        </AbsoluteFill>
      )}
      {mark > 0.001 && <Lockup mark={mark} word={word} tag={tag} sub={sub} showDot={false} />}
      {/* 蓝点（问号的点 → 标识的点） */}
      {f >= T.DOT_BLUE - 2 && (
        <div style={{ position: "absolute", left: dx - dsz / 2, top: dy - dsz / 2, opacity: Math.min(1, blue * 1.4) }}>
          <KimiDot size={dsz} glow={(1 - bloom) * (0.6 + 0.4 * Math.sin(f / 9))} />
        </div>
      )}
      <Clock times={[{ f: 0, t: "02:08" }, { f: T.STREAM + 30, t: "02:09" }]} at={-40} out={T.FADE} />
      <Vignette strength={bloom > 0.5 ? 0.1 : 0.4} dark={bloom < 0.5} />
      <Grain opacity={0.04} />
    </AbsoluteFill>
  );
}
