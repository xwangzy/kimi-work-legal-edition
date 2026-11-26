/**
 * 能力主线（真实任务的真实状态，按时间顺序；全片的“主角”是《股权转让协议》第 7.1 条）：
 *  S06 过程：执行页推进 → 遇到要律师定的事停下来问（拟签还是已签）→ 交出之前独立复核。
 *  S07 风险（英雄镜头）：工作台里合同全幅微距；片头那颗蓝点（AI 的注意力）掠过条文，落在第 7.1 条页边，条款亮起；
 *      镜头拉开，右侧意见卡写明问题、首选修改、可退让方案与建议底线。
 *  S08 引用：引用逐条对照法规原文（来源已核、版本已核；支持与否由律师确认）。
 *  S09 判断（英雄镜头）：律师在第 7.1 条意见卡上点“接受首选” → 镜头穿过界面落到纸面上，第 7.1 条的修订
 *      （删除线 + 插入，逐字取自本次任务“接受后”视图）在纸上写出来。
 */
import { AbsoluteFill, useCurrentFrame } from "remotion";
import type { CSSProperties } from "react";
import { CITE, DECIDE, PROOF, RISK, RUNB } from "../beats";
import { cam, Cursor, easeCine, easeInOut, easeOut, FONT_LATIN, FONT_TITLE, Grain, KimiDot, lerp, LowerThird, map, prog, ProductStage, ProductWindow, Spot, StudioBackdrop, Title, Vignette } from "../ui/film";
import { ClauseRedline } from "../ui/redline";
import { css, qa } from "../ui/Snap";
import { pickX, scrollTo } from "./common";
import type { SnapName } from "../snaps";

type S = SnapName;

/* ───────── S06 过程 ───────── */
export function S06Run() {
  const f = useCurrentFrame();
  const { T1, T2, T_ASK, C_PICK, C_OK, T3, T4, T_REVIEW } = RUNB;
  const { name: snap, prev, mix } = pickX<S>(f, [
    [0, "k01-ask"],
    [T_ASK, "k01-ask"],
    [C_PICK + 4, "k02-ask-picked"],
    [T2, "r024"],
    [T3, "r2003"],
    [T4, "r2010"],
  ], 10);
  const keys = [
    cam(0, 470, 640, 1.26, 1, -5, 330, -20),
    cam(T_ASK + 4, 460, 710, 1.38, 1, -4, 360, -40),
    cam(C_OK + 6, 460, 710, 1.4, 1, -4, 360, -40),
    cam(T2 + 22, 440, 470, 1.18, 1, -6, 360, 0),
    cam(T_REVIEW + 30, 470, 525, 1.34, 1, -5, 400, 0),
    cam(288, 480, 530, 1.38, 1, -5, 400, 0),
  ];
  const spotReview = prog(f, T_REVIEW + 6, 26) * (snap === "r2010" ? 1 : 0);
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <StudioBackdrop cx={60} />
      <ProductStage cam={keys}>
        <ProductWindow name={snap} prev={prev} mix={mix} overlay={<Spot rect={{ x: 104, y: 512, w: 720, h: 36, r: 8 }} p={spotReview} />} />
        <Cursor keys={[{ f: T_ASK, x: 600, y: 760 }, { f: C_PICK - 8, x: 233, y: 690 }, { f: C_OK - 8, x: 136, y: 825 }]} clicks={[C_PICK, C_OK]} show={[T_ASK + 6, C_OK + 16]} />
      </ProductStage>
      <Title eyebrow="02  过程" lines={["要你定的事，", "它会停下来问你。"]} sub="交出之前，另一位 AI 独立复核。" at={12} out={240} x={128} y={380} width={640} size={70} />
      <Vignette strength={0.14} />
      <Grain opacity={0.03} />
    </AbsoluteFill>
  );
}

/* ───────── S07 风险（英雄镜头） ───────── */
const DOC_SCROLL = 320; // 工作台里把合同往上滚，第 7.1 条落在 y≈563
const C71_ROW = { x: 116, y: 552, w: 466, h: 22 };
export function S07Risk() {
  const f = useCurrentFrame();
  const { T_LAND, T_BLOOM, T_PAN, T_WIDE } = RISK;
  // 微距：全幅合同（窗口左缘出画），第 7.1 条在画面中左
  const keys = [
    cam(0, 360, 470, 2.25, 0, 3, -190, 30),
    cam(T_LAND, 330, 545, 2.4, 0, 2, -200, 0),
    cam(T_PAN, 330, 560, 2.48, 0, 2, -200, 0),
    cam(T_WIDE, 1080, 470, 1.24, 1, -6, 340, 0),
    cam(432, 1080, 500, 1.2, 1, -6, 350, 0),
  ];
  // 蓝点：从右上方掠过条文，落在第 7.1 条左侧页边
  const fly = prog(f, 6, T_LAND - 6, easeCine);
  const dotX = lerp(640, 70, fly) + Math.sin(fly * Math.PI) * 30;
  const dotY = lerp(330, 563, fly) - Math.sin(fly * Math.PI) * 40;
  const dotOn = prog(f, 0, 14) * (1 - prog(f, T_PAN + 20, 30));
  const land = prog(f, T_LAND, 20, easeOut);
  const bloom = map(f, [T_BLOOM, T_BLOOM + 30, T_PAN, T_PAN + 40], [0, 1, 1, 0.35]);
  const others = map(f, [0, T_PAN + 40, T_WIDE], [0.4, 0.4, 1]);
  const cards = prog(f, T_PAN - 10, 50, easeInOut);
  const edit = (root: HTMLElement) => {
    scrollTo(root, ".wb-doc", DOC_SCROLL);
    css(root.querySelector<HTMLElement>(".wb-cards"), { opacity: cards });
    for (const m of qa(root, ".wb-mark:not(.mark-active)")) css(m, { opacity: others });
    for (const m of qa(root, ".wb-mark.mark-active")) {
      if (f < T_LAND) m.classList.remove("mark-active");
      css(m, { boxShadow: `0 0 0 ${3 * bloom}px rgba(196,43,43,${0.18 * bloom}), 0 0 ${30 * bloom}px rgba(196,43,43,${0.28 * bloom})` });
    }
  };
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <StudioBackdrop cx={58} />
      <ProductStage cam={keys} drift={0.3}>
        <ProductWindow
          name="w04-acc"
          edit={edit}
          focus={{ x: 829, y: 53, w: 588, h: 828, r: 14 }}
          blur={map(f, [T_PAN + 40, T_WIDE], [0, 2.4])}
          dim={map(f, [T_PAN + 40, T_WIDE], [0, 0.05])}
          overlay={
            <>
              {dotOn > 0.001 && (
                <div style={{ position: "absolute", left: dotX - 6, top: dotY - 6, opacity: dotOn, transform: `scale(${1 + 0.25 * Math.sin(land * Math.PI)})`, zIndex: 30 }}>
                  <KimiDot size={12} glow={1 - 0.4 * land} />
                </div>
              )}
              <Spot rect={{ ...C71_ROW, x: C71_ROW.x - 40, w: C71_ROW.w + 46, y: C71_ROW.y - 4, h: C71_ROW.h + 8 }} p={land * (1 - prog(f, T_PAN, 30))} color="23,131,255" />
            </>
          }
        />
      </ProductStage>
      <Title eyebrow="02  过程" lines={["风险，", "标在条款上。"]} sub="意见卡写明问题、首选修改、可退让方案与建议底线。" at={T_PAN + 56} out={376} x={128} y={380} width={640} size={72} />
      <Vignette strength={0.14} />
      <Grain opacity={0.03} />
    </AbsoluteFill>
  );
}

/* ───────── S08 引用 ───────── */
export function S08Cite() {
  const f = useCurrentFrame();
  // 起幅：法条原文微距（无字）；随后拉开到引用卡全貌，标题入画
  const keys = [cam(0, 1010, 320, 2.2, 1, -4, 40, 0), cam(44, 1040, 330, 2.05, 1, -4, 60, 0), cam(CITE.T_DOWN, 1120, 330, 1.52, 1, -6, 360, 0), cam(216, 1130, 360, 1.58, 1, -5, 350, 0)];
  const spotSrc = prog(f, CITE.T_SPOT, 24);
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <StudioBackdrop cx={58} />
      <ProductStage cam={keys}>
        <ProductWindow name="t-引用" overlay={<><Spot rect={{ x: 836, y: 404, w: 420, h: 30, r: 6 }} p={spotSrc} /><Spot rect={{ x: 836, y: 260, w: 576, h: 140, r: 8 }} p={prog(f, CITE.T_LAW, 24) * (1 - prog(f, CITE.T_SPOT - 6, 14))} color="120,120,120" /></>} />
      </ProductStage>
      <Title eyebrow="02  过程" lines={["引用的法条，", "对照原文核验。"]} sub={<>来源与版本由系统核对；核不了的，明确提示你；<br />是否支持论点，由你确认。</>} at={56} out={176} x={128} y={380} width={680} size={68} />
      <Vignette strength={0.14} />
      <Grain opacity={0.03} />
    </AbsoluteFill>
  );
}

/* ───────── S09 判断（英雄镜头） ───────── */
export function S09Decide() {
  const f = useCurrentFrame();
  const { C1, T_NEXT, T_PAPER, T_STRIKE, T_INS, T_INS_END } = DECIDE;
  const { name: snap, prev, mix } = pickX<S>(f, [
    [0, "w04-acc"],
    [T_NEXT, "w05-acc"],
  ], 8);
  const keys = [
    cam(0, 1020, 600, 1.4, 1, -6, 340, 0),
    cam(C1 - 8, 1000, 640, 1.5, 1, -5, 330, 0),
    cam(T_PAPER + 40, 360, 560, 2.2, 0, 0, -120, 0),
  ];
  const toPaper = prog(f, T_PAPER, 60, easeCine);
  const edit = (root: HTMLElement) => {
    if (root.dataset.snap === "w05-acc") for (const m of qa(root, ".wb-mark.mark-active, .wb-mark.mark-hover")) m.classList.remove("mark-active", "mark-hover");
    if (snap === "w05-acc") {
      const just = prog(f, T_NEXT, 24, easeOut);
      const open = qa(root, ".rc.open")[0];
      if (open && just < 1) css(open, { transform: `translateY(${(1 - just) * 18}px)`, opacity: 0.4 + 0.6 * just });
    }
  };
  const strike = prog(f, T_STRIKE, 40, easeInOut);
  const ins = map(f, [T_INS, T_INS_END], [0, 1], (t) => t);
  const paperIn = prog(f, T_PAPER, 56, easeCine);
  const push = map(f, [T_PAPER + 80, 504], [0, 1], easeInOut);
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <StudioBackdrop cx={lerp(58, 64, toPaper)} cy={lerp(36, 32, toPaper)} />
      <AbsoluteFill style={{ opacity: 1 - map(f, [T_PAPER + 6, T_PAPER + 34], [0, 1]), filter: `blur(${(toPaper * 9).toFixed(2)}px)` }}>
        <ProductStage cam={keys} drift={0.3}>
          <ProductWindow name={snap} prev={prev} mix={mix} edit={edit} />
          <Cursor keys={[{ f: 0, x: 1180, y: 720 }, { f: C1 - 8, x: 889, y: 849 }, { f: C1 + 30, x: 1060, y: 760 }]} clicks={[C1]} show={[6, T_PAPER]} />
        </ProductStage>
      </AbsoluteFill>
      {paperIn > 0.001 && (
        <AbsoluteFill style={{ perspective: 2200, perspectiveOrigin: "60% 45%" }}>
          <div
            style={{
              position: "absolute",
              left: 960 - 560,
              top: 540 - 260,
              width: 1120,
              transformOrigin: "50% 30%",
              transform: `translate3d(${(1 - paperIn) * 160}px, ${(1 - paperIn) * 120 - push * 16}px, 0) rotateX(${(1 - paperIn) * 22 + 3 - push * 2}deg) rotateY(${-5 + push * 2}deg) rotateZ(${(1 - paperIn) * -4 - 0.8}deg) scale(${0.96 + push * 0.05})`,
              opacity: Math.min(1, paperIn * 1.4),
            }}
          >
            <ClauseRedline w={1120} strike={strike} ins={ins} glow={map(f, [T_INS, T_INS + 30, T_INS_END, T_INS_END + 40], [0, 1, 1, 0])} />
          </div>
        </AbsoluteFill>
      )}
      <Title eyebrow="03  判断" lines={["AI 提出意见，", "律师作出判断。"]} sub="接受、修改后接受、不采纳，都由你决定。" at={14} out={92} x={128} y={380} width={680} size={70} />
      <Vignette strength={0.14} />
      <Grain opacity={0.03} />
    </AbsoluteFill>
  );
}
export { easeInOut };

/* ───────── S07b 证据镜头：本次真实任务的结果 ───────── */
export function S07Proof() {
  const f = useCurrentFrame();
  const { L1, L2, L3 } = PROOF;
  const n1 = prog(f, L1, 30, easeOut);
  const n2 = prog(f, L2, 30, easeOut);
  const sub = prog(f, L3, 34, easeOut);
  const out = prog(f, 118, 24, easeInOut);
  const num = (p: number): CSSProperties => ({ opacity: p * (1 - out), transform: `translateY(${(1 - p) * 30 - out * 20}px)`, filter: `blur(${(1 - p) * 8}px)` });
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <StudioBackdrop cx={50} />
      {/* 背景：审查工作台，虚化压淡 */}
      <ProductStage cam={[cam(0, 760, 460, 1.0, 1, -6, 260, 0), cam(144, 760, 460, 1.06, 1, -6, 240, 0)]} drift={0.3}>
        <div style={{ filter: "blur(14px)", opacity: 0.55 }}>
          <ProductWindow name="w04-acc" />
        </div>
      </ProductStage>
      <AbsoluteFill style={{ background: "linear-gradient(90deg, rgba(244,243,240,0.96) 0%, rgba(244,243,240,0.85) 45%, rgba(244,243,240,0.4) 75%, rgba(244,243,240,0.2) 100%)" }} />
      <div style={{ position: "absolute", left: 128, top: 300, fontFamily: FONT_TITLE, color: "#0e1219" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 22, ...num(n1) }}>
          <span style={{ fontFamily: FONT_LATIN, fontSize: 168, fontWeight: 600, letterSpacing: -4, lineHeight: 1, width: 196, textAlign: "right", display: "inline-block" }}>17</span>
          <span style={{ fontSize: 52, fontWeight: 700 }}>项审查意见</span>
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 22, marginTop: 26, ...num(n2) }}>
          <span style={{ fontFamily: FONT_LATIN, fontSize: 168, fontWeight: 600, letterSpacing: -4, lineHeight: 1, width: 196, textAlign: "right", display: "inline-block" }}>8</span>
          <span style={{ fontSize: 52, fontWeight: 700 }}>项重大风险</span>
        </div>
        <div style={{ marginTop: 40, fontSize: 26, color: "#77736c", letterSpacing: 0.4, ...num(sub) }}>本片这份股权转让协议的一次真实审查 · 每一项，由律师逐条处理</div>
      </div>
      <Vignette strength={0.14} />
      <Grain opacity={0.03} />
    </AbsoluteFill>
  );
}
