/**
 * S7 · 每一步都看得见：执行页左栏的步骤随节拍逐条完成，最后右栏出现审查摘要（重大 1 · 一般 2 · 提示 1）。
 * 画面为真实界面快照 r01-run-done（步骤文案与摘要均为产品实际显示），动画只把“已完成”的状态按时间展开。
 */
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { RUN_STEPS, RUN_SUMMARY } from "../cues";
import { prog, spr } from "../lib/anim";
import { Headline, ProductStage, ProductWindow, Scrim, StudioBackdrop, TITLEBAR, type CamKey } from "../ui/film";
import { css, q, qa, type SnapEdit } from "../ui/Snap";

const T = TITLEBAR;
const CAM: CamKey[] = [
  { f: 0, fx: 330, fy: 250 + T, s: 1.85, rx: 1, ry: 7, ox: -330, oy: 20 },
  { f: 118, fx: 340, fy: 300 + T, s: 1.95, rx: 0, ry: 5, ox: -330, oy: 0 },
  { f: 152, fx: 1120, fy: 135 + T, s: 1.95, rx: 0, ry: -4, ox: 0, oy: 40 },
  { f: 192, fx: 1130, fy: 132 + T, s: 2.05, rx: 0, ry: -3, ox: 0, oy: 40 },
];

const edit: SnapEdit = (root, f) => {
  qa(root, ".timeline > .step").forEach((st, i) => {
    const done = RUN_STEPS[i] ?? 0;
    const show = done - 14;
    if (f < show) return css(st, { display: "none" });
    const pin = prog(f, show, 10);
    css(st, { opacity: pin, transform: `translateY(${(1 - pin) * 8}px)` });
    if (f < done) {
      st.classList.remove("step-ok");
      st.classList.add("step-wait");
      css(st.querySelector<HTMLElement>(".step-dot svg"), { opacity: 0 });
    } else {
      const p = spr(f, done, 240, 16);
      css(st.querySelector<HTMLElement>(".step-dot"), { transform: `scale(${1.3 - 0.3 * p})` });
    }
  });
  const later = [q(root, ".step-toggle"), q(root, ".risk-entry"), q(root, ".answer"), q(root, ".next-steps")];
  const pl = prog(f, RUN_SUMMARY, 16);
  later.forEach((e) => css(e, { opacity: pl, transform: `translateY(${(1 - pl) * 10}px)` }));
  const sum = q(root, ".review-summary");
  css(sum, { opacity: prog(f, RUN_SUMMARY - 4, 12) });
  qa(root, ".review-summary .sev-row .pill").forEach((pill, i) => {
    const p = spr(f, RUN_SUMMARY + i * 5, 200, 15);
    css(pill, { display: "inline-block", opacity: Math.min(1, p * 1.5), transform: `scale(${0.6 + 0.4 * p})` });
  });
  qa(root, ".review-top li").forEach((li, i) => {
    const p = prog(f, RUN_SUMMARY + 14 + i * 5, 14);
    css(li, { opacity: p, transform: `translateX(${(1 - p) * 12}px)` });
  });
};

export function S07Run() {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill>
      <StudioBackdrop />
      <ProductStage cam={CAM}>
        <ProductWindow name="r01-run-done" edit={edit} />
      </ProductStage>
      <Scrim side="right" opacity={prog(f, 4, 20) * (1 - prog(f, 120, 20))} to={42} />
      <Headline at={14} out={122} x={1250} y={420} size={64} width={600} title={<>每一步，<br />都看得见。</>} sub="读了什么、按什么方法、找出了什么，一目了然。" />
    </AbsoluteFill>
  );
}
