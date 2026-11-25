/**
 * 左侧栏（第 47 批对照 Kimi Work 桌面端重做信息架构）：
 * 顶部品牌 + 搜索 + 收起 → Work / Chat 切换 → Work：新建任务（⌘K）、成果、期限提醒、方法库，下面“事项”“任务”两个可折叠分组
 * （对应 Kimi 的“项目”“任务”）；Chat：新建问答与问答记录（问答页不再自带左侧列表）→ 底部用户卡（头像、姓名、套餐标识），点开是用户菜单
 * （额度一行、套餐与用量、设置、上手指南、退出登录），与 Kimi 头像菜单同位。
 * 未开放的入口不占一级导航（远程控制、应用等不做）；状态用律师语言，只在异常时变色（UIUX P0-6）。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { newTaskHref } from "../lib/nav-target.ts";
import { account, api, members, onKernelEvent, type Matter, type QuotaStatus } from "../api.ts";
import { nav, OPEN_GUIDE, requestNewMatter, type Route } from "../App.tsx";
import { Icon } from "./Icons.tsx";
import { BrandLockup, KimiMark } from "./Brand.tsx";
import { notifyAccountChanged } from "./AccountPanel.tsx";
import { onDataChanged } from "../lib/events.ts";
import { sidebarFoot, userCardText } from "../lib/user-card.ts";
import { planBadge, quotaMenuLine } from "../lib/quota-notice.ts";
import { runName } from "../lib/labels.ts";
import { NARROW_QUERY, sidebarState } from "../lib/sidebar-state.ts";

interface Item {
  key: Route["page"];
  label: string;
  icon: () => ReactNode;
  href: string;
}

// Work 模式一级入口（Kimi：看板 / 插件 / 任务中心 …）：成果（待复核）、期限提醒、方法库（法律方法与模板，对应 Kimi“插件”的位置）。
// 事项、任务改为下面的分组（对应 Kimi 的“项目”“任务”）；问答移到顶部 Work / Chat 切换。
const WORK_NAV: Item[] = [
  { key: "deliverables", label: "成果", icon: Icon.file, href: "/deliverables" },
  { key: "reminders", label: "期限提醒", icon: Icon.bell, href: "/reminders" },
  { key: "methods", label: "方法库", icon: Icon.plug, href: "/methods" },
];

/** 侧栏收起（对齐 Kimi：头部右侧的收起按钮；收起后点品牌标识展开）记在本机偏好。 */
const COLLAPSE_KEY = "kwl.sidebar.collapsed";
/** 分组折叠（Kimi“项目 ⌄”“任务 ⌄”）记在本机偏好。 */
const SECTIONS_KEY = "kwl.sidebar.sections";
function savedCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}
function savedSections(): { matters: boolean; tasks: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? "{}");
    return { matters: v.matters !== false, tasks: v.tasks !== false };
  } catch {
    return { matters: true, tasks: true };
  }
}
/** 窗口是否窄于 900px（侧栏自动收起）；随窗口缩放更新。 */
function useNarrow(): boolean {
  const query = (): boolean => {
    try {
      return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(NARROW_QUERY).matches;
    } catch {
      return false;
    }
  };
  const [narrow, setNarrow] = useState(query);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(NARROW_QUERY);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return narrow;
}
const MOD = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform) ? "⌘" : "Ctrl";

type RecentRun = { run_id: string; matter_id: string; matter_title: string; scenario: string; status: string; updated_at: string; goal: string; title?: string | null };

export function Sidebar({ route }: { route: Route }) {
  const [collapsed, setCollapsed] = useState(savedCollapsed);
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      } catch {
        // 记不住也不影响本次
      }
      return !c;
    });
  const [sections, setSections] = useState(savedSections);
  const toggleSection = (k: "matters" | "tasks") =>
    setSections((s) => {
      const next = { ...s, [k]: !s[k] };
      try {
        localStorage.setItem(SECTIONS_KEY, JSON.stringify(next));
      } catch {
        // 同上
      }
      return next;
    });
  const mode: "work" | "chat" = route.page === "chat" ? "chat" : "work";
  const [matters, setMatters] = useState<Matter[]>([]);
  // 侧栏列表的读取状态（第 51 批）：没读到不能显示成“还没有事项 / 任务”（失败不是空）
  const [listState, setListState] = useState<{ matters: "loading" | "ready" | "error"; runs: "loading" | "ready" | "error" }>({ matters: "loading", runs: "loading" });
  const [runs, setRuns] = useState<RecentRun[]>([]);
  const [waitingRuns, setWaitingRuns] = useState<Set<string>>(new Set());
  const [chats, setChats] = useState<{ conversation_id: string; title: string; updated_at: string }[]>([]);
  const [pending, setPending] = useState(0);
  const [unreadReminders, setUnreadReminders] = useState(0);
  const [status, setStatus] = useState<{ gate: boolean | null; unresolved: number }>({ gate: null, unresolved: 0 });
  // 执行域标注由能力账本推出（复核 S5-A10：W 不可用时如实写“未隔离：不运行代码”）
  const [execOk, setExecOk] = useState<boolean | null>(true);
  const [tick, setTick] = useState(0);
  const [me, setMe] = useState<{ name: string | null; firm: string | null; admin: boolean; email: string | null; edition?: "trial" | "release" | "dev" | null } | null>(null);
  // 有入组申请等这台电脑批准（B-3 余项）：只问管理员电脑；内核 60 秒内复用上次结果
  const [joins, setJoins] = useState(0);
  // 额度（用户卡上的套餐标识、菜单里的额度一行）：要经控制面取，开机取一次，之后每 5 分钟、打开菜单时再取
  const [quota, setQuota] = useState<QuotaStatus | null>(null);
  const loadQuota = () => void api.quotaStatus().then(setQuota).catch(() => {});
  useEffect(() => {
    loadQuota();
    const t = setInterval(loadQuota, 5 * 60_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => onDataChanged(() => setTick((t) => t + 1)), []);
  // 任务状态变化（开始等待、结束）时刷新侧栏状态点；运行中另每 5 秒刷新一次
  useEffect(() => onKernelEvent((m) => (m?.type === "run.updated" || m?.type === "run.settled" || m?.type === "reminder.due" ? setTick((t) => t + 1) : undefined)), []);
  const anyActive = matters.some((m) => (m.activity?.waiting ?? 0) + (m.activity?.running ?? 0) > 0);
  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(() => setTick((x) => x + 1), 5000);
    return () => clearInterval(t);
  }, [anyActive]);
  // 窗口标题前缀“(N) ”：N 为等你确认的任务数（任务栏上也能看到）
  const waitingTotal = matters.reduce((n, m) => n + (m.activity?.waiting ?? 0), 0);
  useEffect(() => {
    const base = "Kimi Work 法律行业发行版";
    document.title = waitingTotal > 0 ? `(${waitingTotal}) ${base}` : base;
  }, [waitingTotal]);
  useEffect(() => {
    api
      .listMatters()
      .then((r) => {
        setMatters(r.matters.filter((m) => (m.lifecycle ?? "active") === "active"));
        setListState((s) => ({ ...s, matters: "ready" }));
      })
      .catch(() => setListState((s) => ({ ...s, matters: "error" })));
    api
      .recentRuns(8)
      .then((r) => {
        setRuns(r.runs);
        setWaitingRuns(new Set(r.waiting.map((w) => w.run_id)));
        setListState((s) => ({ ...s, runs: "ready" }));
      })
      .catch(() => setListState((s) => ({ ...s, runs: "error" })));
    api.pending().then((r) => setPending(r.count)).catch(() => {});
    api.remindersUnread().then((r) => setUnreadReminders(r.unread)).catch(() => {});
    api
      .kernelStatus()
      .then((s) => {
        setStatus({ gate: s.egress_gate ? true : false, unresolved: s.egress_gate?.unresolved ?? 0 });
        const admin = s.member_role === "firm_admin" || s.member_role === "partner";
        setMe({
          name: s.activation?.member?.name ?? null,
          firm: s.activation?.firm?.name ?? null,
          admin,
          email: (s as { account?: { email?: string } }).account?.email ?? null,
          edition: (s as { edition?: "trial" | "release" | "dev" }).edition ?? null,
        });
        // 只有管理员能批准入组（控制面只认管理员证书；复核 RB16B-18：合伙人不问）；没有控制面或本机没有有效邀请时内核直接报 0，不联网
        if (s.member_role === "firm_admin")
          members
            .attention()
            .then((a) => setJoins(a.pending_joins))
            .catch(() => setJoins(0));
        else setJoins(0);
      })
      .catch(() => setStatus({ gate: null, unresolved: 0 }));
    api
      .capabilities()
      .then((c) => setExecOk(c.execution_domain.available === false ? false : c.execution_domain.available === null ? null : true))
      .catch(() => {});
  }, [route.page, tick]);
  // Chat 模式的问答记录（问答页发送、删除后经 notifyDataChanged 刷新）
  useEffect(() => {
    if (mode !== "chat") return;
    api.chatList().then((r) => setChats(r.conversations)).catch(() => setChats([]));
  }, [mode, tick, route.page === "chat" ? route.conversationId : null]);
  // 底部状态：正常时不占位（Kimi 用户卡只有头像、姓名、套餐）；出问题时变色并说明（技术细节在“设置 · 备份与安全”）
  const foot = sidebarFoot({ gate: status.gate, unresolved: status.unresolved, execOk, pendingJoins: joins });
  const { title: footTitle, note: footNote, tone: footTone } = foot;
  const card = userCardText(me, { title: footTitle, note: footNote });
  const activeMatter = route.page === "matter" || route.page === "run" ? route.matterId : null;
  const activeRun = route.page === "run" ? route.runId : null;
  const activeChat = route.page === "chat" ? (route.conversationId ?? null) : null;
  // 收起状态只在这里算（第 49 批，lib/sidebar-state.ts 写明根因）：手动收起记偏好；执行态三栏页与窄窗口自动收起，
  // 律师可临时展开，换页或窗口宽窄变化即复位
  const narrow = useNarrow();
  const forced = route.page === "run";
  const [peek, setPeek] = useState(false);
  useEffect(() => setPeek(false), [route.page, narrow]);
  const { compact, auto } = sidebarState({ collapsedPref: collapsed, forced, narrow, peek });
  const toggle = () => (auto ? setPeek((p) => !p) : toggleCollapsed());
  const badge = planBadge(quota);
  return (
    <aside className={`sidebar${compact ? " compact" : ""}`} data-tour="sidebar">
      <div className="brand">
        {compact ? (
          // 收起：只留标识，兼作展开按钮；悬停时换成“展开”图标（Kimi 同款），让人知道点了会展开
          <button className="brand-mark-btn" onClick={toggle} title="展开侧栏" aria-label="展开侧栏" aria-expanded={false}>
            <KimiMark className="brand-logo" />
            <span className="brand-expand-ico" aria-hidden="true">
              {Icon.sidebar()}
            </span>
          </button>
        ) : (
          <span className="brand-name">
            <BrandLockup />
          </span>
        )}
        {!compact && (
          <>
            <button className="sidebar-toggle" onClick={() => window.dispatchEvent(new Event("kwl:search"))} title={`搜索事项、任务、成果（${MOD} F）`} aria-label="搜索">
              {Icon.search()}
            </button>
            <button className="sidebar-toggle" onClick={toggle} title="收起侧栏" aria-label="收起侧栏" aria-expanded={true}>
              {Icon.sidebar()}
            </button>
          </>
        )}
      </div>
      {/* 收起时搜索移到图标栏里（展开时在品牌行右侧），两种状态都能直接搜 */}
      {compact && (
        <button className="nav-item nav-rail-only nav-rail-search" onClick={() => window.dispatchEvent(new Event("kwl:search"))} title={`搜索事项、任务、成果（${MOD} F）`} aria-label="搜索">
          <span className="nav-icon">{Icon.search()}</span>
        </button>
      )}
      {/* Work / Chat（Kimi Work 同款分段切换）：Work = 在事项里发起任务；Chat = 不读事项材料的法律问答 */}
      <div className="mode-switch" role="tablist" aria-label="工作模式">
        <button role="tab" aria-selected={mode === "work"} className={`mode-tab${mode === "work" ? " active" : ""}`} onClick={() => mode !== "work" && nav("/")} title="Work：在事项里发起任务">
          <span className="nav-icon">{Icon.monitor()}</span>
          <span className="nav-label">Work</span>
        </button>
        <button role="tab" aria-selected={mode === "chat"} className={`mode-tab${mode === "chat" ? " active" : ""}`} onClick={() => mode !== "chat" && nav("/chat")} title="Chat：法律问答（不读事项材料）" data-tour="nav-chat">
          <span className="nav-icon">{Icon.chat()}</span>
          <span className="nav-label">Chat</span>
        </button>
      </div>
      {mode === "work" ? (
        <>
          <nav className="nav">
            <button className={`nav-item nav-new${route.page === "home" ? " active" : ""}`} onClick={() => nav(newTaskHref("/", route))} title={`新建任务（${MOD} K）`}>
              <span className="nav-icon">{Icon.plus()}</span>
              <span className="nav-label">新建任务</span>
              <span className="nav-kbd" aria-hidden="true">
                <kbd>{MOD}</kbd>
                <kbd>K</kbd>
              </span>
            </button>
            {WORK_NAV.map((it) => {
              const active = route.page === it.key || (it.key === "deliverables" && route.page === "review");
              return (
                <button key={it.key} className={`nav-item${active ? " active" : ""}`} onClick={() => nav(it.href)} title={it.label} data-tour={`nav-${it.key}`}>
                  <span className="nav-icon">{it.icon()}</span>
                  <span className="nav-label">{it.label}</span>
                  {it.key === "deliverables" && pending > 0 && <span className="badge" aria-label={`${pending} 份待复核`}>{pending}</span>}
                  {it.key === "reminders" && unreadReminders > 0 && <span className="badge" aria-label={`${unreadReminders} 条未读提醒`}>{unreadReminders}</span>}
                </button>
              );
            })}
            {/* 收起时“事项”分组整块隐藏：给一个图标入口去全部事项（展开时由分组标题的“全部”承担），否则执行态里回不到事项列表 */}
            {compact && (
              <button className={`nav-item nav-rail-only${route.page === "matters" ? " active" : ""}`} onClick={() => nav("/matters")} title="全部事项" aria-label="全部事项">
                <span className="nav-icon">{Icon.folder()}</span>
                {waitingTotal > 0 && <span className="badge" aria-label={`${waitingTotal} 个任务等你确认`}>{waitingTotal}</span>}
              </button>
            )}
          </nav>
          <div className="sidebar-scroll">
            {/* 上手指南“先建事项”聚光这一组（标题 + 列表） */}
            <div className="sidebar-group" data-tour="nav-matters">
            <SectionHead label="事项" open={sections.matters} onToggle={() => toggleSection("matters")} active={route.page === "matters"}>
              <button className="section-act" onClick={() => requestNewMatter()} title="新建事项" aria-label="新建事项">
                {Icon.plus()}
              </button>
              <button className="section-act section-all" onClick={() => nav("/matters")} title="全部事项">
                全部
              </button>
            </SectionHead>
            {sections.matters && (
              <div className="sidebar-list">
                {listState.matters === "error" && matters.length === 0 && <div className="sidebar-empty-text">没有读到事项，稍后会重新读取</div>}
                {listState.matters === "ready" && matters.length === 0 && (
                  <button className="sidebar-empty" onClick={() => requestNewMatter()}>
                    还没有事项，新建一个
                  </button>
                )}
                {matters.slice(0, 8).map((m) => (
                  <button
                    key={m.matter_id}
                    className={`sidebar-link${activeMatter === m.matter_id ? " active" : ""}`}
                    onClick={() => nav(m.activity?.waiting_run_id ? `/run/${m.activity.waiting_run_id}/${m.matter_id}` : `/matter/${m.matter_id}`)}
                    title={m.activity?.waiting ? `${m.title}（有任务等你确认）` : m.activity?.running ? `${m.title}（有任务进行中）` : m.title}
                  >
                    {/* 状态点：视觉圆点 + 读屏文字（复核 B4-B18：无角色的 span 上的 aria-label 多数读屏不朗读） */}
                    {m.activity?.waiting ? (
                      <>
                        <span className="act-dot act-wait" aria-hidden="true" />
                        <span className="sr-only">等你确认：</span>
                      </>
                    ) : m.activity?.running ? (
                      <>
                        <span className="act-dot act-run" aria-hidden="true" />
                        <span className="sr-only">进行中：</span>
                      </>
                    ) : null}
                    {m.title}
                  </button>
                ))}
                {matters.length > 8 && (
                  <button className="sidebar-more" onClick={() => nav("/matters")}>
                    查看全部 {matters.length} 个事项
                  </button>
                )}
              </div>
            )}
            </div>
            <SectionHead label="任务" open={sections.tasks} onToggle={() => toggleSection("tasks")} />
            {sections.tasks && (
              <div className="sidebar-list">
                {listState.runs === "error" && runs.length === 0 && <div className="sidebar-empty-text">没有读到任务，稍后会重新读取</div>}
                {listState.runs === "ready" && runs.length === 0 && <div className="sidebar-empty-text">还没有任务</div>}
                {runs.map((r) => {
                  const wait = waitingRuns.has(r.run_id) || r.status === "waiting";
                  const live = !wait && (r.status === "running" || r.status === "queued");
                  return (
                    <button key={r.run_id} className={`sidebar-link${activeRun === r.run_id ? " active" : ""}`} onClick={() => nav(`/run/${r.run_id}/${r.matter_id}`)} title={`${runName(r, 60)} · ${r.matter_title}`}>
                      {wait ? (
                        <>
                          <span className="act-dot act-wait" aria-hidden="true" />
                          <span className="sr-only">等你确认：</span>
                        </>
                      ) : live ? (
                        <>
                          <span className="act-dot act-run" aria-hidden="true" />
                          <span className="sr-only">进行中：</span>
                        </>
                      ) : null}
                      {runName(r)}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          <nav className="nav">
            <button className={`nav-item nav-new${route.page === "chat" && !route.conversationId ? " active" : ""}`} onClick={() => nav("/chat")} title="新建问答">
              <span className="nav-icon">{Icon.plus()}</span>
              <span className="nav-label">新建问答</span>
            </button>
          </nav>
          <div className="sidebar-scroll">
            <SectionHead label="问答记录" open onToggle={null} />
            <div className="sidebar-list">
              {chats.length === 0 && <div className="sidebar-empty-text">还没有问答</div>}
              {chats.map((c) => (
                <button key={c.conversation_id} className={`sidebar-link${activeChat === c.conversation_id ? " active" : ""}`} onClick={() => nav(`/chat/${c.conversation_id}`)} title={c.title}>
                  {c.title}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
      <UserCard
        card={card}
        badge={badge}
        me={me}
        quota={quota}
        foot={foot}
        settingsActive={route.page === "connections"}
        onOpen={loadQuota}
      />
    </aside>
  );
}

/** 分组标题（Kimi“项目 ⌄”）：点标题折叠；右侧放本组的操作。 */
function SectionHead(props: { label: string; open: boolean; onToggle: (() => void) | null; active?: boolean; children?: ReactNode }) {
  return (
    <div className={`sidebar-section${props.active ? " active" : ""}`}>
      {props.onToggle ? (
        <button className="side-sec-title" onClick={props.onToggle} aria-expanded={props.open}>
          {props.label}
          <span className={`section-caret${props.open ? "" : " closed"}`} aria-hidden="true">
            {Icon.down()}
          </span>
        </button>
      ) : (
        <span className="side-sec-title">{props.label}</span>
      )}
      {props.children && <span className="section-acts">{props.children}</span>}
    </div>
  );
}

/**
 * 底部用户卡与用户菜单（Kimi：头像 + 姓名 + 套餐标识，点开是菜单）。
 * 菜单：姓名、邮箱、律所；异常状态一行（有问题时）；额度一行；套餐与用量、设置、上手指南、退出登录（就地确认）。
 */
function UserCard(props: {
  card: ReturnType<typeof userCardText>;
  badge: string | null;
  me: { name: string | null; firm: string | null; email: string | null } | null;
  quota: QuotaStatus | null;
  foot: ReturnType<typeof sidebarFoot>;
  settingsActive: boolean;
  onOpen: () => void;
}) {
  const { card, badge, foot } = props;
  const footTone = foot.tone;
  const [open, setOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [logoutMsg, setLogoutMsg] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  useEffect(() => {
    if (!open) {
      setConfirmLogout(false);
      setLogoutMsg("");
    }
  }, [open]);
  // 换页（含快捷键、浏览器前进后退）时收起菜单
  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener("hashchange", close);
    return () => window.removeEventListener("hashchange", close);
  }, []);
  const go = (path: string) => {
    setOpen(false);
    nav(path);
  };
  const usageLine = quotaMenuLine(props.quota);
  const warn = footTone !== "dot-ok";
  return (
    <div className="user-wrap" ref={ref}>
      {open && (
        <div className="popover user-menu" role="menu" aria-label="账号菜单">
          <div className="user-menu-head">
            <span className="user-avatar user-avatar-lg" aria-hidden="true">{card.avatar}</span>
            <span className="user-menu-who">
              <span className="user-name-row">
                <b>{card.name}</b>
                {badge && <span className="plan-badge">{badge}</span>}
              </span>
              {props.me?.email && <small>{props.me.email}</small>}
              {card.firm && <small>{card.firm}</small>}
            </span>
          </div>
          {/* 本机状态（第 66 批）：正常时不显示（个人产品不需要“防护正常”这类研发状态）；有问题时一行变色说明、点开去处理 */}
          {warn && (
            <button className="menu-row user-menu-status warn" role="menuitem" onClick={() => go(foot.href)}>
              <span className={`dot ${footTone}`} aria-hidden="true" />
              <span className="menu-row-text">
                {foot.title}
                {foot.note ? `：${foot.note}` : ""}
              </span>
            </button>
          )}
          <div className="menu-sep" role="separator" />
          <button className="menu-row" role="menuitem" onClick={() => go("/connections/usage")}>
            <span className="nav-icon">{Icon.chart()}</span>
            <span className="menu-row-text">套餐与用量</span>
            {usageLine && <span className="menu-row-meta">{usageLine}</span>}
          </button>
          <button className="menu-row" role="menuitem" onClick={() => go("/connections")}>
            <span className="nav-icon">{Icon.gear()}</span>
            <span className="menu-row-text">设置</span>
          </button>
          <button
            className="menu-row"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              window.dispatchEvent(new Event(OPEN_GUIDE));
            }}
          >
            <span className="nav-icon">{Icon.compass()}</span>
            <span className="menu-row-text">上手指南</span>
          </button>
          <div className="menu-sep" role="separator" />
          {confirmLogout ? (
            <div className="user-menu-confirm" role="alertdialog" aria-label="退出登录">
              <p>退出后这台电脑的 AI 处理会暂停，直到你重新登录；本机的事项、文件和成果照常保留。</p>
              <div className="user-menu-confirm-acts">
                <button
                  className="btn-danger btn-sm"
                  onClick={() =>
                    void account
                      .logout()
                      .then(() => {
                        notifyAccountChanged();
                        setOpen(false);
                      })
                      .catch((e) => setLogoutMsg(`没有退出成功：${(e as Error).message}`))
                  }
                >
                  退出登录
                </button>
                <button className="btn-ghost btn-sm" onClick={() => setConfirmLogout(false)}>
                  取消
                </button>
              </div>
              {logoutMsg && <p className="user-menu-err" role="alert">{logoutMsg}</p>}
            </div>
          ) : (
            <button className="menu-row" role="menuitem" onClick={() => setConfirmLogout(true)}>
              <span className="nav-icon">{Icon.logout()}</span>
              <span className="menu-row-text">退出登录</span>
            </button>
          )}
        </div>
      )}
      <button
        className={`sidebar-foot${open || props.settingsActive ? " active" : ""}`}
        onClick={() => {
          if (!open) props.onOpen();
          setOpen((o) => !o);
        }}
        title={card.tooltip}
        data-tour="settings"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="user-avatar" aria-hidden="true">
          {card.avatar}
          {/* 侧栏收窄时只剩头像：状态点挂在头像右上角（复核 R15B-23） */}
          {warn && <span className={`dot avatar-dot ${footTone}`} />}
        </span>
        <span className="user-text">
          <span className="user-name-row">
            <b>{card.name}</b>
            {badge && <span className="plan-badge">{badge}</span>}
          </span>
          {/* 正常时不占位；有问题时一行说明 */}
          {warn && (
            <small>
              <span className={`dot ${footTone}`} /> {foot.title}
            </small>
          )}
        </span>
        <span className="sr-only">账号与设置</span>
      </button>
    </div>
  );
}
