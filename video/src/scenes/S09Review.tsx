/**
 * S9 · AI 提出意见，律师作出判断：审查工作台左侧合同原文标出四处风险，右侧意见卡写明依据、首选改法与可退让的底线；
 * 律师“接受首选”后合同里出现修订痕迹，对另一条“不采纳”，最后一键生成对外版 Word 修订稿（原件不改动）。
 * 画面为真实界面快照 w01 → w03 → w06 → w07（每一步都是产品里实际点出来的状态）。
 */
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { RV_ACCEPT, RV_REDLINE, RV_REJECT } from "../cues";
import { map, prog, spr } from "../lib/anim";
import { BottomScrim, Cursor, Headline, ProductStage, ProductWindow, Scrim, Spot, StudioBackdrop, TITLEBAR, type CamKey } from "../ui/film";
import { byText, css, q, qa, type SnapEdit } from "../ui/Snap";
import type { SnapName } from "../snaps";

const T = TITLEBAR;
const CAM: CamKey[] = [
  { f: 0, fx: 720, fy: 470, s: 0.98, rx: 3, ry: 5, ox: 0, oy: 20 },
  { f: 36, fx: 720, fy: 470, s: 1.0, rx: 2, ry: 4, ox: 0, oy: 20 },
  { f: 60, fx: 1130, fy: 420 + T, s: 1.42, rx: 0, ry: -4, ox: 250, oy: 0 },
  { f: 72, fx: 1130, fy: 420 + T, s: 1.42, rx: 0, ry: -4, ox: 250, oy: 0 },
  { f: 108, fx: 440, fy: 471 + T, s: 1.75, rx: 0, ry: 3, ox: -40, oy: 0 },
  { f: 132, fx: 450, fy: 471 + T, s: 1.8, rx: 0, ry: 3, ox: -40, oy: 0 },
  { f: 152, fx: 1130, fy: 500 + T, s: 1.4, rx: 0, ry: -4, ox: 250, oy: 0 },
  { f: 200, fx: 1130, fy: 470 + T, s: 1.36, rx: 0, ry: -4, ox: 250, oy: 0 },
  { f: 236, fx: 1010, fy: 90 + T, s: 1.45, rx: 0, ry: -2, ox: -150, oy: 80 },
  { f: 266, fx: 740, fy: 215 + T, s: 1.3, rx: 2, ry: 0, ox: 0, oy: -120 },
  { f: 320, fx: 730, fy: 225 + T, s: 1.24, rx: 3, ry: 0, ox: 0, oy: -120 },
];

const press = (f: number, at: number) => (f >= at - 3 && f <= at + 5 ? 1 - Math.abs(f - at) / 5 : 0);

const edit: SnapEdit = (root, f) => {
  // 开场：四处标注依次亮起
  qa(root, ".wb-doc mark.wb-mark").forEach((m, i) => {
    const p = prog(f, 6 + i * 6, 10);
    css(m, { opacity: 0.25 + 0.75 * p });
  });
  css(byText(root, ".rc.open button", "接受首选"), { transform: `scale(${1 - press(f, RV_ACCEPT) * 0.06})` });
  css(byText(root, ".rc.open button", "不采纳"), { transform: `scale(${1 - press(f, RV_REJECT) * 0.06})` });
  css(byText(root, ".wb-head-actions button", "生成修订稿"), { transform: `scale(${1 - press(f, RV_REDLINE) * 0.05})` });
  // 接受后：删去线划过、新文字从左到右写入
  const del = q(root, ".wb-del");
  const ins = q(root, ".wb-ins");
  if (del && ins && f < RV_REJECT) {
    const a = prog(f, RV_ACCEPT + 6, 14);
    const b = prog(f, RV_ACCEPT + 16, 22);
    css(del, { textDecorationColor: `rgba(180,35,24,${a})`, opacity: 1 - 0.35 * a });
    css(ins, { display: "inline-block", clipPath: `inset(-4px ${(1 - b) * 100}% -4px 0)` });
  }
  // 修订稿横幅
  const ban = q(root, ".banner-green");
  if (ban) {
    const p = spr(f, RV_REDLINE + 6, 150, 22);
    css(ban, { opacity: Math.min(1, p * 1.4), transform: `translateY(${(1 - p) * -14}px)` });
  }
};

export function S09Review() {
  const f = useCurrentFrame();
  const name: SnapName = f < RV_ACCEPT + 2 ? "w01-review" : f < RV_REJECT + 2 ? "w03-acc2" : f < RV_REDLINE + 4 ? "w06-after" : "w07-redline";
  // 浅景深：说意见卡时虚化左侧合同，说修订痕迹时不虚化
  const dof = Math.max(map(f, [40, 60, 76, 92], [0, 1, 1, 0]), map(f, [140, 156, 214, 230], [0, 1, 1, 0]));
  return (
    <AbsoluteFill>
      <StudioBackdrop />
      <ProductStage cam={CAM}>
        <ProductWindow
          name={name}
          edit={edit}
          focus={{ x: 826, y: 180, w: 608, h: 520, r: 10 }}
          blur={dof * 6}
          dim={dof * 0.04}
          overlay={
            <>
              <Spot rect={{ x: 160, y: 456, w: 640, h: 30, r: 6 }} p={prog(f, 96, 12) * (1 - prog(f, 140, 10))} />
              <Cursor
                keys={[
                  { f: 34, x: 1220, y: 780 },
                  { f: 58, x: 898, y: 553 },
                  { f: 120, x: 905, y: 575 },
                  { f: 150, x: 1066, y: 631 },
                  { f: 226, x: 1062, y: 60 },
                  { f: 236, x: 1064, y: 37 },
                  { f: 320, x: 1080, y: 60 },
                ]}
                clicks={[RV_ACCEPT, RV_REJECT, RV_REDLINE]}
                show={[34, 300]}
              />
            </>
          }
        />
      </ProductStage>
      <Scrim opacity={map(f, [140, 156, 214, 230], [0, 0.92, 0.92, 0])} to={38} />
      <BottomScrim opacity={prog(f, 14, 16) * (1 - prog(f, 80, 12))} from={56} />
      <Headline at={20} out={78} x={960} y={860} align="center" width={1500} size={52} title="AI 提出意见，律师作出判断。" sub="每条意见写明依据、首选改法与可退让的底线。" />
      <Headline at={146} out={224} x={140} y={400} size={62} width={640} title={<>接受、修改、不采纳，<br />都由你决定。</>} sub="采纳的意见直接写成修订，原件始终不改动。" />
      <BottomScrim opacity={prog(f, 252, 16)} from={52} />
      <Headline at={258} x={960} y={860} align="center" width={1400} size={52} title="修订稿，一键生成。" sub="带修订痕迹的 Word，对外版只留修订、不带内部批注。" />
    </AbsoluteFill>
  );
}
