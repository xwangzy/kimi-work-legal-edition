/**
 * 纸面上的修订：律师接受意见后，第 7.1 条在 Word 修订稿里的样子（红色删除线 + 绿色下划线插入）。
 * 文字逐字取自本次真实任务审查工作台“接受后”视图（w34-after-s3）里第 7.1 条的修订（模型给出的首选修改，律师已接受）。
 */
import type { CSSProperties } from "react";
import { staticFile } from "remotion";
import { FONT_SERIF, useGlyphs } from "../fonts";

export const C71 = {
  head: "第七条　违约责任",
  pre: "7.1　受让方",
  del: "逾期付款的，每日按应付未付金额的千分之五支付违约金",
  ins: "仅在转让方已满足相应付款条件且不存在违约或应抵扣款项的情况下承担付款义务。受让方逾期付款的，自转让方书面催告所定五个工作日宽限期届满次日起，按应付未付金额每日万分之三支付违约金，累计不超过应付未付金额的5%；因转让方违约、付款先决条件未成就或受让方行使抵扣权而暂缓付款的，不构成逾期",
  post: "。",
};

/**
 * strike：删除线进度 0→1；ins：插入文字进度 0→1（逐字出现）；w：纸宽。
 */
export function ClauseRedline({ strike, ins, w = 1100, style, glow = 0, clean = false, light = 1 }: { strike: number; ins: number; w?: number; style?: CSSProperties; glow?: number; clean?: boolean; light?: number }) {
  useGlyphs(C71.head + C71.pre + C71.del + C71.ins + C71.post);
  const chars = Array.from(C71.ins);
  const n = Math.round(chars.length * Math.max(0, Math.min(1, ins)));
  const shown = chars.slice(0, n).join("");
  const fs = 34;
  return (
    <div
      style={{
        width: w,
        padding: "70px 90px 90px",
        borderRadius: 4,
        backgroundColor: "#f7f3ec",
        filter: light < 1 ? `brightness(${light})` : undefined,
        backgroundImage: `linear-gradient(170deg, rgba(255,255,255,0.6) 0%, rgba(255,255,255,0) 50%, rgba(120,100,70,0.05) 100%), url(${staticFile("textures/paper.png")})`,
        backgroundSize: "100% 100%, 512px 512px",
        boxShadow: "0 50px 100px -30px rgba(40,30,20,0.35), 0 12px 30px -10px rgba(40,30,20,0.2)",
        color: "#25221d",
        fontFamily: FONT_SERIF,
        ...style,
      }}
    >
      <div style={{ fontSize: fs * 1.06, fontWeight: 700, marginBottom: 26 }}>{C71.head}</div>
      {clean ? (
        <p style={{ fontSize: fs, lineHeight: 1.9, margin: 0, textAlign: "justify" }}>
          {C71.pre}
          {C71.ins}
          {C71.post}
        </p>
      ) : (
      <p style={{ fontSize: fs, lineHeight: 1.9, margin: 0, textAlign: "justify" }}>
        {C71.pre}
        {Array.from(C71.del).map((c, i, a) => {
          const on = i < Math.round(a.length * Math.max(0, Math.min(1, strike)));
          return (
            <span key={i} style={on ? { color: "#c42b2b", textDecoration: "line-through", textDecorationColor: "#c42b2b", textDecorationThickness: 2.5 } : undefined}>
              {c}
            </span>
          );
        })}
        {n > 0 && (
          <span style={{ color: "#16794a", textDecoration: "underline", textDecorationColor: "#16794a", textUnderlineOffset: 7, textDecorationThickness: 2, background: glow > 0 ? `rgba(22,121,74,${0.06 * glow})` : undefined }}>
            {shown}
          </span>
        )}
        {n > 0 && n < chars.length && <span style={{ display: "inline-block", width: 2, height: "1.05em", background: "#16794a", verticalAlign: "-0.16em", marginLeft: 1 }} />}
        {C71.post}
      </p>
      )}
    </div>
  );
}
