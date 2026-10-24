import "./product/tokens.css";
import "./product/app.css";
import "./film.css";
import { Composition } from "remotion";
import { Film } from "./Film";
import { DURATION, FPS, HEIGHT, SCENES, WIDTH } from "./timeline";
import { SCENE_COMPONENTS } from "./scenes";
import { SNAP_NAMES, SnapCheck } from "./SnapCheck";

export function Root() {
  return (
    <>
      <Composition id="KimiWorkLegalFilm" component={Film} durationInFrames={DURATION} fps={FPS} width={WIDTH} height={HEIGHT} />
      <Composition id="SnapCheck" component={SnapCheck} durationInFrames={SNAP_NAMES.length} fps={FPS} width={1920} height={1200} />
      {/* 单场景合成：便于逐场预览与出静帧 */}
      {(Object.keys(SCENES) as (keyof typeof SCENES)[]).map((k) => (
        <Composition key={k} id={`S-${k}`} component={SCENE_COMPONENTS[k]} durationInFrames={SCENES[k].dur} fps={FPS} width={WIDTH} height={HEIGHT} />
      ))}
    </>
  );
}
