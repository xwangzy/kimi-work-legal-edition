/**
 * 第一幕 · 时代（25 秒）
 * 1 黑场里《民法典》第一条的微距，浅景深，镜头沿字行横移，焦点停在“秩序”；文案“法律，是写下来的秩序。”
 * 2 长距离后拉：这一行在一页上，一页在成千上万条法条里（随包法规库真实条文）；“读懂它，曾经只能靠人……”
 * 3 一颗蓝点出现，逐行读过一块条文，被读过的行亮起；“今天，智能开始读懂文字。”
 * 4 蓝点飞向远处的第五百八十五条（违约金），镜头跟随潜入那一行；“当智能可以读完一切，律师的时间，应该留给什么？”
 */
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { FONT_SERIF, FONT_TITLE, useGlyphs } from "../fonts";
import { COPY } from "../copy";
import { CORPUS as T } from "../beats";
import { BLOCKS, FS, HERO, LH, READ_ID, TARGET, TARGET_ROW, blockH, blockW, charAt, type Block } from "./corpus-data";
import { Grain, KimiDot, NIGHT, Vignette, easeCine, easeInOut, lerp, map, prog } from "../ui/film";
import { coc, rel, World, Plane, type Cam } from "../ui/space";
import { Manifesto } from "../ui/type";
import { camAt, type ShotKey } from "../ui/camera";

const F = 1000;
const READ = BLOCKS[READ_ID - 1];
const HERO_FOCUS = charAt(HERO, 0, 32.5); // “秩序”
const START = charAt(HERO, 0, 11);
/** 阅读路径：阅读块第 1～3 行，从行首到行尾。 */
const READ_ROWS = [1, 2, 3];
const TGT = charAt(TARGET, TARGET_ROW + 1, 13); // 第五百八十五条第二行“违约金”

function readingPoint(f: number) {
  // 蓝点在阅读块上逐行移动；之后飞向目标行
  const per = T.READ_PER;
  const k = (f - T.READ_AT) / per;
  if (k < 0) return { ...charAt(READ, READ_ROWS[0], 0), row: -1, col: 0 };
  const ri = Math.min(READ_ROWS.length - 1, Math.floor(k));
  const within = Math.min(1, k - ri);
  const cols = Math.min(READ.cols, Array.from(READ.lines[READ_ROWS[ri]]?.t ?? "").length);
  const col = easeInOut(within) * (cols - 1);
  return { ...charAt(READ, READ_ROWS[ri], col), row: ri, col };
}

function dotWorld(f: number) {
  const p = readingPoint(f);
  if (f <= T.FLY_AT) return p;
  const end = readingPoint(T.FLY_AT);
  const t = prog(f, T.FLY_AT, T.FLY_DUR, easeCine);
  // 弧线飞行：中段稍微抬高
  return { x: lerp(end.x, TGT.x, t), y: lerp(end.y, TGT.y, t) - Math.sin(t * Math.PI) * 260, d: lerp(end.d, TGT.d, t), row: 9, col: 0 };
}

const KEYS: ShotKey[] = [
  { f: 0, ...START, z: 250, yaw: 36, pitch: 5 },
  { f: T.MACRO_END, ...HERO_FOCUS, z: 265, yaw: 20, pitch: 2 },
  { f: T.MACRO_END + 110, ...HERO_FOCUS, z: 330, yaw: 13, pitch: 1.5 },
  { f: T.PULL_END, x: 420, y: 120, d: 0, z: 3800, yaw: -4, pitch: -2 },
];

function cameraAt(f: number): { cam: Cam; zf: number; A: number } {
  if (f <= T.PULL_END) {
    const c = camAt(f, KEYS, F);
    // 光圈：微距极浅 → 后拉逐渐收小
    const A = map(f, [0, 200, T.MACRO_END - 30, T.PULL_END - 120], [24, 17, 8, 5]);
    return { cam: c.cam, zf: c.z, A };
  }
  // 跟随蓝点：目标点 = 蓝点，距离从 5400 收到 1500，再在飞行段推近到目标行并潜入
  const dot = dotWorld(f);
  const endPull = camAt(T.PULL_END, KEYS, F);
  const follow = prog(f, T.PULL_END, 260, easeInOut);
  const tx = lerp(endPull.t.x, dot.x, follow);
  const ty = lerp(endPull.t.y, dot.y, follow);
  const td = lerp(endPull.t.d, dot.d, follow);
  let z = Math.exp(lerp(Math.log(3800), Math.log(1150), prog(f, T.PULL_END, 300, easeInOut)));
  if (f > T.FLY_AT) z = Math.exp(lerp(Math.log(1150), Math.log(1000), prog(f, T.FLY_AT, T.FLY_DUR, easeInOut)));
  if (f > T.DIVE_AT) z = Math.exp(lerp(Math.log(1000), Math.log(250), prog(f, T.DIVE_AT, T.DIVE_DUR, (t) => Math.pow(t, 1.8))));
  const yaw = lerp(-4, 3, prog(f, T.PULL_END, 600, easeInOut));
  const pitch = lerp(-2, 1, prog(f, T.PULL_END, 600, easeInOut));
  const a = (yaw * Math.PI) / 180;
  const b = (pitch * Math.PI) / 180;
  const cam: Cam = { x: tx - z * Math.sin(a) * Math.cos(b), y: ty - z * Math.sin(b), d: td - z * Math.cos(a) * Math.cos(b), yaw, pitch, F };
  const A = f > T.DIVE_AT ? lerp(6, 22, prog(f, T.DIVE_AT + 40, T.DIVE_DUR - 40)) : 6.5;
  // 潜入的最后一秒焦点外移：画面化成一片虚焦的“违约金”，与第二幕开头同样虚焦的合同条款匹配剪辑
  const defocus = prog(f, T.DIVE_AT + T.DIVE_DUR - 60, 60, easeInOut);
  return { cam, zf: z * (1 + 0.9 * defocus), A };
}

/** 光波：从阅读块中心向外扩散的一圈亮光（波前处最亮，扫过后保留一点余辉）。 */
const RC = { x: READ.x + blockW(READ) / 2, y: READ.y + blockH(READ) / 2, d: READ.d };
function waveGlow(b: Block, f: number) {
  if (f < T.WAVE) return 0;
  const r = 15000 * Math.pow(prog(f, T.WAVE, 300, (t) => t), 1.15);
  const c = { x: b.x + blockW(b) / 2, y: b.y + blockH(b) / 2, d: b.d };
  const dist = Math.hypot(c.x - RC.x, c.y - RC.y, (c.d - RC.d) * 0.8);
  const front = Math.exp(-Math.pow((dist - r) / 2000, 2));
  const after = dist < r ? 0.3 * (1 - prog(f, T.WAVE + 300, 200)) : 0;
  return Math.min(1, front + after);
}

function BlockView({ b, cam, zf, A, f, lit, R = 1 }: { b: Block; cam: Cam; zf: number; A: number; f: number; lit?: (row: number) => number; R?: number }) {
  const c = rel(cam, { x: b.x + blockW(b) / 2, y: b.y + blockH(b) / 2, d: b.d });
  if (c.z < 60) return null;
  // 剔除：四角投影完全在画面外的块、离镜头过近（投影超过画面数倍）的块——后者在 4K 下会生成超大图层，渲染极慢甚至卡死
  const corners = [
    rel(cam, { x: b.x, y: b.y, d: b.d }),
    rel(cam, { x: b.x + blockW(b), y: b.y, d: b.d }),
    rel(cam, { x: b.x, y: b.y + blockH(b), d: b.d }),
    rel(cam, { x: b.x + blockW(b), y: b.y + blockH(b), d: b.d }),
  ];
  if (corners.some((p) => p.z < 40)) return null;
  const xs = corners.map((p) => 960 + (p.x * F) / p.z);
  const ys = corners.map((p) => 540 + (p.y * F) / p.z);
  const bw = Math.max(...xs) - Math.min(...xs);
  if (Math.max(...xs) < -100 || Math.min(...xs) > 2020 || Math.max(...ys) < -100 || Math.min(...ys) > 1180) return null;
  if (bw > 4200) return null;
  const nearFade = prog(c.z, 90, 420, (t) => t) * (1 - prog(bw, 2800, 1400, (t) => t));
  const fog = Math.max(0.06, Math.min(1, 1 - (c.z - 2600) / 10500));
  const wg = waveGlow(b, f);
  const o = nearFade * Math.min(1, fog * b.tone * (1 + 1.8 * wg) + 0.42 * wg);
  if (o < 0.01) return null;
  const k = F / c.z;
  const screenBlur = coc(c.z, zf, A, 26);
  const blur = (screenBlur / k) * R; // 局部（R 倍）坐标里的模糊半径
  // 强离焦（屏幕模糊 ≥ 6px）的块：文字已不可辨，画成“离焦的文字行”——每行一条解析高斯模糊的软条（box-shadow 偏移法，
  // Skia 对矩形阴影走解析快路径），观感与模糊文字一致，4K 下快两个数量级；5–7px 之间与模糊文字交叉过渡。
  const barMix = prog(screenBlur, 9, 3, (t) => t);
  // 景深模糊用 text-shadow 实现（透明字 + 同色柔影 ≈ 高斯模糊 σ=半径/2）：4K 下比 CSS filter 快一个数量级，观感一致
  const soft = blur > 0.25;
  const baseInk = wg > 0.05 ? `rgb(${lerp(239, 255, wg)},${lerp(233, 252, wg)},${lerp(222, 246, wg)})` : "#efe9de";
  const glow = wg > 0.2 ? `0 0 ${(14 * wg).toFixed(1)}px rgba(255,248,236,${(0.35 * wg).toFixed(2)})` : "";
  const ink = (c: string) => (soft ? { color: "transparent", textShadow: [`0 0 ${(blur * 2).toFixed(2)}px ${c}`, glow].filter(Boolean).join(", ") } : { color: c, textShadow: glow || undefined });
  const OFF = 20000;
  const bars =
    barMix > 0.001 ? (
      <div style={{ position: "absolute", left: 0, top: 0, opacity: Math.min(1, o * 1.15) * barMix }}>
        {[{ w: Array.from(b.title).length * FS * 0.62 * 1.32, y: LH * 0.45, h: FS * 0.55, a: 0.08 }, ...b.lines.map((l, i) => {
          const L = lit ? lit(i) : 0;
          const lo = (lit ? 0.36 : 0.5) + (lit ? 0.64 : 0.5) * L + (l.head ? 0.08 : 0);
          return { w: Array.from(l.t).length * FS, y: 1.4 * LH + i * LH + LH * 0.24, h: LH * 0.52, a: 0.2 * lo };
        })].map((r, i) => (
          <div key={i} style={{ position: "absolute", left: -OFF, top: r.y, width: r.w, height: r.h, borderRadius: r.h / 2, boxShadow: `${OFF}px 0 ${(blur * 2 + 2).toFixed(1)}px 0 rgba(239,233,222,${r.a.toFixed(3)})` }} />
        ))}
      </div>
    ) : null;
  return (
    <Plane x={b.x} y={b.y} d={b.d}>
      {bars}
      {barMix < 0.999 && <div style={{ width: blockW(b) * R, transform: R !== 1 ? `scale(${1 / R})` : undefined, transformOrigin: "0 0", fontFamily: FONT_SERIF, fontSize: FS * R, lineHeight: `${LH * R}px`, ...ink(baseInk), opacity: Math.min(1, o * 1.15) * (1 - barMix), whiteSpace: "pre" }}>
        <div style={{ fontFamily: FONT_TITLE, fontSize: FS * 0.62 * R, letterSpacing: "0.32em", height: LH * 1.4 * R, ...ink("rgba(236,230,218,0.5)") }}>{b.title}</div>
        {b.lines.map((l, i) => {
          const L = lit ? lit(i) : 0;
          return (
            <div key={i} style={{ opacity: (lit ? 0.36 : 0.5) + (lit ? 0.64 : 0.5) * L + (l.head ? 0.08 : 0), fontWeight: l.head ? 600 : 400, ...(L > 0 ? ink(`rgb(${lerp(236, 255, L)},${lerp(230, 250, L)},${lerp(218, 240, L)})`) : {}) }}>
              {l.t}
            </div>
          );
        })}
      </div>}
    </Plane>
  );
}

/**
 * 近景文字（主角块、潜入目标块）：不用 CSS 3D（Chrome 会按较低分辨率栅格化放大的 3D 文字），
 * 而是逐字手算透视投影，在 2D 里按真实屏幕字号排字，景深逐字计算。与世界里的块同一套相机，位置完全一致。
 */
function NearText({ b, cam, zf, A, alpha = 1, lit, rowFrom = 0, rowTo = 99, others = 1 }: { b: Block; cam: Cam; zf: number; A: number; alpha?: number; lit?: (row: number) => number; rowFrom?: number; rowTo?: number; others?: number }) {
  const out: JSX.Element[] = [];
  const put = (key: string, ch: string, wx: number, wy: number, size: number, weight: number, o: number, family: string) => {
    const c = rel(cam, { x: wx, y: wy, d: b.d });
    if (c.z < 40) return;
    const k = F / c.z;
    const sx = 960 + c.x * k;
    const sy = 540 + c.y * k;
    const px = size * k;
    if (sx < -px * 2 || sx > 1920 + px * 2 || sy < -px * 2 || sy > 1080 + px * 2) return;
    // 横向透视缩短：投影后的字宽 / 字号
    const l = rel(cam, { x: wx - size / 2, y: wy, d: b.d });
    const r = rel(cam, { x: wx + size / 2, y: wy, d: b.d });
    const wScreen = Math.abs(960 + (r.x * F) / r.z - (960 + (l.x * F) / l.z));
    const sxScale = Math.max(0.2, Math.min(1.4, wScreen / px));
    const bl = coc(c.z, zf, A, 24);
    const fade = prog(c.z, 40, 160, (t) => t);
    out.push(
      <span
        key={key}
        style={{
          position: "absolute",
          left: sx - px / 2,
          top: sy - px * 0.56,
          width: px,
          fontSize: px,
          lineHeight: 1,
          textAlign: "center",
          fontFamily: family,
          fontWeight: weight,
          opacity: o * alpha * fade,
          transform: `scaleX(${sxScale.toFixed(3)})`,
          ...(bl > 0.35 ? { color: "transparent", textShadow: `0 0 ${(bl * 2).toFixed(2)}px #f1ece2` } : {}),
        }}
      >
        {ch}
      </span>,
    );
  };
  // 标题行（法规名）
  Array.from(b.title).forEach((ch, i) => put(`t${i}`, ch, b.x + i * FS * 0.62 * 1.32 + FS * 0.31, b.y + LH * 0.55, FS * 0.62, 500, 0.5, FONT_TITLE));
  b.lines.forEach((ln, row) => {
    if (row < rowFrom || row > rowTo) return;
    const L = lit ? lit(row) : 0;
    const base = row === 0 && b === HERO ? 1 : (lit ? 0.42 + 0.58 * L : 0.62) * others;
    Array.from(ln.t).forEach((ch, col) => {
      const p = charAt(b, row, col);
      put(`${row}-${col}`, ch, p.x, p.y, FS, ln.head ? 600 : 400, base, FONT_SERIF);
    });
  });
  return <AbsoluteFill style={{ color: "#f1ece2", whiteSpace: "pre", pointerEvents: "none" }}>{out}</AbsoluteFill>;
}

export function S1Corpus({ captions = true, dot = true }: { captions?: boolean; dot?: boolean } = {}) {
  const f = useCurrentFrame();
  useGlyphs(HERO.lines.map((l) => l.t).join("") + TARGET.lines.map((l) => l.t).join("") + HERO.title);
  const { cam, zf, A } = cameraAt(f);
  const targetNear = rel(cam, { x: TARGET.x + blockW(TARGET) / 2, y: TARGET.y + blockH(TARGET) / 2, d: TARGET.d }).z < 2600;
  // 阅读高亮：读过的行渐亮
  const rp = readingPoint(f);
  const litRead = (row: number) => {
    const ri = READ_ROWS.indexOf(row);
    if (ri < 0 || f < T.READ_AT) return 0;
    if (ri < rp.row) return 1;
    if (ri === rp.row) return Math.min(1, rp.col / 6);
    return 0;
  };
  const litTarget = (row: number) => (row === TARGET_ROW + 1 ? prog(f, T.FLY_AT + T.FLY_DUR - 40, 60) : 0);
  // 蓝点（屏幕坐标）
  const dw = dotWorld(f);
  const dr = rel(cam, dw);
  const dk = F / Math.max(1, dr.z);
  const dotOn = prog(f, T.DOT_AT, 50) * (1 - prog(f, T.DIVE_AT + T.DIVE_DUR - 70, 50));
  const dotSize = Math.max(15, Math.min(60, 15 * dk * 2.8));
  const lift = prog(f, 0, 80, easeInOut);
  const toBlack = 0; // 不压黑：与第二幕“违约金”直接匹配剪辑
  // 问句出现时，星海整体退暗，给全片论点留出独立的留白
  const quiet = prog(f, T.C4 - 30, 60, easeInOut) * (1 - prog(f, T.DIVE_AT + 40, 80, easeInOut));
  // 背景微光：后拉时出现一层极淡的暖色雾，给纵深
  const haze = prog(f, T.MACRO_END, 420, easeInOut);
  return (
    <AbsoluteFill style={{ background: NIGHT, overflow: "hidden" }}>
      <AbsoluteFill style={{ background: `radial-gradient(70% 60% at 52% 46%, rgba(255,236,206,${0.05 * haze}) 0%, rgba(255,236,206,0) 70%)` }} />
      <World cam={cam} style={{ opacity: 1 - 0.72 * quiet }}>
        {BLOCKS.filter((b) => b.d > 0).map((b) => (
          <BlockView key={b.id} b={b} cam={cam} zf={zf} A={A} f={f} lit={b.id === READ_ID ? litRead : undefined} R={b.id === READ_ID ? 2 : 1} />
        ))}
        {!targetNear && <BlockView b={TARGET} cam={cam} zf={zf} A={A} f={f} lit={litTarget} />}
      </World>
      {/* 主角块：始终逐字投影（与世界同一相机） */}
      <NearText b={HERO} cam={cam} zf={zf} A={A} alpha={prog(f, 10, 150, easeInOut) * (1 - 0.72 * quiet)} others={map(f, [0, T.MACRO_END + 60, T.MACRO_END + 260], [0.14, 0.14, 1])} />
      {targetNear && <NearText b={TARGET} cam={cam} zf={zf} A={A} lit={litTarget} alpha={1 - 0.66 * quiet * (1 - prog(f, T.DIVE_AT - 20, 60, easeInOut))} />}
      {/* 中景块（在主角与后拉终点之间）画在主角之上 */}
      <World cam={cam} style={{ opacity: 1 - 0.72 * quiet }}>
        {BLOCKS.filter((b) => b.d <= 0).map((b) => (
          <BlockView key={b.id} b={b} cam={cam} zf={zf} A={A} f={f} />
        ))}
      </World>
      {dot && dotOn > 0.001 && dr.z > 20 && (
        <div style={{ position: "absolute", left: 960 + dr.x * dk - dotSize / 2, top: 540 + dr.y * dk - dotSize / 2 - FS * 0.62 * dk, opacity: dotOn }}>
          <KimiDot size={dotSize} glow={0.9} />
        </div>
      )}
      <Vignette strength={0.55} dark />
      {/* 文案（宋体，下方居中） */}
      {captions && <Manifesto lines={[COPY.a1]} at={T.C1} out={T.C1_OUT} y={862} size={62} scrim={0.95} />}
      {captions && <Manifesto lines={[COPY.a2, [{ t: COPY.a3, d: T.C3_DELAY }]]} at={T.C2} out={T.C2_OUT} y={838} size={54} scrim={0.78} />}
      {captions && <Manifesto lines={COPY.a4} at={T.C4} out={T.C4_OUT} y={800} size={62} scrim={0.6} cps={20} />}
      <Grain opacity={0.05} />
      <AbsoluteFill style={{ background: NIGHT, opacity: 1 - lift }} />
      {toBlack > 0 && <AbsoluteFill style={{ background: NIGHT, opacity: toBlack }} />}
    </AbsoluteFill>
  );
}
