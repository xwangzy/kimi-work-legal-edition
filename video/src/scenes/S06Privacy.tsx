/**
 * S6 · 开始审查前：在“审合同”面板点选重点，展开“看看 AI 会看到什么”——自然人姓名、证件号、电话逐个换成代号，公司名称保留原文。
 * 画面为真实界面快照 h06-start-focus / c02-start-preview；代号与替换位置均为产品实际输出，动画只演示“替换前 → 替换后”。
 */
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { PRIV_CHIPS, PRIV_PREVIEW, PRIV_REDACT, PRIV_START } from "../cues";
import { easeInOut, map, prog, spr } from "../lib/anim";
import { BottomScrim, Cursor, Headline, ProductStage, ProductWindow, Scrim, Spot, StudioBackdrop, TITLEBAR, type CamKey } from "../ui/film";
import { byText, css, q, qa, type SnapEdit } from "../ui/Snap";

const T = TITLEBAR;
const CAM: CamKey[] = [
  { f: 0, fx: 720, fy: 450 + T, s: 1.0, rx: 0, ry: -5, ox: 300, oy: 0 },
  { f: 44, fx: 640, fy: 390 + T, s: 1.2, rx: 0, ry: -4, ox: 300, oy: 0 },
  { f: 92, fx: 660, fy: 610 + T, s: 1.12, rx: 0, ry: -3, ox: 300, oy: -40 },
  { f: 132, fx: 725, fy: 388 + T, s: 1.95, rx: 0, ry: 0, ox: 0, oy: -70 },
  { f: 208, fx: 735, fy: 388 + T, s: 2.05, rx: 0, ry: 0, ox: 0, oy: -70 },
  { f: 244, fx: 880, fy: 670 + T, s: 1.2, rx: 0, ry: -2, ox: 120, oy: 0 },
  { f: 256, fx: 890, fy: 680 + T, s: 1.22, rx: 0, ry: -2, ox: 120, oy: 0 },
];

/** 代号 ← 原文（与快照里 4 个代号一一对应，原文取自演示合同） */
const ORIGINAL = ["张伟", "110101198203154517", "李娜", "13910246688"];

const press = (f: number, at: number) => (f >= at - 3 && f <= at + 5 ? 1 - Math.abs(f - at) / 5 : 0);

const edit: SnapEdit = (root, f) => {
  // 面板弹出
  const o = spr(f, 0, 160, 24);
  css(q(root, ".modal-mask"), { opacity: Math.min(1, o * 1.4) });
  css(q(root, ".modal"), { transform: `translateY(${(1 - o) * 24}px) scale(${0.97 + 0.03 * o})` });
  // 重点关注：点击前未选中
  ["付款", "违约责任"].forEach((t, i) => {
    const b = byText(root, ".modal button.chip", t);
    if (b && f < PRIV_CHIPS[i]) b.classList.remove("active");
    css(b, { transform: `scale(${1 - press(f, PRIV_CHIPS[i]) * 0.08})` });
  });
  css(byText(root, ".modal button.btn-link", "看看 AI 会看到什么"), { transform: `scale(${1 - press(f, PRIV_PREVIEW) * 0.05})` });
  css(byText(root, ".modal button.btn-primary", "开始审查"), { transform: `scale(${1 - press(f, PRIV_START) * 0.06})` });
  // 展开后把面板滚到预览处：用位移模拟滚动（单帧渲染时 scrollTop 不可靠），吸底的按钮栏反向抵消
  const sc = f >= PRIV_PREVIEW ? map(f, [PRIV_PREVIEW + 4, PRIV_PREVIEW + 32], [0, 511], easeInOut) : 0;
  css(q(root, ".modal"), { overflow: "hidden" });
  css(q(root, ".modal-head"), { transform: `translateY(${-sc}px)` });
  css(q(root, ".modal-body"), { transform: `translateY(${-sc}px)` });
  css(q(root, ".modal-actions-sticky"), { transform: `translateY(${sc}px)` });
  // 代号：替换前显示原文，识别时轻微标黄，替换瞬间弹出代号
  qa(root, ".token-chip").forEach((chip, i) => {
    const at = PRIV_REDACT[i] ?? 9999;
    if (f < at) {
      const hl = prog(f, at - 12, 10);
      chip.textContent = ORIGINAL[i] ?? chip.textContent;
      css(chip, { background: `rgba(255,196,0,${0.32 * hl})`, border: "0", boxShadow: "none", padding: "0 1px", borderRadius: "3px", color: "inherit", font: "inherit" });
    } else {
      const p = spr(f, at, 220, 16);
      css(chip, { display: "inline-block", transform: `scale(${1.25 - 0.25 * p})`, opacity: Math.min(1, p * 1.6) });
    }
  });
};

export function S06Privacy() {
  const f = useCurrentFrame();
  const name = f < PRIV_PREVIEW ? "h06-start-focus" : "c02-start-preview";
  const chipSpot = prog(f, 30, 12) * (1 - prog(f, 80, 12));
  return (
    <AbsoluteFill>
      <StudioBackdrop />
      <ProductStage cam={CAM}>
        <ProductWindow
          name={name}
          edit={edit}
          overlay={
            <>
              <Spot rect={{ x: 491, y: 370, w: 240, h: 41, r: 20 }} p={chipSpot} />
              <Cursor
                keys={[
                  { f: 24, x: 620, y: 560 },
                  { f: 44, x: 523, y: 392 },
                  { f: 58, x: 685, y: 392 },
                  { f: 86, x: 452, y: 730 },
                  { f: 110, x: 520, y: 810 },
                  { f: 226, x: 940, y: 870 },
                  { f: 238, x: 1036, y: 816 },
                ]}
                clicks={[...PRIV_CHIPS, PRIV_PREVIEW, PRIV_START]}
                show={[24, 256]}
              />
            </>
          }
        />
      </ProductStage>
      <Scrim opacity={prog(f, 4, 24) * (1 - prog(f, 100, 20)) + prog(f, 226, 20)} to={36} />
      <Headline at={10} out={92} x={150} y={420} size={64} title={<>交代清楚，<br />再开始。</>} sub="选好重点，先看清会得到什么。" />
      <BottomScrim opacity={prog(f, 118, 20) * (1 - prog(f, 222, 16))} from={56} />
      <Headline at={124} out={214} x={960} y={850} align="center" width={1500} size={50} title="发出之前，当事人信息先换成代号。" sub="认出的姓名、证件号、电话不发出 · 公司名称保留原文 · 每一次外发都有记录" />
    </AbsoluteFill>
  );
}
