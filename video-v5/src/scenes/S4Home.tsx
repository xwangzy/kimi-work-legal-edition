/**
 * 第三幕 · 首页（8.3 秒）
 *  - 标识组合停住，下方一句“为法律而生的 AI 工作方式”；
 *  - 匹配剪辑：标识里的“Kimi Work”与首页中央字标重合，首页按层（侧栏、近期期限、方法、输入框）在不同深度显影、合拢成窗口；
 *  - 镜头滑到首页的方法区：“诉讼、非诉、企业法务，每一类工作，都有专业的方法。”（53 个法律工作方法，按办案阶段排列）；
 *  - 末帧与第四幕一镜到底的首帧完全相同（同一窗口、同一机位），两幕之间不切。
 */
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { COPY } from "../copy";
import { HOMEB as T } from "../beats";
import { AppWindow, cam, CineStudio, easeIn, easeInOut, easeOut, Grain, lerp, map, prog, ProductStage, ProductWindow, StudioBackdrop, Title, Vignette } from "../ui/film";
import { FONT_TITLE, useGlyphs } from "../fonts";
import { Snap } from "../ui/Snap";
import { hide, only } from "./common";
import { LK, LK_WORD, Lockup } from "../ui/lockup";

const HOME_WORD = { x: 680, y: 153, w: 236, h: 52 }; // 首页中央字标（快照坐标）
const MX = -1720; // 方法库窗口在首页左侧（同一平面），镜头横移过去再回来，不做叠化换物
const S0 = (LK.WH * 236) / 52 / HOME_WORD.w;
const LAYERS: { sel: string[]; z: number }[] = [
  { sel: [".sidebar"], z: 70 },
  { sel: [".today"], z: 60 },
  { sel: [".home-scenes"], z: 130 },
  { sel: [".composer-shell"], z: 210 },
  { sel: [".home-wordmark"], z: 300 },
];
const LAYER_SELS = LAYERS.flatMap((l) => l.sel);

export function S4Home() {
  const f = useCurrentFrame();
  useGlyphs(COPY.c1);
  const M = T.MATCH;
  const keys = [
    cam(0, HOME_WORD.x + HOME_WORD.w / 2, HOME_WORD.y + HOME_WORD.h / 2, S0, 0, 0, LK_WORD.x + LK_WORD.w / 2 - 960, LK_WORD.y + LK.WH / 2 - 540),
    cam(M, HOME_WORD.x + HOME_WORD.w / 2, HOME_WORD.y + HOME_WORD.h / 2, S0, 0, 0, LK_WORD.x + LK_WORD.w / 2 - 960, LK_WORD.y + LK.WH / 2 - 540),
    cam(M + 70, 760, 320, 0.98, 4, -6, 60, 20),
    cam(M + 140, 720, 450, 0.76, 0, -3, 0, 0),
    cam(T.METHODS + 20, MX + 450, 150, 1.5, 0, -3, 330, 90),
    cam(T.C2_OUT - 20, MX + 460, 156, 1.53, 0, -3, 330, 90),
    cam(500, 330, 460, 0.56, 0, 0, 0, 0),
  ];
  const before = f < M;
  const E = map(f, [M, M + 30, M + 128], [1, 1, 0], easeInOut);
  const grow = (i: number) => prog(f, M + 4 + i * 9, 34, easeOut);
  const layered = f >= M && f < M + 132;
  const lockOut = prog(f, M - 4, 22, easeIn);
  const sub = prog(f, T.SUB, 50, easeOut) * (1 - prog(f, T.SUB_OUT, 30, easeIn));
  const sheen = map(f, [M + 126, M + 210], [0, 1], easeInOut);
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <StudioBackdrop cy={44} floor={0} />
      <CineStudio k={prog(f, T.MATCH, 220, easeInOut)} />
      {before ? (
        <>
          <Lockup mark={1 - lockOut} word={1} tag={1 - lockOut} sub={1 - lockOut} />
          <div style={{ position: "absolute", left: 0, right: 0, top: LK_WORD.y + 196, textAlign: "center", fontFamily: FONT_TITLE, fontSize: 30, fontWeight: 400, letterSpacing: 6, color: "#3c3934", opacity: sub, transform: `translateY(${(1 - sub) * 10}px)` }}>{COPY.c1}</div>
        </>
      ) : (
        <ProductStage cam={keys} drift={0} mb={0.3}>
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
            <>
              <ProductWindow name="h01-home" sheen={sheen} />
              <div style={{ position: "absolute", left: MX, top: 0, width: 1440, height: 900 }}>
                <ProductWindow name="p02-methods" sheen={map(f, [T.METHODS - 40, T.METHODS + 60], [0, 1], easeInOut)} />
              </div>
            </>
          )}
        </ProductStage>
      )}
      {/* 匹配剪辑那一刻：标识的字标与首页字标重合（字标层从 M 起由快照接手） */}
      <Title eyebrow="" lines={COPY.c2} sub={COPY.c2sub} at={T.C2} out={T.C2_OUT} x={128} y={150} width={1000} size={58} subSize={28} />
      <Vignette strength={0.08 + 0.12 * prog(f, T.MATCH, 220, easeInOut)} />
      <Grain opacity={0.03} />
    </AbsoluteFill>
  );
}
