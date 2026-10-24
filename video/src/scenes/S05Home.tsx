/**
 * S5 · 一句话，交代任务：首页输入框逐字打出任务，产品认出这是“审合同”并给出建议条，律师点“使用审合同”。
 * 画面为真实界面快照 h04-home-typed（建议条、事项、我方立场均为产品原样），只把打字过程与建议条出现做成动画。
 */
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { HOME_CLICK, HOME_SUGGEST, HOME_TASK, HOME_TYPE_AT, HOME_TYPE_CPS } from "../cues";
import { prog, spr, typed } from "../lib/anim";
import { Cursor, Headline, ProductStage, ProductWindow, Scrim, Spot, StudioBackdrop, TITLEBAR, type CamKey } from "../ui/film";
import { css, q, type SnapEdit } from "../ui/Snap";

const T = TITLEBAR;
const CAM: CamKey[] = [
  { f: 0, fx: 720, fy: 465, s: 0.87, rx: 0, ry: 0, ox: 0, oy: 6 },
  { f: 40, fx: 850, fy: 250 + T, s: 1.22, rx: 3, ry: -7, ox: 330, oy: 10 },
  { f: 130, fx: 850, fy: 268 + T, s: 1.28, rx: 2, ry: -6, ox: 330, oy: 0 },
  { f: 206, fx: 850, fy: 290 + T, s: 1.3, rx: 1, ry: -5, ox: 330, oy: 0 },
  { f: 256, fx: 1061, fy: 321 + T, s: 1.75, rx: 0, ry: -2, ox: 60, oy: 0 },
];

const edit: SnapEdit = (root, f) => {
  const ta = q(root, ".composer textarea") as HTMLTextAreaElement | null;
  if (ta) {
    const [t] = typed(HOME_TASK, f, HOME_TYPE_AT, HOME_TYPE_CPS);
    ta.textContent = t;
    ta.value = t;
  }
  const bar = q(root, ".suggest-bar");
  const p = spr(f, HOME_SUGGEST, 130, 22);
  css(bar, { maxHeight: `${p * 70}px`, opacity: Math.min(1, p * 1.3), overflow: "hidden", transform: `translateY(${(1 - p) * -6}px)`, marginTop: `${p * 6}px`, paddingTop: p < 0.02 ? "0px" : "", paddingBottom: p < 0.02 ? "0px" : "", borderWidth: p < 0.02 ? "0px" : "" });
  const btn = q(root, ".suggest-bar .btn-primary");
  const press = f >= HOME_CLICK - 3 && f <= HOME_CLICK + 5 ? 1 - Math.abs(f - HOME_CLICK) / 5 : 0;
  css(btn, { transform: `scale(${1 - press * 0.06})` });
};

export function S05Home() {
  const f = useCurrentFrame();
  const spot = prog(f, HOME_SUGGEST + 16, 20) * (1 - prog(f, HOME_CLICK + 8, 12));
  return (
    <AbsoluteFill>
      <StudioBackdrop />
      <ProductStage cam={CAM}>
        <ProductWindow
          name="h04-home-typed"
          edit={edit}
          overlay={
            <>
              <Spot rect={{ x: 1019, y: 306, w: 85, h: 29, r: 8 }} p={spot} />
              <Cursor keys={[{ f: 150, x: 1230, y: 600 }, { f: 196, x: 1066, y: 324 }, { f: 256, x: 1068, y: 326 }]} clicks={[HOME_CLICK]} show={[150, 256]} />
            </>
          }
        />
      </ProductStage>
      <Scrim opacity={prog(f, 20, 30) * (1 - prog(f, 214, 20))} to={40} />
      <Headline at={30} out={124} x={150} y={410} size={68} title={<>一句话，<br />交代任务。</>} sub="不用先挑工具，直接说要做什么。" />
      <Headline at={140} out={212} x={150} y={410} size={68} title={<>它听得懂<br />这是哪类工作。</>} sub="认出“审合同”，告诉你会得到什么。" />
    </AbsoluteFill>
  );
}
