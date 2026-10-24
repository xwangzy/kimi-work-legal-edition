/** 检查用：第 N 帧显示第 N 张快照（铺满 1920×1080，按 4:3 等比放大），与 out/ref 里的采集截图对照。 */
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { SNAPS, type SnapName } from "./snaps";
import { Snap } from "./ui/Snap";

export const SNAP_NAMES = Object.keys(SNAPS) as SnapName[];
export function SnapCheck() {
  const f = useCurrentFrame();
  const name = SNAP_NAMES[f % SNAP_NAMES.length];
  return (
    <AbsoluteFill style={{ background: "#fff" }}>
      <div style={{ position: "absolute", left: 0, top: 0, width: 1440, height: 900, transform: "scale(1.3333)", transformOrigin: "0 0" }}>
        <Snap name={name} />
      </div>
    </AbsoluteFill>
  );
}
