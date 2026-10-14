/** 左侧栏（第 03 篇 §4.1：Kimi Work 入口 → 发行版入口）。未开放的入口不占一级导航；状态用律师语言，只在异常时变色（UIUX P0-6）。 */
import { useEffect, useState, type ReactNode } from "react";
import { api, type Matter } from "../api.ts";
import { nav, type Route } from "../App.tsx";
import { Icon } from "./Icons.tsx";
import { onDataChanged } from "../lib/events.ts";

interface Item {
  key: Route["page"];
  label: string;
  icon: () => ReactNode;
  href: string;
  phase?: string;
}

const ITEMS: Item[] = [
  { key: "home", label: "新建任务", icon: Icon.plus, href: "/" },
  { key: "matters", label: "事项", icon: Icon.folder, href: "/matters" },
  { key: "deliverables", label: "交付件", icon: Icon.file, href: "/deliverables" },
  { key: "methods", label: "方法与模板", icon: Icon.book, href: "/methods" },
  { key: "boards", label: "看板", icon: Icon.board, href: "/boards" },
  { key: "chat", label: "问答", icon: Icon.chat, href: "/chat" },
  { key: "connections", label: "设置", icon: Icon.plug, href: "/connections" },
];

export function Sidebar({ route }: { route: Route }) {
  const [matters, setMatters] = useState<Matter[]>([]);
  const [pending, setPending] = useState(0);
  const [status, setStatus] = useState<{ gate: boolean | null; unresolved: number }>({ gate: null, unresolved: 0 });
  // 执行域标注由能力账本推出（复核 S5-A10：W 不可用时如实写“未隔离：不运行代码”）
  const [execOk, setExecOk] = useState<boolean | null>(true);
  const [tick, setTick] = useState(0);
  useEffect(() => onDataChanged(() => setTick((t) => t + 1)), []);
  useEffect(() => {
    api.listMatters().then((r) => setMatters(r.matters)).catch(() => {});
    api.pending().then((r) => setPending(r.count)).catch(() => {});
    api
      .kernelStatus()
      .then((s) => setStatus({ gate: s.egress_gate ? true : false, unresolved: s.egress_gate?.unresolved ?? 0 }))
      .catch(() => setStatus({ gate: null, unresolved: 0 }));
    api
      .capabilities()
      .then((c) => setExecOk(c.execution_domain.available === false ? false : c.execution_domain.available === null ? null : true))
      .catch(() => {});
  }, [route.page, tick]);
  // 底部状态：正常时一句“本机运行 · 防护正常”；只有出问题时变色并说明（技术细节在“设置 · 本机与安全”）
  const footTitle = status.gate === null ? "正在启动…" : status.unresolved > 0 ? "有联网记录需要核对" : execOk === false ? "本机运行 · 代码分析暂不可用" : "本机运行 · 防护正常";
  const footNote = status.gate === null ? "" : status.unresolved > 0 ? `${status.unresolved} 条因中断无法确认是否发出` : execOk === false ? "其余功能正常" : "";
  const footTone = status.gate === null ? "dot-off" : status.unresolved > 0 || execOk === false ? "dot-warn" : "dot-ok";
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
              {it.phase && <span className="phase">{it.phase}</span>}
            </button>
          );
        })}
      </nav>
      <div className="sidebar-section">最近事项</div>
      <div className="sidebar-list">
        {matters.length === 0 && <div className="sidebar-empty">还没有事项</div>}
        {matters.slice(0, 8).map((m) => (
          <button key={m.matter_id} className={`sidebar-link${activeMatter === m.matter_id ? " active" : ""}`} onClick={() => nav(`/matter/${m.matter_id}`)} title={m.title}>
            {m.title}
          </button>
        ))}
      </div>
      <button className="sidebar-foot" onClick={() => nav("/connections/device")} title="本机与安全">
        <span className={`dot ${footTone}`} />
        <span>
          {footTitle}
          {footNote && <small>{footNote}</small>}
        </span>
      </button>
    </aside>
  );
}
