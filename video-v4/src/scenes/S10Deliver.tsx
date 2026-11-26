/**
 * S10 交付（2.5 小节）：生成修订稿后的绿色横幅（13 处修改以 Word 修订写入，原件未改动；另有清洁稿；对外版不含内部批注）→
 *   成果页里修订稿的白纸预览 → 这页纸从屏幕里“抬起来”，离开窗口，悬浮在摄影棚的光里（纸 → 界面 → 纸）。
 * S11 签发（2 小节）：草稿 → 待复核 → 已签发；系统已核对（文件未被改动、客户授权出处）；律师勾选“我已实质复核全部内容”，点“确认签发”。
 */
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { DELIVER, SIGN } from "../beats";
import { cam, Cursor, easeCine, easeInOut, easeOut, Grain, lerp, map, prog, ProductStage, ProductWindow, Spot, StudioBackdrop, Title, Vignette } from "../ui/film";
import { SnapCrop } from "../ui/Snap";
import { pickX, scrollTo } from "./common";
import type { SnapName } from "../snaps";

// 复核签发页左侧修订稿预览里的那页白纸（快照坐标）
const PAGE = { x: 334, y: 262, w: 592, h: 610 };

/** S10 交付：签发后的修订稿从屏幕里“抬起来”，离开窗口，悬浮在摄影棚光里（纸 → 界面 → 纸）。 */
export function S10Deliver() {
  const f = useCurrentFrame();
  const { T_LIFT } = DELIVER;
  const S0 = 1.5;
  const keys = [
    cam(0, 470, 300, 1.42, 1, -6, 380, 40),
    cam(T_LIFT, PAGE.x + PAGE.w / 2, PAGE.y + PAGE.h / 2, S0, 0, 0, 0, 0),
    cam(360, PAGE.x + PAGE.w / 2, PAGE.y + PAGE.h / 2, S0 * 0.8, 0, 0, 0, 30),
  ];
  const lift = prog(f, T_LIFT, 150, easeCine);
  const winGone = prog(f, T_LIFT, 70, easeInOut);
  const pw = PAGE.w * S0;
  const ph = PAGE.h * S0;
  const rot = { x: lerp(0, 22, lift), y: lerp(0, -16, lift), z: lerp(0, -4, lift) };
  const tz = lerp(0, 120, Math.sin(Math.min(1, lift) * Math.PI * 0.5));
  const tx = lerp(0, 360, lift);
  const ty = lerp(0, 10, lift);
  const sc = lerp(1, 0.66, lift);
  const shadow = lift;
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <StudioBackdrop cx={lerp(58, 66, lift)} cy={lerp(36, 30, lift)} />
      <AbsoluteFill style={{ opacity: 1 - winGone, filter: winGone > 0.01 ? `blur(${winGone * 10}px)` : undefined, transform: `scale(${1 - winGone * 0.08})` }}>
        <ProductStage cam={keys} drift={f < T_LIFT ? 0.4 : 0}>
          <ProductWindow name="s20-signed-top" focus={{ x: 300, y: 150, w: 660, h: 750, r: 8 }} blur={7} dim={0.12} overlay={<Spot rect={{ x: 312, y: 172, w: 280, h: 30, r: 8 }} p={1 - prog(f, 10, 20)} />} />
        </ProductStage>
      </AbsoluteFill>
      {f >= T_LIFT && (
        <AbsoluteFill style={{ perspective: 2000, perspectiveOrigin: "50% 45%" }}>
          <div
            style={{
              position: "absolute",
              left: 960 - pw / 2,
              top: 540 - ph / 2,
              width: pw,
              height: ph,
              transform: `translate3d(${tx}px, ${ty}px, ${tz}px) rotateX(${rot.x}deg) rotateY(${rot.y}deg) rotateZ(${rot.z}deg) scale(${sc})`,
              transformOrigin: "50% 40%",
              filter: `drop-shadow(0 ${60 * shadow}px ${70 * shadow}px rgba(40,30,20,${0.28 * shadow}))`,
              WebkitMaskImage: `linear-gradient(180deg, #000 ${lerp(100, 74, lift)}%, transparent 100%)`,
            }}
          >
            <SnapCrop name="s20-signed-top" rect={PAGE} scale={S0} radius={lerp(0, 4, lift)} />
          </div>
        </AbsoluteFill>
      )}
      <Vignette strength={0.14} />
      <Grain opacity={0.03} />
    </AbsoluteFill>
  );
}

/** S11 签发：勾选“我已实质复核全部内容” → 确认签发 → 签发人记录 → 草稿 · 待复核 · 已签发。 */
export function S11Signoff() {
  const f = useCurrentFrame();
  const { C_SIGN, T_SIGNED, T_TOP } = SIGN;
  const px = pickX<SnapName>(f, [
    [0, "s14-checked"],
    [T_SIGNED, "s21-signed-bottom"],
    [T_TOP, "s20-signed-top"],
  ], 10);
  // 到页顶这一下是与镜头同帧的硬切（上一张是滚到底部的同一页，溶解会从空白处淡入）
  const { name: snap } = px;
  const prev = snap === "s20-signed-top" ? null : px.prev;
  const mix = snap === "s20-signed-top" ? 1 : px.mix;
  const keys = [
    cam(0, 1150, 640, 1.5, 1, -6, 330, 0),
    cam(T_SIGNED, 1150, 690, 1.56, 1, -5, 330, 0),
    cam(T_TOP - 1, 1150, 700, 1.58, 1, -5, 330, 0),
    cam(T_TOP, 470, 200, 1.9, 1, -5, 300, 20),
    cam(216, 460, 210, 2.0, 1, -5, 300, 20),
  ];
  // 只滚动签发后的那张（按快照自身判断，不跟着“当前/上一张”走——两层各用各的）
  const edit = (root: HTMLElement) => {
    if (root.dataset.snap === "s21-signed-bottom") scrollTo(root, "main", 980);
  };
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <StudioBackdrop cx={58} />
      <ProductStage cam={keys}>
        <ProductWindow
          name={snap}
          prev={prev}
          mix={mix}
          edit={edit}
          focus={snap === "s20-signed-top" ? null : { x: 980, y: 716, w: 344, h: 210, r: 10 }}
          blur={snap === "s20-signed-top" ? 0 : 2.6}
          dim={snap === "s20-signed-top" ? 0 : 0.03}
          overlay={
            <>
              {snap === "s14-checked" && <Spot rect={{ x: 984, y: 724, w: 336, h: 52, r: 8 }} p={prog(f, 8, 22) * (1 - prog(f, C_SIGN - 20, 14))} />}
              {snap === "s21-signed-bottom" && <Spot rect={{ x: 984, y: 1749 - 980 - 4, w: 336, h: 66, r: 8 }} p={prog(f, T_SIGNED + 6, 22)} />}
              {snap === "s20-signed-top" && <Spot rect={{ x: 312, y: 172, w: 280, h: 30, r: 8 }} p={prog(f, T_TOP + 12, 22)} />}
            </>
          }
        />
        <Cursor keys={[{ f: 0, x: 1220, y: 700 }, { f: C_SIGN - 8, x: 1099, y: 825 }]} clicks={[C_SIGN]} show={[4, T_SIGNED - 4]} />
      </ProductStage>
      <Title eyebrow="03  判断" lines={["签发之前，", "逐项由你确认。"]} sub={<>结果都是草稿，签发后才能对外；<br />签发人与时间随成果记录。</>} at={8} out={86} x={128} y={380} width={680} size={70} />
      <Vignette strength={0.14} />
      <Grain opacity={0.03} />
    </AbsoluteFill>
  );
}
