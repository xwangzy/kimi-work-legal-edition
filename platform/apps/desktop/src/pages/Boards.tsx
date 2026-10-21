/**
 * 看板（第 03 篇 §4.1：事项看板——期限、待办、风险；团队看板——待签发、负载、用量；最多 2 个看板、每板 20 个小组件，沿用 Kimi Work 限制）。
 * G0：固定布局的“我的看板”与“事项看板”，组件只用本机账本里已有的事实；拖拽、缩放与批注未开放（如实标注）。
 */
import { useEffect, useState } from "react";
import { api, type Matter } from "../api.ts";
import { nav } from "../App.tsx";
import { fmtRelative, RUN_STATUS_LABELS, SCENARIO_LABELS } from "../lib/labels.ts";
import { dueText, reminderKindLabel, upcomingDeadlines } from "../lib/reminders.ts";
import type { ReminderItem } from "../api.ts";
import { Select } from "../components/Select.tsx";

export const MAX_BOARDS = 2;
export const MAX_WIDGETS = 20;

function Widget({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="widget">
      <div className="widget-title">{title}</div>
      <div className="widget-body">{children}</div>
    </div>
  );
}

export function MatterBoard({ matter, runs }: { matter: Matter; runs: any[] }) {
  const [pendingReview, setPendingReview] = useState<any[]>([]);
  const [egress, setEgress] = useState<{ sent: number; blocked: number; unknown: number }>({ sent: 0, blocked: 0, unknown: 0 });
  // 期限卡同时列本事项的期限提醒（复核 Q1-18：“填期限”打开的是提醒表单，填完回来卡片要能看到）
  const [reminders, setReminders] = useState<ReminderItem[]>([]);
  useEffect(() => {
    api.pending().then((r) => setPendingReview(r.pending.filter((p: any) => !p.matter_id || p.matter_id === matter.matter_id))).catch(() => {});
    api.reminders(matter.matter_id).then((r) => setReminders(upcomingDeadlines(r.reminders, Date.now(), 3650))).catch(() => setReminders([]));
    api
      .egressRecords({ matterId: matter.matter_id })
      .then((r) =>
        setEgress({
          sent: r.records.filter((x) => (x.outcome ?? "sent") === "sent").length,
          blocked: r.records.filter((x) => x.outcome === "blocked").length,
          unknown: r.records.filter((x) => x.outcome === "unknown").length,
        }),
      )
      .catch(() => {});
  }, [matter.matter_id]);
  const dates = Object.entries(matter.key_dates ?? {}).filter(([, v]) => !!v);
  const waiting = runs.filter((r) => r.status === "waiting_approval" || r.status === "waiting_input");
  return (
    <div className="board">
      <Widget title="期限">
        {/* 空状态给动作（v9.4 U1 §3.4）：“填期限”直接打开本事项的设提醒表单 */}
        {reminders.slice(0, 3).map((r) => (
          <div key={r.reminder_id} className="w-row">
            <span>{r.note || reminderKindLabel(r.kind)}</span>
            <b title={r.due_date}>{dueText(r.due_date)}</b>
          </div>
        ))}
        {dates.length === 0 && reminders.length === 0 ? (
          <p className="muted">
            开庭日、举证期限填在这里，到时提醒你。{" "}
            {(matter.lifecycle ?? "active") === "active" && !matter.is_sample && (
              <button className="btn-link" onClick={() => nav(`/reminders/new/${encodeURIComponent(matter.matter_id)}`)}>
                填期限
              </button>
            )}
          </p>
        ) : (
          dates.map(([k, v]) => <div key={k} className="w-row"><span>{k === "analysis_as_of" ? "分析截止日" : k}</span><b>{v}</b></div>)
        )}
      </Widget>
      <Widget title="待办">
        {waiting.length === 0 && pendingReview.length === 0 && <p className="muted">没有等你处理的事。</p>}
        {waiting.map((r) => (
          <button key={r.run_id} className="w-link" onClick={() => nav(`/run/${r.run_id}/${matter.matter_id}`)}>
            {SCENARIO_LABELS[r.scenario] ?? r.scenario} · {RUN_STATUS_LABELS[r.status]}
          </button>
        ))}
        {pendingReview.map((p) => (
          <button key={p.artifact_version_id} className="w-link" onClick={() => nav(`/review/${p.artifact_version_id}`)}>
            待复核：{p.filename}
          </button>
        ))}
      </Widget>
      <Widget title="最近任务">
        {runs.length === 0 && <p className="muted">还没有任务。</p>}
        {runs.slice(0, 6).map((r) => (
          // 任务以目标前 20 字区分（Y4 B-2）；没有目标的显示场景名；时间用相对时间
          <button key={r.run_id} className="w-link" onClick={() => nav(`/run/${r.run_id}/${matter.matter_id}`)}>
            {r.goal ? `${String(r.goal).slice(0, 20)}${String(r.goal).length > 20 ? "…" : ""}` : (SCENARIO_LABELS[r.scenario] ?? "任务")} · {RUN_STATUS_LABELS[r.status] ?? "状态未知"} · {fmtRelative(r.created_at)}
          </button>
        ))}
      </Widget>
      {/* 发送记录不再常驻概览（v9.4 U1 #9：律师不需要每天看监控指标）；只有需要核实时才出现，完整记录在“⋯ → 数据去向记录” */}
      {egress.unknown > 0 && (
        <Widget title="需要你核实">
          <p>{egress.unknown} 条记录不确定是否已经发出，请在“⋯ → 数据去向记录”里逐条核实。</p>
        </Widget>
      )}
    </div>
  );
}

export function BoardsPage() {
  const [matters, setMatters] = useState<Matter[]>([]);
  const [matterId, setMatterId] = useState<string | null>(null);
  const [matter, setMatter] = useState<Matter | null>(null);
  const [runs, setRuns] = useState<any[]>([]);
  const [pendingReview, setPendingReview] = useState<any[]>([]);
  const [unresolved, setUnresolved] = useState<any[]>([]);
  useEffect(() => {
    api
      .listMatters()
      .then((r) => {
        setMatters(r.matters);
        setMatterId((cur) => cur ?? r.matters[0]?.matter_id ?? null);
      })
      .catch(() => {});
    api.pending().then((r) => setPendingReview(r.pending)).catch(() => {});
    api.egressUnresolved().then((r) => setUnresolved(r.records)).catch(() => {});
  }, []);
  useEffect(() => {
    if (!matterId) return;
    api
      .getMatter(matterId)
      .then((r) => {
        setMatter(r.matter);
        setRuns(r.runs ?? []);
      })
      .catch(() => {});
  }, [matterId]);
  return (
    <main className="main">
      <div className="main-wide">
        <h1 className="page-title">看板</h1>
        <div className="section-title">我的看板</div>
        <div className="board">
          <Widget title="待复核 / 签发">
            {pendingReview.length === 0 && <p className="muted">没有待复核的成果。</p>}
            {pendingReview.slice(0, 8).map((p) => (
              <button key={p.artifact_version_id} className="w-link" onClick={() => nav(`/review/${p.artifact_version_id}`)}>
                {p.filename} · {p.matter_title}
              </button>
            ))}
          </Widget>
          <Widget title="事项">
            <div className="w-row"><span>进行中的事项</span><b>{matters.length}</b></div>
          </Widget>
          {/* 只在有需要核对的联网记录时出现（Y4 B-3） */}
          {unresolved.length > 0 && (
            <Widget title="需要核对的联网记录">
              <p>{unresolved.length} 条记录不确定是否已经发出，请在对应任务的“数据去向”里逐条确认。</p>
            </Widget>
          )}
        </div>
        <div className="section-title board-head">
          事项看板
          <Select aria-label="事项" value={matterId ?? ""} onChange={(v) => setMatterId(v || null)} placeholder="选择事项" options={matters.map((m) => ({ value: m.matter_id, label: m.title }))} />
        </div>
        {matter ? <MatterBoard matter={matter} runs={runs} /> : <p className="muted">还没有事项。</p>}
      </div>
    </main>
  );
}
