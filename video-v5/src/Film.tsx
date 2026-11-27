import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import { SCENES } from "./timeline";
import { SCENE_COMPONENTS } from "./scenes";

/** 全片：按时间轴串联各场；配乐由 scripts/make-music.mjs 依同一时间轴生成。 */
export function Film({ audio = true }: { audio?: boolean }) {
  return (
    <AbsoluteFill style={{ background: "#07080a" }}>
      {(Object.keys(SCENES) as (keyof typeof SCENES)[]).map((k) => {
        const C = SCENE_COMPONENTS[k];
        return (
          <Sequence key={k} from={SCENES[k].from} durationInFrames={SCENES[k].dur} name={k}>
            <C />
          </Sequence>
        );
      })}
      {audio && <Audio src={staticFile("audio/score.wav")} />}
    </AbsoluteFill>
  );
}
