/**
 * S03 首页（3.5 小节，504 帧）：
 *  - 匹配剪辑：S02 的字标与首页中央字标重合，快照在白场上显影；
 *  - 界面空间展开：镜头后拉并偏转，首页按层（侧栏、字标、输入框、方法列表、近期期限）分开在不同深度，随后合拢成完整窗口；
 *  - 一句话交代任务：推到输入框，逐字打出任务；产品认出「审合同」，光标点“使用审合同”。
 */
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { AppWindow, cam, Cursor, easeInOut, easeOut, Grain, lerp, map, prog, ProductStage, ProductWindow, StudioBackdrop, Title, typed, Vignette } from "../ui/film";
import { Snap } from "../ui/Snap";
import { hide, only, pick, typeInto } from "./common";

export const HOME_WORD = { x: 680, y: 153, w: 236, h: 52 };
export const HOME_CAM0 = { fx: HOME_WORD.x + HOME_WORD.w / 2, fy: HOME_WORD.y + HOME_WORD.h / 2, s: 2.1 };
import { HOME, TASK } from "../beats";
export { TASK };

const LAYERS: { sel: string[]; z: number }[] = [
  { sel: [".sidebar"], z: 70 },
  { sel: [".today"], z: 60 },
  { sel: [".home-scenes"], z: 130 },
  { sel: [".composer-shell"], z: 210 },
  { sel: [".home-wordmark"], z: 300 },
];
const LAYER_SELS = LAYERS.flatMap((l) => l.sel);

const { T_TYPE, T_HINT, T_CLICK } = HOME;

export function S03Home() {
  const f = useCurrentFrame();
  // 界面围绕静止的字标生长：字标层从第 0 帧就在（与 S02 末帧重合），其余各层依次显影并从各自深度合拢
  const E = map(f, [0, 30, 128], [1, 1, 0], easeInOut); // 分层深度：开始分开，随后合拢
  const grow = (i: number) => prog(f, 4 + i * 9, 34, easeOut);
  const keys = [
    cam(0, HOME_CAM0.fx, HOME_CAM0.fy, HOME_CAM0.s, 0, 0),
    cam(64, 760, 300, 1.15, 4, -6, 60, 20),
    cam(140, 720, 450, 0.9, 0, -2, 0, 0),
    cam(176, 760, 430, 0.88, 1, -7, 330, 0),
    cam(236, 830, 300, 1.3, 1, -6, 310, 10),
    cam(T_HINT, 830, 300, 1.32, 1, -6, 310, 10),
    cam(432, 860, 300, 1.36, 1, -5, 300, 10),
  ];
  const layered = f < 132;
  const [txt] = typed(TASK, f, T_TYPE, HOME.CPS);
  const snap = f < T_HINT ? "h01-home" : "h02-typed";
  const hint = prog(f, T_HINT, 14);
  const sheen = map(f, [126, 200], [0, 1], easeInOut);
  const editTyping = (root: HTMLElement, fr: number) => {
    if (snap === "h01-home") typeInto(root, "textarea", f >= T_TYPE - 20 ? txt : "", fr, f >= T_TYPE - 30);
  };
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <StudioBackdrop cx={58} />
      <ProductStage cam={keys} drift={layered ? 0 : 0.45}>
        {layered ? (
          <>
            <div style={{ opacity: grow(0) }}>
              <AppWindow shadow={grow(0) * (1 - E * 0.4)}>
                <Snap name="h01-home" edit={(r) => hide(r, LAYER_SELS)} />
              </AppWindow>
            </div>
            {LAYERS.map((l, i) => {
              const isWord = l.sel[0] === ".home-wordmark";
              const o = isWord ? 1 : grow(i + 1);
              return (
                <div key={i} style={{ position: "absolute", left: 0, top: 0, width: 1440, height: 900, opacity: o, transform: `translateZ(${(isWord ? 0 : l.z) * E}px) translateY(${(1 - o) * 14}px)`, filter: E > 0.02 && !isWord ? `drop-shadow(0 ${20 * E}px ${26 * E}px rgba(14,18,25,${0.14 * E}))` : undefined }}>
                  <Snap name="h01-home" edit={(r) => only(r, l.sel)} style={{ background: "transparent" }} />
                </div>
              );
            })}
          </>
        ) : (
          <ProductWindow name={snap} prev={f >= T_HINT ? "h01-home" : null} mix={hint} edit={editTyping} sheen={sheen} />
        )}
        <Cursor keys={[{ f: T_HINT - 10, x: 1150, y: 520 }, { f: T_CLICK - 6, x: 1013, y: 322 }]} clicks={[T_CLICK]} show={[T_HINT - 4, 432]} />
      </ProductStage>
      <Title eyebrow="01  交代" lines={["一句话，", "交代任务。"]} sub="它听得懂，这是哪一类法律工作。" at={150} out={372} x={128} y={380} width={620} size={72} />
      <Vignette strength={0.14} />
      <Grain opacity={0.03} />
    </AbsoluteFill>
  );
}
export { lerp, easeOut, pick };
