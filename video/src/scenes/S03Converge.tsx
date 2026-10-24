/** S3 · 汇于一处：分散的窗口被吸向中央，合成一块白色的工作面；黑场转为暖白。 */
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { easeInOut, lerp, map, prog } from "../lib/anim";
import { Headline, NightBackdrop, StudioBackdrop } from "../ui/film";
import { GRID, ToolWindow } from "./S02Scatter";

/** 汇聚完成时的白色工作面尺寸（= 首页窗口 1440×900 × 0.84）。 */
export const PLATE_W = 1440 * 0.84;
export const PLATE_H = 930 * 0.84;

export function S03Converge() {
  const f = useCurrentFrame();
  const day = prog(f, 48, 40, easeInOut);
  const ry = map(f, [0, 60], [7, 0]);
  return (
    <AbsoluteFill>
      <NightBackdrop glow={0.8} />
      <AbsoluteFill style={{ opacity: day }}>
        <StudioBackdrop />
      </AbsoluteFill>
      <AbsoluteFill style={{ perspective: 1500, perspectiveOrigin: "50% 45%" }}>
        <div style={{ position: "absolute", left: 960, top: 540, transformStyle: "preserve-3d", transform: `translateZ(${map(f, [0, 60], [60, 0])}px) rotateY(${ry}deg) rotateX(${map(f, [0, 60], [4, 0])}deg)` }}>
          {GRID.map((g, i) => {
            // 越靠后出现的越晚出发，形成“被吸入”的层次
            const d = (i % 6) * 2.5;
            const t = prog(f, 22 + d, 40, easeInOut);
            const w = lerp(340, PLATE_W, t);
            const h = lerp(230, PLATE_H, t);
            const x = lerp(g.x, 0, t);
            const y = lerp(g.y + 20, 0, t);
            const z = lerp(g.z, -i * 0.5, t);
            const content = 1 - prog(f, 26 + d, 22);
            return (
              <div
                key={i}
                style={{
                  position: "absolute",
                  left: -w / 2,
                  top: -h / 2,
                  width: w,
                  height: h,
                  borderRadius: lerp(10, 14, t),
                  overflow: "hidden",
                  background: "#fff",
                  transform: `translate3d(${x}px, ${y}px, ${z}px) rotateZ(${lerp(g.rz, 0, t)}deg)`,
                  boxShadow: i === 0 || t < 1 ? `0 ${lerp(24, 50, t)}px ${lerp(60, 110, t)}px -30px rgba(0,0,0,${lerp(0.7, 0.2, day) * (i === 0 ? 1 : 1 - t)})` : "none",
                  filter: `brightness(${lerp(0.5, 1, Math.min(1, Math.max(t * 1.2, day)))})`,
                }}
              >
                <div style={{ opacity: content, transformOrigin: "0 0", transform: `scale(${w / 340}, ${h / 230})` }}>
                  <ToolWindow name={g.name} body={g.body} />
                </div>
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
      <Headline dark at={2} out={44} x={960} y={880} align="center" width={1400} size={46} title="如果，这一切汇于一处。" />
    </AbsoluteFill>
  );
}
