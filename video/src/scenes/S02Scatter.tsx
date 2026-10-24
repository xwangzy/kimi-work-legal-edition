/** S2 · 分散：一个个互不相通的工具窗口随节拍弹出，注意力在其间来回切换。 */
import type { ReactNode } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { BEAT } from "../timeline";
import { easeInOut, map, prog, rand, spr } from "../lib/anim";
import { FONT_DOC, FONT_UI, Headline, NightBackdrop, Vignette } from "../ui/film";

const TOOLS: { name: string; body: "doc" | "table" | "mail" | "list" | "law" | "cal" }[] = [
  { name: "法规数据库", body: "law" },
  { name: "文书编辑", body: "doc" },
  { name: "邮件", body: "mail" },
  { name: "表格", body: "table" },
  { name: "案例检索", body: "list" },
  { name: "会议纪要", body: "doc" },
  { name: "日程", body: "cal" },
  { name: "文件夹", body: "list" },
  { name: "修订对比", body: "doc" },
  { name: "利息计算", body: "table" },
  { name: "聊天记录", body: "mail" },
  { name: "证据目录", body: "table" },
];

function Lines({ n, w = 100 }: { n: number; w?: number }) {
  return (
    <>
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} style={{ height: 7, borderRadius: 3, background: "#d9dbdf", margin: "9px 0", width: `${w - ((i * 23) % 35)}%` }} />
      ))}
    </>
  );
}

function Body({ kind }: { kind: (typeof TOOLS)[number]["body"] }): ReactNode {
  if (kind === "table")
    return (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4 }}>
        {Array.from({ length: 24 }).map((_, i) => (
          <div key={i} style={{ height: 18, background: i < 4 ? "#cfd2d8" : "#e6e8eb", borderRadius: 2 }} />
        ))}
      </div>
    );
  if (kind === "mail")
    return (
      <>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 0", borderBottom: "1px solid #e4e6e9" }}>
            <div style={{ width: 20, height: 20, borderRadius: 99, background: "#cfd2d8" }} />
            <div style={{ flex: 1 }}>
              <div style={{ height: 6, width: "50%", background: "#cfd2d8", borderRadius: 3 }} />
              <div style={{ height: 6, width: "85%", background: "#e3e5e8", borderRadius: 3, marginTop: 5 }} />
            </div>
          </div>
        ))}
      </>
    );
  if (kind === "law")
    return (
      <div style={{ fontFamily: FONT_DOC, fontSize: 13, lineHeight: 1.8, color: "#5b5f66" }}>
        第五百八十五条　当事人可以约定一方违约时应当根据违约情况向对方支付一定数额的违约金……
        <Lines n={3} />
      </div>
    );
  if (kind === "cal")
    return (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
        {Array.from({ length: 28 }).map((_, i) => (
          <div key={i} style={{ height: 22, background: i === 17 ? "#c9ccd2" : "#eceef0", borderRadius: 3 }} />
        ))}
      </div>
    );
  if (kind === "list")
    return (
      <>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", padding: "5px 0" }}>
            <div style={{ width: 14, height: 16, borderRadius: 2, background: "#cfd2d8" }} />
            <div style={{ height: 6, flex: 1, maxWidth: `${60 + ((i * 17) % 35)}%`, background: "#e1e3e6", borderRadius: 3 }} />
          </div>
        ))}
      </>
    );
  return <Lines n={7} />;
}

export function ToolWindow({ name, body, w = 340, h = 230 }: { name: string; body: (typeof TOOLS)[number]["body"]; w?: number; h?: number }) {
  return (
    <div style={{ width: w, height: h, borderRadius: 10, overflow: "hidden", background: "#f4f5f6", boxShadow: "0 24px 60px -18px rgba(0,0,0,0.7)", fontFamily: FONT_UI }}>
      <div style={{ height: 30, display: "flex", alignItems: "center", gap: 6, padding: "0 10px", background: "#e7e9ec", borderBottom: "1px solid #dadde1" }}>
        {[0, 1, 2].map((i) => (
          <span key={i} style={{ width: 9, height: 9, borderRadius: 9, background: "#c4c7cc" }} />
        ))}
        <span style={{ marginLeft: 8, fontSize: 12, color: "#5f636b" }}>{name}</span>
      </div>
      <div style={{ padding: "12px 14px" }}>
        <Body kind={body} />
      </div>
    </div>
  );
}

/** 每个窗口的栅格位置（在 S3 里会被吸向中央）。 */
export const GRID = TOOLS.map((t, i) => {
  const col = i % 4;
  const row = Math.floor(i / 4);
  return {
    ...t,
    x: (col - 1.5) * 400 + (rand(i * 2.3) - 0.5) * 60,
    y: (row - 1) * 262 + (rand(i * 4.1) - 0.5) * 50 - 90,
    z: (rand(i * 9.7) - 0.5) * 300,
    rz: (rand(i * 1.7) - 0.5) * 6,
  };
});

/** 出场顺序与时间：前 8 个按拍，后 4 个按半拍（越来越密）。 */
export const APPEAR = [2, 4, 9, 0, 7, 11, 5, 1, 10, 3, 8, 6];
export function appearAt(k: number): number {
  return k < 8 ? 8 + k * BEAT : 8 + 8 * BEAT + (k - 8) * (BEAT / 2);
}

/** 当前“被切换到”的窗口：先按拍，最后一小节按 1/4 拍。 */
export function activeAt(f: number): number {
  const step = f < 128 ? BEAT : f < 160 ? BEAT / 2 : BEAT / 4;
  const base = f < 128 ? Math.floor(f / BEAT) : f < 160 ? 8 + Math.floor((f - 128) / step) : 12 + Math.floor((f - 160) / step);
  const order = APPEAR;
  const visible = order.filter((_, k) => appearAt(k) <= f);
  if (visible.length === 0) return -1;
  return visible[Math.floor(rand(base * 3.3) * visible.length)];
}

export function S02Scatter() {
  const f = useCurrentFrame();
  const ry = map(f, [0, 192], [-9, 7], easeInOut);
  const push = map(f, [0, 192], [-320, -40], easeInOut);
  const act = activeAt(f);
  return (
    <AbsoluteFill>
      <NightBackdrop glow={0.8} />
      <AbsoluteFill style={{ perspective: 1500, perspectiveOrigin: "50% 45%" }}>
        <div style={{ position: "absolute", left: 960, top: 520, transformStyle: "preserve-3d", transform: `translateZ(${push}px) rotateY(${ry}deg) rotateX(4deg)` }}>
          {GRID.map((g, i) => {
            const k = APPEAR.indexOf(i);
            const at = appearAt(k);
            const p = spr(f, at, 190, 20);
            if (f < at) return null;
            const isAct = i === act;
            const lift = isAct ? 1 : 0;
            return (
              <div
                key={i}
                style={{
                  position: "absolute",
                  left: -170,
                  top: -115,
                  transform: `translate3d(${g.x}px, ${g.y + (1 - p) * 40}px, ${g.z + lift * 90}px) rotateZ(${g.rz}deg) scale(${(0.85 + 0.15 * p) * (1 + lift * 0.05)})`,
                  opacity: Math.min(1, p * 1.6),
                  filter: `brightness(${isAct ? 1.02 : 0.42})`,
                }}
              >
                <ToolWindow name={g.name} body={g.body} />
                {isAct && <div style={{ position: "absolute", inset: -2, borderRadius: 12, boxShadow: "0 0 0 2px rgba(255,255,255,0.85)" }} />}
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
      <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(10,11,13,0) 60%, rgba(10,11,13,0.9) 100%)" }} />
      <Vignette strength={0.5} />
      <Headline dark at={18} out={176} x={960} y={880} align="center" width={1500} size={46} title="在文件、法规、案例与纪要之间，反复切换。" />
      <AbsoluteFill style={{ background: "#0a0b0d", opacity: 1 - prog(f, 0, 8) }} />
    </AbsoluteFill>
  );
}
