/**
 * “设置 · 套餐与用量”专用的两个图（第 69 批 V43）：
 *   UsageRing  一道环：本期额度已用（实色）+ 进行中预留（浅色）；环上一道刻度标“本期时间走到哪”（第三轮改，原为内环）。额度弧没到刻度 = 节奏宽裕。
 *   DailyBars  本期每天一根柱（高度 = 当日计入额度占本人分母的比例），今天高亮，没用的日子画基线点，今天之后的日子画浅点；
 *              虚线 = 每天用多少恰好在期末用完。悬停或键盘聚焦一根柱，标题右侧的读数换成那一天。
 * 颜色、字号全部走样式表令牌（styles-usage.css），这里只给几何尺寸。
 */
import { useState } from "react";
import { fmtPct } from "../lib/firm-usage.ts";
import { dayReadout, type DayBar } from "../lib/personal-usage.ts";

const R_OUT = 64;
const C = 80;

export function UsageRing({ used, inFlight, elapsed, center, label }: { used: number; inFlight: number; elapsed: number | null; center: string; label: string }) {
  const u = Math.min(100, Math.max(0, used * 100));
  const f = Math.min(100 - u, Math.max(0, inFlight * 100));
  const e = elapsed === null ? null : Math.min(100, Math.max(0, elapsed * 100));
  const th = e === null ? 0 : (e / 100) * 2 * Math.PI - Math.PI / 2;
  return (
    <div className="pu-ring" role="img" aria-label={label}>
      <svg viewBox="0 0 160 160" aria-hidden="true">
        <circle className="pu-ring-track" cx={C} cy={C} r={R_OUT} />
        {f > 0.3 && <circle className="pu-ring-flight" cx={C} cy={C} r={R_OUT} pathLength={100} strokeDasharray={`${f} 100`} strokeDashoffset={-u} transform={`rotate(-90 ${C} ${C})`} />}
        {u > 0.3 && <circle className="pu-ring-used" cx={C} cy={C} r={R_OUT} pathLength={100} strokeDasharray={`${u} 100`} transform={`rotate(-90 ${C} ${C})`} />}
        {/* 第 69 批第三轮（独立评审 R2-3）：原来内环画“本期时间已过”，接近闭合时一眼像“用了 85%”。改为外环上的一道刻度：
            刻度在额度弧之前 = 节奏宽裕，额度弧越过刻度 = 偏快；不再要图例 */}
        {e !== null && e > 1 && e < 99 && <line className="pu-ring-now" x1={C + (R_OUT - 9) * Math.cos(th)} y1={C + (R_OUT - 9) * Math.sin(th)} x2={C + (R_OUT + 9) * Math.cos(th)} y2={C + (R_OUT + 9) * Math.sin(th)} />}
      </svg>
      <div className="pu-ring-center">
        <span className="pu-num">
          {center}
          <span className="pu-num-unit">%</span>
        </span>
        <span className="pu-num-k">已用</span>
      </div>
    </div>
  );
}

/** 横轴标签：1 日、8 日、15 日、22 日、29 日与最后一天，今天写“今天”；离今天两格以内的数字让开。 */
function axisLabel(b: DayBar, last: number, todayN: number | null): string {
  if (b.today) return "今天";
  if (todayN !== null && Math.abs(b.n - todayN) <= 2) return "";
  if (b.n === 1 || b.n === last || (b.n - 1) % 7 === 0) {
    if (b.n !== last && last - b.n <= 2) return "";
    return `${Number(b.day.slice(8))} 日`;
  }
  return "";
}

export function DailyBars({ bars, even, top, evenNote, emptyNote }: { bars: DayBar[]; even: number; top: number; evenNote: string; emptyNote: string | null }) {
  const [sel, setSel] = useState<string | null>(null);
  const today = bars.find((b) => b.today) ?? null;
  const lastUsed = [...bars].reverse().find((b) => b.requests > 0 && !b.future) ?? null;
  const fallback = today && today.requests > 0 ? today : (lastUsed ?? today ?? bars[bars.length - 1]!);
  const cur = bars.find((b) => b.day === sel) ?? fallback;
  const r = dayReadout(cur);
  const cols = { gridTemplateColumns: `repeat(${bars.length}, minmax(0, 1fr))` };
  const evenAt = Math.min(100, (even / top) * 100);
  return (
    <>
      <p className="pu-readout" aria-live="polite">
        <span className="pu-readout-when">{r.when}</span>
        <b>{r.pct}</b>
        <span>{r.calls}</span>
      </p>
      <div className={`pu-chart${bars.length <= 8 ? " is-week" : ""}`}>
        <div className="pu-even" style={{ bottom: `${evenAt}%` }} aria-hidden="true">
          <span>{fmtPct(even)} / 天</span>
        </div>
        <div className="pu-bars" style={cols} onMouseLeave={() => setSel(null)}>
          {bars.map((b) => {
            const used = b.requests > 0;
            const t = dayReadout(b);
            return (
              <button
                key={b.day}
                type="button"
                className={`pu-bar${b.today ? " is-today" : ""}${b.future ? " is-future" : ""}${used ? "" : " is-zero"}${cur.day === b.day && sel ? " is-sel" : ""}`}
                disabled={b.future}
                aria-label={`${t.when}：${t.pct}，${t.calls}`}
                onMouseEnter={() => !b.future && setSel(b.day)}
                onFocus={() => setSel(b.day)}
                onBlur={() => setSel(null)}
              >
                {used ? <span className="pu-bar-fill" style={{ height: `${Math.max(3, (b.ratio / top) * 100)}%` }} /> : <span className="pu-bar-dot" />}
              </button>
            );
          })}
        </div>
      </div>
      <div className="pu-axis" style={cols} aria-hidden="true">
        {bars.map((b) => (
          <span key={b.day} className={b.today ? "is-today" : ""}>
            {axisLabel(b, bars.length, today?.n ?? null)}
          </span>
        ))}
      </div>
      <p className="pu-chart-note">
        <i aria-hidden="true" />
        {evenNote}
        {emptyNote && <span className="pu-chart-empty">{emptyNote}</span>}
      </p>
    </>
  );
}
