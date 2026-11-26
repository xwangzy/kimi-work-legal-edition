import "./product/tokens.css";
import "./product/app.css";
import "./film.css";
import "./fonts";
import { Composition } from "remotion";
import { Film } from "./Film";
import { Cut30 } from "./SocialCut";
import { CUT30_DURATION } from "./cut30";
import { Cover, CoverSocial } from "./Cover";
import { DURATION, FPS, HEIGHT, SCENES, WIDTH } from "./timeline";
import { SCENE_COMPONENTS } from "./scenes";
import { SNAP_NAMES, SnapCheck } from "./SnapCheck";

export function Root() {
  return (
    <>
      <Composition id="KimiWorkLegalV4" component={Film} durationInFrames={DURATION} fps={FPS} width={WIDTH} height={HEIGHT} defaultProps={{ audio: true }} />
      <Composition id="KimiWorkLegalV4-30s" component={Cut30} durationInFrames={CUT30_DURATION} fps={FPS} width={WIDTH} height={HEIGHT} defaultProps={{ audio: true }} />
      <Composition id="Cover" component={Cover} durationInFrames={1} fps={FPS} width={WIDTH} height={HEIGHT} />
      <Composition id="Cover-1x1" component={CoverSocial} durationInFrames={1} fps={FPS} width={1080} height={1080} defaultProps={{ ratio: "1x1" as const }} />
      <Composition id="Cover-3x4" component={CoverSocial} durationInFrames={1} fps={FPS} width={1080} height={1440} defaultProps={{ ratio: "3x4" as const }} />
      <Composition id="SnapCheck" component={SnapCheck} durationInFrames={SNAP_NAMES.length} fps={FPS} width={1920} height={1080} />
      {(Object.keys(SCENES) as (keyof typeof SCENES)[]).map((k) => (
        <Composition key={k} id={`S-${k}`} component={SCENE_COMPONENTS[k]} durationInFrames={SCENES[k].dur} fps={FPS} width={WIDTH} height={HEIGHT} />
      ))}
    </>
  );
}
