/**
 * 桌面客户端外壳（v9 第 03 篇 §4：Kimi Work 版式——左侧栏 + 主区；任务执行态为 侧栏 | 对话 | 预览 三栏）。
 * 路由用 hash（渲染进程不导航到任何外部地址）。
 */
import { useEffect, useState } from "react";
import { Sidebar } from "./components/Sidebar.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { onKernelEvent } from "./api.ts";
import { Home } from "./pages/Home.tsx";
import { MattersPage } from "./pages/Matters.tsx";
import { MatterPage } from "./pages/Matter.tsx";
import { RunView } from "./pages/RunView.tsx";
import { ReviewPage } from "./pages/Review.tsx";
import { DeliverablesPage } from "./pages/Deliverables.tsx";
import { MethodsPage } from "./pages/Methods.tsx";
import { BoardsPage } from "./pages/Boards.tsx";
import { ConnectionsPage } from "./pages/Connections.tsx";
import { ChatPage } from "./pages/Chat.tsx";
import { NotOpenPage } from "./pages/NotOpen.tsx";

export type Route =
  | { page: "home"; matterId?: string }
  | { page: "matters" }
  | { page: "matter"; matterId: string }
  | { page: "run"; runId: string; matterId: string }
  | { page: "review"; artifactId: string }
  | { page: "deliverables" }
  | { page: "methods" }
  | { page: "boards" }
  | { page: "reminders" }
  | { page: "inbox" }
  | { page: "connections"; tab: "data" | "device" | "visibility" | "policy" }
  | { page: "chat"; conversationId?: string };

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, "");
  const [page, a, b] = h.split("/").map((x) => decodeURIComponent(x));
  switch (page) {
    case "new":
      return a ? { page: "home", matterId: a } : { page: "home" };
    case "matters":
      return { page: "matters" };
    case "matter":
      return a ? { page: "matter", matterId: a } : { page: "matters" };
    case "run":
      return a && b ? { page: "run", runId: a, matterId: b } : { page: "home" };
    case "review":
      return a ? { page: "review", artifactId: a } : { page: "deliverables" };
    case "deliverables":
      return { page: "deliverables" };
    case "methods":
      return { page: "methods" };
    case "boards":
      return { page: "boards" };
    case "reminders":
      return { page: "reminders" };
    case "inbox":
      return { page: "inbox" };
    case "connections":
      return { page: "connections", tab: a === "device" || a === "visibility" || a === "policy" ? a : "data" };
    case "chat":
      return a ? { page: "chat", conversationId: a } : { page: "chat" };
    default:
      return { page: "home" };
  }
}

export function nav(path: string): void {
  window.location.hash = path;
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  // 后台服务状态（主进程在内核意外退出并自动恢复时广播）：顶部横幅提示，不弹窗打断
  const [kernelNotice, setKernelNotice] = useState<{ status: string; message?: string } | null>(null);
  useEffect(
    () =>
      onKernelEvent((m) => {
        if (m?.type !== "kernel.status") return;
        setKernelNotice(m.status === "running" ? null : { status: String(m.status), message: m.message });
      }),
    [],
  );
  const routeKey = route.page === "run" ? `run:${route.runId}` : route.page === "matter" ? `matter:${route.matterId}` : route.page;
  return (
    <div className="shell">
      <Sidebar route={route} />
      <div className="shell-main">
        {kernelNotice && <div className={`banner ${kernelNotice.status === "stopped" ? "banner-red" : "banner-orange"} kernel-banner`}>{kernelNotice.message ?? "后台服务正在恢复…"}</div>}
        <ErrorBoundary key={routeKey} routeLabel={route.page}>
          <Page route={route} />
        </ErrorBoundary>
      </div>
    </div>
  );
}

function Page({ route }: { route: Route }) {
  switch (route.page) {
    case "home":
      return <Home presetMatterId={route.matterId} />;
    case "matters":
      return <MattersPage />;
    case "matter":
      return <MatterPage matterId={route.matterId} />;
    case "run":
      return <RunView key={route.runId} runId={route.runId} matterId={route.matterId} />;
    case "review":
      return <ReviewPage artifactId={route.artifactId} />;
    case "deliverables":
      return <DeliverablesPage />;
    case "methods":
      return <MethodsPage />;
    case "boards":
      return <BoardsPage />;
    case "connections":
      return <ConnectionsPage tab={route.tab} />;
    case "chat":
      return <ChatPage conversationId={route.conversationId} />;
    case "reminders":
      return <NotOpenPage title="提醒与定时" phase="" lines={["期限提醒与定时任务即将推出：到期前提醒你，定时整理事项进展。"]} />;
    case "inbox":
      return <NotOpenPage title="收件区" phase="" lines={["收件区即将推出：手机和工作群发来的文件先放这里，再归入事项。"]} />;
  }
}
