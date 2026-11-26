/**
 * S04 开始面板（1 小节，144 帧，动作段，无字）：面板从首页弹出；勾选要审的文件，点选“付款”“违约责任”，点“下一步：确认”。
 */
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { cam, Cursor, easeOut, Grain, prog, ProductStage, ProductWindow, StudioBackdrop, Vignette } from "../ui/film";
import { byText, css, q } from "../ui/Snap";

import { START } from "../beats";
const { C1, C2, C3 } = START; // 点“付款”“违约责任”“下一步：确认”

export function S04Start() {
  const f = useCurrentFrame();
  const pop = prog(f, 0, 22, easeOut);
  const keys = [cam(0, 860, 300, 1.36, 1, -5, 300, 10), cam(34, 700, 470, 1.08, 0, -3, 60, 0), cam(100, 640, 560, 1.3, 0, -2, 80, 0), cam(144, 720, 560, 1.34, 1, -5, 300, 0)];
  const edit = (root: HTMLElement) => {
    css(q(root, ".modal-mask"), { opacity: pop });
    css(q(root, ".modal"), { transform: `translateY(${(1 - pop) * 14}px) scale(${0.97 + 0.03 * pop})`, opacity: Math.min(1, pop * 1.5) });
    const c1 = byText(root, ".modal button.chip", "付款");
    const c2 = byText(root, ".modal button.chip", "违约责任");
    if (c1) c1.className = f >= C1 ? "chip active" : "chip";
    if (c2) c2.className = f >= C2 ? "chip active" : "chip";
  };
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <StudioBackdrop cx={60} />
      <ProductStage cam={keys}>
        <ProductWindow name="h04-start-chips" edit={edit} />
        <Cursor
          keys={[
            { f: 10, x: 1013, y: 330 },
            { f: C1 - 6, x: 472, y: 558 },
            { f: C2 - 6, x: 630, y: 558 },
            { f: C3 - 8, x: 1043, y: 828 },
          ]}
          clicks={[C1, C2, C3]}
          show={[0, 144]}
        />
      </ProductStage>
      <Vignette strength={0.14} />
      <Grain opacity={0.03} />
    </AbsoluteFill>
  );
}
