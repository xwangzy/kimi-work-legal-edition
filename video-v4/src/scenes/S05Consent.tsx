/**
 * S05 授权与代号（3.5 小节，504 帧）：
 *  A 开始前确认：“记录本案的客户授权”——选“委托合同中的 AI 条款”，写出处，点“记录授权并开始”；
 *  B “开始用 AI 之前”：三条说明依次点亮，点“我知道了，继续”；
 *  C 代号：窗口退到景深里，《股权转让协议》的当事人条款贴近镜头——姓名、证件号、电话依次换成
 *    模型实际收到的代号（取自本次真实任务的“数据去向”），蓝色扫光掠过替换处。
 */
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { FONT_SERIF, FONT_TITLE } from "../fonts";
import { cam, Cursor, easeCine, easeInOut, easeOut, Grain, lerp, map, prog, ProductStage, ProductWindow, Spot, StudioBackdrop, Title, typed, Vignette } from "../ui/film";
import { HERO_LAYOUT, HeroContract, PAPER_W, rowIndex } from "../ui/paper";
import { css, q } from "../ui/Snap";
import { pickX, typeInto } from "./common";
import { TOKENS } from "../real";

import { AUTH_SRC as SRC, CONSENT } from "../beats";
const { C_KIND, T_SRC, C_REC, T_NOTICE, C_GO, T_PAPER } = CONSENT;

/** 代号替换的三处（行 id、原文、代号、开始帧）。 */
const SWAPS = [
  { row: "p1", from: "张伟", to: TOKENS.name1, at: CONSENT.SWAPS[0] },
  { row: "p1b", from: "110101198203154517", to: TOKENS.id1, at: CONSENT.SWAPS[1] },
  { row: "p2", from: "李娜", to: TOKENS.name2, at: CONSENT.SWAPS[2] },
  { row: "p2b", from: "13910246688", to: TOKENS.phone2, at: CONSENT.SWAPS[3] },
];

export function S05Consent() {
  const f = useCurrentFrame();
  const { name: snap, prev, mix } = pickX(f, [
    [-1, "h04-start-chips"],
    [0, "a01-confirm"],
    [C_KIND, "a02-auth-picked"],
    [C_REC + 10, "a04-notice"],
  ] as [number, "h04-start-chips" | "a01-confirm" | "a02-auth-picked" | "a04-notice"][], 10);
  const [src] = typed(SRC, f, T_SRC, 14);
  const notice = prog(f, C_REC + 10, 26, easeOut);
  const edit = (root: HTMLElement, fr: number) => {
    if (snap === "a02-auth-picked") typeInto(root, ".modal input[aria-label='授权依据的出处']", src, fr, f < C_REC);
    if (root.dataset.snap === "a04-notice") {
      const ms = root.querySelectorAll<HTMLElement>(".modal");
      const top = ms[ms.length - 1];
      if (ms.length > 1) css(ms[0], { opacity: 0 }); // 片中只留一层弹窗：上一层确认框已经交代过
    }
    if (snap === "a04-notice") {
      const ms = root.querySelectorAll<HTMLElement>(".modal");
      const top = ms[ms.length - 1];
      css(top, { transform: `translateY(${(1 - notice) * 10}px) scale(${0.985 + 0.015 * notice})` });
    }
  };
  const toPaper = prog(f, T_PAPER - 20, 70, easeCine);
  const keys = [
    cam(0, 720, 560, 1.34, 1, -5, 300, 0),
    cam(C_KIND, 720, 600, 1.42, 1, -5, 300, 0),
    cam(C_REC, 760, 700, 1.38, 1, -5, 290, -10),
    cam(T_NOTICE + 20, 720, 420, 1.42, 1, -5, 300, 0),
    cam(C_GO, 760, 560, 1.4, 1, -5, 290, 0),
    cam(T_PAPER + 60, 760, 560, 1.1, 10, -10, 420, -200),
  ];
  // 依次点亮“开始用 AI 之前”的三条
  const items = [
    { x: 494, y: 322, w: 470, h: 50, at: CONSENT.ITEMS[0] },
    { x: 494, y: 380, w: 490, h: 78, at: CONSENT.ITEMS[1] },
    { x: 494, y: 462, w: 470, h: 50, at: CONSENT.ITEMS[2] },
  ];
  const spot = (i: number) => (snap === "a04-notice" ? prog(f, items[i].at, 18) * (1 - prog(f, (items[i + 1]?.at ?? C_GO - 10) + 4, 16)) : 0);

  // 纸面：当事人条款特写
  const paperIn = prog(f, T_PAPER - 10, 64, easeCine);
  const p1 = HERO_LAYOUT[rowIndex("p1")];
  const focusY = p1.y + 40;
  const PS = lerp(1.0, 1.72, paperIn) * (1 + map(f, [T_PAPER + 60, 504], [0, 0.04]));
  const sent = prog(f, CONSENT.SWAPS[3] + 24, 14); // 标签：本机原文 →（四处全部换完）→ 模型实际收到的内容
  const paperX = 1390 + (1 - paperIn) * 120;
  const paperY = lerp(1300, 520, paperIn);
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <StudioBackdrop cx={60} />
      <AbsoluteFill style={{ opacity: 1 - map(f, [T_PAPER - 20, T_PAPER + 50], [0, 0.85], easeInOut), filter: `blur(${(toPaper * 7).toFixed(2)}px)` }}>
        <ProductStage cam={keys}>
          <ProductWindow name={snap} prev={prev} mix={mix} edit={edit} overlay={<>{items.map((it, i) => <Spot key={i} rect={it} p={spot(i)} />)}</>} />
          <Cursor
            keys={[
              { f: 0, x: 1043, y: 830 },
              { f: C_KIND - 8, x: 600, y: 540 },
              { f: T_SRC - 6, x: 740, y: 612 },
              { f: C_REC - 8, x: 917, y: 815 },
              { f: C_GO - 10, x: 917, y: 638 },
            ]}
            clicks={[C_KIND, C_REC, C_GO]}
            show={[0, C_GO + 10]}
          />
        </ProductStage>
      </AbsoluteFill>
      {paperIn > 0.001 && (
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            transformOrigin: "0 0",
            transform: `translate(${paperX}px, ${paperY}px) scale(${PS}) translate(${-PAPER_W / 2}px, ${-focusY}px)`,
            opacity: Math.min(1, paperIn * 1.3),
          }}
        >
          <div style={{ transform: `perspective(1600px) rotateX(${(1 - paperIn) * 26}deg) rotateZ(${(1 - paperIn) * -3}deg)`, transformOrigin: "50% 30%" }}>
            <HeroContract light={1} render={(r) => renderSwaps(r.id, r.t, f)} />
            <div style={{ position: "absolute", left: 84, top: 26, fontFamily: FONT_TITLE, fontSize: 19, fontWeight: 600, letterSpacing: 1, display: "flex", gap: 10, alignItems: "center", padding: "5px 12px", borderRadius: 999, background: sent > 0.5 ? "rgba(23,131,255,0.1)" : "rgba(120,110,95,0.1)" }}>
              <span style={{ width: 8, height: 8, borderRadius: 4, background: sent > 0.5 ? "#1783ff" : "#9d968a" }} />
              <span style={{ position: "relative", color: "#5d5850" }}>
                <span style={{ opacity: 1 - sent }}>本机原文</span>
                <span style={{ position: "absolute", left: 0, whiteSpace: "nowrap", opacity: sent, color: "#0a66d1" }}>模型实际收到的内容</span>
              </span>
            </div>
          </div>
        </div>
      )}
      <Title eyebrow="01  交代" lines={["每个案子第一次用 AI，", "先记下客户授权的依据。"]} sub="记录随事项保存，写进事项日志。" at={14} out={T_PAPER - 36} x={128} y={380} width={700} size={62} />
      <Title eyebrow="01  交代" lines={["发出之前，", "先换成代号。"]} sub={<>姓名、证件号、电话换成代号再发出；<br />每次发出的内容都有记录。</>} at={T_PAPER + 14} out={446} x={128} y={380} width={600} size={72} scrim={false} />
      <Vignette strength={0.14} />
      <Grain opacity={0.03} />
    </AbsoluteFill>
  );
}

/** 行内替换：原文 → 代号（中间一道蓝色扫光）。 */
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
