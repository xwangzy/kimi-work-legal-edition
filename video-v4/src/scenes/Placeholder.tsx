import { AbsoluteFill, useCurrentFrame } from "remotion";
export const placeholder = (name: string) =>
  function Placeholder() {
    const f = useCurrentFrame();
    return <AbsoluteFill style={{ background: "#222", color: "#888", fontSize: 40, alignItems: "center", justifyContent: "center", fontFamily: "Inter" }}>{name} · {f}</AbsoluteFill>;
  };
