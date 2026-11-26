/**
 * S12 一个工作空间（4 小节）：方法库（53 个法律工作方法，按办案阶段排列）→ 镜头后拉，真实页面沿一道弧排开，横移掠过：
 *   起诉状的论点确认（采用 / 改写 / 不用）→ 民事起诉状 → 事实时间轴（整理案卷，全部在本机完成）→ 法律问答 → 期限提醒；
 *   最后整排拉远，“从起草到期限，都在同一个工作空间里。”
 * S13 保密（3 小节，夜色）：深色模式“数据去向”：案卷只在这台电脑 / 发出前换成代号 / 中转不留内容 → 去向图 → 一次请求实际发出的样子。
 */
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { FONT_TITLE, useGlyphs } from "../fonts";
import { cam, easeCine, easeInOut, easeOut, Grain, KimiDot, lerp, LowerThird, map, NightBackdrop, prog, ProductStage, ProductWindow, Spot, StudioBackdrop, Title, Vignette } from "../ui/film";
import type { SnapName } from "../snaps";
import { scrollTo } from "./common";

const ITEMS: { snap: SnapName; label: string; sub: string }[] = [
  { snap: "p02-methods", label: "方法库", sub: "53 个法律工作方法 · 按办案阶段排列" },
  { snap: "P02-adopted", label: "起草 · 论点由你确认", sub: "逐条采用、改写或不用；你确认之前不会出文书" },
  { snap: "L90-preview", label: "民事起诉状", sub: "诉讼仲裁 · 起草起诉状" },
  { snap: "C93-preview", label: "事实时间轴", sub: "整理案卷 · 全部在这台电脑上完成" },
  { snap: "q140-chat", label: "法律问答", sub: "一般法律问题，直接问" },
];
const GAP = 1240; // 相邻页面的世界坐标间距
const BASE = 0.76; // 画廊里窗口的缩放

export function S12Breadth() {
  const f = useCurrentFrame();
  useGlyphs(ITEMS.map((i) => i.label + i.sub).join(""));
  // 镜头：G 为世界缩放，camX 为镜头所对的世界 x，ox 为画面偏移
  const G = map(f, [0, 110, 200, 300, 400], [1.25, 1.25, 1.0, 1.0, 0.72], easeCine);
  const camX = map(f, [110, 200, 300], [0, GAP, 4 * GAP], easeInOut) + map(f, [300, 400], [0, -2 * GAP], easeInOut);
  const ox = map(f, [0, 110, 200], [520, 520, 0], easeCine);
  const oy = map(f, [300, 400], [0, 120], easeInOut);
  const end = prog(f, 300, 100, easeInOut);
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <StudioBackdrop cx={55} cy={40} />
      <AbsoluteFill style={{ perspective: 2400, perspectiveOrigin: "50% 44%" }}>
        {ITEMS.map((it, i) => {
          const wx = i * GAP;
          const d = (wx - camX) * G; // 屏幕上的水平偏移
          const n = d / (GAP * G); // 以间距为单位
          const ry = Math.max(-28, Math.min(28, -n * 15)) * (1 - end * 0.5);
          const tz = -Math.abs(n) * 180 * (1 - end * 0.6);
          const blur = Math.min(6, Math.abs(n) * 3.2) * (1 - end);
          const s = BASE * G;
          const label = Math.max(0, 1 - Math.abs(n) * 1.8) * prog(f, 120, 30) * (1 - prog(f, 296, 24));
          const vis = map(Math.abs(d), [2400, 3200], [1, 0], easeInOut);
          if (vis <= 0.001) return null;
          return (
            <div key={i} style={{ position: "absolute", left: 960 + ox + d - 720, top: 450 + oy - 450, width: 1440, height: 900, transform: `translateZ(${tz}px) rotateY(${ry}deg) scale(${s})`, transformStyle: "preserve-3d", opacity: vis, filter: blur > 0.2 ? `blur(${blur.toFixed(2)}px)` : undefined }}>
              <ProductWindow name={it.snap} shadow={0.9} />
              <div style={{ position: "absolute", left: 0, right: 0, top: 900 + 30 / s, textAlign: "center", fontFamily: FONT_TITLE, opacity: label, transform: `scale(${1 / s})`, transformOrigin: "50% 0" }}>
                <div style={{ fontSize: 34, fontWeight: 700, color: "#0e1219", letterSpacing: 1 }}>{it.label}</div>
                <div style={{ marginTop: 10, fontSize: 24, color: "#7c776f", letterSpacing: 0.5 }}>{it.sub}</div>
              </div>
            </div>
          );
        })}
      </AbsoluteFill>
      <Title eyebrow="04  一个工作空间" lines={["53 个法律工作方法，", "按办案阶段排列。"]} sub="诉讼仲裁、非诉、企业法务三条业务线，另有通用方法。" at={10} out={104} x={128} y={380} width={760} size={64} />
      <AbsoluteFill style={{ pointerEvents: "none", opacity: end * 0.75, background: "linear-gradient(180deg, rgba(244,243,240,0.95) 0%, rgba(244,243,240,0.7) 22%, rgba(244,243,240,0) 38%)" }} />
      <Title align="center" lines={["从审合同到起诉状，", "都在同一个工作空间里。"]} at={304} out={370} x={960} y={70} width={1500} size={54} scrim={false} stagger={10} />
      <Vignette strength={0.14} />
      <Grain opacity={0.03} />
      {/* 光收拢成蓝点，接夜色的“保密” */}
      {f >= 380 && (() => {
        const c = prog(f, 382, 46, easeCine);
        const R = (1 - c) * 2300;
        return (
          <>
            <AbsoluteFill style={{ background: "#07080a", pointerEvents: "none", WebkitMaskImage: `radial-gradient(circle at 960px 540px, transparent ${R}px, #000 ${R + Math.min(22, R * 0.3) + 0.5}px)` }} />
            <div style={{ position: "absolute", left: 960 - 11, top: 540 - 11, opacity: prog(f, 406, 20) }}>
              <KimiDot size={22} glow={prog(f, 406, 26)} />
            </div>
          </>
        );
      })()}
    </AbsoluteFill>
  );
}

/* ───────── S13 保密（夜色） ───────── */
export function S13Trust() {
  const f = useCurrentFrame();
  const P = [
    { x: 366, y: 404, w: 249, h: 403, at: 86 },
    { x: 707, y: 404, w: 249, h: 403, at: 118 },
    { x: 1048, y: 404, w: 249, h: 403, at: 150 },
  ];
  // 拉开：三站去向图完整入画，高亮行在画面中线附近
  const keys = [
    cam(0, 830, 560, 0.86, 1, -6, 360, 0),
    cam(70, 830, 600, 0.98, 1, -6, 380, 0),
    cam(226, 830, 610, 1.02, 1, -5, 380, 0),
    cam(310, 830, 560, 1.42, 1, -5, 620, 0),
    cam(432, 830, 566, 1.48, 1, -5, 620, 0),
  ];
  // 页面向上滚 300 px：“一次 AI 请求实际发出的样子”这一行移到画面中线（真实界面在这一屏的最下沿）
  const scrollY = map(f, [232, 300], [0, 300], easeInOut);
  const winIn = prog(f, 6, 44, easeInOut);
  const dot = 1 - prog(f, 10, 30);
  const spot = (i: number) => prog(f, P[i].at, 20) * (1 - prog(f, 236, 24));
  const tokens = prog(f, 304, 24);
  return (
    <AbsoluteFill style={{ overflow: "hidden", background: "#07080a" }}>
      <NightBackdrop glow={map(f, [0, 80, 432], [0.4, 1, 0.9])} gx={62} gy={30} />
      <AbsoluteFill style={{ opacity: winIn }}>
        <ProductStage cam={keys} easing={easeCine}>
          <ProductWindow
            name="d03-visibility"
            edit={(root) => {
              // 中转站说明里的计量细项（含英文 token 字样）在片中虚一点，不抢三条主线
              for (const el of root.querySelectorAll<HTMLElement>(".dfm-station small")) if (el.textContent?.includes("token")) el.style.filter = "blur(2.2px)";
              // 月之暗面书面确认“待签署”属合作进展，不在片中焦点里（产品原文未改，见评审报告）
              for (const el of root.querySelectorAll<HTMLElement>(".dfm-station.dfm-model li, .dfm-station.dfm-model small")) if (el.textContent?.includes("待签署")) el.style.filter = "blur(2.2px)";
              if (scrollY > 0.5) scrollTo(root, "main", scrollY);
            }}
            overlay={
              <>
                {P.map((p, i) => <Spot key={i} rect={{ ...p, y: p.y - scrollY }} p={spot(i)} r={14} />)}
                {/* 三站标签出现时，压暗上方的三条要点卡（与标题副句重复），让标签干净可读 */}
                <div style={{ position: "absolute", left: 360, top: 236, width: 960, height: 112, background: "#141312", opacity: 0.9 * prog(f, P[0].at - 10, 20) * (1 - prog(f, 228, 20)), zIndex: 24 }} />
                {/* 三站的片级标签（文字取自产品去向图） */}
                {[
                  ["这台电脑", "加密保存 · 只有你能打开"],
                  ["中软云端服务", "只转发，不保存"],
                  ["Kimi 模型", "处理换成代号后的内容"],
                ].map(([a, b], i) => {
                  const o = prog(f, P[i].at, 20) * (1 - prog(f, 228, 20));
                  return o > 0.001 ? (
                    <div key={`l${i}`} style={{ position: "absolute", left: P[i].x - 10, top: P[i].y - 92 - scrollY, width: P[i].w + 20, textAlign: "center", fontFamily: FONT_TITLE, opacity: o, transform: `translateY(${(1 - o) * 10}px)`, zIndex: 25 }}>
                      <div style={{ fontSize: 28, fontWeight: 700, color: "#f5f4f1" }}>{a}</div>
                      <div style={{ marginTop: 4, fontSize: 18, color: "rgba(245,244,241,0.7)" }}>{b}</div>
                    </div>
                  ) : null;
                })}
                {[
                  { x: 438, y: 852, w: 129, h: 28 },
                  { x: 633, y: 852, w: 136, h: 28 },
                  { x: 807, y: 852, w: 119, h: 28 },
                ].map((r, i) => <Spot key={i} rect={{ ...r, y: r.y - scrollY * (274 / 300) }} p={tokens * prog(f, 304 + i * 10, 18)} pad={3} r={5} />)}
              </>
            }
          />
        </ProductStage>
      </AbsoluteFill>
      {dot > 0.001 && (
        <div style={{ position: "absolute", left: 960 - 11, top: 540 - 11, opacity: dot }}>
          <KimiDot size={22} glow={dot} />
        </div>
      )}
      <Title dark eyebrow="05  保密" lines={["为律所的", "保密义务而设计。"]} sub={<>案卷只在这台电脑；发出前换成代号；<br />中软只转发，不保存内容；每一次外发都有记录。</>} at={40} out={388} x={128} y={380} width={720} size={70} />
      <Vignette strength={0.5} dark />
      <Grain opacity={0.05} />
      <AbsoluteFill style={{ background: "#07080a", opacity: prog(f, 412, 20, easeInOut), pointerEvents: "none" }} />
    </AbsoluteFill>
  );
}
export { easeOut, lerp };
