import { AbsoluteFill, useCurrentFrame } from "remotion";
export function Placeholder({ name }: { name: string }) {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: "#111", color: "#666", fontFamily: "Inter", fontSize: 40, alignItems: "center", justifyContent: "center" }}>
      {name} · {f}
    </AbsoluteFill>
  );
}
