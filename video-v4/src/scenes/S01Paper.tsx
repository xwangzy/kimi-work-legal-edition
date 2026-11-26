/**
 * S01 序幕（6 小节，864 帧）：
 *  A 微距：黑场里，《股权转让协议》第 7.1 条在极浅景深中由虚到实，镜头沿字行横移。
 *  B 后拉：这一行原来在一页纸上；纸外是成百上千页合同、法规、判决、纪要，分层悬浮在夜色里。
 *  C 穿行：纸堆从镜头两侧掠过（近处虚化），字幕一。
 *  D 命题：纸堆沉入黑暗，只剩这一页；字幕二“让 AI 承担繁杂，让律师专注于专业判断。”
 *  E 蓝点：第 7.1 条旁亮起一颗蓝点（AI 的注意力），纸页暗去，蓝点移到画面中央 → S02。
 */
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { HERO_LAYOUT, HERO_PAD_X, HeroContract, PAPER_H, PAPER_W, PAPERS, Paper, rowCenter, rowIndex } from "../ui/paper";
import { easeCine, easeIn, easeInOut, easeOut, Grain, KimiDot, lerp, map, NightBackdrop, prog, rand, Title, Vignette } from "../ui/film";

const P = 1300; // 透视距离
/** 纸堆：确定性布局。z 为初始深度（负 = 远）。 */
const FIELD = Array.from({ length: 24 }).map((_, i) => {
  const side = i % 2 === 0 ? -1 : 1;
  const r = (k: number) => rand(i * 7.31 + k * 1.7);
  return {
    doc: PAPERS[i % PAPERS.length],
    x: side * (340 + r(1) * 1150),
    y: -620 + r(2) * 1240,
    z: -3600 + r(3) * 3900, // -3600 … 300
    ry: side * -(8 + r(4) * 22),
    rx: (r(5) - 0.5) * 16,
    rz: (r(6) - 0.5) * 10,
    w: 560 + r(7) * 160,
  };
});

/** 微距焦点（纸内坐标）：第 7.1 条“千分之五”附近。 */
const C71_Y = rowCenter("c71");
const FOCUS_A = { x: HERO_PAD_X + 150, y: C71_Y };
const FOCUS_B = { x: HERO_PAD_X + 470, y: C71_Y };
const CENTER = { x: PAPER_W / 2, y: PAPER_H / 2 };

export function S01Paper() {
  const f = useCurrentFrame();

  // ── 主纸的 2D 镜头：焦点（纸内坐标）放到屏幕 (sx, sy)，缩放 S ──
  const macroPan = prog(f, 20, 260, easeInOut);
  const pull = prog(f, 220, 220, easeCine);
  const settle = prog(f, 560, 150, easeInOut);
  const fx = lerp(lerp(FOCUS_A.x, FOCUS_B.x, macroPan), CENTER.x, pull);
  const fy = lerp(FOCUS_A.y, CENTER.y, pull);
  const S = lerp(3.3, 0.5, pull) * lerp(1, 1.1, settle) * (1 + map(f, [440, 600], [0, 0.04], easeInOut));
  const sx = 960 + lerp(0, -30, pull) * (1 - settle);
  const sy = 540 + lerp(0, 8, pull) - settle * 10;
  // 景深：微距时焦外很虚，焦点由虚到实
  const focusIn = prog(f, 36, 120, easeInOut);
  const dofR = lerp(120, 1400, pull); // 清晰区半径（纸内 px）
  const heroBlur = lerp(2.6, 0, pull);
  const heroLight = map(f, [0, 60, 600, 700], [0.0, 1, 1, 0.42]);
  const heroGone = prog(f, 780, 70, easeIn);

  // ── 纸堆：后拉时出现，穿行时向镜头推进，命题时沉入黑暗 ──
  const fieldIn = prog(f, 270, 120, easeInOut);
  const travel = map(f, [300, 720], [0, 1500], easeInOut);
  const sink = prog(f, 580, 140, easeInOut);
  const camX = map(f, [300, 720], [0, -260], easeInOut);

  const fieldItem = (p: (typeof FIELD)[number], i: number) => {
    const z = p.z + travel - sink * 600;
    if (z > P - 120) return null;
    const k = P / (P - z);
    const blur = Math.min(14, Math.abs(z + 300) / 170) + (z > 0 ? z / 60 : 0);
    const bright = map(z, [-3600, -400, 200], [0.18, 0.62, 0.8], easeInOut) * (1 - sink * 0.85);
    const op = fieldIn * map(z, [-3600, -2900], [0, 1], easeInOut) * (1 - map(z, [520, 900], [0, 1], easeInOut));
    if (op <= 0.003) return null;
    return (
      <div
        key={i}
        style={{
          position: "absolute",
          left: 960 + (p.x + camX) * k - (p.w * k) / 2,
          top: 540 + p.y * k - (p.w * 1.414 * k) / 2,
          width: p.w,
          transformOrigin: "0 0",
          transform: `scale(${k}) perspective(1400px) rotateY(${p.ry}deg) rotateX(${p.rx}deg) rotateZ(${p.rz}deg)`,
          filter: `blur(${blur.toFixed(2)}px) brightness(${bright.toFixed(3)})`,
          opacity: op,
        }}
      >
        <Paper doc={p.doc} w={p.w} />
      </div>
    );
  };
  const sorted = FIELD.map((p, i) => ({ p, i, z: p.z + travel - sink * 600 })).sort((a, b) => a.z - b.z);
  const back = sorted.filter((o) => o.z < 0);
  const front = sorted.filter((o) => o.z >= 0);

  // 蓝点：先亮在第 7.1 条左侧页边，再移到画面中央（交给 S02）
  const dotOn = prog(f, 712, 40, easeOut);
  const dotGo = prog(f, 790, 74, easeInOut);
  const dotPaper = { x: HERO_PAD_X - 34, y: C71_Y };
  const dotScreen = { x: sx + (dotPaper.x - fx) * S, y: sy + (dotPaper.y - fy) * S };
  const dx = lerp(dotScreen.x, 960, dotGo);
  const dy = lerp(dotScreen.y, 540, dotGo);
  const dotSize = lerp(10, 26, dotGo);
  const breathe = 1 + Math.sin(f / 9) * 0.06;

  const heroTransform = `translate(${sx}px, ${sy}px) scale(${S}) translate(${-fx}px, ${-fy}px)`;
  const c71 = rowIndex("c71");
  const band = HERO_LAYOUT[c71];
  // 7.1 条在命题段被一束冷光轻轻照亮
  const rowGlow = map(f, [700, 760, 800], [0, 1, 0.6], easeInOut) * (1 - heroGone);

  return (
    <AbsoluteFill style={{ overflow: "hidden", background: "#07080a" }}>
      <NightBackdrop glow={map(f, [0, 120, 600, 760], [0.2, 0.9, 1, 0.5])} gy={map(f, [0, 864], [22, 30])} size={70} />
      {/* 远处纸堆 */}
      <AbsoluteFill>{back.map((o) => fieldItem(o.p, o.i))}</AbsoluteFill>
      {/* 主纸：虚化底层 + 焦点清晰层 */}
      <AbsoluteFill style={{ opacity: 1 - heroGone }}>
        <div style={{ position: "absolute", left: 0, top: 0, transformOrigin: "0 0", transform: heroTransform, filter: `blur(${heroBlur}px) brightness(${heroLight * 0.9})` }}>
          <HeroContract light={heroLight} />
        </div>
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            transformOrigin: "0 0",
            transform: heroTransform,
            opacity: focusIn,
            filter: `brightness(${heroLight})`,
            WebkitMaskImage: `radial-gradient(ellipse ${dofR * 1.7}px ${dofR * 0.42 + 20}px at ${fx}px ${fy}px, #000 35%, transparent 100%)`,
          }}
        >
          <HeroContract
            light={heroLight}
            rowStyle={(_, i) => (i === c71 && rowGlow > 0 ? { textShadow: `0 0 ${18 * rowGlow}px rgba(23,131,255,${0.18 * rowGlow})` } : undefined)}
          />
          {rowGlow > 0.01 && <div style={{ position: "absolute", left: HERO_PAD_X - 12, top: band.y + 3, width: PAPER_W - HERO_PAD_X * 2 + 24, height: band.h - 6, borderRadius: 4, background: `rgba(23,131,255,${0.07 * rowGlow})` }} />}
        </div>
      </AbsoluteFill>
      {/* 近处纸堆（压在主纸前面，很虚） */}
      <AbsoluteFill>{front.map((o) => fieldItem(o.p, o.i))}</AbsoluteFill>
      {/* 微距时的“阅读灯”：一团暖光沿字行移动 */}
      <AbsoluteFill style={{ pointerEvents: "none", mixBlendMode: "soft-light", opacity: (1 - pull) * map(f, [10, 80], [0, 0.9]), background: `radial-gradient(38% 30% at ${lerp(40, 62, macroPan)}% 50%, rgba(255,236,205,0.55) 0%, rgba(255,236,205,0) 70%)` }} />
      {/* 命题时，中心压暗托字 */}
      <AbsoluteFill style={{ pointerEvents: "none", opacity: map(f, [600, 680, 820, 860], [0, 1, 1, 0]), background: "radial-gradient(60% 44% at 50% 44%, rgba(7,8,10,0.78) 0%, rgba(7,8,10,0.4) 60%, rgba(7,8,10,0) 100%)" }} />
      <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(7,8,10,0) 48%, rgba(7,8,10,0.78) 72%, rgba(7,8,10,0.94) 100%)", opacity: map(f, [240, 300, 560, 620], [0, 1, 1, 0]) }} />
      <Vignette strength={0.62} dark />

      <Title dark align="center" x={960} y={838} width={1600} size={42} weight={500} stagger={22} lines={["一份法律意见的背后，", "是成百上千页的合同、法规、判例与纪要。"]} at={300} out={548} />
      <Title dark align="center" x={960} y={392} width={1600} size={70} weight={700} stagger={30} lines={["让 AI 承担繁杂，", "让律师专注于专业判断。"]} at={634} out={812} />

      {dotOn > 0.001 && (
        <div style={{ position: "absolute", left: dx - dotSize / 2, top: dy - dotSize / 2, opacity: dotOn, transform: `scale(${(0.5 + 0.5 * dotOn) * breathe})` }}>
          <KimiDot size={dotSize} glow={lerp(0.7, 1, dotGo)} />
        </div>
      )}
      <Grain opacity={0.06} />
      <AbsoluteFill style={{ background: "#07080a", opacity: 1 - prog(f, 6, 40, easeInOut), pointerEvents: "none" }} />
    </AbsoluteFill>
  );
}
