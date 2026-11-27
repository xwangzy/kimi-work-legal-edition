/** 30 秒品牌精简版：按 cut30.ts 把正片各场的片段串起来，交叠处溶解。 */
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame } from "remotion";
import { CUT30, CUT30_STARTS, XF } from "./cut30";
import { SCENE_COMPONENTS } from "./scenes";

/** 后一段叠在前一段之上淡入，形成交叉溶解。 */
function Fader({ fadeIn, children }: { fadeIn: boolean; children: React.ReactNode }) {
  const f = useCurrentFrame();
  return <AbsoluteFill style={{ opacity: fadeIn ? Math.min(1, f / XF) : 1 }}>{children}</AbsoluteFill>;
}

export function Cut30({ audio = true }: { audio?: boolean }) {
  return (
    <AbsoluteFill style={{ background: "#07080a" }}>
      {CUT30.map((s, i) => {
        const C = SCENE_COMPONENTS[s.scene];
        const dur = s.b - s.a;
        return (
          <Sequence key={i} from={CUT30_STARTS[i]} durationInFrames={dur} name={`${i}-${s.scene}`}>
            <Fader fadeIn={i > 0}>
              <Sequence from={-s.a}>
                <C />
              </Sequence>
            </Fader>
          </Sequence>
        );
      })}
      {audio && <Audio src={staticFile("audio/score-cut30.wav")} />}
    </AbsoluteFill>
  );
}
