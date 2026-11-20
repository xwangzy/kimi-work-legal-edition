/**
 * 桌面客户端外壳（v9 第 03 篇 §4：Kimi Work 版式——左侧栏 + 主区；任务执行态为 侧栏 | 对话 | 预览 三栏）。
 * 路由用 hash（渲染进程不导航到任何外部地址）。
 */
import { useEffect, useRef, useState } from "react";
import { Sidebar } from "./components/Sidebar.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { account, api, members, onKernelEvent, recovery, updates, type UpdateStatus } from "./api.ts";
import { ACCOUNT_CHANGED, LoginBox } from "./components/AccountPanel.tsx";
import { loginRequiredText, needsLogin } from "./lib/account.ts";
import { Home } from "./pages/Home.tsx";
import { MattersPage } from "./pages/Matters.tsx";
import { MatterPage } from "./pages/Matter.tsx";
import { RunView } from "./pages/RunView.tsx";
import { ReviewPage } from "./pages/Review.tsx";
import { bootRetryDelay } from "./lib/boot-gate.ts";
import { localDay, recoveryReminder, reminderSnoozed } from "./lib/recovery-reminder.ts";
import { DeliverablesPage } from "./pages/Deliverables.tsx";
import { MethodsPage } from "./pages/Methods.tsx";
import { ConnectionsPage } from "./pages/Connections.tsx";
import { ChatPage } from "./pages/Chat.tsx";
import { NotOpenPage } from "./pages/NotOpen.tsx";
import { RemindersPage } from "./pages/Reminders.tsx";
import { ActivatePage } from "./pages/Activate.tsx";
import { WelcomePage } from "./pages/Welcome.tsx";
import { updateBannerView } from "./lib/update-banner.ts";
import { SearchPalette } from "./components/SearchPalette.tsx";
import { AskHost } from "./components/AskHost.tsx";
import { fmtDate } from "./lib/labels.ts";
import { GuideTour } from "./components/GuideTour.tsx";
import { guideSeenKey, markGuideSeen } from "./lib/guide-steps.ts";
import { newTaskHref } from "./lib/nav-target.ts";
import { useElapsed, WaitBlock } from "./components/Loading.tsx";
import { BrandLockup } from "./components/Brand.tsx";
import { waitLevel } from "./lib/waiting.ts";

/** 再看一遍上手指南（设置 · 通用里的按钮发这个事件）。 */
export const OPEN_GUIDE = "kwl:guide";
/** 指南最后一步“新建第一个事项”：首页收到后打开新建事项对话框。 */
export const NEW_MATTER = "kwl:new-matter";
/** 本机偏好存储（读不到时为 null）；上手清单（components/GuideChecklist.tsx）经它记收起状态。 */
export const safeStorage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

/**
 * 从侧栏“事项 +”等首页以外的地方新建事项（第 47 批）：先记下请求再回首页，首页挂载后取走并打开新建事项对话框；
 * 已在首页时由 NEW_MATTER 事件直接打开。
 */
let newMatterRequested = false;
export function requestNewMatter(): void {
  newMatterRequested = true;
  if (!/^#?\/?$/.test(window.location.hash)) nav("/");
  window.dispatchEvent(new Event(NEW_MATTER));
}
export function consumeNewMatterRequest(): boolean {
  const r = newMatterRequested;
  newMatterRequested = false;
  return r;
}
/** ⌘ / Ctrl + K（Kimi Work 同款“新建任务”）：首页收到后把光标放进任务输入框。 */
export const FOCUS_COMPOSER = "kwl:focus-composer";

/** “明天提醒”记在这台电脑的本地偏好（v9.4）。 */
const SNOOZE_KEY = "kwl.recovery.snooze_until";

/** 设置页的标签（V16 IA-1；第 47 批加“套餐与用量”，对应 Kimi 设置里的“订阅 · 我的额度”）：律师版六页 + 管理员“管理”。 */
export type SettingsTab = "general" | "writing" | "account" | "usage" | "backup" | "visibility" | "admin";

/**
 * 设置子路径 → 标签（纯函数）。旧地址继续可用（V16）：device（原“本机与安全”）→ 备份与安全，
 * sources / data（原“资料来源”，已并入数据去向页底）→ 数据去向，policy → 管理；认不出的回到通用。
 */
export function settingsTabOf(a: string | undefined): SettingsTab {
  if (a === "general" || a === "writing" || a === "account" || a === "usage" || a === "backup" || a === "visibility" || a === "admin") return a;
  if (a === "device") return "backup";
  if (a === "sources" || a === "data") return "visibility";
  if (a === "policy") return "admin";
  return "general";
}

export type Route =
  | { page: "home"; matterId?: string; startScenario?: string }
  | { page: "matters" }
  | { page: "matter"; matterId: string }
  | { page: "run"; runId: string; matterId: string }
  | { page: "review"; artifactId: string }
  | { page: "deliverables" }
  | { page: "methods" }
  | { page: "reminders"; newForMatter?: string }
  | { page: "inbox" }
  | { page: "connections"; tab: SettingsTab }
  | { page: "chat"; conversationId?: string }
  | { page: "welcome" };

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
    // 独立的“看板”页已撤（V18 第 43 批）：内容与事项页“概览”相同；旧地址落到事项列表
    case "boards":
      return { page: "matters" };
    case "reminders":
      // #/reminders/new/<事项>：打开设提醒表单并选好该事项（事项头“设提醒”）
      return a === "new" && b ? { page: "reminders", newForMatter: b } : { page: "reminders" };
    case "inbox":
      return { page: "inbox" };
    case "connections":
      // 旧链接兼容见 settingsTabOf（device → 备份与安全，sources / data → 数据去向，policy → 管理）
      return { page: "connections", tab: settingsTabOf(a) };
    case "chat":
      return a ? { page: "chat", conversationId: a } : { page: "chat" };
    // 开通向导：激活后的“最后一步”（恢复包、试一下、备份位置），之后进首页看示例事项
    case "welcome":
      return { page: "welcome" };
    default:
      return { page: "home" };
  }
}

/**
 * 冷启动等待（第 51 批）：Kimi 蓝点 + “正在启动…” + 已用时间。原来只有一行静态字“第一次打开需要十几秒”，
 * 等过了十几秒文案不变，像是卡住了；超过 30 秒改说“比平时慢、请不要关闭”，并说明启动不起来时这里会给“重试”（lib/boot-gate.ts 退避约两分钟后判失败）。
 */
function BootWait({ since }: { since: number }) {
  const long = waitLevel(useElapsed(since)) === "long";
  return (
    <WaitBlock
      variant="page"
      title="正在启动…"
      since={since}
      {...(long ? {} : { hint: "第一次打开需要十几秒。" })}
      longHint="这次启动比平时慢，请不要关闭应用；一直启动不起来时，这里会给出“重试”。"
    />
  );
}

export function nav(path: string): void {
  window.location.hash = path;
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  // 首次启动激活（第 13 批）：这台电脑还没有激活时整个应用只显示激活页
  const [boot, setBoot] = useState<{ onboarding: any; restoredAt?: string | null; login?: { reason: string | null; email: string } | null; firm?: string | null; user?: string | null } | null>(null);
  // 取不到状态时不当作“已激活”（复核 B13-K01）：首次启动内核较慢，按退避重试（lib/boot-gate.ts）；约两分钟仍取不到才给出说明与“重试”
  const [bootFailed, setBootFailed] = useState(false);
  // 启动等待从何时算起（第 51 批：冷启动显示真实已用时间）；点“重试”重新计时
  const [bootSince, setBootSince] = useState(() => Date.now());
  const loadBoot = () => {
    setBootFailed(false);
    setBootSince(Date.now());
    let attempt = 0;
    const tryOnce = () =>
      void api
        .kernelStatus()
        .then((st: any) => setBoot({ onboarding: st?.onboarding ?? null, restoredAt: st?.restored_from_backup_at ?? null, login: needsLogin(st) ? { reason: st.account?.reason ?? null, email: st.account?.email ?? "" } : null, firm: st?.firm ?? null, user: st?.user ?? null }))
        .catch(() => {
          attempt += 1;
          const delay = bootRetryDelay(attempt);
          if (delay === null) return setBootFailed(true);
          setTimeout(tryOnce, delay);
        });
    tryOnce();
  };
  useEffect(loadBoot, []);
  // 恢复与备份的提醒（第 14 批；第二轮复核 R2B-05）：缺恢复包、缺备份位置只在首页与事项页提醒；备份失败、多日未成功在各页都提醒
  const [reminder, setReminder] = useState<ReturnType<typeof recoveryReminder>>(null);
  const [snoozedUntil, setSnoozedUntil] = useState<string | null>(() => {
    try {
      return localStorage.getItem(SNOOZE_KEY);
    } catch {
      return null;
    }
  });
  const snooze = () => {
    const until = localDay(1);
    setSnoozedUntil(until);
    try {
      localStorage.setItem(SNOOZE_KEY, until);
    } catch {
      // 本地偏好写不进去时只在本次打开期间生效
    }
  };
  useEffect(() => {
    if (!boot || boot.onboarding) return;
    void recovery
      .backupStatus()
      .then((s: any) => setReminder(recoveryReminder(s)))
      .catch(() => setReminder(null));
  }, [boot, route.page]);
  // 被停用的电脑（D-144，10-23 拍板：只提示、不自动清除）：每次启动提示一次，律师自己决定是否清除写作偏好与问答记录
  const [revokedPersonal, setRevokedPersonal] = useState<{ writing_prefs: boolean; qa_conversations: number } | null>(null);
  const [revokedNote, setRevokedNote] = useState("");
  useEffect(() => {
    if (!boot || boot.onboarding) return;
    void members
      .personalStatus()
      .then((s) => setRevokedPersonal(s.prompt_clear ? { writing_prefs: s.writing_prefs, qa_conversations: s.qa_conversations } : null))
      .catch(() => setRevokedPersonal(null));
  }, [boot]);
  // 登录失效（第 44 批，主文 §2.5）：内核报 login_required 或广播 account.login_required → 顶部横幅 + 就地登录；
  // 主进程（main.cjs）与开发桥（dev/bridge.ts）都转发这条广播；另按 30 秒查一次兜底（本机调用，不联网；广播在界面就绪前发出时也能补上），退出登录时立即刷新
  const [login, setLogin] = useState<{ reason: string | null; email: string } | null>(null);
  // 退出登录后内核不再留邮箱：记住这次打开期间最后看到的那个，就地登录时预先填好
  const lastEmail = useRef("");
  useEffect(() => {
    if (!boot || boot.onboarding) return;
    setLogin(boot.login ?? null);
    let alive = true;
    const refresh = () =>
      void account
        .status()
        .then((s) => {
          if (!alive) return;
          if (s.account?.email) lastEmail.current = s.account.email;
          setLogin(s.login_required ? { reason: s.reason, email: s.account?.email ?? s.last_account?.email ?? lastEmail.current } : null);
        })
        .catch(() => {});
    refresh();
    const t = setInterval(refresh, 30_000);
    window.addEventListener(ACCOUNT_CHANGED, refresh);
    const off = onKernelEvent((m) => (m?.type === "account.login_required" ? refresh() : undefined));
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener(ACCOUNT_CHANGED, refresh);
      off();
    };
  }, [boot]);
  // 首次上手（第 46 批，主文 §5-5）：首页的“上手清单”卡片是第一入口（components/GuideChecklist.tsx）；这里的聚光讲解不再自动弹出，
  // 由清单上的“看看界面”与设置 · 通用里的“再看一遍”打开（OPEN_GUIDE）。看完记“看过了”（按律所与成员分键）
  const [guide, setGuide] = useState<{ hasMatters: boolean } | null>(null);
  const guideKey = boot ? guideSeenKey(boot.firm, boot.user) : null;
  useEffect(() => {
    const open = () => {
      if (onboardingRef.current) return;
      nav("/");
      void api
        .listMatters()
        .then((r) => setGuide({ hasMatters: r.matters.some((m) => !m.is_sample) }))
        .catch(() => setGuide({ hasMatters: true }));
    };
    window.addEventListener(OPEN_GUIDE, open);
    return () => window.removeEventListener(OPEN_GUIDE, open);
  }, []);
  const finishGuide = () => {
    if (guideKey) markGuideSeen(safeStorage(), guideKey);
    setGuide(null);
  };
  const clearRevokedPersonal = async () => {
    try {
      setRevokedNote((await members.offboardClearPersonal()).note);
      setRevokedPersonal(null);
    } catch (e) {
      setRevokedNote(`没有清除成功：${(e as Error).message}`);
    }
  };
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  // 后台服务状态（主进程在内核意外退出并自动恢复时广播）：顶部横幅提示，不弹窗打断
  const [kernelNotice, setKernelNotice] = useState<{ status: string; message?: string } | null>(null);
  // 快捷键（第 47 批对照 Kimi Work）：Ctrl / ⌘ + K = 新建任务（Chat 模式下 = 新建问答），Ctrl / ⌘ + F = 全局搜索（Z3 §8.2 #31）；
  // 侧栏顶部的搜索按钮发 kwl:search 事件
  const [searching, setSearching] = useState(false);
  // 开通向导里不响应（面板只在主界面渲染；否则在向导里按过快捷键，进主界面会自己弹出来）
  const onboardingRef = useRef(true);
  onboardingRef.current = boot === null || !!boot.onboarding;
  const routeRef = useRef(route);
  routeRef.current = route;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // macOS 只认 ⌘（文本框里系统自带的 Ctrl + K 是删除到行尾）；其余系统认 Ctrl（余项续复核 RC-B-08）
      const mod = /Mac/i.test(navigator.platform) ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!mod || e.shiftKey || e.altKey || onboardingRef.current) return;
      const key = e.key.toLowerCase();
      if (key === "k") {
        e.preventDefault();
        const r = routeRef.current;
        if (r.page === "chat") return nav("/chat");
        nav(newTaskHref("/", r));
        // 首页挂载后把光标放进输入框（已在首页时立即生效）
        setTimeout(() => window.dispatchEvent(new Event(FOCUS_COMPOSER)), 0);
      } else if (key === "f") {
        e.preventDefault();
        setSearching(true);
      }
    };
    const onOpen = () => !onboardingRef.current && setSearching(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("kwl:search", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("kwl:search", onOpen);
    };
  }, []);
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
          {/* 第 51 批：启动页也是第一眼——与登录页同一品牌组合 */}
          <div className="brand">
            <BrandLockup />
          </div>
          {/* 主进程的“后台服务已停止”在启动占位页也看得到（复核 R2B-25） */}
          {kernelNotice?.status === "stopped" && <p className="activate-error" role="alert">{kernelNotice.message}</p>}
          {bootFailed ? (
            <p className="muted" role="status">
              后台服务没有启动起来。可以点“重试”；仍不行请重新打开应用，或联系所内 IT 与客服。
            </p>
          ) : (
            <BootWait since={bootSince} />
          )}
          {bootFailed && (
            <button className="btn-primary" onClick={loadBoot}>
              重试
            </button>
          )}
        </div>
      </div>
    );
  }
  if (boot.onboarding)
    return (
      <>
        <ActivatePage initial={boot.onboarding} onRefresh={loadBoot} notice={kernelNotice?.status === "stopped" ? (kernelNotice.message ?? "后台服务已停止") : ""} />
        {/* 开通向导里导出恢复包也会问保存位置（lib/ask.ts） */}
        <AskHost />
      </>
    );
  return (
    <div className="shell">
      <Sidebar route={route} />
      <div className="shell-main">
        {kernelNotice && <div className={`banner ${kernelNotice.status === "stopped" ? "banner-red" : "banner-orange"} kernel-banner`}>{kernelNotice.message ?? "后台服务正在恢复…"}</div>}
        {login && (
          <div className="banner banner-orange login-banner" role="alert">
            <div>{loginRequiredText(login.reason)}</div>
            {/* 设置 · 账号与团队页上已有登录框：横幅只提示，不再放第二个 */}
            {route.page === "connections" && route.tab === "account" ? <div className="muted">请在下方“账号”一栏登录。</div> : <LoginBox compact email={login.email} onDone={() => setLogin(null)} />}
          </div>
        )}
        {update && !updateDismissed && route.page !== "run" && route.page !== "review" && <UpdateBanner status={update} onDismiss={() => setUpdateDismissed(true)} />}
        {revokedPersonal && (
          <div className="banner banner-orange" role="status">
            这台电脑已被律所停用。你在这台电脑上还有{[revokedPersonal.writing_prefs ? "写作偏好" : "", revokedPersonal.qa_conversations > 0 ? `${revokedPersonal.qa_conversations} 个问答` : ""].filter(Boolean).join("和")}，要清除吗？事项材料与成果按律所制度处理，这里不删。{" "}
            <button className="btn-link" onClick={() => void clearRevokedPersonal()}>
              清除我的个人数据
            </button>
            <button className="btn-link banner-later" onClick={() => setRevokedPersonal(null)}>
              先不清除
            </button>
          </div>
        )}
        {revokedNote && !revokedPersonal && (
          <div className="banner banner-neutral" role="status">
            {revokedNote}{" "}
            <button className="btn-link banner-later" onClick={() => setRevokedNote("")}>
              知道了
            </button>
          </div>
        )}
        {boot.restoredAt && Date.now() - Date.parse(boot.restoredAt) < 14 * 86400_000 && route.page === "home" && (
          <div className="banner banner-orange">
            这台电脑是从备份恢复的（{fmtDate(boot.restoredAt)}）。如果原来那台电脑丢了或被偷，请马上告诉律所管理员：当前版本不能单独停用原电脑，管理员会为你重新办理入组。
          </div>
        )}
        {reminder && route.page !== "welcome" && !reminderSnoozed(reminder, snoozedUntil, localDay()) && (reminder.everywhere ? route.page !== "run" && route.page !== "review" : route.page === "home" || route.page === "matters") && (
          // 第 47 批：主区顶部居中的提示胶囊（Kimi 首页顶部胶囊同位），不再是整宽黄条
          <div className={`top-notice ${reminder.tone === "red" ? "tone-red" : "tone-orange"}`} role="status">
            <span className="top-notice-text">{reminder.text}</span>
            <button
              className="btn-link"
              onClick={() => {
                // 还没有恢复包：回到开通向导一步一步做；其余情形到“设置 · 备份与安全”并滚到“恢复与备份”那一行（复核 R2B-23）
                if (reminder.kind === "package") return nav("/welcome");
                nav("/connections/backup");
                setTimeout(() => document.getElementById("recovery-backup")?.scrollIntoView({ block: "center" }), 300);
              }}
            >
              {reminder.kind === "package" ? "去完成 →" : "去设置 →"}
            </button>
            {reminder.tone === "orange" && (
              <button className="btn-link banner-later" onClick={snooze}>
                明天提醒
              </button>
            )}
          </div>
        )}
        <ErrorBoundary key={routeKey} routeLabel={route.page}>
          <Page route={route} />
        </ErrorBoundary>
      </div>
      {searching && <SearchPalette onClose={() => setSearching(false)} />}
      {guide && route.page === "home" && <GuideTour hasMatters={guide.hasMatters} onFinish={finishGuide} onNewMatter={() => window.dispatchEvent(new Event(NEW_MATTER))} />}
      <AskHost />
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
              className="btn-primary btn-sm"
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
            className="btn-ghost btn-sm"
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
            className="btn-ghost btn-sm"
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
    case "connections":
      return <ConnectionsPage tab={route.tab} />;
    case "chat":
      return <ChatPage conversationId={route.conversationId} />;
    case "reminders":
      return <RemindersPage {...(route.newForMatter ? { newForMatter: route.newForMatter } : {})} />;
    case "welcome":
      return <WelcomePage />;
    case "inbox":
      return <NotOpenPage title="收件区" phase="" lines={["收件区即将推出：手机和工作群发来的文件先放这里，再归入事项。"]} />;
  }
}
