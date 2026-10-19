/**
 * 桌面客户端外壳（v9 第 03 篇 §4：Kimi Work 版式——左侧栏 + 主区；任务执行态为 侧栏 | 对话 | 预览 三栏）。
 * 路由用 hash（渲染进程不导航到任何外部地址）。
 */
import { useEffect, useState } from "react";
import { Sidebar } from "./components/Sidebar.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { api, onKernelEvent, recovery, updates, type UpdateStatus } from "./api.ts";
import { Home } from "./pages/Home.tsx";
import { MattersPage } from "./pages/Matters.tsx";
import { MatterPage } from "./pages/Matter.tsx";
import { RunView } from "./pages/RunView.tsx";
import { ReviewPage } from "./pages/Review.tsx";
import { bootRetryDelay } from "./lib/boot-gate.ts";
import { DeliverablesPage } from "./pages/Deliverables.tsx";
import { MethodsPage } from "./pages/Methods.tsx";
import { BoardsPage } from "./pages/Boards.tsx";
import { ConnectionsPage } from "./pages/Connections.tsx";
import { ChatPage } from "./pages/Chat.tsx";
import { NotOpenPage } from "./pages/NotOpen.tsx";
import { RemindersPage } from "./pages/Reminders.tsx";
import { ActivatePage } from "./pages/Activate.tsx";
import { updateBannerView } from "./lib/update-banner.ts";

/** 设置页的标签（UIUX 增量评审 ST-5）：律师版四页 + 管理员“管理”。 */
export type SettingsTab = "general" | "visibility" | "sources" | "device" | "admin";

export type Route =
  | { page: "home"; matterId?: string; startScenario?: string }
  | { page: "matters" }
  | { page: "matter"; matterId: string }
  | { page: "run"; runId: string; matterId: string }
  | { page: "review"; artifactId: string }
  | { page: "deliverables" }
  | { page: "methods" }
  | { page: "boards" }
  | { page: "reminders"; newForMatter?: string }
  | { page: "inbox" }
  | { page: "connections"; tab: SettingsTab }
  | { page: "chat"; conversationId?: string };

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, "");
  const [page, a, b] = h.split("/").map((x) => decodeURIComponent(x));
  switch (page) {
    case "new":
      return a ? { page: "home", matterId: a } : { page: "home" };
    // 方法与模板页“开始 →”：回到首页并打开该业务场景的开始面板（与首页场景卡同一入口）
    case "start":
      // “接着做”（UIUX 增量评审 D-4）：#/start/<场景>/<事项> 在该事项下直接打开下一场景的开始面板
      return a ? (b ? { page: "home", startScenario: a, matterId: b } : { page: "home", startScenario: a }) : { page: "home" };
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
      // #/reminders/new/<事项>：打开设提醒表单并选好该事项（事项头“设提醒”）
      return a === "new" && b ? { page: "reminders", newForMatter: b } : { page: "reminders" };
    case "inbox":
      return { page: "inbox" };
    case "connections":
      // 旧链接兼容：data → 资料来源，policy → 管理
      return { page: "connections", tab: a === "device" || a === "visibility" || a === "sources" || a === "admin" ? a : a === "data" ? "sources" : a === "policy" ? "admin" : "general" };
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
  // 首次启动激活（第 13 批）：这台电脑还没有激活时整个应用只显示激活页
  const [boot, setBoot] = useState<{ onboarding: any } | null>(null);
  // 取不到状态时不当作“已激活”（复核 B13-K01）：首次启动内核较慢，按退避重试（lib/boot-gate.ts）；约两分钟仍取不到才给出说明与“重试”
  const [bootFailed, setBootFailed] = useState(false);
  const loadBoot = () => {
    setBootFailed(false);
    let attempt = 0;
    const tryOnce = () =>
      void api
        .kernelStatus()
        .then((st: any) => setBoot({ onboarding: st?.onboarding ?? null }))
        .catch(() => {
          attempt += 1;
          const delay = bootRetryDelay(attempt);
          if (delay === null) return setBootFailed(true);
          setTimeout(tryOnce, delay);
        });
    tryOnce();
  };
  useEffect(loadBoot, []);
  // 开通的最后一步（第 14 批）：还没有生成恢复包时，首页与事项页顶部提醒（电脑坏了数据就找不回）
  const [needRecovery, setNeedRecovery] = useState(false);
  useEffect(() => {
    if (!boot || boot.onboarding) return;
    void recovery
      .backupStatus()
      .then((s: any) => setNeedRecovery(!!s && s.packages_created === 0))
      .catch(() => setNeedRecovery(false));
  }, [boot, route.page]);
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
  // 系统通知被点击：打开那个等你确认的任务
  useEffect(
    () =>
      onKernelEvent((m) => {
        if (m?.type !== "focus.run" || typeof m.run_id !== "string") return;
        void api
          .getRun(m.run_id)
          .then((r: any) => r?.run?.matter_id && nav(`/run/${m.run_id}/${r.run.matter_id}`))
          .catch(() => {});
      }),
    [],
  );
  // 期限提醒的系统通知被点击：打开提醒页
  useEffect(() => onKernelEvent((m) => (m?.type === "focus.reminders" ? nav("/reminders") : undefined)), []);
  // 自动更新（W7）：新版本下载并通过发布签名核验后提示；由律师选择时机重启，不强制
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  useEffect(() => {
    void updates.status().then((s) => s && setUpdate(s));
    return onKernelEvent((m) => {
      if (m?.type !== "update.status") return;
      setUpdate(m as UpdateStatus);
      setUpdateDismissed(false);
    });
  }, []);
  const routeKey = route.page === "run" ? `run:${route.runId}` : route.page === "matter" ? `matter:${route.matterId}` : route.page;
  if (boot === null) {
    return (
      <div className="activate" aria-busy={!bootFailed}>
        <div className="activate-card">
          <p className="muted" role="status">
            {bootFailed ? "后台服务没有启动起来。可以点“重试”；仍不行请重新打开应用，或联系所内 IT 与客服。" : "正在启动…第一次打开需要十几秒。"}
          </p>
          {bootFailed && (
            <button className="btn-primary" onClick={loadBoot}>
              重试
            </button>
          )}
        </div>
      </div>
    );
  }
  if (boot.onboarding) return <ActivatePage initial={boot.onboarding} onRefresh={loadBoot} />;
  return (
    <div className="shell">
      <Sidebar route={route} />
      <div className="shell-main">
        {kernelNotice && <div className={`banner ${kernelNotice.status === "stopped" ? "banner-red" : "banner-orange"} kernel-banner`}>{kernelNotice.message ?? "后台服务正在恢复…"}</div>}
        {update && !updateDismissed && route.page !== "run" && route.page !== "review" && <UpdateBanner status={update} onDismiss={() => setUpdateDismissed(true)} />}
        {needRecovery && (route.page === "home" || route.page === "matters") && (
          <div className="banner banner-orange">
            完成开通的最后一步：生成恢复包并设置备份。不做的话，这台电脑坏了或丢了，案件数据将无法找回。{" "}
            <button className="btn-link" onClick={() => nav("/connections/device")}>
              去设置 →
            </button>
          </div>
        )}
        <ErrorBoundary key={routeKey} routeLabel={route.page}>
          <Page route={route} />
        </ErrorBoundary>
      </div>
    </div>
  );
}

/** “稍后”与“已知道未通过核验”按版本记住（只在本机浏览器存储；读写失败时当作没记住）。 */
const LATER_KEY = "kwl.update.later";
const REJECTED_KEY = "kwl.update.rejected-seen";
function remembered(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function remember(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 记不住也不影响：下次启动再提示
  }
}

function UpdateBanner({ status, onDismiss }: { status: UpdateStatus; onDismiss: () => void }) {
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  // 进行中与等你处理的任务数实时计算（复核 B4-B17：此前只在版本变化时取一次，横幅显示后开始的任务不会让“现在重启并更新”消失）
  useEffect(() => {
    let alive = true;
    const recount = () =>
      void api
        .listMatters()
        .then((r) => alive && setActive(r.matters.reduce((n, m) => n + (m.activity?.running ?? 0) + (m.activity?.waiting ?? 0), 0)))
        .catch(() => {});
    recount();
    const off = onKernelEvent((m) => {
      if (m?.type === "run.updated" || m?.type === "run.settled") recount();
    });
    // 开发桥没有推送：低频兜底
    const t = setInterval(recount, 15_000);
    return () => {
      alive = false;
      off();
      clearInterval(t);
    };
  }, [status.version]);
  const view = updateBannerView({ state: status.state, version: status.version, laterVersion: remembered(LATER_KEY), rejectedSeenVersion: remembered(REJECTED_KEY), activeRuns: active });
  if (view?.kind === "ready") {
    return (
      <div className="banner banner-neutral kernel-banner" role="status">
        新版本 {status.version} 已准备好，重启应用后生效。
        {view.busyNote ? " 现在有任务在进行，建议等任务完成后再重启；关闭应用时也会自动完成更新。" : ""}
        <div className="banner-actions">
          {view.canInstall && (
            <button
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                // 主进程核对到进行中的任务即不安装（界面计数可能过时）：改为显示“有任务在进行”的提示
                void updates
                  .install()
                  .then((r) => {
                    if (!r.ok && (r as { reason?: string }).reason === "busy") setActive((n) => Math.max(n, 1));
                  })
                  .finally(() => setBusy(false));
              }}
            >
              现在重启并更新
            </button>
          )}{" "}
          <button
            className="btn btn-sm"
            onClick={() => {
              remember(LATER_KEY, String(status.version ?? ""));
              onDismiss();
            }}
          >
            {view.dismissLabel}
          </button>
        </div>
      </div>
    );
  }
  if (view?.kind === "rejected") {
    return (
      <div className="banner banner-neutral kernel-banner" role="status">
        这次下载的更新没有通过安全核验，已丢弃，当前版本照常可用。如持续出现，请联系所内 IT 或客服。
        <div className="banner-actions">
          <button
            className="btn btn-sm"
            onClick={() => {
              remember(REJECTED_KEY, String(status.version ?? ""));
              onDismiss();
            }}
          >
            知道了
          </button>
        </div>
      </div>
    );
  }
  return null;
}

function Page({ route }: { route: Route }) {
  switch (route.page) {
    case "home":
      return <Home presetMatterId={route.matterId} startScenario={route.startScenario} />;
    case "matters":
      return <MattersPage />;
    case "matter":
      return <MatterPage matterId={route.matterId} />;
    case "run":
      return <RunView key={route.runId} runId={route.runId} matterId={route.matterId} />;
    case "review":
      // key：换一份成果即重建页面，上一份的勾选不带到下一份（复核 A-13）
      return <ReviewPage key={route.artifactId} artifactId={route.artifactId} />;
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
      return <RemindersPage {...(route.newForMatter ? { newForMatter: route.newForMatter } : {})} />;
    case "inbox":
      return <NotOpenPage title="收件区" phase="" lines={["收件区即将推出：手机和工作群发来的文件先放这里，再归入事项。"]} />;
  }
}
