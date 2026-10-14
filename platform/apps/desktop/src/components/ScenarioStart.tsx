/**
 * 场景开始面板（UIUX P0-2 ScenarioStartSheet；历史 Demo 融合方案 §4.3 四步表单 → 两段式）：
 * 第一段“你给什么”（材料 + ≤ 3 个本方法必需的字段 + 可选补充要求）；第二段“你得到什么”（交付件 + 预计花费与内容去向）。
 * “这个方法会怎么做”默认折叠。主按钮写动词（开始审查 / 开始整理…），按下即发起；依据未齐等需要处理的情况转到发起确认。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Matter, type RunPolicyView } from "../api.ts";
import type { ScenarioCard } from "../lib/scenarios.ts";
import { buildGoal, LINE_LABELS } from "../lib/scenarios.ts";
import { Modal } from "./Modal.tsx";
import { defaultChoice } from "./ModeSelector.tsx";
import { launchRun, prepareStart, RunSheet, type PendingStart } from "./RunSheet.tsx";

interface Props {
  card: ScenarioCard;
  matter: Matter;
  documents: { document_version_id: string; filename: string }[];
  policy: RunPolicyView | null;
  /** 从输入框带来的任务描述（作为补充要求）。 */
  initialExtra?: string;
  onImport: (files: FileList) => Promise<void> | void;
  onClose: () => void;
}

function preselect(card: ScenarioCard, docs: Props["documents"]): string[] {
  if (card.minMaterials === 0) return [];
  if (card.scenario === "s1b.draft_compare") return [];
  if (card.skill === "contract-review") {
    const word = [...docs].reverse().find((d) => d.filename.toLowerCase().endsWith(".docx"));
    return word ? [word.document_version_id] : docs.slice(-1).map((d) => d.document_version_id);
  }
  return docs.map((d) => d.document_version_id);
}

export function ScenarioStart({ card, matter, documents, policy, initialExtra, onImport, onClose }: Props) {
  const [values, setValues] = useState<Record<string, string | string[]>>({});
  const [extra, setExtra] = useState(initialExtra ?? "");
  const [docIds, setDocIds] = useState<string[]>(() => preselect(card, documents));
  const [how, setHow] = useState(false);
  const [estimate, setEstimate] = useState<PendingStart | null>(null);
  const [estErr, setEstErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [confirm, setConfirm] = useState<PendingStart | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const known = useRef(new Set(documents.map((d) => d.document_version_id)));

  // 新导入的材料自动勾选
  useEffect(() => {
    const fresh = documents.filter((d) => !known.current.has(d.document_version_id)).map((d) => d.document_version_id);
    for (const d of documents) known.current.add(d.document_version_id);
    if (fresh.length > 0) setDocIds((ids) => [...ids, ...fresh.filter((x) => !ids.includes(x))]);
  }, [documents]);

  const goal = useMemo(() => (card.scenario === "a1.agent_task" ? buildGoal(card, values, extra) : extra.trim()), [card, values, extra]);
  const missing = card.fields.filter((f) => f.required && !(Array.isArray(values[f.key]) ? (values[f.key] as string[]).length : String(values[f.key] ?? "").trim()));
  const needDocs = Math.max(0, card.minMaterials - docIds.length);
  const ready = missing.length === 0 && needDocs === 0 && (card.scenario !== "a1.agent_task" || goal.length > 0);
  const value = useMemo(() => ({ goal, scenario: card.scenario, documentIds: docIds, choice: defaultChoice(policy) }), [goal, card.scenario, docIds, policy]);
  const opts = useMemo(() => ({ ...(card.skill ? { skill: card.skill } : {}), label: card.title }), [card]);

  // 预计花费与内容去向：材料或说明变化后重新估价（去抖）
  useEffect(() => {
    if (!ready) {
      setEstimate(null);
      return;
    }
    const t = setTimeout(() => {
      prepareStart(matter, value, opts)
        .then((p) => {
          setEstimate(p);
          setEstErr("");
        })
        .catch((e) => {
          setEstimate(null);
          setEstErr((e as Error).message);
        });
    }, 400);
    return () => clearTimeout(t);
  }, [ready, matter, value, opts]);

  const start = async () => {
    setBusy(true);
    setErr("");
    try {
      const p = estimate ?? (await prepareStart(matter, value, opts));
      // 依据未齐、去向有提醒：转到发起确认（在那里原地记录客户同意）
      if (p.estimate.data_where?.start_blocked || p.estimate.data_where?.warning) {
        setConfirm(p);
        return;
      }
      await launchRun(p);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (confirm) return <RunSheet pending={confirm} onClose={() => setConfirm(null)} />;

  const setField = (k: string, v: string | string[]) => setValues((cur) => ({ ...cur, [k]: v }));
  const order = (id: string) => docIds.indexOf(id) + 1;

  return (
    <Modal title={card.title} onClose={onClose}>
      <div className="ss">
        <div className="ss-sub muted">
          {LINE_LABELS[card.line]} · {matter.title} · 我方：{matter.stance}
        </div>
        <section className="ss-sec">
          <div className="ss-h">你给什么</div>
          <div className="ss-hint">{card.gives}</div>
          {card.minMaterials > 0 || documents.length > 0 ? (
            <div className="ss-docs" role="group" aria-label="选择材料">
              {documents.length === 0 && <div className="muted">本事项还没有材料。</div>}
              {documents.map((d) => {
                const on = docIds.includes(d.document_version_id);
                return (
                  <label key={d.document_version_id} className={`ss-doc${on ? " on" : ""}`}>
                    <input
                      type="checkbox"
                      aria-label={d.filename}
                      checked={on}
                      onChange={() => setDocIds((ids) => (on ? ids.filter((x) => x !== d.document_version_id) : [...ids, d.document_version_id]))}
                    />
                    <span className="ss-doc-name">{d.filename}</span>
                    {card.scenario === "s1b.draft_compare" && on && <span className="tag tag-gray">{order(d.document_version_id) === 1 ? "基线稿" : "对方回稿"}</span>}
                  </label>
                );
              })}
              <button className="btn-link ss-add" onClick={() => fileRef.current?.click()}>＋ 添加文件</button>
              <input
                ref={fileRef}
                type="file"
                multiple
                hidden
                accept=".docx,.txt,.md,.pdf,.png,.jpg,.jpeg"
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) void onImport(e.target.files);
                  e.target.value = "";
                }}
              />
              {needDocs > 0 && <div className="ss-need">{card.scenario === "s1b.draft_compare" ? "请依次勾选基线稿与对方回稿" : `还需要选择 ${needDocs} 份材料`}</div>}
            </div>
          ) : null}
          {card.fields.map((f) => (
            <label key={f.key} className="ss-field">
              <span className="ss-label">
                {f.label}
                {f.required ? <span className="ss-req" aria-label="必填">*</span> : null}
              </span>
              {f.kind === "select" ? (
                <select aria-label={f.label} value={String(values[f.key] ?? "")} onChange={(e) => setField(f.key, e.target.value)}>
                  <option value="">请选择</option>
                  {f.options!.map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              ) : f.kind === "multi" ? (
                <span className="ss-multi">
                  {f.options!.map((o) => {
                    const cur = (values[f.key] as string[] | undefined) ?? [];
                    const on = cur.includes(o);
                    return (
                      <button key={o} type="button" className={`chip${on ? " active" : ""}`} aria-pressed={on} onClick={() => setField(f.key, on ? cur.filter((x) => x !== o) : [...cur, o])}>
                        {o}
                      </button>
                    );
                  })}
                </span>
              ) : (
                <input aria-label={f.label} type={f.kind === "date" ? "date" : "text"} placeholder={f.placeholder ?? ""} value={String(values[f.key] ?? "")} onChange={(e) => setField(f.key, e.target.value)} />
              )}
            </label>
          ))}
          <label className="ss-field">
            <span className="ss-label">补充要求（可选）</span>
            <input type="text" aria-label="补充要求" value={extra} placeholder="例如：重点看交割前提条件" onChange={(e) => setExtra(e.target.value)} />
          </label>
        </section>
        <section className="ss-sec">
          <div className="ss-h">你得到什么</div>
          <ul className="ss-gets">
            {card.gets.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
          <button className="btn-link ss-how" aria-expanded={how} onClick={() => setHow((v) => !v)}>
            这个方法会怎么做 {how ? "▾" : "▸"}
          </button>
          {how && (
            <ol className="ss-steps">
              {card.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          )}
          <div className="ss-est" aria-live="polite">
            {estimate ? (
              <>
                {estimate.estimate.points_display}
                {estimate.estimate.data_where?.preview ? (
                  <details className="ss-where">
                    <summary className="muted">{estimate.estimate.data_where.preview.split("；")[0]}</summary>
                    <span className="muted">{estimate.estimate.data_where.preview.split("；").slice(1).join("；")}</span>
                  </details>
                ) : null}
              </>
            ) : estErr ? (
              <span className="ss-need">{estErr}</span>
            ) : ready ? (
              <span className="muted">正在估算…</span>
            ) : (
              <span className="muted">{missing.length > 0 ? `请先填写：${missing.map((f) => f.label).join("、")}` : needDocs > 0 ? "请先选择材料" : ""}</span>
            )}
          </div>
          <p className="ss-note muted">结果都是草稿，需要你复核后使用。{card.scenario === "a1.agent_task" ? "处理中需要联网或用到当事人信息时，会先问你。" : ""}</p>
        </section>
        {err && <div className="banner banner-red">{err}</div>}
        <div className="modal-actions">
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" disabled={busy || !ready} onClick={() => void start()}>
            {card.verb}
          </button>
        </div>
      </div>
    </Modal>
  );
}
