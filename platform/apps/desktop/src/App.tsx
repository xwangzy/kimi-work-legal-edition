import { useEffect, useState } from "react";
import { Home } from "./pages/Home.tsx";
import { MatterPage } from "./pages/Matter.tsx";
import { RunView } from "./pages/RunView.tsx";
import { ReviewPage } from "./pages/Review.tsx";

export type Route =
  | { page: "home" }
  | { page: "matter"; matterId: string }
  | { page: "run"; runId: string; matterId: string }
  | { page: "review"; artifactId: string };

function parseHash(): Route {
  const h = window.location.hash.replace(/^#\/?/, "");
  const [page, a, b] = h.split("/");
  if (page === "matter" && a) return { page: "matter", matterId: a };
  if (page === "run" && a && b) return { page: "run", runId: a, matterId: b };
  if (page === "review" && a) return { page: "review", artifactId: a };
  return { page: "home" };
}

export function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  if (route.page === "matter") return <MatterPage matterId={route.matterId} />;
  if (route.page === "run") return <RunView runId={route.runId} matterId={route.matterId} />;
  if (route.page === "review") return <ReviewPage artifactId={route.artifactId} />;
  return <Home />;
}

export function nav(path: string): void {
  window.location.hash = path;
}
