/**
 * 第四幕 · 一件事（一镜到底，33.3 秒，不切）
 * 四个工作站排在同一个三维空间里，镜头连续穿行：
 *  W1 首页：一句话交代任务 → 产品建议“审合同”，律师点“使用审合同”
 *  W2 执行页：停下来问“拟签还是已签” → 律师选“拟签文本”、确定（时间线其余部分景深虚化）
 *  W3 审查工作台：蓝点落在第 7.1 条 → 真实意见卡 → 律师点“接受首选” → 生成修订稿（原件未改动，另有清洁稿）
 *  W4 成果：修订稿·对外版的 Word 预览（红删绿增）
 * 底部一条细线：交代 · 理解 · 分析 · 确认 · 成果，进度点随镜头前进。界面全部是真实任务的 DOM 快照。
 */
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { COPY } from "../copy";
import { ONETAKE as T, TASK } from "../beats";
import { CineStudio, Cursor, easeCine, easeInOut, easeOut, Grain, KimiDot, lerp, map, prog, Spot, Title, typed, Vignette } from "../ui/film";
import { css, qa } from "../ui/Snap";
import { camAt, type ShotKey } from "../ui/camera";
import { coc, rel } from "../ui/space";
import { WorldWindow, winPoint, winProject, type WinPos } from "../ui/stage";
import { pickX, scrollTo, typeInto } from "./common";
import { Caption, Rail } from "../ui/type";
import type { SnapName } from "../snaps";

const F = 1600;
const W1: WinPos = { x: 0, y: 0, d: 0, ry: 0 };
const W2: WinPos = { x: 2400, y: 50, d: 760, ry: -9 };
const W3: WinPos = { x: 4350, y: -30, d: 1350, ry: -12 };
const W4: WinPos = { x: 6500, y: 30, d: 1800, ry: -9 };
const WINS = [W1, W2, W3, W4];

const DOC_SCROLL = 320; // 工作台里合同上滚，第 7.1 条落在 y≈563
const C71_ROW = { x: 116, y: 552, w: 466, h: 22 };

/** 关键帧：在某个窗口里看向 (u,v)，放大 k。 */
const at = (f: number, w: WinPos, u: number, v: number, k: number, pitch = 0): ShotKey => ({ f, ...winPoint(w, u, v), z: F / k, yaw: w.ry, pitch });
/** 两窗之间的过渡点：看向两窗中点，退远。 */
const mid = (f: number, a: WinPos, b: WinPos, k: number): ShotKey => ({ f, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: (a.d + b.d) / 2, z: F / k, yaw: (a.ry + b.ry) / 2, pitch: 0 });

const KEYS: ShotKey[] = [
  at(0, W1, 167, 450, 0.6),
  at(T.T_TITLE_OUT - 10, W1, 250, 430, 0.66),
  at(T.T_HINT - 6, W1, 790, 300, 1.22),
  at(T.T_CLICK + 20, W1, 860, 300, 1.3),
  mid(T.ST2 - 50, W1, W2, 0.78), // 横移跟拍（不退远）
  at(T.ST2, W2, 470, 690, 1.2),
  at(T.C_OK + 20, W2, 450, 712, 1.34),
  { ...dotPath(0.55), f: T.ST3 - 40, z: F / 0.62, yaw: -10.5, pitch: 0 }, // 跟着蓝点走
  at(T.ST3, W3, 360, 520, 1.85),
  at(T.T_LAND + 30, W3, 330, 560, 2.15),
  at(T.T_PAN, W3, 340, 560, 2.15),
  at(T.T_PAN + 100, W3, 1060, 620, 1.34),
  at(T.C_ACCEPT + 10, W3, 980, 740, 1.48),
  at(T.T_REJ + 40, W3, 1110, 300, 1.62),
  at(T.T_RED - 16, W3, 1110, 306, 1.64),
  at(T.T_RED + 40, W3, 760, 128, 1.3),
  at(T.ST4 - 80, W3, 780, 132, 1.3),
  mid(T.ST4 - 40, W3, W4, 0.52),
  at(T.ST4 + 20, W4, 1070, 470, 1.3),
  at(T.T_DIM, W4, 1070, 480, 1.5),
  at(1500, W4, 1070, 485, 1.54),
];

/** 蓝点从提问卡上律师选中的“拟签文本”升起，飞过两站之间，落在工作台第 7.1 条页边（共享元素转场）。 */
function dotPath(p: number) {
  const a = winPoint(W2, 233, 690);
  const b = winPoint(W3, 70, 563);
  return { x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p) - Math.sin(p * Math.PI) * 260, d: lerp(a.d, b.d, p) };
}

/** 进度：0..4（交代 理解 分析 确认 成果）。 */
function railProgress(f: number) {
  return map(f, [0, T.T_CLICK, T.ST2, T.C_OK, T.ST3, T.T_PAN, T.C_ACCEPT, T.T_RED, T.ST4, 1490], [0, 0.1, 1, 1.15, 2, 2.2, 3, 3.2, 4, 4], easeInOut);
}

export function S5OneTake() {
  const f = useCurrentFrame();
  const { cam, z: zf } = camAt(f, KEYS, F);
  const blurOf = (w: WinPos) => coc(winProject(cam, w).z, zf, 3, 7);

  // W1 首页
  const [txt] = typed(TASK, f, T.T_TYPE, T.CPS);
  const w1Snap: SnapName = f < T.T_HINT ? "h01-home" : "h02-typed";
  const w1Edit = (root: HTMLElement, fr: number) => {
    if (root.dataset.snap === "h01-home") typeInto(root, "textarea", f >= T.T_TYPE - 20 ? txt : "", fr, f >= T.T_TYPE - 30 && f < T.T_HINT);
  };

  // W2 执行页：时间线虚化，只留提问卡清楚（也遮住了内部工具名一行）
  // 界面状态变化与真实界面一样是即时的（不做叠化，避免两张快照错位的重影）
  const w2 = pickX<SnapName>(f, [[0, "k01-ask"], [T.C_PICK + 4, "k02-ask-picked"], [T.T_ANSWERED, "k03-answered"]], 2);
  const w2Edit = (root: HTMLElement) => {
    // 提问卡以外（含“正在起草”一段、内部工具名一行）一律景深虚化，只留提问卡清楚
    for (const el of qa(root, ".step, .step-toggle, .progress-panel, .live-draft, .run-head ~ *:not(.interactions)")) css(el, { filter: "blur(3.5px)", opacity: 0.5 });
  };

  // W3 工作台
  const w3 = pickX<SnapName>(f, [[0, "w04-acc"], [T.C_ACCEPT + 8, "w05-acc"], [T.T_REJ, "w12-rej"], [T.T_RED, "w41-redline-done"]], 14);
  const land = prog(f, T.T_LAND, 22, easeOut);
  const dotX = 70;
  const dotY = 563;
  const dotOn = (f >= T.T_LAND ? 1 : 0) * (1 - prog(f, T.T_PAN + 30, 30));
  // 飞行中的蓝点（世界坐标 → 屏幕）
  const flyP = prog(f, T.C_OK + 30, T.T_LAND - T.C_OK - 30, easeCine);
  const flyOn = f >= T.C_OK + 24 && f < T.T_LAND;
  const fw = rel(cam, dotPath(flyP));
  const fk = F / Math.max(1, fw.z);
  const bloom = map(f, [T.T_LAND + 8, T.T_LAND + 40, T.T_PAN, T.T_PAN + 50], [0, 1, 1, 0.3]);
  const cards = prog(f, T.T_PAN - 20, 60, easeInOut);
  const w3Edit = (root: HTMLElement) => {
    const sn = root.dataset.snap;
    if (sn === "w12-rej") for (const m of qa(root, ".wb-mark:not(.mark-active)")) css(m, { opacity: 0.28 });
    if (sn === "w04-acc" || sn === "w05-acc") {
      scrollTo(root, ".wb-doc", DOC_SCROLL);
      if (sn === "w04-acc") {
        css(root.querySelector<HTMLElement>(".wb-cards"), { opacity: cards });
        for (const m of qa(root, ".wb-mark:not(.mark-active)")) css(m, { opacity: 0.28 });
        for (const m of qa(root, ".wb-mark.mark-active")) {
          if (f < T.T_LAND) m.classList.remove("mark-active");
          css(m, { boxShadow: `0 0 0 ${3 * bloom}px rgba(196,43,43,${0.18 * bloom}), 0 0 ${30 * bloom}px rgba(196,43,43,${0.28 * bloom})` });
        }
      } else {
        for (const m of qa(root, ".wb-mark.mark-active, .wb-mark.mark-hover")) m.classList.remove("mark-active", "mark-hover");
        const just = prog(f, T.C_ACCEPT + 8, 24, easeOut);
        const open = qa(root, ".rc.open")[0];
        if (open && just < 1) css(open, { transform: `translateY(${(1 - just) * 18}px)`, opacity: 0.4 + 0.6 * just });
      }
    }
  };

  // 收光：一镜到底的末尾，摄影棚的光慢慢降下来，接第五幕夜色
  const dimP = prog(f, T.T_DIM, 46, easeInOut);
  const capIdx = T.CAP;
  const caps = [COPY.d2, COPY.d3, COPY.d4, COPY.d5];
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <CineStudio />
      <AbsoluteFill>
        <WorldWindow cam={cam} w={W4} name="s05-sign-page" blur={blurOf(W4)} sheen={map(f, [T.ST4 - 40, T.ST4 + 60], [0, 1], easeInOut)} />
        <WorldWindow
          cam={cam}
          w={W3}
          name={w3.name}
          prev={w3.prev}
          mix={w3.mix}
          edit={w3Edit}
          blur={blurOf(W3)}
          sheen={map(f, [T.ST3 - 50, T.ST3 + 50], [0, 1], easeInOut)}
          overlay={
            <>
              {dotOn > 0.001 && (
                <div style={{ position: "absolute", left: dotX - 6, top: dotY - 6, opacity: dotOn, transform: `scale(${1 + 0.25 * Math.sin(land * Math.PI)})`, zIndex: 30 }}>
                  <KimiDot size={12} glow={1 - 0.4 * land} />
                </div>
              )}
              <Spot rect={{ ...C71_ROW, x: C71_ROW.x - 40, w: C71_ROW.w + 46, y: C71_ROW.y - 4, h: C71_ROW.h + 8 }} p={land * (1 - prog(f, T.T_PAN, 30))} />
              {/* 不采纳的第 9.1 条（真实：律师在本次任务里不采纳了这一条） */}
              <Spot rect={{ x: 828, y: 258, w: 584, h: 96, r: 10 }} p={prog(f, T.T_REJ + 40, 24) * (1 - prog(f, T.T_RED - 20, 20))} color="120,120,120" />
            </>
          }
        >
          <Cursor keys={[{ f: T.T_PAN + 60, x: 1180, y: 760 }, { f: T.C_ACCEPT - 10, x: 889, y: 849 }, { f: T.C_ACCEPT + 50, x: 1100, y: 600 }, { f: T.T_REJ + 50, x: 1370, y: 300 }]} clicks={[T.C_ACCEPT]} show={[T.T_PAN + 70, T.T_RED - 30]} />
        </WorldWindow>
        <WorldWindow cam={cam} w={W2} name={w2.name} prev={w2.prev} mix={w2.mix} edit={w2Edit} blur={blurOf(W2)} sheen={map(f, [T.ST2 - 50, T.ST2 + 50], [0, 1], easeInOut)}>
          <Cursor keys={[{ f: T.ST2 + 20, x: 620, y: 780 }, { f: T.C_PICK - 8, x: 233, y: 690 }, { f: T.C_OK - 8, x: 136, y: 825 }, { f: T.C_OK + 40, x: 300, y: 760 }]} clicks={[T.C_PICK, T.C_OK]} show={[T.ST2 + 24, T.C_OK + 50]} />
        </WorldWindow>
        <WorldWindow cam={cam} w={W1} name={w1Snap} prev={f >= T.T_HINT ? "h01-home" : null} mix={prog(f, T.T_HINT, 14)} edit={w1Edit} blur={blurOf(W1)} sheen={map(f, [20, 120], [0, 1], easeInOut)}>
          <Cursor keys={[{ f: T.T_HINT - 10, x: 1150, y: 520 }, { f: T.T_CLICK - 6, x: 1013, y: 322 }, { f: T.T_CLICK + 40, x: 1080, y: 400 }]} clicks={[T.T_CLICK]} show={[T.T_HINT - 4, T.T_CLICK + 60]} />
        </WorldWindow>
      </AbsoluteFill>
      {flyOn && fw.z > 50 && (
        <div style={{ position: "absolute", left: 960 + fw.x * fk - 7 * fk, top: 540 + fw.y * fk - 7 * fk, opacity: prog(f, T.C_OK + 24, 14) }}>
          <KimiDot size={14 * fk} glow={1} />
        </div>
      )}
      {/* 开场标题：一次真实的运行 */}
      <Title eyebrow={COPY.d0eyebrow} lines={COPY.d0} at={T.T_TITLE} out={T.T_TITLE_OUT} x={128} y={370} width={700} size={62} sub={COPY.d0note} subSize={26} />
      {caps.map((c, i) => (
        <Caption key={i} text={c} at={capIdx[i][0]} out={capIdx[i][1]} />
      ))}
      <Rail labels={COPY.rail} p={railProgress(f)} at={T.T_TITLE + 40} out={1440} />
      <Vignette strength={0.2} />
      <Grain opacity={0.03} />
      <AbsoluteFill style={{ background: "#07080a", opacity: dimP, pointerEvents: "none" }} />
    </AbsoluteFill>
  );
}
export { WINS, easeInOut };
