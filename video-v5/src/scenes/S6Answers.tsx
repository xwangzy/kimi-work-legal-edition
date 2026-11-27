/**
 * 第五幕 · 回答（25 秒，夜色）——第二幕三个问题，逐一用真实产品作答：
 *  一 依据在哪里？——每一条法条引用，都对照原文核验（引用卡：成果里这样写 / 法条原文〔施行版本〕/ 来源已核 · 版本已核 · 支持待判）
 *  二 案卷去了哪里？——案卷原件留在你的电脑上（当事人条款里姓名、证件号、电话换成本事项的真实代号；设置 › 数据去向三站）
 *  三 谁来负责？——签发由律师亲自完成（勾选“我已实质复核全部内容”→ 确认签发 → 已签发）
 * 产品画面在夜色里像一块亮着的屏幕；焦点外的部分（含内部字段名、合作进展“待签署”一行）景深虚化，不进入可读焦点。
 */
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { COPY } from "../copy";
import { ANSWERS as T } from "../beats";
import { TOKENS } from "../real";
import { cam, Cursor, easeCine, easeInOut, easeOut, Grain, lerp, map, NightBackdrop, prog, ProductStage, ProductWindow, Spot, Title, Vignette } from "../ui/film";
import { FONT_SERIF, FONT_TITLE, useGlyphs } from "../fonts";
import { HERO_LAYOUT, HeroContract, PAPER_W, rowIndex } from "../ui/paper";
import { pickX } from "./common";
import { qa, rectIn, shiftChildren, SnapCrop } from "../ui/Snap";

/** 引用页：把引用列表滚到《民法典》第五百八十五条那张卡（第 7.1 条意见的依据，呼应第二幕被划出的“根据相关法律规定”）。 */
function scrollTo585(root: HTMLElement) {
  const body = root.querySelector<HTMLElement>(".tab-body");
  const card = qa(root, ".claim").find((c) => c.textContent?.includes("第五百八十五条"));
  if (!body || !card) return;
  // 用版面偏移（offsetTop 链，不受镜头 3D 透视与位移影响）计算，每帧结果完全一致
  const top = (el: HTMLElement | null) => {
    let y = 0;
    for (let e = el; e; e = e.offsetParent as HTMLElement | null) y += e.offsetTop;
    return y;
  };
  shiftChildren(body, top(card) - top(body) - 34);
}

/** 复核签发页：把右栏滚到“签发人：…（时间）”一行。 */
function scrollToSigner(root: HTMLElement) {
  const line = qa(root, "p, div, span").find((e) => e.childElementCount === 0 && e.textContent?.startsWith("签发人："));
  if (!line) return;
  let sc: HTMLElement | null = line.parentElement;
  while (sc && sc !== root && !(sc.scrollHeight > sc.clientHeight + 4 && getComputedStyle(sc).overflowY !== "visible")) sc = sc.parentElement;
  if (!sc || sc === root) return;
  const rs = rectIn(root, sc);
  const rl = rectIn(root, line);
  if (!rs || !rl) return;
  shiftChildren(sc, Math.max(0, rl.y - rs.y - 520));
}
import type { SnapName } from "../snaps";

const SWAPS = [
  { row: "p1", from: "张伟", to: TOKENS.name1, at: 70 },
  { row: "p1b", from: "110101********4517", to: TOKENS.id1, at: 92 },
  { row: "p2", from: "李娜", to: TOKENS.name2, at: 114 },
  { row: "p2b", from: "139****6688", to: TOKENS.phone2, at: 136 },
];

function renderSwaps(id: string | undefined, text: string, f: number) {
  const mine = SWAPS.filter((s) => s.row === id);
  if (!mine.length) return text;
  const parts: (string | JSX.Element)[] = [];
  let rest = text;
  mine.forEach((s, k) => {
    const i = rest.indexOf(s.from);
    if (i < 0) return;
    parts.push(rest.slice(0, i));
    const p = prog(f, s.at, 26, easeInOut);
    const glow = map(f, [s.at - 4, s.at + 8, s.at + 40], [0, 1, 0]);
    parts.push(
      <span key={k} style={{ position: "relative", display: "inline-block" }}>
        <span style={{ display: "inline-block", opacity: 1 - p, filter: `blur(${p * 4}px)`, transform: `translateY(${-p * 6}px)`, position: p > 0.5 ? "absolute" : "relative", left: 0, whiteSpace: "nowrap" }}>{s.from}</span>
        {p > 0.001 && (
          <span style={{ display: "inline-block", opacity: p, transform: `translateY(${(1 - p) * 8}px)`, position: p <= 0.5 ? "absolute" : "relative", left: 0, whiteSpace: "nowrap", fontFamily: FONT_SERIF, color: "#0a66d1", background: `rgba(23,131,255,${0.1 * p})`, borderRadius: 3, padding: "0 3px" }}>{s.to}</span>
        )}
        {glow > 0.01 && <span style={{ position: "absolute", left: -6, right: -6, top: -4, bottom: -4, borderRadius: 4, boxShadow: `0 0 ${22 * glow}px rgba(23,131,255,${0.45 * glow})`, background: `rgba(23,131,255,${0.08 * glow})`, pointerEvents: "none" }} />}
      </span>,
    );
    rest = rest.slice(i + s.from.length);
  });
  parts.push(rest);
  return <>{parts}</>;
}

/** 一段问答：小字问题（宋体，灰）+ 回答（黑体两行）+ 副句。 */
function QA({ q, a, sub, at, out }: { q: string; a: readonly string[]; sub: readonly string[]; at: number; out: number }) {
  const f = useCurrentFrame();
  useGlyphs(q);
  const qp = prog(f, at, 40, easeOut) * (1 - prog(f, out, 30, easeInOut));
  return (
    <>
      <div style={{ position: "absolute", left: 128, top: 306, fontFamily: FONT_SERIF, fontSize: 40, fontWeight: 600, letterSpacing: 2, color: "rgba(239,234,225,0.5)", opacity: qp, transform: `translateY(${(1 - qp) * 8}px)`, zIndex: 60 }}>{q}</div>
      <Title eyebrow="" lines={a} sub={<span style={{ whiteSpace: "nowrap" }}>{sub[0]}<br />{sub[1]}</span>} at={at + 26} out={out - 6} x={128} y={398} width={680} size={64} subSize={sub[0].length > 22 ? 25 : 28} dark />
    </>
  );
}

export function S6Answers() {
  const f = useCurrentFrame();
  const local = (o: number) => f - o;
  // ── 一 依据 ──
  const f1 = local(T.A1);
  const show1 = f < T.A2 + 30;
  const in1 = prog(f, T.A1, 16, easeInOut) * (1 - prog(f, T.A2 - 24, 40, easeInOut));
  // ── 二 案卷 ──
  const f2 = local(T.A2);
  const show2 = f > T.A2 - 40 && f < T.A3 + 30;
  const in2 = prog(f, T.A2 - 34, 40, easeInOut) * (1 - prog(f, T.A3 - 24, 40, easeInOut));
  const paperIn = prog(f2, 0, 60, easeCine);
  const toFlow = prog(f2, T.FLOW, 50, easeInOut);
  const sent = prog(f2, SWAPS[0].at - 4, 16); // 标签与第一处替换同帧翻成“发出前，换成代号”
  const p1 = HERO_LAYOUT[rowIndex("p1")];
  // ── 三 负责 ──
  const f3 = local(T.A3);
  const show3 = f > T.A3 - 40;
  const in3 = prog(f, T.A3 - 34, 40, easeInOut) * (1 - prog(f, T.END - 10, 26, easeInOut));
  const s3 = pickX<SnapName>(f3, [[0, "s14-checked"], [T.C_SIGN + 6, "s15-signed"], [T.TOP, "s20-signed-top"]], 14);
  const s3Edit = (root: HTMLElement) => {
    // 签发后，右栏轻轻上滚 120px，露出“签发人：王律师（2026年11月26日 14:43）”这一行
    if (root.dataset.snap === "s15-signed") {
      const main = root.querySelector<HTMLElement>("main.main");
      if (main) shiftChildren(main, 895 + 64 * prog(f3, T.SIGNER - 30, 44, easeInOut));
    }
  };
  return (
    <AbsoluteFill style={{ overflow: "hidden", background: "#07080a" }}>
      <NightBackdrop gx={66} gy={34} size={70} glow={1.6} />
      {/* 一 依据：真实引用卡 */}
      {show1 && (
        <AbsoluteFill style={{ opacity: in1 }}>
          <ProductStage cam={[cam(0, 1120, 300, 1.72, 0, -3, 430, 10), cam(T.A2, 1120, 320, 1.6, 1, -5, 440, 10)]} drift={0.3}>
            <ProductWindow
              name="t-引用-s1"
              edit={scrollTo585}
              focus={{ x: 826, y: 120, w: 604, h: 380, r: 12 }}
              blur={4}
              dim={0.8}
              overlay={
                <>

                </>
              }
            />
          </ProductStage>
        </AbsoluteFill>
      )}
      {/* 二 案卷：当事人条款换成代号 → 数据去向 */}
      {show2 && (
        <AbsoluteFill style={{ opacity: in2 }}>
          {toFlow < 0.999 && (
            <div style={{ position: "absolute", left: 0, top: 0, transformOrigin: "0 0", opacity: Math.min(1, paperIn * 1.3) * (1 - toFlow), transform: `translate(${1450 + (1 - paperIn) * 100}px, ${lerp(980, 470, paperIn)}px) scale(${1.62 + map(f2, [60, T.FLOW], [0, 0.05])}) translate(${-PAPER_W / 2}px, ${-(p1.y + 40)}px)` }}>
              <div style={{ transform: `perspective(1600px) rotateX(${(1 - paperIn) * 22}deg) rotateZ(${-1 + (1 - paperIn) * -3}deg)`, transformOrigin: "50% 30%", filter: "drop-shadow(0 40px 60px rgba(0,0,0,0.6))" }}>
                <HeroContract light={0.92} render={(r) => renderSwaps(r.id, r.t, f2)} rowStyle={(r) => (r.id && r.id.startsWith("p") ? undefined : { opacity: 0.35 })} />
                <div style={{ position: "absolute", left: 84, top: 26, fontFamily: FONT_TITLE, fontSize: 19, fontWeight: 600, letterSpacing: 1, display: "flex", gap: 10, alignItems: "center", padding: "5px 12px", borderRadius: 999, background: sent > 0.5 ? "rgba(23,131,255,0.1)" : "rgba(120,110,95,0.1)" }}>
                  <span style={{ width: 8, height: 8, borderRadius: 4, background: sent > 0.5 ? "#1783ff" : "#9d968a" }} />
                  <span style={{ position: "relative", color: "#5d5850" }}>
                    <span style={{ opacity: 1 - sent }}>本机原文</span>
                    <span style={{ position: "absolute", left: 0, whiteSpace: "nowrap", opacity: sent, color: "#0a66d1" }}>发出前，换成代号</span>
                  </span>
                </div>
              </div>
            </div>
          )}
          {toFlow > 0.001 && (
            <AbsoluteFill style={{ opacity: toFlow }}>
              <ProductStage cam={[cam(T.A2 + T.FLOW, 800, 480, 1.16, 1, -6, 270, 10), cam(T.A3, 800, 500, 1.24, 1, -5, 280, 0)]} drift={0.3}>
                <ProductWindow
                  name="d03-visibility"
                  edit={(root) => {
                    for (const el of root.querySelectorAll<HTMLElement>(".dfm-station small")) if (el.textContent?.includes("token")) el.style.filter = "blur(2.4px)";
                    for (const el of root.querySelectorAll<HTMLElement>(".dfm-station.dfm-model li, .dfm-station.dfm-model small")) if (el.textContent?.includes("待签署")) el.style.filter = "blur(2.4px)";
                  }}
                  focus={{ x: 360, y: 360, w: 960, h: 480, r: 14 }}
                  blur={3}
                  dim={0.45}
                />
              </ProductStage>
            </AbsoluteFill>
          )}
        </AbsoluteFill>
      )}
      {/* 三 负责：复核签发——把真实界面的签发区裁成一张被光照亮的卡（不露窗口硬边），确认框居中放大 */}
      {show3 && (
        <AbsoluteFill style={{ opacity: in3 }}>
          {(() => {
            const SC = 2.05;
            const R = { x: 985, y: 734, w: 402, h: 150 };
            const cardB = prog(f3, T.TOP, 30, easeInOut);
            const cardIn = prog(f3, 158, 32, easeOut);
            // 交稿前的独立复核（真实执行页时间线原文），与签发卡同款的受光卡；先独自停约 2.6 秒，退场后签发卡才进
            const revIn = prog(f3, 2, 34, easeOut) * (1 - prog(f3, 140, 24, easeInOut));
            const cx = 880;
            const cy = 300;
            const settle = map(f3, [T.C_SIGN, T.C_SIGN + 10, T.C_SIGN + 50], [0, 1, 0]);
            return (
              <>
                {revIn > 0.002 && (
                  <div style={{ position: "absolute", left: cx, top: cy + 60 + (1 - revIn) * 24, opacity: revIn, borderRadius: 16, overflow: "hidden", boxShadow: "0 40px 100px -30px rgba(0,0,0,0.9), 0 0 0 1px rgba(255,255,255,0.08)" }}>
                    <SnapCrop name="r2010" rect={{ x: 76, y: 484, w: 540, h: 68 }} scale={1.85} radius={16} />
                    <Spot rect={{ x: 6, y: (518 - 484) * 1.85, w: 528 * 1.85, h: 30 * 1.85, r: 12 }} p={prog(f3, 16, 24)} />
                  </div>
                )}
                <div style={{ position: "absolute", left: cx, top: cy + (1 - cardIn) * 24 - cardB * 30, opacity: (1 - cardB) * cardIn, borderRadius: 16, boxShadow: `0 40px 100px -30px rgba(0,0,0,0.9), 0 0 0 1px rgba(255,255,255,0.08), 0 0 0 ${(6 * settle).toFixed(1)}px rgba(23,131,255,${(0.35 * settle).toFixed(2)}), 0 0 ${(60 * settle).toFixed(0)}px rgba(23,131,255,${(0.25 * settle).toFixed(2)})`, overflow: "hidden" }}>
                  <SnapCrop name={s3.name === "s20-signed-top" ? "s15-signed" : s3.name} rect={R} scale={SC} edit={s3Edit} radius={16} />
                  {/* 卡片上缘轻轻淡出（上方清单不进入可读焦点） */}
                  <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: 36, background: "linear-gradient(180deg, rgba(255,255,255,1), rgba(255,255,255,0))" }} />
                  <Cursor keys={[{ f: T.A3 + 180, x: 330, y: 260 }, { f: T.A3 + 204, x: (1012 - R.x) * SC, y: (763 - R.y) * SC }, { f: T.A3 + T.C_SIGN - 8, x: (1117 - R.x) * SC, y: (853 - R.y) * SC }, { f: T.A3 + T.C_SIGN + 40, x: 700, y: 280 }]} clicks={[T.A3 + 214, T.A3 + T.C_SIGN]} show={[T.A3 + 182, T.A3 + T.C_SIGN + 50]} />
                </div>
                {cardB > 0.001 && (
                  <div style={{ position: "absolute", left: cx, top: cy + 60 + (1 - cardB) * 24, opacity: cardB, borderRadius: 16, overflow: "hidden", boxShadow: "0 40px 100px -30px rgba(0,0,0,0.9), 0 0 0 1px rgba(255,255,255,0.08)" }}>
                    <SnapCrop name="s20-signed-top" rect={{ x: 290, y: 118, w: 500, h: 104 }} scale={1.7} radius={16} />
                    <Spot rect={{ x: (512 - 290) * 1.7, y: (174 - 118) * 1.7, w: 92 * 1.7, h: 28 * 1.7, r: 12 }} p={prog(f3, T.TOP + 40, 24)} />
                  </div>
                )}
              </>
            );
          })()}
        </AbsoluteFill>
      )}
      <QA q={COPY.e1q} a={COPY.e1} sub={COPY.e1sub} at={T.A1 + 20} out={T.A2 - 24} />
      <QA q={COPY.e2q} a={COPY.e2} sub={COPY.e2sub} at={T.A2 + 20} out={T.A3 - 50} />
      <QA q={COPY.e3q} a={COPY.e3} sub={COPY.e3sub} at={T.A3 - 24} out={T.END} />
      <Vignette strength={0.5} dark />
      <Grain opacity={0.04} />
    </AbsoluteFill>
  );
}
export { easeOut };
