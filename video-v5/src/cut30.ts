/**
 * 30 秒品牌精简版剪辑表（60 fps，1800 帧）：一个问题 → 一个答案 → 一个品牌。
 * 每段取正片某场的一段（场景内帧 [a, b)），相邻两段交叠 XF 帧做溶解。配乐按同一剪辑点单独编配（make-music.mjs SCORE=cut30）。
 */
export const XF = 10;
export interface CutSeg {
  scene: "corpus" | "night" | "turn" | "home" | "onetake" | "answers" | "dawn" | "finale";
  a: number;
  b: number;
  note: string;
}
export const CUT30: CutSeg[] = [
  { scene: "corpus", a: 990, b: 1250, note: "光波扫过星海；“当智能可以读完一切，律师的时间，应该留给什么？”" },
  { scene: "turn", a: 380, b: 610, note: "三问：依据在哪里？谁来负责？案卷去了哪里？" },
  { scene: "turn", a: 610, b: 800, note: "“？”的点变成蓝点 → 暖白 → 标识成形" },
  { scene: "home", a: 0, b: 110, note: "Kimi Work 法律行业发行版 / 为法律而生的 AI 工作方式" },
  { scene: "onetake", a: 230, b: 360, note: "一句话交代，它建议用哪种方法" },
  { scene: "onetake", a: 440, b: 590, note: "该你拿主意的，它停下来问你" },
  { scene: "onetake", a: 750, b: 890, note: "风险指在第 7.1 条上" },
  { scene: "onetake", a: 985, b: 1135, note: "接受、修改、不采纳——由你决定" },
  { scene: "dawn", a: 940, b: 1180, note: "让智能承担繁复，把时间留给判断。" },
  { scene: "finale", a: 450, b: 740, note: "中软国际 × Kimi 联袂打造" },
];
/** 各段在 30 秒版里的起点（帧）。 */
export const CUT30_STARTS = (() => {
  const out: number[] = [];
  let t = 0;
  for (const s of CUT30) {
    out.push(t);
    t += s.b - s.a - XF;
  }
  return out;
})();
export const CUT30_DURATION = CUT30_STARTS[CUT30_STARTS.length - 1] + (CUT30[CUT30.length - 1].b - CUT30[CUT30.length - 1].a);
