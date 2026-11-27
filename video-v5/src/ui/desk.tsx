/**
 * 深夜的桌面（第二幕、第六幕共用）：近黑桌面 + 台灯光池；纸张平放在桌上。
 * 通用工具窗口（ToolWin）是中性的示意窗口，不仿任何真实品牌，内容是本案的材料与检索。
 */
import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill } from "remotion";
import { FONT_LATIN, FONT_SERIF, FONT_TITLE, useGlyphs } from "../fonts";

export const DESK_W = 4200;
export const DESK_H = 2800;

/** 桌面：深色木纹的近似（极淡的横向纹理）+ 台灯光池（lamp 0..1）+ 晨光（day 0..1，从左上斜照）。 */
export function DeskSurface({ lamp = 1, day = 0, lx = 2100, ly = 1250 }: { lamp?: number; day?: number; lx?: number; ly?: number }) {
  return (
    <div style={{ position: "absolute", left: 0, top: 0, width: DESK_W, height: DESK_H, background: "#0b0a09", overflow: "hidden" }}>
      <div style={{ position: "absolute", inset: 0, opacity: 0.5, background: "repeating-linear-gradient(176deg, rgba(255,240,220,0.018) 0px, rgba(255,240,220,0.0) 6px, rgba(0,0,0,0.05) 13px, rgba(255,240,220,0.012) 21px)" }} />
      <div style={{ position: "absolute", inset: 0, opacity: lamp, background: `radial-gradient(1300px 1000px at ${lx}px ${ly}px, rgba(255,214,160,0.34) 0%, rgba(255,200,140,0.16) 34%, rgba(255,190,130,0.05) 62%, rgba(0,0,0,0) 80%)` }} />
      {/* 晨光：暖色、从左上斜照；桌面被照亮成温暖的木色，右下仍有阴影 */}
      <div style={{ position: "absolute", inset: 0, opacity: day, background: "linear-gradient(128deg, rgba(255,232,196,0.62) 0%, rgba(214,178,132,0.42) 34%, rgba(120,92,64,0.3) 66%, rgba(40,30,22,0.2) 100%)" }} />
      <div style={{ position: "absolute", inset: 0, opacity: day, background: `radial-gradient(1600px 1100px at ${lx - 500}px ${ly - 300}px, rgba(255,240,214,0.32) 0%, rgba(255,240,214,0) 70%)` }} />
    </div>
  );
}

/** 法律意见书（空白页，等待落笔）——第二幕“寂静”与“三问”共用。 */
export const OPINION_W = 820;
export const OPINION_H = Math.round(820 * 1.414);
export function OpinionPage({ children, style, caret = false }: { children?: ReactNode; style?: CSSProperties; caret?: boolean }) {
  useGlyphs("法律意见书致：乙投资有限公司关于《股权转让协议》第七条的意见");
  return (
    <div style={{ position: "absolute", width: OPINION_W, height: OPINION_H, borderRadius: 3, background: "#f5f1e8", boxShadow: "0 50px 110px -30px rgba(0,0,0,0.8), 0 12px 30px -10px rgba(0,0,0,0.5)", color: "#25221d", ...style }}>
      <div style={{ position: "absolute", left: 92, right: 92, top: 96, textAlign: "center", fontFamily: FONT_SERIF, fontSize: 34, fontWeight: 700, letterSpacing: 6 }}>法律意见书</div>
      <div style={{ position: "absolute", left: 92, top: 176, fontFamily: FONT_SERIF, fontSize: 19, color: "#3a362f" }}>致：乙投资有限公司</div>
      <div style={{ position: "absolute", left: 92, top: 216, fontFamily: FONT_SERIF, fontSize: 19, color: "#3a362f" }}>关于《股权转让协议》第七条的意见</div>
      {caret && <div style={{ position: "absolute", left: 92, top: 278, width: 2, height: 26, background: "#25221d" }} />}
      {children}
    </div>
  );
}

/** 中性的工具窗口（示意，不仿真实品牌）。 */
export function ToolWin({ title, kind, lines = [], w = 520, h = 340, hl, style, active = 0 }: { title: string; kind: "doc" | "law" | "pdf" | "sheet" | "mail" | "search" | "note"; lines?: string[]; w?: number; h?: number; hl?: string; style?: CSSProperties; active?: number }) {
  useGlyphs(title + lines.join("") + (hl ?? ""));
  const serif = kind === "doc" || kind === "law" || kind === "pdf";
  return (
    <div
      style={{
        position: "absolute",
        width: w,
        height: h,
        borderRadius: 10,
        overflow: "hidden",
        background: kind === "pdf" ? "#e9e7e2" : "#f7f6f3",
        boxShadow: `0 0 0 1px rgba(0,0,0,0.25), 0 30px 70px -20px rgba(0,0,0,0.75), 0 0 0 ${2 * active}px rgba(255,255,255,${0.35 * active})`,
        ...style,
      }}
    >
      <div style={{ height: 34, background: "#e6e4df", display: "flex", alignItems: "center", gap: 8, padding: "0 14px", borderBottom: "1px solid #d6d3cc" }}>
        {[0, 1, 2].map((i) => (
          <span key={i} style={{ width: 10, height: 10, borderRadius: 5, background: "#c4c0b8" }} />
        ))}
        <span style={{ marginLeft: 10, fontFamily: FONT_TITLE, fontSize: 14, color: "#5d5a55", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</span>
      </div>
      {kind === "sheet" ? (
        <div style={{ padding: 0 }}>
          {Array.from({ length: 9 }).map((_, r) => (
            <div key={r} style={{ display: "flex", borderBottom: "1px solid #dedbd4" }}>
              {Array.from({ length: 5 }).map((__, c) => (
                <div key={c} style={{ width: w / 5, height: 30, borderRight: "1px solid #dedbd4", fontFamily: FONT_LATIN, fontSize: 13, color: "#55524c", padding: "6px 8px", boxSizing: "border-box", whiteSpace: "nowrap", overflow: "hidden" }}>
                  {lines[r * 5 + c] ?? ""}
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div style={{ padding: kind === "pdf" ? "22px 40px" : "18px 22px", fontFamily: serif ? FONT_SERIF : FONT_TITLE, fontSize: serif ? 16 : 15, lineHeight: 1.85, color: "#2d2a25", background: kind === "pdf" ? "#fbfaf7" : undefined, margin: kind === "pdf" ? "14px 26px" : 0, boxShadow: kind === "pdf" ? "0 2px 8px rgba(0,0,0,0.12)" : undefined }}>
          {lines.map((l, i) => {
            if (hl && l.includes(hl)) {
              const [a, b] = l.split(hl);
              return (
                <div key={i} style={{ whiteSpace: "nowrap", overflow: "hidden" }}>
                  {a}
                  <span style={{ background: "rgba(23,131,255,0.22)", borderRadius: 2 }}>{hl}</span>
                  {b}
                </div>
              );
            }
            return (
              <div key={i} style={{ whiteSpace: "nowrap", overflow: "hidden", color: kind === "search" && i % 3 === 0 ? "#1d1a16" : undefined, fontWeight: kind === "search" && i % 3 === 0 ? 600 : 400 }}>
                {l}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** 夜色里的柔和暗角 + 暖光托底。 */
export function NightAir({ warm = 1 }: { warm?: number }) {
  return <AbsoluteFill style={{ pointerEvents: "none", background: `radial-gradient(80% 70% at 50% 55%, rgba(0,0,0,0) 40%, rgba(0,0,0,${0.55 * warm}) 100%)` }} />;
}

/** 钢笔（平放在桌上，俯视）：深色漆面笔杆 + 金色笔夹与环；capped=false 时露出笔尖。L 为长度（桌面坐标 px）。 */
export function Pen({ L = 520, capped = true, style }: { L?: number; capped?: boolean; style?: CSSProperties }) {
  const W = L * 0.075;
  return (
    <svg width={L} height={W * 2.2} viewBox={`0 0 ${L} ${W * 2.2}`} style={{ position: "absolute", overflow: "visible", filter: "drop-shadow(0 10px 10px rgba(0,0,0,0.55)) drop-shadow(0 2px 2px rgba(0,0,0,0.5))", ...style }}>
      <defs>
        <linearGradient id="penBody" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3a3d44" />
          <stop offset="0.28" stopColor="#8d929c" />
          <stop offset="0.42" stopColor="#23262c" />
          <stop offset="1" stopColor="#0c0d10" />
        </linearGradient>
        <linearGradient id="penGold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8a6a32" />
          <stop offset="0.35" stopColor="#f1d79a" />
          <stop offset="0.6" stopColor="#a8823e" />
          <stop offset="1" stopColor="#5b4320" />
        </linearGradient>
      </defs>
      <g transform={`translate(0 ${W * 0.6})`}>
        {/* 笔杆 */}
        <rect x={capped ? 0 : L * 0.1} y={0} width={capped ? L : L * 0.9} height={W} rx={W / 2} fill="url(#penBody)" />
        {!capped && (
          <>
            <path d={`M ${L * 0.1} ${W * 0.12} L ${L * 0.02} ${W * 0.42} L 0 ${W * 0.5} L ${L * 0.02} ${W * 0.58} L ${L * 0.1} ${W * 0.88} Z`} fill="url(#penGold)" />
            <line x1={L * 0.005} y1={W * 0.5} x2={L * 0.07} y2={W * 0.5} stroke="#3b2a10" strokeWidth={0.8} />
          </>
        )}
        {/* 金环与笔夹 */}
        <rect x={L * (capped ? 0.42 : 0.46)} y={0} width={L * 0.02} height={W} fill="url(#penGold)" />
        {capped && <rect x={L * 0.06} y={W * 0.36} width={L * 0.34} height={W * 0.28} rx={W * 0.14} fill="url(#penGold)" />}
        <ellipse cx={L - W * 0.3} cy={W / 2} rx={W * 0.32} ry={W * 0.46} fill="#15171b" />
      </g>
    </svg>
  );
}

/** 荧光笔（平放）。 */
export function Highlighter({ L = 360, style }: { L?: number; style?: CSSProperties }) {
  const W = L * 0.1;
  return (
    <svg width={L} height={W * 2} viewBox={`0 0 ${L} ${W * 2}`} style={{ position: "absolute", overflow: "visible", filter: "drop-shadow(0 8px 8px rgba(0,0,0,0.5))", ...style }}>
      <defs>
        <linearGradient id="hlBody" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#d9d5c8" />
          <stop offset="0.3" stopColor="#ffffff" />
          <stop offset="1" stopColor="#9d998e" />
        </linearGradient>
        <linearGradient id="hlCap" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#c9a417" />
          <stop offset="0.3" stopColor="#ffe25a" />
          <stop offset="1" stopColor="#9b7d0c" />
        </linearGradient>
      </defs>
      <g transform={`translate(0 ${W * 0.5})`}>
        <rect x={L * 0.3} y={0} width={L * 0.7} height={W} rx={W * 0.3} fill="url(#hlBody)" />
        <rect x={0} y={-W * 0.06} width={L * 0.34} height={W * 1.12} rx={W * 0.32} fill="url(#hlCap)" />
      </g>
    </svg>
  );
}

/** 晨光透过窗格落在桌面上的光斑：2×3 窗格（窗框留暗缝），斜投、柔边，暖金色。p 为强度。 */
export function WindowLight({ p, x, y, w = 2200, h = 1500, rot = -24, skew = -22 }: { p: number; x: number; y: number; w?: number; h?: number; rot?: number; skew?: number }) {
  if (p <= 0.002) return null;
  const cols = 3;
  const rows = 2;
  const gap = 46;
  const pw = (w - gap * (cols - 1)) / cols;
  const ph = (h - gap * (rows - 1)) / rows;
  return (
    <div style={{ position: "absolute", left: x, top: y, width: w, height: h, transform: `rotate(${rot}deg) skewX(${skew}deg)`, transformOrigin: "50% 50%", opacity: p, mixBlendMode: "screen", filter: "blur(26px)" }}>
      {Array.from({ length: cols * rows }).map((_, i) => (
        <div key={i} style={{ position: "absolute", left: (i % cols) * (pw + gap), top: Math.floor(i / cols) * (ph + gap), width: pw, height: ph, background: "linear-gradient(135deg, rgba(255,226,170,0.55), rgba(255,236,196,0.32))" }} />
      ))}
    </div>
  );
}
