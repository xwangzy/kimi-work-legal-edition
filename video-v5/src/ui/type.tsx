/**
 * V5 的两种“声音”：
 *  - Manifesto（时代之声）：思源宋体，居中，逐字“晕开”显影（透明度 + 轻微模糊 + 上浮），整句一起退场。
 *  - 产品之声沿用 film.tsx 的 Title / LowerThird（思源黑体，左对齐两行大字，自遮罩升起）。
 * 所有动画按“当前帧写全状态”。时间单位：帧。
 */
import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { FONT_LATIN, FONT_SERIF, FONT_TITLE, useGlyphs } from "../fonts";
import { easeIn, easeInOut, easeOut, KimiDot, prog } from "./film";

export const PAPER_INK = "#1d1a16";
export const NIGHT_INK = "#efeae1";

/** 一段文字：text + 相对整句开始的延迟（帧），用于“三个动词一拍一个”。 */
export interface Seg {
  t: string;
  d?: number;
  style?: CSSProperties;
}

/**
 * 宣言句：lines 是若干行，每行是字符串或若干段 Seg。
 * at：开始帧；out：退场帧；cps：逐字显影速度（字/秒）；size：字号。
 */
export function Manifesto({
  lines,
  at,
  out,
  x = 960,
  y = 540,
  size = 58,
  dark = true,
  cps = 22,
  weight = 600,
  lineGap = 1.62,
  color,
  scrim = 0,
  align = "center",
  tracking = 0.06,
}: {
  lines: readonly (string | readonly Seg[])[];
  at: number;
  out?: number;
  x?: number;
  y?: number;
  size?: number;
  dark?: boolean;
  cps?: number;
  weight?: number;
  lineGap?: number;
  color?: string;
  scrim?: number;
  align?: "center" | "left";
  tracking?: number;
}) {
  const f = useCurrentFrame();
  const all = lines.map((l) => (typeof l === "string" ? l : l.map((s) => s.t).join(""))).join("");
  useGlyphs(all);
  if (f < at - 40 || (out !== undefined && f > out + 60)) return null;
  const ink = color ?? (dark ? NIGHT_INK : PAPER_INK);
  const exit = out === undefined ? 0 : prog(f, out, 40, easeIn);
  const scrimO = scrim * Math.min(prog(f, at - 30, 40, easeInOut), out === undefined ? 1 : 1 - prog(f, out + 10, 40, easeInOut));
  let idx = 0;
  const perChar = 60 / cps;
  return (
    <>
      {scrimO > 0.002 && (
        <AbsoluteFill
          style={{
            pointerEvents: "none",
            opacity: scrimO,
            background: dark
              ? `radial-gradient(46% ${Math.max(30, lines.length * 13)}% at ${((align === "left" ? x + 330 : x) / 1920) * 100}% ${(y / 1080) * 100}%, rgba(7,8,10,0.86) 0%, rgba(7,8,10,0.55) 55%, rgba(7,8,10,0) 100%)`
              : `radial-gradient(46% ${Math.max(30, lines.length * 13)}% at ${((align === "left" ? x + 330 : x) / 1920) * 100}% ${(y / 1080) * 100}%, rgba(246,244,240,0.9) 0%, rgba(246,244,240,0.5) 55%, rgba(246,244,240,0) 100%)`,
          }}
        />
      )}
      <div
        style={{
          position: "absolute",
          left: align === "center" ? x - 900 : x,
          width: 1800,
          top: y - (lines.length * size * lineGap) / 2,
          textAlign: align,
          fontFamily: FONT_SERIF,
          fontSize: size,
          fontWeight: weight,
          lineHeight: lineGap,
          letterSpacing: `${tracking}em`,
          color: ink,
          opacity: 1 - exit,
          transform: `translateY(${-exit * 14}px)`,
          filter: exit > 0.01 ? `blur(${exit * 6}px)` : undefined,
          whiteSpace: "nowrap",
        }}
      >
        {lines.map((l, li) => {
          const segs: readonly Seg[] = typeof l === "string" ? [{ t: l }] : l;
          return (
            <div key={li}>
              {segs.map((sg, si) => (
                <span key={si} style={sg.style}>
                  {(sg.t.match(/——|./gu) ?? []).map((ch, ci) => {
                    const start = at + (sg.d ?? 0) + idx * perChar;
                    idx++;
                    const p = prog(f, start, 34, easeOut);
                    return (
                      <span key={ci} style={{ display: "inline-block", opacity: p, transform: `translateY(${(1 - p) * 0.12}em)`, filter: p < 0.98 ? `blur(${(1 - p) * 7}px)` : undefined }}>
                        {ch === " " ? " " : ch}
                      </span>
                    );
                  })}
                </span>
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
}

/** 小号标签（Inter + 思源黑体，字距加宽）。 */
export function Eyebrow({ children, at, out, x, y, dark = true, align = "left", dot = true, size = 17 }: { children: ReactNode; at: number; out?: number; x: number; y: number; dark?: boolean; align?: "left" | "center"; dot?: boolean; size?: number }) {
  const f = useCurrentFrame();
  useGlyphs(typeof children === "string" ? children : "");
  const o = prog(f, at, 40) * (out === undefined ? 1 : 1 - prog(f, out, 30, easeIn));
  if (o <= 0.002) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: align === "center" ? x - 600 : x,
        width: align === "center" ? 1200 : undefined,
        top: y,
        display: "flex",
        justifyContent: align === "center" ? "center" : "flex-start",
        alignItems: "center",
        gap: 12,
        fontFamily: FONT_TITLE,
        fontSize: size,
        fontWeight: 500,
        letterSpacing: 3.4,
        color: dark ? "rgba(239,234,225,0.52)" : "#8b877f",
        opacity: o,
        transform: `translateY(${(1 - o) * 6}px)`,
      }}
    >
      {dot && <span style={{ width: 7, height: 7, borderRadius: 2, background: "#1783ff", display: "inline-block" }} />}
      <span>{children}</span>
    </div>
  );
}

/** 时间戳（深夜的小字）：Inter 300，等宽数字；from→to 可在 [t0,t1] 间滚动分钟。 */
export function Clock({ times, at, out, x = 1712, y = 980, dark = true }: { times: { f: number; t: string }[]; at: number; out: number; x?: number; y?: number; dark?: boolean }) {
  const f = useCurrentFrame();
  const o = prog(f, at, 40) * (1 - prog(f, out, 30, easeIn));
  if (o <= 0.002) return null;
  let cur = times[0];
  for (const t of times) if (f >= t.f) cur = t;
  const flip = times.reduce((m, t) => (f >= t.f && f < t.f + 16 ? 1 - (f - t.f) / 16 : m), 0);
  return (
    <div style={{ position: "absolute", left: x, top: y, fontFamily: FONT_LATIN, fontWeight: 300, fontSize: 28, letterSpacing: 2, fontVariantNumeric: "tabular-nums", color: dark ? "rgba(239,234,225,0.5)" : "rgba(29,26,22,0.45)", opacity: o * (1 - flip * 0.6) }}>
      {cur.t}
    </div>
  );
}

/** 一镜到底的说明字：左下，思源黑体，自遮罩中升起；底部柔光托字（浅色）。 */
export function Caption({ text, at, out, x = 128, y = 832, size = 52, dark = false }: { text: string; at: number; out: number; x?: number; y?: number; size?: number; dark?: boolean }) {
  const f = useCurrentFrame();
  useGlyphs(text);
  if (f < at - 30 || f > out + 50) return null;
  const p = prog(f, at, 46, easeOut);
  const e = prog(f, out, 28, easeIn);
  const scrim = Math.min(prog(f, at - 24, 36), 1 - prog(f, out + 8, 36));
  const c = dark ? "7,8,10" : "244,243,240";
  return (
    <>
      <AbsoluteFill style={{ pointerEvents: "none", opacity: scrim, background: `linear-gradient(180deg, rgba(${c},0) 50%, rgba(${c},0.86) 72%, rgba(${c},0.97) 100%)` }} />
      <div style={{ position: "absolute", left: x, top: y, fontFamily: FONT_TITLE, overflow: "hidden", paddingBottom: 8 }}>
        <div style={{ fontSize: size, fontWeight: 600, letterSpacing: 0.6, color: dark ? NIGHT_INK : "#0e1219", whiteSpace: "nowrap", transform: `translateY(${(1 - p) * 104 - e * 40}%)`, opacity: Math.min(1, p * 1.6) * (1 - e) }}>{text}</div>
      </div>
    </>
  );
}

/** 工作流细线：节点等距，进度 p（0..n-1）；当前节点是 Kimi 蓝点。 */
export function Rail({ labels, p, at, out, y = 1004, w = 760, dark = false }: { labels: readonly string[]; p: number; at: number; out: number; y?: number; w?: number; dark?: boolean }) {
  const f = useCurrentFrame();
  useGlyphs(labels.join(""));
  const o = prog(f, at, 50, easeInOut) * (1 - prog(f, out, 40, easeIn));
  if (o <= 0.002) return null;
  const n = labels.length;
  const x0 = 960 - w / 2;
  const step = w / (n - 1);
  const ink = dark ? "rgba(239,234,225,0.9)" : "#1d1a16";
  const faint = dark ? "rgba(239,234,225,0.22)" : "rgba(29,26,22,0.16)";
  const cx = x0 + Math.max(0, Math.min(n - 1, p)) * step;
  return (
    <div style={{ position: "absolute", left: 0, top: 0, width: 1920, height: 1080, opacity: o, pointerEvents: "none" }}>
      <div style={{ position: "absolute", left: x0, top: y, width: w, height: 1, background: faint }} />
      <div style={{ position: "absolute", left: x0, top: y, width: cx - x0, height: 1, background: ink, opacity: 0.55 }} />
      {labels.map((l, i) => {
        const lit = Math.max(0, Math.min(1, p - i + 1));
        return (
          <div key={i}>
            <div style={{ position: "absolute", left: x0 + i * step - 3, top: y - 3, width: 7, height: 7, borderRadius: 4, background: lit > 0.5 ? ink : faint }} />
            <div style={{ position: "absolute", left: x0 + i * step - 60, width: 120, top: y + 16, textAlign: "center", fontFamily: FONT_TITLE, fontSize: 21, letterSpacing: 4, color: ink, opacity: 0.32 + 0.6 * lit }}>{l}</div>
          </div>
        );
      })}
      <div style={{ position: "absolute", left: cx - 6, top: y - 6 }}>
        <KimiDot size={13} glow={0.8} />
      </div>
    </div>
  );
}
