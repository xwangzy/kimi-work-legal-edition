import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import { SCENES } from "./timeline";
import { SCENE_COMPONENTS } from "./scenes";

/** 全片：按时间轴串联 14 场；配乐由 scripts/make-music.mjs 依同一时间轴生成。 */
export function Film() {
  return (
    <AbsoluteFill style={{ background: "#0a0b0d" }}>
      {(Object.keys(SCENES) as (keyof typeof SCENES)[]).map((k) => {
        const C = SCENE_COMPONENTS[k];
        return (
          <Sequence key={k} from={SCENES[k].from} durationInFrames={SCENES[k].dur} name={k}>
            <C />
          </Sequence>
        );
      })}
      <Audio src={staticFile("audio/score.wav")} />
    </AbsoluteFill>
  );
}
