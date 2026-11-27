/**
 * 第二幕 · 痛点（21.7 秒）
 * D 台灯（0–520）：匹配剪辑——第一幕潜入的“违约金”成为桌上合同第 7.1 条的“违约金”；由虚到实，后拉成俯视桌面：
 *   台灯光池、荧光笔一行行划过、纸张一张张压上来；23:47。“一份法律意见的背后，是成百上千页的阅读、检索与核对。”
 * E 碎片（520–900）：桌面上方浮起十个工具窗口，焦点在其间跳来跳去，同一句“千分之五”被反复复制；00:36 → 01:12。
 *   “信息散落在十几个窗口之间，上下文，一次次被打断。”
 * F 寂静（900–1300）：所有窗口同时熄灭，只剩台灯下一页空白的法律意见书与闪烁的光标；02:08。
 *   “真正需要判断的时候，往往只剩下最疲惫的时间。”
 */
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { COPY } from "../copy";
import { NIGHT as T } from "../beats";
import { cam, Cursor, easeCine, easeIn, easeInOut, easeOut, Grain, lerp, map, prog, ProductStage, rand, Title } from "../ui/film";
import { HERO_LAYOUT, HERO_ROWS, HeroContract, PAPER_W, PAPERS, Paper, rowCenter, rowIndex } from "../ui/paper";
import { DESK_H, DESK_W, DeskSurface, Highlighter, NightAir, OpinionPage, OPINION_H, OPINION_W, Pen, ToolWin } from "../ui/desk";
import { Clock, Manifesto } from "../ui/type";

const PX = DESK_W / 2 - PAPER_W / 2; // 主纸在桌上的位置：第 7.1 条落在桌面中心
const PY = DESK_H / 2 - rowCenter("c71");
const C71_END_X = PX + 86 + 30.5 * 17; // “违约金”
const MARKS: { row: string; at: number }[] = [
  { row: "c32", at: 120 },
  { row: "c71", at: 175 },
];
const EXTRA_MARKS = [9, 15, 20]; // 其他行号（2.1、4.1、6.1）

/** 第二幕结束时那页法律意见书在画面上的位置（第二幕尾与三问共用）。 */
export const PAGE_POS = { x: 1300, y: 560, s: 0.74, rot: -1.6 };
export function pageStyle(o = 1) {
  return { left: PAGE_POS.x - OPINION_W / 2, top: PAGE_POS.y - OPINION_H / 2, transform: `rotate(${PAGE_POS.rot}deg) scale(${PAGE_POS.s})`, opacity: o };
}

const WINS: { title: string; kind: "doc" | "law" | "pdf" | "sheet" | "mail" | "search" | "note"; lines: string[]; x: number; y: number; w: number; h: number; r: number }[] = [
  { title: "股权转让协议.docx", kind: "doc", x: 90, y: 120, w: 560, h: 360, r: -2, lines: ["第七条　违约责任", "7.1　受让方逾期付款的，每日按应付未付金额的", "千分之五支付违约金。", "7.2　转让方违反陈述与保证的，应赔偿受让方", "因此遭受的直接损失。", "第八条　保密"] },
  { title: "法规检索 · 违约金 调整", kind: "search", x: 700, y: 70, w: 520, h: 330, r: 1.5, lines: ["民法典 第五百八十五条", "约定的违约金过分高于造成的损失的……", "", "合同编通则解释 第六十五条", "当事人主张约定的违约金过分高于……", "", "民法典 第五百八十四条"] },
  { title: "民事判决书.pdf", kind: "pdf", x: 1290, y: 150, w: 540, h: 400, r: 2.5, lines: ["本院认为，本案的争议焦点为：", "一、被告是否已履行协助办理股权变更登记的义务；", "二、原告逾期付款是否构成根本违约；", "三、约定的违约金是否过分高于造成的损失。", "关于第三项争议焦点……"] },
  { title: "付款测算.xlsx", kind: "sheet", x: 160, y: 540, w: 500, h: 300, r: 1, lines: ["期数", "应付", "已付", "逾期天数", "违约金", "1", "10,000,000", "0", "30", "千分之五", "", "", "", "", "", "合计"] },
  { title: "邮件：关于第七条违约金", kind: "mail", x: 760, y: 430, w: 500, h: 300, r: -1.5, lines: ["发件人：项目组", "主题：第七条违约金是否需要调整", "", "对方坚持每日千分之五，请评估风险，", "今晚给出修改建议。"] },
  { title: "会议纪要.docx", kind: "doc", x: 1330, y: 600, w: 480, h: 320, r: -2.5, lines: ["一、交易结构：乙投资拟受让丙数据 60% 股权。", "二、待确认：其他股东是否放弃优先购买权。", "三、下一步：本周内完成协议审查。"] },
  { title: "笔记", kind: "note", x: 560, y: 760, w: 420, h: 250, r: 2, lines: ["7.1 千分之五 → 过高？", "查：585 条 / 通则解释 65 条", "对比：判决 违约金调整", "明早给客户"] },
  { title: "民法典 · 第五百八十五条", kind: "law", x: 1040, y: 800, w: 520, h: 230, r: -1, lines: ["当事人可以约定一方违约时应当根据违约情况", "向对方支付一定数额的违约金……"] },
  { title: "尽职调查清单.docx", kind: "doc", x: -40, y: 820, w: 460, h: 260, r: -3, lines: ["一、目标公司基本情况", "二、股权结构：出资凭证、股权质押", "三、重大合同：对外担保、借款合同"] },
  { title: "检索：千分之五 违约金", kind: "search", x: 1500, y: -20, w: 440, h: 250, r: 3, lines: ["相关结果 128 条", "", "（二审）违约金调整……", "", "（一审）逾期付款违约金……"] },
];

export function S2Night() {
  const f = useCurrentFrame();
  // ── D 台灯 ──
  const deskOn = 1 - prog(f, T.F_AT - 10, 40, easeInOut);
  const keys = [
    cam(0, C71_END_X - 34, DESK_H / 2, 2.4, 1, 0, 0, 0),
    cam(80, C71_END_X - 60, DESK_H / 2, 2.0, 2, 0, 300, 0),
    cam(T.D_PULL, DESK_W / 2 + 40, DESK_H / 2 - 60, 0.62, 34, 0, 420, 40),
    cam(T.E_AT, DESK_W / 2 + 160, DESK_H / 2 - 40, 0.56, 38, 0, 260, 40),
    cam(T.F_AT, DESK_W / 2 + 200, DESK_H / 2, 0.5, 44, 0, 280, 60),
  ];
  const focusIn = 1 - prog(f, 0, 80, easeInOut); // 开头由虚到实（接第一幕潜入的虚焦，匹配剪辑）
  const windowsOn = prog(f, T.E_AT, 30, easeInOut) * (1 - prog(f, T.F_AT, 10, easeIn));
  const deskDim = map(f, [T.E_AT, T.E_AT + 60], [0, 1], easeInOut);
  const papersIn = (i: number) => prog(f, T.PAPERS_AT + i * 34, 46, easeCine);
  const mark = (at: number) => prog(f, at, 34, easeInOut);
  // ── E 焦点跳动 ──
  const order = [0, 2, 1, 4, 6, 3, 7, 5, 9, 0];
  const jumpIdx = f < T.E_JUMP ? -1 : Math.floor((f - T.E_JUMP) / T.E_STEP) % order.length;
  const active = jumpIdx >= 0 ? order[jumpIdx] : -1;
  const pop = (i: number) => prog(f, T.E_AT + i * 20, 26, easeOut);
  const cx = (i: number) => WINS[i].x + WINS[i].w * 0.55;
  const cy = (i: number) => WINS[i].y + WINS[i].h * 0.55;
  const cursorKeys = order.map((w, j) => ({ f: T.E_JUMP + j * T.E_STEP - 8, x: cx(w) + (rand(j) - 0.5) * 80, y: cy(w) + (rand(j + 9) - 0.5) * 60 }));
  // ── F 寂静 ──
  const stillOn = prog(f, T.F_AT + 6, 50, easeInOut);
  return (
    <AbsoluteFill style={{ background: "#050505", overflow: "hidden" }}>
      {deskOn > 0.002 && (
        <AbsoluteFill style={{ opacity: deskOn, filter: `blur(${(focusIn * 9 + deskDim * 5).toFixed(2)}px) brightness(${1 - deskDim * 0.45})` }}>
          <ProductStage cam={keys} w={DESK_W} h={DESK_H} perspective={2400} drift={0.25}>
            <DeskSurface lx={DESK_W / 2 + 60} ly={DESK_H / 2 - 40} />
            {/* 主纸：第 7.1 条在桌面中心 */}
            <div style={{ position: "absolute", left: PX, top: PY, transform: "rotate(-1.2deg)" }}>
              <HeroContract light={0.95} />
              {[...MARKS.map((m) => ({ i: rowIndex(m.row), at: m.at })), ...EXTRA_MARKS.map((i, j) => ({ i, at: 230 + j * 40 }))].map(({ i, at }, j) => {
                const L = HERO_LAYOUT[i];
                const len = Math.min(560, Array.from(HERO_ROWS[i].t).length * 17 + 6);
                return <div key={j} style={{ position: "absolute", left: 82, top: L.y + 6, height: L.h - 12, width: len * mark(at), background: "rgba(250,208,70,0.42)", mixBlendMode: "multiply", borderRadius: 2 }} />;
              })}
            </div>
            {/* 人的痕迹：打开的钢笔、荧光笔 */}
            <Pen L={500} capped={false} style={{ left: PX + PAPER_W + 60, top: PY + 520, transform: "rotate(-62deg)", transformOrigin: "0 50%" }} />
            <Highlighter L={340} style={{ left: PX + PAPER_W + 150, top: PY + 760, transform: "rotate(-18deg)" }} />
            {/* 压上来的纸 */}
            {PAPERS.slice(0, 6).map((doc, i) => {
              const p = papersIn(i);
              if (p <= 0.001) return null;
              const ang = [-14, 9, -6, 16, -20, 4][i];
              const ox = [980, 820, 560, 700, 1240, 340][i];
              const oy = [-260, -380, 460, 380, 80, -640][i];
              return (
                <div key={i} style={{ position: "absolute", left: PX + ox + (1 - p) * Math.sign(ox) * 900, top: PY + oy + (1 - p) * Math.sign(oy) * 500, transform: `rotate(${ang * (0.6 + 0.4 * p)}deg)`, opacity: Math.min(1, p * 1.5) }}>
                  <Paper doc={doc} light={0.8} />
                </div>
              );
            })}
          </ProductStage>
        </AbsoluteFill>
      )}
      {/* E 碎片窗口 */}
      {windowsOn > 0.002 && (
        <AbsoluteFill style={{ opacity: windowsOn, perspective: 2000 }}>
          {WINS.map((w, i) => {
            const p = pop(i);
            if (p <= 0.001) return null;
            const act = i === active ? 1 : 0;
            const actP = act ? prog(f, T.E_JUMP + jumpIdx * T.E_STEP, 10, easeOut) : 0;
            // 焦点在窗口间跳动：亮起与暗下各用 6 帧过渡（保留急促感，但不出现单帧硬跳）
            const prevIdx = jumpIdx > 0 ? order[jumpIdx - 1] : -1;
            const fadeOutPrev = i === prevIdx && i !== active ? 1 - prog(f, T.E_JUMP + jumpIdx * T.E_STEP, 9, easeInOut) : 0;
            const base = 0.9 - 0.4 * prog(f, T.E_JUMP - 14, 22, easeInOut); // 进入跳动前，所有窗口先一起暗下去（不再单帧突变）
            const lit = active < 0 ? base : base + (1.02 - base) * Math.max(act ? prog(f, T.E_JUMP + jumpIdx * T.E_STEP, 9, easeInOut) : 0, fadeOutPrev);
            return (
              <div key={i} style={{ position: "absolute", left: w.x, top: w.y, transform: `rotate(${w.r}deg) scale(${(0.9 + 0.1 * p) * (1 + 0.035 * actP)}) translateY(${(1 - p) * 24}px)`, opacity: Math.min(1, p * 1.4), filter: `brightness(${lit.toFixed(3)})${i % 3 === 2 && !act ? " blur(1.6px)" : ""}`, zIndex: act ? 20 : i }}>
                <ToolWin title={w.title} kind={w.kind} lines={w.lines} w={w.w} h={w.h} hl="千分之五" active={actP} />
              </div>
            );
          })}
          <Cursor keys={cursorKeys} clicks={order.map((_, j) => T.E_JUMP + j * T.E_STEP)} show={[T.E_JUMP - 10, T.F_AT - 4]} />
        </AbsoluteFill>
      )}
      {/* F 寂静：台灯 + 一页空白的法律意见书 */}
      {stillOn > 0.002 && (
        <AbsoluteFill style={{ opacity: stillOn }}>
          <AbsoluteFill style={{ background: `radial-gradient(900px 700px at ${PAGE_POS.x}px ${PAGE_POS.y + 40}px, rgba(255,208,150,0.2) 0%, rgba(255,196,140,0.07) 45%, rgba(0,0,0,0) 75%)` }} />
          <OpinionPage caret={Math.floor(f / 32) % 2 === 0} style={pageStyle()} />
        </AbsoluteFill>
      )}
      <NightAir />
      <Manifesto lines={COPY.b1} at={T.B1} out={T.B1_OUT} x={128} y={520} size={58} align="left" scrim={0.9} cps={16} />
      <Manifesto lines={COPY.b2} at={T.B2} out={T.B2_OUT} x={128} y={520} size={58} align="left" scrim={0.9} cps={16} />
      <Manifesto lines={COPY.b3} at={T.B3} out={T.B3_OUT} x={560} y={540} size={58} cps={14} />
      <Clock times={[{ f: 0, t: "23:47" }, { f: T.E_AT + 60, t: "00:36" }, { f: T.E_AT + 240, t: "01:12" }, { f: T.F_AT + 20, t: "02:08" }]} at={40} out={1290} />
      <Grain opacity={0.05} />

    </AbsoluteFill>
  );
}
export { lerp };
