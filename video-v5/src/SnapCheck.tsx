/** 检查用：第 N 帧显示第 N 张快照（1440×900 等比放大到 1728×1080）。 */
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { SNAPS, type SnapName } from "./snaps";
import { Snap } from "./ui/Snap";

export const SNAP_NAMES = Object.keys(SNAPS) as SnapName[];
export function SnapCheck() {
  const f = useCurrentFrame();
  const name = SNAP_NAMES[f % SNAP_NAMES.length];
  return (
    <AbsoluteFill style={{ background: "#fff" }}>
      <div style={{ position: "absolute", left: 0, top: 0, width: 1440, height: 900, transform: "scale(1.2)", transformOrigin: "0 0" }}>
        <Snap name={name} />
      </div>
      <div style={{ position: "absolute", right: 20, bottom: 20, fontSize: 28, color: "#c00", fontFamily: "Inter" }}>{name}</div>
    </AbsoluteFill>
  );
}
