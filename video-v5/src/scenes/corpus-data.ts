/**
 * 第一幕“法条星海”的数据：全部取自产品随包法规库（platform/content/lawdb/sources/laws.json，第 71 批 55d75f32，
 * 仅 official-text-collected-* 来源的现行有效版本）的官方公布文本。法律条文不受著作权保护。
 * corpus.json 是按固定种子抽样的 1,400 条；hero.json 是指定条文（民法典第一条等）。
 */
import corpus from "../data/corpus.json";
import hero from "../data/hero.json";
import { rand } from "../ui/film";

export const FS = 30; // 世界里正文字号（px）
export const LH = 57; // 行高
export const HERO_COLS = 35;

const CN = "零一二三四五六七八九";
export function cnNum(n: number): string {
  if (n < 10) return CN[n];
  if (n < 20) return "十" + (n % 10 ? CN[n % 10] : "");
  if (n < 100) return CN[Math.floor(n / 10)] + "十" + (n % 10 ? CN[n % 10] : "");
  if (n < 1000) {
    const h = Math.floor(n / 100);
    const r = n % 100;
    return CN[h] + "百" + (r === 0 ? "" : r < 10 ? "零" + CN[r] : r < 20 ? "一十" + (r % 10 ? CN[r % 10] : "") : cnNum(r));
  }
  const t = Math.floor(n / 1000);
  const r = n % 1000;
  return CN[t] + "千" + (r === 0 ? "" : r < 100 ? "零" + cnNum(r) : cnNum(r));
}

/** 按每行 cols 个字硬折行（中文全角字等宽，便于按字定位）。 */
export function wrap(text: string, cols: number): string[] {
  const ch = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < ch.length; i += cols) out.push(ch.slice(i, i + cols).join(""));
  return out;
}

export interface Block {
  id: number;
  x: number;
  y: number;
  d: number;
  cols: number;
  title: string;
  lines: { t: string; head?: boolean }[];
  tone: number; // 亮度系数
}

function articleLines(head: string, text: string, cols: number) {
  return wrap(`${head}　${text}`, cols).map((t, i) => ({ t, head: i === 0 }));
}

/** 主角：民法典第一条起（第 0 行第 32、33 字是“秩序”）。 */
export const HERO: Block = (() => {
  const lines: Block["lines"] = [];
  for (const a of hero.civil.filter((a) => a.no <= 6)) lines.push(...articleLines(`第${cnNum(a.no)}条`, a.text, HERO_COLS));
  return { id: 0, x: 0, y: 0, d: 0, cols: HERO_COLS, title: "中华人民共和国民法典", lines, tone: 1 };
})();
export const ZHIXU = { x: 32 * FS + FS, y: LH / 2 }; // “秩序”两字的中心（块内坐标）

/** 潜入目标：民法典第五百八十五条（违约金），与第二幕桌上合同第 7.1 条“违约金”匹配。 */
export const TARGET: Block = (() => {
  const a = hero.civil.find((x) => x.no === 585)!;
  const b = hero.civil.find((x) => x.no === 584)!;
  return { id: 999, x: 1350, y: 260, d: 7600, cols: 26, title: "中华人民共和国民法典", lines: [...articleLines(`第${cnNum(584)}条`, b.text, 26), ...articleLines(`第${cnNum(585)}条`, a.text, 26)], tone: 1 };
})();
/** 目标行：第五百八十五条首行（块内行号）。 */
export const TARGET_ROW = TARGET.lines.findIndex((l) => l.t.startsWith("第五百八十五条"));

/** 阅读块：蓝点逐行读过的那一块。 */
export const READ_ID = 7;

export const BLOCKS: Block[] = (() => {
  const list = corpus as { l: string; h: string; t: string }[];
  const out: Block[] = [];
  let k = 0;
  const N = 72;
  for (let i = 1; i <= N; i++) {
    const mid = i > 44; // 中景：位于主角与后拉终点之间，后拉时从画面边缘进入
    const cols = mid ? 24 + Math.floor(rand(i * 3.1) * 14) : 22 + Math.floor(rand(i * 3.1) * 12);
    const lines: Block["lines"] = [];
    const law = list[k].l;
    while (lines.length < 8 + Math.floor(rand(i * 5.7) * 8) && k < list.length) {
      const a = list[k++];
      lines.push(...articleLines(a.h, a.t, cols));
    }
    let x: number, y: number, d: number;
    if (mid) {
      d = -2700 + rand(i * 7.3) * 2300;
      const ang = rand(i * 2.3) * Math.PI * 2;
      const r = 900 + rand(i * 4.1) * 2300;
      x = Math.cos(ang) * r * 1.35 - cols * FS * 0.5;
      y = Math.sin(ang) * r * 0.8 - 300;
    } else {
      d = 500 + Math.pow(rand(i * 1.7), 0.9) * 9500;
      const spread = 0.7 + d / 7000;
      x = (rand(i * 2.3) - 0.5) * 5600 * spread - cols * FS * 0.5;
      y = (rand(i * 4.1) - 0.5) * 3000 * spread - 300;
    }
    out.push({ id: i, x, y, d, cols, title: law, lines: lines.slice(0, 16), tone: 0.7 + rand(i * 9.9) * 0.3 });
  }
  // 阅读块：后拉终点画面左上的中景，蓝点在这里出场
  const r = out[READ_ID - 1];
  Object.assign(r, { x: -1250, y: -640, d: 900, tone: 1, cols: 28 });
  return out;
})();

export const blockW = (b: Block) => b.cols * FS;
export const blockH = (b: Block) => (b.lines.length + 1.4) * LH;
/** 块内字符中心 → 世界坐标。 */
export function charAt(b: Block, row: number, col: number) {
  return { x: b.x + col * FS + FS / 2, y: b.y + 1.4 * LH + row * LH + LH / 2, d: b.d };
}
