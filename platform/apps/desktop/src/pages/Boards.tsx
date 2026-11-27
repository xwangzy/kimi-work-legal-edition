/**
 * 看板（第 03 篇 §4.1：事项看板——期限、待办、风险；团队看板——待签发、负载、用量；最多 2 个看板、每板 20 个小组件，沿用 Kimi Work 限制）。
 * G0：固定布局的“我的看板”与“事项看板”，组件只用本机账本里已有的事实；拖拽、缩放与批注未开放（如实标注）。
 */
import { useEffect, useState } from "react";
import { api, type Matter } from "../api.ts";
import { nav } from "../App.tsx";
import { fmtRelative, RUN_STATUS_LABELS, runName } from "../lib/labels.ts";
import { dueText, dueTone, reminderKindLabel, upcomingDeadlines } from "../lib/reminders.ts";
import type { ReminderItem } from "../api.ts";
import { MatterTodos, PartiesInfoRow, PendingChecks, StageStrip } from "../components/MatterOverview.tsx";
import type { PartiesDocRow } from "../components/PartiesInfo.tsx";
import { ReviewRulesWidget, TemplateMethods } from "../components/MatterSetup.tsx";
import { matterLine } from "../lib/scenarios.ts";
import type { PendingCheck } from "../api.ts";

/** 任务状态的色调（概览“最近 AI 记录”的色点）：等你的橙、在跑的蓝、做完的绿、没做成的红，其余灰。 */
export function runTone(status: string): "warn" | "info" | "ok" | "danger" | "neutral" {
  if (status.startsWith("waiting") || status === "reconciling") return "warn";
  if (status === "running" || status === "queued") return "info";
  if (status === "succeeded" || status === "partial") return "ok";
  if (status === "failed" || status === "timed_out" || status === "expired") return "danger";
  return "neutral";
}

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

export function MatterBoard({ matter, runs, docs, onChanged, onGo, readOnly: lockedHere = false }: {
  matter: Matter;
  runs: any[];
  /** 本事项材料（当事人信息那一行用，D-224）；不给时不显示 */
  docs?: PartiesDocRow[];
  onChanged?: () => void;
  onGo?: (target: PendingCheck["target"]) => void;
  /** 第 73 批（11c T13）：事项页判定的只读（被移出 / 只看 / 结案，按 can_write）——概览不留伪操作（加待办、填期限、填写、现在填、阶段选择都不出）。 */
  readOnly?: boolean;
}) {
  const [egress, setEgress] = useState<{ sent: number; blocked: number; unknown: number }>({ sent: 0, blocked: 0, unknown: 0 });
  // 期限卡同时列本事项的期限提醒（复核 Q1-18：“填期限”打开的是提醒表单，填完回来卡片要能看到）
  const [reminders, setReminders] = useState<ReminderItem[]>([]);
  const [checks, setChecks] = useState(0);
  useEffect(() => {
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
  const readOnly = lockedHere || (matter.lifecycle ?? "active") !== "active" || !!matter.is_sample;
  return (
    <>
    {/* 阶段条与事件时点（v9.4 第 20 批 S-08、C1 §3.2）：当前阶段由律师点选 */}
    <StageStrip matter={matter} readOnly={readOnly || !onChanged} onChanged={onChanged ?? (() => {})} />
    {/* 当事人信息（D-224）：存一次，起诉状、律师函等文书的首部自动带入 */}
    {docs && <PartiesInfoRow matter={matter} docs={docs} readOnly={readOnly || !onChanged} onChanged={onChanged ?? (() => {})} />}
    {/* 事项类型的常用方法（v9.4 第 22 批，C1 #20） */}
    <TemplateMethods matter={matter} readOnly={readOnly} />
    {/* 固定两栏（第 27 批，评审 U2-29）：左边“等你处理”（待核 + 待办，与首页同名）与最近 AI 记录；右边期限、审查要点 */}
    <div className="board-2col">
      <div className="board-col">
        <Widget title="等你处理">
          {/* 统一待核清单（v9.4 第 21 批）在前：还等你核什么、去哪里核；没有时不占行 */}
          <PendingChecks matter={matter} hideEmpty onCount={setChecks} {...(onGo ? { onGo } : {})} />
          {/* 待办（C1 §3.2）：做什么、谁做、谁复核、期限；AI 完成的任务自动变成“待你复核” */}
          <MatterTodos matter={matter} readOnly={readOnly} othersCount={checks} />
        </Widget>
        <Widget title="最近 AI 记录">
          {runs.length === 0 && <p className="muted">还没有 AI 记录。</p>}
          {runs.slice(0, 6).map((r) => (
            // 任务以目标前 20 字区分（Y4 B-2）；没有目标的显示场景名；时间用相对时间
            // 第 55 批：名称、状态、时间分三段对齐（原来是一串“名称 · 状态 · 时间”的文字），状态带色点
            <button key={r.run_id} className="w-link w-run" onClick={() => nav(`/run/${r.run_id}/${matter.matter_id}`)}>
              <span className="w-run-name">{runName(r, 20)}</span>
              <span className={`w-run-status tone-${runTone(r.status)}`}>{RUN_STATUS_LABELS[r.status] ?? "状态未知"}</span>
              <span className="w-run-time">{fmtRelative(r.created_at)}</span>
            </button>
          ))}
        </Widget>
        {/* 发送记录不再常驻概览（v9.4 U1 #9）；只有需要核实时才出现，完整记录在“⋯ → 数据去向记录” */}
        {egress.unknown > 0 && (
          <Widget title="需要你核实">
            <p>{egress.unknown} 条记录不确定是否已经发出，请在“⋯ → 数据去向记录”里逐条核实。</p>
          </Widget>
        )}
      </div>
      <div className="board-col">
      <Widget title="期限">
        {/* 空状态给动作（v9.4 U1 §3.4）：“填期限”直接打开本事项的设提醒表单 */}
        {reminders.slice(0, 3).map((r) => (
          <div key={r.reminder_id} className="w-row">
            <span>{r.note || reminderKindLabel(r.kind)}</span>
            {/* 第 55 批：临近的期限用与期限提醒页同一套颜色（三天内红、七天内橙） */}
            <b title={r.due_date} className={dueTone(r.due_date) === "red" ? "due-red" : dueTone(r.due_date) === "orange" ? "due-orange" : undefined}>{dueText(r.due_date)}</b>
          </div>
        ))}
        {dates.length === 0 && reminders.length === 0 ? (
          <p className="muted">
            {/* 只读事项（11c T13）：不写“填在这里”这类引导 */}
            {readOnly ? "还没有期限。" : "开庭日、举证期限填在这里，到时提醒你。"}{" "}
            {!readOnly && (
              <button className="btn-link" onClick={() => nav(`/reminders/new/${encodeURIComponent(matter.matter_id)}`)}>
                填期限
              </button>
            )}
          </p>
        ) : (
          dates.map(([k, v]) => <div key={k} className="w-row"><span>{k === "analysis_as_of" ? "分析截止日" : k}</span><b>{v}</b></div>)
        )}
      </Widget>
      {/* 本事项的审查要点（v9.4 第 22 批，C1 #21、#22）：审合同按它判“偏离”；诉讼事项不显示（走查：对诉讼律师是噪音） */}
      {matterLine(matter) !== "litigation" && (
        <Widget title="审查要点">
          <ReviewRulesWidget matter={matter} readOnly={readOnly || !onChanged} />
        </Widget>
      )}
      </div>
    </div>
    </>
  );
}
