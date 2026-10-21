/**
 * 场景开始面板（UIUX P0-2 ScenarioStartSheet；历史 Demo 融合方案 §4.3 四步表单 → 两段式）：
 * 第一段“你给什么”（材料 + ≤ 3 个本方法必需的字段 + 可选补充要求）；第二段“你得到什么”（交付件 + 预计花费与内容去向）。
 * “这个方法会怎么做”默认折叠。主按钮写动词（开始审查 / 开始整理…），按下即发起；依据未齐等需要处理的情况转到发起确认。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api, MATERIAL_ACCEPT, pickMaterials, type Matter, type MaterialFile, type RunPolicyView } from "../api.ts";
import type { ScenarioCard } from "../lib/scenarios.ts";
import { buildGoal, canStartPartial, LINE_LABELS, lineMismatchText, missingMaterialsText, skillArgsOf, splitIssues } from "../lib/scenarios.ts";
import { Icon } from "./Icons.tsx";
import { Modal } from "./Modal.tsx";
import { defaultChoice } from "./ModeSelector.tsx";
import { launchRun, prepareStart, RunSheet, type PendingStart } from "./RunSheet.tsx";
import { SendSummary } from "./SendSummary.tsx";
import { stanceLabel } from "../lib/labels.ts";
import { RolePills, Select, type MaterialRole } from "./Select.tsx";

interface Props {
  card: ScenarioCard;
  /** 面板里选中的事项；null = 还没有合适的事项（默认“新建事项”，Z3 评审 #1）。 */
  matter: Matter | null;
  /** 可切换的事项（与输入框的事项菜单同一份）。 */
  matters: Matter[];
  onMatterChange: (id: string) => void;
  onNewMatter: () => void;
  /** documents 属于哪个事项（切换事项后，新事项的材料到达前不重置勾选）。 */
  documentsFor: string | null;
  documents: { document_version_id: string; filename: string; role?: MaterialRole | null }[];
  policy: RunPolicyView | null;
  /** 从输入框带来的任务描述（作为补充要求）。 */
  initialExtra?: string;
  onImport: (files: FileList | MaterialFile[]) => Promise<void> | void;
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

export function ScenarioStart({ card, matter, matters, onMatterChange, onNewMatter, documentsFor, documents: allDocs, policy, initialExtra, onImport, onClose }: Props) {
  // 只用属于当前所选事项的材料（切换事项后旧事项的材料不显示、不勾选）
  const docsReady = !!matter && documentsFor === matter.matter_id;
  const documents = docsReady ? allDocs : [];
  const [matterMenu, setMatterMenu] = useState(false);
  const [values, setValues] = useState<Record<string, string | string[]>>({});
  const [extra, setExtra] = useState(initialExtra ?? "");
  const [docIds, setDocIds] = useState<string[]>(() => preselect(card, documents));
  /** 本面板里刚改过的用途（未刷新事项材料前先按这里显示；保存失败即撤回）。 */
  const [roles, setRoles] = useState<Record<string, MaterialRole | null>>({});
  const [how, setHow] = useState(false);
  const [estimate, setEstimate] = useState<PendingStart | null>(null);
  const [estErr, setEstErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [confirm, setConfirm] = useState<PendingStart | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const known = useRef(new Set(documents.map((d) => d.document_version_id)));
  const knownFor = useRef<string | null>(docsReady ? documentsFor : null);

  // 新导入的材料自动勾选；换了事项则按新事项的材料重新预选（Z3 评审 #1：切换事项后刷新材料列表）
  useEffect(() => {
    if (!docsReady) return;
    if (knownFor.current !== documentsFor) {
      knownFor.current = documentsFor;
      known.current = new Set(documents.map((d) => d.document_version_id));
      setDocIds(preselect(card, documents));
      return;
    }
    const fresh = documents.filter((d) => !known.current.has(d.document_version_id)).map((d) => d.document_version_id);
    for (const d of documents) known.current.add(d.document_version_id);
    if (fresh.length > 0) setDocIds((ids) => [...ids, ...fresh.filter((x) => !ids.includes(x))]);
  }, [documents, docsReady, documentsFor, card]);

  // 材料不齐也可先开始（UIUX 增量评审 S-4 / 历史 Demo D-5）：只限卡片声明允许的 Agent 场景（Z3 评审 #4：审合同没有合同不能先开始）；确定性流程仍须选够材料
  const [partial, setPartial] = useState(false);
  const goal = useMemo(() => {
    if (card.scenario !== "a1.agent_task") return extra.trim();
    const g = buildGoal(card, values, extra);
    // 只在材料确实还不齐时追加（复核 S6B-04：补齐材料后不能再让模型按“不齐”处理）
    return partial && card.minMaterials > docIds.length && g ? `${g}\n（材料还不齐：先按已有材料做，缺少的材料列为“待补充”，无法核实的内容标注“待补充”，不要推测。）` : g;
  }, [card, values, extra, partial, docIds.length]);
  const missing = card.fields.filter((f) => f.required && !(Array.isArray(values[f.key]) ? (values[f.key] as string[]).length : String(values[f.key] ?? "").trim()));
  const needDocs = Math.max(0, card.minMaterials - docIds.length);
  const canPartial = canStartPartial(card) && needDocs > 0;
  const ready = !!matter && docsReady && missing.length === 0 && (needDocs === 0 || (canPartial && partial)) && (card.scenario !== "a1.agent_task" || goal.length > 0);
  // “争点与证据分析”只用确认过的事实（复核 R15B-01）：事项里还没有确认过的，开始前就说清楚
  const [confirmedFacts, setConfirmedFacts] = useState<number | null>(null);
  useEffect(() => {
    setConfirmedFacts(null);
    if (card.skill !== "issue-evidence-matrix" || !matter) return;
    void api
      .facts(matter.matter_id, { status: "confirmed" })
      .then((r) => setConfirmedFacts(r.facts.length))
      .catch(() => setConfirmedFacts(null));
  }, [card.skill, matter?.matter_id]);
  // 整理案卷（确定性流程）的“已知争点”直接交给争点矩阵框架（B-5）
  const issues = useMemo(() => (card.scenario === "s2.case_file" ? splitIssues(String(values.issues ?? "")) : []), [card.scenario, values]);
  const value = useMemo(() => ({ goal, scenario: card.scenario, documentIds: docIds, choice: defaultChoice(policy), ...(issues.length > 0 ? { issues } : {}) }), [goal, card.scenario, docIds, policy, issues]);
  const opts = useMemo(() => ({ ...(card.skill ? { skill: card.skill } : {}), label: card.title, ...(card.skill ? { skillArgs: skillArgsOf(card, values) } : {}) }), [card, values]);

  // 疑似姓名核对之后重新估价
  const [reestimateTick, setReestimateTick] = useState(0);
  // 预计花费与内容去向：材料或说明变化后重新估价（去抖）
  useEffect(() => {
    if (!ready || !matter) {
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
  }, [ready, matter, value, opts, reestimateTick]);

  const start = async () => {
    setBusy(true);
    setErr("");
    try {
      if (!matter) return;
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
    <Modal title={card.title} onClose={onClose} wide>
      <div className="ss">
        <div className="ss-matter">
          <span className="ss-label">事项</span>
          <span className="ss-matter-pick">
            <button type="button" className="chip" aria-haspopup="listbox" aria-expanded={matterMenu} onClick={() => setMatterMenu((v) => !v)} title={matter?.title ?? "新建事项"}>
              <Icon.folder /> <span className="ss-matter-name">{matter ? matter.title : "新建事项"}</span> <Icon.down />
            </button>
            {matterMenu && (
              <div className="popover composer-menu ss-matter-menu" role="listbox" aria-label="选择事项">
                {matters.map((m) => (
                  <button
                    key={m.matter_id}
                    role="option"
                    aria-selected={m.matter_id === matter?.matter_id}
                    className={`menu-item${m.matter_id === matter?.matter_id ? " selected" : ""}`}
                    onClick={() => {
                      onMatterChange(m.matter_id);
                      setMatterMenu(false);
                    }}
                  >
                    <span className="menu-label">{m.title}</span>
                    <span className="menu-desc">我方：{stanceLabel(m.stance)}</span>
                  </button>
                ))}
                <button
                  className="menu-item menu-new"
                  onClick={() => {
                    setMatterMenu(false);
                    onNewMatter();
                  }}
                >
                  <span className="menu-label"><Icon.plus /> 新建事项</span>
                </button>
              </div>
            )}
          </span>
          {matter && <span className="muted">我方：{stanceLabel(matter.stance)}</span>}
        </div>
        {matter && lineMismatchText(card, matter) && <div className="muted ss-mismatch">{lineMismatchText(card, matter)}</div>}
        {!matter && (
          <div className="ss-need">
            还没有{LINE_LABELS[card.line]}事项。先新建一个事项（写明客户和我方立场），再开始{card.title}。{" "}
            <button className="btn-link" onClick={onNewMatter}>新建事项</button>
          </div>
        )}
        <section className="ss-sec">
          <div className="ss-h">你给什么</div>
          <div className="ss-hint">{card.gives}</div>
          {matter && (card.minMaterials > 0 || documents.length > 0) ? (
            <div className="ss-docs" role="group" aria-label="选择材料">
              {!docsReady && <div className="muted">正在读取这个事项的材料…</div>}
              {docsReady && documents.length === 0 && <div className="muted">本事项还没有材料。</div>}
              {documents.map((d) => {
                const on = docIds.includes(d.document_version_id);
                return (
                  <div key={d.document_version_id} className="ss-doc-row">
                  <label className={`ss-doc${on ? " on" : ""}`}>
                    <input
                      type="checkbox"
                      aria-label={d.filename}
                      checked={on}
                      onChange={() => setDocIds((ids) => (on ? ids.filter((x) => x !== d.document_version_id) : [...ids, d.document_version_id]))}
                    />
                    <span className="ss-doc-name">{d.filename}</span>
                    {card.scenario === "s1b.draft_compare" && on && <span className="tag tag-gray">{order(d.document_version_id) === 1 ? "基线稿" : "对方回稿"}</span>}
                  </label>
                  {/* 勾选材料时顺手标用途（Z3 #15、D-4 余项），与材料表同一份数据 */}
                  <RolePills
                    name={d.filename}
                    value={d.document_version_id in roles ? roles[d.document_version_id] : d.role}
                    onChange={(v) => {
                      setRoles((r) => ({ ...r, [d.document_version_id]: v }));
                      void api.setMaterialRole(d.document_version_id, v).catch(() => setRoles((r) => {
                        const { [d.document_version_id]: _, ...rest } = r;
                        return rest;
                      }));
                    }}
                  />
                  </div>
                );
              })}
              <button className="btn-link ss-add" onClick={() => void pickMaterials(fileRef.current, onImport)}>＋ 添加文件</button>
              <input
                ref={fileRef}
                type="file"
                multiple
                hidden
                accept={MATERIAL_ACCEPT}
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) void onImport(e.target.files);
                  e.target.value = "";
                }}
              />
              {needDocs > 0 && !(canPartial && partial) && (
                <div className="ss-need">
                  {missingMaterialsText(card, needDocs)}
                  {canPartial && (
                    <button className="btn-link" onClick={() => setPartial(true)}>
                      先开始，缺的稍后补
                    </button>
                  )}
                </div>
              )}
              {canPartial && partial && (
                <div className="muted">
                  材料还不齐：会先按已有材料做，缺的列为“待补充”，无法核实的内容不会推测。{" "}
                  <button className="btn-link" onClick={() => setPartial(false)}>
                    改回等材料齐了再开始
                  </button>
                </div>
              )}
            </div>
          ) : null}
          {card.fields.map((f) => (
            <label key={f.key} className="ss-field">
              <span className="ss-label">
                {f.label}
                {f.required ? <span className="ss-req" aria-label="必填">*</span> : null}
              </span>
              {f.kind === "select" ? (
                <Select aria-label={f.label} value={String(values[f.key] ?? "")} onChange={(v) => setField(f.key, v)} options={f.options!.map((o) => ({ value: o, label: o }))} />
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
          {/* 发送摘要不放在 aria-live 区域里（复核 S5B-06：发送视图与核对表不应被整段朗读） */}
          {matter && estimate?.estimate.data_where?.send_summary && (
            <SendSummary
              matterId={matter.matter_id}
              summary={estimate.estimate.data_where.send_summary}
              documentIds={docIds}
              goal={goal}
              mustReview={estimate.estimate.data_where.block_kind === "suspects"}
              onReviewed={() => setReestimateTick((n) => n + 1)}
            />
          )}
          {confirmedFacts === 0 && (
            <p className="banner banner-orange">这个事项还没有确认过的事实：AI 只能列出要件框架。先做“整理案卷”，再到事项页“事实”里逐条确认。</p>
          )}
          <p className="ss-note muted">结果都是草稿，需要你复核后使用。{card.scenario === "a1.agent_task" ? "处理中需要联网或用到当事人信息时，会先问你。" : ""}</p>
        </section>
        {err && <div className="banner banner-red">{err}</div>}
        <div className="modal-actions">
          <button className="btn-ghost" onClick={onClose}>取消</button>
          {/* 还不能开始时（例如疑似姓名待核对）不占主按钮：同屏的主动作是待办那一步（复核 S7B-01） */}
          <button className={ready ? "btn-primary" : "btn-ghost"} disabled={busy || !ready} onClick={() => void start()}>
            {card.verb}
          </button>
        </div>
      </div>
    </Modal>
  );
}
