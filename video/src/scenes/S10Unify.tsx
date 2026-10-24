/**
 * S10 · 三条业务线，一个工作空间：首页“从业务场景开始”的三个标签——诉讼仲裁、非诉、企业法务——
 * 各自的方法卡依次亮起（真实界面快照 p01-home / p01-home-非诉 / p01-home-企业法务），再汇回同一个首页。
 */
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { UNIFY_LINES, UNIFY_MERGE } from "../cues";
import { easeInOut, lerp, map, prog, reveal, spr } from "../lib/anim";
import { FONT_DISPLAY, FONT_UI, Headline, INK, ProductStage, ProductWindow, StudioBackdrop, WIN_H, type CamKey } from "../ui/film";
import { Snap, css, q, qa, type SnapEdit } from "../ui/Snap";
import type { SnapName } from "../snaps";

/** scroll：首页主区向下滚动的距离（各标签页内容高度不同，取各自能滚到的最大值）；top：滚动后“业务场景”标签栏的位置 */
const LINES: { name: SnapName; label: string; items: string; scroll: number; top: number }[] = [
  { name: "p01-home", label: "诉讼仲裁", items: "整理案卷 · 争点与证据分析 · 金额测算 · 起草文书", scroll: 440, top: 127 },
  { name: "p01-home-非诉", label: "非诉交易", items: "审合同 · 对方回稿比对 · 客户版与对外脱敏", scroll: 365, top: 202 },
  { name: "p01-home-企业法务", label: "企业法务", items: "合同审核 · 从公司范本整理审核标准 · 合规问答", scroll: 295, top: 272 },
];
const PW = 820;
const PH = 520;
/** 用位移模拟主区滚动（单帧渲染时 scrollTop 不可靠） */
const scrolled = (px: number): SnapEdit => (root) => {
  css(q(root, ".main"), { overflow: "hidden" });
  qa(root, ".main > *").forEach((e) => css(e, { transform: `translateY(${-px}px)` }));
};
const EDITS = LINES.map((l) => scrolled(l.scroll));

function LinePanel({ name, top, edit }: { name: SnapName; top: number; edit: SnapEdit }) {
  return (
    <div style={{ position: "relative", width: PW, height: PH, overflow: "hidden", borderRadius: 18, background: "#fff", boxShadow: "0 0 0 1px rgba(14,18,25,0.08), 0 30px 60px -20px rgba(14,18,25,0.25), 0 80px 120px -50px rgba(14,18,25,0.3)" }}>
      <div style={{ position: "absolute", left: -430, top: -top + 14 }}>
        <Snap name={name} edit={edit} />
      </div>
    </div>
  );
}

const CAM: CamKey[] = [
  { f: 0, fx: 720, fy: WIN_H / 2, s: 0.74, rx: 0, ry: 0, ox: 0, oy: -20 },
  { f: 256, fx: 720, fy: WIN_H / 2, s: 0.79, rx: 0, ry: 0, ox: 0, oy: -20 },
];

export function S10Unify() {
  const f = useCurrentFrame();
  const merge = prog(f, UNIFY_MERGE, 34, easeInOut);
  const home = prog(f, UNIFY_MERGE + 14, 30);
  return (
    <AbsoluteFill>
      <StudioBackdrop />
      {/* 汇合后的首页 */}
      <AbsoluteFill style={{ opacity: home, transform: `scale(${lerp(0.92, 1, home)})` }}>
        <ProductStage cam={CAM}>
          <ProductWindow name="p01-home" />
        </ProductStage>
      </AbsoluteFill>
      {/* 三条业务线 */}
      <AbsoluteFill style={{ perspective: 2200, perspectiveOrigin: "50% 50%", opacity: 1 - prog(f, UNIFY_MERGE + 6, 16) }}>
        {LINES.map((l, i) => {
          const p = spr(f, UNIFY_LINES[i], 110, 22);
          const side = i - 1;
          const x = lerp(side * 610, 0, merge);
          const ry = lerp(-side * 16, 0, merge) + (1 - p) * -side * 10;
          const z = lerp(side === 0 ? 40 : -80, -200, merge);
          const s = 0.68 * lerp(1, 0.85, merge);
          const lab = reveal(f, UNIFY_LINES[i] + 6, 22, 16);
          return (
            <div key={l.label} style={{ position: "absolute", left: 960 - PW / 2, top: 690 - PH / 2, width: PW, height: PH, transformStyle: "preserve-3d", transform: `translate3d(${x}px, ${(1 - p) * 60}px, ${z}px) rotateY(${ry}deg) scale(${s})`, opacity: Math.min(1, p * 1.4) }}>
              <div style={{ position: "absolute", left: 0, right: 0, bottom: PH + 40, textAlign: "center", fontFamily: FONT_DISPLAY, ...lab, opacity: lab.opacity * (1 - prog(f, UNIFY_MERGE - 12, 12)) }}>
                <div style={{ fontSize: 84, fontWeight: 600, color: INK, letterSpacing: 4 }}>{l.label}</div>
                <div style={{ fontFamily: FONT_UI, fontSize: 30, color: "#6b6862", marginTop: 14 }}>{l.items}</div>
              </div>
              <LinePanel name={l.name} top={l.top} edit={EDITS[i]} />
            </div>
          );
        })}
      </AbsoluteFill>
      <Headline at={8} out={UNIFY_MERGE - 6} x={960} y={150} align="center" width={1500} size={46} title="按律师的业务线组织。" />
      <AbsoluteFill style={{ background: `linear-gradient(180deg, rgba(246,245,242,${0.0}) 0%, rgba(246,245,242,0) 70%, rgba(246,245,242,${0.95 * home}) 92%)` }} />
      <Headline at={UNIFY_MERGE + 30} out={240} x={960} y={930} align="center" width={1500} size={50} title="一个工作空间。" sub="方法、材料与交付件，都在同一处。" subSize={24} />
      <AbsoluteFill style={{ background: "#0a0b0d", opacity: map(f, [236, 256], [0, 1]) }} />
    </AbsoluteFill>
  );
}
