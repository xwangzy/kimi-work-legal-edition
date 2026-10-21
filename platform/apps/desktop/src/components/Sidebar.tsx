/** 左侧栏（第 03 篇 §4.1：Kimi Work 入口 → 发行版入口）。未开放的入口不占一级导航；状态用律师语言，只在异常时变色（UIUX P0-6）。 */
import { useEffect, useState, type ReactNode } from "react";
import { api, members, onKernelEvent, type Matter } from "../api.ts";
import { nav, type Route } from "../App.tsx";
import { Icon } from "./Icons.tsx";
import { onDataChanged } from "../lib/events.ts";
import { sidebarFoot, userCardText } from "../lib/user-card.ts";

interface Item {
  key: Route["page"];
  label: string;
  icon: () => ReactNode;
  href: string;
  phase?: string;
}

// 侧栏收敛（Z3 评审 IA-1、IA-2、#9）：“看板”与首页、事项页重复，“方法与模板”与首页场景卡重复，不再占一级入口；
// #/boards、#/methods 两个路由保留（首页“更多场景 →”进入方法与模板；事项页有本事项看板）。
// “设置”收进底部用户卡（Z3 IA-6、#9：姓名、律所名、齿轮；“本机运行 · 防护正常”降为卡片里的一行小字）
const ITEMS: Item[] = [
  { key: "home", label: "新建任务", icon: Icon.plus, href: "/" },
  { key: "matters", label: "事项", icon: Icon.folder, href: "/matters" },
  { key: "deliverables", label: "交付件", icon: Icon.file, href: "/deliverables" },
  { key: "reminders", label: "期限提醒", icon: Icon.bell, href: "/reminders" },
  { key: "chat", label: "问答", icon: Icon.chat, href: "/chat" },
];

export function Sidebar({ route }: { route: Route }) {
  const [matters, setMatters] = useState<Matter[]>([]);
  const [pending, setPending] = useState(0);
  const [unreadReminders, setUnreadReminders] = useState(0);
  const [status, setStatus] = useState<{ gate: boolean | null; unresolved: number }>({ gate: null, unresolved: 0 });
  // 执行域标注由能力账本推出（复核 S5-A10：W 不可用时如实写“未隔离：不运行代码”）
  const [execOk, setExecOk] = useState<boolean | null>(true);
  const [tick, setTick] = useState(0);
  const [me, setMe] = useState<{ name: string | null; firm: string | null; admin: boolean } | null>(null);
  // 有入组申请等这台电脑批准（B-3 余项）：只问管理员电脑；内核 60 秒内复用上次结果
  const [joins, setJoins] = useState(0);
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
    api.listMatters().then((r) => setMatters(r.matters)).catch(() => {});
    api.pending().then((r) => setPending(r.count)).catch(() => {});
    api.remindersUnread().then((r) => setUnreadReminders(r.unread)).catch(() => {});
    api
      .kernelStatus()
      .then((s) => {
        setStatus({ gate: s.egress_gate ? true : false, unresolved: s.egress_gate?.unresolved ?? 0 });
        const admin = s.member_role === "firm_admin" || s.member_role === "partner";
        setMe({ name: s.activation?.member?.name ?? null, firm: s.activation?.firm?.name ?? null, admin });
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
  // 底部状态：正常时一句“本机运行 · 防护正常”；只有出问题时变色并说明（技术细节在“设置 · 本机与安全”）
  const foot = sidebarFoot({ gate: status.gate, unresolved: status.unresolved, execOk, pendingJoins: joins });
  const { title: footTitle, note: footNote, tone: footTone } = foot;
  const card = userCardText(me, { title: footTitle, note: footNote });
  const activeMatter = route.page === "matter" || route.page === "run" ? route.matterId : null;
  // 任务执行态收为图标栏，给三栏（材料 | 进度 | 预览）让出宽度
  const compact = route.page === "run";
  return (
    <aside className={`sidebar${compact ? " compact" : ""}`}>
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">K</span>
        <span>
          Kimi Work
          <small>法律行业发行版</small>
        </span>
      </div>
      <nav className="nav">
        {ITEMS.map((it) => {
          const active = route.page === it.key || (it.key === "matters" && route.page === "matter") || (it.key === "deliverables" && route.page === "review");
          return (
            <button key={it.key} className={`nav-item${active ? " active" : ""}`} onClick={() => nav(it.href)} title={it.label}>
              <span className="nav-icon">{it.icon()}</span>
              <span className="nav-label">{it.label}</span>
              {it.key === "deliverables" && pending > 0 && <span className="badge">{pending}</span>}
              {it.key === "reminders" && unreadReminders > 0 && <span className="badge" aria-label={`${unreadReminders} 条未读提醒`}>{unreadReminders}</span>}
              {it.phase && <span className="phase">{it.phase}</span>}
            </button>
          );
        })}
      </nav>
      <div className="sidebar-section">最近事项</div>
      <div className="sidebar-list">
        {matters.length === 0 && <div className="sidebar-empty">还没有事项</div>}
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
      </div>
      <button className={`sidebar-foot${route.page === "connections" ? " active" : ""}`} onClick={() => nav(foot.href)} title={card.tooltip}>
        <span className="user-avatar" aria-hidden="true">
          {card.avatar}
          {/* 侧栏收窄时只剩头像：状态点挂在头像右上角（复核 R15B-23） */}
          <span className={`dot avatar-dot ${footTone}`} />
        </span>
        <span className="user-text">
          <b>{card.name}</b>
          {card.firm && <small>{card.firm}</small>}
          <small>
            <span className={`dot ${footTone}`} /> {footTitle}
            {footNote ? `：${footNote}` : ""}
          </small>
        </span>
        <span className="user-gear" aria-hidden="true">
          {Icon.gear()}
        </span>
        <span className="sr-only">设置</span>
      </button>
    </aside>
  );
}
