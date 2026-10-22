/**
 * 事项概览的阶段条与待办（v9.4 第 20 批；评审 C1 §3.2：事项是大本营——下一步做什么、卡在哪、谁在等我）。
 * - 阶段条：律师点选当前阶段（不由 AI 推断）；旁边是事件时点与地域——签发前按它们核对引用的适用版本与地方性规定（S-08）；
 * - 待办：手工待办（做什么、谁做、谁复核、期限）+ 从任务与成果推出的待办（等你确认、AI 已完成待你复核、待签发）。
 */
import { useCallback, useEffect, useState } from "react";
import { api, type Matter, type TodoInput, type TodoList } from "../api.ts";
import { nav } from "../App.tsx";
import { SCENARIO_LABELS } from "../lib/labels.ts";
import { ALL_STAGES, eventDateProblem, STAGE_LABELS, stagesFor, type Stage } from "../lib/matter-stage.ts";
import { dueText, dueTone } from "../lib/reminders.ts";
import { ASSIGNEE_LABELS, derivedTodoText, todoMeta } from "../lib/todos.ts";
import { notifyDataChanged } from "../lib/events.ts";
import { Select } from "./Select.tsx";

export function StageStrip({ matter, readOnly, onChanged }: { matter: Matter; readOnly: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [eventDate, setEventDate] = useState(matter.event_date ?? "");
  const [region, setRegion] = useState(matter.region ?? "");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const stages = stagesFor(matter.stance, matter.stage);
  const save = async (patch: Record<string, unknown>) => {
    setBusy(true);
    setErr("");
    try {
      await api.updateMatter(matter.matter_id, patch);
      notifyDataChanged();
      onChanged();
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const problem = eventDateProblem(eventDate);
  return (
    <div className="stage-strip">
      <div className="stage-line" role="radiogroup" aria-label="当前阶段">
        {stages.map((s) => (
          <button
            key={s}
            role="radio"
            aria-checked={matter.stage === s}
            className={`stage-step${matter.stage === s ? " on" : ""}`}
            disabled={readOnly || busy}
            onClick={() => void save({ stage: matter.stage === s ? null : s })}
            title={matter.stage === s ? "再点一次取消" : `当前阶段改为${STAGE_LABELS[s]}`}
          >
            {STAGE_LABELS[s]}
          </button>
        ))}
        {!readOnly && (
          <Select
            aria-label="其他阶段"
            value=""
            placeholder="其他阶段"
            onChange={(v) => v && void save({ stage: v })}
            options={ALL_STAGES.filter((s) => !stages.includes(s)).map((s: Stage) => ({ value: s, label: STAGE_LABELS[s] }))}
          />
        )}
      </div>
      {!editing ? (
        <div className="stage-facts">
          <span>
            事件时点 <b>{matter.event_date || "未填"}</b>
          </span>
          <span>
            地域 <b>{matter.region || "未填"}</b>
          </span>
          {!readOnly && (
            <button className="btn-link" onClick={() => setEditing(true)}>
              {matter.event_date || matter.region ? "修改" : "填写"}
            </button>
          )}
          {!matter.event_date && <span className="muted">填了以后，签发前按事件发生时的版本核对引用</span>}
        </div>
      ) : (
        <div className="stage-facts stage-edit">
          <label>
            事件时点
            <input value={eventDate} onChange={(e) => setEventDate(e.target.value)} placeholder="2023-05 或 2023-05-06" aria-label="事件时点" size={14} />
          </label>
          <label>
            地域
            <input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="如 上海市" aria-label="地域" size={10} maxLength={20} />
          </label>
          <button className="btn btn-sm" disabled={busy || !!problem} onClick={() => void save({ event_date: eventDate.trim() || null, region: region.trim() || null }).then((ok) => ok && setEditing(false))}>
            保存
          </button>
          <button className="btn-link" onClick={() => { setEditing(false); setEventDate(matter.event_date ?? ""); setRegion(matter.region ?? ""); setErr(""); }}>
            取消
          </button>
          {problem && <span className="muted">{problem}</span>}
        </div>
      )}
      {err && <div className="banner banner-red">{err}</div>}
    </div>
  );
}

const EMPTY: TodoInput = { title: "", assignee_kind: "me", assignee_name: "", reviewer_name: "", due_date: "" };

export function MatterTodos({ matter, readOnly }: { matter: Matter; readOnly: boolean }) {
  const [list, setList] = useState<TodoList | null>(null);
  const [failed, setFailed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<TodoInput>(EMPTY);
  const [showDone, setShowDone] = useState(false);
  const [err, setErr] = useState("");
  const reload = useCallback(() => {
    api
      .todos(matter.matter_id)
      .then((r) => {
        setList(r);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [matter.matter_id]);
  useEffect(reload, [reload]);
  const act = async (p: Promise<unknown>) => {
    setErr("");
    try {
      await p;
      reload();
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    }
  };
  const add = async () => {
    if (!draft.title.trim()) return;
    const body: TodoInput = {
      title: draft.title.trim(),
      assignee_kind: draft.assignee_kind,
      assignee_name: draft.assignee_kind === "assistant" || draft.assignee_kind === "colleague" ? draft.assignee_name?.trim() || null : null,
      reviewer_name: draft.reviewer_name?.trim() || null,
      due_date: draft.due_date || null,
    };
    if (await act(api.createTodo(matter.matter_id, body))) {
      setDraft(EMPTY);
      setAdding(false);
    }
  };
  if (failed) return <p className="muted">待办没有读出来，请稍后再试。</p>;
  if (!list) return <p className="muted">载入中…</p>;
  const nothing = list.derived.length === 0 && list.open.length === 0;
  return (
    <div className="todos">
      {nothing && !adding && <p className="muted">没有待办。AI 完成的任务会自动出现在这里，等你复核。</p>}
      {list.derived.map((d, i) => {
        const t = derivedTodoText(d, (s) => SCENARIO_LABELS[s] ?? "任务");
        return (
          <button
            key={`d${i}`}
            className="todo-row todo-derived"
            onClick={() => (d.artifact_version_id ? nav(`/review/${d.artifact_version_id}`) : d.run_id ? nav(`/run/${d.run_id}/${matter.matter_id}`) : undefined)}
          >
            <span className="todo-title">{t.title}</span>
            <span className="todo-meta">{t.who}</span>
          </button>
        );
      })}
      {list.open.map((t) => {
        const meta = todoMeta(t);
        const tone = t.due_date ? dueTone(t.due_date) : null;
        return (
          <div key={t.todo_id} className="todo-row">
            <input type="checkbox" aria-label={`完成：${t.title}`} disabled={readOnly} checked={false} onChange={() => void act(api.updateTodo(matter.matter_id, t.todo_id, { done: true }))} />
            <span className="todo-title">{t.title}</span>
            {meta && <span className="todo-meta">{meta}</span>}
            {t.due_date && (
              <span className={`todo-due${tone === "red" ? " due-red" : tone === "orange" ? " due-orange" : ""}`} title={t.due_date}>
                {dueText(t.due_date)}
              </span>
            )}
            {!readOnly && (
              <button className="btn-link todo-del" aria-label={`删除：${t.title}`} onClick={() => void act(api.deleteTodo(matter.matter_id, t.todo_id))}>
                删除
              </button>
            )}
          </div>
        );
      })}
      {adding ? (
        <div className="todo-add">
          <input autoFocus value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="做什么，例如：整理补充证据" aria-label="待办内容" maxLength={120} onKeyDown={(e) => e.key === "Enter" && void add()} />
          <div className="todo-add-row">
            <Select aria-label="谁做" value={draft.assignee_kind} onChange={(v) => setDraft({ ...draft, assignee_kind: v as TodoInput["assignee_kind"] })} options={(Object.keys(ASSIGNEE_LABELS) as TodoInput["assignee_kind"][]).map((k) => ({ value: k, label: `${ASSIGNEE_LABELS[k]}做` }))} />
            {(draft.assignee_kind === "assistant" || draft.assignee_kind === "colleague") && (
              <input value={draft.assignee_name ?? ""} onChange={(e) => setDraft({ ...draft, assignee_name: e.target.value })} placeholder="称呼" aria-label="谁做（称呼）" size={6} maxLength={20} />
            )}
            <input value={draft.reviewer_name ?? ""} onChange={(e) => setDraft({ ...draft, reviewer_name: e.target.value })} placeholder="复核人（可空）" aria-label="复核人" size={10} maxLength={20} />
            <input type="date" value={draft.due_date ?? ""} onChange={(e) => setDraft({ ...draft, due_date: e.target.value })} aria-label="期限" />
          </div>
          <div className="todo-add-row">
            <button className="btn btn-sm" disabled={!draft.title.trim()} onClick={() => void add()}>添加</button>
            <button className="btn-link" onClick={() => { setAdding(false); setDraft(EMPTY); }}>取消</button>
          </div>
        </div>
      ) : (
        !readOnly && (
          <button className="btn-link" onClick={() => setAdding(true)}>
            + 加一条待办
          </button>
        )
      )}
      {list.done.length > 0 && (
        <button className="btn-link todo-done-toggle" onClick={() => setShowDone((v) => !v)}>
          {showDone ? "收起已完成" : `已完成 ${list.done.length} 条`}
        </button>
      )}
      {showDone &&
        list.done.map((t) => (
          <div key={t.todo_id} className="todo-row todo-done">
            <input type="checkbox" aria-label={`改回未完成：${t.title}`} disabled={readOnly} checked onChange={() => void act(api.updateTodo(matter.matter_id, t.todo_id, { done: false }))} />
            <span className="todo-title">{t.title}</span>
          </div>
        ))}
      {err && <div className="banner banner-red">{err}</div>}
    </div>
  );
}
