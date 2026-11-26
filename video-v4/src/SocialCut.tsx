/** 30 秒社媒版：按 cut30.ts 的剪辑表串联正片片段（嵌套 Sequence 做场景内时间偏移）。 */
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame } from "remotion";
import { FONT_TITLE } from "./fonts";
import { easeInOut, prog, Wordmark } from "./ui/film";
import { CUT30, CUT30_STARTS } from "./cut30";
import { SCENE_COMPONENTS } from "./scenes";
import { PartnerShift } from "./scenes/S15Finale";

export function Cut30({ audio = true }: { audio?: boolean }) {
  const f = useCurrentFrame();
  const pStart = CUT30_STARTS[CUT30.findIndex((x) => x.scene === "partner")];
  const shift = 64 * prog(f, pStart + 170, 40, easeInOut);
  return (
    <AbsoluteFill style={{ background: "#07080a" }}>
      {CUT30.map((seg, i) => {
        const C = SCENE_COMPONENTS[seg.scene];
        return (
          <Sequence key={i} from={CUT30_STARTS[i]} durationInFrames={seg.to - seg.from} name={`${i + 1}-${seg.scene}`}>
            <Sequence from={-seg.from}>
              <PartnerShift.Provider value={seg.scene === "partner" ? shift : 0}>
                <C />
              </PartnerShift.Provider>
            </Sequence>
          </Sequence>
        );
      })}
      <CutOverlays />
      {audio && <Audio src={staticFile("audio/score-cut30.wav")} />}
    </AbsoluteFill>
  );
}

/** 30 秒版专用：签发段末尾浸入夜色（接主题）；落版上方补产品名（终帧同时有产品名与联合品牌）。 */
function CutOverlays() {
  const f = useCurrentFrame();
  const i = CUT30.findIndex((x) => x.scene === "signoff");
  const sEnd = CUT30_STARTS[i] + (CUT30[i].to - CUT30[i].from);
  const pStart = CUT30_STARTS[CUT30.findIndex((x) => x.scene === "partner")];
  const dip = prog(f, sEnd - 14, 14, easeInOut);
  const name = prog(f, pStart + 170, 40);
  return (
    <>
      {f >= sEnd - 14 && f < sEnd && <AbsoluteFill style={{ background: "#07080a", opacity: dip, zIndex: 1000 }} />}
      {f >= pStart + 170 && (
        <div style={{ position: "absolute", left: 0, right: 0, top: 236, display: "flex", flexDirection: "column", alignItems: "center", opacity: name, transform: `translateY(${(1 - name) * 8}px)` }}>
          <Wordmark h={50} />
          <div style={{ marginTop: 10, fontFamily: FONT_TITLE, fontSize: 21, fontWeight: 500, letterSpacing: 7, paddingLeft: 7, color: "#57534d" }}>法律行业发行版</div>
        </div>
      )}
    </>
  );
}
