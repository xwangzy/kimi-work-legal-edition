/** S1 · 文字的分量：黑场中，一页页法律文本在景深里缓缓掠过。 */
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { easeInOut, map, prog, rand } from "../lib/anim";
import { Headline, NightBackdrop, Vignette } from "../ui/film";
import { PAPERS, Paper } from "../ui/paper";

export const SHEETS = Array.from({ length: 14 }).map((_, i) => {
  const side = i % 2 === 0 ? -1 : 1;
  return {
    doc: PAPERS[i % PAPERS.length],
    x: i === 0 ? 0 : side * (260 + rand(i * 3.1) * 420),
    y: i === 0 ? -40 : -220 + rand(i * 7.7) * 380,
    z: i === 0 ? -260 : -420 - i * 300,
    ry: i === 0 ? -8 : side * -(10 + rand(i) * 18),
    rz: (rand(i * 5.3) - 0.5) * 8,
  };
});

export function S01Weight() {
  const f = useCurrentFrame();
  const camZ = map(f, [0, 224], [-120, 2700], easeInOut);
  const camX = map(f, [0, 224], [40, -60], easeInOut);
  return (
    <AbsoluteFill>
      <NightBackdrop glow={prog(f, 0, 60)} glowY={20} />
      <AbsoluteFill style={{ perspective: 1100, perspectiveOrigin: "50% 45%" }}>
        {SHEETS.map((s, i) => {
          const zeff = s.z + camZ;
          const blur = Math.min(12, Math.abs(zeff + 160) / 140);
          const fadeFar = map(zeff, [-3200, -1700], [0, 1]);
          const fadeNear = 1 - map(zeff, [160, 520], [0, 1]);
          const first = i === 0 ? prog(f, 0, 50) : prog(f, 34 + i * 5, 36);
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                left: 960 - 280,
                top: 540 - 380,
                transform: `translate3d(${s.x + camX}px, ${s.y}px, ${zeff}px) rotateY(${s.ry}deg) rotateZ(${s.rz}deg)`,
                filter: `blur(${blur}px) brightness(${0.55 + 0.45 * map(zeff, [-2000, 0], [0.2, 1])})`,
                opacity: fadeFar * fadeNear * first,
              }}
            >
              <Paper doc={s.doc} />
            </div>
          );
        })}
      </AbsoluteFill>
      {/* 底部渐暗，托住字幕 */}
      <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(10,11,13,0) 55%, rgba(10,11,13,0.85) 100%)" }} />
      <Vignette strength={0.55} />
      <Headline dark at={22} out={196} x={960} y={826} align="center" width={1400} size={46} title="一份法律意见的背后，" />
      <Headline dark at={92} out={198} x={960} y={892} align="center" width={1400} size={46} title="是成百上千页的合同、法规、判例与纪要。" />
      <AbsoluteFill style={{ background: "#0a0b0d", opacity: Math.max(1 - prog(f, 0, 24), prog(f, 204, 20)) }} />
    </AbsoluteFill>
  );
}
