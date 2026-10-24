/**
 * S8 · 引用核验：执行页“引用”标签——成果里写的每一条依据都和法规库原文并排对照，来源、版本逐层标明；
 * 离线核不了的案号标为“没法核对”，签发前须逐个核对（产品在签发时校验，未核对的不让签发）。
 * 画面为真实界面快照 r05-cite（三条依据与核对状态均为产品实际输出）。
 */
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { CITE_FLAG, CITE_IN } from "../cues";
import { map, prog, spr } from "../lib/anim";
import { Headline, ProductStage, ProductWindow, Scrim, Spot, StudioBackdrop, TITLEBAR, type CamKey } from "../ui/film";
import { css, q, qa, type SnapEdit } from "../ui/Snap";

const T = TITLEBAR;
const CAM: CamKey[] = [
  { f: 0, fx: 1130, fy: 300 + T, s: 1.32, rx: 0, ry: -6, ox: 300, oy: 0 },
  { f: 70, fx: 1130, fy: 500 + T, s: 1.62, rx: 0, ry: -4, ox: 260, oy: 0 },
  { f: 112, fx: 1130, fy: 520 + T, s: 1.66, rx: 0, ry: -4, ox: 260, oy: 0 },
  { f: 150, fx: 1130, fy: 768 + T, s: 1.72, rx: 0, ry: -3, ox: 260, oy: -20 },
  { f: 192, fx: 1130, fy: 772 + T, s: 1.76, rx: 0, ry: -3, ox: 260, oy: -20 },
];

const edit: SnapEdit = (root, f) => {
  css(q(root, ".claims-summary"), { opacity: prog(f, CITE_IN[0] - 6, 12) });
  qa(root, ".claims > .claim").forEach((c, i) => {
    const p = spr(f, CITE_IN[i] ?? 0, 150, 22);
    css(c, { opacity: Math.min(1, p * 1.4), transform: `translateY(${(1 - p) * 22}px)` });
  });
  const flag = q(root, ".claims > .claim.claim-gray");
  const k = prog(f, CITE_FLAG, 10) * (1 - prog(f, CITE_FLAG + 40, 24) * 0.5);
  css(flag, { boxShadow: `0 0 0 ${2 * k}px rgba(180,35,24,${0.55 * k})` });
};

export function S08Cite() {
  const f = useCurrentFrame();
  const blur = map(f, [0, 20], [3, 7]);
  return (
    <AbsoluteFill>
      <StudioBackdrop />
      <ProductStage cam={CAM}>
        <ProductWindow
          name="r05-cite"
          edit={edit}
          focus={{ x: 820, y: 0, w: 620, h: 900, r: 0 }}
          blur={blur}
          dim={0.04}
          overlay={<Spot rect={{ x: 849, y: 592, w: 420, h: 19, r: 6 }} p={prog(f, 84, 12) * (1 - prog(f, 132, 12))} />}
        />
      </ProductStage>
      <Scrim opacity={0.9} to={40} />
      <Headline at={12} out={112} x={140} y={400} size={62} width={540} title={<>每一条引用，<br />都对照法规原文。</>} sub="来源、版本逐层核对；是否支持，由律师确认。" />
      <Headline at={122} out={184} x={140} y={400} size={62} width={540} title={<>核对不了的，<br />签发前必须确认。</>} sub="离线核不了的案号单独标出，逐个核对后才能签发。" />
    </AbsoluteFill>
  );
}
